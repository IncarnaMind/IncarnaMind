import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import type { SpeechSegment, Transcriber, TranscriptionModelFiles } from "../../src/core";
import { createTracks } from "../../src/core/meetings/tracks";
import { createFakeSpeechEngine } from "../../src/core/transcription/fake";
import {
  chooseModel,
  createTranscriptionModel,
  QWEN3_ASR_0_6B,
  SILERO_VAD,
  TRANSCRIPTION_MODELS,
  type TranscriptionModelDefinition,
  transcriptionModelFiles,
} from "../../src/core/transcription/model";
import {
  createSpeechHost,
  PARTIAL_EVERY_MS,
  type SpeechEngine,
  type VoiceDetector,
} from "../../src/core/transcription/speech";

import { createTempDataFolder } from "../helpers/core";
import { startModelServer } from "../helpers/embedding";
import { recordingLog } from "../helpers/log";
import { inProcessTranscriber } from "../helpers/transcription";

const RATE = 16_000;

/** A detector that hears speech exactly where the test says, in seconds. */
function scriptedDetector(speech: readonly [number, number][]): VoiceDetector {
  let position = 0;
  let kept: number[] = [];
  const ended: { start: number; samples: Float32Array }[] = [];
  const inSpeech = (at: number) => speech.find(([from, to]) => at >= from * RATE && at < to * RATE);
  let open: [number, number] | undefined;
  return {
    accept(samples) {
      for (const sample of samples) {
        const now = inSpeech(position);
        if (open && now !== open) {
          ended.push({ start: open[0] * RATE, samples: Float32Array.from(kept) });
          kept = [];
        }
        open = now;
        if (now) kept.push(sample);
        position++;
      }
    },
    speaking: () => open !== undefined,
    next: () => ended.shift() ?? null,
    flush() {
      if (open) ended.push({ start: open[0] * RATE, samples: Float32Array.from(kept) });
      open = undefined;
      kept = [];
    },
  };
}

/** A recognizer that says how long the speech it was given is: "4.0 s". */
const lengthEngine = (speech: readonly [number, number][]): SpeechEngine => ({
  detector: () => scriptedDetector(speech),
  recognizer: { decode: async (samples) => `${(samples.length / RATE).toFixed(1)} s` },
  close() {},
});

describe("Live text from VAD segments, decoded again as speech goes on", () => {
  test("speech in progress is decoded again every few seconds; its final text comes when it ends, as the same line", async () => {
    const segments: SpeechSegment[] = [];
    const progress: number[] = [];
    const host = createSpeechHost(lengthEngine([[1, 9]]), {
      segment: (segment) => segments.push(segment),
      progress: (_stream, doneMs) => progress.push(doneMs),
      failed: () => {},
    });
    // Ten seconds in 100 ms frames, as the capture sends them.
    for (let at = 0; at < 100; at++) {
      host.push("live", new Float32Array(RATE / 10));
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await host.finish("live");
    const partials = segments.filter((segment) => !segment.final);
    const finals = segments.filter((segment) => segment.final);
    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(partials.every((segment) => segment.id === 1)).toBe(true);
    // Each partial holds the speech so far: longer each time.
    const lengths = partials.map((segment) => segment.endMs - segment.startMs);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(lengths[1] as number).toBeGreaterThanOrEqual(
      (lengths[0] as number) + PARTIAL_EVERY_MS - 200,
    );
    expect(finals).toEqual([
      expect.objectContaining({
        stream: "live",
        id: 1,
        // From a quarter of a second before the detector heard it, as a word's first sound is often cut.
        startMs: 750,
        endMs: 9000,
        text: "8.3 s",
        final: true,
      }),
    ]);
    // Done up to where the speech started while it went on; all of it once its final text came.
    expect(progress).toContain(10_000);
    expect(Math.max(...progress.slice(0, 50))).toBeLessThanOrEqual(1000);
  });

  test("a stream dropped forgets what it hadn't decoded; another goes on", async () => {
    const segments: SpeechSegment[] = [];
    const host = createSpeechHost(
      lengthEngine([
        [0, 1],
        [2, 3],
      ]),
      {
        segment: (segment) => segments.push(segment),
        progress: () => {},
        failed: () => {},
      },
    );
    host.push("a", new Float32Array(4 * RATE));
    host.drop("a");
    host.push("b", new Float32Array(4 * RATE));
    await host.finish("b");
    await vi.waitFor(() => expect(segments.map((each) => each.stream)).toEqual(["b", "b"]));
  });

  test("a stream's final readings are told the words told for that stream; partial ones and other streams' are not (#1031)", async () => {
    const decoded: { stream: string; words: readonly string[] }[] = [];
    const segments: SpeechSegment[] = [];
    const host = createSpeechHost(
      {
        detector: () => scriptedDetector([[0, 4]]),
        recognizer: {
          decode: async (_samples, stream, words) => {
            decoded.push({ stream, words });
            return "Priya Raman";
          },
        },
        close() {},
      },
      { segment: (segment) => segments.push(segment), progress: () => {}, failed: () => {} },
    );
    host.words("a:microphone", ["Priya Raman", "星河科技"]);
    for (let at = 0; at < 50; at++) {
      host.push("a:microphone", new Float32Array(RATE / 10));
      host.push("a:system", new Float32Array(RATE / 10));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all([host.finish("a:microphone"), host.finish("a:system")]);
    const mine = decoded.filter((each) => each.stream === "a:microphone");
    const partials = segments.filter((each) => each.stream === "a:microphone" && !each.final);
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(mine.length).toBe(partials.length + 1);
    expect(mine.at(-1)?.words).toEqual(["Priya Raman", "星河科技"]);
    expect(mine.slice(0, -1).every((each) => each.words.length === 0)).toBe(true);
    const theirs = decoded.filter((each) => each.stream === "a:system");
    expect(theirs.length).toBeGreaterThanOrEqual(1);
    expect(theirs.every((each) => each.words.length === 0)).toBe(true);
  });

  test("final readings are told their words only while decoding, every stream counted, takes at most half the audio's time (#1031)", async () => {
    // 1.8 s of speech every 2 s; each second of speech takes `perSecond` seconds to read.
    const speech: [number, number][] = Array.from({ length: 20 }, (_, at) => [
      at * 2,
      at * 2 + 1.8,
    ]);
    const run = async (perSecond: number, sources: readonly string[]) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const told: Record<string, boolean[]> = {};
      const host = createSpeechHost(
        {
          detector: () => scriptedDetector(speech),
          recognizer: {
            decode: async (samples, stream, words) => {
              vi.setSystemTime(Date.now() + (samples.length / RATE) * perSecond * 1000);
              told[stream] = [...(told[stream] ?? []), words.length > 0];
              return "Priya Raman";
            },
          },
          close() {},
        },
        { segment: () => {}, progress: () => {}, failed: () => {} },
      );
      for (const source of sources) host.words(source, ["Priya Raman"]);
      for (let at = 0; at < 400; at++) {
        for (const source of sources) host.push(source, new Float32Array(RATE / 10));
        await new Promise((resolve) => setImmediate(resolve));
      }
      await Promise.all(sources.map((source) => host.finish(source)));
      vi.useRealTimers();
      return told;
    };

    // One stream read in 0.35 of its speech's time: about 0.32 of the audio's, told throughout.
    const alone = await run(0.35, ["call:microphone"]);
    expect(alone["call:microphone"]?.length).toBe(20);
    expect(alone["call:microphone"]?.every(Boolean)).toBe(true);

    // The microphone and the call's sound together: about 0.63, so after the first ten seconds
    // of each, no longer told.
    const both = await run(0.35, ["call:microphone", "call:system"]);
    expect(both["call:microphone"]?.slice(0, 4).every(Boolean)).toBe(true);
    expect(both["call:microphone"]?.slice(-5).some(Boolean)).toBe(false);
    expect(both["call:system"]?.slice(-5).some(Boolean)).toBe(false);
  });

  test("a stretch the engine can't read loses its text, and the stream goes on", async () => {
    const failures: string[] = [];
    const segments: SpeechSegment[] = [];
    let calls = 0;
    const host = createSpeechHost(
      {
        ...lengthEngine([
          [0, 1],
          [2, 3],
        ]),
        recognizer: {
          decode: async () => {
            calls++;
            if (calls === 1) throw new Error("bad audio");
            return "fine";
          },
        },
      },
      {
        segment: (segment) => segments.push(segment),
        progress: () => {},
        failed: (_s, m) => failures.push(m),
      },
    );
    host.push("live", new Float32Array(4 * RATE));
    await host.finish("live");
    expect(failures).toEqual(["bad audio"]);
    expect(segments.map((each) => each.text)).toEqual(["", "fine"]);
  });
});

/**
 * A streaming model that writes a word for each 300 ms it hears ("w1 w2 w3"). `msPerSecond`: how
 * long it takes, on the host's faked clock, for each second it hears; `fails`: it throws instead.
 */
function countingReader(options: { msPerSecond?: number; fails?: boolean } = {}) {
  const readings: { heardMs: number; ended: boolean }[] = [];
  const live = () => {
    const reading = { heardMs: 0, ended: false };
    readings.push(reading);
    const words = () =>
      Array.from({ length: Math.floor(reading.heardMs / 300) }, (_, at) => `w${at + 1}`).join(" ");
    return {
      hear(samples: Float32Array) {
        if (options.fails) throw new Error("The streaming model stopped.");
        const ms = (samples.length / RATE) * 1000;
        reading.heardMs += ms;
        if (options.msPerSecond) vi.setSystemTime(Date.now() + (ms / 1000) * options.msPerSecond);
        return words();
      },
      end() {
        reading.ended = true;
        return words();
      },
    };
  };
  return { live, readings };
}

/** Pushes `seconds` of audio in 100 ms frames, as the capture sends them, letting decodes run between. */
async function pushPaced(
  host: ReturnType<typeof createSpeechHost>,
  stream: string,
  seconds: number,
) {
  for (let at = 0; at < seconds * 10; at++) {
    host.push(stream, new Float32Array(RATE / 10));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("Live words from a streaming model (#2662)", () => {
  test("the words come as they are said, a little at a time, and the final reading gives the line", async () => {
    const segments: SpeechSegment[] = [];
    const decoded: number[] = [];
    const reader = countingReader();
    const host = createSpeechHost(
      {
        detector: () => scriptedDetector([[1, 4]]),
        recognizer: {
          decode: async (samples) => {
            decoded.push(samples.length / RATE);
            return "The launch moves to the eighteenth.";
          },
        },
        live: reader.live,
        close() {},
      },
      { segment: (segment) => segments.push(segment), progress: () => {}, failed: () => {} },
    );
    await pushPaced(host, "live", 6);
    await host.finish("live");

    const partials = segments.filter((segment) => !segment.final);
    // A word more for each 300 ms of speech, the first within half a second of it, never re-read.
    expect(partials[0]?.text).toBe("w1");
    expect((partials[0]?.endMs ?? 0) - 1000).toBeLessThanOrEqual(500);
    expect(partials.map((segment) => segment.text.split(" ").length)).toEqual(
      partials.map((_, at) => at + 1),
    );
    expect(partials.every((segment) => segment.id === 1 && segment.startMs === 700)).toBe(true);
    // The speech is decoded once, whole, for its final text: never again while it goes on.
    expect(decoded).toEqual([3.25]);
    expect(segments.filter((segment) => segment.final)).toEqual([
      expect.objectContaining({ id: 1, text: "The launch moves to the eighteenth.", final: true }),
    ]);
    expect(reader.readings).toEqual([expect.objectContaining({ ended: true })]);
  });

  test("a stretch's live words stay, with the next stretch's after them, until its final text comes", async () => {
    const segments: SpeechSegment[] = [];
    const waiting: (() => void)[] = [];
    const host = createSpeechHost(
      {
        detector: () =>
          scriptedDetector([
            [0, 1.2],
            [2, 3],
          ]),
        recognizer: {
          // Each final reading waits until the test lets it finish, as a slow one does.
          decode: () =>
            new Promise<string>((resolve) => waiting.push(() => resolve("First line."))),
        },
        live: countingReader().live,
        close() {},
      },
      { segment: (segment) => segments.push(segment), progress: () => {}, failed: () => {} },
    );
    await pushPaced(host, "live", 2.1);

    // The first stretch ended at 1.2 s; its final reading hasn't come, and the second is under way.
    expect(segments.at(-1)).toEqual(
      expect.objectContaining({ id: 1, text: "w1 w2 w3 w4 w1", final: false }),
    );
    waiting.shift()?.();
    await vi.waitFor(() =>
      expect(segments.slice(-2)).toEqual([
        expect.objectContaining({ id: 1, text: "First line.", final: true }),
        expect.objectContaining({ id: 2, text: "w1", final: false }),
      ]),
    );
    const finishing = host.finish("live");
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    waiting.shift()?.();
    await finishing;
    expect(segments.filter((segment) => segment.final).map((segment) => segment.id)).toEqual([
      1, 2,
    ]);
  });

  test("a streaming model that can't keep up hands the live words back to decoding the speech again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let readings = 0;
    // 2.8 s of speech every 3 s: each second it hears takes the model 0.6 s, more than it may.
    const speech: [number, number][] = Array.from({ length: 8 }, (_, at) => [at * 3, at * 3 + 2.8]);
    const reader = countingReader({ msPerSecond: 600 });
    const segments: SpeechSegment[] = [];
    const host = createSpeechHost(
      {
        detector: () => scriptedDetector(speech),
        recognizer: {
          decode: async () => {
            readings++;
            return "A line.";
          },
        },
        live: reader.live,
        close() {},
      },
      { segment: (segment) => segments.push(segment), progress: () => {}, failed: () => {} },
    );
    await pushPaced(host, "live", 24);
    await host.finish("live");
    vi.useRealTimers();

    // Read live until the first ten seconds showed it can't keep up; after them, never again.
    expect(reader.readings.length).toBe(4);
    expect(warn).toHaveBeenCalledWith(
      "Live words go back to reading the speech again: the streaming model can't keep up",
    );
    // The speech after is decoded again as it goes on, as well as once at its end.
    expect(segments.filter((segment) => segment.final)).toHaveLength(8);
    expect(readings).toBeGreaterThan(8);
    warn.mockRestore();
  });

  test("live words are tried again once no stream is open, so the next Meeting starts with them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = countingReader({ fails: true });
    const host = createSpeechHost(
      {
        ...lengthEngine([
          [0, 1],
          [2, 3],
        ]),
        live: reader.live,
      },
      { segment: () => {}, progress: () => {}, failed: () => {} },
    );
    await pushPaced(host, "meeting-1:microphone", 4);
    // It failed on the first stretch, so the second was read again instead.
    expect(reader.readings).toHaveLength(1);
    await host.finish("meeting-1:microphone");

    await pushPaced(host, "meeting-2:microphone", 1.5);
    expect(reader.readings).toHaveLength(2);
    warn.mockRestore();
  });

  test("a streaming model that fails leaves the stream going on, its live words read again instead", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const segments: SpeechSegment[] = [];
    const host = createSpeechHost(
      {
        ...lengthEngine([[0, 4]]),
        live: countingReader({ fails: true }).live,
      },
      { segment: (segment) => segments.push(segment), progress: () => {}, failed: () => {} },
    );
    await pushPaced(host, "live", 5);
    await host.finish("live");

    expect(warn).toHaveBeenCalledWith(
      "Live words go back to reading the speech again: the streaming model failed: The streaming model stopped.",
    );
    expect(segments.filter((segment) => !segment.final).map((segment) => segment.text)).toEqual([
      "2.6 s",
    ]);
    expect(segments.filter((segment) => segment.final).map((segment) => segment.text)).toEqual([
      "4.0 s",
    ]);
    warn.mockRestore();
  });
});

/** Sound at a speaking level, with 100 ms of quiet at each of `quietAt`, in seconds. */
function sound(seconds: number, quietAt: readonly number[] = [], speech = [0, seconds]) {
  const samples = new Float32Array(seconds * RATE);
  samples.fill(0.3, (speech[0] as number) * RATE, (speech[1] as number) * RATE);
  for (const at of quietAt) samples.fill(0, at * RATE, (at + 0.1) * RATE);
  return samples;
}

/** Pushes `samples` in 100 ms frames, as the capture sends them, letting decodes run between. */
async function pushSound(host: ReturnType<typeof createSpeechHost>, samples: Float32Array) {
  for (let at = 0; at < samples.length; at += RATE / 10) {
    host.push("live", samples.subarray(at, at + RATE / 10));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const words = (count: number) => Array.from({ length: count }, (_, at) => `w${at + 1}`).join(" ");

describe("Speech longer than the engine reads at once (#1031)", () => {
  // protects=speech that goes on past what the engine reads at once is cut as it goes on, at its quietest 100 ms in the last 4 s before the limit, each part a line of its own from where the last ended, and the live words neither doubled nor lost at a cut; fails_when=a part runs past the limit, a cut lands outside the quiet, the parts overlap or leave a gap, the next part's live words repeat the words before the cut, or the parts come only once the speaker stops; no_claim=where a real voice is quietest, which eval/meetings measures.
  test("is cut at its quietest moment as it goes on, the live words kept in step", async () => {
    const segments: SpeechSegment[] = [];
    const host = createSpeechHost(
      {
        ...lengthEngine([[0.5, 30]]),
        recognizer: { decode: async (samples) => `${(samples.length / RATE).toFixed(2)} s` },
        live: countingReader().live,
        longestMs: 6000,
      },
      { segment: (segment) => segments.push(segment), progress: () => {}, failed: () => {} },
    );
    // Quiet at 1 s, too early to cut at, then at 4 s and 9 s.
    await pushSound(host, sound(12, [1, 4, 9]));
    const live = segments.filter((segment) => segment.final).length;
    await host.finish("live");

    expect(segments.filter((segment) => segment.final)).toEqual([
      expect.objectContaining({ id: 1, startMs: 200, endMs: 4050, text: "3.85 s" }),
      expect.objectContaining({ id: 2, startMs: 4050, endMs: 9050, text: "5.00 s" }),
      expect.objectContaining({ id: 3, startMs: 9050, endMs: 12_000, text: "2.95 s" }),
    ]);
    // The first two came while the speaker went on.
    expect(live).toBe(2);
    const first = segments.findIndex((segment) => segment.final);
    // Before the cut, 5.9 s heard: 19 words. After it, the 3.8 s heard up to the cut and the
    // 2.15 s heard again from it: 19 words still, the first part's until its line comes.
    expect(segments.slice(first - 2, first + 2)).toEqual([
      expect.objectContaining({ id: 1, text: words(19), final: false }),
      expect.objectContaining({ id: 1, text: `${words(12)} ${words(7)}`, final: false }),
      expect.objectContaining({ id: 1, text: "3.85 s", final: true }),
      expect.objectContaining({ id: 2, text: words(7), final: false }),
    ]);
  });

  // protects=a stretch whose sound comes all at once, as a recording read back after Stop comes 20 s at a time, is read in parts no longer than the engine reads at once, whether the detector says it is speaking as it goes or gives the stretch whole at its end; fails_when=a reading runs past the limit, or the parts overlap, leave a gap or lose the stretch's start; no_claim=live words, which a recording read back has none of.
  test.each([
    ["as it goes on", (speech: [number, number][]) => scriptedDetector(speech)],
    [
      "given whole at its end",
      (speech: [number, number][]) => ({ ...scriptedDetector(speech), speaking: () => false }),
    ],
  ])("that comes 20 s at a time is read in parts, the stretch %s", async (_how, detector) => {
    const finals: SpeechSegment[] = [];
    const host = createSpeechHost(
      { ...lengthEngine([]), detector: () => detector([[1, 19]]), longestMs: 6000 },
      {
        segment: (segment) => {
          if (segment.final) finals.push(segment);
        },
        progress: () => {},
        failed: () => {},
      },
    );
    host.push("live", new Float32Array(20 * RATE));
    await host.finish("live");

    expect(finals.length).toBeGreaterThanOrEqual(4);
    for (const [at, line] of finals.entries()) {
      expect(line.endMs - line.startMs).toBeLessThanOrEqual(6000);
      if (at > 0) expect(line.startMs).toBe(finals[at - 1]?.endMs);
    }
    expect(finals[0]?.startMs).toBeLessThanOrEqual(750);
    expect(finals.at(-1)?.endMs).toBe(19_000);
    expect(new Set(finals.map((line) => line.id)).size).toBe(finals.length);
  });

  // protects=when the detector ends a stretch half a second after its last sound, as Silero does, and the cut came in that half second, nothing is read twice and the part after the cut gets an empty final text, which drops its live words; fails_when=the quiet after the cut is read again as a line, or its live words stay shown with no line to replace them; no_claim=a stretch that goes on after the cut, which the test above covers.
  test("that ends just before a cut is read once, leaving no live words behind", async () => {
    const segments: SpeechSegment[] = [];
    const decoded: number[] = [];
    let position = 0;
    let ended = false;
    // Speech from 0.5 s to 6 s, its stretch ended at 6.6 s.
    const detector: VoiceDetector = {
      accept: (samples) => {
        position += samples.length;
      },
      speaking: () => !ended && position > 0.5 * RATE,
      next: () => {
        if (ended || position < 6.6 * RATE) return null;
        ended = true;
        return { start: 0.5 * RATE, samples: new Float32Array(5.5 * RATE) };
      },
      flush: () => {},
    };
    const host = createSpeechHost(
      {
        detector: () => detector,
        recognizer: {
          decode: async (samples) => {
            decoded.push(samples.length / RATE);
            return "The launch moves.";
          },
        },
        live: countingReader().live,
        longestMs: 6000,
        close() {},
      },
      { segment: (segment) => segments.push(segment), progress: () => {}, failed: () => {} },
    );
    await pushSound(host, sound(8, [], [0.5, 6]));
    await host.finish("live");

    // Cut at 6.15 s, in the quiet after the speech; nothing after it is read.
    expect(decoded).toEqual([5.95]);
    expect(segments.filter((segment) => segment.final)).toEqual([
      expect.objectContaining({ id: 1, startMs: 200, endMs: 6150, text: "The launch moves." }),
      expect.objectContaining({ id: 2, text: "" }),
    ]);
    // The streaming model heard a word in the quiet after the cut; the empty line drops it.
    expect(segments.slice(-2)).toEqual([
      expect.objectContaining({ id: 2, text: "w1", final: false }),
      expect.objectContaining({ id: 2, text: "", final: true }),
    ]);
  });

  // protects=a stream dropped while a cut part waits to be read gives no more lines; another stream goes on; fails_when=a dropped Meeting's part reaches the Transcript after it was dropped; no_claim=finishing halfway, which the first test does after its cuts.
  test("dropped halfway gives nothing more", async () => {
    const segments: SpeechSegment[] = [];
    const waiting: (() => void)[] = [];
    const host = createSpeechHost(
      {
        ...lengthEngine([[0.5, 30]]),
        recognizer: {
          decode: () => new Promise<string>((resolve) => waiting.push(() => resolve("A part."))),
        },
        live: countingReader().live,
        longestMs: 6000,
      },
      { segment: (segment) => segments.push(segment), progress: () => {}, failed: () => {} },
    );
    await pushSound(host, sound(7));
    expect(waiting).toHaveLength(1);
    host.drop("live");
    waiting.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(segments.filter((segment) => segment.final)).toEqual([]);
  });
});

describe("Speech whose words hold control characters (#981)", () => {
  test("is kept as one line of words, the stretch not marked as one the engine couldn't read", async () => {
    const segments: SpeechSegment[] = [];
    const failures: string[] = [];
    const said = ["The launch\nmoves to the\u0007 eighteenth.\t\n\nDone", "\n\u0001\n"];
    let decoded = 0;
    const host = createSpeechHost(
      {
        ...lengthEngine([
          [0, 2],
          [3, 5],
        ]),
        recognizer: { decode: async () => said[decoded++] ?? "" },
      },
      {
        segment: (segment) => segments.push(segment),
        progress: () => {},
        failed: (_stream, message) => failures.push(message),
      },
    );

    host.push("live", new Float32Array(6 * RATE));
    await host.finish("live");

    expect(failures).toEqual([]);
    const finals = segments.filter((segment) => segment.final);
    expect(finals.map((segment) => segment.text)).toEqual([
      "The launch moves to the eighteenth. Done",
      "",
    ]);
    expect(finals.some((segment) => segment.failed)).toBe(false);
  });
});

describe("The microphone and the computer's sound as two tracks", () => {
  const tone = (value: number, length: number) => new Int16Array(length).fill(value);

  test("each source is placed where it belongs in the Meeting's time, and both tracks go out together, a moment behind", () => {
    const tracks = createTracks(1000);
    // The computer's sound, 100 ms: held back a moment for the microphone.
    expect(tracks.add("system", tone(30_000, 1600), 1000)).toBeNull();
    // The microphone, from 50 ms in: what is 300 ms older than the newest goes out, in whole blocks.
    const out = tracks.add("microphone", tone(5000, 8000), 1050);
    expect(out?.atMs).toBe(1000);
    expect(out?.microphone?.length).toBe(3840);
    expect(out?.system?.length).toBe(3840);
    // Not summed: each keeps its own samples.
    expect([out?.microphone?.[0], out?.microphone?.[800], out?.microphone?.[1700]]).toEqual([
      0, 5000, 5000,
    ]);
    expect([out?.system?.[0], out?.system?.[1599], out?.system?.[1700]]).toEqual([
      30_000, 30_000, 0,
    ]);
    const rest = tracks.flush();
    expect(rest?.atMs).toBe(1240);
    expect(rest?.microphone?.length).toBe(4960);
    expect(rest?.system?.length).toBe(4960);
    // Samples later than what has gone out go to disk only.
    expect(tracks.add("microphone", tone(5, 160), 1000)).toBeNull();
    expect(tracks.flush()).toBeNull();
  });

  test("a Meeting in a room, whose computer sound never comes, has the microphone's track only", () => {
    const tracks = createTracks(0);
    const out = tracks.add("microphone", tone(4000, 16_000), 0);
    expect(out?.microphone?.length).toBeGreaterThan(0);
    expect(out?.system).toBeNull();
    expect(tracks.flush()?.system).toBeNull();
  });

  test("the computer's sound that comes later gives a track from where it comes", () => {
    const tracks = createTracks(0);
    expect(tracks.add("microphone", tone(4000, 16_000), 0)?.system).toBeNull();
    const later = tracks.add("system", tone(3000, 16_000), 1000);
    tracks.add("microphone", tone(4000, 16_000), 1000);
    const next = tracks.flush() ?? later;
    expect(next?.system).not.toBeNull();
  });

  test("a paused microphone has no track, not even silence, while the computer's sound goes on", () => {
    const tracks = createTracks(0);
    const before = [
      tracks.add("system", tone(3000, 16_000), 0),
      tracks.add("microphone", tone(5000, 16_000), 0),
      // What the microphone heard goes out at once, its last: nothing more is waited for.
      tracks.pauseMicrophone(1000),
    ].filter((each) => each !== null);
    expect(before.reduce((sum, each) => sum + (each.microphone?.length ?? 0), 0)).toBe(16_000);
    expect(before.reduce((sum, each) => sum + (each.system?.length ?? 0), 0)).toBe(16_000);

    const during = [
      tracks.add("system", tone(3000, 16_000), 1000),
      tracks.add("system", tone(3000, 16_000), 2000),
      tracks.flush(),
    ].filter((each) => each !== null);
    expect(during.length).toBeGreaterThan(0);
    expect(during.map((each) => each.microphone)).toEqual(during.map(() => null));
    expect(during.reduce((sum, each) => sum + (each.system?.length ?? 0), 0)).toBe(32_000);
    expect(during.every((each) => each.lengthMs > 0)).toBe(true);
  });

  test("a microphone resumed after a long pause with nothing else playing carries on from there", () => {
    const tracks = createTracks(0);
    tracks.add("microphone", tone(5000, 16_000), 0);
    tracks.pauseMicrophone(1000);
    expect(tracks.atMs).toBe(1000);

    // Ten minutes on: no block holds the pause, and the first one starts where the microphone does.
    expect(tracks.resumeMicrophone(600_000)).toBeNull();
    expect(tracks.atMs).toBe(600_000);
    const first = [tracks.add("microphone", tone(7000, 16_000), 600_000), tracks.flush()].filter(
      (each) => each !== null,
    );
    expect(first[0]?.atMs).toBe(600_000);
    expect(first.reduce((sum, each) => sum + (each.microphone?.length ?? 0), 0)).toBe(16_000);
    expect(first[0]?.microphone?.[0]).toBe(7000);
  });

  test("what came while paused goes out without the microphone's track, and the track starts again at resume", () => {
    const tracks = createTracks(0);
    tracks.add("microphone", tone(5000, 8000), 0);
    tracks.add("system", tone(3000, 8000), 0);
    tracks.pauseMicrophone(500);
    tracks.add("system", tone(3000, 16_000), 500);
    const waiting = tracks.resumeMicrophone(1500);
    expect(waiting?.microphone).toBeNull();
    expect(waiting?.system).not.toBeNull();

    const after = [
      tracks.add("microphone", tone(6000, 16_000), 1500),
      tracks.add("system", tone(3000, 16_000), 1500),
      tracks.flush(),
    ].filter((each) => each !== null);
    expect(after.every((each) => each.microphone !== null)).toBe(true);
    expect(after[0]?.atMs).toBeGreaterThanOrEqual(1500);
    expect(after.reduce((sum, each) => sum + (each.microphone?.length ?? 0), 0)).toBe(16_000);
  });
});

describe("Downloading the speech models", () => {
  /** A transcriber that only keeps the files it was asked to load. */
  function loadingTranscriber() {
    const loaded: TranscriptionModelFiles[] = [];
    const transcriber: Transcriber = {
      load: async (files) => {
        loaded.push(files);
      },
      words: () => {},
      push: () => {},
      finish: async () => {},
      drop: () => {},
      dropCloud: async () => {},
      open: () => {},
      listen: () => {},
      close: () => {},
    };
    return { loaded, transcriber };
  }

  async function servers() {
    return {
      model: await startModelServer({ "decoder.onnx": 3000 }),
      vad: await startModelServer({ "vad.onnx": 100 }),
      live: await startModelServer({ "encoder.onnx": 600 }),
    };
  }

  test("the streaming model downloads with the speech model, its size counted with theirs, and loads with it", async () => {
    const dataDir = await createTempDataFolder();
    const served = await servers();
    const { loaded, transcriber } = loadingTranscriber();
    const model = createTranscriptionModel({
      dataDir,
      transcriber,
      source: { model: served.model.source, vad: served.vad.source, live: served.live.source },
      speed: () => ({}),
      emitStatus: () => {},
      log: recordingLog().log,
    });
    expect(model.status()).toEqual(
      expect.objectContaining({ state: "not-downloaded", totalBytes: 3700 }),
    );

    model.ensure();
    await vi.waitFor(() => expect(model.status().state).toBe("ready"));
    expect(await model.load()).toBe(true);
    expect(loaded[0]?.live?.files.encoder).toContain(
      join("models", "streaming-zipformer-zh-en-int8", "encoder-epoch-99-avg-1.int8.onnx"),
    );
    model.close();
  });

  test("where the speech model is here from before, it transcribes at once, and the streaming model follows for the next Meeting", async () => {
    const dataDir = await createTempDataFolder();
    const served = await servers();
    const before = createTranscriptionModel({
      dataDir,
      transcriber: loadingTranscriber().transcriber,
      source: { model: served.model.source, vad: served.vad.source },
      speed: () => ({}),
      emitStatus: () => {},
      log: recordingLog().log,
    });
    before.ensure();
    await vi.waitFor(() => expect(before.status().state).toBe("ready"));
    before.close();

    const { loaded, transcriber } = loadingTranscriber();
    const model = createTranscriptionModel({
      dataDir,
      transcriber,
      source: { model: served.model.source, vad: served.vad.source, live: served.live.source },
      speed: () => ({}),
      emitStatus: () => {},
      log: recordingLog().log,
    });
    expect(model.status().state).toBe("ready");
    expect(await model.load()).toBe(true);
    expect(loaded[0]?.live).toBeUndefined();

    model.ensure();
    expect(model.status().state).toBe("ready");
    await vi.waitFor(async () => {
      expect(await model.load()).toBe(true);
      expect(loaded.at(-1)?.live?.engine).toBe("streaming-transducer");
    });
    expect(served.model.requests).toHaveLength(1);
    model.close();
  });

  test("on a first download, a streaming model that can't be downloaded doesn't hold up the speech model", async () => {
    const dataDir = await createTempDataFolder();
    const served = await servers();
    served.live.behave("encoder.onnx", { corrupt: true });
    const { log, entries } = recordingLog();
    const { loaded, transcriber } = loadingTranscriber();
    const model = createTranscriptionModel({
      dataDir,
      transcriber,
      source: { model: served.model.source, vad: served.vad.source, live: served.live.source },
      speed: () => ({}),
      emitStatus: () => {},
      log,
    });
    model.ensure();
    await vi.waitFor(() => expect(model.status().state).toBe("ready"));
    expect(model.status().error).toBeNull();
    expect(entries.map((entry) => entry.event)).toContain("transcription.liveModelDownload");
    expect(await model.load()).toBe(true);
    expect(loaded[0]?.live).toBeUndefined();
    model.close();
  });

  test("a streaming model that can't be downloaded leaves transcription as it was, and says why in the log", async () => {
    const dataDir = await createTempDataFolder();
    const served = await servers();
    served.live.behave("encoder.onnx", { corrupt: true });
    const before = createTranscriptionModel({
      dataDir,
      transcriber: loadingTranscriber().transcriber,
      source: { model: served.model.source, vad: served.vad.source },
      speed: () => ({}),
      emitStatus: () => {},
      log: recordingLog().log,
    });
    before.ensure();
    await vi.waitFor(() => expect(before.status().state).toBe("ready"));
    before.close();

    const { log, entries } = recordingLog();
    const { loaded, transcriber } = loadingTranscriber();
    const model = createTranscriptionModel({
      dataDir,
      transcriber,
      source: { model: served.model.source, vad: served.vad.source, live: served.live.source },
      speed: () => ({}),
      emitStatus: () => {},
      log,
    });
    model.ensure();
    await vi.waitFor(() =>
      expect(entries.map((entry) => entry.event)).toContain("transcription.liveModelDownload"),
    );
    expect(model.status()).toEqual(expect.objectContaining({ state: "ready", error: null }));
    expect(await model.load()).toBe(true);
    expect(loaded[0]?.live).toBeUndefined();
    model.close();
  });
});

describe("The speech models' licences", () => {
  test("ship with the app, naming each model it downloads to transcribe on this computer", () => {
    const notice = readFileSync(
      fileURLToPath(new URL("../../resources/notices/speech-models.txt", import.meta.url)),
      "utf8",
    );
    const sources = TRANSCRIPTION_MODELS.flatMap((model) => [
      model.source,
      ...(model.live ? [model.live.source] : []),
    ]).concat(SILERO_VAD.source);
    for (const source of sources) {
      const repository = new URL(source.baseUrl).pathname.split("/resolve/")[0] as string;
      expect(notice).toContain(`https://huggingface.co${repository}`);
    }
    expect(notice).toContain("Apache License");
    expect(notice).toContain("MIT License");
  });
});

describe("Choosing the speech model", () => {
  const smaller: TranscriptionModelDefinition = {
    ...QWEN3_ASR_0_6B,
    id: "smaller",
    memoryBytes: 500_000_000,
  };
  const models = [QWEN3_ASR_0_6B, smaller];
  const memory = { freeBytes: 8e9, totalBytes: 32e9 };

  test("the best one with the memory to run, unless it didn't keep up here last time", () => {
    expect(chooseModel(models, memory, {}).id).toBe(QWEN3_ASR_0_6B.id);
    expect(chooseModel(models, { freeBytes: 0.3e9, totalBytes: 4e9 }, {}).id).toBe("smaller");
    expect(chooseModel(models, memory, { [QWEN3_ASR_0_6B.id]: 1.4 }).id).toBe("smaller");
    expect(chooseModel(models, memory, { [QWEN3_ASR_0_6B.id]: 0.5 }).id).toBe(QWEN3_ASR_0_6B.id);
    // Too little memory for any: the smallest.
    expect(chooseModel(models, { freeBytes: 0.1e9, totalBytes: 1e9 }, {}).id).toBe("smaller");
  });
});

describe("The speech models leave memory when no Meeting needs them (#2673)", () => {
  /** Speech the fake engine hears: a second of sound above its whisper. */
  const speech = () => new Int16Array(RATE).fill(3000);
  const turn = (count = 1) =>
    Promise.all(
      Array.from({ length: count }, () => new Promise((resolve) => setImmediate(resolve))),
    );

  function countingEngine() {
    const counts = { built: 0, closed: 0, detectors: 0 };
    const build = async (): Promise<SpeechEngine> => {
      counts.built++;
      const engine = createFakeSpeechEngine();
      return {
        ...engine,
        detector: () => {
          counts.detectors++;
          return engine.detector();
        },
        close: () => {
          counts.closed++;
        },
      };
    };
    return { counts, build };
  }

  test("the engine is unloaded once the idle wait passes, and a load after that builds it again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { counts, build } = countingEngine();
      let unloaded = 0;
      const { transcriber } = inProcessTranscriber({}, build, undefined, {
        idleMs: 60_000,
        unloaded: () => {
          unloaded++;
        },
      });
      const segments: SpeechSegment[] = [];
      transcriber.listen({
        segment: (segment) => segments.push(segment),
        progress: () => {},
        failed: () => {},
        stopped: () => {},
        unloaded: () => {},
        switched: () => {},
        lost: () => {},
        opened: () => {},
      });
      const files = transcriptionModelFiles(await createTempDataFolder(), QWEN3_ASR_0_6B);

      await transcriber.load(files);
      transcriber.push("meeting:microphone", speech());
      await transcriber.finish("meeting:microphone");
      expect(segments.filter((segment) => segment.final)).toHaveLength(1);
      expect({ ...counts, unloaded }).toEqual({ built: 1, closed: 0, detectors: 1, unloaded: 0 });

      await vi.advanceTimersByTimeAsync(60_000);
      expect({ ...counts, unloaded }).toEqual({ built: 1, closed: 1, detectors: 1, unloaded: 1 });

      await transcriber.load(files);
      expect(counts.built).toBe(2);
      transcriber.push("meeting:microphone", speech());
      await transcriber.finish("meeting:microphone");
      expect(segments.filter((segment) => segment.final)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("nothing is unloaded while a stream is open, however long it stays open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { counts, build } = countingEngine();
      let unloaded = 0;
      const { transcriber } = inProcessTranscriber({}, build, undefined, {
        idleMs: 60_000,
        unloaded: () => {
          unloaded++;
        },
      });
      const files = transcriptionModelFiles(await createTempDataFolder(), QWEN3_ASR_0_6B);

      await transcriber.load(files);
      transcriber.push("meeting:microphone", speech());
      await turn();
      expect(counts.detectors).toBe(1);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(unloaded).toBe(0);
      expect(counts.closed).toBe(0);

      await transcriber.finish("meeting:microphone");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(unloaded).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("nothing is unloaded while a cloud stream is open either", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { build } = countingEngine();
      let unloaded = 0;
      const { transcriber } = inProcessTranscriber({}, build, undefined, {
        idleMs: 60_000,
        unloaded: () => {
          unloaded++;
        },
      });
      const files = transcriptionModelFiles(await createTempDataFolder(), QWEN3_ASR_0_6B);

      await transcriber.load(files);
      transcriber.open("call:microphone", {
        service: "soniox",
        model: "stt-rt-v4",
        apiKey: "test-key",
      });
      await turn();
      // The local stream finishes and the engine is idle, but a cloud stream is still open.
      transcriber.push("meeting:microphone", speech());
      await transcriber.finish("meeting:microphone");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(unloaded).toBe(0);

      transcriber.drop("call:microphone");
      await turn();
      // The socket's close may take a turn of its own before the idle wait starts.
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(unloaded).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an engine loaded for a Meeting that never sends audio is unloaded after the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { counts, build } = countingEngine();
      let unloaded = 0;
      const { transcriber } = inProcessTranscriber({}, build, undefined, {
        idleMs: 60_000,
        unloaded: () => {
          unloaded++;
        },
      });
      const files = transcriptionModelFiles(await createTempDataFolder(), QWEN3_ASR_0_6B);

      await transcriber.load(files);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(unloaded).toBe(1);
      expect(counts.closed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a drop for a stream that already finished starts the wait again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { build } = countingEngine();
      let unloaded = 0;
      const { transcriber } = inProcessTranscriber({}, build, undefined, {
        idleMs: 60_000,
        unloaded: () => {
          unloaded++;
        },
      });
      const files = transcriptionModelFiles(await createTempDataFolder(), QWEN3_ASR_0_6B);

      await transcriber.load(files);
      transcriber.push("meeting:microphone", speech());
      await transcriber.finish("meeting:microphone");
      // Its stream is gone, so the host changes nothing; the wait must still start again.
      transcriber.drop("meeting:microphone");
      await turn();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(unloaded).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("nothing is unloaded while the stretch after Stop is being read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const holding = Promise.withResolvers<void>();
      let reading = 0;
      let unloaded = 0;
      const build = async (): Promise<SpeechEngine> => {
        const engine = createFakeSpeechEngine();
        return {
          ...engine,
          recognizer: {
            async decode(samples, stream, words) {
              reading++;
              await holding.promise;
              return engine.recognizer.decode(samples, stream, words);
            },
          },
        };
      };
      const { transcriber } = inProcessTranscriber({}, build, undefined, {
        idleMs: 60_000,
        unloaded: () => {
          unloaded++;
        },
      });
      const files = transcriptionModelFiles(await createTempDataFolder(), QWEN3_ASR_0_6B);

      await transcriber.load(files);
      transcriber.push("meeting:microphone", speech());
      let finished = false;
      const finishing = transcriber.finish("meeting:microphone").finally(() => {
        finished = true;
      });
      await turn(2);
      expect(reading).toBe(1);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(unloaded).toBe(0);
      expect(finished).toBe(false);

      holding.resolve();
      await finishing;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(unloaded).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
