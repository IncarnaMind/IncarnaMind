import { describe, expect, test } from "vitest";
import { lineBoxes } from "../../src/renderer/src/editor/lineBoxes";

/* The outline of a sentence whose check card is open: one box for each line it covers. */

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
});

describe("The boxes of a sentence's outline", () => {
  test("are one to a line, top to bottom, standing 3px out from the words", () => {
    const boxes = lineBoxes([box(300, 82, 120, 22), box(40, 54, 380, 22), box(40, 26, 380, 22)]);
    expect(boxes).toEqual([box(37, 23, 386, 28), box(37, 51, 386, 28), box(297, 79, 126, 28)]);
  });

  test("hold a line's words and its Citation markers together, though a marker is shorter", () => {
    const boxes = lineBoxes([box(40, 26, 300, 22), box(344, 28, 22, 18), box(369, 26, 40, 22)]);
    expect(boxes).toEqual([box(37, 23, 375, 28)]);
  });

  test("leave out what has no size, such as the end of a line where it wraps", () => {
    expect(lineBoxes([box(40, 26, 0, 22), box(40, 26, 100, 0)])).toEqual([]);
  });

  test("keep two lines apart when they only touch", () => {
    expect(lineBoxes([box(40, 26, 100, 22), box(40, 48, 100, 22)])).toHaveLength(2);
  });
});
