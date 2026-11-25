import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, Meeting } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  closeSettings,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  expectSheetFootOneRow,
  firstTranscriptLine,
  launchApp,
  openMeetingSheet,
  openSettings,
  openTranscriptBeside,
  placeAssistant,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  stopMeeting,
  transcriptSaved,
  useLocalChatModel,
} from "./app";

/**
 * A call's control and its Transcript sheet in a real window (#3762): the time a paused call's
 * tab holds, Write notes as a button of its own over the control, the sheet's foot at any width
 * and its words that stay under the pointer. Set INCARNAMIND_SCREENSHOTS to keep stills.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

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

/** "1:05" in seconds. */
const secondsOf = (clock: string | null) => {
  const [minutes, seconds] = (clock ?? "").split(":").map(Number);
  return (minutes ?? 0) * 60 + (seconds ?? 0);
};

/** Seconds as the tab says them: "0:07", "1:05". */
const clockOf = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

// protects=a paused call's tab says the time recorded until it records again, however the core's
// updates come while it pauses; fails_when=the tab shows 0:00 or any time short of what was
// recorded while paused; no_claim=the time's ticking while it records, which the window's other specs cover.
test("a paused call's tab holds the time it recorded, by its key and by the core, and goes on from it", async () => {
  test.setTimeout(150_000);
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  // What the window hears of the call, kept to say which update a wrong time came from.
  await window.evaluate(() => {
    const scope = globalThis as unknown as { incarnamind: CoreBridge; heard: string[] };
    scope.heard = [];
    scope.incarnamind.on("meetings.changed", (list) => {
      for (const each of list)
        scope.heard.push(`${each.status} ${each.recordedMs} ${each.recordingSince ?? "-"}`);
    });
  });
  const heard = () => window.evaluate(() => (globalThis as unknown as { heard: string[] }).heard);
  await mkdir(test.info().outputDir, { recursive: true });
  // Paused by its key after a few seconds, by the core after a few, and by the core at once.
  for (const [language, pause, after] of [
    ["en", "key", 3],
    ["zh-CN", "core", 3],
    ["en", "core", 0],
  ] as const) {
    await setLanguage(window, language);
    const control = await recordMeeting(window);
    const tab = window.locator('[data-testid="mind-tab"]:has([data-testid="mind-tab-recording"])');
    const time = tab.getByTestId("mind-tab-time");
    if (after > 0) await expect(time).toHaveText(/^0:0[3-9]$/, { timeout: 30_000 });
    if (pause === "key") await window.keyboard.press("ControlOrMeta+Shift+KeyP");
    else {
      const [live] = (await meetingsOf(window)).filter((each) => each.status === "recording");
      await window.evaluate(
        (meetingId) =>
          (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.pauseMeeting(
            meetingId,
          ),
        live?.id ?? "",
      );
    }
    await expect(control).toHaveAttribute("data-status", "paused");
    const [paused] = (await meetingsOf(window)).filter((each) => each.status === "paused");
    const recorded = Math.floor((paused?.recordedMs ?? 0) / 1000);
    expect(recorded).toBeGreaterThanOrEqual(after);
    await writeFile(
      test.info().outputPath(`meetings-changed-${language}-${pause}-${after}.txt`),
      (await heard()).join("\n"),
    );
    await expect(time).toHaveText(clockOf(recorded));
    // The sheet's head says the same time.
    const sheet = await openMeetingSheet(window);
    await expect(sheet.getByTestId("meeting-sheet-time").getByRole("timer")).toHaveText(
      clockOf(recorded),
    );
    await shot(window, `meeting-paused-time-${language}`);
    await expect(time).toHaveText(clockOf(recorded));
    await window.keyboard.press("ControlOrMeta+Shift+KeyP");
    await expect(control).toHaveAttribute("data-status", "recording");
    await expect.poll(async () => secondsOf(await time.textContent())).toBeGreaterThan(recorded);
    await stopMeeting(window);
  }
  await app.close();
});

/** The User's own AI writes this call's notes: connected, and chosen in Settings › Meetings. */
async function notesByOwnAi(window: Page): Promise<void> {
  const agent = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setAgentsEnabled(true);
    const group = await bridge.createLibraryGroup({ name: "Shipping", description: "" });
    const { pairing } = await bridge.connectAgent({
      name: "VS Code",
      client: "vscode",
      folderIds: [group.id],
    });
    return pairing.id;
  });
  const settings = await openSettings(window, "meetings");
  await settings.getByLabel("AI for meeting notes").selectOption(agent);
  await closeSettings(window);
}

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Not drawn.");
  return box;
};

// protects=after Stop, Write notes is the design system's primary button, standing a clear step
// (16px on the spacing scale) over the control, on its left edge, at 1,440 and 900 px in English
// and Chinese; fails_when=it reads as a tip on the control: touching it, smaller than a primary
// button or off its edge; no_claim=the column's centred case, which the stills measure.
for (const language of ["en", "zh-CN"] as const) {
  test(`after Stop, Write notes is a primary button a clear step over the control (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir);
    // Connecting the AI keeps its key: a computer with no keyring keeps it as plain text.
    await acceptPlainTextKeys(window);
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await notesByOwnAi(window);
    await setLanguage(window, language);
    const control = await recordMeeting(window);
    await firstTranscriptLine(window);
    await stopMeeting(window);
    const write = window.getByTestId("meeting-write-notes");
    await expect(write).toHaveText(language === "en" ? "Write notes" : "整理笔记", {
      timeout: 30_000,
    });
    for (const width of [1440, 900]) {
      await setWindowSize(app, window, width, 900);
      await window.mouse.move(1, 1);
      const button = await boxOf(write);
      const pill = await boxOf(control);
      expect(Math.round(button.height)).toBe(32);
      expect(await write.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("6px");
      expect(Math.round(pill.y - (button.y + button.height))).toBe(16);
      // On the control's left edge beside the input; centred on it where the control stands alone.
      const alone = await window
        .locator(".meeting-foot-ask")
        .evaluate((ask) => ask.childElementCount === 0);
      if (alone)
        expect(
          Math.abs(button.x + button.width / 2 - (pill.x + pill.width / 2)),
        ).toBeLessThanOrEqual(1);
      else expect(Math.abs(button.x - pill.x)).toBeLessThanOrEqual(1);
      await shot(window, `meeting-write-notes-${language}-${width}`);
    }
    await app.close();
  });
}

// protects=the sheet's foot is one row inside the sheet in a narrow Note: with the assistant docked
// beside it, and with the Transcript open beside from 1,600 to 1,000 px, in English and Chinese;
// its words give way to icons by the foot's own width, and come back where they fit; fails_when=a
// button or word overflows the sheet or wraps, or the words never show in a wide sheet.
test("the sheet's foot fits a narrow Note: its words give way to icons, never overflow", async () => {
  test.setTimeout(300_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const sheet = await (async () => {
    await recordMeeting(window);
    await firstTranscriptLine(window);
    return openMeetingSheet(window);
  })();
  const words = sheet.locator('[data-testid="meeting-sheet-foot"] .meeting-button-word');
  await placeAssistant(window, { dock: "right", folded: false });
  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    // Wide, the foot says what each button does.
    await setWindowSize(app, window, 1600, 900);
    await expectSheetFootOneRow(sheet);
    await expect(words.first()).toBeVisible();
    // The assistant docked beside a 1,100px window.
    await setWindowSize(app, window, 1100, 800);
    await window.mouse.move(1, 1);
    await expectSheetFootOneRow(sheet);
    await shot(window, `meeting-sheet-foot-assistant-${language}`);
  }
  // The Transcript open beside, in a split of its own, the window from 1,600 to 1,000 px.
  await placeAssistant(window, { folded: true });
  await setWindowSize(app, window, 1600, 900);
  await openTranscriptBeside(window);
  await expect(window.getByTestId("tab-group")).toHaveCount(2);
  await openMeetingSheet(window);
  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    for (let width = 1600; width >= 1000; width -= 100) {
      await setWindowSize(app, window, width, 800);
      await window.mouse.move(1, 1);
      await expectSheetFootOneRow(sheet);
    }
    await shot(window, `meeting-sheet-foot-beside-${language}`);
  }
  // After Stop, the same: Resume, Review speakers… and ⋯ on one row.
  await stopMeeting(window);
  await transcriptSaved(window);
  await openMeetingSheet(window);
  for (let width = 1600; width >= 1000; width -= 200) {
    await setWindowSize(app, window, width, 800);
    await expectSheetFootOneRow(sheet);
  }
  await app.close();
});

// protects=a saved Transcript's words stay where they are while the pointer moves over them and
// rests, so a click lands on the word under it, in English and Chinese; fails_when=resting on a
// line moves any line, or a word's click lands beside it.
for (const language of ["en", "zh-CN"] as const) {
  test(`the sheet's words hold still under the pointer and a click lands on its word (${language})`, async () => {
    test.setTimeout(150_000);
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await recordMeeting(window);
    await expect
      .poll(async () => (await meetingsOf(window))[0]?.transcript?.lines ?? 0, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(4);
    await stopMeeting(window);
    await transcriptSaved(window);
    // Its speakers told apart, a word's click puts the caret before it.
    await expect
      .poll(async () => (await meetingsOf(window))[0]?.transcript?.separating, { timeout: 60_000 })
      .toBe(false);
    const sheet = await openMeetingSheet(window);
    const lines = sheet.getByTestId("transcript-line");
    await expect(lines.nth(3)).toBeVisible();
    const tops = () =>
      lines.evaluateAll((all) => all.map((line) => Math.round(line.getBoundingClientRect().top)));
    const before = await tops();
    const count = Math.min(before.length, 6);
    for (let index = 0; index < count; index++) {
      const line = lines.nth(index);
      const box = await boxOf(line);
      await window.mouse.move(box.x + 8, box.y + box.height / 2, { steps: 4 });
      await expect(line).toHaveAttribute("data-aimed", "");
      expect(await tops()).toEqual(before);
    }
    const word = lines.nth(1).locator("[data-word]").nth(1);
    const box = await boxOf(word);
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await window.mouse.down();
    await window.mouse.up();
    await expect(word).toHaveAttribute("data-caret", "true");
    await app.close();
  });
}

// protects=after Stop the sheet's ⋯ holds the template the notes were filled in with, checked, and
// Fill in again, as the call's old chip did; fails_when=the stopped sheet has no way to the template
// or to fill in again.
test("after Stop the sheet's ⋯ shows the template used and Fill in again", async () => {
  test.setTimeout(150_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const bridge = await coreOf(window);
  const id = await bridge.evaluate(async (core) => {
    const made = await core.createSkill({
      name: "fixture-template",
      description: "A fixture Meeting template.",
      steps: "## Sections\n\n- Decisions",
      meetingTemplate: true,
    });
    if (!made.ok) throw new Error("Couldn't create the fixture template.");
    return made.skill.id;
  });
  await recordMeeting(window);
  await bridge.evaluate(async (core, templateId) => {
    const [meeting] = await core.listMeetings();
    if (meeting) await core.setMeetingWriteupTemplate(meeting.id, templateId);
  }, id);
  await firstTranscriptLine(window);
  await stopMeeting(window);
  await expect
    .poll(async () => (await meetingsOf(window))[0]?.fill?.state, { timeout: 30_000 })
    .toBe("filled");
  const sheet = await openMeetingSheet(window);
  await pointAndClick(window, sheet.getByTestId("meeting-sheet-more"));
  await expect(window.getByTestId("meeting-writeup-fixture-template")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const again = window.getByTestId("meeting-writeup-again");
  await expect(again).toHaveText("Fill in again");
  await shot(window, "meeting-sheet-template-stopped-en");
  await pointAndClick(window, again);
  // The notes fill in anew in view: the sheet folds to them.
  await expect(sheet).toBeHidden();
  await app.close();
});

// protects=at 900 wide, with the Note's conversation opened upward from its input, what the meeting
// says over its control (the first tip with its ✕, the microphone's card, the shared screen's line)
// stands clear of the conversation, whole and pressable, in English and Chinese; fails_when=the open
// conversation covers a card or its ✕.
for (const language of ["en", "zh-CN"] as const) {
  test(`at 900 wide the cards over the control stand clear of the conversation opened upward (${language})`, async () => {
    test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");
    test.skip(
      process.platform === "win32",
      "The stand-in for Claude Code starts from a shell script.",
    );
    test.setTimeout(120_000);
    const home = await realpath(await createDataFolder());
    const bin = await realpath(await createDataFolder());
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "fakeClaudeCode.mjs")}" "$@"\n`,
    );
    await chmod(join(bin, "claude"), 0o755);
    await writeFile(join(bin, "mode"), "explain");
    const { app, window } = await launchApp(dataDir, {
      home,
      ownAi: join(bin, "claude"),
      extraEnv: { INCARNAMIND_TEST_OWN_AI_MODE_FILE: join(bin, "mode") },
    });
    try {
      await acceptPlainTextKeys(window);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, 900, 760);
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
      await recordMeeting(window);
      await window.evaluate(async (folder) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const [recording] = (await bridge.listMeetings()).filter(
          (each) => each.status === "recording",
        );
        if (recording) await bridge.moveToFolder({ mindIds: [recording.mindId], folderId: folder });
      }, folderId);
      const tip = window.getByTestId("meeting-foot-tip");
      await expect(tip).toBeVisible();
      await pointAndClick(window, window.getByTestId("note-ask-input"));
      await window.keyboard.insertText(
        language === "en" ? "What does this count?" : "这统计的是什么？",
      );
      await window.keyboard.press("Enter");
      await expect(window.getByTestId("note-ask-pill-open")).toBeVisible({ timeout: 30_000 });
      await pointAndClick(window, window.getByTestId("note-ask-handle-toggle"));
      await expect(window.getByTestId("note-ask-panel")).toBeVisible();
      const box = await boxOf(window.getByTestId("note-ask-box"));
      const cards = window.locator(".meeting-foot-over > :not(:empty)");
      expect(await cards.count()).toBeGreaterThan(0);
      for (const card of await cards.all()) {
        await expect(card).toBeInViewport({ ratio: 1 });
        const at = await boxOf(card);
        const apart =
          at.y + at.height <= box.y ||
          at.x + at.width <= box.x ||
          at.x >= box.x + box.width ||
          at.y >= box.y + box.height;
        expect(apart).toBe(true);
        // Nothing lies over it.
        expect(
          await card.evaluate((element) => {
            const shown = element.getBoundingClientRect();
            return element.contains(
              document.elementFromPoint(shown.left + shown.width / 2, shown.top + shown.height / 2),
            );
          }),
        ).toBe(true);
      }
      // A press on a card keeps the conversation open, so the card stays under the pointer.
      const standing = await boxOf(tip);
      await pointAndClick(window, tip.locator("span").first());
      await expect(window.getByTestId("note-ask-panel")).toBeVisible();
      expect(await boxOf(tip)).toEqual(standing);
      // Its ✕ is reached and works from the keyboard while the conversation stays open.
      await tip.getByTestId("meeting-foot-tip-close").focus();
      await window.keyboard.press("Enter");
      await expect(tip).toHaveCount(0);
      await expect(window.getByTestId("note-ask-panel")).toBeVisible();
      await shot(window, `meeting-cards-over-conversation-${language}-900`);
    } finally {
      await app.close();
      await removeDataFolder(home);
      await removeDataFolder(bin);
    }
  });
}
