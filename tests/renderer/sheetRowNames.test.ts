import { describe, expect, test } from "vitest";
import type { Cell, Sheet } from "../../src/core/documents/formats/grid";
import { citedRowNames, shortRowName } from "../../src/renderer/src/viewer/sheetRowNames";

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

function sheetOf(cells: Cell[], merges: string[] = []): Sheet {
  return { name: "Trial balance", cells, merges, rowCount: 20, columnCount: 6, columnWidths: [] };
}

const trialBalance = sheetOf([
  text(7, 0, "4007"),
  text(7, 1, "Cash at bank"),
  figure(7, 2, "700.25"),
  figure(7, 3, "84,317.52"),
  text(8, 0, "4008"),
  text(8, 1, "Trade debtors"),
  figure(8, 2, "800.25"),
  figure(8, 3, "12.48"),
  figure(9, 0, "4009"),
  figure(9, 2, "900.25"),
]);

describe("the names of the rows a quote covers", () => {
  test("a row quoted whole is named by its first text cell left of its figures", () => {
    expect(citedRowNames(trialBalance, ["A8", "B8", "C8", "D8"])).toEqual(["Trade debtors"]);
  });

  test("a figure quoted alone is named by the text left of it", () => {
    expect(citedRowNames(trialBalance, ["D7"])).toEqual(["Cash at bank"]);
  });

  test("several rows, each with its own name, in row order", () => {
    expect(citedRowNames(trialBalance, ["D8", "C8", "C7", "D7"])).toEqual([
      "Cash at bank",
      "Trade debtors",
    ]);
  });

  test("a row of only numbers has no name", () => {
    expect(citedRowNames(trialBalance, ["A9", "C9"])).toEqual([]);
  });

  test("a quote of text only has no name", () => {
    expect(citedRowNames(trialBalance, ["B8"])).toEqual([]);
  });

  test("a name in a merged cell names each row the merge covers", () => {
    const merged = sheetOf(
      [text(3, 0, "Accruals"), figure(3, 2, "10.00"), figure(4, 2, "20.00")],
      ["A3:B4"],
    );
    expect(citedRowNames(merged, ["C4"])).toEqual(["Accruals"]);
  });

  test("a Chinese name", () => {
    const chinese = sheetOf([text(8, 1, "银行存款"), figure(8, 2, "84,317.52")]);
    expect(citedRowNames(chinese, ["C8"])).toEqual(["银行存款"]);
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
