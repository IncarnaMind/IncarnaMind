/**
 * When a shared window is worth reading (ADR-0031), from the small grey
 * thumbnails its capture sends about once a second. Most of a call shows the
 * same slide, so almost nothing is read: a picture is read once it differs
 * from the last one read and has then stayed still for `STILL_MS`, because
 * screen-share video sharpens once the image settles and a blurry frame
 * misreads digits. Parts of the window that keep changing, such as a video
 * tile, a spinner or a blinking cursor, are left out of both comparisons.
 * Pure: the times are the samples'.
 */
import type { PagePicture } from "../adapters";

/** How long a changed picture must stay still before it is read. */
export const STILL_MS = 1500;

/** A thumbnail's pixel differs from another's by more than this many grey levels: video noise is less. */
const PIXEL_DIFFERS = 12;
/** How fast a pixel's record of changing follows its samples: from 0 (never) to 1 (only the last one). */
const MOTION_WEIGHT = 0.3;
/** A pixel that changed in most recent samples is a moving part, such as a video tile. */
const MOVING = 0.5;
/** The share of the steady pixels that may change, a cursor say, for the picture to count as still. */
const STILL_SHARE = 0.003;
/** The share of the steady pixels, and how many at least, that must differ from the last picture read. */
const CHANGED_SHARE = 0.01;
const CHANGED_PIXELS = 6;

export interface ScreenChanges {
  /** Takes a thumbnail sampled at `at` (ms): true when it is time to read the window. */
  sample(thumbnail: PagePicture, at: number): boolean;
  /** The window was read as this thumbnail shows it: later ones are compared with it. */
  read(thumbnail: PagePicture): void;
  /** When the picture last changed, in ms; null before any sample. */
  readonly changedAt: number | null;
}

const sameSize = (a: PagePicture, b: PagePicture) => a.width === b.width && a.height === b.height;

export function createScreenChanges(): ScreenChanges {
  let previous: PagePicture | null = null;
  let reference: PagePicture | null = null;
  let changedAt: number | null = null;
  /** For each pixel, how often it has changed lately, from 0 to 1. */
  let motion = new Float32Array(0);

  const steady = (index: number) => (motion[index] ?? 0) < MOVING;

  /** How many of the steady pixels differ between two thumbnails of one size, and how many are steady. */
  function differing(a: PagePicture, b: PagePicture): { count: number; steady: number } {
    let count = 0;
    let steadyPixels = 0;
    for (let index = 0; index < a.pixels.length; index++) {
      if (!steady(index)) continue;
      steadyPixels++;
      if (Math.abs((a.pixels[index] ?? 0) - (b.pixels[index] ?? 0)) > PIXEL_DIFFERS) count++;
    }
    return { count, steady: steadyPixels };
  }

  return {
    sample(thumbnail, at) {
      const before = previous;
      previous = thumbnail;
      if (!before || !sameSize(before, thumbnail)) {
        motion = new Float32Array(thumbnail.pixels.length);
        changedAt = at;
        return false;
      }
      const moved = differing(before, thumbnail);
      for (let index = 0; index < thumbnail.pixels.length; index++) {
        const changed =
          Math.abs((before.pixels[index] ?? 0) - (thumbnail.pixels[index] ?? 0)) > PIXEL_DIFFERS;
        motion[index] = (motion[index] ?? 0) * (1 - MOTION_WEIGHT) + (changed ? MOTION_WEIGHT : 0);
      }
      if (moved.count > Math.max(1, moved.steady * STILL_SHARE)) changedAt = at;
      if (changedAt === null || at - changedAt < STILL_MS) return false;
      if (!reference || !sameSize(reference, thumbnail)) return true;
      const changed = differing(reference, thumbnail);
      return changed.count >= Math.max(CHANGED_PIXELS, changed.steady * CHANGED_SHARE);
    },

    read(thumbnail) {
      reference = thumbnail;
    },

    get changedAt() {
      return changedAt;
    },
  };
}
