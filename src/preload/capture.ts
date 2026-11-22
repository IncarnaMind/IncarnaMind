/**
 * The hidden capture window's preload (ADR-0015): its page gets start and
 * stop from the main process, and sends back audio and how each source is
 * doing, and the shared window's thumbnails and frames (ADR-0031). Nothing
 * else: no core, no files.
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
  onScreenStart: (listener) => {
    ipcRenderer.on(CAPTURE_CHANNELS.screenStart, (_event, selection: number) =>
      listener(selection),
    );
  },
  onScreenGrab: (listener) => {
    ipcRenderer.on(
      CAPTURE_CHANNELS.screenGrab,
      (_event, selection: number, id: number, keepImage: boolean) =>
        listener(selection, id, keepImage),
    );
  },
  onScreenStop: (listener) => {
    ipcRenderer.on(CAPTURE_CHANNELS.screenStop, (_event, selection: number) => listener(selection));
  },
  screenStarted: (selection, started) =>
    ipcRenderer.send(CAPTURE_CHANNELS.screenStarted, selection, started),
  screenSample: (selection, width, height, pixels) =>
    ipcRenderer.send(CAPTURE_CHANNELS.screenSample, selection, width, height, pixels),
  screenFrame: (selection, id, frame) =>
    ipcRenderer.send(CAPTURE_CHANNELS.screenFrame, selection, id, frame),
  screenEnded: (selection) => ipcRenderer.send(CAPTURE_CHANNELS.screenEnded, selection),
};

contextBridge.exposeInMainWorld(CAPTURE_BRIDGE_KEY, bridge);
