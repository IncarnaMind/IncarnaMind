/**
 * The hidden capture window's page (ADR-0015). Started by the main process, it
 * opens the microphone (`getUserMedia`) and, if asked, the computer's sound
 * (`getDisplayMedia`, which the main process answers with loopback audio and
 * this window's own page as the video, stopped at once). Each track is read as
 * its device gives it, mixed to mono and resampled to 16 kHz (`./frames`), and
 * its frames go to the main process as 16-bit PCM. The microphone is opened
 * again when the default input changes or its device goes, and closed while the
 * User has paused it, so nothing opens or hears it then.
 */
import type { AudioSource } from "../../core/api";
import {
  CAPTURE_BRIDGE_KEY,
  type CaptureBridge,
  type CaptureStart,
  type CaptureWindowState,
  toPcm16,
} from "../../shared/capture";
import { createFrames } from "./frames";
import { createMicrophone, startMicrophone } from "./microphone";

const found = (window as unknown as Partial<Record<string, CaptureBridge>>)[CAPTURE_BRIDGE_KEY];
if (!found) throw new Error("The capture window's preload didn't load.");
const bridge: CaptureBridge = found;

declare global {
  // Chromium's MediaStreamTrackProcessor, which TypeScript's DOM types don't have.
  var MediaStreamTrackProcessor: new (init: {
    track: MediaStreamTrack;
    maxBufferSize?: number;
  }) => { readonly readable: ReadableStream<AudioData> };
}

/**
 * About five seconds of the 10 ms blocks a device gives. The page reads each as it comes, so only
 * a page held up that long would lose any.
 */
const QUEUED_BLOCKS = 500;
const QUEUED_MS = QUEUED_BLOCKS * 10;

interface Open {
  stream: MediaStream;
  /** It has given some sound: a track that ends before any was most likely refused. */
  heard: boolean;
  /** Resolves once its track's audio has ended and what was held has been sent. */
  flushed: Promise<void>;
}

const open = new Map<AudioSource, Open>();
let running = false;

const report = (source: AudioSource, state: CaptureWindowState) => bridge.state(source, state);

function stateOf(error: unknown): CaptureWindowState {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "unavailable";
  return "ended";
}

function channelsOf(block: AudioData): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let planeIndex = 0; planeIndex < block.numberOfChannels; planeIndex++) {
    const samples = new Float32Array(block.numberOfFrames);
    block.copyTo(samples, { planeIndex, format: "f32-planar" });
    channels.push(samples);
  }
  return channels;
}

/**
 * Reads a track's audio as its device gives it. An audio context would take it at the pace of its
 * output, a device's or a timer's: an output that is slow to open held the microphone back, one
 * that failed captured nothing (#3248), and a timer that runs late lost what it didn't take, half
 * of everything on a macOS virtual machine (#3000).
 */
function connect(source: AudioSource, stream: MediaStream): Open {
  const [track] = stream.getAudioTracks();
  if (!track) throw new Error(`The ${source} stream has no audio track.`);
  const reader = new MediaStreamTrackProcessor({
    track,
    maxBufferSize: QUEUED_BLOCKS,
  }).readable.getReader();
  const entry: Open = { stream, heard: false, flushed: Promise.resolve() };
  // A block's stamp counts on the page's clock from an origin of its own: the quickest any block
  // came counts as no wait, and one that came later than that was captured that much earlier.
  let quickest = Number.POSITIVE_INFINITY;
  let capturedAt = Date.now();
  const frames = createFrames((frame) => {
    if (!entry.heard) entry.heard = frame.some((sample) => sample !== 0);
    bridge.audio(source, toPcm16(frame), capturedAt);
  });
  entry.flushed = (async () => {
    for (;;) {
      const { value: block, done } = await reader.read();
      if (done) break;
      try {
        const took =
          performance.now() -
          block.timestamp / 1000 -
          (1000 * block.numberOfFrames) / block.sampleRate;
        quickest = Math.min(quickest, took);
        capturedAt = Math.round(Date.now() - Math.min(took - quickest, QUEUED_MS));
        frames.push(channelsOf(block), block.sampleRate);
      } finally {
        block.close();
      }
    }
  })()
    .catch((error: unknown) => {
      console.error(error);
      if (open.get(source) === entry) report(source, "ended");
    })
    .finally(() => frames.flush());
  open.set(source, entry);
  return entry;
}

/** Stops a source's track and sends what it still holds. */
async function close(source: AudioSource): Promise<void> {
  const entry = open.get(source);
  if (!entry) return;
  open.delete(source);
  for (const track of entry.stream.getTracks()) {
    track.onended = null;
    track.stop();
  }
  await entry.flushed;
}

async function openMicrophone(stillWanted: () => boolean): Promise<void> {
  if (!stillWanted()) return;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // No echo cancellation: the others' voices come from another app, which it can't see.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch (error) {
    report("microphone", stateOf(error));
    return;
  }
  // A pause can arrive while the User is still being asked, or the page is starting.
  if (!stillWanted()) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  try {
    connect("microphone", stream);
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
  report("microphone", "recording");
  const [track] = stream.getAudioTracks();
  if (track) track.onended = () => void microphone.reopen();
}

const microphone = createMicrophone({
  isOpen: () => open.has("microphone"),
  open: openMicrophone,
  close: () => close("microphone"),
});

async function openSystemAudio(): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (error) {
    report("system", stateOf(error));
    return;
  }
  // Chromium grants loopback audio only with a video track: this page's, never looked at.
  for (const track of stream.getVideoTracks()) track.stop();
  const [track] = stream.getAudioTracks();
  if (!running || !track || track.readyState === "ended") {
    if (track) track.stop();
    if (running) report("system", "denied");
    return;
  }
  const entry = connect("system", new MediaStream([track]));
  report("system", "recording");
  // macOS gives a refused Core Audio tap as a track that ends: before any sound, that's a refusal.
  track.onended = () => {
    void close("system");
    report("system", entry.heard ? "ended" : "denied");
  };
}

async function start(request: CaptureStart): Promise<void> {
  running = true;
  // Queued before anything is awaited: a pause that follows is never behind this open.
  await startMicrophone(microphone, request);
  if (request.systemAudio) await openSystemAudio();
}

async function stop(): Promise<void> {
  running = false;
  await microphone.stop();
  await Promise.all([close("microphone"), close("system")]);
  bridge.stopped();
}

navigator.mediaDevices.addEventListener("devicechange", () => {
  void microphone.reopen();
});

bridge.onMicrophone((on) => {
  void microphone.set(on);
});
bridge.onStart((request) => {
  start(request).catch((error: unknown) => {
    console.error(error);
    report("microphone", "ended");
  });
});
bridge.onStop(() => {
  stop().catch((error: unknown) => {
    console.error(error);
    bridge.stopped();
  });
});
