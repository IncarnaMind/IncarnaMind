import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge, Meeting } from "../src/core/api";
import {
  closeFirstFillPopover,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  motionSettled,
  pointAndClick,
  recordMeetingNow,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";
import { encode, film } from "./feel";

/**
 * My notes (#138): after the call, the meeting's page shows only what the User typed, edited in
 * place in the same Note; the fill's lines stay in Notes. Set INCARNAMIND_SCREENSHOTS to keep
 * stills and a film.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

async function recordOnClose(app: ElectronApplication, window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  const stop = await film(window, resolve(SCREENSHOTS, `${name}-frames`));
  const close = app.close.bind(app);
  let closing: Promise<void> | undefined;
  app.close = () => {
    closing ??= (async () => {
      try {
        await stop();
        await encode(resolve(SCREENSHOTS, `${name}-frames`), resolve(SCREENSHOTS, `${name}.mp4`));
      } finally {
        await close();
      }
    })();
    return closing;
  };
}

const WORDS = {
  en: {
    lines: ["Launch date", "UK fee"],
    heading: "Action items",
    added: " for Dana",
    notes: "Notes",
    mine: "My notes",
    transcript: "Transcript",
    showMine: "Show my notes",
    filled: "Note filled in from the call",
    undo: "Undo",
    empty: "You didn’t type notes in this meeting.",
    fillUndo: "Undo the fill-in from notes",
    showNotes: "Show notes",
    recorded: /^Recorded \d+:\d{2}$/,
    find: "launch",
    found: 1,
  },
  "zh-CN": {
    lines: ["上线日期", "英国费用"],
    heading: "待办",
    added: "（小王）",
    notes: "笔记",
    mine: "我的笔记",
    transcript: "转写稿",
    showMine: "显示我的笔记",
    filled: "已补全笔记",
    undo: "撤销",
    empty: "这次会议你没有记笔记。",
    fillUndo: "请在笔记视图中撤销补全",
    showNotes: "显示笔记",
    recorded: /^已录制 \d+:\d{2}$/,
    find: "launch",
    found: 0,
  },
} as const;

/** The fake transcription speaks English in either language, and the fill follows it. */
const OVERVIEW = "The call reviewed priorities and follow-through";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const meetingsOf = (window: Page): Promise<Meeting[]> =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings(),
  );

const starts = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

for (const language of ["en", "zh-CN"] as const) {
  // protects=after the call My notes shows exactly the lines the User typed, from the chip, ⌥⌘←/⌥⌘→ and ⌘K; an edit there is the same line in Notes; Select all then Delete leaves the fill in Notes and says nothing was typed, a copy holds only what shows, Find counts only what shows, and ⌘Z doesn't take back the fill from there (#138); fails_when=a fill line shows in My notes, an edit lands elsewhere, a deletion or copy takes the fill's lines, or ⌘Z takes back the fill unseen; no_claim=a real model's fill.
  test(`after the call My notes shows what the User typed and edits it in place (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await recordOnClose(app, window, `my-notes-${language}`);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ device: { meetingNoticeAccepted: true } });
    });

    const bar = await recordMeetingNow(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);
    await focusSettled(window, editor);
    for (const text of words.lines) {
      await window.keyboard.insertText(text);
      await window.keyboard.press("Enter");
    }
    await window.keyboard.type("## ");
    await window.keyboard.insertText(words.heading);
    await expect
      .poll(async () => (await meetingsOf(window))[0]?.transcript?.lines ?? 0, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
    await pointAndClick(window, bar.getByTestId("meeting-stop"));
    const line = window.getByTestId("meeting-fill-line");
    await expect(line).toHaveText(`${words.filled} · ${words.undo}`, {
      timeout: 30_000,
      useInnerText: false,
    });
    await closeFirstFillPopover(window);
    const overview = editor.locator("p").filter({ hasText: OVERVIEW });
    await expect(overview).toHaveCount(1);

    // From the chip: the views after the call, and My notes shows only what was typed.
    const chip = window.getByTestId("meeting-view-chip");
    await pointAndClick(window, chip);
    const menu = window.getByTestId("meeting-view-menu");
    await expect(menu.locator('[role="menuitemradio"]')).toHaveText([
      words.notes,
      words.mine,
      words.transcript,
    ]);
    await shot(window, `my-notes-chip-${language}-1440`);
    await pointAndClick(window, menu.getByTestId("meeting-view-mine"));
    await expect(chip).toHaveText(words.mine);
    const shown = editor.locator(":is(p, h1, h2, h3):visible");
    const typed = [...words.lines, words.heading].map(starts);
    await expect(shown).toHaveText(typed);
    await expect(line).toHaveCount(0);
    await expect(editor).toBeFocused();
    await shot(window, `my-notes-${language}-1440`);

    // An edit here is the same line in Notes.
    await pointAndClick(window, shown.first());
    await window.keyboard.press("End");
    await window.keyboard.insertText(words.added);
    await expect(shown.first()).toHaveText(starts(`${words.lines[0]}${words.added}`));
    await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(chip).toHaveText(words.recorded);
    await expect(editor.locator("p").first()).toHaveText(starts(`${words.lines[0]}${words.added}`));
    await expect(overview).toBeVisible();

    // ⌘K reaches My notes, and the keys go Notes, My notes, Transcript.
    await runCommand(window, "meeting.showMyNotes", words.showMine);
    await expect(chip).toHaveText(words.mine);
    await window.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect(chip).toHaveText(words.transcript);
    await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(chip).toHaveText(words.mine);
    await expect(editor).toBeFocused();

    // Find counts only what shows.
    await window.keyboard.press("ControlOrMeta+f");
    await window.getByTestId("find-field").fill(words.find);
    await expect(editor.locator(".find-match")).toHaveCount(words.found);
    await window.keyboard.press("Escape");
    await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await window.keyboard.press("ControlOrMeta+f");
    await window.getByTestId("find-field").fill(words.find);
    await expect(editor.locator(".find-match")).toHaveCount(words.found + 1);
    await window.keyboard.press("Escape");
    await window.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect(chip).toHaveText(words.mine);

    // Select all: a copy holds only what shows, and a cut takes out only that.
    await window.evaluate(() => {
      const keep = (event: ClipboardEvent) => {
        const held = globalThis as unknown as { clipboardText: Record<string, string> };
        held.clipboardText = {
          ...held.clipboardText,
          [event.type]: event.clipboardData?.getData("text/plain") ?? "",
        };
      };
      document.addEventListener("copy", keep);
      document.addEventListener("cut", keep);
    });
    const clipboard = () =>
      window.evaluate(
        () =>
          (globalThis as unknown as { clipboardText?: Record<string, string> }).clipboardText ?? {},
      );
    await pointAndClick(window, shown.first());
    await window.keyboard.press("ControlOrMeta+a");
    await window.keyboard.press("ControlOrMeta+c");
    await expect.poll(async () => (await clipboard()).copy ?? "").not.toBe("");
    const copied = (await clipboard()).copy ?? "";
    for (const text of [`${words.lines[0]}${words.added}`, words.lines[1], words.heading]) {
      expect(copied).toContain(text);
    }
    expect(copied).not.toContain(OVERVIEW);
    await window.keyboard.press("ControlOrMeta+x");
    await expect.poll(async () => (await clipboard()).cut ?? "").toBe(copied);
    await expect(window.getByTestId("my-notes-empty")).toHaveText(words.empty);
    await shot(window, `my-notes-empty-${language}-1440`);
    await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(overview).toBeVisible();
    await expect(editor.locator("p").filter({ hasText: words.lines[1] })).toHaveCount(0);
    await window.keyboard.press("ControlOrMeta+Alt+ArrowRight");

    // ⌘Z puts the lines back, then the edit; the fill's own step is taken back from Notes.
    await window.keyboard.press("ControlOrMeta+z");
    await expect(shown).toHaveText([starts(`${words.lines[0]}${words.added}`), ...typed.slice(1)]);
    await expect(window.getByTestId("my-notes-empty")).toHaveCount(0);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(shown).toHaveText(typed);
    await window.keyboard.press("ControlOrMeta+z");
    const told = window.getByTestId("undo-message").last();
    await expect(told).toContainText(words.fillUndo);
    await expect(overview).toHaveCount(1);
    await setWindowSize(app, window, 900, 760);
    await shot(window, `my-notes-${language}-900`);
    await pointAndClick(window, window.getByTestId("my-notes-show-notes"));
    await expect(chip).toHaveText(words.recorded);
    await expect(overview).toBeVisible();
    await app.close();
  });
}
