/**
 * The hidden capture window's page (ADR-0015). Started by the main process, it
 * opens the microphone (`getUserMedia`) and, if asked, the computer's sound
 * (`getDisplayMedia`, which the main process answers with loopback audio and
 * this window's own page as the video, stopped at once). Each track runs
 * through a 16 kHz AudioContext and the "pcm-frames" worklet, and its frames
 * go to the main process as 16-bit PCM. The microphone is opened again when
 * the default input changes or its device goes, and closed while the User has
 * paused it, so nothing opens or hears it then.
 */
import type { AudioSource } from "../../core/api";
import {
  CAPTURE_BRIDGE_KEY,
  type CaptureBridge,
  type CaptureStart,
  type CaptureWindowState,
  toPcm16,
} from "../../shared/capture";
import { createMicrophone, startMicrophone } from "./microphone";
import pcmFramesUrl from "./pcmFrames.ts?worker&url";

const found = (window as unknown as Partial<Record<string, CaptureBridge>>)[CAPTURE_BRIDGE_KEY];
if (!found) throw new Error("The capture window's preload didn't load.");
const bridge: CaptureBridge = found;

const SAMPLE_RATE = 16_000;

interface Open {
  stream: MediaStream;
  node: MediaStreamAudioSourceNode;
  worklet: AudioWorkletNode;
  /** It has given some sound: a track that ends before any was most likely refused. */
  heard: boolean;
  /** Resolves once the worklet has sent what it held. */
  flushed: Promise<void>;
  /** When its track was stopped: what the worklet sends after that was captured by then. */
  stoppedAt: number | null;
}

let context: Promise<AudioContext> | null = null;
let sink: GainNode | null = null;
const open = new Map<AudioSource, Open>();
let running = false;

function audioContext(): Promise<AudioContext> {
  context ??= (async () => {
    const created = new AudioContext({ sampleRate: SAMPLE_RATE });
    await created.audioWorklet.addModule(pcmFramesUrl);
    // Worklets are pulled only from the destination: a silent path to it keeps them running.
    sink = created.createGain();
    sink.gain.value = 0;
    sink.connect(created.destination);
    return created;
  })();
  return context;
}

const report = (source: AudioSource, state: CaptureWindowState) => bridge.state(source, state);

function stateOf(error: unknown): CaptureWindowState {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "unavailable";
  return "ended";
}

async function connect(source: AudioSource, stream: MediaStream): Promise<Open> {
  const audio = await audioContext();
  const node = audio.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audio, "pcm-frames", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });
  let flushed = () => {};
  const entry: Open = {
    stream,
    node,
    worklet,
    heard: false,
    stoppedAt: null,
    flushed: new Promise((resolve) => {
      flushed = resolve;
    }),
  };
  worklet.port.onmessage = (event: MessageEvent<Float32Array | "flushed">) => {
    if (event.data === "flushed") {
      flushed();
      return;
    }
    if (!entry.heard) entry.heard = event.data.some((sample) => sample !== 0);
    bridge.audio(source, toPcm16(event.data), entry.stoppedAt ?? Date.now());
  };
  node.connect(worklet);
  if (sink) worklet.connect(sink);
  open.set(source, entry);
  return entry;
}

/** Stops a source's track and sends what its worklet still holds. */
async function close(source: AudioSource): Promise<void> {
  const entry = open.get(source);
  if (!entry) return;
  open.delete(source);
  entry.stoppedAt = Date.now();
  for (const track of entry.stream.getTracks()) {
    track.onended = null;
    track.stop();
  }
  entry.node.disconnect();
  entry.worklet.port.postMessage("flush");
  await entry.flushed;
  entry.worklet.disconnect();
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
    await connect("microphone", stream);
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
  const entry = await connect("system", new MediaStream([track]));
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
  const microphoneOpened = startMicrophone(microphone, request);
  await audioContext();
  await microphoneOpened;
  if (request.systemAudio) await openSystemAudio();
}

async function stop(): Promise<void> {
  running = false;
  await microphone.stop();
  await Promise.all([close("microphone"), close("system")]);
  if (context) await (await context).close();
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
