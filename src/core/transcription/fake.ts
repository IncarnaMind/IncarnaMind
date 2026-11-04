/**
 * A speech-to-text engine with no model, for the tests and the smoke tests
 * (#136): sound louder than a whisper is speech, cut into stretches of at
 * most two seconds, and each stretch says the next of its lines in turn: the
 * User's lines on the microphone's stream, the other side's on the computer
 * sound's (#941), with the names it mishears right only once it is told them.
 * Deterministic, and never a real model. It can be slow, fail
 * to read stretches, and say it failed over to another engine, for capture
 * health (#161).
 */
import { MEETING_SAMPLE_RATE } from "../adapters";
import type { TranscriberPort, TranscriberResponse } from "./channel";
import type { FakeCloudOptions } from "./fakeCloud";
import type { SpeechEngine, VoiceDetector } from "./speech";

export const FAKE_LINES: readonly string[] = [
  "Let's start with the launch date.",
  "The launch moves to the eighteenth of November.",
  "The payment provider's review won't be done before then.",
  "We keep the partner preview on the twenty-eighth of October.",
  "Marketing waits for the new date before announcing anything.",
  "I'll confirm the date with the payment provider by Friday.",
];

/** What the other side says, in turn: not a word of `FAKE_LINES`, so no line of theirs repeats one of the User's. */
export const FAKE_THEIR_LINES: readonly string[] = [
  "Thanks for making time today, everyone.",
  "Can you hear me clearly on your end?",
  "Dana is joining us from the Leeds office.",
  "Is there anything blocking the design review?",
  "Please send the notes round before the weekend.",
  "Good, let's pick this up again on Thursday.",
];

export interface FakeSpeechOptions {
  /** What each stretch of the microphone says, in turn, from the first again after the last. */
  lines?: readonly string[];
  /** What each stretch of the computer's sound says, in turn: `FAKE_THEIR_LINES` by default. */
  theirLines?: readonly string[];
  /** How long decoding takes, in ms. */
  decodeMs?: number;
  /** The longest stretch, in ms. */
  maxSpeechMs?: number;
  /** Decoding takes this many times as long as the speech decoded: over 1 is slower than real time. */
  realTimeFactor?: number;
  /** The decodes, counted from 1, that fail as a real engine's can: their stretches lose their text. */
  failing?: readonly number[];
  /** The engine can't start, for this reason: as a real one's JavaScript error says. */
  failToLoad?: string;
  /** Names it writes as these other words unless it was told them (#1031): { Dana: "Donna" }. */
  mishears?: Readonly<Record<string, string>>;
}

/** A transcriber that says it moved its streams to the cloud, and back, after so many lines each. */
export interface FakeFailover {
  /** After this many lines of a stream: this computer fell behind. */
  toCloudAfter: number;
  /** After this many lines of it: the cloud dropped. */
  backAfter?: number;
}

/** What the smoke tests ask of the fake transcriber (INCARNAMIND_TEST_TRANSCRIBER_OPTIONS). */
export interface FakeTranscriberOptions extends FakeSpeechOptions {
  failover?: FakeFailover;
  /** How the pretend cloud service behaves, for streams opened with one (#141). */
  cloud?: FakeCloudOptions;
}

/**
 * The serving end of a transcriber that fails over (#141, #462), with no
 * cloud: the same engine goes on, and only the switch is reported.
 */
export function failingOver(port: TranscriberPort, failover: FakeFailover): TranscriberPort {
  const lines = new Map<string, number>();
  return {
    onRequest: (listener) => port.onRequest(listener),
    respond(response: TranscriberResponse) {
      port.respond(response);
      if (response.type !== "segment" || !response.segment.final) return;
      const { stream } = response.segment;
      const count = (lines.get(stream) ?? 0) + 1;
      lines.set(stream, count);
      if (count === failover.toCloudAfter) {
        port.respond({
          type: "switched",
          change: { stream, from: "local", to: "cloud", reason: "behind" },
        });
      } else if (count === failover.backAfter) {
        port.respond({
          type: "switched",
          change: { stream, from: "cloud", to: "local", reason: "failed" },
        });
      }
    },
  };
}

/** 20 ms frames: one is speech when its level is above a whisper's. */
const FRAME = MEETING_SAMPLE_RATE / 50;
const LEVEL = 0.01;
/** Speech ends after this much quiet. */
const QUIET_FRAMES = 25;

export function createFakeSpeechEngine(options: FakeSpeechOptions = {}): SpeechEngine {
  if (options.failToLoad) throw new Error(options.failToLoad);
  const mine = options.lines ?? FAKE_LINES;
  const theirs = options.theirLines ?? FAKE_THEIR_LINES;
  const maxFrames = Math.round((options.maxSpeechMs ?? 2000) / 20);
  let said = 0;
  const saidBy = { mine: 0, theirs: 0 };

  const detector = (): VoiceDetector => {
    let position = 0;
    let waiting: number[] = [];
    let speech: { start: number; samples: number[]; quiet: number } | null = null;
    const ended: { start: number; samples: Float32Array }[] = [];
    const end = () => {
      if (!speech) return;
      const kept = speech.samples.slice(0, speech.samples.length - speech.quiet * FRAME);
      if (kept.length > 0) ended.push({ start: speech.start, samples: Float32Array.from(kept) });
      speech = null;
    };
    const frame = (samples: number[]) => {
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const loud = Math.sqrt(sum / samples.length) > LEVEL;
      if (loud && !speech) speech = { start: position, samples: [], quiet: 0 };
      if (speech) {
        speech.samples.push(...samples);
        speech.quiet = loud ? 0 : speech.quiet + 1;
        if (speech.quiet >= QUIET_FRAMES || speech.samples.length >= maxFrames * FRAME) end();
      }
      position += samples.length;
    };
    return {
      accept(samples) {
        for (const sample of samples) {
          waiting.push(sample);
          if (waiting.length === FRAME) {
            frame(waiting);
            waiting = [];
          }
        }
      },
      speaking: () => speech !== null,
      next: () => ended.shift() ?? null,
      flush() {
        if (waiting.length > 0) frame(waiting);
        waiting = [];
        end();
      },
    };
  };

  return {
    detector,
    recognizer: {
      async decode(samples, stream, words) {
        const ms = options.realTimeFactor
          ? ((samples.length * 1000) / MEETING_SAMPLE_RATE) * options.realTimeFactor
          : options.decodeMs;
        if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
        const theirSound = stream.endsWith(":system");
        const lines = theirSound ? theirs : mine;
        const line = lines[saidBy[theirSound ? "theirs" : "mine"]++ % lines.length] ?? "";
        said++;
        if (options.failing?.includes(said)) throw new Error("The fake engine can't read this.");
        return Object.entries(options.mishears ?? {}).reduce(
          (text, [name, heard]) => (words.includes(name) ? text : text.replaceAll(name, heard)),
          line,
        );
      },
    },
    close() {},
  };
}
