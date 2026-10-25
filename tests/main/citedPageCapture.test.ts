import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Document } from "../../src/core/api";
import { CITED_PAGE_CHANNELS } from "../../src/shared/citedPage";

const electron = vi.hoisted(() => {
  const listeners = new Map<
    string,
    (event: { sender: { id: number } }, ...args: unknown[]) => void
  >();
  const blank = {
    getSize: () => ({ width: 20, height: 20 }),
    isEmpty: () => false,
    toBitmap: () => Buffer.alloc(20 * 20 * 4, 255),
    toPNG: () => Buffer.alloc(0),
  };
  let picture: (value: typeof blank) => void = () => undefined;
  const contents = {
    id: 7,
    destroyed: false,
    capturePage: vi.fn(() => {
      if (contents.destroyed) throw new TypeError("Object has been destroyed");
      return new Promise<typeof blank>((resolve) => {
        picture = resolve;
      });
    }),
    isDestroyed: () => contents.destroyed,
    close: () => {
      contents.destroyed = true;
    },
    on: () => undefined,
    setWindowOpenHandler: () => undefined,
    loadURL: () => Promise.resolve(),
    loadFile: () => Promise.resolve(),
  };
  return {
    listeners,
    contents,
    blank,
    givePicture: () => picture(blank),
    module: {
      BaseWindow: class {
        contentView = { addChildView: () => undefined };
        isDestroyed = () => false;
        destroy = () => undefined;
      },
      WebContentsView: class {
        webContents = contents;
        setBounds = () => undefined;
      },
      ipcMain: {
        handle: () => undefined,
        on: (channel: string, listener: (event: { sender: { id: number } }) => void) =>
          listeners.set(channel, listener),
      },
    },
  };
});
vi.mock("electron", () => electron.module);

const { createCitedPageCapture } = await import("../../src/main/citedPageCapture");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// protects=a drawing stopped while its picture is being taken (an Answer starting stops it) takes no picture after; fails_when=the late try reaches the closed window and throws in the main process, whose error box stops the app; no_claim=what is drawn.
test("a drawing stopped while its picture is taken tries no more", async () => {
  const capture = createCitedPageCapture({ rendererUrl: undefined });
  const stop = new AbortController();
  const document = { id: "d", kind: "docx" } as Document;
  const drawing = capture(
    { document, pageFrom: 1, pageTo: 1, area: { kind: "section" } },
    stop.signal,
  );
  const drawn = electron.listeners.get(CITED_PAGE_CHANNELS.drawn);
  drawn?.(
    { sender: { id: electron.contents.id } },
    { rect: { x: 0, y: 0, width: 20, height: 20 } },
  );
  await vi.advanceTimersByTimeAsync(1_000);
  expect(electron.contents.capturePage).toHaveBeenCalledTimes(1);

  stop.abort(new Error("An Answer started."));
  await expect(drawing).rejects.toThrow("An Answer started.");
  electron.givePicture();

  await vi.advanceTimersByTimeAsync(5_000);
  expect(electron.contents.capturePage).toHaveBeenCalledTimes(1);
});
