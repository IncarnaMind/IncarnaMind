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
 * INCARNAMIND_EVAL_WORDS=1: each case's transcriber is told its words in words.json (#1031), as a
 *   Meeting tells it its Words to know; the run scores those words either way.
 * INCARNAMIND_EVAL_LIVE=off: without the streaming model for the live words (#2662), as before it.
 * INCARNAMIND_EVAL_ROUTE: "soniox" or "openai" sends each track instead to that cloud route, through
 *   the app's adapter, at the pace it was spoken (./cloud); INCARNAMIND_EVAL_PARALLEL cases at once.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MEETING_SAMPLE_RATE, type SpeechSegment } from "../../src/core/adapters";
import { QWEN3_ASR_0_6B } from "../../src/core/transcription/model";
import { createSherpaEngine } from "../../src/core/transcription/sherpa";
import { createSpeechHost } from "../../src/core/transcription/speech";
import { monoSamples } from "../lib/wav";
import { evalModelFiles, FRAME, modelData } from "../transcription/clips";
import { loadCase, readCases } from "./cache";
import { type CloudRoute, cloudModelOf, isCloudRoute, transcribeOnCloud } from "./cloud";
import { type CaseScore, formatReport, scoreCase } from "./report";
import { formatTerms, readWords, scoreTerms, type TermScore } from "./terms";
import type { Hypothesis, Language, Track } from "./types";

const ONLY = process.env.INCARNAMIND_EVAL_CASES?.split(",").filter(Boolean);
const UNTIL = process.env.INCARNAMIND_EVAL_UNTIL_MINUTES
  ? Number(process.env.INCARNAMIND_EVAL_UNTIL_MINUTES) * 60
  : undefined;
const TOLD = process.env.INCARNAMIND_EVAL_WORDS === "1";
const LABELS: Partial<Record<Track, string>> = { mic: "Me", system: "Them" };
const ROUTE = process.env.INCARNAMIND_EVAL_ROUTE ?? "local";
const PARALLEL = Number(process.env.INCARNAMIND_EVAL_PARALLEL ?? "1");
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

    if (ROUTE !== "local") {
      if (!isCloudRoute(ROUTE)) throw new Error(`No route "${ROUTE}".`);
      await runOnCloud(ROUTE, definitions, out);
      return;
    }
    const dataDir = await modelData();
    const files = evalModelFiles(dataDir);
    const engine = await createSherpaEngine(files);
    const scores: CaseScore[] = [];
    const words = await readWords();
    const termScores: { id: string; language: Language; score: TermScore }[] = [];

    for (const definition of definitions) {
      const told = words[definition.id] ?? { said: [], notSaid: [], told: [] };
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
      if (TOLD) for (const [track] of tracks) host.words(track, told.told);
      const started = Date.now();
      const cpuStarted = process.cpuUsage();
      const length = Math.max(...tracks.map(([, samples]) => samples.length));
      for (let at = 0, frames = 0; at < length; at += FRAME, frames++) {
        for (const [track, samples] of tracks) host.push(track, samples.subarray(at, at + FRAME));
        if (frames % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      await Promise.all(tracks.map(([track]) => host.finish(track)));
      const processingSeconds = (Date.now() - started) / 1000;
      const cpu = process.cpuUsage(cpuStarted);
      const cpuPerMinute = (cpu.user + cpu.system) / 1e6 / (length / MEETING_SAMPLE_RATE / 60);

      const hypothesis: Hypothesis = {
        case: definition.id,
        transcriber: `${QWEN3_ASR_0_6B.name} with Silero VAD, ${files.threads} threads${files.live ? ", live words from the streaming model" : ""}${TOLD ? ", told its words" : ""}`,
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
      termScores.push({
        id: definition.id,
        language: definition.language,
        score: scoreTerms(definition.language, loaded.reference, hypothesis, told, UNTIL),
      });
      console.log(
        `${definition.id}: ${formatReport(scores.slice(-1)).split("\n").at(-1)} ${segments.length} lines, CPU ${cpuPerMinute.toFixed(1)} s per audio minute`,
      );
    }
    engine.close();

    const report = `${formatReport(scores)}\n\n${formatTerms(termScores)}`;
    await writeFile(join(out, "score.md"), `${report}\n`);
    await writeFile(join(out, "terms.json"), JSON.stringify(termScores, null, 2));
    console.log(
      `${report}\n\nLoad average while it ran: ${loadavg()
        .map((v) => v.toFixed(1))
        .join(" ")}`,
    );
  });
});

/** The cases on a cloud route, `PARALLEL` at a time, scored as this computer's are. */
async function runOnCloud(
  route: CloudRoute,
  definitions: Awaited<ReturnType<typeof readCases>>,
  out: string,
): Promise<void> {
  const words = await readWords();
  const scores: CaseScore[] = [];
  const termScores: { id: string; language: Language; score: TermScore }[] = [];
  const queue = [...definitions];
  const transcriber = `${route} ${cloudModelOf(route)}${TOLD ? ", told its words" : ""}`;
  async function next(): Promise<void> {
    const definition = queue.shift();
    if (!definition) return;
    const told = words[definition.id] ?? { said: [], notSaid: [], told: [] };
    const loaded = await loadCase(definition);
    const tracks: Record<string, Float32Array> = {};
    for (const [track, path] of Object.entries(loaded.tracks)) {
      const samples = monoSamples(await readFile(path as string), path as string);
      tracks[track] = samples.subarray(
        0,
        UNTIL ? Math.min(samples.length, UNTIL * MEETING_SAMPLE_RATE) : samples.length,
      );
    }
    const started = Date.now();
    const segments = await transcribeOnCloud(route, tracks, TOLD ? told.told : []);
    const hypothesis: Hypothesis = {
      case: definition.id,
      transcriber,
      processingSeconds: (Date.now() - started) / 1000,
      segments: segments
        .map((segment) => {
          const speaker = LABELS[segment.stream as Track];
          return {
            start: segment.startMs / 1000,
            end: segment.endMs / 1000,
            text: segment.text,
            ...(speaker && { speaker }),
          };
        })
        .sort((a, b) => a.start - b.start),
    };
    await writeFile(join(out, `${definition.id}.json`), JSON.stringify(hypothesis));
    scores.push(scoreCase(definition, loaded.reference, hypothesis, { until: UNTIL }));
    termScores.push({
      id: definition.id,
      language: definition.language,
      score: scoreTerms(definition.language, loaded.reference, hypothesis, told, UNTIL),
    });
    console.log(`${definition.id}: ${formatReport(scores.slice(-1)).split("\n").at(-1)}`);
    await next();
  }
  await Promise.all(Array.from({ length: Math.max(1, PARALLEL) }, next));
  const order = new Map(definitions.map((each, at) => [each.id, at]));
  const byCase = <T extends { id: string }>(list: T[]) =>
    list.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const report = `**${transcriber}**\n\n${formatReport(byCase(scores))}\n\n${formatTerms(byCase(termScores))}`;
  await writeFile(join(out, "score.md"), `${report}\n`);
  await writeFile(join(out, "terms.json"), JSON.stringify(termScores, null, 2));
  console.log(report);
}
