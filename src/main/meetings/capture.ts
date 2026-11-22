/**
 * The desktop app's `AudioCapture` (ADR-0015): the hidden capture window
 * (./captureWindow) records the microphone and the computer's sound through
 * Chromium, and sends 16 kHz PCM back here, which goes on to the core. The
 * window is held while a Meeting records.
 */
import { type IpcMainEvent, ipcMain, shell, systemPreferences } from "electron";
import type { AudioCapture, AudioSink, CaptureSession, Logger } from "../../core";
import type { AudioSource } from "../../core/api";
import {
  CAPTURE_CHANNELS,
  type CaptureWindowState,
  createMicrophoneRelay,
} from "../../shared/capture";
import type { CaptureWindows } from "./captureWindow";

/** How long stopping waits for the window to send its last samples. */
const STOP_TIMEOUT_MS = 3000;

/** Where each platform keeps the switch that lets an app record a source. */
const SETTINGS: Partial<Record<NodeJS.Platform, Record<AudioSource, string>>> = {
  darwin: {
    microphone:
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
    // "Screen & System Audio Recording", where "System Audio Recording Only" is.
    system:
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
  },
  win32: { microphone: "ms-settings:privacy-microphone", system: "ms-settings:sound" },
};

const CAPTURE_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "recording",
  "denied",
  "unavailable",
  "ended",
]);

/** Samples from the window, as 16-bit PCM whatever view IPC delivered them in. */
function samplesOf(value: unknown): Int16Array | null {
  if (value instanceof Int16Array) return value;
  if (!ArrayBuffer.isView(value) || value.byteLength % 2 !== 0) return null;
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  return new Int16Array(bytes.buffer);
}

/** On macOS, asks for the microphone if the User hasn't been asked: true if it may be used. */
async function microphoneAllowed(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  if (status === "not-determined") return systemPreferences.askForMediaAccess("microphone");
  return false;
}

export function createElectronAudioCapture(windows: CaptureWindows, log: Logger): AudioCapture {
  return {
    // Linux: the microphone only, for now (ADR-0015).
    systemAudio: process.platform === "darwin" || process.platform === "win32",

    start(request, sink: AudioSink): CaptureSession {
      const use = windows.use();
      const contents = use.contents;
      const fromWindow = (event: IpcMainEvent) => event.sender === contents;
      const microphoneRelay = createMicrophoneRelay({
        start: (request) => contents.send(CAPTURE_CHANNELS.start, request),
        microphone: (on) => {
          if (!contents.isDestroyed()) contents.send(CAPTURE_CHANNELS.microphone, on);
        },
      });
      let stopped = () => {};
      const whenStopped = new Promise<void>((resolve) => {
        stopped = resolve;
      });

      const onAudio = (
        event: IpcMainEvent,
        source: unknown,
        value: unknown,
        capturedAt: unknown,
      ) => {
        if (!fromWindow(event) || (source !== "microphone" && source !== "system")) return;
        const samples = samplesOf(value);
        const at =
          typeof capturedAt === "number" && Number.isFinite(capturedAt) ? capturedAt : undefined;
        if (samples) sink.audio(source, samples, at);
      };
      const onState = (event: IpcMainEvent, source: unknown, state: unknown) => {
        if (!fromWindow(event) || (source !== "microphone" && source !== "system")) return;
        if (typeof state !== "string" || !CAPTURE_STATES.has(state)) return;
        sink.state(source, state as CaptureWindowState);
      };
      const onStopped = (event: IpcMainEvent) => {
        if (fromWindow(event)) stopped();
      };
      ipcMain.on(CAPTURE_CHANNELS.audio, onAudio);
      ipcMain.on(CAPTURE_CHANNELS.state, onState);
      ipcMain.on(CAPTURE_CHANNELS.stopped, onStopped);
      const detach = () => {
        ipcMain.off(CAPTURE_CHANNELS.audio, onAudio);
        ipcMain.off(CAPTURE_CHANNELS.state, onState);
        ipcMain.off(CAPTURE_CHANNELS.stopped, onStopped);
      };
      use.onGone(() => {
        sink.state("microphone", "ended");
        if (request.systemAudio) sink.state("system", "ended");
        stopped();
      });

      const begin = async () => {
        // While the system's prompt is open nothing is captured, so the Meeting says it waits.
        if (
          process.platform === "darwin" &&
          systemPreferences.getMediaAccessStatus("microphone") === "not-determined"
        ) {
          sink.state("microphone", "waiting");
        }
        const microphone = await microphoneAllowed();
        if (!microphone) sink.state("microphone", "denied");
        await use.loaded;
        if (contents.isDestroyed()) return;
        microphoneRelay.start({ microphone, systemAudio: request.systemAudio });
      };
      const starting = begin().catch((error: unknown) => {
        log.error("meeting.captureFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
        sink.state("microphone", "ended");
        if (request.systemAudio) sink.state("system", "ended");
      });

      return {
        setMicrophone: (on) => microphoneRelay.set(on),
        async stop() {
          await starting;
          if (!contents.isDestroyed()) {
            contents.send(CAPTURE_CHANNELS.stop);
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              whenStopped,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, STOP_TIMEOUT_MS);
              }),
            ]);
            clearTimeout(timer);
          }
          detach();
          use.release();
        },
      };
    },

    async openSettings(source) {
      const url = SETTINGS[process.platform]?.[source];
      if (!url) throw new Error("This system has no settings page IncarnaMind can open for this.");
      await shell.openExternal(url);
    },
  };
}
