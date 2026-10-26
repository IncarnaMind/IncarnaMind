import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { recordMeeting, startRecording, useOutputLocation } from "../app";
import {
  copyModelsIn,
  copyModelsOut,
  launchPackaged,
  packagedExecutable,
  packagedLogLines,
} from "./app";

const root = resolve(__dirname, "../..");
// The opening of the Gettysburg Address, read for LibriVox (tests/fixtures/speech/README.md).
const speech = join(root, "tests/fixtures/speech/gettysburg.wav");

test.skip(process.platform !== "darwin", "CI builds and runs the packaged app on macOS only");

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

// protects=meeting transcription works in the packaged app, through its real speech engine and model (#1233 failed only there, with every test passing on the fake transcriber), keeps going past its first stretch, and saves the Transcript; then the speaker pass runs to the end on its real engine and models in its own process (#138), and the room's lines are numbered; fails_when=the engine doesn't load in the packaged app, the transcript misses the words spoken, it stops after the first line, or the speaker process, its bundle or its models are broken, which leaves every line "Speaker ?"; no_claim=the computer's sound, how well voices are told apart (eval/speakers), Windows and Linux, or a cloud transcription service.
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

  const start = await recordMeeting(window);
  await start.getByTestId("meeting-start-audio").selectOption("me");
  const bar = await startRecording(window, start, { notice: true });

  // The toggle is greyed until the Transcript has its first line: the model is downloaded and
  // the engine runs. An engine that doesn't load says so instead, and the test stops there.
  const toggle = bar.getByTestId("meeting-transcript-toggle");
  const stopped = window
    .getByTestId("meeting-transcript-line")
    .filter({ hasText: /Transcription stopped|couldn’t/ });
  await expect(toggle.and(window.locator(":enabled")).or(stopped)).toBeVisible({
    timeout: 20 * 60_000,
  });
  await expect(stopped).toHaveCount(0);
  await toggle.click();
  const lines = window.getByTestId("transcript-lines");
  for (const word of [/fathers/i, /nation/i, /liberty/i, /equal/i]) {
    await expect(lines).toContainText(word, { timeout: 2 * 60_000 });
  }
  // The file plays again from its start, so a second line means it went on past the first.
  await expect
    .poll(() => lines.getByTestId("transcript-line").count(), { timeout: 2 * 60_000 })
    .toBeGreaterThan(1);
  await expect(stopped).toHaveCount(0);

  await bar.getByTestId("meeting-stop").click();
  const saved = window
    .getByTestId("meeting-transcript-line")
    .filter({ hasText: "Transcript saved" });
  await expect(saved).toBeVisible({ timeout: 5 * 60_000 });
  expect(await readdir(output)).not.toHaveLength(0);

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
          ? "numbered"
          : "waiting";
      },
      { timeout: 10 * 60_000 },
    )
    .toBe("numbered");

  await app.close();
  app = undefined;
  // Only a run that got this far has the whole model to keep.
  await copyModelsOut(dataDir);
});
