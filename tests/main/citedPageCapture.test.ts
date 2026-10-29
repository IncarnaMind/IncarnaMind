import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Document, LogFields } from "../../src/core";
import { CITED_PAGE_CHANNELS } from "../../src/shared/citedPage";

type Sender = { sender: { id: number } };

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (event: Sender, ...args: unknown[]) => void>();
  const handlers = new Map<string, (event: Sender, ...args: unknown[]) => unknown>();
  const events = new Map<string, (...args: unknown[]) => void>();
  /** A picture of `width` × `height` pixels: all white, or with something drawn on it. */
  const picture = (drawn: boolean, width = 40, height = 40) => ({
    getSize: () => ({ width, height }),
    isEmpty: () => false,
    toBitmap: () => {
      const bitmap = Buffer.alloc(width * height * 4, 255);
      if (drawn) for (let at = 0; at < bitmap.length; at += 8) bitmap[at] = 0;
      return bitmap;
    },
    toPNG: () => Buffer.from([137, 80, 78, 71]),
  });
  type Picture = ReturnType<typeof picture>;
  let given: { resolve: (value: Picture) => void; reject: (error: Error) => void } | null = null;
  const contents = {
    id: 7,
    destroyed: false,
    capturePage: vi.fn(() => {
      if (contents.destroyed) throw new TypeError("Object has been destroyed");
      return new Promise<Picture>((resolve, reject) => {
        given = { resolve, reject };
      });
    }),
    isDestroyed: () => contents.destroyed,
    close: () => {
      contents.destroyed = true;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.set(event, listener);
    },
    setWindowOpenHandler: () => undefined,
    loadURL: () => Promise.resolve(),
    loadFile: () => Promise.resolve(),
  };
  /** The window's content height: the hidden window starts as tall as a short screen lets it. */
  const window = { height: 645 };
  return {
    listeners,
    handlers,
    contents,
    window,
    picture,
    /** The compositor gives the picture asked for last. */
    give: (drawn = true) => given?.resolve(picture(drawn)),
    /** The compositor drops the picture asked for last, as it does with "UnknownVizError". */
    drop: () => given?.reject(new Error("UnknownVizError")),
    /** The page paints a frame of `height` CSS pixels, drawn at twice the pixels. */
    paint: (height: number) =>
      events.get("paint")?.({}, {}, { getSize: () => ({ width: 2000, height: height * 2 }) }),
    module: {
      BaseWindow: class {
        contentView = { addChildView: () => undefined };
        isDestroyed = () => false;
        destroy = () => undefined;
        setContentSize = (_width: number, height: number) => {
          window.height = height;
        };
        getContentSize = () => [1000, window.height];
      },
      WebContentsView: class {
        webContents = contents;
        setBounds = () => undefined;
      },
      ipcMain: {
        handle: (channel: string, handler: (event: Sender, ...args: unknown[]) => unknown) =>
          handlers.set(channel, handler),
        on: (channel: string, listener: (event: Sender, ...args: unknown[]) => void) =>
          listeners.set(channel, listener),
      },
    },
  };
});
vi.mock("electron", () => electron.module);

const { createCitedPageCapture } = await import("../../src/main/citedPageCapture");

const logged: { event: string; fields?: LogFields }[] = [];
const keep = (event: string, fields?: LogFields) => {
  logged.push({ event, fields });
};
const capture = createCitedPageCapture({
  rendererUrl: undefined,
  log: { info: keep, warn: keep, error: keep },
});
const sender = { sender: { id: electron.contents.id } };
const docx = { id: "d", kind: "docx" } as Document;

/** Starts drawing a Word section, as the core asks for a cited page. */
function draw(signal = new AbortController().signal) {
  const drawing = capture(
    { document: docx, pageFrom: 1, pageTo: 1, area: { kind: "section" } },
    signal,
  );
  drawing.catch(() => undefined);
  return drawing;
}

/** The page says where the cited area is drawn, from its top to `bottom`. */
const drawn = (bottom: number) =>
  electron.listeners.get(CITED_PAGE_CHANNELS.drawn)?.(sender, {
    rect: { x: 0, y: 0, width: 600, height: bottom },
    text: [],
  });

/** The page asks to be `height` tall to hold the cited area, as the page's script does. */
const grow = (height: number) =>
  electron.handlers.get(CITED_PAGE_CHANNELS.resize)?.(sender, height);

beforeEach(() => {
  vi.useFakeTimers();
  electron.contents.capturePage.mockClear();
  electron.contents.destroyed = false;
  electron.window.height = 645;
  logged.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

// protects=a drawing stopped while its picture is being taken (an Answer starting stops it) takes no picture after; fails_when=the late try reaches the closed window and throws in the main process, whose error box stops the app; no_claim=what is drawn.
test("a drawing stopped while its picture is taken tries no more", async () => {
  const stop = new AbortController();
  const drawing = draw(stop.signal);
  drawn(20);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(electron.contents.capturePage).toHaveBeenCalledTimes(1);

  stop.abort(new Error("An Answer started."));
  await expect(drawing).rejects.toThrow("An Answer started.");
  electron.give();

  await vi.advanceTimersByTimeAsync(5_000);
  expect(electron.contents.capturePage).toHaveBeenCalledTimes(1);
});

// protects=a page that grew to hold its cited area is pictured only once a frame of its new size is painted (#2161); fails_when=the picture is asked for during the compositor's switch to the new size and comes back as UnknownVizError; no_claim=how long the compositor takes.
test("a page that grew is pictured once it has painted a frame of its new size, however late that frame comes", async () => {
  const drawing = draw();
  electron.paint(677);
  expect(grow(840)).toBe(1200);
  drawn(840);
  // A frame of the old size, then none for a long while: no picture is asked for.
  electron.paint(677);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(electron.contents.capturePage).not.toHaveBeenCalled();

  electron.paint(1232);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(electron.contents.capturePage).toHaveBeenCalledTimes(1);
  electron.give();
  await expect(drawing).resolves.toMatchObject({ type: "image/png" });
  expect(logged.at(-1)).toMatchObject({
    event: "citedPage.drawing",
    fields: { kind: "docx", outcome: "drawn", resizes: 1, paints: 3, pictures: 1, failed: 0 },
  });
});

// protects=a page that fits as it is waits for no frame: none may come for a page that stopped changing; fails_when=every page that didn't grow times out; no_claim=what the picture shows.
test("a page that didn't grow is pictured without waiting for a frame", async () => {
  const drawing = draw();
  drawn(400);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(electron.contents.capturePage).toHaveBeenCalledTimes(1);
  electron.give();
  await expect(drawing).resolves.toMatchObject({ type: "image/png" });
});

// protects=a picture the compositor drops is asked for again, and the log keeps the failed attempt apart from the one that worked (#2161); fails_when=one dropped picture loses the page; no_claim=why the compositor dropped it.
test("a picture the compositor drops is asked for again, and the log says so", async () => {
  const drawing = draw();
  drawn(400);
  await vi.advanceTimersByTimeAsync(1_000);
  electron.drop();
  await vi.advanceTimersByTimeAsync(0);
  expect(electron.contents.capturePage).toHaveBeenCalledTimes(2);
  electron.give();

  await expect(drawing).resolves.toMatchObject({ type: "image/png" });
  expect(logged).toEqual([
    {
      event: "citedPage.pictureFailed",
      fields: { kind: "docx", attempt: 1, reason: "UnknownVizError" },
    },
    {
      event: "citedPage.drawing",
      fields: expect.objectContaining({ outcome: "drawn", pictures: 2, failed: 1 }),
    },
  ]);
});

// protects=pictures the compositor keeps dropping are asked for three times, then the drawing fails for the core to try later; fails_when=a compositor that never gives a picture keeps the drawing asking until its time is up, or for ever; no_claim=when the core tries again.
test("a picture dropped three times fails the drawing, and no more is asked for", async () => {
  const drawing = draw();
  drawn(400);
  await vi.advanceTimersByTimeAsync(1_000);
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(electron.contents.capturePage).toHaveBeenCalledTimes(attempt);
    electron.drop();
    await vi.advanceTimersByTimeAsync(0);
  }
  await expect(drawing).rejects.toThrow("UnknownVizError");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(electron.contents.capturePage).toHaveBeenCalledTimes(3);
  expect(logged.at(-1)).toMatchObject({
    event: "citedPage.drawing",
    fields: { outcome: "failed", pictures: 3, failed: 3 },
  });
});
