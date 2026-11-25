import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { FakeCapture } from "../src/core/meetings/fakeCapture";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  launchApp,
  motionSettled,
  openMeetingDetails,
  openMeetingSheet,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  stopMeeting,
  tabMenu,
  transcriptSaved,
} from "./app";

/*
 * Deleting a Meeting's Note (#1253) asks nothing and erases nothing: Undo, or Restore in
 * Recently deleted, brings back the Note with its Meeting, its control that raises the
 * Transcript and the sheet's recording details with the audio's line (#3762), in either
 * language. A Meeting recording stops at Delete.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
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

const WORDS = {
  en: {
    transcript: "Transcript",
    audio: /^Recorded 0:\d\d · Audio kept until /,
    deleted: (name: string) => `Moved “${name}” to Recently deleted`,
    restored: (name: string) => `Restored “${name}”`,
    lost: (name: string) =>
      `Restored “${name}” without its audio: it was no longer on this computer.`,
    gone: /^Recorded 0:\d\d · Audio deleted on \d{1,2} [A-Z][a-z]{2}( \d{4})?$/,
    question: (name: string) =>
      `Your text in “${name}” is gone. Its recording and Transcript are deleted too. This can’t be undone. Your files stay where they are.`,
  },
  "zh-CN": {
    transcript: "转写稿",
    audio: /^已录制 0:\d\d · 音频保留到/,
    deleted: (name: string) => `已将“${name}”移到回收站`,
    restored: (name: string) => `已恢复“${name}”`,
    lost: (name: string) => `已恢复“${name}”，但音频已不在这台电脑上，无法恢复。`,
    gone: /^已录制 0:\d\d · 音频已于(\d{4}年)?\d{1,2}月\d{1,2}日删除$/,
    question: (name: string) =>
      `“${name}”中你写的内容将丢失。会议的录音和转写稿也将彻底删除。此操作无法撤销。你的文件仍在原处。`,
  },
} as const;

const meetings = async (window: Page) =>
  (await coreOf(window)).evaluate((bridge) => bridge.listMeetings());

const fakeAudio = (app: ElectronApplication) =>
  app.evaluate(() => {
    const fake = (globalThis as { incarnamindFakeAudio?: FakeCapture }).incarnamindFakeAudio;
    if (!fake) throw new Error("The app isn't recording with the fake capture.");
    return { running: fake.running };
  });

/** The audio's parts on disk, by name. */
function partsOf(meetingId: string): string[] {
  const folder = join(dataDir, "meetings", meetingId);
  return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".wav")) : [];
}

const undoMessage = (window: Page) => window.getByTestId("undo-line").getByTestId("undo-message");

const noteRow = (window: Page, name: string): Locator =>
  window
    .getByTestId("mind-row")
    .filter({ has: window.getByTestId("mind-list-item").filter({ hasText: name }) });

/** A Meeting recording from its first press, with a few lines in its Transcript. */
async function recording(window: Page, language: keyof typeof WORDS) {
  await setLanguage(window, language);
  await dismissChatSetup(window);
  await recordMeeting(window);
  await expect
    .poll(async () => (await meetings(window))[0]?.transcript?.lines ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  const name = (await frontMindName(window).textContent()) ?? "";
  const [meeting] = await meetings(window);
  if (!meeting) throw new Error("No Meeting.");
  return { name, meeting };
}

/**
 * A stopped Meeting's control, once its Transcript is saved: one button, Transcript, and nothing
 * above the notes says anything of the Transcript.
 */
async function stoppedControl(window: Page, language: keyof typeof WORDS): Promise<Locator> {
  await transcriptSaved(window);
  const control = window.getByTestId("meeting-foot");
  await expect(control).toHaveAttribute("data-status", "stopped");
  await expect(control.getByTestId("meeting-foot-transcript")).toHaveText(
    WORDS[language].transcript,
  );
  await expect(window.getByTestId("meeting-transcript-line")).toHaveCount(0);
  return control;
}

/** What the Transcript sheet's recording details say of the audio; then the sheet folds. */
async function audioLine(window: Page): Promise<string> {
  const details = await openMeetingDetails(window);
  const audio = details.getByTestId("meeting-audio");
  await expect(audio).toBeVisible();
  const said = (await audio.textContent()) ?? "";
  const sheet = window.getByTestId("meeting-sheet");
  await pointAndClick(window, sheet.getByTestId("meeting-sheet-hide"));
  await expect(sheet).toBeHidden();
  return said;
}

/** The Transcript rises over the Note from its control, with the lines said in it. */
async function opensTranscript(window: Page, mindId: string): Promise<void> {
  const tab = window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`);
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const tabId = await tab.getAttribute("data-tab-id");
  const panelId = await tab.getAttribute("aria-controls");
  if (!tabId || !panelId) throw new Error("Expected the restored Note's tab and panel");
  const panel = window.locator(`[id="${panelId}"]`);
  const editor = panel.getByTestId("mind-editor");
  const retained = await editor.elementHandle();
  if (!retained) throw new Error("Expected the restored Note's editor");
  const documentTabs = await window.getByTestId("document-tab").count();
  try {
    const sheet = await openMeetingSheet(window);
    await expect(panel.getByTestId("meeting-sheet")).toBeVisible();
    await expect(
      sheet.getByTestId("viewer-transcript").getByTestId("transcript-line").first(),
    ).toBeVisible();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab).toHaveAttribute("data-tab-id", tabId);
    await expect(window.getByTestId("document-tab")).toHaveCount(documentTabs);
    // The sheet lies over the Note: the Note and its editor stay as they were.
    await expect(editor).toBeVisible();
    expect(await retained.evaluate((element) => element.isConnected)).toBe(true);
  } finally {
    await retained.dispose();
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a stopped Meeting's Note deleted from its tab comes back whole with Undo (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 900);
    const { name, meeting } = await recording(window, language);
    await stopMeeting(window);
    const control = await stoppedControl(window, language);
    const audioSaid = await audioLine(window);
    expect(audioSaid).toMatch(WORDS[language].audio);
    const parts = partsOf(meeting.id);
    expect(parts.length).toBeGreaterThan(0);
    await screenshot(window, `meeting-undo-stopped-${language}`);

    const menu = await tabMenu(window);
    await pointAndClick(window, menu.getByTestId("mind.delete"));
    await expect(undoMessage(window)).toHaveText(WORDS[language].deleted(name));
    await expect(noteRow(window, name)).toHaveCount(0);
    expect(await meetings(window)).toEqual([]);
    expect(partsOf(meeting.id)).toEqual(parts);
    await screenshot(window, `meeting-undo-deleted-${language}`);

    await pointAndClick(window, window.getByTestId("undo-line").getByTestId("undo-action"));

    await expect(frontMindName(window)).toHaveText(name);
    await screenshot(window, `meeting-undo-undone-${language}`);
    await expect(control).toHaveAttribute("data-status", "stopped");
    await expect(control.getByTestId("meeting-foot-transcript")).toHaveText(
      WORDS[language].transcript,
    );
    expect(await audioLine(window)).toBe(audioSaid);
    await expect(undoMessage(window)).toHaveCount(0);
    expect(partsOf(meeting.id)).toEqual(parts);
    await opensTranscript(window, meeting.mindId);
    await app.close();
  });

  test(`a recording Meeting stops at Delete, and Restore in Recently deleted brings its Note back with its lines (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 900);
    const { name, meeting } = await recording(window, language);
    expect((await fakeAudio(app)).running).toBe(true);

    const row = noteRow(window, name);
    await row.hover();
    await pointAndClick(window, row.getByTestId("mind-menu"));
    await pointAndClick(window, row.getByTestId("mind-actions").getByTestId("mind.delete"));
    await expect(undoMessage(window)).toHaveText(WORDS[language].deleted(name));
    await expect.poll(async () => (await fakeAudio(app)).running).toBe(false);
    expect(await meetings(window)).toEqual([]);
    expect(partsOf(meeting.id).length).toBeGreaterThan(0);

    await pointAndClick(window, window.getByTestId("open-library"));
    const head = window.getByTestId("deleted-section-head");
    if ((await head.getAttribute("data-open")) === "false") {
      await pointAndClick(window, head.getByTestId("deleted-heading"));
    }
    // The Note waits there alone: its Transcript waits with it, not beside it.
    const rows = window.getByTestId("deleted-item");
    await expect(rows.getByTestId("deleted-name")).toHaveText([name]);
    await screenshot(window, `meeting-restore-deleted-${language}`);
    // Delete Permanently says what goes with the note before anything is lost; Esc keeps it all.
    await pointAndClick(window, rows.getByTestId("deleted-delete"));
    const question = window.getByTestId("delete-permanently-dialog");
    await expect(question.locator("#delete-permanently-body")).toHaveText(
      WORDS[language].question(name),
    );
    await screenshot(window, `meeting-delete-permanently-${language}`);
    await window.keyboard.press("Escape");
    await expect(question).toBeHidden();
    await expect(rows).toHaveCount(1);
    await pointAndClick(window, rows.getByTestId("deleted-restore"));
    await expect(undoMessage(window)).toHaveText(WORDS[language].restored(name));

    await pointAndClick(window, noteRow(window, name).getByTestId("mind-list-item"));
    await expect(frontMindName(window)).toHaveText(name);
    await screenshot(window, `meeting-restore-restored-${language}`);
    await stoppedControl(window, language);
    expect((await meetings(window))[0]).toMatchObject({ id: meeting.id, status: "stopped" });
    expect(partsOf(meeting.id).length).toBeGreaterThan(0);
    await opensTranscript(window, meeting.mindId);
    await app.close();
  });

  test(`Undo says so when the audio is no longer on this computer, and the Meeting comes back without it (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 900);
    const { name, meeting } = await recording(window, language);
    await stopMeeting(window);
    await stoppedControl(window, language);
    await pointAndClick(window, (await tabMenu(window)).getByTestId("mind.delete"));
    await expect(undoMessage(window)).toHaveText(WORDS[language].deleted(name));
    // Something outside IncarnaMind removes it while the Note waits in Recently deleted.
    await rm(join(dataDir, "meetings", meeting.id), { recursive: true });

    await window.keyboard.press("ControlOrMeta+z");

    await expect(window.getByTestId("undo-line").getByTestId("undo-note")).toHaveText(
      WORDS[language].lost(name),
    );
    await expect(frontMindName(window)).toHaveText(name);
    await stoppedControl(window, language);
    expect(await audioLine(window)).toMatch(WORDS[language].gone);
    await screenshot(window, `meeting-undo-lost-${language}`);
    await app.close();
  });
}
