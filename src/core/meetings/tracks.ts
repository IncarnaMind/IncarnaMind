/**
 * The microphone and the computer's sound as two tracks for transcription
 * (#136, #941), in the Meeting's time, so each is transcribed on its own and
 * its lines say who spoke. The echo of the computer's sound the microphone
 * picks up from the speakers is taken out of the microphone's track first
 * (./echo, #846), with the computer's sound as the reference, so what the
 * others say is in the computer's track only. Each source's samples are
 * placed where they belong; both tracks are let out together, a moment
 * behind the newest, so a source a little late still joins in. Samples later
 * than that go to disk only. A stretch a source doesn't cover is silence.
 *
 * While the User has paused their microphone, no block carries a microphone
 * track: nothing is sent for it, not even silence.
 */
import { MEETING_SAMPLE_RATE } from "../adapters";
import type { AudioSource } from "../api";
import { createEchoCanceller, ECHO_BLOCK, type EchoCanceller } from "./echo";

/** How long audio waits for the other source before it is let out. */
const DELAY_MS = 300;

const sampleAt = (ms: number) => Math.round((ms * MEETING_SAMPLE_RATE) / 1000);
const msAt = (sample: number) => (sample * 1000) / MEETING_SAMPLE_RATE;

export interface TrackedAudio {
  /** Where both tracks start, in the Meeting's time, and how long they last. */
  atMs: number;
  lengthMs: number;
  /** Null while the User has paused it. */
  microphone: Int16Array | null;
  /** The computer's sound; null while none has been heard: a Meeting in a room has none. */
  system: Int16Array | null;
}

export function createTracks(startMs: number) {
  /** The first sample not yet let out, in the Meeting's time. */
  let out = sampleAt(startMs);
  /** The computer's sound from `out` on. */
  let system = new Int32Array(MEETING_SAMPLE_RATE);
  /** The microphone from `out` on, as captured. */
  let microphone = new Int32Array(MEETING_SAMPLE_RATE);
  /** One past the newest sample heard. */
  let newest = out;
  /** Made when the computer's sound first comes: until then there is no echo to take out. */
  let canceller: EchoCanceller | null = null;
  let microphonePaused = false;

  function room(end: number): void {
    const needed = end - out;
    if (needed <= system.length) return;
    const length = Math.max(needed, system.length * 2);
    const grownSystem = new Int32Array(length);
    grownSystem.set(system);
    system = grownSystem;
    const grownMicrophone = new Int32Array(length);
    grownMicrophone.set(microphone);
    microphone = grownMicrophone;
  }

  /** The microphone from `out` on, `count` samples, with the echo taken out a block at a time. */
  function cleanMicrophone(count: number): Int32Array {
    if (!canceller) return microphone;
    const block = new Int16Array(ECHO_BLOCK);
    for (let at = 0; at < count; at += ECHO_BLOCK) {
      const length = Math.min(ECHO_BLOCK, count - at);
      block.fill(0);
      for (let i = 0; i < length; i++) {
        block[i] = Math.max(-32768, Math.min(32767, microphone[at + i] as number));
      }
      microphone.set(canceller.cancel(block, out + at).subarray(0, length), at);
    }
    return microphone;
  }

  const clipped = (source: Int32Array, count: number): Int16Array => {
    const samples = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      samples[i] = Math.max(-32768, Math.min(32767, source[i] as number));
    }
    return samples;
  };

  function take(until: number): TrackedAudio | null {
    if (until <= out) return null;
    const count = until - out;
    const audio = {
      atMs: msAt(out),
      lengthMs: msAt(count),
      microphone: microphonePaused ? null : clipped(cleanMicrophone(count), count),
      system: canceller ? clipped(system, count) : null,
    };
    for (const buffer of [system, microphone]) {
      buffer.copyWithin(0, count);
      buffer.fill(0, buffer.length - count);
    }
    out = until;
    return audio;
  }

  /** Adds a source's samples, which start at `atMs` in the Meeting's time. */
  function put(source: AudioSource, samples: Int16Array, atMs: number): void {
    let start = sampleAt(atMs);
    const end = start + samples.length;
    if (source === "system") {
      canceller ??= createEchoCanceller();
      canceller.reference(samples, start);
    }
    if (end > out) {
      const skip = Math.max(0, out - start);
      start += skip;
      room(end);
      const target = source === "system" ? system : microphone;
      for (let i = skip; i < samples.length; i++) {
        const at = start - out + (i - skip);
        target[at] = (target[at] as number) + (samples[i] as number);
      }
    }
    newest = Math.max(newest, end);
  }

  return {
    put,

    /** Adds a source's samples, as `put`, and returns what is ready to go, in whole blocks. */
    add(source: AudioSource, samples: Int16Array, atMs: number): TrackedAudio | null {
      put(source, samples, atMs);
      const ready = newest - sampleAt(DELAY_MS) - out;
      return take(out + Math.floor(ready / ECHO_BLOCK) * ECHO_BLOCK);
    },

    /** Lets out everything heard. */
    flush(): TrackedAudio | null {
      return take(newest);
    },

    /**
     * The microphone is paused at `atMs` in the Meeting's time: what it heard up to there is let
     * out now, its last, and no block has its track until `resumeMicrophone`.
     */
    pauseMicrophone(atMs: number): TrackedAudio | null {
      // Either source can be stamped a little past the press (the computer's sound runs ahead
      // when its first frame was heard late): that goes out later, without the microphone's track.
      const audio = take(Math.max(out, Math.min(newest, sampleAt(atMs))));
      microphonePaused = true;
      return audio;
    },

    /**
     * The microphone is on again from `atMs` in the Meeting's time: what came meanwhile is let
     * out now, without its track, and its samples are placed from here.
     */
    resumeMicrophone(atMs: number): TrackedAudio | null {
      const audio = take(newest);
      microphonePaused = false;
      // With nothing else coming, nothing waited through the pause: carry on from here.
      out = newest = Math.max(out, sampleAt(atMs));
      return audio;
    },

    /** Where the audio not yet let out starts, in the Meeting's time. */
    get atMs(): number {
      return msAt(out);
    },
  };
}

export type Tracks = ReturnType<typeof createTracks>;
