/**
 * The hidden meeting capture window (ADR-0015), shared by what it captures:
 * a Meeting's audio, and the one window the User shares (ADR-0031). It opens,
 * in a session of its own, when the first of them starts, and closes once
 * the last stops.
 *
 * Only that session may use media: the microphone, and display capture,
 * which `setDisplayMediaRequestHandler` answers. A request with audio is the
 * computer's sound: loopback audio, with the window's own page as the video,
 * so no screen is captured for it. A request without audio is the shared
 * window: the one chosen in IncarnaMind's picker.
 */
import { join } from "node:path";
import {
  BrowserWindow,
  type DesktopCapturerSource,
  type Session,
  session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import type { Logger } from "../../core";
import { CAPTURE_PARTITION } from "../../shared/capture";

/** The capture windows, and the windows a test shares, so the app's own window handling leaves them out. */
const captureWindows = new WeakSet<BrowserWindow>();
export const isCaptureWindow = (window: BrowserWindow) => captureWindows.has(window);
export const leaveOut = (window: BrowserWindow) => captureWindows.add(window);

/** What the next display request without audio is answered with: a window, or a test's page. */
export type ScreenChoice =
  | { kind: "window"; source: Pick<DesktopCapturerSource, "id" | "name"> }
  | { kind: "page"; frame: WebFrameMain };

/** The open window, as one of its users holds it. */
export interface CaptureWindowUse {
  contents: WebContents;
  /** Resolves once its page has loaded and can be asked to capture. */
  loaded: Promise<void>;
  /** Called when its page's process dies: everything it captured has stopped. */
  onGone(listener: () => void): void;
  /** This user is done with it: the window closes when no one else uses it. */
  release(): void;
}

export interface CaptureWindowOptions {
  log: Logger;
  /** The dev server's address in development; the built page otherwise. */
  rendererUrl: string | undefined;
}

export function createCaptureWindows({ log, rendererUrl }: CaptureWindowOptions) {
  let captureSession: Session | null = null;
  let open: {
    window: BrowserWindow;
    users: number;
    loaded: Promise<void>;
    gone: Set<() => void>;
  } | null = null;
  /** How the shared window's next request is answered, set just before the page makes it. */
  let screenChoice: ScreenChoice | null = null;

  function answerDisplayRequest(
    request: Electron.DisplayMediaRequestHandlerHandlerRequest,
    callback: (streams: Electron.Streams) => void,
  ): void {
    try {
      if (request.audioRequested) {
        // Chromium won't grant audio alone: the video is this window's own blank page.
        callback({ video: request.frame ?? undefined, audio: "loopback" });
        return;
      }
      const choice = screenChoice;
      screenChoice = null;
      if (choice?.kind === "window") callback({ video: choice.source });
      else if (choice?.kind === "page") callback({ video: choice.frame });
      else callback({});
    } catch (error) {
      log.error("meeting.displayRequestRefused", {
        audio: request.audioRequested,
        message: error instanceof Error ? error.message : String(error),
      });
      callback({});
    }
  }

  /** Lets only the capture window's session use media, and answers its display requests. */
  function prepareSession(): Session {
    const prepared = session.fromPartition(CAPTURE_PARTITION, { cache: false });
    // The microphone asks for "media" with mediaTypes ["audio"]; display capture (Electron 44)
    // asks for "media" with none, and the handler below decides what it gets. A camera never.
    const microphoneOrDisplay = (types: readonly string[] | undefined) =>
      (types ?? []).every((type) => type === "audio");
    prepared.setPermissionRequestHandler((_contents, permission, callback, details) => {
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
      callback(
        (permission === "media" && microphoneOrDisplay(mediaTypes)) ||
          permission === "display-capture",
      );
    });
    prepared.setPermissionCheckHandler(
      (_contents, permission, _origin, details) =>
        (permission === "media" && details.mediaType !== "video") ||
        permission === "display-capture",
    );
    prepared.setDisplayMediaRequestHandler(answerDisplayRequest, { useSystemPicker: false });
    return prepared;
  }

  return {
    /** How the shared window's next display request is answered. */
    chooseScreen(choice: ScreenChoice | null): void {
      captureSession ??= prepareSession();
      screenChoice = choice;
    },

    /** Opens the capture window, or shares the one open. */
    use(): CaptureWindowUse {
      captureSession ??= prepareSession();
      if (!open || open.window.isDestroyed()) {
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
        const gone = new Set<() => void>();
        contents.on("console-message", (event) => {
          if (event.level === "error")
            log.error("meeting.captureWindow", { message: event.message });
        });
        contents.on("render-process-gone", (_event, details) => {
          log.error("meeting.captureGone", { reason: details.reason });
          for (const listener of gone) listener();
        });
        const loaded = new Promise<void>((resolve, reject) => {
          contents.once("did-finish-load", () => resolve());
          contents.once("did-fail-load", (_event, code, description) =>
            reject(new Error(`The capture page didn't load (${code}): ${description}`)),
          );
          if (rendererUrl) void window.loadURL(new URL("capture.html", `${rendererUrl}/`).href);
          else void window.loadFile(join(__dirname, "../renderer/capture.html"));
        });
        // Each user waits for it; one that gives up mustn't leave it unhandled.
        loaded.catch(() => undefined);
        open = { window, users: 0, loaded, gone };
      }
      const current = open;
      current.users++;
      let released = false;
      const listeners = new Set<() => void>();
      return {
        contents: current.window.webContents,
        loaded: current.loaded,
        onGone(listener) {
          listeners.add(listener);
          current.gone.add(listener);
        },
        release() {
          if (released) return;
          released = true;
          for (const listener of listeners) current.gone.delete(listener);
          current.users--;
          if (current.users > 0) return;
          if (open === current) open = null;
          if (!current.window.isDestroyed()) current.window.destroy();
        },
      };
    },
  };
}

export type CaptureWindows = ReturnType<typeof createCaptureWindows>;
