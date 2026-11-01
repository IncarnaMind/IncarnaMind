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
  const row = (...values: (string | number)[]) =>
    sheetOf(
      values.map((value, column) =>
        typeof value === "number" ? figure(4, column, value.toFixed(2)) : text(4, column, value),
      ),
    );

  test("every text cell left of the first quoted figure, in column order, joined by ' · '", () => {
    const cases: [Sheet, string][] = [
      [row("Current liabilities", "VAT", 1200), "Current liabilities · VAT"],
      [row("AR01", "Receivables", 1234), "AR01 · Receivables"],
      [row("Trade receivables", "Note 12", 1234), "Trade receivables · Note 12"],
      [row("Cash at bank", "USD", 1234), "Cash at bank · USD"],
      [row("Category", "Account", 10), "Category · Account"],
      [row("流动负债", "增值税", 1200), "流动负债 · 增值税"],
    ];
    for (const [sheet, name] of cases) {
      expect(citedRowNames(sheet, ["A4", "B4", "C4"]), name).toEqual([{ row: 4, name }]);
    }
  });

  test("a figure between texts: left of the first quoted figure only", () => {
    const sheet = row("Name", 100, "Note", 200);
    expect(citedRowNames(sheet, ["D4"])).toEqual([{ row: 4, name: "Name · Note" }]);
    expect(citedRowNames(sheet, ["B4", "D4"])).toEqual([{ row: 4, name: "Name" }]);
  });

  test("an account code stored as a number neither joins the name nor hides it", () => {
    expect(citedRowNames(trialBalance, ["A8", "B8", "C8", "D8"])).toEqual([
      { row: 8, name: "Trade debtors" },
    ]);
  });

  test("a code typed as digits names nothing, and the name beside it stays", () => {
    expect(citedRowNames(trialBalance, ["A7", "B7", "C7", "D7"])).toEqual([
      { row: 7, name: "Cash at bank" },
    ]);
  });

  test("several rows, each with its own name or none, in row order", () => {
    expect(citedRowNames(trialBalance, ["C9", "D8", "C7"])).toEqual([
      { row: 7, name: "Cash at bank" },
      { row: 8, name: "Trade debtors" },
      { row: 9, name: null },
    ]);
  });

  test("figures stored as text are figures, and don't join the name", () => {
    const sheet = sheetOf([text(4, 0, "Rent"), text(4, 1, "1,200"), text(4, 2, "(300)")]);
    expect(citedRowNames(sheet, ["C4"])).toEqual([{ row: 4, name: "Rent" }]);
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
      "FALSE",
      "1,200",
      "2026",
      "无",
      "不适用",
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

  test("a number never joins, even shown with letters, and counts as a figure", () => {
    const sheet = sheetOf([
      figure(4, 0, "15 Mar 2026"),
      text(4, 1, "Rent"),
      figure(4, 2, "1,200 Dr"),
      text(4, 3, "Note 3"),
      figure(4, 4, "10.00"),
    ]);
    expect(citedRowNames(sheet, ["C4", "E4"])).toEqual([{ row: 4, name: "Rent" }]);
  });

  test("a merged cell's text counts once, for each row the merge covers", () => {
    const merged = sheetOf(
      [text(3, 0, "Accruals"), figure(3, 2, "10.00"), figure(4, 2, "20.00")],
      ["A3:B4"],
    );
    expect(citedRowNames(merged, ["C4"])).toEqual([{ row: 4, name: "Accruals" }]);
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
    expect(shortRowName("应收关联方及参与权益单位的款项合计数额")).toBe(
      "应收关联方及参与权益单位…",
    );
  });

  test("28 columns show whole; one more is cut", () => {
    expect(shortRowName("Abcdefghij Abcdefghij Abcdef")).toBe("Abcdefghij Abcdefghij Abcdef");
    expect(shortRowName("Abcdefghij Abcdefghij Abcdefg")).toBe("Abcdefghij Abcdefghij…");
  });

  test("a cut never ends on the dot between two cells", () => {
    expect(shortRowName("Current liabilities due · Value added tax")).toBe(
      "Current liabilities due…",
    );
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

  test("the decided labels show whole on the mark", () => {
    const labels: [string[], string][] = [
      [["Current liabilities", "VAT"], "Current liabilities · VAT"],
      [["AR01", "Receivables"], "AR01 · Receivables"],
      [["Trade receivables", "Note 12"], "Trade receivables · Note 12"],
      [["Cash at bank", "USD"], "Cash at bank · USD"],
      [["流动负债", "增值税"], "流动负债 · 增值税"],
    ];
    for (const [texts, label] of labels) {
      const sheet = sheetOf([
        ...texts.map((each, column) => text(4, column, each)),
        figure(4, texts.length, "1,200.00"),
      ]);
      const marked = withRowNames(
        { ...mark, label: "Trial balance, row 4" },
        sheet,
        found("C4"),
        ", ",
      );
      expect(marked?.shown, label).toBe(label);
    }
  });

  test("a long label: the mark shows its start, cut with an ellipsis; the tooltip the whole", () => {
    const sheet = sheetOf([
      text(4, 0, "Amounts owed by group undertakings"),
      text(4, 1, "Note 14"),
      figure(4, 2, "1,000.00"),
    ]);
    const row = { label: "Trial balance, row 4" };
    expect(withRowNames(row, sheet, found("C4"), ", ")).toEqual({
      label: "Trial balance, row 4 · Amounts owed by group undertakings · Note 14",
      shown: "Amounts owed by group…",
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
