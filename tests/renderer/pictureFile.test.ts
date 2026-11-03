import { describe, expect, test } from "vitest";
import {
  isHeicPicture,
  keptFormat,
  PICTURE_MAX_EDGE,
  scaledPictureSize,
} from "../../src/renderer/src/pictureFile";

describe("How a picture is kept in a Note (#1937)", () => {
  test("a picture is drawn no longer than the Note keeps it, its shape held", () => {
    expect(scaledPictureSize(6000, 4000)).toEqual({ width: PICTURE_MAX_EDGE, height: 1067 });
    expect(scaledPictureSize(4000, 6000)).toEqual({ width: 1067, height: PICTURE_MAX_EDGE });
    expect(scaledPictureSize(1200, 800)).toEqual({ width: 1200, height: 800 });
    // Never enlarged, and never less than a pixel.
    expect(scaledPictureSize(1, 1)).toEqual({ width: 1, height: 1 });
    expect(scaledPictureSize(1, 9000, 1600)).toEqual({ width: 1, height: 1600 });
  });

  test("a picture with see-through parts is kept as PNG, any other as JPEG", () => {
    expect(keptFormat(true)).toEqual({ mediaType: "image/png", extension: "png" });
    expect(keptFormat(false)).toEqual({ mediaType: "image/jpeg", extension: "jpg" });
  });

  test("a HEIC is known by its type or its name, which the web engine alone can't read", () => {
    expect(isHeicPicture(new Blob([], { type: "image/heic" }))).toBe(true);
    expect(isHeicPicture(Object.assign(new Blob([]), { name: "IMG_2204.HEIF" }))).toBe(true);
    expect(isHeicPicture(new Blob([], { type: "image/png" }))).toBe(false);
    expect(isHeicPicture(Object.assign(new Blob([]), { name: "chart.jpg" }))).toBe(false);
  });
});
