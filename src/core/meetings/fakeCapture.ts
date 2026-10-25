/**
 * An `AudioCapture` with no devices, for the tests and the smoke tests: the
 * microphone makes a 440 Hz tone, the computer's sound a quieter 660 Hz one
 * (or silence, or a recording played once, for checking transcription by
 * hand). The tests push audio by hand; the smoke tests' copy makes it in real
 * time (`realTime`). Never the real microphone.
 */
import {
  type AudioCapture,
  type AudioSink,
  type CaptureState,
  MEETING_SAMPLE_RATE,
} from "../adapters";
import type { AudioSource } from "../api";

export interface FakeCaptureOptions {
  /** This computer can record its own sound (true by default). */
  systemAudio?: boolean;
  /** What the computer's sound does when asked for: plays, is denied, or gives only silence. */
  system?: "allowed" | "denied" | "silent";
  /** What the microphone does when asked for: records (by default), or is denied. */
  microphone?: "allowed" | "denied";
  /** Makes audio by itself, as captured, every `realTime` ms. */
  realTime?: number;
  /** The computer's sound plays these samples once, then silence; the microphone is quiet meanwhile. */
  recording?: Int16Array;
  /** The clock its frames are stamped with, the one the core's `now` reads: `Date.now` by default. */
  now?: () => number;
}

/** A WAV file's samples: 16-bit PCM, mono, at `MEETING_SAMPLE_RATE`, as a recording to play. */
export function wavSamples(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (id === "data") {
      const body = bytes.slice(at + 8, at + 8 + size - (size % 2));
      return new Int16Array(body.buffer);
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("The recording has no audio.");
}

export interface FakeCapture extends AudioCapture {
  /** Sends `ms` of audio from a source while a capture runs. */
  push(source: AudioSource, ms: number): void;
  /** Reports a source's state while a capture runs. */
  report(source: AudioSource, state: CaptureState): void;
  /**
   * The default microphone changes: no samples for a moment, then the new
   * device's, as the desktop capture does.
   */
  changeDevice(pauseMs?: number): void;
  /** How many captures have started, and whether one runs now. */
  readonly started: number;
  readonly running: boolean;
  readonly microphoneOn: boolean;
  /** The sources the System Settings link was opened for. */
  readonly settingsOpened: readonly AudioSource[];
}

export function createFakeCapture(options: FakeCaptureOptions = {}): FakeCapture {
  const systemAudio = options.systemAudio ?? true;
  const system = options.system ?? "allowed";
  const microphone = options.microphone ?? "allowed";
  let sink: AudioSink | null = null;
  let started = 0;
  /** Samples made so far per source, so the tone carries on across pushes. */
  const made: Record<AudioSource, number> = { microphone: 0, system: 0 };
  let wanted: Record<AudioSource, boolean> = { microphone: false, system: false };
  let micQuietUntil = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const settingsOpened: AudioSource[] = [];

  const samplesOf = (source: AudioSource, ms: number): Int16Array => {
    const count = Math.round((ms * MEETING_SAMPLE_RATE) / 1000);
    const samples = new Int16Array(count);
    if (source === "system" && system === "silent") return samples;
    if (options.recording) {
      if (source === "system")
        samples.set(options.recording.subarray(made.system, made.system + count));
      made[source] += count;
      return samples;
    }
    const [hertz, level] = source === "microphone" ? [440, 6000] : [660, 3000];
    for (let i = 0; i < count; i++) {
      const t = (made[source] + i) / MEETING_SAMPLE_RATE;
      samples[i] = Math.round(level * Math.sin(2 * Math.PI * hertz * t));
    }
    made[source] += count;
    return samples;
  };

  const now = options.now ?? Date.now;
  const push = (source: AudioSource, ms: number) => {
    if (!sink || !wanted[source]) return;
    if (source === "microphone" && Date.now() < micQuietUntil) return;
    sink.audio(source, samplesOf(source, ms), now());
  };

  return {
    systemAudio,
    get started() {
      return started;
    },
    get running() {
      return sink !== null;
    },
    get microphoneOn() {
      return wanted.microphone;
    },
    settingsOpened,

    start(request, given) {
      started++;
      sink = given;
      wanted = {
        microphone: microphone !== "denied",
        system: request.systemAudio && system !== "denied",
      };
      given.state("microphone", microphone === "denied" ? "denied" : "recording");
      if (request.systemAudio) given.state("system", system === "denied" ? "denied" : "recording");
      const tick = options.realTime;
      if (tick) {
        let last = Date.now();
        timer = setInterval(() => {
          // A late tick sends the time it was late too, as a device's buffer does: a busy
          // machine would otherwise lose audio a real microphone keeps.
          const now = Date.now();
          push("microphone", now - last);
          push("system", now - last);
          last = now;
        }, tick);
      }
      return {
        setMicrophone(on) {
          if (sink !== given || wanted.microphone === on) return;
          wanted = { ...wanted, microphone: on };
          if (on) given.state("microphone", "recording");
        },
        stop: async () => {
          if (timer) clearInterval(timer);
          timer = null;
          if (sink === given) sink = null;
        },
      };
    },

    async openSettings(source) {
      settingsOpened.push(source);
    },

    push,

    report(source, state) {
      sink?.state(source, state);
    },

    changeDevice(pauseMs = 1500) {
      micQuietUntil = Date.now() + pauseMs;
    },
  };
}
