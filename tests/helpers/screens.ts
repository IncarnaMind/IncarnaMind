/**
 * A Meeting's shared window, scripted (ADR-0031): a fake `ScreenCapture` that
 * shows one slide at a time, sampled when the test says, and a text
 * recogniser that reads each slide's lines from its picture. No window or
 * model is involved: a slide's number is written in its picture's pixels.
 */
import {
  type CoreAdapters,
  type PagePicture,
  type RecognizedLine,
  type ScreenCapture,
  ScreenCaptureError,
  type ScreenPermission,
  type ScreenSink,
  type TextRecognizer,
} from "../../src/core";
import { NO_MODEL_FILES } from "./core";

/** A slide's lines; a figure read differently the second time is `[first, second]`. */
export type SlideLine = string | { first: string; second: string };

/** What each slide shows, by its number from 1. */
export type Slides = Record<number, SlideLine[]>;

const THUMBNAIL = { width: 96, height: 54 };
const PICTURE = { width: 640, height: 360 };

const thumbnailOf = (slide: number, cursor: boolean): PagePicture => {
  const pixels = new Uint8Array(THUMBNAIL.width * THUMBNAIL.height).fill((slide * 60) % 256);
  // A cursor is a pixel or two: not a change worth reading.
  if (cursor) pixels[5] = 255 - (pixels[5] ?? 0);
  return { ...THUMBNAIL, pixels };
};

/** A slide's picture: its number in the first pixel, and in the second how many frames were grabbed. */
const pictureOf = (slide: number, frame: number, still: boolean): PagePicture => {
  const pixels = new Uint8Array(PICTURE.width * PICTURE.height);
  pixels[0] = slide;
  pixels[1] = still ? 0 : frame % 256;
  return { ...PICTURE, pixels };
};

export interface FakeScreenOptions {
  /** macOS's Screen Recording: given (by default), not asked yet, or refused when asked. */
  permission?: "granted" | "not-asked" | "refused";
  /** What choosing a window does: it is read (by default), or refused. */
  refuse?: "whole-screen" | "denied";
  /** Each frame differs a little from the one before, as screen-share video does: it is read twice. */
  noisy?: boolean;
}

export function fakeScreen(options: FakeScreenOptions = {}) {
  let sink: ScreenSink | null = null;
  let slide = 1;
  let grabs = 0;
  let started = 0;
  let cursor = false;

  let permission: ScreenPermission =
    options.permission === "refused" ? "not-asked" : (options.permission ?? "granted");
  let listed = 0;

  const capture: ScreenCapture = {
    permission: () => permission,
    async windows() {
      listed++;
      // The first listing asks: the User answers.
      if (permission === "not-asked") {
        permission = options.permission === "refused" ? "denied" : "granted";
      }
      if (permission === "denied") throw new ScreenCaptureError("denied", "Not allowed.");
      return [{ id: "zoom", name: "Zoom Meeting", thumbnail: "" }];
    },
    async start(_window, given) {
      if (options.refuse) throw new ScreenCaptureError(options.refuse, "Refused.");
      started++;
      sink = given;
      return {
        name: "Zoom Meeting",
        async grab() {
          grabs++;
          return {
            picture: pictureOf(slide, grabs, !options.noisy),
            image: { bytes: 3, jpeg: () => new Uint8Array([0xff, 0xd8, slide]) },
          };
        },
        stop() {
          if (sink === given) sink = null;
        },
      };
    },
  };

  return {
    capture,
    /** The shared window shows this slide now. */
    show(next: number) {
      slide = next;
    },
    /** A cursor moves over the slide. */
    moveCursor() {
      cursor = !cursor;
    },
    /** The window's capture sends a thumbnail of what it shows now. */
    sample() {
      sink?.sample(thumbnailOf(slide, cursor));
    },
    /** The shared window closes. */
    close() {
      const given = sink;
      sink = null;
      given?.ended();
    },
    get capturing() {
      return sink !== null;
    },
    get started() {
      return started;
    },
    /** How many times the windows were listed: the first asks for the permission. */
    get listed() {
      return listed;
    },
    get grabs() {
      return grabs;
    },
  };
}

/** A text recogniser that reads the slide a picture shows, line by line down it, sure of every character. */
export function slideReader(slides: Slides): TextRecognizer & { readonly reads: number } {
  let reads = 0;
  return {
    async load() {},
    async readFile() {
      throw new Error("The shared window supplies pixels.");
    },
    async read(picture) {
      reads++;
      const slide = picture.pixels[0] ?? 0;
      // A noisy window's frames are numbered: each reading's second frame is an even one.
      const frame = picture.pixels[1] ?? 0;
      const second = frame > 0 && frame % 2 === 0;
      return (slides[slide] ?? []).map((line, index): RecognizedLine => {
        const text = typeof line === "string" ? line : second ? line.second : line.first;
        const top = 20 + index * 40;
        return {
          text,
          quad: [
            [40, top],
            [40 + 12 * [...text].length, top],
            [40 + 12 * [...text].length, top + 28],
            [40, top + 28],
          ],
          confidence: 0.98,
          characters: [...text].map((character, at, all) => ({
            text: character,
            confidence: 0.98,
            at: (at + 0.5) / all.length,
          })),
        };
      });
    },
    close() {},
    get reads() {
      return reads;
    },
  };
}

/** The adapters a core needs to read a shared window: the fake capture, and the slide reader. */
export const screenAdapters = (
  capture: ScreenCapture,
  reader: TextRecognizer,
): Partial<CoreAdapters> => ({
  screenCapture: capture,
  textRecognizer: reader,
  textRecognitionModelSource: NO_MODEL_FILES,
});
