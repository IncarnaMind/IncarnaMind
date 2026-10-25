/**
 * The desktop app's `AudioCapture` (ADR-0015): a hidden window, in a session
 * of its own, records the microphone and the computer's sound through
 * Chromium, and sends 16 kHz PCM back here, which goes on to the core.
 *
 * Only that session may use media: the microphone, and display capture,
 * which `setDisplayMediaRequestHandler` answers with loopback audio and the
 * window's own page as the video, so no screen is captured. The window exists
 * only while a Meeting records.
 */
import { join } from "node:path";
import {
  BrowserWindow,
  type IpcMainEvent,
  ipcMain,
  type Session,
  session,
  shell,
  systemPreferences,
} from "electron";
import type { AudioCapture, AudioSink, CaptureSession, Logger } from "../../core";
import type { AudioSource } from "../../core/api";
import {
  CAPTURE_CHANNELS,
  CAPTURE_PARTITION,
  type CaptureWindowState,
  createMicrophoneRelay,
} from "../../shared/capture";

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
  "recording",
  "denied",
  "unavailable",
  "ended",
]);

/** The capture windows, so the app's own window handling leaves them out. */
const captureWindows = new WeakSet<BrowserWindow>();
export const isCaptureWindow = (window: BrowserWindow) => captureWindows.has(window);

/** Samples from the window, as 16-bit PCM whatever view IPC delivered them in. */
function samplesOf(value: unknown): Int16Array | null {
  if (value instanceof Int16Array) return value;
  if (!ArrayBuffer.isView(value) || value.byteLength % 2 !== 0) return null;
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  return new Int16Array(bytes.buffer);
}

/** Lets only the capture window's session use media, and answers its display capture with loopback audio. */
function prepareSession(log: Logger): Session {
  const captureSession = session.fromPartition(CAPTURE_PARTITION, { cache: false });
  // The microphone asks for "media" with mediaTypes ["audio"]; display capture (Electron 44)
  // asks for "media" with none, and our handler below decides what it gets. A camera never.
  const microphoneOrDisplay = (types: readonly string[] | undefined) =>
    (types ?? []).every((type) => type === "audio");
  captureSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    callback(
      (permission === "media" && microphoneOrDisplay(mediaTypes)) ||
        permission === "display-capture",
    );
  });
  captureSession.setPermissionCheckHandler(
    (_contents, permission, _origin, details) =>
      (permission === "media" && details.mediaType !== "video") || permission === "display-capture",
  );
  captureSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      try {
        // Chromium won't grant audio alone: the video is this window's own blank page.
        callback({ video: request.frame ?? undefined, audio: "loopback" });
      } catch (error) {
        log.error("meeting.loopbackRefused", {
          message: error instanceof Error ? error.message : String(error),
        });
        callback({});
      }
    },
    { useSystemPicker: false },
  );
  return captureSession;
}

/** On macOS, asks for the microphone if the User hasn't been asked: true if it may be used. */
async function microphoneAllowed(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  if (status === "not-determined") return systemPreferences.askForMediaAccess("microphone");
  return false;
}

export interface ElectronCaptureOptions {
  log: Logger;
  /** The dev server's address in development; the built page otherwise. */
  rendererUrl: string | undefined;
}

export function createElectronAudioCapture({
  log,
  rendererUrl,
}: ElectronCaptureOptions): AudioCapture {
  let captureSession: Session | null = null;

  return {
    // Linux: the microphone only, for now (ADR-0015).
    systemAudio: process.platform === "darwin" || process.platform === "win32",

    start(request, sink: AudioSink): CaptureSession {
      captureSession ??= prepareSession(log);
      const window = new BrowserWindow({
        show: false,
        width: 320,
        height: 240,
        title: "IncarnaMind audio",
        webPreferences: {
          preload: join(__dirname, "../preload/capture.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          session: captureSession,
          backgroundThrottling: false,
        },
      });
      captureWindows.add(window);
      const contents = window.webContents;
      const fromWindow = (event: IpcMainEvent) => event.sender === contents;
      const microphoneRelay = createMicrophoneRelay({
        start: (request) => contents.send(CAPTURE_CHANNELS.start, request),
        microphone: (on) => {
          if (!window.isDestroyed()) contents.send(CAPTURE_CHANNELS.microphone, on);
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

      contents.on("console-message", (event) => {
        if (event.level === "error") log.error("meeting.captureWindow", { message: event.message });
      });
      contents.on("render-process-gone", (_event, details) => {
        log.error("meeting.captureGone", { reason: details.reason });
        sink.state("microphone", "ended");
        if (request.systemAudio) sink.state("system", "ended");
        stopped();
      });

      const begin = async () => {
        const microphone = await microphoneAllowed();
        if (!microphone) sink.state("microphone", "denied");
        await new Promise<void>((resolve, reject) => {
          contents.once("did-finish-load", () => resolve());
          contents.once("did-fail-load", (_event, code, description) =>
            reject(new Error(`The capture page didn't load (${code}): ${description}`)),
          );
          if (rendererUrl) void window.loadURL(new URL("capture.html", `${rendererUrl}/`).href);
          else void window.loadFile(join(__dirname, "../renderer/capture.html"));
        });
        if (window.isDestroyed()) return;
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
          if (!window.isDestroyed()) {
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
          if (!window.isDestroyed()) window.destroy();
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
