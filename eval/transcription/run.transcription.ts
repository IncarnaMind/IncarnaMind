/**
 * `npm run eval:transcription` (eval/transcription/README.md): the real
 * speech-to-text engine (Qwen3-ASR-0.6B int8 and Silero VAD, through
 * sherpa-onnx-node) on a stream made of FLEURS clips, one per language, fed
 * in 100 ms frames at the pace a Meeting is captured, through the same code
 * as the transcription process (`createSpeechHost`). Reports WER (English),
 * CER (Chinese), how long decoding took for the audio it decoded, and how far
 * live text was behind when the audio ended.
 *
 * INCARNAMIND_EVAL_CLIPS: the folder fetch-fleurs.py wrote (required).
 * INCARNAMIND_EVAL_MODELS: a folder holding the model's files as the data
 * folder's `models/` does; by default ~/.cache/incarnamind-eval/models, where
 * they are downloaded and checked the first time.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MEETING_SAMPLE_RATE, type SpeechSegment } from "../../src/core/adapters";
import { QWEN3_ASR_0_6B, transcriptionModelFiles } from "../../src/core/transcription/model";
import { createSherpaEngine } from "../../src/core/transcription/sherpa";
import { createSpeechHost } from "../../src/core/transcription/speech";
import { clipsOf, FRAME, modelData, streamOf } from "./clips";
import { characters, type ErrorRate, errorRate, words } from "./scoring";

const CLIPS = process.env.INCARNAMIND_EVAL_CLIPS;

interface LanguageResult {
  language: string;
  clips: number;
  audioSeconds: number;
  speechSeconds: number;
  score: ErrorRate & { unit: "word" | "character" };
  /** Decoding time for the final text over the audio it decoded. */
  decodeRatio: number;
  /** All decoding, partial text included, over the stream's length. */
  busyRatio: number;
  partials: number;
  /** How long after the audio ended its last final text came, in seconds. */
  behindAtEnd: number;
  hypothesis: string;
}

describe.runIf(CLIPS)("Transcription on this computer", () => {
  test("WER, CER and how long decoding takes, on FLEURS clips fed as a Meeting is", async () => {
    const dataDir = await modelData();
    const files = transcriptionModelFiles(dataDir, QWEN3_ASR_0_6B);
    const loadStarted = Date.now();
    const engine = await createSherpaEngine(files);
    const loadSeconds = (Date.now() - loadStarted) / 1000;
    const results: LanguageResult[] = [];

    for (const language of ["en", "zh"]) {
      const clips = await clipsOf(CLIPS as string, language);
      const stream = await streamOf(clips);

      const segments: SpeechSegment[] = [];
      let lastFinalAt = 0;
      const host = createSpeechHost(engine, {
        segment(segment) {
          segments.push(segment);
          if (segment.final) lastFinalAt = Date.now();
        },
        progress: () => {},
        failed: (_stream, message) => console.error(`A stretch couldn't be decoded: ${message}`),
      });
      const started = Date.now();
      for (let at = 0; at < stream.length; at += FRAME) {
        host.push(language, stream.subarray(at, at + FRAME));
        const due = started + ((at + FRAME) * 1000) / MEETING_SAMPLE_RATE;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now())));
      }
      const audioEnded = Date.now();
      await host.finish(language);
      const finals = segments.filter((segment) => segment.final);
      const hypothesis = finals.map((segment) => segment.text).join(language === "zh" ? "" : " ");
      const reference = clips.map((clip) => clip.reference).join(language === "zh" ? "" : " ");
      const split = language === "zh" ? characters : words;
      const speechMs = finals.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0);
      const audioMs = (stream.length * 1000) / MEETING_SAMPLE_RATE;
      results.push({
        language,
        clips: clips.length,
        audioSeconds: Math.round(audioMs / 100) / 10,
        speechSeconds: Math.round(speechMs / 100) / 10,
        score: {
          ...errorRate(split(reference), split(hypothesis)),
          unit: language === "zh" ? "character" : "word",
        },
        decodeRatio:
          finals.reduce((sum, segment) => sum + segment.decodeMs, 0) / Math.max(1, speechMs),
        busyRatio: segments.reduce((sum, segment) => sum + segment.decodeMs, 0) / audioMs,
        partials: segments.length - finals.length,
        behindAtEnd: Math.max(0, lastFinalAt - audioEnded) / 1000,
        hypothesis,
      });
    }
    engine.close();

    const report = {
      date: new Date().toISOString(),
      model: QWEN3_ASR_0_6B.name,
      threads: files.threads,
      loadSeconds,
      /** The machine's load while it ran: the ratios are only as good as the machine was free. */
      loadAverage: loadavg().map((value) => Math.round(value * 10) / 10),
      results,
    };
    const out = join(process.cwd(), "eval", "results");
    await mkdir(out, { recursive: true });
    await writeFile(
      join(out, `transcription-${report.date.slice(0, 10)}.json`),
      JSON.stringify(report, null, 2),
    );
    console.log(
      [
        `${report.model}, ${report.threads} threads, loaded in ${loadSeconds.toFixed(1)} s, load average ${report.loadAverage.join(" ")}`,
        ...results.map(
          (result) =>
            `${result.language}: ${result.clips} clips, ${result.audioSeconds} s of audio; ${result.score.unit === "word" ? "WER" : "CER"} ${(result.score.rate * 100).toFixed(1)}% (${result.score.errors}/${result.score.total}); decoding ${result.decodeRatio.toFixed(2)}× the speech it decoded, ${result.busyRatio.toFixed(2)}× the stream with partial text; ${result.partials} partials; last line ${result.behindAtEnd.toFixed(1)} s after the audio ended`,
        ),
      ].join("\n"),
    );
    expect(results).toHaveLength(2);
  });
});
