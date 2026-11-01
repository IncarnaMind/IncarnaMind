/**
 * `npm run eval:meetings -- names` (eval/meetings/README.md, Words to know): two calls full of
 * names, one in English and one in Chinese, in synthetic speech (macOS `say`, the voices in
 * names.json), as #1031 measured the built app on them. Each call's two sides are the
 * microphone's and the computer sound's tracks, fed to the code the app runs (`createSpeechHost`,
 * Qwen3-ASR 0.6B with Silero VAD) in 100 ms frames, four times: told no words, told the call's own
 * names (as its Note and Folder give them), told those and the other call's (as a User's list
 * holds both), and told only the other call's names, none of them said.
 *
 * The audio is made the first time into the evaluation's cache, `meetings/names/`; macOS only.
 * INCARNAMIND_EVAL_OUT: the results folder (default eval/results/meetings-names-<date>).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { MEETING_SAMPLE_RATE, type SpeechSegment } from "../../src/core/adapters";
import { QWEN3_ASR_0_6B, transcriptionModelFiles } from "../../src/core/transcription/model";
import { createSherpaEngine } from "../../src/core/transcription/sherpa";
import { createSpeechHost } from "../../src/core/transcription/speech";
import { monoSamples } from "../lib/wav";
import { FRAME, modelData } from "../transcription/clips";
import { characters, errorRate, words } from "../transcription/scoring";
import { meetingsCache } from "./cache";
import { scoreTerms, type TermScore } from "./terms";
import type { Hypothesis, Reference, Track } from "./types";

interface Call {
  id: string;
  language: "en" | "zh";
  voices: { me: string; them: string };
  /** What the call's Note and Folder would tell the transcriber. */
  names: string[];
  /** Every name said, the parts of a name said alone too, for scoring. */
  said: string[];
  lines: { side: "me" | "them"; text: string }[];
}

const ARMS = ["none", "own", "own and other", "other only"] as const;
type Arm = (typeof ARMS)[number];

const GAP_SECONDS = 0.8;
const YIELD_EVERY = 50;
const callsFile = join(dirname(fileURLToPath(import.meta.url)), "names.json");

/**
 * Each line's speech, made with `say` the first time and kept as 16 kHz mono 16-bit WAV, named
 * for its voice and words, so a line changed in names.json is spoken again.
 */
async function lineAudio(call: Call, at: number): Promise<Float32Array> {
  const folder = join(meetingsCache(), "names");
  const line = call.lines[at] as Call["lines"][number];
  const voice = call.voices[line.side];
  const key = createHash("sha256").update(`${voice}\n${line.text}`).digest("hex").slice(0, 16);
  const wav = join(folder, `${call.id}-${String(at).padStart(2, "0")}-${key}.wav`);
  if (!existsSync(wav)) {
    await mkdir(folder, { recursive: true });
    const aiff = `${wav}.aiff`;
    const partial = `${wav}.partial.wav`;
    execFileSync("say", ["-v", voice, "-r", "165", "-o", aiff, line.text]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, partial]);
    await rename(partial, wav);
    await rm(aiff, { force: true });
  }
  return monoSamples(await readFile(wav), wav);
}

/** The call laid out as a conversation: each side's lines on its own track, one after another. */
async function layOut(call: Call) {
  const placed: { start: number; samples: Float32Array; track: Track; text: string }[] = [];
  let at = 1;
  for (const [index, line] of call.lines.entries()) {
    const samples = await lineAudio(call, index);
    placed.push({
      start: at,
      samples,
      track: line.side === "me" ? "mic" : "system",
      text: line.text,
    });
    at += samples.length / MEETING_SAMPLE_RATE + GAP_SECONDS;
  }
  const length = Math.ceil((at + 1) * MEETING_SAMPLE_RATE);
  const tracks = { mic: new Float32Array(length), system: new Float32Array(length) };
  for (const each of placed) {
    (each.track === "mic" ? tracks.mic : tracks.system).set(
      each.samples,
      Math.round(each.start * MEETING_SAMPLE_RATE),
    );
  }
  const reference: Reference = {
    format: 1,
    segments: placed.map((each) => ({
      start: each.start,
      end: each.start + each.samples.length / MEETING_SAMPLE_RATE,
      speaker: each.track,
      text: each.text,
      track: each.track,
    })),
  };
  return { tracks, reference };
}

describe("Words to know on two calls full of names (#1031)", () => {
  test("the names' error rate told and not told, and everything else's", async () => {
    const { calls } = JSON.parse(await readFile(callsFile, "utf8")) as { calls: Call[] };
    const date = new Date().toISOString().slice(0, 10);
    const out =
      process.env.INCARNAMIND_EVAL_OUT ??
      join(process.cwd(), "eval", "results", `meetings-names-${date}`);
    await mkdir(out, { recursive: true });
    const engine = await createSherpaEngine(
      transcriptionModelFiles(await modelData(), QWEN3_ASR_0_6B),
    );
    const results: {
      call: string;
      arm: Arm;
      told: string[];
      errors: ReturnType<typeof errorRate>;
      names: TermScore;
      lines: string[];
    }[] = [];

    for (const call of calls) {
      const other = calls.find((each) => each !== call) as Call;
      const { tracks, reference } = await layOut(call);
      for (const arm of ARMS) {
        const told =
          arm === "none"
            ? []
            : arm === "own"
              ? call.names
              : arm === "own and other"
                ? [...call.names, ...other.names]
                : other.names;
        const segments: SpeechSegment[] = [];
        const host = createSpeechHost(engine, {
          segment: (segment) => {
            if (segment.final && segment.text) segments.push(segment);
          },
          progress: () => {},
          failed: (stream, message) => console.error(`${call.id} ${stream}: ${message}`),
        });
        for (const track of ["mic", "system"] as const) host.words(track, told);
        for (let at = 0, frames = 0; at < tracks.mic.length; at += FRAME, frames++) {
          host.push("mic", tracks.mic.subarray(at, at + FRAME));
          host.push("system", tracks.system.subarray(at, at + FRAME));
          if (frames % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
        }
        await Promise.all([host.finish("mic"), host.finish("system")]);
        const hypothesis: Hypothesis = {
          case: call.id,
          transcriber: `${QWEN3_ASR_0_6B.name}, told ${arm}`,
          segments: segments
            .map((segment) => ({
              start: segment.startMs / 1000,
              end: segment.endMs / 1000,
              text: segment.text,
            }))
            .sort((a, b) => a.start - b.start),
        };
        const split = call.language === "en" ? words : characters;
        const text = (each: { text: string }[]) => each.map((segment) => segment.text).join(" ");
        results.push({
          call: call.id,
          arm,
          told,
          errors: errorRate(split(text(reference.segments)), split(text(hypothesis.segments))),
          names: scoreTerms(call.language, reference, hypothesis, {
            said: call.said,
            notSaid: arm === "own and other" || arm === "other only" ? other.names : [],
          }),
          lines: hypothesis.segments.map((segment) => segment.text),
        });
      }
    }
    engine.close();

    const rows = [
      "| Call | Told | Error rate | Names not written exactly | Other units' error rate | Told, never said, written |",
      "|---|---|---|---|---|---|",
      ...results.map(
        ({ call, arm, errors, names }) =>
          `| ${call} | ${arm} | ${(100 * errors.rate).toFixed(1)}% (${errors.errors} of ${errors.total}) | ${names.wrong} of ${names.occurrences} | ${((100 * names.others.errors) / Math.max(1, names.others.total)).toFixed(1)}% | ${names.unsaid} |`,
      ),
    ];
    const report = rows.join("\n");
    await writeFile(join(out, "names.md"), `${report}\n`);
    await writeFile(join(out, "names.json"), JSON.stringify(results, null, 2));
    console.log(report);
    expect(results.length).toBe(calls.length * ARMS.length);
  });
});
