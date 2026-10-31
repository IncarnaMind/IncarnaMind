import { describe, expect, test } from "vitest";
import {
  MARK_GAP,
  MARK_HEIGHT,
  placeMarginMarks,
  revealOrder,
} from "../../src/renderer/src/editor/marginMarks";

/*
 * The check marks in the Mind's right margin (DESIGN.md, Check marks): each level
 * with the line its sentence starts on; sentences that start on one line put their
 * marks side by side, and one that would pass the pane's edge goes under the
 * line's first mark. Asserted by relation: whose top and left each mark takes.
 */

const GAP = 8;

/** A sentence starting on its line, at `middle`, with its mark `width` wide. */
const mark = (middle: number, left: number, width = 19, { silent = false, line = 22 } = {}) => ({
  top: middle - line / 2,
  bottom: middle + line / 2,
  middle,
  left,
  width,
  silent,
});

const lineTop = (middle: number) => middle - MARK_HEIGHT / 2;

describe("The marks of a line", () => {
  test("two sentences that start on one line stand side by side, level, 4px apart", () => {
    const spots = placeMarginMarks([mark(111, 40), mark(111, 300, 24)], { gap: GAP, edge: 300 });
    expect(spots[0]).toEqual({ top: lineTop(111), left: GAP });
    // The second starts a mark's width and 4px after the first.
    expect(spots[1]).toEqual({ top: lineTop(111), left: GAP + 19 + MARK_GAP });
  });

  test("stand in reading order, whatever order they were measured in", () => {
    const spots = placeMarginMarks([mark(111, 300, 24), mark(111, 40, 19)], {
      gap: GAP,
      edge: 300,
    });
    expect(spots[1]).toEqual({ top: lineTop(111), left: GAP });
    expect(spots[0]).toEqual({ top: lineTop(111), left: GAP + 19 + MARK_GAP });
  });

  test("a third mark that would pass the pane's edge goes under the first, 4px below it", () => {
    const spots = placeMarginMarks([mark(111, 40), mark(111, 120), mark(111, 200)], {
      gap: GAP,
      edge: 60,
    });
    expect(spots[0]).toEqual({ top: lineTop(111), left: GAP });
    expect(spots[1]).toEqual({ top: lineTop(111), left: GAP + 19 + MARK_GAP });
    expect(spots[2]).toEqual({
      top: lineTop(111) + MARK_HEIGHT + MARK_GAP,
      left: GAP,
    });
  });

  test("a mark that renders wider moves the next one along", () => {
    const plain = placeMarginMarks([mark(111, 40, 19), mark(111, 120, 19)], {
      gap: GAP,
      edge: 300,
    });
    const wider = placeMarginMarks([mark(111, 40, 27), mark(111, 120, 19)], {
      gap: GAP,
      edge: 300,
    });
    expect(plain[1]?.left).toBe(GAP + 19 + MARK_GAP);
    expect(wider[1]?.left).toBe(GAP + 27 + MARK_GAP);
  });

  test("once one mark wraps, every later mark wraps under it, in reading order", () => {
    const spots = placeMarginMarks(
      [mark(111, 40, 19), mark(111, 120, 19), mark(111, 200, 5), mark(111, 280, 5)],
      { gap: GAP, edge: 40 },
    );
    const top = lineTop(111);
    expect(spots[0]).toEqual({ top, left: GAP });
    // The third and fourth would fit after the first, but the line keeps its reading order.
    expect(spots[2]?.left).toBe(GAP);
    expect(spots[3]?.left).toBe(GAP);
    expect(spots[1]?.top).toBe(top + MARK_HEIGHT + MARK_GAP);
    expect(spots[2]?.top).toBe(top + 2 * (MARK_HEIGHT + MARK_GAP));
    expect(spots[3]?.top).toBe(top + 3 * (MARK_HEIGHT + MARK_GAP));
  });

  test("a mark that ends exactly 8px inside the pane stays on the line; one nearer goes under", () => {
    const marks = [mark(111, 40, 10), mark(111, 120, 9)];
    expect(placeMarginMarks(marks, { gap: GAP, edge: GAP + 10 + MARK_GAP + 9 })[1]).toEqual({
      top: lineTop(111),
      left: GAP + 10 + MARK_GAP,
    });
    expect(placeMarginMarks(marks, { gap: GAP, edge: GAP + 10 + MARK_GAP + 8 })[1]).toEqual({
      top: lineTop(111) + MARK_HEIGHT + MARK_GAP,
      left: GAP,
    });
  });

  test("a sentence not checked yet takes no room on the line", () => {
    const spots = placeMarginMarks(
      [mark(111, 40), mark(111, 120, 24, { silent: true }), mark(111, 200, 24)],
      { gap: GAP, edge: 300 },
    );
    expect(spots[0]?.left).toBe(GAP);
    expect(spots[2]?.left).toBe(GAP + 19 + MARK_GAP);
  });
});

describe("A mark further down", () => {
  test("keeps its line's top until the mark above would overlap it, then moves down", () => {
    const spots = placeMarginMarks([mark(111, 40), mark(140, 40), mark(155, 40)], {
      gap: GAP,
      edge: 300,
    });
    const above = lineTop(111) + MARK_HEIGHT;
    expect(spots[1]).toEqual({ top: lineTop(140), left: GAP });
    expect(spots[1]?.top).toBeGreaterThanOrEqual(above + MARK_GAP);
    expect(spots[2]).toEqual({ top: lineTop(140) + MARK_HEIGHT + MARK_GAP, left: GAP });
  });

  test("moves its whole line down together, so the line's marks stay level", () => {
    const spots = placeMarginMarks(
      [mark(111, 40, 24), mark(111, 120, 24), mark(125, 40), mark(125, 120)],
      { gap: GAP, edge: 50 },
    );
    // The first line's second mark wraps under its first, its bottom below the next line's top.
    expect(spots[1]?.top).toBe(lineTop(111) + MARK_HEIGHT + MARK_GAP);
    expect(spots[2]?.top).toBe(spots[3]?.top);
    expect(spots[2]?.top).toBe((spots[1]?.top ?? 0) + MARK_HEIGHT + MARK_GAP);
    expect(spots[2]?.left).toBe(GAP);
    expect(spots[3]?.left).toBe(GAP + 19 + MARK_GAP);
  });
});

describe("The reveal", () => {
  test("comes top to bottom, then left to right within a line", () => {
    const order = revealOrder([
      { top: 40, left: 60 },
      { top: 0, left: 60 },
      { top: 40, left: 8 },
      { top: 0, left: 8 },
    ]);
    expect(order).toEqual([
      { top: 0, left: 8 },
      { top: 0, left: 60 },
      { top: 40, left: 8 },
      { top: 40, left: 60 },
    ]);
  });
});
