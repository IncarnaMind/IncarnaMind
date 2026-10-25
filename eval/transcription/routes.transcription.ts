/**
 * Each place meeting audio can be transcribed (#141), on the same FLEURS clips: this computer
 * (Qwen3-ASR-0.6B with Silero VAD), OpenAI's live model and Soniox, each with the User's own
 * key. Three streams go to each, fed in 100 ms frames at the pace they were spoken, through the
 * code the app runs (`createSpeechHost`, and the cloud adapters in
 * src/core/transcription/cloud): the English clips, the Chinese clips, and the two taking
 * turns, as a meeting in both languages does. Reports WER for English, CER for Chinese, and for
 * the mixed stream an error rate counting each Han character and each English word as one unit.
 *
 * INCARNAMIND_EVAL_CLIPS: the folder fetch-fleurs.py wrote (required).
 * OPENAI_API_KEY, SONIOX_API_KEY: a route runs only with its key.
 * INCARNAMIND_EVAL_RECORD: a folder to write what each service sent back, as the adapters'
 * contract tests replay it.
 * INCARNAMIND_EVAL_ROUTES: only these routes, comma-separated ("openai,soniox").
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MEETING_SAMPLE_RATE, type SpeechSegment } from "../../src/core/adapters";
import {
  OPENAI_LIVE_TRANSCRIPTION_MODEL,
  SONIOX_REALTIME_MODEL,
} from "../../src/core/providers/catalog/transcription";
import { createOpenAiStream } from "../../src/core/transcription/cloud/openai";
import { type CloudConnect, connectWebSocket } from "../../src/core/transcription/cloud/socket";
import { createSonioxStream } from "../../src/core/transcription/cloud/soniox";
import type { CloudStreamHandle } from "../../src/core/transcription/cloud/stream";
import { QWEN3_ASR_0_6B, transcriptionModelFiles } from "../../src/core/transcription/model";
import { createSherpaEngine, createSileroDetectors } from "../../src/core/transcription/sherpa";
import { createSpeechHost } from "../../src/core/transcription/speech";
import { type Clip, clipsOf, FRAME, modelData, streamOf } from "./clips";
import { characters, type ErrorRate, errorRate, words } from "./scoring";

const CLIPS = process.env.INCARNAMIND_EVAL_CLIPS;
const RECORD = process.env.INCARNAMIND_EVAL_RECORD;

type Route = "local" | "openai" | "soniox";
type Language = "en" | "zh" | "mixed";

interface Result {
  route: Route;
  language: Language;
  audioSeconds: number;
  score: ErrorRate & { unit: "word" | "character" | "unit" };
  /** How long after the audio ended its last final text came, in seconds. */
  behindAtEnd: number;
  lost: string | null;
  hypothesis: string;
}

const toInt16 = (samples: Float32Array) =>
  Int16Array.from(samples, (sample) =>
    Math.max(-32768, Math.min(32767, Math.round(sample * 32768))),
  );

/** Each English clip, then each Chinese one, taking turns. */
function takingTurns(en: readonly Clip[], zh: readonly Clip[]): Clip[] {
  const out: Clip[] = [];
  for (let i = 0; i < Math.max(en.length, zh.length); i++) {
    if (en[i]) out.push(en[i] as Clip);
    if (zh[i]) out.push(zh[i] as Clip);
  }
  return out;
}

/** The connection, keeping what the service sends back, with when. */
function recording(log: { atMs: number; text: string }[]): CloudConnect {
  const started = Date.now();
  return (url, apiKey, events) =>
    connectWebSocket(url, apiKey, {
      open: events.open,
      message(text) {
        log.push({ atMs: Date.now() - started, text });
        events.message(text);
      },
      closed: events.closed,
    });
}

function scoreOf(language: Language, clips: readonly Clip[], hypothesis: string) {
  const reference = clips
    .map((clip) => clip.reference)
    .join(language === "en" ? " " : language === "zh" ? "" : " ");
  const split = language === "en" ? words : characters;
  return {
    ...errorRate(split(reference), split(hypothesis)),
    unit:
      language === "en"
        ? ("word" as const)
        : language === "zh"
          ? ("character" as const)
          : ("unit" as const),
  };
}

describe.runIf(CLIPS)("Each route's error rate on English, Chinese and both taking turns", () => {
  test("this computer, OpenAI and Soniox on the same clips, fed as a Meeting is", async () => {
    const dataDir = await modelData();
    const files = transcriptionModelFiles(dataDir, QWEN3_ASR_0_6B);
    const engine = await createSherpaEngine(files);
    const detectors = await createSileroDetectors(files.vad);
    const en = await clipsOf(CLIPS as string, "en");
    const zh = await clipsOf(CLIPS as string, "zh");
    const sets: Record<Language, Clip[]> = { en, zh, mixed: takingTurns(en, zh) };
    const only = process.env.INCARNAMIND_EVAL_ROUTES?.split(",");
    const routes = (
      [
        "local",
        ...(process.env.OPENAI_API_KEY ? (["openai"] as const) : []),
        ...(process.env.SONIOX_API_KEY ? (["soniox"] as const) : []),
      ] as Route[]
    ).filter((route) => !only || only.includes(route));

    async function run(route: Route, language: Language): Promise<Result> {
      const clips = sets[language];
      const stream = await streamOf(clips);
      const finals: SpeechSegment[] = [];
      let lastFinalAt = 0;
      let lost: string | null = null;
      const log: { atMs: number; text: string }[] = [];
      const segment = (each: SpeechSegment) => {
        if (!each.final) return;
        finals.push(each);
        lastFinalAt = Date.now();
      };
      let push: (frame: Float32Array) => void;
      let finish: () => Promise<void>;
      if (route === "local") {
        const host = createSpeechHost(engine, {
          segment,
          progress: () => {},
          failed: (_stream, message) => console.error(`A stretch couldn't be decoded: ${message}`),
        });
        push = (frame) => host.push(language, frame);
        finish = () => host.finish(language);
      } else {
        const options = {
          stream: language,
          connect: recording(log),
          report: {
            segment,
            progress: () => {},
            lost: (loss: string) => (lost = loss),
            opened: () => {},
          },
        };
        const handle: CloudStreamHandle =
          route === "openai"
            ? createOpenAiStream({
                ...options,
                model: OPENAI_LIVE_TRANSCRIPTION_MODEL,
                apiKey: process.env.OPENAI_API_KEY as string,
                detector: detectors(),
              })
            : createSonioxStream({
                ...options,
                model: SONIOX_REALTIME_MODEL,
                apiKey: process.env.SONIOX_API_KEY as string,
              });
        push = (frame) => handle.push(toInt16(frame));
        finish = () => handle.finish();
      }
      const started = Date.now();
      for (let at = 0; at < stream.length; at += FRAME) {
        push(stream.subarray(at, at + FRAME));
        const due = started + ((at + FRAME) * 1000) / MEETING_SAMPLE_RATE;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now())));
      }
      const audioEnded = Date.now();
      await finish();
      if (RECORD && route !== "local") {
        await mkdir(RECORD, { recursive: true });
        await writeFile(join(RECORD, `${route}-${language}.json`), JSON.stringify(log, null, 1));
      }
      const hypothesis = finals
        .sort((a, b) => a.startMs - b.startMs)
        .map((each) => each.text)
        .join(language === "zh" ? "" : " ");
      return {
        route,
        language,
        audioSeconds: Math.round(stream.length / (MEETING_SAMPLE_RATE / 10)) / 10,
        score: scoreOf(language, clips, hypothesis),
        behindAtEnd: Math.max(0, lastFinalAt - audioEnded) / 1000,
        lost,
        hypothesis,
      };
    }

    const results = await Promise.all(
      routes.flatMap((route) =>
        (["en", "zh", "mixed"] as const).map((language) => run(route, language)),
      ),
    );
    engine.close();

    const report = {
      date: new Date().toISOString(),
      clips: { en: en.length, zh: zh.length },
      models: {
        local: QWEN3_ASR_0_6B.name,
        openai: OPENAI_LIVE_TRANSCRIPTION_MODEL,
        soniox: SONIOX_REALTIME_MODEL,
      },
      loadAverage: loadavg().map((value) => Math.round(value * 10) / 10),
      results,
    };
    const out = join(process.cwd(), "eval", "results");
    await mkdir(out, { recursive: true });
    await writeFile(
      join(out, `transcription-routes-${report.date.slice(0, 10)}.json`),
      JSON.stringify(report, null, 2),
    );
    const label = { word: "WER", character: "CER", unit: "error" } as const;
    console.log(
      results
        .map(
          (result) =>
            `${result.route} ${result.language}: ${label[result.score.unit]} ${(result.score.rate * 100).toFixed(1)}% (${result.score.errors}/${result.score.total}), ${result.audioSeconds} s of audio, last line ${result.behindAtEnd.toFixed(1)} s after the audio ended${result.lost ? `, lost: ${result.lost}` : ""}`,
        )
        .join("\n"),
    );
    expect(results.every((result) => result.lost === null)).toBe(true);
  });
});
