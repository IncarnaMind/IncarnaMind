/**
 * `npm run eval:speakers` (eval/speakers/README.md): the speaker pass on the meeting audio set
 * (eval/meetings, #85), as the app runs it. For each case, the track whose voices the pass tells
 * apart (the computer's sound online, the room's otherwise) is written as a Meeting's 10-second
 * parts and separated by the pass's own engine (`createSherpaSeparator`); the Transcript's lines
 * are cut as the transcription process cuts them, with Silero VAD, and labelled by the pass's
 * own rule (`labelled`), the microphone's "Me" online. Each case's labelled lines are written as
 * a hypothesis for eval/meetings' scorer, which gives DER; they carry no text, so its error
 * rate means nothing here.
 *
 * INCARNAMIND_EVAL_MEETING_CASES: the cases' folder (default: the evaluation cache's meetings/cases).
 * INCARNAMIND_EVAL_SPEAKER_CASES: case ids to run, comma-separated (default: all).
 * INCARNAMIND_EVAL_SPEAKER_THRESHOLDS: clustering thresholds to try (default: the app's).
 * INCARNAMIND_EVAL_SPEAKER_SAME: how alike two voiceprints are to be one person, to try (default: the app's).
 * INCARNAMIND_EVAL_SPEAKER_MINUTES: only the first minutes of each case, for tuning.
 * INCARNAMIND_EVAL_SPEAKER_HOUR=1: also an hour of the room cases one after the other, for the real-time factor.
 * INCARNAMIND_EVAL_SPEAKER_WINDOW: minutes the engine clusters at once (default: the app's), to check the join across windows on cases shorter than the app's window.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { VoiceTurn } from "../../src/core";
import { silentLogger } from "../../src/core/activityLog";
import type { Cue } from "../../src/core/documents/formats/vtt";
import { downloadModel } from "../../src/core/embedding/download";
import { writePart } from "../../src/core/meetings/audioFiles";
import { labelled } from "../../src/core/meetings/speakerPass";
import {
  CLUSTER_THRESHOLD,
  createSherpaSeparator,
  SAME_PERSON,
  WINDOW_SECONDS,
} from "../../src/core/transcription/diarization";
import { SILERO_VAD } from "../../src/core/transcription/model";
import { createSileroDetectors } from "../../src/core/transcription/sherpa";
import { createSpeakerModel } from "../../src/core/transcription/speakerModel";
import { SPEAKER_ME, SPEAKER_THEM, SPEAKER_UNKNOWN } from "../../src/shared/speakers";
import { evalCache } from "../lib/cache";

const CASES = process.env.INCARNAMIND_EVAL_MEETING_CASES ?? join(evalCache(), "meetings", "cases");
const ONLY = process.env.INCARNAMIND_EVAL_SPEAKER_CASES?.split(",");
const THRESHOLDS = (process.env.INCARNAMIND_EVAL_SPEAKER_THRESHOLDS ?? String(CLUSTER_THRESHOLD))
  .split(",")
  .map(Number);
const SAME = (process.env.INCARNAMIND_EVAL_SPEAKER_SAME ?? String(SAME_PERSON))
  .split(",")
  .map(Number);
const MINUTES = Number(process.env.INCARNAMIND_EVAL_SPEAKER_MINUTES ?? "0");
const WINDOW = process.env.INCARNAMIND_EVAL_SPEAKER_WINDOW
  ? Number(process.env.INCARNAMIND_EVAL_SPEAKER_WINDOW) * 60
  : WINDOW_SECONDS;
const RATE = 16_000;
const PART_SAMPLES = 10 * RATE;

interface Case {
  id: string;
  /** The track the pass separates, and online the microphone's. */
  separate: Int16Array;
  mic: Int16Array | null;
}

/** A WAV file's 16-bit samples, wherever its data chunk is. */
function samplesOf(path: string): Int16Array {
  const bytes = readFileSync(path);
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "data") {
      const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
      const copy = new Uint8Array(body.byteLength - (body.byteLength % 2));
      copy.set(body.subarray(0, copy.byteLength));
      const samples = new Int16Array(copy.buffer);
      return MINUTES > 0 ? samples.subarray(0, MINUTES * 60 * RATE) : samples;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no data chunk.`);
}

function casesIn(folder: string): Case[] {
  return readdirSync(folder)
    .filter((id) => !ONLY || ONLY.includes(id))
    .sort()
    .flatMap((id) => {
      const track = ["system", "room", "conversation"]
        .map((name) => join(folder, id, `${name}.wav`))
        .find((path) => existsSync(path));
      if (!track) return [];
      const mic = join(folder, id, "mic.wav");
      return [{ id, separate: samplesOf(track), mic: existsSync(mic) ? samplesOf(mic) : null }];
    });
}

/** The samples as a Meeting keeps its audio: 10-second parts. */
async function partsOf(samples: Int16Array) {
  const folder = await mkdtemp(join(tmpdir(), "incarnamind-speakers-"));
  const parts = [];
  for (let at = 0; at < samples.length; at += PART_SAMPLES) {
    const part = writePart(
      folder,
      "system",
      (at * 1000) / RATE,
      samples.subarray(at, at + PART_SAMPLES),
    );
    parts.push({ path: part.path, offsetMs: part.offsetMs });
  }
  return { folder, parts };
}

async function models() {
  const dataDir = await mkdtemp(join(tmpdir(), "incarnamind-speaker-models-"));
  const folder = join(evalCache(), "models");
  await mkdir(folder, { recursive: true });
  await symlink(folder, join(dataDir, "models"));
  const vad = join(folder, SILERO_VAD.folder);
  await downloadModel({
    directory: vad,
    source: SILERO_VAD.source,
    signal: new AbortController().signal,
    onProgress: () => {},
  });
  return {
    speakers: await createSpeakerModel({ dataDir, log: silentLogger }).files(),
    vad: join(vad, SILERO_VAD.file),
  };
}

/** The Transcript's lines as the transcription process cuts them, with Silero VAD. */
async function linesOf(samples: Int16Array, vadFile: string, speaker: string): Promise<Cue[]> {
  const detector = (await createSileroDetectors(vadFile))();
  const lines: Cue[] = [];
  const take = () => {
    for (let found = detector.next(); found; found = detector.next()) {
      const startMs = (found.start * 1000) / RATE;
      lines.push({
        startMs,
        endMs: startMs + (found.samples.length * 1000) / RATE,
        text: "",
        speaker,
      });
    }
  };
  const step = RATE / 10;
  for (let at = 0; at < samples.length; at += step) {
    const chunk = samples.subarray(at, at + step);
    const floats = new Float32Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) floats[i] = (chunk[i] ?? 0) / 32768;
    detector.accept(floats);
    take();
  }
  detector.flush();
  take();
  return lines;
}

const asSegments = (cues: readonly { startMs: number; endMs: number; speaker: string | null }[]) =>
  cues.map((cue) => ({
    start: cue.startMs / 1000,
    end: cue.endMs / 1000,
    text: "",
    speaker: cue.speaker ?? SPEAKER_UNKNOWN,
  }));

const turnsAsSegments = (turns: readonly VoiceTurn[]) =>
  asSegments(turns.map((turn) => ({ ...turn, speaker: `voice ${turn.voice}` })));

describe.runIf(existsSync(CASES))("The speaker pass on the meeting audio set", () => {
  test("hypotheses for eval/meetings' scorer, and the real-time factor", async () => {
    const { speakers, vad } = await models();
    const cases = casesIn(CASES);
    if (process.env.INCARNAMIND_EVAL_SPEAKER_HOUR === "1") {
      const room = cases.filter((each) => each.mic === null && each.id.includes("-room-"));
      const hour = new Int16Array(60 * 60 * RATE);
      let at = 0;
      for (const each of room) {
        if (at >= hour.length) break;
        hour.set(each.separate.subarray(0, hour.length - at), at);
        at += each.separate.length;
      }
      cases.push({
        id: "an hour of room cases",
        separate: hour.subarray(0, Math.min(at, hour.length)),
        mic: null,
      });
    }
    const out = join(
      process.cwd(),
      "eval",
      "results",
      `speakers-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    const rows: string[] = [];
    for (const [threshold, samePerson] of THRESHOLDS.flatMap((t) =>
      SAME.map((same) => [t, same] as const),
    )) {
      const separate = await createSherpaSeparator({
        threshold,
        samePerson,
        windowSeconds: WINDOW,
      });
      const lines = join(out, `lines-${threshold}-${samePerson}`);
      const raw = join(out, `turns-${threshold}-${samePerson}`);
      await mkdir(lines, { recursive: true });
      await mkdir(raw, { recursive: true });
      for (const each of cases) {
        const { folder, parts } = await partsOf(each.separate);
        const load = loadavg()[0] ?? 0;
        const started = performance.now();
        const turns = separate({ parts, model: speakers });
        const seconds = (performance.now() - started) / 1000;
        await rm(folder, { recursive: true, force: true });
        const call = each.mic !== null;
        const cues = [
          ...(each.mic ? await linesOf(each.mic, vad, SPEAKER_ME) : []),
          ...(await linesOf(each.separate, vad, call ? SPEAKER_THEM : SPEAKER_UNKNOWN)),
        ].sort((a, b) => a.startMs - b.startMs);
        const final = labelled(cues, turns, call) ?? cues;
        const audio = each.separate.length / RATE;
        const hypothesis = {
          case: each.id,
          transcriber: `speaker pass, threshold ${threshold}, same person ${samePerson}`,
          processingSeconds: seconds,
        };
        await writeFile(
          join(lines, `${each.id}.json`),
          JSON.stringify({ ...hypothesis, segments: asSegments(final) }),
        );
        await writeFile(
          join(raw, `${each.id}.json`),
          JSON.stringify({ ...hypothesis, segments: turnsAsSegments(turns) }),
        );
        const voices = new Set(turns.map((turn) => turn.voice)).size;
        const labels = new Set(final.map((cue) => cue.speaker)).size;
        const row = `| ${threshold} / ${samePerson} | ${each.id} | ${(audio / 60).toFixed(1)} min | ${voices} | ${labels} | ${(seconds / audio).toFixed(3)}× | ${load.toFixed(1)} |`;
        console.log(row);
        rows.push(row);
      }
    }
    await writeFile(
      join(out, "speakers.md"),
      [
        `${availableParallelism()} cores, ${speakers.threads} threads for the pass.`,
        "",
        "| Threshold / same person | Case | Audio | Voices found | Labels | Time / audio | Load |",
        "|---|---|---|---|---|---|---|",
        ...rows,
      ].join("\n"),
    );
    console.log(`Hypotheses in ${out}: score each folder with eval/meetings' scorer.`);
    expect(rows).toHaveLength(cases.length * THRESHOLDS.length * SAME.length);
  });
});
