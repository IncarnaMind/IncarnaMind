import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AudioSource, SpeechSegment } from "../../src/core";
import { readVtt } from "../../src/core/documents/formats/vtt";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { createFakeSpeechEngine } from "../../src/core/transcription/fake";
import {
  createSpeechHost,
  type SpeechEngine,
  type VoiceDetector,
} from "../../src/core/transcription/speech";
import { createTempDataFolder } from "../helpers/core";
import { transcribingCore, transcriptOf, until } from "../helpers/transcription";

const RATE = 16_000;
const SECOND = 1000;
const STEP = 500;

type Speaking = { microphone?: boolean; system?: boolean };

/**
 * The fake engine as one that reads at most 15 s at once (as Qwen3-ASR does since #2908), or with
 * `cuts: false` one whose detector ends a stretch at 15 s and reads it whole. Each decode takes
 * `decodeMs` of the call's own time: it ends once that much more audio has been recorded after it
 * began, so a test sets how far behind the engine is to the half second, whatever the machine.
 */
function owingEngine(decodeMs: (audioMs: number) => number, { cuts = true } = {}) {
  const fake = createFakeSpeechEngine({
    maxSpeechMs: cuts ? 120 * SECOND : 15 * SECOND,
    live: true,
  });
  const heard: { samples: number }[] = [];
  let waiting: { at: number; done: () => void }[] = [];
  let recordedMs = 0;
  let instant = false;
  const engine: SpeechEngine = {
    ...fake,
    ...(cuts && { longestMs: 15 * SECOND }),
    detector(): VoiceDetector {
      const inner = fake.detector();
      const counted = { samples: 0 };
      heard.push(counted);
      return {
        ...inner,
        accept(samples) {
          counted.samples += samples.length;
          inner.accept(samples);
        },
      };
    },
    recognizer: {
      decode: (samples, stream, words) =>
        new Promise<string>((resolve) => {
          const done = () => resolve(fake.recognizer.decode(samples, stream, words));
          if (instant) done();
          else waiting.push({ at: recordedMs + decodeMs((samples.length / RATE) * SECOND), done });
        }),
    },
  };
  return {
    engine,
    /** `ms` more of the call has been recorded: the decodes due by then end. */
    advance(ms: number) {
      recordedMs += ms;
      const due = waiting.filter((each) => each.at <= recordedMs);
      waiting = waiting.filter((each) => each.at > recordedMs);
      for (const each of due) each.done();
    },
    /** Every decode from now on ends at once, as after Stop nothing more is recorded. */
    finishAll() {
      instant = true;
      for (const each of waiting) each.done();
      waiting = [];
    },
    /** Whether the transcription process has heard this much of the call, less the tracks' wait. */
    caughtUp: () => heard.some((each) => each.samples >= ((recordedMs - 400) * RATE) / SECOND),
    where: () =>
      `${recordedMs} ms recorded, heard ${heard.map((each) => (each.samples * SECOND) / RATE).join(", ")}`,
  };
}

/**
 * A Meeting recording through the core with the owing engine. `play` records the call 0.5 s at a
 * time, each source speaking (the fake capture's tone) or quiet, and returns where in the call
 * live text first fell behind, or null.
 */
async function owingCall(owing: ReturnType<typeof owingEngine>) {
  const dataDir = await createTempDataFolder();
  const recording = await transcribingCore(dataDir, { engineFactory: async () => owing.engine });
  const { core, capture, clock } = recording;
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id });
  await until(core, meeting.id, (transcript) => transcript.state === "live");
  let playedMs = 0;
  let behindAt: number | null = null;
  return {
    ...recording,
    dataDir,
    meetingId: meeting.id,
    async play(ms: number, speaking: Speaking) {
      for (let at = 0; at < ms; at += STEP) {
        clock.advance(STEP);
        capture.push("microphone", STEP, !speaking.microphone);
        capture.push("system", STEP, !speaking.system);
        playedMs += STEP;
        // Live text that fell behind sends the engine nothing more.
        await vi.waitFor(
          async () => {
            if (owing.caughtUp()) return;
            if ((await transcriptOf(core, meeting.id)).state === "behind") return;
            throw new Error(`The audio hasn't reached the engine yet: ${owing.where()}`);
          },
          { timeout: 5 * SECOND, interval: 1 },
        );
        owing.advance(STEP);
        for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
        if (behindAt === null && (await transcriptOf(core, meeting.id)).state === "behind") {
          behindAt = playedMs;
        }
      }
      return behindAt;
    },
    async stopAndRead() {
      owing.finishAll();
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      return readVtt(readFileSync(saved.savedPath as string, "utf8"));
    },
  };
}

const BOTH: Speaking = { microphone: true, system: true };
const ME: Speaking = { microphone: true };
const THEM: Speaking = { system: true };
const QUIET: Speaking = {};

describe("Live text is behind only by what the engine owes (#2902)", { timeout: 60_000 }, () => {
  test("both sides talking for 15 s on a computer that decodes at 0.85 of real time: live text stays up", async () => {
    const owing = owingEngine((audioMs) => audioMs * 0.85);
    const call = await owingCall(owing);
    // Each side's first 15 s is read at once, one after the other: the second's line comes 40.4 s
    // into the call, 25.4 s after it was read and 40.4 s after its speech began.
    expect(await call.play(15 * SECOND, BOTH)).toBeNull();
    expect(await call.play(30 * SECOND, ME)).toBeNull();
    const transcript = await transcriptOf(call.core, call.meetingId);
    expect(transcript.state).toBe("live");
    const { cues } = await call.stopAndRead();
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
  });

  test("the same call on an engine that reads each stretch whole keeps today's rule, and falls behind", async () => {
    const owing = owingEngine((audioMs) => audioMs * 0.85, { cuts: false });
    const call = await owingCall(owing);
    await call.play(15 * SECOND, BOTH);
    const behindAt = await call.play(30 * SECOND, ME);
    expect(behindAt).toBeGreaterThanOrEqual(30 * SECOND);
    expect(behindAt).toBeLessThanOrEqual(32 * SECOND);
  });

  test("a computer that decodes at 1.5 times real time still falls behind within a minute, and the Transcript after Stop holds every stretch", async () => {
    const owing = owingEngine((audioMs) => audioMs * 1.5);
    const call = await owingCall(owing);
    const behindAt = await call.play(60 * SECOND, BOTH);
    expect(behindAt).not.toBeNull();
    expect(behindAt).toBeLessThanOrEqual(60 * SECOND);
    const { cues } = await call.stopAndRead();
    expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(["Me", "Them"]));
    for (const speaker of ["Me", "Them"]) {
      const theirs = cues.filter((cue) => cue.speaker === speaker);
      expect(theirs[0]?.startMs).toBeLessThanOrEqual(1 * SECOND);
      expect(theirs.at(-1)?.endMs).toBeGreaterThanOrEqual(59 * SECOND);
    }
  });

  test.each([
    [25, null],
    [31, 46],
  ] as const)(
    "a 15 s turn whose line takes %i s once it is read: behind from %s s into the call",
    async (decodeSeconds, behindFrom) => {
      const owing = owingEngine((audioMs) => (audioMs > 10 * SECOND ? decodeSeconds * SECOND : 0));
      const call = await owingCall(owing);
      await call.play(15 * SECOND, THEM);
      const behindAt = await call.play(35 * SECOND, QUIET);
      if (behindFrom === null) expect(behindAt).toBeNull();
      else {
        expect(behindAt).toBeGreaterThanOrEqual(behindFrom * SECOND);
        expect(behindAt).toBeLessThanOrEqual((behindFrom + 1) * SECOND);
      }
    },
  );

  test("paused and resumed while a line is owed: live text stays up, and the line is in the Transcript", async () => {
    const owing = owingEngine((audioMs) => (audioMs > 10 * SECOND ? 25 * SECOND : 0));
    const call = await owingCall(owing);
    await call.play(15 * SECOND, THEM);
    await call.play(5 * SECOND, QUIET);
    await call.core.pauseMeeting(call.meetingId);
    owing.finishAll();
    await call.core.resumeMeeting(call.meetingId);
    await until(call.core, call.meetingId, (transcript) => transcript.state === "live");
    const { cues } = await call.stopAndRead();
    const theirs = cues.filter((cue) => cue.speaker === "Them");
    expect(theirs[0]?.startMs).toBeLessThanOrEqual(1 * SECOND);
    expect(theirs[0]?.endMs).toBeGreaterThanOrEqual(11 * SECOND);
  });

  test("the engine restarting while a line is owed: the stretch it lost is filled in after Stop", async () => {
    const owing = owingEngine((audioMs) => (audioMs > 10 * SECOND ? 25 * SECOND : 0));
    const call = await owingCall(owing);
    await call.play(15 * SECOND, THEM);
    await call.play(5 * SECOND, QUIET);
    owing.finishAll();
    call.engineHost.crash();
    await until(call.core, call.meetingId, (transcript) => transcript.state === "live");
    const { cues, gaps } = await call.stopAndRead();
    expect(gaps.filter((gap) => gap.reason === "restarted")).toEqual([]);
    expect(cues.filter((cue) => cue.speaker === "Them")[0]?.startMs).toBeLessThanOrEqual(SECOND);
  });

  test("Stopped while a line is owed: the line is in the Transcript", async () => {
    const owing = owingEngine((audioMs) => (audioMs > 10 * SECOND ? 25 * SECOND : 0));
    const call = await owingCall(owing);
    await call.play(15 * SECOND, THEM);
    await call.play(10 * SECOND, QUIET);
    const { cues } = await call.stopAndRead();
    const theirs = cues.filter((cue) => cue.speaker === "Them");
    expect(theirs[0]?.startMs).toBeLessThanOrEqual(1 * SECOND);
    expect(theirs[0]?.endMs).toBeGreaterThanOrEqual(11 * SECOND);
  });

  test("IncarnaMind closing while a line is owed: what live text owed is read once the Meeting stops", async () => {
    const owing = owingEngine((audioMs) => (audioMs > 10 * SECOND ? 25 * SECOND : 0));
    const call = await owingCall(owing);
    await call.play(15 * SECOND, THEM);
    await call.play(10 * SECOND, QUIET);
    call.core.close();
    // What is kept beside the Transcript says live text got no further than the owed line's start.
    const kept = JSON.parse(
      readFileSync(join(call.dataDir, "Transcripts", `${call.meetingId}.json`), "utf8"),
    );
    expect(kept.doneMs).toBeLessThanOrEqual(1 * SECOND);

    const second = await transcribingCore(call.dataDir);
    await second.core.stopMeeting(call.meetingId);
    const saved = await until(
      second.core,
      call.meetingId,
      (transcript) => transcript.state === "saved",
    );
    const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
    expect(cues[0]?.startMs).toBeLessThanOrEqual(1 * SECOND);
  });
});

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

describe("What the speech host says it owes (#2902)", () => {
  /** A host whose decodes wait until the test lets them end, reporting each stream's progress. */
  function heldHost(speech: readonly [number, number][], longestMs: number | undefined) {
    const held: (() => void)[] = [];
    const progress: { stream: string; doneMs: number; heardMs: number }[] = [];
    const segments: SpeechSegment[] = [];
    const engine: SpeechEngine = {
      detector: () => scriptedDetector(speech),
      // Live words from a streaming model, so no partial reading waits in the queue.
      live: () => ({ hear: () => "", end: () => "" }),
      ...(longestMs !== undefined && { longestMs }),
      recognizer: {
        decode: (samples) =>
          new Promise((resolve) => held.push(() => resolve(`${samples.length / RATE} s`))),
      },
      close() {},
    };
    const host = createSpeechHost(engine, {
      segment: (segment) => segments.push(segment),
      progress: (stream, doneMs, heardMs) => progress.push({ stream, doneMs, heardMs }),
      failed: () => {},
    });
    const push = async (stream: string, seconds: number) => {
      for (let at = 0; at < seconds * 10; at++) {
        host.push(stream, new Float32Array(RATE / 10));
        await Promise.resolve();
      }
    };
    const last = (stream: string) => progress.filter((each) => each.stream === stream).at(-1);
    return { host, held, progress, segments, push, last };
  }

  test("nothing while speech is said, then where the stream had got when its piece was read, until its line comes", async () => {
    const { held, push, last } = heldHost([[1, 25]], 15 * SECOND);
    await push("call", 10);
    // Ten seconds in, the turn started at 1 s is being said: nothing is owed, though nothing is final.
    expect(last("call")).toEqual({ stream: "call", doneMs: 700, heardMs: 10_000 });
    await push("call", 10);
    // Cut at 15.7 s (the turn's first 15 s, from 0.7 s), its piece read then and not yet final.
    expect(last("call")).toEqual({ stream: "call", doneMs: 700, heardMs: 15_700 });
    held.shift()?.();
    await vi.waitFor(() => expect(last("call")?.heardMs).toBe(20_000));
    expect(last("call")?.doneMs).toBe(15_650);
  });

  test("an engine that reads a stretch only once it ends owes all of it: what it heard is what is final", async () => {
    const { push, progress } = heldHost([[1, 25]], undefined);
    await push("call", 20);
    expect(progress.every((each) => each.heardMs === each.doneMs)).toBe(true);
    expect(progress.at(-1)).toEqual({ stream: "call", doneMs: 700, heardMs: 700 });
  });

  test("each stream says what it owes: one that owes nothing has heard all it was sent", async () => {
    const { push, last } = heldHost([[1, 25]], 15 * SECOND);
    await push("them", 20);
    await push("me", 20);
    expect(last("them")?.heardMs).toBe(15_700);
    expect(last("me")?.heardMs).toBe(15_700);
    const quiet = heldHost([], 15 * SECOND);
    await quiet.push("me", 20);
    expect(quiet.last("me")).toEqual({ stream: "me", doneMs: 20_000, heardMs: 20_000 });
  });

  test("what a stream owes is never more than what isn't final: heard is never short of done", async () => {
    const { held, push, progress } = heldHost(
      [
        [1, 25],
        [27, 31],
        [33, 52],
      ],
      15 * SECOND,
    );
    for (let at = 0; at < 6; at++) {
      await push("call", 10);
      held.shift()?.();
    }
    expect(progress.length).toBeGreaterThan(500);
    expect(progress.filter((each) => each.heardMs < each.doneMs)).toEqual([]);
  });
});

describe("A recorded call with both sides, as the test build plays it (#2902)", () => {
  test("each side plays its own recording on its own track, once, then silence", () => {
    const capture = createFakeCapture({
      recording: Int16Array.from([1, 2, 3, 4]),
      microphoneRecording: Int16Array.from([-1, -2]),
    });
    const heard: Record<AudioSource, number[]> = { microphone: [], system: [] };
    capture.start(
      { systemAudio: true },
      { audio: (source, samples) => heard[source].push(...samples), state: () => {} },
    );
    // 0.25 ms is four samples at 16 kHz.
    capture.push("microphone", 0.25);
    capture.push("system", 0.25);
    expect(heard).toEqual({ microphone: [-1, -2, 0, 0], system: [1, 2, 3, 4] });
  });
});
