import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { readVtt } from "../src/core/documents/formats/vtt";
import type { FakeCapture } from "../src/core/meetings/fakeCapture";
import type { TestHooks } from "../src/shared/testHooks";
import {
  askInAssistant,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  expectSheetFootOneRow,
  firstTranscriptLine,
  forceQuit,
  frontMindName,
  launchApp,
  motionSettled,
  openDocumentAt,
  openMeetingDetails,
  openMeetingSheet,
  openSettings,
  openTranscriptBeside,
  paletteFound,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  stopMeeting,
  transcriptSaved,
  turnOf,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/**
 * Recording a Meeting (#135), with the fake capture every smoke test gets: a
 * tone for the microphone and for the computer's sound, never a device. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const bridge = (window: Page) =>
  window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings(),
  );

/** ⌘K with this typed, once it is open and has the focus. */
async function searchPalette(window: Page, text: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(text);
  await expect(window.getByTestId("palette-search")).toHaveValue(text);
}

/** The parts saved for a Meeting's source, by where they start, in ms. */
function partsOf(meetingId: string, source: "microphone" | "system"): number[] {
  const folder = join(dataDir, "meetings", meetingId);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .map((name) => new RegExp(`^${source}-(\\d{10})\\.wav$`).exec(name)?.[1])
    .filter((offset): offset is string => offset !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

const fakeAudio = (app: ElectronApplication) =>
  app.evaluate(() => {
    const fake = (globalThis as { incarnamindFakeAudio?: FakeCapture }).incarnamindFakeAudio;
    if (!fake) throw new Error("The app isn't recording with the fake capture.");
    return { settingsOpened: [...fake.settingsOpened], running: fake.running };
  });

test("a meeting records at once from the + menu, the first time too, turning nothing else on: the control, the sheet's line, ⌘⇧P, Stop and Delete audio, from the line and from ⌘K", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await useOutputLocation(window, sources);
  // From the first run: the + menu offers "Record a meeting" at its top level, with nothing to
  // turn on first (#763).
  await window.getByTestId("plus-menu").click();
  await expect(window.getByTestId("plus-record-meeting")).toHaveText("Record a meeting");
  if (SCREENSHOTS) await shot(window, "plus-menu-record-en");
  await window.keyboard.press("Escape");
  const settings = await openSettings(window, "meetings");
  await expect(settings.getByTestId("meetings-settings")).toBeVisible();
  await expect(settings.getByTestId("meetings-enabled")).toHaveCount(0);
  if (SCREENSHOTS) await shot(window, "settings-meetings-en");
  await closeSettings(window);
  const device = () =>
    window.evaluate(
      async () =>
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings())
          .device,
    );
  const before = await device();

  // The first recording on this device starts at once, recording both sides, with no card to
  // read and no start block (#3762).
  const control = await recordMeeting(window);
  await expect(frontMindName(window)).toHaveText(/^Meeting, \d{1,2} [A-Z][a-z]+$/);
  await expect(window.getByTestId("end-hint")).toHaveText(
    "Write the agenda, or anything you want to cover…",
  );
  await expect(window.getByTestId("meeting-notice")).toHaveCount(0);
  await expect(window.getByTestId("meeting-start")).toHaveCount(0);
  expect((await bridge(window))[0]).toMatchObject({ status: "recording", systemAudio: true });
  // Starting turns no other setting on: the offers to take notes and what they need stay as they were.
  await expect.poll(async () => (await device()).meetingNoticeAccepted).toBe(true);
  expect(await device()).toMatchObject({
    callOffers: before.callOffers,
    keepRunning: before.keepRunning,
  });
  await shot(window, "meeting-start-en");

  // The sheet says the one thing to do, in English and Chinese, and shows the time, its dot red
  // as on the tab.
  const sheet = await openMeetingSheet(window);
  const tell = sheet.locator(".meeting-sheet-consent");
  await expect(tell).toHaveText("Tell everyone you’re recording.");
  const time = sheet.getByTestId("meeting-sheet-time");
  await expect(time.getByRole("timer")).toHaveText(/^0:0[2-9]$/);
  await expect(time.locator(".recording-dot")).toHaveCSS("background-color", "rgb(180, 35, 24)");
  await shot(window, "meeting-sheet-en");
  await setLanguage(window, "zh-CN");
  await expect(tell).toHaveText("告诉所有人你正在录音。");
  expect(await tell.textContent()).not.toMatch(/[。：] /);
  await setLanguage(window, "en");
  // Esc folds it back to the chevron it rose from.
  await window.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(control.getByTestId("meeting-foot-transcript")).toBeFocused();
  await expect(control.getByTestId("meeting-foot-transcript")).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  // The control stands at the Note's foot, under the notes and inside the text's edges; the
  // composer stays for asking.
  const page = await window.getByTestId("mind-pane").locator(".mind-measure").boundingBox();
  const scroller = await window.getByTestId("mind-scroller").boundingBox();
  const controls = await control.boundingBox();
  if (!page || !scroller || !controls) throw new Error("The meeting's control isn't drawn.");
  expect(controls.y).toBeGreaterThanOrEqual(scroller.y + scroller.height - 1);
  expect(controls.x).toBeGreaterThanOrEqual(page.x - 1);
  expect(controls.x + controls.width).toBeLessThanOrEqual(page.x + page.width + 1);
  await expect(window.getByTestId("composer")).not.toContainText("Recording");
  // The tab shows the recording: a red dot and the meeting's time.
  const tab = window.getByTestId("mind-tab").filter({ hasText: "Meeting" });
  await expect(tab.getByTestId("mind-tab-recording")).toHaveAttribute("data-status", "recording");
  await expect(tab.getByTestId("mind-tab-recording")).toHaveCSS(
    "background-color",
    "rgb(180, 35, 24)",
  );
  await expect(tab.getByTestId("mind-tab-time")).toHaveText(/^0:\d\d$/);
  await shot(window, "meeting-foot-en");

  // Notes written above scroll over the control, which stays in view at the foot; the last line
  // ends above it.
  const notesText = window.getByTestId("mind-editor");
  await notesText.click();
  for (let line = 0; line < 30; line++) await window.keyboard.press("Enter");
  await window.keyboard.type("Rebates stay as they are until January.");
  await window.locator(".mind-scroller").evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  await expect(notesText.locator(":scope > *").first()).not.toBeInViewport();
  const lastLine = notesText.locator(":scope > *").last();
  await expect(lastLine).toBeInViewport();
  await expect(control).toBeInViewport();
  const lastBox = await lastLine.boundingBox();
  const footBox = await control.boundingBox();
  expect((lastBox?.y ?? 0) + (lastBox?.height ?? 0)).toBeLessThanOrEqual((footBox?.y ?? 0) + 1);
  await shot(window, "meeting-foot-scrolled-en");

  // While it records, Documents wait to be read; its Transcript is read at once.
  const file = join(sources, "Agenda.md");
  await writeFile(file, "# Agenda\n\nThe rebates.\n");
  await window.evaluate(async (path) => {
    const hooks = (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks;
    if (!hooks) throw new Error("Test hooks are off.");
    await hooks.addPaths([path]);
  }, file);
  const agenda = window.getByTestId("document-list-item").filter({ hasText: "Agenda" });
  await expect(agenda).toHaveAttribute("data-status", "queued");
  await expect(window.getByTestId("reading-paused")).toBeVisible();

  // ⌘⇧P (Ctrl+Shift+P) is the "Pause recording" command, bound in the window's one keymap:
  // it works while the User types in the meeting's notes, and types nothing there.
  const notes = window.getByTestId("mind-editor");
  await notes.click();
  await window.keyboard.press("End");
  await window.keyboard.type(" Next item");
  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(control).toHaveAttribute("data-status", "paused");
  await expect(notes).toContainText("Next item");
  await expect(notes).not.toContainText(/Next itemP/i);
  // Paused, Resume recording stands in the level's place, and the tab's dot is no longer red.
  await expect(control.getByTestId("meeting-foot-level")).toHaveCount(0);
  await expect(control.getByTestId("meeting-foot-resume-recording")).toHaveAccessibleName(
    "Resume recording",
  );
  await expect(tab.getByTestId("mind-tab-recording")).toHaveAttribute("data-status", "paused");
  await expect(tab.getByTestId("mind-tab-recording")).not.toHaveCSS(
    "background-color",
    "rgb(180, 35, 24)",
  );
  await shot(window, "meeting-paused-en");
  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(control).toHaveAttribute("data-status", "recording");

  // From another Mind, the key pauses the meeting that records: its tab's dot turns grey.
  // Resuming is for the meeting in view, so a paused meeting never starts from elsewhere.
  const meetingTab = window.getByTestId("mind-tab").filter({ hasText: "Meeting" });
  await window.keyboard.press("ControlOrMeta+KeyN");
  await expect(window.getByTestId("mind-tab")).toHaveCount(2);
  await enterContent(window);
  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  const tabDot = meetingTab.getByTestId("mind-tab-recording");
  await expect(tabDot).toHaveAttribute("data-status", "paused");
  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(tabDot).toHaveAttribute("data-status", "paused");
  await meetingTab.click();
  await expect(control).toHaveAttribute("data-status", "paused");
  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(control).toHaveAttribute("data-status", "recording");

  await stopMeeting(window);
  // The page stays bare (#2527): the control says Transcript, and the audio's line is in the
  // sheet's recording details.
  await expect(control.getByTestId("meeting-foot-transcript")).toHaveText("Transcript");
  await expect(window.locator('[data-testid="meeting-audio"]:visible')).toHaveCount(0);
  const details = await openMeetingDetails(window);
  const audio = details.getByTestId("meeting-audio");
  await expect(audio).toContainText(/^Recorded 0:\d\d · Audio kept until /);
  // Stopped, the Document is read.
  await expect(
    window.getByTestId("document-list-item").filter({ hasText: "Agenda" }),
  ).toHaveAttribute("data-status", "ready");
  await shot(window, "meeting-stopped-en");

  // It can't be undone, so the line asks first; Esc keeps it, and only the question closes.
  await expect(audio.getByTestId("meeting-audio-delete")).toHaveText("Delete audio now");
  await pointAndClick(window, audio.getByTestId("meeting-audio-delete"));
  const confirm = window.getByTestId("meeting-audio-confirm");
  await expect(confirm).toContainText("for good? The note stays.");
  await expect(confirm.getByTestId("meeting-audio-delete-confirm")).toBeFocused();
  const question = await confirm.textContent();
  await window.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(audio).toContainText("Audio kept until");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("meeting-sheet")).toBeHidden();

  // ⌘K's "Delete audio" is the same command: the same question, in the same place, raised with
  // the sheet folded, and Esc or "Keep it" keeps the audio.
  const palette = window.getByTestId("palette");
  const deleteAudio = paletteFound(window).filter({ hasText: "Delete audio" });
  await searchPalette(window, "delete audio");
  await expect(deleteAudio).toHaveCount(1);
  await shot(window, "meeting-delete-audio-palette-en");
  await window.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(confirm).toHaveText(question ?? "");
  await expect(confirm.getByTestId("meeting-audio-delete-confirm")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await searchPalette(window, "delete audio");
  await window.keyboard.press("Enter");
  await pointAndClick(window, confirm.getByRole("button", { name: "Keep it" }));
  await expect(audio).toContainText("Audio kept until");
  expect((await bridge(window))[0]?.audio.kept).toBe(true);

  await pointAndClick(window, audio.getByTestId("meeting-audio-delete"));
  await shot(window, "meeting-delete-audio-en");
  await pointAndClick(window, window.getByTestId("meeting-audio-delete-confirm"));
  await expect(audio).toContainText("Audio deleted");
  await window.keyboard.press("Escape");
  await expect(audio).toBeHidden();
  const [meeting] = await bridge(window);
  expect(meeting?.audio.kept).toBe(false);
  expect(existsSync(join(dataDir, "meetings", meeting?.id ?? ""))).toBe(false);

  // With the audio gone, there is nothing to delete, and ⌘K no longer offers it.
  await searchPalette(window, "delete audio");
  await expect(deleteAudio).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  // The next meeting records at once too, with no card and no start block.
  await recordMeeting(window);
  await expect(window.getByTestId("meeting-notice")).toHaveCount(0);
  await expect(window.getByTestId("meeting-start")).toHaveCount(0);
});

test("the first Record waits for macOS: the page says so with no timer or meter, and the Transcript gap says it waited, in English and Chinese", async () => {
  test.setTimeout(150_000);
  const { app, window } = await launchApp(dataDir, { microphone: "waiting" });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useOutputLocation(window, sources);
  const control = await recordMeeting(window);
  const [meeting] = await bridge(window);
  if (!meeting) throw new Error("No Meeting.");

  // While the system's prompt is open the page waits: the level's place says so, with no meter,
  // and neither the sheet nor the tab runs a timer.
  const level = control.getByTestId("meeting-foot-level");
  await expect(level).toHaveAttribute("title", "Waiting for macOS…");
  await expect(control.getByTestId("level-bars")).toHaveCount(0);
  await expect(window.getByTestId("mind-tab-time")).toHaveCount(0);
  const sheet = await openMeetingSheet(window);
  await expect(sheet.getByRole("timer")).toHaveCount(0);
  await shot(window, "meeting-waiting-permission-en");
  await setLanguage(window, "zh-CN");
  await expect(level).toHaveAttribute("title", "正在等待 macOS 授权…");
  await shot(window, "meeting-waiting-permission-zh");
  await setLanguage(window, "en");
  await pointAndClick(window, sheet.getByTestId("meeting-sheet-hide"));
  await expect(sheet).toBeHidden();

  // The prompt is answered after a second or more: recording starts, and the page shows it.
  await expect
    .poll(async () => {
      const current = (await bridge(window)).find((each) => each.id === meeting.id);
      const since = current?.recordingSince ? Date.parse(current.recordingSince) : 0;
      return since === 0 ? 0 : Date.now() - since;
    })
    .toBeGreaterThanOrEqual(1500);
  await app.evaluate(() => {
    const fake = (globalThis as { incarnamindFakeAudio?: FakeCapture }).incarnamindFakeAudio;
    if (!fake) throw new Error("The app isn't recording with the fake capture.");
    fake.answerPermission();
  });
  await expect(level).toHaveAttribute("title", "Sound level");
  await expect(control.getByTestId("level-bars")).toHaveCount(1);
  await expect(window.getByTestId("mind-tab-time")).toHaveText(/^\d+:\d\d$/);
  await openMeetingSheet(window);
  await expect(sheet.getByRole("timer")).toHaveText(/^\d+:\d\d$/);
  await shot(window, "meeting-permission-answered-en");

  // The live Transcript says what happened in the stretch with no audio, never that it was deleted.
  await openTranscriptBeside(window);
  const transcript = window.getByTestId("viewer-transcript");
  const gap = transcript.locator('[data-testid="transcript-gap"][data-reason="permission"]');
  await expect(gap).toHaveCount(1);
  await expect(gap).toContainText(/not transcribed: waiting for permission$/);
  await expect(transcript).not.toContainText("its audio was deleted");
  await setLanguage(window, "zh-CN");
  await expect(gap).toContainText(/未转写：等待麦克风授权$/);
  await shot(window, "meeting-permission-gap-zh");
  await setLanguage(window, "en");

  await stopMeeting(window);
  await expect
    .poll(async () => {
      const current = (await bridge(window)).find((each) => each.id === meeting.id);
      return current?.transcript?.state;
    })
    .toBe("saved");
  const saved = readVtt(readFileSync(join(dataDir, "Transcripts", `${meeting.id}.vtt`), "utf8"));
  const permission = saved.gaps.filter((each) => each.reason === "permission");
  expect(permission).toHaveLength(1);
  expect((permission[0]?.toMs ?? 0) - (permission[0]?.fromMs ?? 0)).toBeGreaterThanOrEqual(1000);
  expect(saved.gaps.map((each) => each.reason)).not.toContain("lost");
  expect(saved.gaps.every((each) => each.toMs - each.fromMs >= 1000)).toBe(true);
  await shot(window, "meeting-permission-saved-en");
});

test("an engine that can't start says so in plain words, never in its JavaScript error, in English and Chinese", async () => {
  const error = "Cannot read properties of undefined (reading 'createAsync')";
  const { app, window } = await launchApp(dataDir, { transcriber: { failToLoad: error } });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  // Its audio is kept until it is deleted, so the line after Stop names no time of day.
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      device: { keepMeetingAudio: true },
    }),
  );
  await recordMeeting(window);

  // Over the meeting's control, as a card of its own.
  const line = window.locator(".meeting-foot-over").getByTestId("meeting-transcript-line");
  await expect(line).toHaveText("Transcription stopped. · Try again", { timeout: 30_000 });
  await expect(line).not.toContainText("createAsync");
  await shot(window, "meeting-transcript-engine-stopped-en");
  await setLanguage(window, "zh-CN");
  await expect(line).toHaveText("转写已停止。· 重试");
  await shot(window, "meeting-transcript-engine-stopped-zh");
  const [meeting] = await bridge(window);
  expect(meeting?.status).toBe("recording");

  // Stopped, the Meeting's Note says the Transcript isn't finished and that its recording is kept,
  // while it is (#2957), once, over its control.
  await stopMeeting(window);
  await expect
    .poll(async () => (await bridge(window))[0]?.audio)
    .toMatchObject({ kept: true, keptUntilDeleted: true });
  await expect(line).toHaveText("转写中途停止，录音已保留。· 重试");
  await expect(window.locator('[data-testid="meeting-transcript-line"]:visible')).toHaveCount(1);
  await shot(window, "meeting-transcript-stopped-before-end-zh");
  await setLanguage(window, "en");
  await expect(line).toHaveText(
    "Transcription stopped before the end. Your recording is kept. · Try again",
  );
  await expect(line).not.toContainText("createAsync");
  await shot(window, "meeting-transcript-stopped-before-end-en");

  // Its audio deleted, the line no longer says it is kept, with nothing reloaded.
  const meetingId = meeting?.id as string;
  await window.evaluate(
    (id) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.deleteMeetingAudio(id),
    meetingId,
  );
  await expect(line).toHaveText("Transcription stopped. · Try again");
});

test("Open beside opens the live Transcript next to the meeting, closing its tab hides it, and at Stop it is saved", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  // No Output location chosen: the Transcript goes to the default, Documents › IncarnaMind.
  const control = await recordMeeting(window);

  // Lines come from the first seconds of sound: it can open beside once the first is in.
  await openTranscriptBeside(window);
  const transcriptTab = window.getByTestId("document-tab").filter({ hasText: "Transcript" });
  await expect(transcriptTab).toHaveCount(1);
  const transcript = window.getByTestId("viewer-transcript");
  await expect(transcript).toBeVisible();
  await expect(window.getByTestId("viewer-title")).toHaveText(
    /^Transcript · Meeting, \d{1,2} \w+$/,
  );
  await expect(window.getByTestId("transcript-live")).toHaveText("Live");
  await expect(transcript.getByTestId("transcript-line").first()).toContainText(
    "Let's start with the launch date.",
  );
  await expect(transcript.getByTestId("transcript-line").nth(1)).toBeVisible({ timeout: 20_000 });
  // The microphone's lines are Me, the computer sound's Them, from the first line.
  const speakers = transcript.getByTestId("transcript-speaker");
  await expect(speakers.first()).toHaveText("Me");
  await expect(speakers.filter({ hasText: /^Them$/ }).first()).toBeVisible({ timeout: 20_000 });
  // As the board draws a turn: the time in a column of its own, the label above the words, in a grey that isn't a colour.
  const row = transcript.getByTestId("transcript-turn").first();
  const [timeBox, labelBox, wordsBox] = await Promise.all([
    row.locator(".transcript-time").boundingBox(),
    row.getByTestId("transcript-speaker").boundingBox(),
    row.locator(".transcript-text").first().boundingBox(),
  ]);
  expect((timeBox?.x ?? 0) + (timeBox?.width ?? 0)).toBeLessThanOrEqual(labelBox?.x ?? 0);
  expect((labelBox?.y ?? 0) + (labelBox?.height ?? 0)).toBeLessThanOrEqual(wordsBox?.y ?? 0);
  expect(wordsBox?.x).toBe(labelBox?.x);
  const label = await row.getByTestId("transcript-speaker").evaluate((element) => {
    const style = getComputedStyle(element);
    const [red = 0, green = 0, blue = 0] = style.color.match(/\d+/g)?.map(Number) ?? [];
    return {
      size: style.fontSize,
      weight: style.fontWeight,
      spread: Math.max(red, green, blue) - Math.min(red, green, blue),
    };
  });
  expect(label).toMatchObject({ size: "12px", weight: "600" });
  expect(label.spread).toBeLessThan(24);
  // A tab of its own in the group beside the meeting's Mind, which stays where it was.
  await expect(window.getByTestId("tab-group")).toHaveCount(2);
  const mindGroup = await window.getByTestId("tab-group").first().boundingBox();
  const transcriptBox = await transcript.boundingBox();
  if (!mindGroup || !transcriptBox) throw new Error("The groups aren't drawn.");
  expect(transcriptBox.x).toBeGreaterThanOrEqual(mindGroup.x + mindGroup.width - 1);
  await expect(control).toHaveAttribute("data-status", "recording");
  await shot(window, "meeting-transcript-wide-en");
  // A narrow window shows its groups merged: the Transcript is the tab after the Mind's.
  await setWindowSize(app, window, 900, 700);
  await window.getByTestId("mind-tab").click();
  await expect(control).toBeVisible();
  await shot(window, "meeting-foot-narrow-en");
  await transcriptTab.click();
  await expect(transcript).toBeVisible();
  await shot(window, "meeting-transcript-narrow-en");
  await setWindowSize(app, window, 1440, 900);

  // Hidden, it is still a Document: searchable and citable.
  await transcriptTab.hover();
  await transcriptTab.getByTestId("tab-close").click();
  await expect(transcript).toBeHidden();
  const [meeting] = await bridge(window);
  const documentId = meeting?.transcript?.documentId ?? "";
  expect(documentId).not.toBe("");
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const found = await core.searchPassages("launch date", { mode: "keyword" });
        return found.map((passage) => passage.documentId);
      }),
    )
    .toContain(documentId);
  await shot(window, "meeting-foot-transcript-en");

  // In Chinese, the same controls in Chinese words.
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await expect(control.getByTestId("meeting-foot-transcript")).toHaveAccessibleName(
    /^显示转写稿（.+）$/,
  );
  await expect(control.getByTestId("meeting-foot-stop")).toHaveAccessibleName("停止录制");
  await shot(window, "meeting-foot-transcript-zh");
  const sheet = await openMeetingSheet(window);
  await expect(sheet.getByRole("heading")).toHaveText("转写稿");
  const beside = sheet.getByTestId("meeting-sheet-beside");
  await expect(beside).toHaveAccessibleName("在右侧一栏中打开转写稿");
  await pointAndClick(window, beside);
  await expect(sheet).toBeHidden();
  await expect(window.getByTestId("transcript-live")).toHaveText("实时");
  await expect(speakers.filter({ hasText: /^我$/ }).first()).toBeVisible();
  await expect(speakers.filter({ hasText: /^对方$/ }).first()).toBeVisible();
  await shot(window, "meeting-transcript-wide-zh");
  await setWindowSize(app, window, 900, 700);
  await window.getByTestId("mind-tab").filter({ hasText: "Meeting" }).click();
  await expect(control).toBeVisible();
  await shot(window, "meeting-foot-narrow-zh");
  // Named when its first line came, the Transcript keeps its name in another language.
  await transcriptTab.click();
  await expect(transcript).toBeVisible();
  // At the narrowest, a label fits its turn.
  const firstTurn = transcript.getByTestId("transcript-turn").first();
  const [narrowLine, narrowLabel] = await Promise.all([
    firstTurn.boundingBox(),
    firstTurn.getByTestId("transcript-speaker").boundingBox(),
  ]);
  expect((narrowLabel?.x ?? 0) + (narrowLabel?.width ?? 0)).toBeLessThanOrEqual(
    (narrowLine?.x ?? 0) + (narrowLine?.width ?? 0),
  );
  await shot(window, "meeting-transcript-narrow-zh");
  await setWindowSize(app, window, 1440, 900);

  // At Stop it is finished and kept in the Library, with no folder to choose and no .vtt to read
  // (#763); the page says nothing of it (#2527), and the control, saying Transcript, opens it.
  await window.getByTestId("mind-tab").click();
  await stopMeeting(window);
  await transcriptSaved(window);
  await expect(window.getByTestId("meeting-transcript-line")).toHaveCount(0);
  await expect(control.getByTestId("meeting-foot-transcript")).toHaveText("转写稿");
  await shot(window, "meeting-transcript-saved-zh");
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "en" },
    }),
  );
  await expect(control.getByTestId("meeting-foot-transcript")).toHaveText("Transcript");
  await expect((await openMeetingDetails(window)).getByTestId("meeting-audio")).toContainText(
    /^Recorded \d+:\d\d · /,
  );
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("meeting-sheet")).toBeHidden();
  await expect(window.getByTestId("file-write-dialog")).toBeHidden();
  await expect(window.getByTestId("transcript-live")).toHaveCount(0);
  const [stopped] = await bridge(window);
  expect(dirname(stopped?.transcript?.savedPath ?? "")).toBe(join(dataDir, "Transcripts"));
  expect(existsSync(stopped?.transcript?.savedPath ?? "")).toBe(true);
  expect(existsSync(join(dataDir, "Documents", "IncarnaMind"))).toBe(false);
  await shot(window, "meeting-transcript-saved-en");

  // Opened at a Citation, the quote is washed in the line it was said in.
  await openDocumentAt(window, {
    documentId,
    pageFrom: 1,
    pageTo: 1,
    quote: "The launch moves to the eighteenth of November.",
    citation: { check: "found", number: 1, label: "0:01" },
  });
  const washed = window.getByTestId("viewer-transcript").locator("[data-quote-highlight]");
  await expect(washed.first()).toBeVisible();
  // Each word is an element of its own (#138), so the wash comes in pieces that read as the line.
  await expect
    .poll(async () => (await washed.allTextContents()).join(""))
    .toBe("The launch moves to the eighteenth of November.");
  await shot(window, "meeting-transcript-citation-en");
});

test("notes during the call: typed lines get their time, Mark (⌘D) and Add to note work by keyboard, and the Citation is found", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  // No Output location chosen: the Transcript goes to the default, Documents › IncarnaMind.
  const control = await recordMeeting(window);
  await openTranscriptBeside(window);
  const transcript = window.getByTestId("viewer-transcript");
  /** The sheet's Mark, which it shows while the sheet is up: the sheet folds again after. */
  const sheetMark = async (check: (mark: Locator) => Promise<void>) => {
    const sheet = await openMeetingSheet(window);
    await check(sheet.getByTestId("meeting-sheet-mark"));
    await pointAndClick(window, sheet.getByTestId("meeting-sheet-hide"));
    await expect(sheet).toBeHidden();
  };
  const lines = transcript.getByTestId("transcript-line");
  await expect(lines.first()).toBeVisible();

  // A line typed while recording takes the meeting's time, shown when it is pointed at.
  const notes = window.getByTestId("mind-editor");
  await notes.click();
  await window.keyboard.type("Launch date");
  const typed = notes.locator("p", { hasText: "Launch date" });
  await expect(typed).toHaveAttribute("data-meeting-time", /^\d+:\d{2}$/);
  const [minutes = 0, seconds = 0] = ((await typed.getAttribute("data-meeting-time")) ?? "")
    .split(":")
    .map(Number);
  const typedSeconds = minutes * 60 + seconds;
  await typed.hover();
  await shot(window, "meeting-typed-time-wide-en");

  // It falls within the line the Transcript has from that moment: after its start, before the next one.
  const starts = () =>
    lines.evaluateAll((all) => all.map((each) => Number(each.getAttribute("data-start"))));
  await expect
    .poll(async () => (await starts()).some((start) => start / 1000 > typedSeconds + 0.5), {
      timeout: 30_000,
    })
    .toBe(true);
  const all = await starts();
  const here = all.filter((start) => start / 1000 <= typedSeconds + 1).at(-1);
  const next = all.find((start) => start / 1000 > typedSeconds + 0.5);
  expect(here).toBeDefined();
  expect(next).toBeDefined();
  expect(Math.floor((here ?? 0) / 1000)).toBeLessThanOrEqual(typedSeconds);
  expect(Math.ceil((next ?? 0) / 1000)).toBeGreaterThanOrEqual(typedSeconds);

  // Mark: ⌘D leaves an empty bullet with its time, the cursor in it.
  await window.keyboard.press("ControlOrMeta+KeyD");
  const marked = notes.locator("li p[data-meeting-time]");
  await expect(marked).toHaveCount(1);
  await expect(marked).toHaveText("");
  await expect(marked).toHaveAttribute("data-meeting-time", /^\d+:\d{2}$/);
  await window.keyboard.type("Ask about the payment review");
  await expect(marked).toHaveText("Ask about the payment review");
  await sheetMark((mark) => expect(mark).toBeEnabled());
  await shot(window, "meeting-mark-wide-en");

  // Add to note, by keyboard: the line takes the focus, Enter adds it with a Citation that is found.
  const second = lines.nth(1);
  await expect(second).toBeVisible({ timeout: 20_000 });
  await second.hover();
  await second.click();
  await expect(second).toBeFocused();
  await expect(turnOf(second).getByTestId("transcript-add")).toBeVisible();
  await shot(window, "meeting-add-to-note-wide-en");
  const quote = (await second.textContent()) ?? "";
  await window.keyboard.press("ArrowUp");
  await expect(lines.first()).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await expect(second).toBeFocused();
  await window.keyboard.press("Enter");
  // It shows for a few seconds: asserted first.
  await expect(window.getByTestId("transcript-added")).toHaveText("Added to the note");
  const citation = notes.getByTestId("citation");
  await expect(citation).toHaveCount(1);
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(notes.locator("li", { hasText: quote })).toHaveCount(1);
  // The cursor stays in the Transcript, where the User is reading.
  await expect(second).toBeFocused();

  // The same line again is shown, not added twice.
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("transcript-added")).toHaveText("Already in the note");
  await expect(citation).toHaveCount(1);

  // Undo takes it back, outside a text field.
  await window.getByTestId("undo-action").click();
  await expect(citation).toHaveCount(0);

  // A transcript line can also be added with the mouse.
  const third = lines.nth(2);
  await expect(third).toBeVisible({ timeout: 20_000 });
  await third.hover();
  await turnOf(third).getByTestId("transcript-add").click();
  await expect(citation).toHaveCount(1);
  await expect(citation).toHaveAttribute("data-check", "found");

  // In a pause no time is taken, and Mark is off.
  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(control).toHaveAttribute("data-status", "paused");
  await sheetMark((mark) => expect(mark).toBeDisabled());
  await typed.click();
  await expect(notes).toBeFocused();
  await window.keyboard.press("End");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Typed in the pause");
  await expect(notes.locator("p", { hasText: "Typed in the pause" })).not.toHaveAttribute(
    "data-meeting-time",
  );
  const timed = await notes.locator("[data-meeting-time]").count();
  await window.keyboard.press("ControlOrMeta+KeyD");
  await expect(notes.locator("[data-meeting-time]")).toHaveCount(timed);

  // Resumed, it times lines again.
  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(control).toHaveAttribute("data-status", "recording");
  // Chinese and a narrow window hold the same controls.
  const setLanguage = (language: "en" | "zh-CN") =>
    window.evaluate(
      async (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    );
  await setLanguage("zh-CN");
  await sheetMark((mark) => expect(mark).toHaveText("标记"));
  await typed.hover();
  await shot(window, "meeting-typed-time-wide-zh");
  const fourth = lines.nth(3);
  await expect(fourth).toBeVisible({ timeout: 20_000 });
  await fourth.hover();
  await turnOf(fourth).getByTestId("transcript-add").click();
  await expect(window.getByTestId("undo-message")).toHaveText("已将转写稿中的一句加入笔记");
  await third.hover();
  await expect(turnOf(third).getByTestId("transcript-add")).toContainText("加入笔记");
  // Reserved at the turn's end: it covers no words, and nothing moves when it shows.
  const words = await third.locator("xpath=ancestor::p[1]").boundingBox();
  const button = await turnOf(third).getByTestId("transcript-add").boundingBox();
  if (!words || !button) throw new Error("The line isn't drawn.");
  expect(button.x).toBeGreaterThanOrEqual(words.x + words.width - 1);
  await shot(window, "meeting-add-to-note-wide-zh");
  await setWindowSize(app, window, 900, 700);
  await window
    .getByTestId("mind-tab")
    .filter({ hasText: /Meeting|会议/ })
    .click();
  await expect(control).toBeVisible();
  await sheetMark((mark) => expect(mark).toBeInViewport({ ratio: 1 }));
  await typed.hover();
  await shot(window, "meeting-mark-narrow-zh");
  await setLanguage("en");
  await shot(window, "meeting-mark-narrow-en");
  await window.getByTestId("document-tab").filter({ hasText: "Transcript" }).click();
  await third.hover();
  await shot(window, "meeting-add-to-note-narrow-en");
  await window.getByTestId("mind-tab").filter({ hasText: "Meeting" }).click();
  await setWindowSize(app, window, 1440, 900);
  await expect(third).toBeVisible();

  // The times are kept once the meeting is stopped.
  await stopMeeting(window);
  await expect(typed).toHaveAttribute("data-meeting-time", /^\d+:\d{2}$/);
});

test("with the computer's sound denied, a line says so and opens System Settings; the microphone records on", async () => {
  const { app, window } = await launchApp(dataDir, { computerSound: "denied" });
  await dismissChatSetup(window);
  const control = await recordMeeting(window);

  // The line is in the sheet, under its head, with the way to System Settings.
  const sheet = await openMeetingSheet(window);
  const line = sheet.getByTestId("meeting-line-system");
  await expect(line).toContainText(
    "Only your microphone is recorded: computer sound isn’t allowed.",
  );
  await expect(control).toHaveAttribute("data-status", "recording");
  await shot(window, "meeting-system-denied-en");
  const open = line.getByTestId("meeting-settings-system");
  await open.hover();
  await open.click();
  await expect.poll(async () => (await fakeAudio(app)).settingsOpened).toEqual(["system"]);

  // Nothing tells the User from the others without the computer's sound: the lines read Speaker ?
  await openTranscriptBeside(window);
  const speakers = window.getByTestId("viewer-transcript").getByTestId("transcript-speaker");
  await expect(speakers.first()).toHaveText("Speaker ?");
  await expect(speakers.filter({ hasNotText: /^Speaker \?$/ })).toHaveCount(0);

  // In Chinese, the same line in Chinese words.
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await expect(speakers.first()).toHaveText("发言人 ?");
  await expect(control).toHaveAccessibleName("会议录制");
  await openMeetingSheet(window);
  await expect(line).toContainText("只录到了麦克风：没有录制电脑声音的权限。");
  await shot(window, "meeting-system-denied-zh");
  if (SCREENSHOTS) {
    await window.getByTestId("sidebar-footer").getByRole("button", { name: "设置" }).click();
    await showSettingsPage(window, "meetings");
    await shot(window, "settings-meetings-zh");
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("settings")).toBeHidden();
  }

  // At the narrowest window, the sheet keeps its controls on one row, and the control its height.
  await setWindowSize(app, window, 900, 660);
  await expect(control).toBeVisible();
  await expectSheetFootOneRow(sheet);
  const box = await control.boundingBox();
  expect(box?.height).toBeLessThanOrEqual(44);
  await shot(window, "meeting-foot-narrow-zh");
});

test("a microphone that gives nothing but silence says so after 15 seconds, with the way to its settings", async () => {
  const { app, window } = await launchApp(dataDir, { microphone: "silent" });
  await dismissChatSetup(window);
  const control = await recordMeeting(window);

  // Over the control, a card says it in short, with the way to its settings.
  const card = window.getByTestId("meeting-foot-problem");
  await expect(card).toContainText("Your mic isn’t heard", { timeout: 20_000 });
  await expect(control).toHaveAttribute("data-status", "recording");
  const settings = card.getByTestId("meeting-foot-problem-settings");
  await settings.hover();
  await settings.click();
  await expect.poll(async () => (await fakeAudio(app)).settingsOpened).toEqual(["microphone"]);
  // The sheet says it whole, with the same way there.
  const line = (await openMeetingSheet(window)).getByTestId("meeting-line-microphone");
  await expect(line).toContainText(
    "No sound from the microphone for 15 seconds: it may be muted, or the wrong one chosen.",
  );
  // In Chinese, the same lines in Chinese words.
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await expect(line).toContainText("15 秒没有麦克风声音：可能已静音，或选错了麦克风。");
  const open = line.getByTestId("meeting-settings-microphone");
  await open.hover();
  await open.click();
  await expect
    .poll(async () => (await fakeAudio(app)).settingsOpened)
    .toEqual(["microphone", "microphone"]);
  await window.keyboard.press("Escape");
  await expect(card).toContainText("听不到你的麦克风");
  await stopMeeting(window);
});

// protects=a microphone that is open while no audio comes in at all is said within 15 seconds, in both languages, instead of a bar that reads Recording while the Meeting captures nothing (#3248)
test("a microphone that opens and gives no audio at all says so after 15 seconds", async () => {
  const { app, window } = await launchApp(dataDir, { microphone: "nothing" });
  await dismissChatSetup(window);
  const control = await recordMeeting(window);

  const card = window.getByTestId("meeting-foot-problem");
  await expect(card).toContainText("Your mic isn’t heard", { timeout: 20_000 });
  const line = (await openMeetingSheet(window)).getByTestId("meeting-line-microphone");
  await expect(line).toContainText(
    "No sound from the microphone for 15 seconds: it may be muted, or the wrong one chosen.",
  );
  await expect(control).toHaveAttribute("data-status", "recording");
  await setWindowSize(app, window, 1100, 700);
  await shot(window, "meeting-microphone-nothing");
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await expect(line).toContainText("15 秒没有麦克风声音：可能已静音，或选错了麦克风。");
  await pointAndClick(window, window.getByTestId("meeting-sheet-hide"));
  await expect(card).toContainText("听不到你的麦克风");
  await shot(window, "meeting-microphone-nothing-zh");
  await stopMeeting(window);
  // The recording details count the whole stretch as lost, not "No audio was lost".
  const meeting = await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings(),
  );
  expect(meeting[0]?.health.events).toMatchObject([
    { kind: "audioLost", source: "microphone", cause: "stalled", atMs: 0 },
  ]);
});

test("a device change keeps recording, the new microphone's audio at the right time", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const control = await recordMeeting(window);
  const sheet = await openMeetingSheet(window);
  const time = sheet.getByTestId("meeting-sheet-time").getByRole("timer");
  await expect(time).toHaveText(/^0:0[2-9]$/);

  await app.evaluate(() =>
    (globalThis as { incarnamindFakeAudio?: FakeCapture }).incarnamindFakeAudio?.changeDevice(1500),
  );
  await expect(time).toHaveText(/^0:0[5-9]$/);
  await expect(control).toHaveAttribute("data-status", "recording");
  await expect(window.getByTestId("meeting-line-microphone")).toHaveCount(0);
  await expect(window.getByTestId("meeting-foot-problem")).toHaveCount(0);

  await stopMeeting(window);
  const [meeting] = await bridge(window);
  // Two runs: before the change, and from the new device on, after the moment with no audio.
  const parts = partsOf(meeting?.id ?? "", "microphone");
  expect(parts).toHaveLength(2);
  expect((parts[1] ?? 0) - (parts[0] ?? 0)).toBeGreaterThan(1500);
});

test("killed mid-recording, IncarnaMind recovers the audio up to the last part and marks the gap", async () => {
  const first = await launchApp(dataDir);
  await dismissChatSetup(first.window);
  await recordMeeting(first.window);
  const [meeting] = await bridge(first.window);
  const meetingId = meeting?.id ?? "";
  // The first 10-second part is on disk: then the app is killed, with no time to save more.
  await expect.poll(() => partsOf(meetingId, "microphone").length, { timeout: 30_000 }).toBe(1);
  await forceQuit(first.app);
  // The next part was being written when it died.
  await writeFile(join(dataDir, "meetings", meetingId, "microphone-0000010000.wav.writing"), "");

  const { app, window } = await launchApp(dataDir);
  await expect(window.getByTestId("home")).toBeVisible();
  await window.getByTestId("mind-tab").click();
  const control = window.getByTestId("meeting-foot");
  await expect(control).toHaveAttribute("data-status", "paused");
  await expect(control.getByTestId("meeting-foot-resume-recording")).toBeVisible();
  // A recovered, paused Meeting opens no call help panel: it would open before the app's window.
  expect(app.windows()).toHaveLength(1);
  const sheet = await openMeetingSheet(window);
  const interrupted = sheet.getByTestId("meeting-line-interrupted");
  await expect(interrupted).toContainText(
    "IncarnaMind closed while recording. Everything up to 0:10 is saved.",
  );
  await shot(window, "meeting-interrupted-en");

  // The recording details say what was recovered, and what was lost.
  const toggle = sheet.getByTestId("meeting-details-toggle");
  await toggle.hover();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const details = sheet.getByTestId("meeting-sheet-details").getByTestId("meeting-details");
  const line = (text: string) =>
    details.getByTestId("meeting-details-line").filter({ hasText: text });
  await expect(line("the 10 s saved before then was recovered")).toContainText("0:10");
  await expect(
    line("10 s of microphone audio lost: IncarnaMind closed while saving it"),
  ).toContainText("0:10");
  await shot(window, "meeting-details-recovered-en");
  await toggle.click();
  await expect(details).toBeHidden();

  await interrupted.getByTestId("meeting-line-resume").click();
  await expect(control).toHaveAttribute("data-status", "recording");
  await expect(sheet.getByTestId("meeting-line-gap")).toContainText(
    / not recorded at 0:10: IncarnaMind was closed\. · Dismiss$/,
  );
  await shot(window, "meeting-gap-en");
  const [resumed] = await bridge(window);
  expect(resumed?.gaps).toEqual([
    { atMs: expect.any(Number), missedMs: expect.any(Number), reason: "interrupted" },
  ]);
  // The gap starts where the saved part ends, about 10 seconds in.
  expect(Math.floor((resumed?.gaps[0]?.atMs ?? 0) / 1000)).toBe(10);
});

test("recording details: a slow engine, a fallback and a part that can't be saved, the last with a problem line, in English and Chinese", async () => {
  test.setTimeout(150_000);
  // Decoding takes one and a half times as long as the speech; after two lines it fails over.
  const { app, window } = await launchApp(dataDir, {
    transcriber: { realTimeFactor: 1.5, failover: { toCloudAfter: 2 } },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useOutputLocation(window, sources);
  await recordMeeting(window);
  const [meeting] = await bridge(window);
  const meetingId = meeting?.id ?? "";

  // Quiet until asked for: the pulse button in the sheet's head shows them.
  const sheet = await openMeetingSheet(window);
  const toggle = sheet.getByTestId("meeting-details-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "Show recording details");
  await expect(sheet.getByTestId("meeting-details")).toHaveCount(0);
  await toggle.hover();
  await toggle.click();
  const details = sheet.getByTestId("meeting-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText(/Transcribed here at 0\.\d× real time, too slow to keep up/, {
    timeout: 30_000,
  });
  await expect(details).toContainText(
    "Switched to cloud transcription: this computer fell behind",
    {
      timeout: 30_000,
    },
  );
  await expect(details).toContainText("No audio was lost");
  await shot(window, "meeting-details-slow-fallback-en");

  // Once the first part is saved, a file stands where the meeting's folder was: the next can't be.
  await expect.poll(() => partsOf(meetingId, "microphone").length, { timeout: 30_000 }).toBe(1);
  const folder = join(dataDir, "meetings", meetingId);
  await rename(folder, `${folder}-aside`);
  await writeFile(folder, "");
  await expect(sheet.getByTestId("meeting-line-save")).toBeVisible({ timeout: 30_000 });
  await rm(folder);
  await rename(`${folder}-aside`, folder);
  // Once parts are saved again, a line in the sheet says what is missing, with the details one
  // click away.
  await toggle.click();
  await expect(details).toBeHidden();
  const unsaved = sheet.getByTestId("meeting-line-unsaved");
  await expect(unsaved).toHaveText(
    /^\d+ s of audio couldn’t be saved, so it’s not transcribed\. · Details$/,
    { timeout: 30_000 },
  );
  await expect(window.getByTestId("meeting-line-save")).toHaveCount(0);
  await shot(window, "meeting-line-unsaved-wide-en");
  await unsaved.getByTestId("meeting-line-details").click();
  await expect(details).toBeVisible();
  await expect(details).toContainText(
    /\d+ s of (microphone audio|the computer’s sound) lost: it couldn’t be saved/,
  );
  await expect(unsaved).toHaveText(/couldn’t be saved, so it’s not transcribed\.$/);
  await shot(window, "meeting-details-unsaved-wide-en");

  await setWindowSize(app, window, 900, 700);
  await expect(details).toBeVisible();
  await expectSheetFootOneRow(sheet);
  const sheetBox = await sheet.boundingBox();
  const detailsBox = await details.boundingBox();
  if (!sheetBox || !detailsBox) throw new Error("The sheet isn't drawn.");
  expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width);
  await shot(window, "meeting-details-narrow-en");

  // In Chinese, the same details in Chinese words.
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await expect(details).toContainText("已改用云端转写：这台电脑跟不上");
  await expect(details).toContainText(/在这台电脑上转写，速度是实时的 0\.\d 倍，跟不上/);
  await expect(unsaved).toHaveText(/^有 \d+ 秒的音频无法保存，转写稿中缺少这部分。$/);
  await expect(toggle).toHaveAttribute("aria-label", "隐藏录制详情");
  await shot(window, "meeting-details-narrow-zh");
  await toggle.click();
  await expect(unsaved).toHaveText(/。· 详情$/);
  await shot(window, "meeting-line-unsaved-narrow-zh");
  await setWindowSize(app, window, 1440, 900);
  await shot(window, "meeting-line-unsaved-wide-zh");
  await unsaved.getByTestId("meeting-line-details").click();
  await shot(window, "meeting-details-wide-zh");

  // Stopped, the details are in the sheet, which the problem line's Details raises with them
  // shown; the problem line stays where it happened, on the page (#2527).
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "en" },
    }),
  );
  await window.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await stopMeeting(window);
  const stoppedUnsaved = window.getByTestId("mind-pane").getByTestId("meeting-line-unsaved");
  await expect(stoppedUnsaved).toHaveText(
    /^\d+ s of audio couldn’t be saved, so it’s not transcribed\. · Details$/,
  );
  await pointAndClick(window, stoppedUnsaved.getByTestId("meeting-line-details"));
  await expect(sheet).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-label", "Hide recording details");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    sheet.getByTestId("meeting-sheet-details").getByTestId("meeting-details"),
  ).toContainText("Switched to cloud transcription: this computer fell behind");
  await shot(window, "meeting-details-stopped-en");
  await pointAndClick(window, toggle);
  await expect(sheet.getByTestId("meeting-details")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(stoppedUnsaved).toBeVisible();
  await shot(window, "meeting-line-unsaved-stopped-en");
});

test("asking during the call: the assistant listens to the live transcript, its Answer cites a time that opens the transcript there, quick asks start a conversation, and after Stop it is in the meeting's Folder", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await useOutputLocation(window, sources);
  await recordMeeting(window);
  const [meeting] = await bridge(window);
  if (!meeting) throw new Error("No Meeting.");
  // The meeting's Mind is in a Folder, where its conversations go.
  const folderId = await window.evaluate(async (mindId) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await core.createLibraryGroup({ name: "Launch", description: "" });
    await core.moveToFolder({ mindIds: [mindId], folderId: folder.id });
    return folder.id;
  }, meeting.mindId);
  await firstTranscriptLine(window);
  await window.getByTestId("mind-editor").click();

  // A new conversation says it listens, and offers the quick asks.
  const reads = window.getByTestId("assistant-reads");
  await expect(reads).toHaveText(/^Reads “Meeting, .+” · listening to the live transcript$/);
  const starters = window.getByTestId("meeting-starter");
  await expect(starters).toHaveText([
    "Recap the last 5 minutes",
    "What should I ask next?",
    "Action items so far",
  ]);
  await motionSettled(window);
  await shot(window, "meeting-ask-starters-en");

  // A Question about the call: its Answer cites a time in the transcript, the note untouched.
  const answer = await askInAssistant(window, "When does the launch move to?");
  await expect(answer.getByTestId("answer-steps")).toContainText("Listened to the live transcript");
  const chip = answer.getByTestId("citation-chip").first();
  await expect(chip).toHaveAttribute(
    "aria-label",
    /^Citation 1: Transcript · Meeting, .+, (?:Me|Them) · \d+:\d{2}/,
  );
  await expect(window.getByTestId("mind-editor")).toHaveText("");
  await motionSettled(window);
  await shot(window, "meeting-ask-answer-en");

  // The transcript is still being written: let it move on from the version the Answer cited, so
  // the Citation opens the version it was made from, as any Citation whose Document changed does
  // (#2159), and its one action takes the live transcript at the same time.
  const citedHash = await answer.getByTestId("assistant-answer-text").evaluate((dom) => {
    const found: string[] = [];
    (dom as unknown as { editor: Editor }).editor.state.doc.descendants((node) => {
      if (node.type.name === "citation" && typeof node.attrs.contentHash === "string") {
        found.push(node.attrs.contentHash);
      }
    });
    return found[0] ?? null;
  });
  if (citedHash === null) throw new Error("The Citation stores no version.");
  const transcriptHash = () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const transcript = (await core.listDocuments()).find((each) => each.kind === "transcript");
      return transcript?.contentHash ?? null;
    });
  await expect.poll(transcriptHash, { timeout: 30_000 }).not.toBe(citedHash);

  // The Citation opens the version it was made from, the transcript hidden till now, beside the meeting's Mind.
  await expect(window.getByTestId("viewer-transcript")).toHaveCount(0);
  await pointAndClick(window, chip);
  const card = window.getByTestId("citation-card");
  if (await card.isVisible()) await card.getByTestId("citation-open").click();
  const viewer = window.getByTestId("viewer");
  await expect(viewer.getByTestId("viewer-as-cited")).toBeVisible();
  await expect(
    viewer.getByTestId("viewer-cited").locator("[data-quote-highlight]").first(),
  ).toBeInViewport();
  await pointAndClick(window, viewer.getByTestId("viewer-open-current"));
  await expect(viewer.getByTestId("viewer-as-cited")).toHaveCount(0);
  const transcript = window.getByTestId("viewer-transcript");
  await expect(transcript).toBeVisible();
  await expect(transcript.locator("[data-quote-highlight]").first()).toBeInViewport();
  await expect(window.getByTestId("mind-pane")).toBeVisible();
  await shot(window, "meeting-ask-citation-en");

  // A quick ask, in a new conversation, in Chinese.
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await window.getByTestId("assistant-new-chat").click();
  await window.getByTestId("mind-editor").click();
  await expect(reads).toHaveText(/^读“.+” · 正在听：实时转写$/);
  await expect(starters).toHaveText(["回顾最近 5 分钟", "接下来该问什么？", "目前的待办事项"]);
  await shot(window, "meeting-ask-starters-zh");
  await pointAndClick(window, starters.first());
  const asked = window.getByTestId("assistant").getByTestId("assistant-question").last();
  await expect(asked).toContainText("回顾最近 5 分钟");
  await expect(
    window.getByTestId("assistant").getByTestId("assistant-answer").last(),
  ).toHaveAttribute("data-status", "done", { timeout: 15_000 });

  // After Stop, both conversations are the meeting's Folder's.
  await stopMeeting(window);
  const titles = await window.evaluate(async (folder) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listConversations({ folderId: folder })).map((each) => each.title);
  }, folderId);
  expect(titles).toHaveLength(2);
  await app.close();
});

/** A slide, as the window someone shares in a call shows it (ADR-0031): its lines, a table's cells apart. */
const SLIDE = `<!doctype html><html><head><meta charset="utf-8"><title>Q3 review · slides</title>
<style>body{margin:0;background:#1f2430;color:#fff;font:28px sans-serif}main{padding:48px}td{padding:6px 24px}</style>
</head><body><main><h1>Launch budget</h1><table>
<tr><td>Budget</td><td>£1.2m</td></tr><tr><td>Spent to date</td><td>£640k</td></tr>
<tr><td>Contingency left</td><td>£90k</td></tr></table></main></body></html>`;

/** What the fake text recognition reads on the first screen read: the slide's lines. */
const SLIDE_READ = {
  pages: {
    "1": {
      lines: [
        { text: "Launch budget", quad: [0.04, 0.13, 0.34, 0.13, 0.34, 0.21, 0.04, 0.21] },
        { text: "Budget £1.2m", quad: [0.055, 0.28, 0.34, 0.28, 0.34, 0.33, 0.055, 0.33] },
        { text: "Spent to date £640k", quad: [0.055, 0.35, 0.34, 0.35, 0.34, 0.4, 0.055, 0.4] },
        { text: "Contingency left £90k", quad: [0.055, 0.42, 0.34, 0.42, 0.34, 0.47, 0.055, 0.47] },
      ],
    },
  },
};

const screenOf = async (window: Page) => (await bridge(window))[0]?.screen ?? null;

test("the shared screen: one line over the control asks at the start, one chosen window is read, an Answer cites it, and after Stop the Citation says it was deleted; Not this time reads nothing, and the sheet offers it later", async () => {
  const slide = join(sources, "slide.html");
  await writeFile(slide, SLIDE);
  const scans = join(sources, "slide-read.json");
  await writeFile(scans, JSON.stringify(SLIDE_READ));
  const { app, window } = await launchApp(dataDir, { fakeChat: true, sharedWindow: slide, scans });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await useOutputLocation(window, sources);
  const control = await recordMeeting(window);

  // Asked over the meeting's control as recording starts: one line, not a dialog.
  const line = window.locator(".meeting-foot-over").getByTestId("meeting-screen-line");
  await expect(line).toHaveAttribute("data-state", "ask");
  await expect(line).toHaveText(
    /^Read a shared screen\? When you ask, .*Ollama.* gets its text, or a picture if needed\. · Choose window… · Not this time$/,
  );
  const lineBox = await line.boundingBox();
  const footBox = await control.boundingBox();
  expect((lineBox?.y ?? 0) + (lineBox?.height ?? 0)).toBeLessThanOrEqual((footBox?.y ?? 0) + 1);
  await motionSettled(window);
  await shot(window, "screen-ask-en");

  // Choose window…: IncarnaMind's picker lists the one window there is to read.
  await pointAndClick(window, line.getByTestId("meeting-screen-choose"));
  const picker = window.getByTestId("screen-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId("screen-picker-window")).toHaveText(["Q3 review · slides"]);
  await shot(window, "screen-picker-en");
  await pointAndClick(window, picker.getByTestId("screen-picker-read"));
  await expect(picker).toBeHidden();
  await expect(line).toHaveText("Reading the “Q3 review · slides” window · Stop");
  // Read once it has settled, on this computer.
  await expect.poll(async () => (await screenOf(window))?.screens, { timeout: 20_000 }).toBe(1);

  // A Question about the slide: its Answer cites the shared screen, the card shows the screen.
  await window.getByTestId("mind-editor").click();
  const answer = await askInAssistant(window, "How much has been spent, as the slide shows?");
  await expect(answer.getByTestId("answer-steps")).toContainText("Used the screen text");
  const chip = answer.getByTestId("citation-chip").first();
  await expect(chip).toHaveAttribute("aria-label", /^Citation 1: Shared screen \d{1,2}:\d{2}.*$/);
  await pointAndClick(window, chip);
  const card = window.getByTestId("screen-citation-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("screen-citation-where")).toContainText(
    "Q3 review · slides window",
  );
  await expect(card.getByTestId("screen-citation-quote")).toHaveText("Spent to date £640k");
  await expect(card.getByTestId("screen-citation-picture")).toBeVisible();
  await motionSettled(window);
  await shot(window, "screen-reading-en");

  // After Stop nothing of the screen is kept: the Citation says it was deleted, with nothing to open.
  await window.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await stopMeeting(window);
  await expect(line).toHaveCount(0);
  await expect(chip).toHaveAttribute("data-check", "cant-check");
  await pointAndClick(window, chip);
  await expect(card).toHaveAttribute("data-gone", "true");
  await expect(card.getByTestId("citation-badge")).toHaveText("Deleted after the meeting");
  await expect(card.getByTestId("screen-citation-picture")).toHaveCount(0);
  await expect(card.getByTestId("screen-citation-quote")).toHaveCount(0);
  await motionSettled(window);
  await shot(window, "screen-after-en");
  await window.keyboard.press("Escape");
  await expect(card).toBeHidden();

  // In Chinese, Not this time: nothing is read, the line goes, and the sheet's Shared screen…
  // offers it for later in the call.
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await recordMeeting(window);
  const asked = window.locator(".meeting-foot-over").getByTestId("meeting-screen-line");
  await expect(asked).toHaveText(
    /^要读取共享屏幕吗？你提问时，.*Ollama.* 会收到屏幕文字，需要时收到一张画面。 · 选择窗口… · 这次不用$/,
  );
  await motionSettled(window);
  await shot(window, "screen-ask-zh");
  await pointAndClick(window, asked.getByTestId("meeting-screen-decline"));
  await expect(asked).toHaveCount(0);
  const later = (await openMeetingSheet(window)).getByTestId("meeting-sheet-screen");
  await expect(later).toBeEnabled();
  await expect(later).toHaveText("共享屏幕…");
  await pointAndClick(window, window.getByTestId("meeting-sheet-hide"));
  await expect(window.getByTestId("meeting-sheet")).toBeHidden();
  await window.getByTestId("assistant-new-chat").click();
  await window.getByTestId("mind-editor").click();
  const plain = await askInAssistant(window, "屏幕上的预算花了多少？");
  await expect(plain.getByTestId("answer-steps")).not.toContainText("共享屏幕");
  const meetings = await bridge(window);
  expect(meetings[0]?.screen).toMatchObject({ state: "off", screens: 0 });
  await app.close();
});

test("a stopped Transcript has no row of its own: from its Note, Get info names that Note, with no .vtt path and no file actions, in English and Chinese (#763, #2528)", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await recordMeeting(window);
  await expect
    .poll(async () => (await bridge(window))[0]?.transcript?.lines ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await stopMeeting(window);
  await transcriptSaved(window);
  await expect(window.getByTestId("mind-pane")).not.toContainText(
    /vtt|Documents › IncarnaMind|Change folder/i,
  );

  // The Library has no row for it: the meeting is its Note, where its Transcript is reached.
  await pointAndClick(window, window.getByTestId("open-library"));
  const library = window.getByTestId("library");
  await expect(library).toBeVisible();
  await expect(library.getByTestId("library-document")).toHaveCount(0);
  await pointAndClick(window, window.getByTestId("mind-tab").first());
  // It opens over its Note, in its own tab, with no file of the User's to act on: its file is
  // IncarnaMind's.
  const shown = await openMeetingSheet(window);
  await expect(shown.getByTestId("viewer-transcript")).toBeVisible();
  await expect(shown.getByTestId("viewer-open-externally")).toHaveCount(0);
  await expect(shown.getByTestId("document-file-menu")).toHaveCount(0);
  await pointAndClick(window, shown.getByTestId("meeting-sheet-hide"));
  await expect(shown).toHaveCount(0);

  // Found from ⌘K once its words are indexed, it opens beside its Note; there too it has no
  // "Open in default app".
  const documentId = (await bridge(window))[0]?.transcript?.documentId;
  await expect
    .poll(() =>
      window.evaluate(
        async (id) =>
          (
            await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()
          ).find((each) => each.id === id)?.status,
        documentId,
      ),
    )
    .toBe("ready");
  // A word the call said, whichever side's line was saved first.
  const said = await window.evaluate(
    async (id) =>
      (
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.readDocumentText(
          id ?? "",
        )
      ).pages
        .map((page) => page.text)
        .join(" "),
    documentId,
  );
  const word = /[A-Za-z]{6,}/.exec(said)?.[0] ?? "";
  expect(word).not.toBe("");
  await searchPalette(window, word);
  await expect(
    window
      .getByTestId("palette")
      .locator('[data-testid="palette-group"][data-group="meetingText"]')
      .getByTestId("palette-item")
      .first(),
  ).toBeVisible();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("viewer-transcript")).toBeVisible();
  await expect(window.getByTestId("viewer-open-externally")).toHaveCount(0);
  const header = window.getByTestId("viewer-header");
  await pointAndClick(window, header.getByTestId("document-file-menu"));
  const menu = header.getByTestId("document-file-actions");
  await expect(menu.getByTestId("file.info")).toBeVisible();
  // It has no file of the User's to show, copy or open in its app.
  await expect(menu.getByTestId("file.copyPath")).toHaveCount(0);
  await expect(menu.getByText(/Show in Finder|Show in folder/)).toHaveCount(0);
  await expect(menu.getByTestId("document.openExternally")).toHaveCount(0);
  await pointAndClick(window, menu.getByTestId("file.info"));
  const panel = window.getByTestId("info-panel");
  // Its place is its Note's: the panel names the Note, which it opens, never a place of its own.
  const [note] = await window.evaluate(async () =>
    (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds()).map(
      (mind) => mind.title,
    ),
  );
  await expect(panel.getByRole("term").filter({ hasText: /^Note$/ })).toBeVisible();
  await expect(panel.getByTestId("info-open-meeting-note")).toHaveText(note ?? "");
  // Organize never files a meeting's Transcript, so Get info has no Organize row for it.
  await expect(panel.getByTestId("info-organize")).toHaveCount(0);
  await expect(panel.getByTestId("info-path")).toHaveCount(0);
  await expect(panel).not.toContainText(".vtt");
  await expect(panel).not.toContainText("In your Library");
  await expect(panel.getByTestId("info-show")).toHaveCount(0);
  await expect(panel.getByTestId("info-copy-path")).toHaveCount(0);
  await window.keyboard.press("Escape");

  await setLanguage(window, "zh-CN");
  await pointAndClick(window, header.getByTestId("document-file-menu"));
  await pointAndClick(window, menu.getByTestId("file.info"));
  await expect(panel.getByRole("term").filter({ hasText: /^笔记$/ })).toBeVisible();
  await expect(panel.getByTestId("info-open-meeting-note")).toHaveText(note ?? "");
  await expect(panel).not.toContainText("在资料库中");
  await expect(panel).not.toContainText(".vtt");
  await pointAndClick(window, panel.getByTestId("info-open-meeting-note"));
  await expect(window.getByTestId("mind-pane")).toBeVisible();
  await app.close();
});
