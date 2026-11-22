/**
 * The desktop app's `ScreenCapture` (ADR-0031): the one window the User
 * shares during a Meeting, chosen in IncarnaMind's own picker from the open
 * windows (`desktopCapturer`, never IncarnaMind's own), and captured as video
 * only in the meeting capture window (./captureWindow), which sends a small
 * grey thumbnail about once a second and, when the core asks, the window at
 * full size. On macOS this needs the Screen Recording permission, which macOS
 * asks for the first time the windows are listed.
 *
 * Test builds can share a test page instead (INCARNAMIND_TEST_SHARED_WINDOW):
 * a hidden window showing that HTML file is the one window the picker lists,
 * captured as a tab is, so no screen is ever captured in tests.
 */
import {
  BrowserWindow,
  desktopCapturer,
  type IpcMainEvent,
  ipcMain,
  nativeImage,
  systemPreferences,
  type WebContents,
} from "electron";
import {
  type Logger,
  type PagePicture,
  type ScreenCapture,
  ScreenCaptureError,
  type ScreenFrame,
  type ScreenPermission,
  type ScreenSession,
  type ScreenSink,
} from "../../core";
import type { ShareableWindow } from "../../core/api";
import { CAPTURE_CHANNELS, type ScreenGrabbed, type ScreenStarted } from "../../shared/capture";
import { type CaptureWindows, leaveOut, type ScreenChoice } from "./captureWindow";

/** How long a frame asked for may take before reading it gives up. */
const GRAB_TIMEOUT_MS = 10_000;
/** The pictures IncarnaMind's picker shows of each window. */
const THUMBNAIL = { width: 320, height: 200 };
/** The test page's id in IncarnaMind's picker. */
const TEST_WINDOW = "test-window";

/** Whether IncarnaMind may capture a window: macOS's Screen Recording; nothing to ask elsewhere. */
function screenPermission(): ScreenPermission {
  if (process.platform !== "darwin") return "granted";
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (status === "granted") return "granted";
  return status === "not-determined" ? "not-asked" : "denied";
}

/** Bytes from the capture window, whatever view IPC delivered them in. */
function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (!ArrayBuffer.isView(value)) return null;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/** A picture from the capture window, checked. */
function pictureOf(width: unknown, height: unknown, pixels: unknown): PagePicture | null {
  const bytes = bytesOf(pixels);
  if (typeof width !== "number" || typeof height !== "number" || !bytes) return null;
  return bytes.length === width * height ? { width, height, pixels: bytes } : null;
}

export interface ElectronScreenCaptureOptions {
  windows: CaptureWindows;
  log: Logger;
  /** A test build's page to share instead of a window (INCARNAMIND_TEST_SHARED_WINDOW). */
  testPage?: string;
}

export function createElectronScreenCapture({
  windows,
  log,
  testPage,
}: ElectronScreenCaptureOptions): ScreenCapture {
  let testWindow: BrowserWindow | null = null;
  let nextSelection = 0;

  /** The test page's hidden window, opened the first time it is asked for. */
  async function openTestWindow(page: string): Promise<BrowserWindow> {
    if (testWindow && !testWindow.isDestroyed()) return testWindow;
    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true },
    });
    leaveOut(window);
    await window.loadFile(page);
    testWindow = window;
    // The tests change what it shows through this.
    (globalThis as { incarnamindTestScreen?: WebContents }).incarnamindTestScreen =
      window.webContents;
    return window;
  }

  async function listWindows(): Promise<ShareableWindow[]> {
    if (testPage) {
      const window = await openTestWindow(testPage);
      const picture = await window.webContents.capturePage();
      return [{ id: TEST_WINDOW, name: window.getTitle(), thumbnail: picture.toDataURL() }];
    }
    if (screenPermission() === "denied") {
      throw new ScreenCaptureError("denied", "IncarnaMind may not record the screen.");
    }
    const own = new Set(BrowserWindow.getAllWindows().map((window) => window.getMediaSourceId()));
    // On macOS the first listing asks for Screen Recording; without it, the windows can't be read.
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: THUMBNAIL,
      fetchWindowIcons: false,
    });
    if (screenPermission() !== "granted") {
      throw new ScreenCaptureError("denied", "IncarnaMind may not record the screen.");
    }
    const shown = sources.filter((source) => !own.has(source.id) && source.name.trim() !== "");
    return shown.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.isEmpty() ? "" : source.thumbnail.toDataURL(),
    }));
  }

  async function choiceFor(window: Pick<ShareableWindow, "id" | "name">): Promise<ScreenChoice> {
    if (testPage && window.id === TEST_WINDOW) {
      return { kind: "page", frame: (await openTestWindow(testPage)).webContents.mainFrame };
    }
    return { kind: "window", source: window };
  }

  return {
    permission: () => (testPage ? "granted" : screenPermission()),

    windows: listWindows,

    async start(window, sink: ScreenSink, signal): Promise<ScreenSession> {
      const selection = ++nextSelection;
      const choice = await choiceFor(window);
      signal.throwIfAborted();
      const use = windows.use();
      const contents = use.contents;
      const fromWindow = (event: IpcMainEvent, token: unknown) =>
        event.sender === contents && token === selection && !ended;
      const grabs = new Map<
        number,
        { resolve(frame: ScreenFrame): void; reject(error: Error): void }
      >();
      let nextGrab = 1;
      let ended = false;
      let answer: (started: ScreenStarted) => void = () => {};
      const started = new Promise<ScreenStarted>((resolve) => {
        answer = resolve;
      });

      const onStarted = (event: IpcMainEvent, token: unknown, value: ScreenStarted) => {
        if (fromWindow(event, token)) answer(value);
      };
      const onSample = (
        event: IpcMainEvent,
        token: unknown,
        width: unknown,
        height: unknown,
        pixels: unknown,
      ) => {
        if (!fromWindow(event, token) || ended) return;
        const thumbnail = pictureOf(width, height, pixels);
        if (thumbnail) sink.sample(thumbnail);
      };
      const onFrame = (event: IpcMainEvent, token: unknown, id: unknown, frame: ScreenGrabbed) => {
        if (!fromWindow(event, token) || typeof id !== "number") return;
        const waiting = grabs.get(id);
        grabs.delete(id);
        if (!waiting) return;
        if ("error" in frame) {
          waiting.reject(new Error(frame.error));
          return;
        }
        const picture = pictureOf(frame.width, frame.height, frame.pixels);
        if (!picture) {
          waiting.reject(new Error("The shared window's frame could not be read."));
          return;
        }
        const preview = frame.preview;
        if (!preview) {
          waiting.resolve({ picture, image: null });
          return;
        }
        const { width, height } = preview;
        const bytes = bytesOf(preview.bgra);
        if (
          !bytes ||
          !Number.isSafeInteger(width) ||
          !Number.isSafeInteger(height) ||
          width < 1 ||
          height < 1 ||
          width > 1280 ||
          height > 1280 ||
          bytes.length !== width * height * 4
        ) {
          waiting.reject(new Error("The shared window's picture has invalid dimensions."));
          return;
        }
        let held: { bitmap: Buffer } | { encoded: Buffer } = {
          bitmap: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        };
        waiting.resolve({
          picture,
          image: {
            bytes: bytes.length,
            jpeg() {
              if ("bitmap" in held)
                held = {
                  encoded: nativeImage.createFromBitmap(held.bitmap, { width, height }).toJPEG(80),
                };
              return held.encoded;
            },
          },
        });
      };
      const finish = () => {
        if (ended) return;
        ended = true;
        signal.removeEventListener("abort", stop);
        ipcMain.off(CAPTURE_CHANNELS.screenStarted, onStarted);
        ipcMain.off(CAPTURE_CHANNELS.screenSample, onSample);
        ipcMain.off(CAPTURE_CHANNELS.screenFrame, onFrame);
        ipcMain.off(CAPTURE_CHANNELS.screenEnded, onEnded);
        for (const waiting of grabs.values()) {
          waiting.reject(new Error("The shared window is no longer captured."));
        }
        grabs.clear();
        use.release();
      };
      function onEnded(event: IpcMainEvent, token: unknown) {
        if (!fromWindow(event, token) || ended) return;
        answer({ started: false, reason: "closed", message: "The shared window closed." });
        finish();
        sink.ended();
      }
      function stop() {
        if (ended) return;
        windows.chooseScreen(null);
        if (!contents.isDestroyed()) contents.send(CAPTURE_CHANNELS.screenStop, selection);
        answer({ started: false, reason: "closed", message: "The selected window was withdrawn." });
        finish();
      }
      signal.addEventListener("abort", stop, { once: true });
      ipcMain.on(CAPTURE_CHANNELS.screenStarted, onStarted);
      ipcMain.on(CAPTURE_CHANNELS.screenSample, onSample);
      ipcMain.on(CAPTURE_CHANNELS.screenFrame, onFrame);
      ipcMain.on(CAPTURE_CHANNELS.screenEnded, onEnded);
      use.onGone(() => {
        answer({ started: false, reason: "closed", message: "The capture window stopped." });
        if (ended) return;
        finish();
        sink.ended();
      });

      let result: ScreenStarted;
      try {
        await use.loaded;
        signal.throwIfAborted();
        windows.chooseScreen(choice);
        contents.send(CAPTURE_CHANNELS.screenStart, selection);
        result = await started;
      } catch (error) {
        result = {
          started: false,
          reason: "closed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (!result.started) {
        finish();
        log.warn("meeting.screenNotStarted", { reason: result.reason, kind: choice.kind });
        throw new ScreenCaptureError(result.reason, result.message);
      }
      const name = choice.kind === "window" ? choice.source.name : (testWindow?.getTitle() ?? "");

      return {
        name,
        grab(keepImage) {
          if (ended || contents.isDestroyed()) {
            return Promise.reject(new Error("The shared window is no longer captured."));
          }
          const id = nextGrab++;
          return new Promise<ScreenFrame>((resolve, reject) => {
            const timer = setTimeout(() => {
              grabs.delete(id);
              reject(new Error("The shared window's frame didn't come."));
            }, GRAB_TIMEOUT_MS);
            grabs.set(id, {
              resolve: (frame) => {
                clearTimeout(timer);
                resolve(frame);
              },
              reject: (error) => {
                clearTimeout(timer);
                reject(error);
              },
            });
            contents.send(CAPTURE_CHANNELS.screenGrab, selection, id, keepImage);
          });
        },
        stop,
      };
    },
  };
}
