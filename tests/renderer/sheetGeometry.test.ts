import { describe, expect, test } from "vitest";
import type { CellStyle } from "../../src/core/documents/formats/xlsxStyles";
import {
  Axis,
  borderCss,
  cellEdges,
  fontCss,
  fontFamily,
  rowHeightFor,
} from "../../src/renderer/src/viewer/sheetGeometry";

describe("a sheet's rows and columns", () => {
  test("an axis of default sizes, with some set and some hidden", () => {
    // Rows 1–10, 20px each, row 3 is 40px and row 5 hidden.
    const rows = new Axis(
      1,
      10,
      20,
      new Map([
        [3, 40],
        [5, 0],
      ]),
    );
    expect(rows.size(3)).toBe(40);
    expect(rows.size(5)).toBe(0);
    expect(rows.start(1)).toBe(0);
    expect(rows.start(4)).toBe(80);
    expect(rows.start(6)).toBe(100);
    expect(rows.total).toBe(200);
    // The row at an offset; a hidden one is never it.
    expect(rows.indexAt(0)).toBe(1);
    expect(rows.indexAt(45)).toBe(3);
    expect(rows.indexAt(99.5)).toBe(4);
    expect(rows.indexAt(100)).toBe(6);
    expect(rows.indexAt(120)).toBe(7);
    expect(rows.indexAt(10_000)).toBe(10);
    expect(rows.visible(4, 7)).toEqual([4, 6, 7]);
  });

  test("a huge axis stays cheap: offsets come from the few sizes set", () => {
    const rows = new Axis(1, 1_000_000, 20, new Map([[500_000, 100]]));
    expect(rows.start(500_001)).toBe(500_000 * 20 + 80);
    expect(rows.indexAt(500_000 * 20 + 50)).toBe(500_001 - 1);
    expect(rows.total).toBe(1_000_000 * 20 + 80);
  });

  test("a row grows to fit a larger font or wrapped text when the file sets no height", () => {
    expect(rowHeightFor(11, 1)).toBe(20);
    expect(rowHeightFor(14, 1)).toBe(25);
    expect(rowHeightFor(11, 3)).toBe(60);
  });
});

describe("a cell's look", () => {
  const style = (extra: Partial<CellStyle>): CellStyle => ({ font: {}, border: {}, ...extra });

  test("Office fonts fall back to the app's own of the same kind", () => {
    expect(fontFamily("Calibri")).toBe('"IncarnaMind Office Calibri", var(--font-sans)');
    expect(fontFamily("Times New Roman")).toBe('"Times New Roman", var(--font-serif)');
    expect(fontFamily("Consolas")).toBe('"Consolas", var(--font-mono)');
    expect(fontFamily(undefined)).toBe("var(--font-sans)");
  });

  test("a font as CSS: size in pixels, weight, slant, lines, colour", () => {
    expect(
      fontCss({
        name: "Georgia",
        size: 14,
        bold: true,
        italic: true,
        underline: "double",
        strike: true,
        color: "#C00000",
      }),
    ).toEqual({
      fontFamily: '"Georgia", var(--font-serif)',
      fontSize: "18.67px",
      fontWeight: 700,
      fontStyle: "italic",
      textDecorationLine: "underline line-through",
      textDecorationStyle: "double",
      color: "#C00000",
    });
    expect(fontCss({ size: 11 })).toEqual({ fontSize: "14.67px" });
  });

  test("Excel's line styles as CSS borders", () => {
    expect(borderCss({ style: "thin", color: "#000000" })).toBe("1px solid #000000");
    expect(borderCss({ style: "medium", color: "#0000FF" })).toBe("2px solid #0000FF");
    expect(borderCss({ style: "thick", color: "#000000" })).toBe("3px solid #000000");
    expect(borderCss({ style: "double", color: "#000000" })).toBe("3px double #000000");
    expect(borderCss({ style: "dashed", color: "#000000" })).toBe("1px dashed #000000");
    expect(borderCss({ style: "hair", color: "#000000" })).toBe("1px dotted #000000");
  });

  test("each edge between two cells is drawn once: a border from either side, else a gridline unless a fill covers it", () => {
    const thin = { style: "thin", color: "#000000" };
    const cells = new Map<string, CellStyle>([
      ["A1", style({ border: { right: thin } })],
      ["C1", style({ border: { left: { style: "medium", color: "#FF0000" } } })],
      ["A2", style({ fill: "#FFFF00" })],
    ]);
    const at = (ref: string) => cells.get(ref);
    // A1's right edge is its own border.
    expect(cellEdges(at("A1"), at("B1"), at("A2"), true)).toEqual({
      right: thin,
      bottom: null,
    });
    // B1's right edge is C1's left border; its bottom a gridline.
    expect(cellEdges(at("B1"), at("C1"), at("B2"), true)).toEqual({
      right: { style: "medium", color: "#FF0000" },
      bottom: "grid",
    });
    // B2 meets the fill of A2 on its left, which is A2's right edge: no gridline there.
    expect(cellEdges(at("A2"), at("B2"), at("A3"), true)).toEqual({ right: null, bottom: null });
    expect(cellEdges(at("B2"), at("C2"), at("B3"), true)).toEqual({
      right: "grid",
      bottom: "grid",
    });
    // Gridlines off.
    expect(cellEdges(at("B2"), at("C2"), at("B3"), false)).toEqual({ right: null, bottom: null });
  });
});
