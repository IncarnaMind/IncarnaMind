/**
 * An Analysis's table is worked out again column by column (#2378): a column is recalculated only
 * when exactly one rule, of a sum, mean, min, max or count of one input column over the rows whose
 * key holds the row's label, reproduces every cell of it. Two rules that fit, or none, leave it not
 * recalculated: nothing is guessed.
 */
import { describe, expect, test } from "vitest";
import { checkTableColumns } from "../../src/core/analysis/tableRules";
import type { AnalysisCell, AnalysisInput, AnalysisTable } from "../../src/shared/analysis";

const orders = (rows: AnalysisCell[][], extra: Partial<AnalysisInput> = {}): AnalysisInput =>
  ({
    kind: "table",
    name: "orders",
    columns: ["order_id", "region", "amount"],
    rows,
    firstRow: 2,
    ...extra,
  }) as AnalysisInput;

const ROWS: AnalysisCell[][] = [
  [1001, "Central", 157.5],
  [1002, "North", 195],
  [1003, "Central", 307.5],
  [1004, "North", 270],
  [1005, "South", 232.5],
  [1006, "South", 345],
];

const table = (columns: string[], rows: AnalysisCell[][]): AnalysisTable => ({
  columns,
  rows,
  rowCount: rows.length,
  columnCount: columns.length,
});

describe("a column worked out again from the input's rows (#2378)", () => {
  test("totals by region are the sum of amount over each region's rows", () => {
    const totals = table(
      ["region", "amount"],
      [
        ["Central", 465],
        ["North", 465],
        ["South", 577.5],
      ],
    );
    expect(checkTableColumns(totals, [orders(ROWS)])).toEqual([
      {
        column: 1,
        rule: { input: "orders", key: "region", value: "amount", how: "sum" },
        rows: 6,
      },
    ]);
  });

  test("a mean, a count and a highest value are each their one rule", () => {
    const stats = table(
      ["region", "average", "orders", "largest"],
      [
        ["Central", 232.5, 2, 307.5],
        ["North", 232.5, 2, 270],
        ["South", 288.75, 2, 345],
      ],
    );
    expect(checkTableColumns(stats, [orders(ROWS)]).map((each) => each.rule)).toEqual([
      { input: "orders", key: "region", value: "amount", how: "mean" },
      { input: "orders", key: "region", value: "region", how: "count" },
      { input: "orders", key: "region", value: "amount", how: "max" },
    ]);
  });

  test("one-row groups, where sum, mean, min and max all give the cell, are not recalculated", () => {
    const one = table(
      ["order_id", "amount"],
      [
        [1001, 157.5],
        [1002, 195],
      ],
    );
    expect(checkTableColumns(one, [orders(ROWS)])).toEqual([{ column: 1, rule: null, rows: 0 }]);
  });

  test("a column two rules fit, from two input columns that hold the same numbers, is not recalculated", () => {
    const twice = orders(
      ROWS.map((row) => [...row, row[2] ?? null]),
      { columns: ["order_id", "region", "amount", "amount_copy"] } as Partial<AnalysisInput>,
    );
    const totals = table(
      ["region", "amount"],
      [
        ["Central", 465],
        ["North", 465],
        ["South", 577.5],
      ],
    );
    expect(checkTableColumns(totals, [twice])).toEqual([{ column: 1, rule: null, rows: 0 }]);
  });

  test("a column no rule fits, a cell off by one, is not recalculated", () => {
    const off = table(
      ["region", "amount"],
      [
        ["Central", 465],
        ["North", 466],
        ["South", 577.5],
      ],
    );
    expect(checkTableColumns(off, [orders(ROWS)])).toEqual([{ column: 1, rule: null, rows: 0 }]);
  });

  test("a label the input doesn't hold, a total row, leaves the column not recalculated", () => {
    const withTotal = table(
      ["region", "amount"],
      [
        ["Central", 465],
        ["North", 465],
        ["South", 577.5],
        ["Total", 1507.5],
      ],
    );
    expect(checkTableColumns(withTotal, [orders(ROWS)])[0]?.rule).toBeNull();
  });

  test("a label given twice, as a group by two keys gives it, leaves the column not recalculated", () => {
    // Central's two rows sum to 465 as a pair: read by the label, each row would be both.
    const twice = table(
      ["region", "amount"],
      [
        ["Central", 465],
        ["Central", 465],
        ["North", 465],
      ],
    );
    expect(checkTableColumns(twice, [orders(ROWS)])).toEqual([{ column: 1, rule: null, rows: 0 }]);
  });

  test("cells read from a scan are never worked out again", () => {
    const totals = table(
      ["region", "amount"],
      [
        ["Central", 465],
        ["North", 465],
        ["South", 577.5],
      ],
    );
    const scanned = orders(ROWS, { readFromScan: true } as Partial<AnalysisInput>);
    expect(checkTableColumns(totals, [scanned])[0]?.rule).toBeNull();
  });

  test("a group with a cell that isn't a number is not summed, as figure() refuses it", () => {
    const rows = ROWS.map((row, at) => (at === 0 ? [row[0] ?? null, "Central", "n/a"] : row));
    const totals = table(
      ["region", "amount"],
      [
        ["Central", 307.5],
        ["North", 465],
        ["South", 577.5],
      ],
    );
    expect(checkTableColumns(totals, [orders(rows)])[0]?.rule).toBeNull();
  });
});
