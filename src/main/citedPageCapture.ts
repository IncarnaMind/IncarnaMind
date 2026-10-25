/**
 * The desktop app's `capturePage` (#133): a hidden window of its own draws a
 * cited page with the Document viewer's view for its kind, off screen at
 * twice the pixels, and the cited area is taken as a picture. The window
 * exists only while it draws, and isn't one of the app's windows.
 */
import { join } from "node:path";
import {
  BaseWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  type NativeImage,
  WebContentsView,
} from "electron";
import type { CapturePage, DrawnPage, PageBox, PageCaptureRequest, PageText } from "../core";
import { isRecord } from "../core/errors";
import { CITED_PAGE_ARGUMENT, CITED_PAGE_CHANNELS } from "../shared/citedPage";

/** The page's width, and its height at first and at most, in CSS pixels. */
const WIDTH = 1000;
const HEIGHT = 1200;
const MAX_HEIGHT = 4000;
/** The picture's pixels per CSS pixel. */
const SCALE = 2;
const TIMEOUT_MS = 30_000;
/** How long the page paints nothing before its picture is taken, in milliseconds. */
const QUIET_MS = 300;
/** How many times a picture that came out blank is taken again, after another quiet moment. */
const BLANK_TRIES = 5;

interface Drawing {
  request: PageCaptureRequest;
  resize(height: number): number;
  drawn(layout: unknown): void;
  failed(reason: string): void;
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function boxOf(value: unknown): PageBox | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  return isNumber(x) && isNumber(y) && isNumber(width) && isNumber(height)
    ? { x, y, width, height }
    : null;
}

/** Whether a picture is all one colour: a cited area always has something drawn in it. */
function isBlank(picture: NativeImage): boolean {
  const bitmap = picture.toBitmap();
  let low = 255;
  let high = 0;
  for (let at = 0; at < bitmap.length; at += 4 * 7) {
    const value = bitmap[at] ?? 0;
    low = Math.min(low, value);
    high = Math.max(high, value);
    if (high - low > 16) return false;
  }
  return true;
}

/** The text runs the page gave, those whole, with their boxes in the picture's pixels. */
function textOf(value: unknown, scale: number): PageText[] {
  if (!Array.isArray(value)) return [];
  const runs: PageText[] = [];
  for (const run of value) {
    if (!isRecord(run)) continue;
    const { text, breakAfter, box } = run;
    const at = boxOf(box);
    if (typeof text !== "string" || !at) continue;
    runs.push({
      text,
      ...(breakAfter === true && { breakAfter: true }),
      box: {
        x: at.x * scale,
        y: at.y * scale,
        width: at.width * scale,
        height: at.height * scale,
      },
    });
  }
  return runs;
}

export function createCitedPageCapture({
  rendererUrl,
}: {
  /** The dev server's address in development; the built page otherwise. */
  rendererUrl: string | undefined;
}): CapturePage {
  const drawings = new Map<number, Drawing>();
  const drawingFor = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    const drawing = drawings.get(event.sender.id);
    if (!drawing) throw new Error("Refused a call from an unknown page.");
    return drawing;
  };
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    ipcMain.handle(CITED_PAGE_CHANNELS.request, (event) => drawingFor(event).request);
    ipcMain.handle(CITED_PAGE_CHANNELS.resize, (event, height: unknown) => {
      const drawing = drawingFor(event);
      if (!isNumber(height)) throw new Error("A page's height must be a number.");
      return drawing.resize(height);
    });
    ipcMain.on(CITED_PAGE_CHANNELS.drawn, (event, layout: unknown) => {
      drawings.get(event.sender.id)?.drawn(layout);
    });
    ipcMain.on(CITED_PAGE_CHANNELS.failed, (event, reason: unknown) => {
      drawings.get(event.sender.id)?.failed(String(reason));
    });
  };

  return (request, signal) => {
    signal.throwIfAborted();
    listen();
    return new Promise<DrawnPage>((resolve, reject) => {
      const window = new BaseWindow({
        show: false,
        width: WIDTH,
        height: HEIGHT,
        // macOS keeps a window no taller than the screen otherwise; this one is never shown.
        enableLargerThanScreen: true,
      });
      const view = new WebContentsView({
        webPreferences: {
          preload: join(__dirname, "../preload/index.js"),
          additionalArguments: [CITED_PAGE_ARGUMENT],
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: { deviceScaleFactor: SCALE },
          backgroundThrottling: false,
        },
      });
      window.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
      const contents = view.webContents;
      let height = HEIGHT;
      let settled = false;
      /** When the page last painted a frame, and the wait for it to stop. */
      let painted = Date.now();
      let settling: NodeJS.Timeout | undefined;

      const finish = (outcome: { page: DrawnPage } | { error: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(settling);
        signal.removeEventListener("abort", abort);
        drawings.delete(contents.id);
        if (!contents.isDestroyed()) contents.close();
        if (!window.isDestroyed()) window.destroy();
        if ("page" in outcome) resolve(outcome.page);
        else reject(outcome.error);
      };
      const abort = () => finish({ error: signal.reason });
      const timer = setTimeout(
        () => finish({ error: new Error("The cited page took too long to draw.") }),
        TIMEOUT_MS,
      );
      signal.addEventListener("abort", abort, { once: true });

      drawings.set(contents.id, {
        request,
        resize(wanted) {
          const asked = Math.round(Math.min(MAX_HEIGHT, Math.max(HEIGHT, wanted)));
          window.setContentSize(WIDTH, asked);
          height = Math.min(asked, window.getContentSize()[1] ?? asked);
          view.setBounds({ x: 0, y: 0, width: WIDTH, height });
          return height;
        },
        drawn(layout) {
          const given = isRecord(layout) ? layout : {};
          const box = boxOf(given.rect);
          const x = Math.max(0, Math.floor(box?.x ?? 0));
          const y = Math.max(0, Math.floor(box?.y ?? 0));
          const rect = {
            x,
            y,
            width: Math.min(WIDTH, Math.ceil((box?.x ?? 0) + (box?.width ?? 0))) - x,
            height: Math.min(height, Math.ceil((box?.y ?? 0) + (box?.height ?? 0))) - y,
          };
          if (!box || rect.width <= 0 || rect.height <= 0) {
            finish({ error: new Error("The cited area isn't on the page.") });
            return;
          }
          // Taken once the page has painted nothing for a moment: frames reach here a little
          // after they are drawn, so one taken at once can be from before the area was drawn.
          let tries = 0;
          const take = () => {
            // Stopped while a picture was being taken: its window is gone, and touching it
            // throws in the main process, whose error box stops the app.
            if (settled) return;
            const wait = QUIET_MS - (Date.now() - painted);
            if (wait > 0) {
              settling = setTimeout(take, wait);
              return;
            }
            contents
              .capturePage(rect, { stayHidden: true })
              .then((picture) => {
                const size = picture.getSize();
                if (picture.isEmpty() || size.width === 0 || size.height === 0) {
                  throw new Error("The cited page came out empty.");
                }
                if (isBlank(picture) && ++tries < BLANK_TRIES) {
                  settling = setTimeout(take, QUIET_MS);
                  return;
                }
                finish({
                  page: {
                    data: picture.toPNG(),
                    type: "image/png",
                    width: size.width,
                    height: size.height,
                    text: textOf(given.text, size.width / rect.width),
                  },
                });
              })
              .catch((error: unknown) => finish({ error }));
          };
          take();
        },
        failed(reason) {
          finish({ error: new Error(`The cited page couldn't be drawn: ${reason}`) });
        },
      });

      contents.on("paint", () => {
        painted = Date.now();
      });
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event) => event.preventDefault());
      contents.on("render-process-gone", (_event, details) =>
        finish({ error: new Error(`The page drawing a cited page stopped (${details.reason}).`) }),
      );
      contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
        if (mainFrame) {
          finish({
            error: new Error(`The cited page's window didn't load (${code}): ${description}`),
          });
        }
      });
      const loading = rendererUrl
        ? contents.loadURL(new URL("citedPage.html", `${rendererUrl}/`).href)
        : contents.loadFile(join(__dirname, "../renderer/citedPage.html"));
      loading.catch((error: unknown) => finish({ error }));
    });
  };
}
