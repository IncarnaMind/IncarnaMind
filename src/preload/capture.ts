/**
 * The hidden capture window's preload (ADR-0015): its page gets start and
 * stop from the main process, and sends back audio and how each source is
 * doing. Nothing else: no core, no files.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  CAPTURE_BRIDGE_KEY,
  CAPTURE_CHANNELS,
  type CaptureBridge,
  type CaptureStart,
} from "../shared/capture";

const bridge: CaptureBridge = {
  onStart: (listener) => {
    ipcRenderer.on(CAPTURE_CHANNELS.start, (_event, request: CaptureStart) => listener(request));
  },
  onStop: (listener) => {
    ipcRenderer.on(CAPTURE_CHANNELS.stop, () => listener());
  },
  onMicrophone: (listener) => {
    ipcRenderer.on(CAPTURE_CHANNELS.microphone, (_event, on: boolean) => listener(on));
  },
  audio: (source, samples, capturedAt) =>
    ipcRenderer.send(CAPTURE_CHANNELS.audio, source, samples, capturedAt),
  state: (source, state) => ipcRenderer.send(CAPTURE_CHANNELS.state, source, state),
  stopped: () => ipcRenderer.send(CAPTURE_CHANNELS.stopped),
};

contextBridge.exposeInMainWorld(CAPTURE_BRIDGE_KEY, bridge);
