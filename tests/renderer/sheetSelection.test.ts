import { describe, expect, test } from "vitest";
import {
  isInRange,
  rangeParts,
  rangeSize,
  rangeTable,
  rangeTsv,
  type SheetRange,
} from "../../src/renderer/src/viewer/sheetSelection";
import { translate } from "../../src/shared/i18n";
import type { TextUnit } from "../../src/shared/units";

/** A sheet's cells by row, from column 0. */
const cells: Record<number, string[]> = {
  4: ["", "Q1", "Q2", "Q3", "9 months"],
  12: ["Stores", "1,431", "1,452", "1,470", "4,353"],
  13: ["Online", "352", "361", "329", "1,042"],
  14: ["Wholesale", "99", "97", "92", "288"],
};
const textOf = (row: number, column: number) => cells[row]?.[column] ?? "";

const range = (over: Partial<SheetRange> = {}): SheetRange => ({
  sheet: "Revenue",
  fromRow: 12,
  toRow: 14,
  fromColumn: 1,
  toColumn: 4,
  headerRow: 4,
  ...over,
});

const units: TextUnit[] = [
  {
    page: 1,
    kind: "rows",
    label: { sheet: "Revenue", from: 4, to: 14, rows: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] },
    text: [
      "\tQ1\tQ2\tQ3\t9 months",
      "2025",
      "",
      "Stores\t1412\t1438\t1446\t4296",
      "Online\t318\t326\t341\t985",
      "Wholesale\t96\t98\t101\t295",
      "",
      "2026",
      "Stores\t1431\t1452\t1470\t4353",
      "Online\t352\t361\t329\t1042",
      "Wholesale\t99\t97\t92\t288",
    ].join("\n"),
    anchors: null,
  },
];

describe("A range of cells in a sheet (#118)", () => {
  test("comes with its sheet's header row, which is outside the selected rows", () => {
    expect(rangeTable(range(), textOf)).toEqual({
      header: ["Q1", "Q2", "Q3", "9 months"],
      rows: [
        ["1,431", "1,452", "1,470", "4,353"],
        ["352", "361", "329", "1,042"],
        ["99", "97", "92", "288"],
      ],
    });
  });

  test("has no second header when the header row is one of the rows selected", () => {
    expect(rangeTable(range({ fromRow: 4, toRow: 4 }), textOf)).toEqual({
      header: null,
      rows: [["Q1", "Q2", "Q3", "9 months"]],
    });
  });

  test("is cited as its rows as the Document stores them, one part for each Unit", () => {
    expect(rangeParts(range(), units)).toEqual([
      {
        unit: 1,
        text: "Stores\t1431\t1452\t1470\t4353\nOnline\t352\t361\t329\t1042\nWholesale\t99\t97\t92\t288",
      },
    ]);
  });

  test("is cited in the Units of its own rows only, and nothing empty", () => {
    expect(rangeParts(range(), units)).toHaveLength(1);
    expect(rangeParts(range({ fromRow: 20, toRow: 22 }), units)).toEqual([]);
  });

  test("reads a later block's rows from its own lines, the repeated header line first", () => {
    // A Unit after the first repeats the sheet's header as its first row and line (#118).
    const later: TextUnit = {
      page: 2,
      kind: "rows",
      label: { sheet: "Revenue", from: 51, to: 53, rows: [4, 51, 52, 53], header: true },
      text: ["\tQ1\tQ2", "row 51", "row 52", "row 53"].join("\n"),
      anchors: null,
    };
    // A part that starts at the block's first row starts with the header line before it in the text.
    expect(rangeParts(range({ fromRow: 51, toRow: 52 }), [later])).toEqual([
      { unit: 2, text: "\tQ1\tQ2\nrow 51\nrow 52" },
    ]);
    // Only the header row is selected, and that row belongs to the first block: this one adds nothing.
    expect(rangeParts(range({ fromRow: 4, toRow: 4 }), [later])).toEqual([]);
    // A part inside the block doesn't take the far-away header line.
    expect(rangeParts(range({ fromRow: 52, toRow: 53 }), [later])).toEqual([
      { unit: 2, text: "row 52\nrow 53" },
    ]);
  });

  test("a range that takes the header row selects only the blocks whose own rows it takes", () => {
    const block = (page: number, from: number, to: number, header: boolean): TextUnit => ({
      page,
      kind: "rows",
      label: {
        sheet: "Revenue",
        from,
        to,
        rows: header
          ? [1, ...Array.from({ length: to - from + 1 }, (_, at) => from + at)]
          : Array.from({ length: to - from + 1 }, (_, at) => from + at),
        ...(header && { header: true }),
      },
      text: [
        ...(header ? ["\tQ1\tQ2"] : []),
        ...Array.from({ length: to - from + 1 }, (_, at) => `row ${from + at}`),
      ].join("\n"),
      anchors: null,
    });
    const three = [block(1, 1, 100, false), block(2, 101, 194, true), block(3, 195, 221, true)];
    expect(rangeParts(range({ fromRow: 1, toRow: 1 }), three)).toEqual([
      { unit: 1, text: "row 1" },
    ]);
    expect(rangeParts(range({ fromRow: 1, toRow: 5 }), three)).toEqual([
      { unit: 1, text: "row 1\nrow 2\nrow 3\nrow 4\nrow 5" },
    ]);
    expect(rangeParts(range({ fromRow: 1, toRow: 100 }), three)).toEqual([
      {
        unit: 1,
        text: Array.from({ length: 100 }, (_, at) => `row ${at + 1}`).join("\n"),
      },
    ]);
    const overTwo = rangeParts(range({ fromRow: 1, toRow: 150 }), three);
    expect(overTwo.map((part) => part.unit)).toEqual([1, 2]);
    expect(overTwo[1]?.text).toBe(
      "\tQ1\tQ2\n" + Array.from({ length: 50 }, (_, at) => `row ${101 + at}`).join("\n"),
    );
  });

  test("crosses blocks of 100 rows, each part taking its own lines and no row twice", () => {
    const block = (page: number, from: number, to: number, header: boolean): TextUnit => ({
      page,
      kind: "rows",
      label: {
        sheet: "Revenue",
        from,
        to,
        rows: header
          ? [1, ...Array.from({ length: to - from + 1 }, (_, at) => from + at)]
          : Array.from({ length: to - from + 1 }, (_, at) => from + at),
        ...(header && { header: true }),
      },
      text: [
        ...(header ? ["\tQ1\tQ2"] : []),
        ...Array.from({ length: to - from + 1 }, (_, at) => `row ${from + at}`),
      ].join("\n"),
      anchors: null,
    });
    const two = [block(1, 1, 100, false), block(2, 101, 151, true)];
    expect(rangeParts(range({ fromRow: 99, toRow: 102 }), two)).toEqual([
      { unit: 1, text: "row 99\nrow 100" },
      { unit: 2, text: "\tQ1\tQ2\nrow 101\nrow 102" },
    ]);
  });

  test("reads 150 rows over two blocks, each part with its own lines", () => {
    const block = (page: number, from: number, to: number, header: boolean): TextUnit => ({
      page,
      kind: "rows",
      label: {
        sheet: "Revenue",
        from,
        to,
        rows: header
          ? [1, ...Array.from({ length: to - from + 1 }, (_, at) => from + at)]
          : Array.from({ length: to - from + 1 }, (_, at) => from + at),
        ...(header && { header: true }),
      },
      text: [
        ...(header ? ["\tQ1\tQ2"] : []),
        ...Array.from({ length: to - from + 1 }, (_, at) => `row ${from + at}`),
      ].join("\n"),
      anchors: null,
    });
    const two = [block(1, 1, 100, false), block(2, 101, 151, true)];
    const parts = rangeParts(range({ fromRow: 1, toRow: 150 }), two);
    expect(parts.map((part) => part.unit)).toEqual([1, 2]);
    const lines = parts.map((part) => part.text.split("\n"));
    expect(lines[0]).toHaveLength(100);
    expect(lines[0]?.[0]).toBe("row 1");
    expect(lines[0]?.at(-1)).toBe("row 100");
    // Row 1 is the sheet's header: the range includes it, and the later block opens with its line.
    expect(lines[1]).toHaveLength(51);
    expect(lines[1]?.[0]).toBe("\tQ1\tQ2");
    expect(lines[1]?.[1]).toBe("row 101");
    expect(lines[1]?.at(-1)).toBe("row 150");
  });

  test("copies as TSV with its header row first", () => {
    expect(rangeTsv(rangeTable(range(), textOf))).toBe(
      "Q1\tQ2\tQ3\t9 months\n1,431\t1,452\t1,470\t4,353\n352\t361\t329\t1,042\n99\t97\t92\t288",
    );
  });

  test("says how many rows and columns it is, in English and Chinese", () => {
    expect(rangeSize(range(), (key, params) => translate("en", key, params)).text).toBe(
      "3 rows × 4 columns",
    );
    expect(rangeSize(range(), (key, params) => translate("zh-CN", key, params)).text).toBe(
      "3 行 × 4 列",
    );
    expect(
      rangeSize(range({ toRow: 12 }), (key, params) => translate("en", key, params)).text,
    ).toBe("1 row × 4 columns");
  });

  test("knows which cell is in it", () => {
    expect(isInRange(range(), 12, 1)).toBe(true);
    expect(isInRange(range(), 14, 4)).toBe(true);
    expect(isInRange(range(), 11, 4)).toBe(false);
    expect(isInRange(range(), 14, 5)).toBe(false);
  });
});
