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
