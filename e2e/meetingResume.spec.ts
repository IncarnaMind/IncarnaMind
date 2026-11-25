import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Meeting } from "../src/core/api";
import { readVtt } from "../src/core/documents/formats/vtt";
import {
  coreOf,
  createDataFolder,
  firstTranscriptLine,
  launchApp,
  openMeetingSheet,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  stopMeeting,
} from "./app";

/*
 * Resume after Stop (#3762): the Transcript sheet's Resume records more of the same Meeting, its
 * time going on from where it stopped and its Transcript keeping every earlier line first, and a
 * quit between Stop and Resume changes none of that. The fake capture and the stand-in
 * transcriber every smoke test gets, never a device.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const WORDS = {
  en: { resume: "Resume", resumeName: "Record more of this meeting", transcript: "Transcript" },
  "zh-CN": { resume: "继续录制", resumeName: "继续录制这场会议", transcript: "转写稿" },
} as const;

/** Long enough that a time started again from 0 can't be read as one going on. */
const FIRST_STRETCH_S = 6;

interface ShownLine {
  start: number;
  text: string;
}

async function meetingOf(window: Page, meetingId: string): Promise<Meeting> {
  const meeting = (await (await coreOf(window)).evaluate((core) => core.listMeetings())).find(
    (each) => each.id === meetingId,
  );
  if (!meeting) throw new Error(`No Meeting ${meetingId}.`);
  return meeting;
}

/** The lines the sheet shows, in order: where each starts, in ms of the meeting, and its words. */
const sheetLines = (sheet: Locator): Promise<ShownLine[]> =>
  sheet.getByTestId("transcript-line").evaluateAll((lines) =>
    lines.map((line) => ({
      start: Number(line.getAttribute("data-start")),
      text: line.textContent ?? "",
    })),
  );

/** The lines of the Meeting's Transcript file, as its last Stop saved them. */
const savedLines = (meetingId: string) =>
  readVtt(readFileSync(join(dataDir, "Transcripts", `${meetingId}.vtt`), "utf8")).cues.map(
    ({ startMs, endMs, text, speaker }) => ({ startMs, endMs, text, speaker }),
  );

/** "1:05", or "1:02:05", in seconds. */
const secondsOf = (time: string | null) =>
  (time ?? "").split(":").reduce((total, part) => total * 60 + Number(part), 0);

const tabTime = (window: Page, mindId: string) =>
  window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`).getByTestId("mind-tab-time");

/** Stop at the control, then wait until the Transcript is saved to its file again. */
async function stopAndSave(window: Page, meetingId: string): Promise<Meeting> {
  await stopMeeting(window);
  await expect
    .poll(
      async () => {
        const { status, transcript } = await meetingOf(window, meetingId);
        return (
          status === "stopped" &&
          transcript?.state === "saved" &&
          transcript.savedPath !== null &&
          !transcript.separating
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return meetingOf(window, meetingId);
}

/**
 * The sheet's Resume, in the language's words, on a stopped Meeting: the control records again,
 * and the tab's time goes on from the time recorded before.
 */
async function resumeFromSheet(
  window: Page,
  words: (typeof WORDS)[keyof typeof WORDS],
  stopped: Meeting,
): Promise<void> {
  const control = window.getByTestId("meeting-foot");
  await expect(control).toHaveAttribute("data-status", "stopped");
  await expect(control.getByTestId("meeting-foot-transcript")).toHaveText(words.transcript);
  const sheet = await openMeetingSheet(window);
  const resume = sheet.getByTestId("meeting-sheet-resume-meeting");
  await expect(resume).toHaveText(words.resume);
  await expect(resume).toHaveAccessibleName(words.resumeName);
  await pointAndClick(window, resume);
  await expect(control).toHaveAttribute("data-status", "recording");

  const time = tabTime(window, stopped.mindId);
  await expect(time).toHaveText(/^\d+:\d\d$/);
  const stoppedAt = Math.floor(stopped.recordedMs / 1000);
  const resumedAt = secondsOf(await time.textContent());
  expect(resumedAt).toBeGreaterThanOrEqual(stoppedAt);
  expect(resumedAt).toBeLessThan(stoppedAt + FIRST_STRETCH_S);
  await expect.poll(async () => secondsOf(await time.textContent())).toBeGreaterThan(resumedAt);
}

/**
 * Waits for a line said after the Resume, in the sheet: the lines shown before stay first, as
 * they were, and every new one starts after the time recorded before.
 */
async function linesAddedAfter(
  sheet: Locator,
  before: ShownLine[],
  stopped: Meeting,
): Promise<ShownLine[]> {
  await expect
    .poll(async () => (await sheetLines(sheet)).length, { timeout: 20_000 })
    .toBeGreaterThan(before.length);
  const shown = await sheetLines(sheet);
  expect(shown.slice(0, before.length)).toEqual(before);
  const added = shown.slice(before.length);
  expect(added.every((line) => line.start >= stopped.recordedMs)).toBe(true);
  return shown;
}

/** One Meeting in the data folder, with one Transcript Document: the one it had. */
async function oneMeetingOneTranscript(window: Page, meeting: Meeting): Promise<void> {
  const core = await coreOf(window);
  expect((await core.evaluate((each) => each.listMeetings())).map((each) => each.id)).toEqual([
    meeting.id,
  ]);
  const transcripts = (await core.evaluate((each) => each.listDocuments()))
    .filter((each) => each.kind === "transcript")
    .map((each) => each.id);
  expect(transcripts).toEqual([meeting.transcript?.documentId]);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Resume after Stop records more of the same meeting: its time goes on, its earlier lines stay first as they were, Stop saves one Transcript, and after a quit it resumes again (${language})`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    const first = await launchApp(dataDir);
    await setWindowSize(first.app, first.window, 1440, 900);
    await setLanguage(first.window, language);
    let window = first.window;

    const control = await recordMeeting(window);
    await firstTranscriptLine(window);
    const [recording] = await (await coreOf(window)).evaluate((core) => core.listMeetings());
    if (!recording) throw new Error("No Meeting is recording.");
    await expect
      .poll(async () => secondsOf(await tabTime(window, recording.mindId).textContent()), {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(FIRST_STRETCH_S);
    const sheet = await openMeetingSheet(window);
    await expect(sheet.getByTestId("transcript-line").first()).toBeVisible();

    const stopped = await stopAndSave(window, recording.id);
    await expect(control).toHaveAttribute("data-status", "stopped");
    const savedFirst = savedLines(recording.id);
    expect(savedFirst.length).toBeGreaterThan(0);
    await expect(sheet.getByTestId("transcript-line")).toHaveCount(savedFirst.length);
    const shownFirst = await sheetLines(sheet);

    await resumeFromSheet(window, words, stopped);
    await linesAddedAfter(sheet, shownFirst, stopped);
    expect(await meetingOf(window, recording.id)).toMatchObject({
      mindId: recording.mindId,
      transcript: { documentId: stopped.transcript?.documentId },
    });

    // Stop again saves the one Transcript, the first stretch's lines first as they were.
    const stoppedAgain = await stopAndSave(window, recording.id);
    expect(stoppedAgain.recordedMs).toBeGreaterThan(stopped.recordedMs);
    const savedSecond = savedLines(recording.id);
    expect(savedSecond.slice(0, savedFirst.length)).toEqual(savedFirst);
    const addedSecond = savedSecond.slice(savedFirst.length);
    expect(addedSecond.length).toBeGreaterThan(0);
    expect(addedSecond.every((cue) => cue.startMs >= stopped.recordedMs)).toBe(true);
    await expect(sheet.getByTestId("transcript-line")).toHaveCount(savedSecond.length);
    const shownSecond = await sheetLines(sheet);
    expect(shownSecond.slice(0, shownFirst.length)).toEqual(shownFirst);
    await oneMeetingOneTranscript(window, stoppedAgain);

    // Quit, and open the Note again on the same data folder: as Stop left it, it resumes again.
    await first.app.close();
    const again = await launchApp(dataDir);
    window = again.window;
    await setWindowSize(again.app, window, 1440, 900);
    await setLanguage(window, language);
    // On Linux the relaunched window doesn't bring the Note's tab back; the sidebar lists it on every system.
    await pointAndClick(
      window,
      window.locator(`[data-testid="mind-list-item"][data-mind-id="${recording.mindId}"]`),
    );
    await expect(window.getByTestId("mind-pane")).toHaveAttribute("data-mind-id", recording.mindId);
    expect(await meetingOf(window, recording.id)).toMatchObject({
      status: "stopped",
      recordedMs: stoppedAgain.recordedMs,
    });
    const reopened = await openMeetingSheet(window);
    await expect(reopened.getByTestId("transcript-line")).toHaveCount(savedSecond.length);
    expect(await sheetLines(reopened)).toEqual(shownSecond);

    await resumeFromSheet(window, words, stoppedAgain);
    await linesAddedAfter(reopened, shownSecond, stoppedAgain);
    const stoppedLast = await stopAndSave(window, recording.id);
    const savedLast = savedLines(recording.id);
    expect(savedLast.slice(0, savedSecond.length)).toEqual(savedSecond);
    const addedLast = savedLast.slice(savedSecond.length);
    expect(addedLast.length).toBeGreaterThan(0);
    expect(addedLast.every((cue) => cue.startMs >= stoppedAgain.recordedMs)).toBe(true);
    await oneMeetingOneTranscript(window, stoppedLast);
  });
}
