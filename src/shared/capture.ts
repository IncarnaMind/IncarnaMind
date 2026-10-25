/**
 * What the main process and the hidden capture window say to each other
 * while a Meeting records (ADR-0015): the channels, and the bridge the
 * window's preload gives its page.
 */
import type { AudioSource } from "../core/api";

/** The capture window's page reaches its preload as `window.incarnamindCapture`. */
export const CAPTURE_BRIDGE_KEY = "incarnamindCapture";

/** The in-memory session only the capture window uses: the one place media is allowed. */
export const CAPTURE_PARTITION = "meeting-capture";

export const CAPTURE_CHANNELS = {
  /** Main → page: start capturing (`CaptureStart`). */
  start: "capture:start",
  /** Main → page: stop, send what is left, then say "stopped". */
  stop: "capture:stop",
  /** Main → page: turn the microphone off or on (boolean) while capturing; the computer's sound goes on. */
  microphone: "capture:microphone",
  /** Page → main: (source, Int16Array of 16 kHz mono samples, when the last was captured). */
  audio: "capture:audio",
  /** Page → main: (source, `CaptureState`). */
  state: "capture:state",
  /** Page → main: everything captured has been sent. */
  stopped: "capture:stopped",
} as const;

export interface CaptureStart {
  /** Open the microphone: false when the OS has already refused it. */
  microphone: boolean;
  /** The User has it on: false when they paused it before the page started. */
  microphoneOn: boolean;
  /** Record the computer's sound too. */
  systemAudio: boolean;
}

/**
 * What the main process says to the capture page about the User's microphone: the first message
 * (the start) carries whether they have paused it already, and each change after it goes on as
 * it comes. A pause before the start isn't lost, and a resume after it isn't taken for refused.
 */
export function createMicrophoneRelay(page: {
  start(request: CaptureStart): void;
  microphone(on: boolean): void;
}) {
  let on = true;
  let started = false;
  return {
    set(next: boolean): void {
      on = next;
      if (started) page.microphone(next);
    },
    start(request: Omit<CaptureStart, "microphoneOn">): void {
      page.start({ ...request, microphoneOn: on });
      started = true;
    },
  };
}

/** How a source is doing, as the capture window sees it (`CaptureState` in the core's adapters). */
export type CaptureWindowState = "recording" | "denied" | "unavailable" | "ended";

export interface CaptureBridge {
  onStart(listener: (request: CaptureStart) => void): void;
  onStop(listener: () => void): void;
  onMicrophone(listener: (on: boolean) => void): void;
  /** `capturedAt`: when the last sample was captured, `Date.now()` on this computer. */
  audio(source: AudioSource, samples: Int16Array, capturedAt: number): void;
  state(source: AudioSource, state: CaptureWindowState): void;
  stopped(): void;
}

/** Web Audio's samples (-1 to 1) as 16-bit PCM, clipped. */
export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return out;
}
