/**
 * `npm run eval:meetings` (eval/meetings/README.md): the first speech-to-text engine (Qwen3-ASR
 * 0.6B int8 with Silero VAD, through sherpa-onnx-node, on the CPU) on the meeting set, through
 * the code the app runs (`createSpeechHost`). Each track of a case is a stream, fed in 100 ms
 * frames as fast as the engine takes them; the lines are labelled as a live Meeting labels them:
 * "Me" for the microphone, "Them" for the system audio, and none for a room. The hypotheses go
 * to a results folder and are scored as `npm run eval:meetings:score` scores them.
 *
 * Needs the cases (`npm run eval:meetings:fetch`) and the model, which is downloaded the first
 * time into the evaluation's cache.
 *
 * INCARNAMIND_EVAL_CASES: only these cases, comma-separated.
 * INCARNAMIND_EVAL_UNTIL_MINUTES: only the first minutes of each case, for a quick look. The
 *   real-time factor is not reported then.
 * INCARNAMIND_EVAL_OUT: the results folder (default eval/results/meetings-local-<date>).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MEETING_SAMPLE_RATE, type SpeechSegment } from "../../src/core/adapters";
import { QWEN3_ASR_0_6B, transcriptionModelFiles } from "../../src/core/transcription/model";
import { createSherpaEngine } from "../../src/core/transcription/sherpa";
import { createSpeechHost } from "../../src/core/transcription/speech";
import { monoSamples } from "../lib/wav";
import { FRAME, modelData } from "../transcription/clips";
import { loadCase, readCases } from "./cache";
import { type CaseScore, formatReport, scoreCase } from "./report";
import type { Hypothesis, Track } from "./types";

const ONLY = process.env.INCARNAMIND_EVAL_CASES?.split(",").filter(Boolean);
const UNTIL = process.env.INCARNAMIND_EVAL_UNTIL_MINUTES
  ? Number(process.env.INCARNAMIND_EVAL_UNTIL_MINUTES) * 60
  : undefined;
const LABELS: Partial<Record<Track, string>> = { mic: "Me", system: "Them" };
const YIELD_EVERY = 50;

describe("Transcription on this computer, on the meeting set", () => {
  test("WER, CER, DER and the real-time factor", async () => {
    const definitions = (await readCases()).filter((c) => !ONLY || ONLY.includes(c.id));
    expect(definitions.length).toBeGreaterThan(0);
    const date = new Date().toISOString().slice(0, 10);
    const out =
      process.env.INCARNAMIND_EVAL_OUT ??
      join(process.cwd(), "eval", "results", `meetings-local-${date}`);
    await mkdir(out, { recursive: true });

    const dataDir = await modelData();
    const files = transcriptionModelFiles(dataDir, QWEN3_ASR_0_6B);
    const engine = await createSherpaEngine(files);
    const scores: CaseScore[] = [];

    for (const definition of definitions) {
      const loaded = await loadCase(definition);
      const segments: SpeechSegment[] = [];
      const host = createSpeechHost(engine, {
        segment: (segment) => {
          if (segment.final && segment.text) segments.push(segment);
        },
        progress: () => {},
        failed: (stream, message) => console.error(`${definition.id} ${stream}: ${message}`),
      });
      const tracks = await Promise.all(
        Object.entries(loaded.tracks).map(async ([track, path]) => {
          const samples = monoSamples(await readFile(path as string), path as string);
          const length = UNTIL
            ? Math.min(samples.length, UNTIL * MEETING_SAMPLE_RATE)
            : samples.length;
          return [track as Track, samples.subarray(0, length)] as const;
        }),
      );
      const started = Date.now();
      const length = Math.max(...tracks.map(([, samples]) => samples.length));
      for (let at = 0, frames = 0; at < length; at += FRAME, frames++) {
        for (const [track, samples] of tracks) host.push(track, samples.subarray(at, at + FRAME));
        if (frames % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      await Promise.all(tracks.map(([track]) => host.finish(track)));
      const processingSeconds = (Date.now() - started) / 1000;

      const hypothesis: Hypothesis = {
        case: definition.id,
        transcriber: `${QWEN3_ASR_0_6B.name} with Silero VAD, ${files.threads} threads`,
        processingSeconds,
        segments: segments.map((segment) => {
          const speaker = LABELS[segment.stream as Track];
          return {
            start: segment.startMs / 1000,
            end: segment.endMs / 1000,
            text: segment.text,
            ...(speaker && { speaker }),
          };
        }),
      };
      await writeFile(join(out, `${definition.id}.json`), JSON.stringify(hypothesis));
      scores.push(scoreCase(definition, loaded.reference, hypothesis, { until: UNTIL }));
      console.log(`${definition.id}: ${formatReport(scores.slice(-1)).split("\n").at(-1)}`);
    }
    engine.close();

    const report = formatReport(scores);
    await writeFile(join(out, "score.md"), `${report}\n`);
    console.log(
      `${report}\n\nLoad average while it ran: ${loadavg()
        .map((v) => v.toFixed(1))
        .join(" ")}`,
    );
  });
});
