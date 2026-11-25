import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  boxBottom,
  boxOf,
  boxRight,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  openMeetingSheet,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  stopMeeting,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");
test.skip(process.platform === "win32", "The stand-in for Claude Code starts from a shell script.");

/*
 * Asking the User's own AI from a recorded meeting's Note (#3762): its input stays at the Note's
 * foot beside the meeting's control. A reply that lands while the Transcript sheet is up shows on
 * the line above the input, below the sheet; at 900 wide the conversation opens upward and leaves
 * the control in view and pressable; and in My notes, which hides the AI's lines, a change it makes
 * says it is in notes, with the one action that shows it there. A Node script stands in for
 * `claude`, reaching IncarnaMind only through the settings it was given.
 */

let dataDir: string;
let home: string;
let bin: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  bin = await realpath(await createDataFolder());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeClaudeCode.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
});
test.afterEach(async () => {
  for (const folder of [dataDir, home, bin]) await removeDataFolder(folder);
});

const WORDS = {
  en: {
    question: "What does this count?",
    answer: "It counts the ship calls the harbour handled in 2025.",
    summary: "Write a summary of the ferry interviews",
    summaryReply: "I wrote a summary of the ferry interviews in your note.",
    summaryLine: "Commuters miss the 08:15 train when it does.",
    typed: ["Ramp works start in March", "Ask about the 07:40 crossing"],
    showMine: "Show my notes",
  },
  "zh-CN": {
    question: "这统计的是什么？",
    answer: "它统计的是港口在 2025 年接待的船舶靠港次数。",
    summary: "写一份渡轮访谈的总结",
    summaryReply: "我已在你的笔记里写好渡轮访谈的总结。",
    summaryLine: "晚点时，通勤者会错过 08:15 的火车。",
    typed: ["坡道工程三月开工", "问一下 07:40 的班次"],
    showMine: "显示我的笔记",
  },
} as const;

async function shot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await window.screenshot({ path: join(folder, `${name}.png`), animations: "disabled" });
}

/** The app with the stand-in Claude Code as the User's own AI, which may read "Kestrel Bay". */
async function launched(language: "en" | "zh-CN") {
  const launch = await launchApp(dataDir, {
    home,
    ownAi: join(bin, "claude"),
    extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
  });
  const { window } = launch;
  await acceptPlainTextKeys(window);
  await dismissChatSetup(window);
  await setLanguage(window, language);
  const folderId = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({ name: "Kestrel Bay", description: "" });
    await bridge.setAgentsEnabled(true);
    await bridge.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [folder.id],
      propose: true,
    });
    return folder.id;
  });
  return { ...launch, folderId };
}

/** Records a meeting, its Note filed in the folder its AI may read: the Note's input shows. */
async function recordInFolder(window: Page, folderId: string): Promise<Locator> {
  const control = await recordMeeting(window);
  await window.evaluate(async (folder) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const recording = (await bridge.listMeetings()).find((each) => each.status === "recording");
    if (!recording) throw new Error("No meeting is recording.");
    await bridge.moveToFolder({ mindIds: [recording.mindId], folderId: folder });
  }, folderId);
  await expect(window.getByTestId("note-ask-input")).toBeVisible({ timeout: 15_000 });
  return control;
}

/** What the stand-in does at its next start. */
const nextRun = (mode: "explain" | "summary" | "wait") => writeFile(join(bin, "mode"), mode);

/** Types a request into the Note's input, as a person does, and sends it. */
async function send(window: Page, words: string) {
  await pointAndClick(window, window.getByTestId("note-ask-input"));
  await window.keyboard.insertText(words);
  await window.keyboard.press("Enter");
}

/** Whether nothing lies over the middle of `target`: a press there reaches it. */
const uncovered = (target: Locator) =>
  target.evaluate((element) => {
    const at = element.getBoundingClientRect();
    return element.contains(
      document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2),
    );
  });

/** The line above the input shows whole, below the Transcript sheet, with nothing over it. */
async function shownBelow(line: Locator, sheet: Locator) {
  await expect(line).toBeInViewport({ ratio: 1 });
  expect(boxBottom(await boxOf(sheet))).toBeLessThanOrEqual((await boxOf(line)).y);
  expect(await uncovered(line)).toBe(true);
}

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  // protects=with the Transcript sheet up, the line above the Note's input shows that the AI works and then that its reply arrived, below the sheet and uncovered, and the sheet stays up (#3762); fails_when=the sheet covers the line, folds as the request goes, or nothing shows that the reply arrived
  test(`a reply that lands with the Transcript up shows on the line above the input, below the sheet (${language})`, async () => {
    const { app, window, folderId } = await launched(language);
    try {
      await setWindowSize(app, window, 1440, 760);
      await recordInFolder(window, folderId);
      const sheet = await openMeetingSheet(window);
      const line = window.getByTestId("note-ask-pill");

      await nextRun("wait");
      await send(window, words.question);
      await expect(line).toHaveAttribute("data-state", "working");
      await expect(window.getByTestId("note-ask-pill-text")).toHaveText("Looking at your note");
      await shownBelow(line, sheet);
      await pointAndClick(window, window.getByTestId("note-ask-stop"));
      await expect(line).toHaveCount(0);
      await expect(sheet).toBeVisible();

      await nextRun("explain");
      await send(window, words.question);
      await expect(window.getByTestId("note-ask-pill-open")).toHaveText(words.answer);
      await expect(line).toHaveAttribute("data-state", "landed");
      await expect(sheet).toBeVisible();
      await shownBelow(line, sheet);
      await shot(window, `meeting-reply-under-sheet-${language}-1440`);
    } finally {
      await app.close();
    }
  });

  // protects=at 900 wide the conversation opens upward from the input and leaves the meeting's control at its left in view and pressable: the chevron raises the sheet (#3762); fails_when=the open conversation lies over the control or takes its press
  test(`at 900 wide, the conversation open upward leaves the meeting's control in view and pressable (${language})`, async () => {
    const { app, window, folderId } = await launched(language);
    try {
      await setWindowSize(app, window, 900, 760);
      const control = await recordInFolder(window, folderId);
      await nextRun("explain");
      await send(window, words.question);
      await expect(window.getByTestId("note-ask-pill-open")).toHaveText(words.answer);
      await pointAndClick(window, window.getByTestId("note-ask-handle-toggle"));
      const panel = window.getByTestId("note-ask-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(words.answer);
      await expect(window.getByTestId("note-column")).toHaveCount(0);

      // The open conversation stands right of the control, which shows whole with nothing over it.
      const box = window.getByTestId("note-ask-box");
      expect((await boxOf(box)).x).toBeGreaterThanOrEqual(boxRight(await boxOf(control)));
      const chevron = control.getByTestId("meeting-foot-transcript");
      for (const slot of [chevron, control.getByTestId("meeting-foot-stop")]) {
        await expect(slot).toBeInViewport({ ratio: 1 });
        expect(await uncovered(slot)).toBe(true);
      }
      await shot(window, `meeting-conversation-upward-${language}-900`);

      await pointAndClick(window, chevron);
      await expect(window.getByTestId("meeting-sheet")).toBeVisible();
      await expect(chevron).toHaveAttribute("aria-expanded", "true");
    } finally {
      await app.close();
    }
  });

  // protects=in My notes, which hides the AI's lines, a change the User's AI makes is said on the line above the input with one action, Show in notes, which shows Notes at the change, where Undo is (#3762); fails_when=the change goes unseen with only Undo and Review, or Show in notes leaves My notes or the change out of view
  test(`in My notes, a change the AI makes says it is in notes, and its one action shows it there (${language})`, async () => {
    const { app, window, folderId } = await launched(language);
    try {
      await setWindowSize(app, window, 1440, 760);
      await recordInFolder(window, folderId);
      const editor = window.getByTestId("mind-editor");
      await pointAndClick(window, editor);
      await focusSettled(window, editor);
      for (const typed of words.typed) {
        await window.keyboard.insertText(typed);
        await window.keyboard.press("Enter");
      }
      await stopMeeting(window);
      await runCommand(window, "meeting.showMyNotes", words.showMine);
      const typed = words.typed.map((each) => editor.locator("p", { hasText: each }));
      for (const each of typed) await expect(each).toBeVisible();

      await nextRun("summary");
      await send(window, words.summary);
      await expect(window.getByTestId("note-ask-pill-open")).toHaveText(words.summaryReply);
      const added = editor.locator("p", { hasText: words.summaryLine });
      await expect(added).toHaveCount(1);
      await expect(added).toBeHidden();
      const showIn = window.getByTestId("note-ask-show-in-notes");
      await expect(showIn).toHaveText(translate(language, "noteAsk.showInNotes"));
      await expect(window.getByTestId("note-ask-undo")).toHaveCount(0);
      for (const each of typed) await expect(each).toBeVisible();
      await shot(window, `meeting-my-notes-change-${language}-1440`);

      await pointAndClick(window, showIn);
      await expect(added).toBeVisible();
      await expect(added).toBeInViewport();
      await expect(showIn).toHaveCount(0);
      await expect(window.getByTestId("note-ask-undo")).toHaveText(
        translate(language, "edit.applied.undo"),
      );
      for (const each of typed) await expect(each).toHaveCount(1);
      await shot(window, `meeting-my-notes-shown-in-notes-${language}-1440`);
    } finally {
      await app.close();
    }
  });
}
