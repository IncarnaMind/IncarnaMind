import { describe, expect, test, vi } from "vitest";
import type { SpeechSegment } from "../../src/core";
import { createTracks } from "../../src/core/meetings/tracks";
import {
  chooseModel,
  QWEN3_ASR_0_6B,
  type TranscriptionModelDefinition,
} from "../../src/core/transcription/model";
import {
  createSpeechHost,
  PARTIAL_EVERY_MS,
  type SpeechEngine,
  type VoiceDetector,
} from "../../src/core/transcription/speech";

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
