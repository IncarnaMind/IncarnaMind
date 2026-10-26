import { existsSync, readdirSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import type { FakeCapture } from "../src/core/meetings/fakeCapture";
import type { TestHooks } from "../src/shared/testHooks";
import {
  askInAssistant,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  expectBarOneRow,
  frontMindName,
  launchApp,
  makeTagOnDocument,
  motionSettled,
  openDocumentAt,
  openSettings,
  paletteFound,
  pointAndClick,
  recordMeeting,
  recordMeetingNow,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  startRecording,
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

test("a meeting records from the + menu, after the one-time notice: the bar, ⌘⇧P, Stop and Delete audio, from the line and from ⌘K", async () => {
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

  const start = await recordMeeting(window);
  await expect(frontMindName(window)).toHaveText(/^Meeting, \d{1,2} [A-Z][a-z]+$/);
  await expect(window.getByTestId("end-hint")).toHaveText(
    "Write the agenda, or anything you want to cover…",
  );
  await expect(start.getByTestId("meeting-start-audio")).toHaveValue("both");
  await shot(window, "meeting-start-en");

  // The first recording on this device shows the notice once; Cancel records nothing.
  await start.getByTestId("meeting-start-record").click();
  const notice = window.getByTestId("meeting-notice");
  await expect(notice).toContainText(
    "Tell everyone you’re recording: in many places it’s the law.",
  );
  // The fake engine's model is already here, so the first recording doesn't say it downloads:
  // "Download and start" is only while the model is absent (recordMeeting.spec covers that).
  await expect(notice.getByTestId("meeting-notice-model-size")).toHaveCount(0);
  await expect(notice.getByTestId("meeting-notice-start")).toHaveText("Start recording");
  await shot(window, "meeting-notice-en");
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  const zhNotice = await notice.locator("#meeting-notice-body p").first().textContent();
  expect(zhNotice).toContain("会议中的所有人。音频只存在");
  expect(zhNotice).not.toMatch(/[。：] /);
  await expect(notice.getByTestId("meeting-notice-model-size")).toHaveCount(0);
  await expect(notice.getByTestId("meeting-notice-start")).toHaveText("开始录制");
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "en" },
    }),
  );
  await notice.getByRole("button", { name: "Cancel" }).click();
  await expect(notice).toBeHidden();
  expect((await bridge(window))[0]?.status).toBe("ready");

  const bar = await startRecording(window, start, { notice: true });
  await expect(start).toBeHidden();
  await expect(bar).toContainText("Recording");
  // Live, its dot is red, as on the tab.
  await expect(bar.getByTestId("meeting-dot")).toHaveCSS("background-color", "rgb(180, 35, 24)");
  await expect(window.getByTestId("meeting-time")).toHaveText(/^0:0[2-9]$/);
  // The bar sits at the top of the Mind's page, above the notes; the composer stays for asking.
  const page = await window.getByTestId("mind-pane").boundingBox();
  const controls = await bar.boundingBox();
  const editor = await window.getByTestId("mind-editor").boundingBox();
  if (!page || !controls || !editor) throw new Error("The meeting bar isn't drawn.");
  expect(controls.y).toBeGreaterThanOrEqual(page.y);
  expect(controls.y + controls.height).toBeLessThanOrEqual(editor.y + 1);
  await expect(window.getByTestId("composer")).not.toContainText("Recording");
  // The tab shows the recording: a red dot and the meeting's time.
  const tab = window.getByTestId("mind-tab").filter({ hasText: "Meeting" });
  await expect(tab.getByTestId("mind-tab-recording")).toHaveAttribute("data-status", "recording");
  await expect(tab.getByTestId("mind-tab-recording")).toHaveCSS(
    "background-color",
    "rgb(180, 35, 24)",
  );
  await expect(tab.getByTestId("mind-tab-time")).toHaveText(/^0:\d\d$/);
  await shot(window, "meeting-bar-en");

  // Notes written below scroll under the bar, which stays in view at the top.
  const notesText = window.getByTestId("mind-editor");
  await notesText.click();
  for (let line = 0; line < 30; line++) await window.keyboard.press("Enter");
  await window.keyboard.type("Rebates stay as they are until January.");
  await window.locator(".mind-scroller").evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  await expect(notesText.locator(":scope > *").first()).not.toBeInViewport();
  await expect(notesText.locator(":scope > *").last()).toBeInViewport();
  await expect(bar).toBeInViewport();
  await shot(window, "meeting-bar-scrolled-en");

  // While it records, Documents wait to be read; its Transcript is read at once. A Tag of the
  // User's own is what lets the footer name Tags at all (#1942).
  await makeTagOnDocument(window);
  await expect(window.getByTestId("tagging-waiting")).toBeVisible({ timeout: 20_000 });
  const file = join(sources, "Agenda.md");
  await writeFile(file, "# Agenda\n\nThe rebates.\n");
  await window.evaluate(async (path) => {
    const hooks = (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks;
    if (!hooks) throw new Error("Test hooks are off.");
    await hooks.addPaths([path]);
  }, file);
  // The Transcript's tags waiting for a model is the more pressing status: reading waits behind "+1".
  const agenda = window.getByTestId("document-list-item").filter({ hasText: "Agenda" });
  await expect(agenda).toHaveAttribute("data-status", "queued");
  await window.getByTestId("status-more").click();
  await expect(window.getByTestId("status-others").getByTestId("reading-paused")).toBeVisible();
  await window.keyboard.press("Escape");

  // ⌘⇧P (Ctrl+Shift+P) is the "Pause recording" command, bound in the window's one keymap:
  // it works while the User types in the meeting's notes, and types nothing there.
  const notes = window.getByTestId("mind-editor");
  await notes.click();
  await window.keyboard.press("End");
  await window.keyboard.type(" Next item");
  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(bar).toHaveAttribute("data-status", "paused");
  await expect(bar).toContainText("Paused");
  await expect(notes).toContainText("Next item");
  await expect(notes).not.toContainText(/Next itemP/i);
  await expect(bar.getByTestId("meeting-dot")).not.toHaveCSS(
    "background-color",
    "rgb(180, 35, 24)",
  );
  await expect(window.getByTestId("meeting-resume")).toHaveAccessibleName(/Resume recording/);
  await shot(window, "meeting-paused-en");
  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(bar).toHaveAttribute("data-status", "recording");

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
  await expect(bar).toHaveAttribute("data-status", "paused");
  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(bar).toHaveAttribute("data-status", "recording");

  await bar.getByTestId("meeting-stop").click();
  await expect(bar).toBeHidden();
  const audio = window.getByTestId("meeting-audio");
  await expect(audio).toContainText(/^Recorded 0:\d\d · Audio stays on this computer until /);
  // Stopped, the Document is read.
  await expect(
    window.getByTestId("document-list-item").filter({ hasText: "Agenda" }),
  ).toHaveAttribute("data-status", "ready");
  await shot(window, "meeting-stopped-en");

  // It can't be undone, so the line asks first; Esc keeps it.
  await audio.getByTestId("meeting-audio-delete").click();
  const confirm = window.getByTestId("meeting-audio-confirm");
  await expect(confirm).toContainText("for good? Your notes stay.");
  await expect(confirm.getByTestId("meeting-audio-delete-confirm")).toBeFocused();
  const question = await confirm.textContent();
  await window.keyboard.press("Escape");
  await expect(audio).toContainText("Audio stays on this computer");

  // ⌘K's "Delete audio" is the same command: the same question, in the same place, and Esc
  // or "Keep it" keeps the audio.
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
  await expect(audio).toContainText("Audio stays on this computer");
  await searchPalette(window, "delete audio");
  await window.keyboard.press("Enter");
  await confirm.getByRole("button", { name: "Keep it" }).click();
  await expect(audio).toContainText("Audio stays on this computer");
  expect((await bridge(window))[0]?.audio.kept).toBe(true);

  await audio.getByTestId("meeting-audio-delete").click();
  await shot(window, "meeting-delete-audio-en");
  await window.getByTestId("meeting-audio-delete-confirm").click();
  await expect(audio).toContainText("Audio deleted");
  const [meeting] = await bridge(window);
  expect(meeting?.audio.kept).toBe(false);
  expect(existsSync(join(dataDir, "meetings", meeting?.id ?? ""))).toBe(false);

  // With the audio gone, there is nothing to delete, and ⌘K no longer offers it.
  await searchPalette(window, "delete audio");
  await expect(deleteAudio).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  // The notice comes once on a device: the next meeting records in one action, with no start block.
  await recordMeetingNow(window);
  await expect(window.getByTestId("meeting-notice")).toBeHidden();
  await expect(window.getByTestId("meeting-start")).toHaveCount(0);
});

test("an engine that can't start says so in plain words, never in its JavaScript error, in English and Chinese", async () => {
  const error = "Cannot read properties of undefined (reading 'createAsync')";
  const { app, window } = await launchApp(dataDir, { transcriber: { failToLoad: error } });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await startRecording(window, await recordMeeting(window), { notice: true });

  const line = window.getByTestId("meeting-transcript-line");
  await expect(line).toHaveText("Transcription stopped. · Try again", { timeout: 30_000 });
  await expect(line).not.toContainText("createAsync");
  await shot(window, "meeting-transcript-engine-stopped-en");
  await setLanguage(window, "zh-CN");
  await expect(line).toHaveText("转写已停止。· 重试");
  await shot(window, "meeting-transcript-engine-stopped-zh");
  const [meeting] = await bridge(window);
  expect(meeting?.status).toBe("recording");
});

test("Show transcript opens the live Transcript beside the meeting, Hide transcript closes it, and at Stop it is saved", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  // No Output location chosen: the Transcript goes to the default, Documents › IncarnaMind.
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  const toggle = bar.getByTestId("meeting-transcript-toggle");
  await expect(toggle).toHaveText("Show transcript");

  // Lines come from the first seconds of sound: it can be shown once the first is in.
  await expect(toggle).toBeEnabled({ timeout: 20_000 });
  await toggle.hover();
  await toggle.click();
  await expect(toggle).toHaveText("Hide transcript");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
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
  // As the board draws a row: the time in a column of its own, the label above the words, in a grey that isn't a colour.
  const row = transcript.getByTestId("transcript-line").first();
  const [timeBox, labelBox, wordsBox] = await Promise.all([
    row.locator(".transcript-time").boundingBox(),
    row.getByTestId("transcript-speaker").boundingBox(),
    row.locator(".transcript-text").boundingBox(),
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
  await expect(bar).toHaveAttribute("data-status", "recording");
  await shot(window, "meeting-transcript-wide-en");
  // A narrow window shows its groups merged: the Transcript is the tab after the Mind's.
  await setWindowSize(app, window, 900, 700);
  await expect(bar).toBeVisible();
  await shot(window, "meeting-bar-narrow-en");
  const transcriptTab = window.getByTestId("document-tab").filter({ hasText: "Transcript" });
  await transcriptTab.click();
  await expect(transcript).toBeVisible();
  await shot(window, "meeting-transcript-narrow-en");
  await setWindowSize(app, window, 1440, 900);

  // Hidden, it is still a Document: searchable and citable.
  await toggle.click();
  await expect(transcript).toBeHidden();
  await expect(toggle).toHaveText("Show transcript");
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
  await shot(window, "meeting-bar-transcript-en");

  // In Chinese, the same controls in Chinese words.
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await expect(toggle).toHaveText("显示转写稿");
  await shot(window, "meeting-bar-transcript-zh");
  await toggle.click();
  await expect(toggle).toHaveText("隐藏转写稿");
  await expect(window.getByTestId("transcript-live")).toHaveText("实时");
  await expect(speakers.filter({ hasText: /^我$/ }).first()).toBeVisible();
  await expect(speakers.filter({ hasText: /^对方$/ }).first()).toBeVisible();
  await shot(window, "meeting-transcript-wide-zh");
  await setWindowSize(app, window, 900, 700);
  await window.getByTestId("mind-tab").filter({ hasText: "Meeting" }).click();
  await expect(bar).toBeVisible();
  await shot(window, "meeting-bar-narrow-zh");
  // Named when its first line came, the Transcript keeps its name in another language.
  await transcriptTab.click();
  await expect(transcript).toBeVisible();
  // At the narrowest, a label fits its line.
  const firstLine = transcript.getByTestId("transcript-line").first();
  const [narrowLine, narrowLabel] = await Promise.all([
    firstLine.boundingBox(),
    firstLine.getByTestId("transcript-speaker").boundingBox(),
  ]);
  expect((narrowLabel?.x ?? 0) + (narrowLabel?.width ?? 0)).toBeLessThanOrEqual(
    (narrowLine?.x ?? 0) + (narrowLine?.width ?? 0),
  );
  await shot(window, "meeting-transcript-narrow-zh");
  await setWindowSize(app, window, 1440, 900);

  // At Stop it is finished and kept in the Library, with no folder to choose and no .vtt to read
  // (#763): the line says so, and opens it.
  await bar.getByTestId("meeting-stop").click();
  await expect(bar).toBeHidden();
  const saved = window.getByTestId("meeting-transcript-line");
  await expect(saved).toHaveText("转写稿已保存 · 打开转写稿", { timeout: 20_000 });
  await shot(window, "meeting-transcript-saved-zh");
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "en" },
    }),
  );
  await expect(saved).toHaveText("Transcript saved · Open transcript");
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
  await expect(washed.first()).toHaveText("The launch moves to the eighteenth of November.");
  await shot(window, "meeting-transcript-citation-en");
});

test("notes during the call: typed lines get their time, Mark (⌘D) and Add to note work by keyboard, and the Citation is found", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  // No Output location chosen: the Transcript goes to the default, Documents › IncarnaMind.
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  const toggle = bar.getByTestId("meeting-transcript-toggle");
  await expect(toggle).toBeEnabled({ timeout: 20_000 });
  await toggle.hover();
  await toggle.click();
  const transcript = window.getByTestId("viewer-transcript");
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
  await expect(window.getByTestId("meeting-mark")).toBeEnabled();
  await shot(window, "meeting-mark-wide-en");

  // Add to note, by keyboard: the line takes the focus, Enter adds it with a Citation that is found.
  const second = lines.nth(1);
  await expect(second).toBeVisible({ timeout: 20_000 });
  await second.hover();
  await second.click();
  await expect(second).toBeFocused();
  await expect(second.getByTestId("transcript-add")).toBeVisible();
  await shot(window, "meeting-add-to-note-wide-en");
  const quote = (await second.locator(".transcript-text").textContent()) ?? "";
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
  await third.getByTestId("transcript-add").click();
  await expect(citation).toHaveCount(1);
  await expect(citation).toHaveAttribute("data-check", "found");

  // In a pause no time is taken, and Mark is off.
  await window.keyboard.press("ControlOrMeta+Shift+KeyP");
  await expect(bar).toHaveAttribute("data-status", "paused");
  await expect(window.getByTestId("meeting-mark")).toBeDisabled();
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
  await expect(bar).toHaveAttribute("data-status", "recording");
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
  await expect(window.getByTestId("meeting-mark")).toContainText("标记");
  await typed.hover();
  await shot(window, "meeting-typed-time-wide-zh");
  const fourth = lines.nth(3);
  await expect(fourth).toBeVisible({ timeout: 20_000 });
  await fourth.hover();
  await fourth.getByTestId("transcript-add").click();
  await expect(window.getByTestId("undo-message")).toHaveText("已将转写稿中的一句加入笔记");
  await third.hover();
  await expect(third.getByTestId("transcript-add")).toContainText("加入笔记");
  // Reserved at the line's end: it covers no words, and nothing moves when it shows.
  const words = await third.locator(".transcript-text").boundingBox();
  const button = await third.getByTestId("transcript-add").boundingBox();
  if (!words || !button) throw new Error("The line isn't drawn.");
  expect(button.x).toBeGreaterThanOrEqual(words.x + words.width - 1);
  await shot(window, "meeting-add-to-note-wide-zh");
  await setWindowSize(app, window, 900, 700);
  await window
    .getByTestId("mind-tab")
    .filter({ hasText: /Meeting|会议/ })
    .click();
  await expect(bar).toBeVisible();
  await expect(window.getByTestId("meeting-mark")).toBeVisible();
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
  await bar.getByTestId("meeting-stop").click();
  await expect(bar).toBeHidden();
  await expect(typed).toHaveAttribute("data-meeting-time", /^\d+:\d{2}$/);
});

test("with the computer's sound denied, a line says so and opens System Settings; the microphone records on", async () => {
  const { app, window } = await launchApp(dataDir, { computerSound: "denied" });
  await dismissChatSetup(window);
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });

  const line = window.getByTestId("meeting-line-system");
  await expect(line).toContainText(
    "Only your microphone is recorded: computer sound isn’t allowed.",
  );
  await expect(bar).toHaveAttribute("data-status", "recording");
  await shot(window, "meeting-system-denied-en");

  // Nothing tells the User from the others without the computer's sound: the lines read Speaker ?
  const toggle = bar.getByTestId("meeting-transcript-toggle");
  await expect(toggle).toBeEnabled({ timeout: 20_000 });
  await toggle.hover();
  await toggle.click();
  const speakers = window.getByTestId("viewer-transcript").getByTestId("transcript-speaker");
  await expect(speakers.first()).toHaveText("Speaker ?");
  await expect(speakers.filter({ hasNotText: /^Speaker \?$/ })).toHaveCount(0);
  const open = line.getByTestId("meeting-settings-system");
  await open.hover();
  await open.click();
  await expect.poll(async () => (await fakeAudio(app)).settingsOpened).toEqual(["system"]);

  // In Chinese, the same line in Chinese words.
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await expect(line).toContainText("只录到了麦克风：没有录制电脑声音的权限。");
  await expect(speakers.first()).toHaveText("发言人 ?");
  await expect(bar).toContainText("正在录制");
  await shot(window, "meeting-system-denied-zh");
  if (SCREENSHOTS) {
    await window.getByTestId("sidebar-footer").getByRole("button", { name: "设置" }).click();
    await showSettingsPage(window, "meetings");
    await shot(window, "settings-meetings-zh");
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("settings")).toBeHidden();
  }

  // At the narrowest window, the bar keeps its controls on one row.
  await setWindowSize(app, window, 900, 660);
  await expect(bar).toBeVisible();
  const box = await bar.getByTestId("meeting-controls").boundingBox();
  expect(box?.height).toBeLessThanOrEqual(28);
  await shot(window, "meeting-bar-narrow-zh");
});

test("a device change keeps recording, the new microphone's audio at the right time", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  const time = window.getByTestId("meeting-time");
  await expect(time).toHaveText(/^0:0[2-9]$/);

  await app.evaluate(() =>
    (globalThis as { incarnamindFakeAudio?: FakeCapture }).incarnamindFakeAudio?.changeDevice(1500),
  );
  await expect(time).toHaveText(/^0:0[5-9]$/);
  await expect(bar).toHaveAttribute("data-status", "recording");
  await expect(window.getByTestId("meeting-line-microphone")).toHaveCount(0);

  await bar.getByTestId("meeting-stop").click();
  const [meeting] = await bridge(window);
  // Two runs: before the change, and from the new device on, after the moment with no audio.
  const parts = partsOf(meeting?.id ?? "", "microphone");
  expect(parts).toHaveLength(2);
  expect((parts[1] ?? 0) - (parts[0] ?? 0)).toBeGreaterThan(1500);
});

test("killed mid-recording, IncarnaMind recovers the audio up to the last part and marks the gap", async () => {
  const first = await launchApp(dataDir);
  await dismissChatSetup(first.window);
  await startRecording(first.window, await recordMeeting(first.window), { notice: true });
  const [meeting] = await bridge(first.window);
  const meetingId = meeting?.id ?? "";
  // The first 10-second part is on disk: then the app is killed, with no time to save more.
  await expect.poll(() => partsOf(meetingId, "microphone").length, { timeout: 30_000 }).toBe(1);
  first.app.process().kill("SIGKILL");
  await first.app.waitForEvent("close");
  // The next part was being written when it died.
  await writeFile(join(dataDir, "meetings", meetingId, "microphone-0000010000.wav.writing"), "");

  const { app, window } = await launchApp(dataDir);
  await expect(window.getByTestId("home")).toBeVisible();
  await window.getByTestId("mind-tab").click();
  const bar = window.getByTestId("meeting-bar");
  await expect(bar).toHaveAttribute("data-status", "paused");
  // A recovered, paused Meeting opens no call help panel: it would open before the app's window.
  expect(app.windows()).toHaveLength(1);
  const interrupted = window.getByTestId("meeting-line-interrupted");
  await expect(interrupted).toContainText(
    "IncarnaMind closed while recording. Everything up to 0:10 is saved.",
  );
  await shot(window, "meeting-interrupted-en");

  // The recording details say what was recovered, and what was lost.
  const toggle = bar.getByTestId("meeting-details-toggle");
  await toggle.hover();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const details = bar.getByTestId("meeting-details");
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
  await expect(bar).toHaveAttribute("data-status", "recording");
  await expect(window.getByTestId("meeting-line-gap")).toContainText(
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
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  const [meeting] = await bridge(window);
  const meetingId = meeting?.id ?? "";

  // Quiet until asked for: the bar's pulse button shows them.
  const toggle = bar.getByTestId("meeting-details-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "Show recording details");
  await expect(bar.getByTestId("meeting-details")).toHaveCount(0);
  await toggle.hover();
  await toggle.click();
  const details = bar.getByTestId("meeting-details");
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
  await expect(window.getByTestId("meeting-line-save")).toBeVisible({ timeout: 30_000 });
  await rm(folder);
  await rename(`${folder}-aside`, folder);
  // Once parts are saved again, a line says what is missing, with the details one click away.
  await toggle.click();
  await expect(details).toBeHidden();
  const unsaved = bar.getByTestId("meeting-line-unsaved");
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
  await expectBarOneRow(bar);
  const barBox = await bar.boundingBox();
  const detailsBox = await details.boundingBox();
  if (!barBox || !detailsBox) throw new Error("The bar isn't drawn.");
  expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(barBox.x + barBox.width);
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

  // Stopped, the details open from the line under the meeting, and ⌘K reaches them too.
  await window.evaluate(async () =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "en" },
    }),
  );
  await bar.getByTestId("meeting-stop").click();
  await expect(bar).toBeHidden();
  const after = window.getByTestId("meeting-details-toggle");
  await expect(after).toHaveText("Recording details");
  await expect(after).toHaveAttribute("aria-expanded", "true");
  await expect(window.getByTestId("meeting-details")).toContainText(
    "Switched to cloud transcription: this computer fell behind",
  );
  await shot(window, "meeting-details-stopped-en");
  await after.click();
  await expect(window.getByTestId("meeting-details")).toHaveCount(0);
  await expect(window.getByTestId("meeting-line-unsaved")).toBeVisible();
  await shot(window, "meeting-line-unsaved-stopped-en");
});

test("asking during the call: the assistant listens to the live transcript, its Answer cites a time that opens the transcript there, quick asks start a conversation, and after Stop it is in the meeting's Folder", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await useOutputLocation(window, sources);
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  const [meeting] = await bridge(window);
  if (!meeting) throw new Error("No Meeting.");
  // The meeting's Mind is in a Folder, where its conversations go.
  const folderId = await window.evaluate(async (mindId) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await core.createLibraryGroup({ name: "Launch", description: "" });
    await core.moveToFolder({ mindIds: [mindId], folderId: folder.id });
    return folder.id;
  }, meeting.mindId);
  await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 20_000 });
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

  // The Citation opens the transcript, hidden till now, at that line, beside the meeting's Mind.
  await expect(window.getByTestId("viewer-transcript")).toHaveCount(0);
  await pointAndClick(window, chip);
  const card = window.getByTestId("citation-card");
  if (await card.isVisible()) await card.getByTestId("citation-open").click();
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
  await expect(reads).toHaveText(/^正在读“.+” · 正在听：实时转写$/);
  await expect(starters).toHaveText(["回顾最近 5 分钟", "接下来该问什么？", "目前的待办事项"]);
  await shot(window, "meeting-ask-starters-zh");
  await pointAndClick(window, starters.first());
  const asked = window.getByTestId("assistant").getByTestId("assistant-question").last();
  await expect(asked).toContainText("回顾最近 5 分钟");
  await expect(
    window.getByTestId("assistant").getByTestId("assistant-answer").last(),
  ).toHaveAttribute("data-status", "done", { timeout: 15_000 });

  // After Stop, both conversations are the meeting's Folder's.
  await bar.getByTestId("meeting-stop").click();
  await expect(bar).toBeHidden();
  const titles = await window.evaluate(async (folder) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listConversations({ folderId: folder })).map((each) => each.title);
  }, folderId);
  expect(titles).toHaveLength(2);
  await app.close();
});

test("a stopped Transcript is kept in the Library: Get info says so, with no .vtt path and no file actions, in English and Chinese (#763)", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  });
  await recordMeetingNow(window);
  await expect
    .poll(async () => (await bridge(window))[0]?.transcript?.lines ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await window.getByTestId("meeting-stop").click();
  const line = window.getByTestId("meeting-transcript-line");
  await expect(line).toContainText("Transcript saved", { timeout: 30_000 });
  await expect(line).not.toContainText(/vtt|Documents › IncarnaMind|Change folder/i);

  // In the Library, the Transcript is a Document of the Library, not a .vtt file of the User's.
  await pointAndClick(window, window.getByTestId("open-library"));
  const library = window.getByTestId("library");
  const row = library.getByTestId("library-document").filter({ hasText: "Transcript" });
  await expect(row).toHaveCount(1);
  await row.locator('[data-object-menu^="document:"]').click();
  const menu = window.getByTestId("document-file-actions");
  await expect(menu.getByTestId("file.info")).toBeVisible();
  // It has no file of the User's to show, copy or open in its app.
  await expect(menu.getByTestId("file.copyPath")).toHaveCount(0);
  await expect(menu.getByText(/Show in Finder|Show in folder/)).toHaveCount(0);
  await expect(menu.getByTestId("document.openExternally")).toHaveCount(0);
  await pointAndClick(window, menu.getByTestId("file.info"));
  const panel = window.getByTestId("info-panel");
  await expect(panel.getByTestId("info-path")).toHaveText("In your Library");
  await expect(panel).not.toContainText(".vtt");
  await expect(panel.getByTestId("info-show")).toHaveCount(0);
  await expect(panel.getByTestId("info-copy-path")).toHaveCount(0);
  await window.keyboard.press("Escape");
  // Opened, it has no "Open in default app" either: its file is IncarnaMind's, not the User's.
  await pointAndClick(window, row.getByTestId("library-document-name"));
  await expect(window.getByTestId("viewer")).toBeVisible();
  await expect(window.getByTestId("viewer-open-externally")).toHaveCount(0);
  await pointAndClick(window, window.getByTestId("document-tab").getByTestId("tab-close"));

  await setLanguage(window, "zh-CN");
  await row.locator('[data-object-menu^="document:"]').click();
  await pointAndClick(window, window.getByTestId("document-file-actions").getByTestId("file.info"));
  await expect(panel.getByTestId("info-path")).toHaveText("在资料库中");
  await expect(panel).not.toContainText(".vtt");
  await app.close();
});
