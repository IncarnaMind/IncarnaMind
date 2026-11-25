import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { encodeWav, monoSamples, toPcm16 } from "../../eval/lib/wav";
import { MEETING_SAMPLE_RATE } from "../../src/core/adapters";
import type { CoreBridge } from "../../src/core/api";
import { listParts, meetingFolder, msOf } from "../../src/core/meetings/audioFiles";
import {
  openMeetingSheet,
  pointAndClick,
  recordMeeting,
  stopMeeting,
  transcriptSaved,
  turnOf,
  useOutputLocation,
} from "../app";
import {
  copyModelsIn,
  copyModelsOut,
  launchPackaged,
  packagedExecutable,
  packagedLogLines,
} from "./app";
import { audioOutputsHeldBy } from "./macAudio";
import { expectSpeechEngineOnTheAppsRuntime } from "./windowsRuntime";

const root = resolve(__dirname, "../..");
// The opening of the Gettysburg Address, read for LibriVox, then a line in a second, synthetic
// voice (tests/fixtures/speech/README.md).
const speech = join(root, "tests/fixtures/speech/two-voices.wav");
// Three Mandarin lines, each a short word alone, a pause, then the rest (tests/fixtures/speech/README.md).
const shortFirstWords = join(root, "tests/fixtures/speech/short-first-words-zh.wav");
const closeVoices = join(root, "tests/fixtures/speech/close-voices.wav");
/** Each of the handoff test's two waits before Stop: for the Transcript's first line, then the shared one. */
const HANDOFF_WAIT_MS = 2 * 60_000;

/**
 * The two close voices, the second starting as the first stops or, with `overlap`, 400 ms before,
 * then silence for as long as the test waits before Stop. Chromium plays the file again from its
 * start: without the silence, a slow runner's recording also held the next play's handoff, cut
 * short by Stop.
 */
async function oneHandoff(home: string, overlap: boolean): Promise<string> {
  const samplesPerMs = MEETING_SAMPLE_RATE / 1000;
  const handoff = 7170 * samplesPerMs;
  const shift = overlap ? 400 * samplesPerMs : 0;
  const samples = monoSamples(await readFile(closeVoices), closeVoices);
  const voices = samples.length - shift;
  const mixed = new Float32Array(voices + 2 * HANDOFF_WAIT_MS * samplesPerMs);
  mixed.set(samples.subarray(0, handoff));
  for (const [at, sample] of samples.subarray(handoff).entries()) {
    const offset = handoff - shift + at;
    mixed[offset] = (mixed[offset] ?? 0) + sample;
  }
  const file = join(home, overlap ? "overlapping-voices.wav" : "close-voices.wav");
  await writeFile(file, encodeWav(toPcm16(mixed)));
  return file;
}

/**
 * Records a meeting of the microphone alone, as Settings › Meetings' "What is recorded" chooses
 * it, and raises its Transcript sheet: a runner may have no computer sound to record.
 */
async function recordMicrophone(window: Page): Promise<Locator> {
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      device: { meetingSystemAudio: false },
    }),
  );
  await recordMeeting(window);
  return openMeetingSheet(window);
}

/**
 * The sheet's "Open beside", once the Transcript has its first line: the model is downloaded and
 * the engine runs. Meanwhile the sheet is folded, so an engine that doesn't load says so over the
 * meeting's control at once, and the test stops there instead of waiting out the download's time.
 */
async function besideOnceTranscribing(window: Page, sheet: Locator): Promise<Locator> {
  const stopped = window
    .getByTestId("meeting-transcript-line")
    .filter({ hasText: /Transcription stopped|couldn’t/ });
  await pointAndClick(window, sheet.getByTestId("meeting-sheet-hide"));
  await expect(sheet).toBeHidden();
  const firstLine = () =>
    window.evaluate(async () =>
      (
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings()
      ).some((each) => each.status !== "stopped" && (each.transcript?.lines ?? 0) > 0),
    );
  await expect
    .poll(async () => (await stopped.count()) > 0 || (await firstLine()), {
      timeout: 20 * 60_000,
    })
    .toBe(true);
  await expect(stopped).toHaveCount(0);
  const beside = (await openMeetingSheet(window)).getByTestId("meeting-sheet-beside");
  await expect(beside).toBeEnabled();
  return beside;
}

async function savedWithSpeakers(window: Page): Promise<void> {
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const [meeting] = await core.listMeetings();
          return meeting?.transcript?.state === "saved" && !meeting.transcript.separating;
        }),
      { timeout: 5 * 60_000 },
    )
    .toBe(true);
}

test.skip(
  process.platform !== "darwin" && process.platform !== "win32",
  "CI builds and runs the packaged app on macOS and Windows only",
);

let app: ElectronApplication | undefined;
let dataDir = "";
const folders: string[] = [];

test.afterEach(async () => {
  const testInfo = test.info();
  await app?.close();
  app = undefined;
  // The packaged app's own log says why its engine stopped; CI keeps no data folder.
  if (testInfo.status !== testInfo.expectedStatus && dataDir) {
    const lines = await packagedLogLines(dataDir, /ERROR|WARN/);
    await testInfo.attach("app log", { body: lines.join("\n"), contentType: "text/plain" });
    console.log(lines.slice(-20).join("\n"));
  }
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

// protects=meeting transcription works in the packaged app, through its real speech engine and model (#1233 failed only there, with every test passing on the fake transcriber), with its streaming model's live words while a line is said (#2662), told Words to know none of which is said (#1031), keeps going past its first stretch, and saves the Transcript; then the speaker pass runs to the end on its real engine and models in its own process (#138), and the room's two clearly different voices are two numbered speakers; fails_when=the engine doesn't load in the packaged app, the transcript misses the words spoken, it stops after the first line, or the speaker process, its bundle or its models are broken, which leaves every line "Speaker ?", or the two voices come out as one speaker or more than two; no_claim=the computer's sound, how well alike voices or a long meeting's are told apart (eval/speakers), Linux, or a cloud transcription service; on Windows the speech process also loads exactly one ONNX Runtime library, the app's own (#2152), which fails when the speech package brings its own older copy back.
test("the packaged app transcribes a meeting from the microphone on this computer, and tells its speakers apart", async () => {
  expect(existsSync(packagedExecutable), `${packagedExecutable}: run npm run dist:dir first`).toBe(
    true,
  );
  const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
  dataDir = await mkdtemp(join(tmpdir(), "incarnamind-data-"));
  folders.push(home, dataDir);
  await copyModelsIn(dataDir);
  app = await launchPackaged(home, dataDir, { speech });
  const window = await app.firstWindow();
  const output = join(home, "Output");
  await mkdir(output);
  await useOutputLocation(window, output);
  // The real engine is told words (#1031): none of them is said, and none may be written.
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { meetingWords: ["Lindqvist", "Harbor Logistics", "星河科技"] },
    }),
  );

  const sheet = await recordMicrophone(window);
  const beside = await besideOnceTranscribing(window, sheet);
  // The words being said, before their line is finished: the streaming model loaded and reads.
  await expect(sheet.getByTestId("transcript-partial").first()).toContainText(/\p{L}/u, {
    timeout: 2 * 60_000,
  });
  await pointAndClick(window, beside);
  await expect(sheet).toBeHidden();
  // With the sheet folded, the Transcript's own lines stand over the meeting's control.
  const stopped = window
    .getByTestId("meeting-transcript-line")
    .filter({ hasText: /Transcription stopped|couldn’t/ });
  const lines = window.getByTestId("transcript-lines");
  for (const word of [/fathers/i, /nation/i, /liberty/i, /equal/i, /Thursday/i]) {
    await expect(lines).toContainText(word, { timeout: 2 * 60_000 });
  }
  await expect(lines).not.toContainText(/Lindqvist|Harbor Logistics|星河科技/);
  // The file plays again from its start, so a second line means it went on past the first.
  await expect
    .poll(() => lines.getByTestId("transcript-line").count(), { timeout: 2 * 60_000 })
    .toBeGreaterThan(1);
  await expect(stopped).toHaveCount(0);
  if (process.platform === "win32") await expectSpeechEngineOnTheAppsRuntime(app);
  // The capture opens no audio output: one that is slow to open held the microphone back, and
  // one that failed left the whole Meeting with nothing captured (#3248).
  if (process.platform === "darwin") expect(await audioOutputsHeldBy(app)).toEqual([]);

  await stopMeeting(window);
  await transcriptSaved(window, 5 * 60_000);
  // Finished, it is kept in the Library: its file is the data folder's own, and the chosen
  // Output location gets nothing (#763).
  expect(await readdir(join(dataDir, "Transcripts"))).not.toHaveLength(0);
  expect(await readdir(output)).toEqual([]);

  const speakers = lines.getByTestId("transcript-speaker");
  const failed = window
    .getByTestId("meeting-transcript-line")
    .filter({ hasText: "speakers couldn’t be told apart" });
  await expect
    .poll(
      async () => {
        if ((await failed.count()) > 0) return "failed";
        const labels = await speakers.allTextContents();
        return labels.length > 0 && labels.every((label) => /^Speaker \d+$/.test(label))
          ? [...new Set(labels)].sort().join(", ")
          : "waiting";
      },
      { timeout: 10 * 60_000 },
    )
    .toBe("Speaker 1, Speaker 2");

  await app.close();
  app = undefined;
  // Only a run that got this far has the whole model to keep.
  await copyModelsOut(dataDir);
});

for (const { kind, overlap } of [
  { kind: "without a pause", overlap: false },
  { kind: "with overlapping audio", overlap: true },
]) {
  test(`a speaker handoff ${kind} gets two speaker turns after Stop`, async () => {
    expect(
      existsSync(packagedExecutable),
      `${packagedExecutable}: build the packaged app first`,
    ).toBe(true);
    const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
    dataDir = await mkdtemp(join(tmpdir(), "incarnamind-data-"));
    folders.push(home, dataDir);
    await copyModelsIn(dataDir);
    const speech = await oneHandoff(home, overlap);
    app = await launchPackaged(home, dataDir, { speech });
    const window = await app.firstWindow();
    const sheet = await recordMicrophone(window);
    const beside = sheet.getByTestId("meeting-sheet-beside");
    await expect(beside).toBeEnabled({ timeout: HANDOFF_WAIT_MS });
    await pointAndClick(window, beside);
    await expect(sheet).toBeHidden();

    const lines = window.getByTestId("transcript-line");
    const shared = lines.filter({ hasText: /created equal.*thank you/i });
    await expect(shared.first()).toBeVisible({ timeout: HANDOFF_WAIT_MS });
    const wordsBefore = (await shared.first().innerText()).trim();
    await stopMeeting(window);
    await savedWithSpeakers(window);
    const first = lines.filter({ hasText: /created equal/i }).first();
    const second = lines.filter({ hasText: /Thursday morning/i }).first();
    await expect(turnOf(first).getByTestId("transcript-speaker")).toHaveText("Speaker 1");
    await expect(turnOf(second).getByTestId("transcript-speaker")).toHaveText("Speaker 2");
    await expect(shared).toHaveCount(0);
    expect([await first.innerText(), await second.innerText()].join(" ")).toBe(wordsBefore);
    await copyModelsOut(dataDir);
  });
}

// protects=each short Mandarin opening word stays with its own phrase in the saved Transcript (#2305); fails_when=an opening word is missing, misplaced, or present only on a later play; no_claim=the number of cues produced by a pause, or how well the engine recognises names and numbers (#1031).
test("the packaged app keeps the short first word of each Chinese line", async () => {
  expect(
    existsSync(packagedExecutable),
    `${packagedExecutable}: build the packaged app first`,
  ).toBe(true);
  const home = await mkdtemp(join(tmpdir(), "incarnamind-home-"));
  dataDir = await mkdtemp(join(tmpdir(), "incarnamind-data-"));
  folders.push(home, dataDir);
  await copyModelsIn(dataDir);
  const durationMs = msOf(monoSamples(await readFile(shortFirstWords), shortFirstWords).length);
  app = await launchPackaged(home, dataDir, { speech: `${shortFirstWords}%noloop` });
  const window = await app.firstWindow();

  const sheet = await recordMicrophone(window);
  await pointAndClick(window, await besideOnceTranscribing(window, sheet));
  await expect(sheet).toBeHidden();

  const meetingId = await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listMeetings())[0]?.id;
  });
  if (!meetingId) throw new Error("The recording has no Meeting.");
  const folder = meetingFolder(dataDir, meetingId);
  // Wait for one full play to reach disk, including when the live reader falls behind.
  await expect
    .poll(
      () =>
        listParts(folder)
          .filter((part) => part.source === "microphone")
          .reduce((ms, part) => ms + part.durationMs, 0),
      { timeout: 2 * 60_000 },
    )
    .toBeGreaterThanOrEqual(durationMs);
  await stopMeeting(window);
  await savedWithSpeakers(window);

  // A breath can put the first word in its own cue in the same speaker's paragraph (#2305).
  await expect(async () => {
    const paragraphs = await window
      .getByTestId("transcript-turn")
      .locator("p.transcript-text")
      .evaluateAll((elements) =>
        elements.map((paragraph) =>
          Array.from(
            paragraph.querySelectorAll<HTMLElement>('[data-testid="transcript-line"]'),
            (cue) => ({
              text: (cue.textContent ?? "").replace(/[，。,.\s]/gu, ""),
              start: Number(cue.dataset.start),
              end: Number(cue.dataset.end),
            }),
          ),
        ),
      );
    const openings = paragraphs.flatMap((cues) =>
      cues.flatMap((cue, index) => {
        const before = cues[index - 1];
        // The recorded pause is 400 ms. Allow for the detector's cue boundaries, within one breath.
        const joined =
          before && /^[对行是]$/u.test(before.text) && cue.start - before.end <= 800
            ? before.text + cue.text
            : cue.text;
        return joined.match(/^[对行是]?(?:总价|周五|合同)/u) ?? [];
      }),
    );
    expect(openings, JSON.stringify(paragraphs)).toEqual(["对总价", "行周五", "是合同"]);
  }).toPass({ timeout: 5000 });

  await app.close();
  app = undefined;
  await copyModelsOut(dataDir);
});
