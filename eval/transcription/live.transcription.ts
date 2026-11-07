/**
 * Live words on this computer (#2662): how soon they come and how often they change, at the pace
 * speech is said, through the transcription process's own code (`createSpeechHost`,
 * `createSherpaEngine`). The FLEURS clips in English, in Chinese and the two taking turns, each a
 * stream fed in 100 ms frames at the pace it was spoken, one after the other.
 *
 * With the streaming model (two passes: its live words, Qwen3-ASR's finished lines), or with
 * INCARNAMIND_EVAL_LIVE=off without it, as before: the speech so far decoded again every 2.5 s.
 * Run each in a process of its own, so its memory is its own.
 *
 * For each clip, from where its speech starts (its first 10 ms louder than a tenth of its peak):
 * - first words: when the first live words of it are reported;
 * - updates: how often its live words change while it is said;
 * - finished: when its line is final, after its last sound.
 * And the error of the finished lines, and of the streaming model's own words for each stretch
 * (what streaming alone would give), with the process's CPU time and its largest memory.
 *
 * INCARNAMIND_EVAL_CLIPS: the folder fetch-fleurs.py wrote (required).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MEETING_SAMPLE_RATE, type SpeechSegment } from "../../src/core/adapters";
import { createSherpaEngine } from "../../src/core/transcription/sherpa";
import { createSpeechHost, type SpeechEngine } from "../../src/core/transcription/speech";
import {
  type Clip,
  clipsOf,
  evalModelFiles,
  FRAME,
  lastSoundOf,
  modelData,
  onsetOf,
  PAUSE_MS,
  samplesOf,
} from "./clips";
import { characters, type ErrorRate, errorRate, words } from "./scoring";

const CLIPS = process.env.INCARNAMIND_EVAL_CLIPS;
const RATE = MEETING_SAMPLE_RATE;

type Language = "en" | "zh" | "mixed";

interface Timing {
  median: number;
  p90: number;
  max: number;
}

interface LanguageResult {
  language: Language;
  clips: number;
  audioSeconds: number;
  /** Seconds from where a clip's speech starts to its first live words: `each`, in the clips' order. */
  firstWords: Timing & { clips: number; each: number[] };
  /** Seconds between changes of a clip's live words while it is said. */
  updates: Timing & { count: number };
  /** Seconds from a clip's last sound to its finished line. */
  finished: Timing;
  lines: ErrorRate & { unit: "word" | "character" | "unit" };
  /** The streaming model's own words, a stretch at a time: null without it. */
  liveOnly: (ErrorRate & { unit: "word" | "character" | "unit" }) | null;
  /** The process's CPU time over the audio's length. */
  cpuPerAudioSecond: number;
}

const timing = (values: readonly number[]): Timing => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) =>
    sorted.length === 0
      ? Number.NaN
      : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] as number);
  const round = (value: number) => Math.round(value * 100) / 100;
  return { median: round(at(0.5)), p90: round(at(0.9)), max: round(sorted.at(-1) ?? Number.NaN) };
};

/** Each English clip, then each Chinese one, taking turns. */
function takingTurns(en: readonly Clip[], zh: readonly Clip[]): Clip[] {
  const out: Clip[] = [];
  for (let i = 0; i < Math.max(en.length, zh.length); i++) {
    if (en[i]) out.push(en[i] as Clip);
    if (zh[i]) out.push(zh[i] as Clip);
  }
  return out;
}

function scoreOf(language: Language, clips: readonly Clip[], hypothesis: string) {
  const reference = clips.map((clip) => clip.reference).join(language === "zh" ? "" : " ");
  const split = language === "en" ? words : characters;
  const unit = language === "en" ? "word" : language === "zh" ? "character" : "unit";
  return { ...errorRate(split(reference), split(hypothesis)), unit } as const;
}

/** A clip placed in the stream: where it starts, where its speech starts and where its last sound ends, in seconds. */
interface Placed {
  from: number;
  onset: number;
  lastSound: number;
  to: number;
}

describe.runIf(CLIPS)("Live words on this computer", () => {
  test("first words, updates and finished lines, at the pace speech is said", async () => {
    const memory = { most: process.memoryUsage().rss };
    const sampling = setInterval(() => {
      memory.most = Math.max(memory.most, process.memoryUsage().rss);
    }, 250);
    const files = evalModelFiles(await modelData());
    const loadStarted = Date.now();
    const loaded = await createSherpaEngine(files);
    const loadSeconds = (Date.now() - loadStarted) / 1000;
    const loadedMemory = process.memoryUsage().rss;

    // The streaming model's readings, with when each stretch's words came: one reading a stretch.
    let readings: { startedAt: number; changes: { at: number; text: string }[]; end: string }[] =
      [];
    let started = 0;
    const live = loaded.live;
    const engine: SpeechEngine = live
      ? {
          ...loaded,
          live(stream) {
            const reading = live(stream);
            const kept = {
              startedAt: (performance.now() - started) / 1000,
              changes: [] as { at: number; text: string }[],
              end: "",
            };
            readings.push(kept);
            return {
              hear(samples) {
                const text = reading.hear(samples);
                if (text !== (kept.changes.at(-1)?.text ?? "")) {
                  kept.changes.push({ at: (performance.now() - started) / 1000, text });
                }
                return text;
              },
              end() {
                kept.end = reading.end();
                return kept.end;
              },
            };
          },
        }
      : loaded;

    const en = await clipsOf(CLIPS as string, "en");
    const zh = await clipsOf(CLIPS as string, "zh");
    const sets: Record<Language, Clip[]> = { en, zh, mixed: takingTurns(en, zh) };
    const results: LanguageResult[] = [];

    for (const language of ["en", "zh", "mixed"] as const) {
      const clips = sets[language];
      const pause = new Float32Array((RATE * PAUSE_MS) / 1000);
      const parts: Float32Array[] = [];
      const placed: Placed[] = [];
      let at = 0;
      for (const clip of clips) {
        const samples = await samplesOf(clip.file);
        at += pause.length;
        placed.push({
          from: at / RATE,
          onset: (at + onsetOf(samples)) / RATE,
          lastSound: (at + lastSoundOf(samples)) / RATE,
          to: (at + samples.length) / RATE,
        });
        parts.push(pause, samples);
        at += samples.length;
      }
      parts.push(pause);
      const stream = new Float32Array(at + pause.length);
      let offset = 0;
      for (const part of parts) {
        stream.set(part, offset);
        offset += part.length;
      }

      const reported: { at: number; segment: SpeechSegment }[] = [];
      readings = [];
      const host = createSpeechHost(engine, {
        segment: (segment) => reported.push({ at: (performance.now() - started) / 1000, segment }),
        progress: () => {},
        failed: (_stream, message) => console.error(`A stretch couldn't be decoded: ${message}`),
      });
      const cpu = process.cpuUsage();
      started = performance.now();
      for (let frame = 0; frame < stream.length; frame += FRAME) {
        host.push(language, stream.subarray(frame, frame + FRAME));
        const due = started + ((frame + FRAME) * 1000) / RATE;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - performance.now())));
      }
      await host.finish(language);
      const used = process.cpuUsage(cpu);

      // A stretch belongs to the clip its speech is heard in, from a little before the clip.
      const clipAt = (seconds: number) =>
        placed.findIndex((clip) => seconds >= clip.from - 0.6 && seconds < clip.to + 0.6);
      const firstWords: number[] = [];
      const updates: number[] = [];
      const finished: number[] = [];
      placed.forEach((clip, index) => {
        let changes: number[];
        if (live) {
          changes = readings
            .filter((reading) => clipAt(reading.startedAt) === index)
            .flatMap((reading) =>
              reading.changes.filter((change) => change.text).map((change) => change.at),
            );
        } else {
          changes = reported
            .filter(
              ({ segment }) =>
                !segment.final && segment.text && clipAt(segment.startMs / 1000) === index,
            )
            .map((each) => each.at);
        }
        const finals = reported.filter(
          ({ segment }) =>
            segment.final && segment.text && clipAt(segment.startMs / 1000) === index,
        );
        // Without live words, a clip's first words are its first text, partial or final.
        const first = Math.min(
          changes[0] ?? Number.POSITIVE_INFINITY,
          finals[0]?.at ?? Number.POSITIVE_INFINITY,
        );
        if (Number.isFinite(first)) firstWords.push(first - clip.onset);
        const during = changes.filter((each) => each <= clip.lastSound + 0.3);
        for (let i = 1; i < during.length; i++)
          updates.push((during[i] as number) - (during[i - 1] as number));
        const last = finals.at(-1);
        if (last) finished.push(last.at - clip.lastSound);
      });

      const joiner = language === "zh" ? "" : " ";
      const hypothesis = reported
        .filter(({ segment }) => segment.final)
        .map(({ segment }) => segment)
        .sort((a, b) => a.startMs - b.startMs)
        .map((segment) => segment.text)
        .join(joiner);
      const liveHypothesis = readings.map((reading) => reading.end).join(joiner);
      const audioSeconds = stream.length / RATE;
      results.push({
        language,
        clips: clips.length,
        audioSeconds: Math.round(audioSeconds * 10) / 10,
        firstWords: {
          ...timing(firstWords),
          clips: firstWords.length,
          each: firstWords.map((each) => Math.round(each * 100) / 100),
        },
        updates: { ...timing(updates), count: updates.length },
        finished: timing(finished),
        lines: scoreOf(language, clips, hypothesis),
        liveOnly: live ? scoreOf(language, clips, liveHypothesis) : null,
        cpuPerAudioSecond: Math.round(((used.user + used.system) / 1e6 / audioSeconds) * 100) / 100,
      });
    }
    clearInterval(sampling);
    loaded.close();

    const report = {
      date: new Date().toISOString(),
      passes: live
        ? "two passes: streaming live words, Qwen3-ASR finished lines"
        : "the speech so far decoded again",
      threads: files.threads,
      loadSeconds,
      memoryMB: { loaded: Math.round(loadedMemory / 1e6), most: Math.round(memory.most / 1e6) },
      loadAverage: loadavg().map((value) => Math.round(value * 10) / 10),
      results,
    };
    const out = join(process.cwd(), "eval", "results");
    await mkdir(out, { recursive: true });
    await writeFile(
      join(
        out,
        `transcription-live-${live ? "two-passes" : "again"}-${report.date.slice(0, 10)}.json`,
      ),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 1));
    expect(results.every((result) => result.firstWords.clips > 0)).toBe(true);
  });
});
