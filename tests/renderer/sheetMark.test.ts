import { describe, expect, test } from "vitest";
import { placeSheetMark, scrollAcross } from "../../src/renderer/src/viewer/sheetMark";

/** A view under a 24px header row, right of 48px of row numbers. */
const view = { left: 48, top: 24, right: 600, bottom: 500 };
const size = { full: 110, compact: 34, height: 18 };
const row = (top: number, bottom: number) => ({ top, bottom });

const overlaps = (
  mark: { left: number; top: number },
  width: number,
  cells: { left: number; top: number; right: number; bottom: number },
) =>
  mark.left < cells.right &&
  mark.left + width > cells.left &&
  mark.top < cells.bottom &&
  mark.top + 18 > cells.top;

describe("where a sheet Citation's mark goes", () => {
  test("right of the cited cells, level with their first row, with its label", () => {
    const cited = { left: 100, top: 200, right: 300, bottom: 240 };
    expect(placeSheetMark(cited, row(200, 220), view, size)).toEqual({
      left: 308,
      top: 201,
      label: true,
    });
  });

  test("beside the cells without its label when only the number fits on the right", () => {
    const cited = { left: 100, top: 200, right: 520, bottom: 220 };
    expect(placeSheetMark(cited, row(200, 220), view, size)).toEqual({
      left: 528,
      top: 201,
      label: false,
    });
  });

  test("left of the cells when they reach the view's right edge", () => {
    const cited = { left: 300, top: 200, right: 600, bottom: 220 };
    const place = placeSheetMark(cited, row(200, 220), view, size);
    expect(place).toEqual({ left: 182, top: 201, label: true });
    expect(overlaps(place, 110, cited)).toBe(false);
  });

  test("above the cells, at their right end, when they span the view's width", () => {
    const cited = { left: 48, top: 200, right: 600, bottom: 220 };
    const place = placeSheetMark(cited, row(200, 220), view, size);
    expect(place).toEqual({ left: 490, top: 180, label: true });
    expect(overlaps(place, 110, cited)).toBe(false);
  });

  test("below the cells when they span the view's width from its top", () => {
    const cited = { left: 0, top: 24, right: 700, bottom: 64 };
    const place = placeSheetMark(cited, row(24, 44), view, size);
    expect(place).toEqual({ left: 490, top: 66, label: true });
    expect(overlaps(place, 110, cited)).toBe(false);
  });

  test("with no room in view outside the cells, right of them and out of view", () => {
    const cited = { left: 0, top: 0, right: 900, bottom: 900 };
    const place = placeSheetMark(cited, row(0, 20), view, size);
    expect(place.left).toBe(908);
    expect(overlaps(place, 110, cited)).toBe(false);
  });

  test("level with the part of the cited rows in view once their first row scrolls away", () => {
    const cited = { left: 100, top: 0, right: 300, bottom: 300 };
    expect(placeSheetMark(cited, row(0, 20), view, size)).toEqual({
      left: 308,
      top: 24,
      label: true,
    });
  });

  test("never beside rows that are out of view, nor above columns that are", () => {
    const rowsAbove = { left: 100, top: -200, right: 300, bottom: -180 };
    expect(placeSheetMark(rowsAbove, row(-200, -180), view, size).left).toBe(308);
    expect(placeSheetMark(rowsAbove, row(-200, -180), view, size).top).toBeLessThan(24);
    const columnsLeft = { left: -400, top: 200, right: -100, bottom: 220 };
    const place = placeSheetMark(columnsLeft, row(200, 220), view, size);
    expect(place.left).toBe(-92);
  });
});

describe("how far a sheet scrolls across to cited columns", () => {
  test("not at all when the cells and the mark's room fit, keeping column A in view", () => {
    expect(scrollAcross({ left: 0, right: 500 }, 0, 700)).toBe(0);
    expect(scrollAcross({ left: 400, right: 500 }, 0, 700)).toBe(0);
  });

  test("to cells off to the right, with the mark's room after them", () => {
    expect(scrollAcross({ left: 1200, right: 1300 }, 0, 700)).toBe(704);
  });

  test("a narrow view keeps a narrower room for the mark", () => {
    expect(scrollAcross({ left: 1200, right: 1300 }, 0, 500)).toBe(848);
  });

  test("the cells whole, without the room, when only they fit", () => {
    expect(scrollAcross({ left: 0, right: 650 }, 0, 700)).toBe(0);
    expect(scrollAcross({ left: 100, right: 750 }, 0, 700)).toBe(50);
  });

  test("the right end, where a row's figure is, and the mark's room, when the cells are wider than the view", () => {
    // A wide label column and its figure: the figure, then the mark, at the view's right edge.
    expect(scrollAcross({ left: 0, right: 545 }, 0, 470)).toBe(123);
    expect(scrollAcross({ left: 0, right: 1550 }, 0, 700)).toBe(954);
  });

  test("frozen columns stay in view and leave less room", () => {
    expect(scrollAcross({ left: 0, right: 900 }, 200, 700)).toBe(304);
    expect(scrollAcross({ left: 0, right: 650 }, 200, 700)).toBe(0);
    expect(scrollAcross({ left: 900, right: 1000 }, 200, 700)).toBe(404);
  });
});
