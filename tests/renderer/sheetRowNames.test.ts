import { describe, expect, test } from "vitest";
import type { Cell, Sheet } from "../../src/core/documents/formats/grid";
import { cellIndex, type SheetLayout } from "../../src/core/documents/formats/sheetLayout";
import {
  cellsOn,
  citedRowNames,
  shortRowName,
  withRowNames,
} from "../../src/renderer/src/viewer/sheetRowNames";

const text = (row: number, column: number, value: string): Cell => ({
  row,
  column,
  value,
  numeric: false,
});
const figure = (row: number, column: number, value: string): Cell => ({
  row,
  column,
  value,
  numeric: true,
});

function sheetOf(cells: Cell[], merges: string[] = [], layout?: Partial<SheetLayout>): Sheet {
  return {
    name: "Trial balance",
    cells,
    merges,
    rowCount: 20,
    columnCount: 6,
    columnWidths: [],
    ...(layout && {
      layout: {
        styles: new Map(),
        shown: new Map(),
        runs: new Map(),
        centred: new Set(),
        noValue: new Set(),
        notes: new Map(),
        rows: new Map(),
        columns: new Map(),
        defaultRowHeight: 20,
        defaultColumnWidth: 64,
        showGridLines: true,
        frozen: null,
        drawings: [],
        extent: { rows: 0, columns: 0 },
        ...layout,
      },
    }),
  };
}

const trialBalance = sheetOf([
  text(7, 0, "4007"),
  text(7, 1, "Cash at bank"),
  figure(7, 2, "700.25"),
  figure(7, 3, "84,317.52"),
  figure(8, 0, "4008"),
  text(8, 1, "Trade debtors"),
  figure(8, 2, "800.25"),
  figure(8, 3, "12.48"),
  figure(9, 0, "4009"),
  figure(9, 2, "900.25"),
]);

describe("the rows a quote covers, each with its name", () => {
  test("a row quoted whole is named by its first text left of its figures", () => {
    expect(citedRowNames(trialBalance, ["A7", "B7", "C7", "D7"])).toEqual([
      { row: 7, name: "Cash at bank" },
    ]);
  });

  test("an account code stored as a number doesn't hide the name beside it", () => {
    expect(citedRowNames(trialBalance, ["A8", "B8", "C8", "D8"])).toEqual([
      { row: 8, name: "Trade debtors" },
    ]);
  });

  test("a figure quoted alone is named by the text left of it", () => {
    expect(citedRowNames(trialBalance, ["D7"])).toEqual([{ row: 7, name: "Cash at bank" }]);
  });

  test("several rows, each with its own name or none, in row order", () => {
    expect(citedRowNames(trialBalance, ["C9", "D8", "C7"])).toEqual([
      { row: 7, name: "Cash at bank" },
      { row: 8, name: "Trade debtors" },
      { row: 9, name: null },
    ]);
  });

  test("a quote of text only has no name", () => {
    expect(citedRowNames(trialBalance, ["B8"])).toEqual([{ row: 8, name: null }]);
  });

  test("a text code, a note reference and a currency beside the name don't stand in for it", () => {
    const sheet = sheetOf([
      text(4, 0, "AR01"),
      text(4, 1, "Rent"),
      text(4, 2, "Note 12"),
      text(4, 3, "USD"),
      text(4, 4, "BS-1200"),
      figure(4, 5, "10.00"),
    ]);
    expect(citedRowNames(sheet, ["A4", "B4", "C4", "D4", "E4", "F4"])).toEqual([
      { row: 4, name: "Rent" },
    ]);
  });

  test("figures stored as text are figures", () => {
    const sheet = sheetOf([text(4, 0, "Rent"), text(4, 1, "1,200"), text(4, 2, "(300)")]);
    expect(citedRowNames(sheet, ["B4", "C4"])).toEqual([{ row: 4, name: "Rent" }]);
  });

  test("a quote of text only has no name, even with text left of it", () => {
    const sheet = sheetOf([text(4, 0, "Rent"), text(4, 1, "Paid monthly"), figure(4, 2, "1.00")]);
    expect(citedRowNames(sheet, ["B4"])).toEqual([{ row: 4, name: null }]);
  });

  test("text that names nothing is passed over", () => {
    for (const filler of [
      "-",
      "n/a",
      "N/A",
      "n.a.",
      "Nil",
      "n/m",
      "#N/A",
      "#REF!",
      "#DIV/0!",
      "#GETTING_DATA",
      "TRUE",
      "1,200",
      "2026",
    ]) {
      const sheet = sheetOf([text(4, 0, "Rent"), text(4, 1, filler), figure(4, 2, "10.00")]);
      expect(citedRowNames(sheet, ["C4"]), filler).toEqual([{ row: 4, name: "Rent" }]);
    }
  });

  test("a hidden column and text its number format hides are passed over", () => {
    const sheet = sheetOf(
      [text(4, 0, "Rent"), text(4, 1, "Old code"), text(4, 2, "Secret"), figure(4, 3, "10.00")],
      [],
      {
        columns: new Map([[1, { hidden: true }]]),
        shown: new Map([[cellIndex(4, 2), { text: "" }]]),
      },
    );
    expect(citedRowNames(sheet, ["D4"])).toEqual([{ row: 4, name: "Rent" }]);
  });

  test("a name's line breaks become spaces", () => {
    const sheet = sheetOf([text(4, 0, "Cash at\nbank "), figure(4, 1, "10.00")]);
    expect(citedRowNames(sheet, ["B4"])).toEqual([{ row: 4, name: "Cash at bank" }]);
  });

  test("a name in a merged cell names each row the merge covers", () => {
    const merged = sheetOf(
      [text(3, 0, "Accruals"), figure(3, 2, "10.00"), figure(4, 2, "20.00")],
      ["A3:B4"],
    );
    expect(citedRowNames(merged, ["C4"])).toEqual([{ row: 4, name: "Accruals" }]);
  });

  test("a Chinese name", () => {
    const chinese = sheetOf([text(8, 1, "银行存款"), figure(8, 2, "84,317.52")]);
    expect(citedRowNames(chinese, ["C8"])).toEqual([{ row: 8, name: "银行存款" }]);
  });
});

describe("a row's name on its mark", () => {
  test("a short name whole", () => {
    expect(shortRowName("Cash at bank")).toBe("Cash at bank");
  });

  test("a long name cut at a word, with an ellipsis, within 24 columns", () => {
    const shown = shortRowName("Amounts owed by group undertakings and participating interests");
    expect(shown).toBe("Amounts owed by group…");
  });

  test("a long Chinese name cut anywhere, a character taking two columns", () => {
    expect(shortRowName("应收关联方及参与权益单位的款项合计数额")).toBe("应收关联方及参与权益单…");
  });
});

describe("a sheet Citation's mark with its rows' names", () => {
  const mark: { label: string; shown?: string } = { label: "Trial balance, row 7" };
  const found = (...refs: string[]) => ({
    sheet: "Trial balance",
    cells: new Set(refs.map((ref) => `Trial balance!${ref}`)),
  });

  test("one row: the mark shows its name, and the tooltip's label adds it", () => {
    expect(withRowNames(mark, trialBalance, found("A7", "B7", "C7", "D7"), ", ")).toEqual({
      ...mark,
      label: "Trial balance, row 7 · Cash at bank",
      shown: "Cash at bank",
    });
  });

  test("several rows: the mark keeps its range, and the tooltip names each row", () => {
    const rows = { ...mark, label: "Trial balance, rows 7–8" };
    expect(withRowNames(rows, trialBalance, found("D7", "D8"), "、")).toEqual({
      ...rows,
      label: "Trial balance, rows 7–8 · Cash at bank、Trade debtors",
      shown: "Trial balance, rows 7–8",
    });
  });

  test("several rows, one without a name: no names at all, so none is read against the wrong row", () => {
    const rows = { ...mark, label: "Trial balance, rows 7–9" };
    expect(withRowNames(rows, trialBalance, found("C7", "D8", "C9"), ", ")).toEqual(rows);
  });

  test("a row with no name keeps the mark as it was", () => {
    const row = { ...mark, label: "Trial balance, row 9" };
    expect(withRowNames(row, trialBalance, found("A9", "C9"), ", ")).toEqual(row);
  });

  test("a quote across two sheets is named by the cells on the sheet it opens on", () => {
    const across = {
      sheet: "Trial balance",
      cells: new Set(["Trial balance!D8", "Bank rec!B3", "Bank rec!A3"]),
    };
    expect(cellsOn(across)).toEqual(["D8"]);
    expect(withRowNames(mark, trialBalance, across, ", ")?.shown).toBe("Trade debtors");
  });
});
