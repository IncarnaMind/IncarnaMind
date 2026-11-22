/**
 * What the main process and the hidden capture window say to each other
 * while a Meeting records (ADR-0015) or reads its shared screen (ADR-0031):
 * the channels, and the bridge the window's preload gives its page.
 */
import type { AudioSource } from "../core/api";

/** How wide the shared window's thumbnails are: about a 20th of a 1080p frame, enough to see a slide change. */
export const SCREEN_THUMBNAIL_WIDTH = 96;

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
  /** Main → page: capture the shared window (ADR-0031), which the next display request gives. */
  screenStart: "capture:screen-start",
  /** Page → main: `ScreenStarted`. */
  screenStarted: "capture:screen-started",
  /** Page → main: (width, height, pixels) of a small grey thumbnail, about once a second. */
  screenSample: "capture:screen-sample",
  /** Main → page: (id) send the window as it is now, at full size. */
  screenGrab: "capture:screen-grab",
  /** Page → main: (id, `ScreenGrabbed`). */
  screenFrame: "capture:screen-frame",
  /** Page → main: the shared window's capture ended by itself: closed, or stopped from outside. */
  screenEnded: "capture:screen-ended",
  /** Main → page: stop capturing the shared window. */
  screenStop: "capture:screen-stop",
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
export type CaptureWindowState = "waiting" | "recording" | "denied" | "unavailable" | "ended";

/** How the shared window's capture started: its name, or why it didn't. */
export type ScreenStarted =
  | { started: true }
  | { started: false; reason: "whole-screen" | "denied" | "closed"; message: string };

/** The shared window as it was when asked for: grey to read, and a JPEG to show. */
export type ScreenGrabbed =
  | {
      width: number;
      height: number;
      pixels: Uint8Array;
      preview?: { width: number; height: number; bgra: Uint8Array };
    }
  | { error: string };

export interface CaptureBridge {
  onStart(listener: (request: CaptureStart) => void): void;
  onStop(listener: () => void): void;
  onMicrophone(listener: (on: boolean) => void): void;
  /** `capturedAt`: when the last sample was captured, `Date.now()` on this computer. */
  audio(source: AudioSource, samples: Int16Array, capturedAt: number): void;
  state(source: AudioSource, state: CaptureWindowState): void;
  stopped(): void;
  onScreenStart(listener: (selection: number) => void): void;
  onScreenGrab(listener: (selection: number, id: number, keepImage: boolean) => void): void;
  onScreenStop(listener: (selection: number) => void): void;
  screenStarted(selection: number, started: ScreenStarted): void;
  screenSample(selection: number, width: number, height: number, pixels: Uint8Array): void;
  screenFrame(selection: number, id: number, frame: ScreenGrabbed): void;
  screenEnded(selection: number): void;
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
