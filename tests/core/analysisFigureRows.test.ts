import { describe, expect, test } from "vitest";
import { recalculate, rowsText } from "../../src/core/analysis/figureRows";
import type { AnalysisFigureRows, AnalysisInput } from "../../src/shared/analysis";
import { readAnalysisOutput } from "../../src/shared/analysis";

/** A sheet's rows from row 2, as IncarnaMind reads them; row 5's revenue is text, row 6's empty. */
const SALES: AnalysisInput = {
  kind: "table",
  name: "sales",
  columns: ["Region", "Revenue"],
  firstRow: 2,
  rows: [
    ["North", 120],
    ["North", 150.5],
    ["South", 80],
    ["South", "n/a"],
    ["East", null],
    ["West", 40],
  ],
  rowNumbers: [2, 3, 4, 5, 6, 8],
};

const of = (
  rows: [number, number][],
  how: AnalysisFigureRows["how"],
  columns = ["Revenue"],
): AnalysisFigureRows => ({
  input: "sales",
  columns,
  rows,
  count: rows.reduce((n, [from, to]) => n + to - from + 1, 0),
  how,
});

describe("a figure() figure worked out again from the cells", () => {
  test.each([
    ["sum", 390.5],
    ["mean", 97.625],
    ["min", 40],
    ["max", 150.5],
    ["count", 4],
  ] as const)("its %s over rows of numbers and blanks is worked out again", (how, value) => {
    expect(
      recalculate(
        value,
        of(
          [
            [2, 4],
            [6, 6],
            [8, 8],
          ],
          how,
        ),
        [SALES],
      ),
    ).toEqual({ kind: "same", value });
  });

  test.each([
    ["sum", 390.5],
    ["count", 4],
  ] as const)(
    "its %s over rows holding a cell that isn't a number isn't, and names the cell (#2444)",
    (how, value) => {
      expect(
        recalculate(
          value,
          of(
            [
              [2, 6],
              [8, 8],
            ],
            how,
          ),
          [SALES],
        ),
      ).toEqual({
        kind: "unchecked",
        reason: '1 cell of Revenue in the rows it names isn\'t a number: row 5 "n/a"',
      });
    },
  );

  test.each([
    ["min", 1],
    ["max", 199_999],
    ["sum", 19_999_900_000],
  ] as const)("its %s over 199,999 rows is worked out again", (how, value) => {
    const many: AnalysisInput = {
      kind: "table",
      name: "orders",
      columns: ["Amount"],
      firstRow: 2,
      rows: Array.from({ length: 199_999 }, (_, at) => [at + 1]),
    };
    expect(
      recalculate(
        value,
        { input: "orders", columns: ["Amount"], rows: [[2, 200_000]], count: 199_999, how },
        [many],
      ),
    ).toEqual({ kind: "same", value });
  });

  test("a value its cells don't come to differs, and says what they come to", () => {
    expect(recalculate(300, of([[2, 3]], "sum"), [SALES])).toEqual({
      kind: "differs",
      value: 270.5,
    });
    expect(recalculate(270.5, of([[2, 3]], "sum"), [SALES])).toEqual({
      kind: "same",
      value: 270.5,
    });
  });

  test("a row the input doesn't have, a column it doesn't have, or a column of text isn't worked out", () => {
    expect(recalculate(1, of([[7, 7]], "max"), [SALES])).toEqual({
      kind: "unchecked",
      reason: "sales has no row 7",
    });
    expect(recalculate(1, of([[2, 2]], "sum", ["Profit"]), [SALES])).toEqual({
      kind: "unchecked",
      reason: 'sales has no one column "Profit"',
    });
    expect(recalculate(1, of([[2, 2]], "sum", ["Region"]), [SALES])).toEqual({
      kind: "unchecked",
      reason: "Region in sales holds text, not numbers",
    });
    // Counting a column of text counts its filled cells.
    expect(
      recalculate(
        6,
        of(
          [
            [2, 6],
            [8, 8],
          ],
          "count",
          ["Region"],
        ),
        [SALES],
      ),
    ).toEqual({
      kind: "same",
      value: 6,
    });
  });

  test("its rows read as runs, the first few only", () => {
    expect(rowsText([[7, 7]])).toBe("row 7");
    expect(
      rowsText([
        [2, 6],
        [8, 8],
      ]),
    ).toBe("rows 2–6, 8");
    expect(
      rowsText([
        [2, 2],
        [4, 4],
        [6, 6],
        [8, 8],
        [10, 10],
        [12, 12],
        [14, 14],
      ]),
    ).toBe("rows 2, 4, 6, 8, 10, 12 and 1 more run");
  });
});

describe("what the sandbox says a figure's rows and pictures are", () => {
  const figure = (given: unknown) =>
    readAnalysisOutput({
      results: [{ kind: "figure", name: "total", label: "Total", unit: null, value: 1, of: given }],
    }).results;

  test("rows that run in order, apart, with their count, are kept; anything else drops the figure", () => {
    expect(
      figure(
        of(
          [
            [2, 6],
            [8, 8],
          ],
          "sum",
        ),
      ),
    ).toEqual([
      {
        kind: "figure",
        name: "total",
        label: "Total",
        unit: null,
        value: 1,
        of: of(
          [
            [2, 6],
            [8, 8],
          ],
          "sum",
        ),
      },
    ]);
    for (const wrong of [
      {
        ...of(
          [
            [2, 6],
            [7, 8],
          ],
          "sum",
        ),
      },
      { ...of([[6, 2]], "sum") },
      { ...of([[2, 6]], "sum"), count: 4 },
      { ...of([[2, 6]], "sum"), how: "median" },
      { ...of([[0, 6]], "sum") },
    ])
      expect(figure(wrong), JSON.stringify(wrong)).toEqual([]);
  });

  test("a picture is kept only as a PNG within a Note's size", () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const read = (pictures: unknown[]) => readAnalysisOutput({ pictures }).pictures;
    expect(read([{ title: "Revenue", png, width: 1600, height: 900 }])).toEqual([
      { title: "Revenue", png, width: 1600, height: 900 },
    ]);
    expect(read([{ title: "Wide", png, width: 1601, height: 900 }])).toEqual([]);
    expect(read([{ title: "JPEG", png: "/9j/4AAQSkZJRg==", width: 10, height: 10 }])).toEqual([]);
    expect(read([{ title: "Not base64", png: `${png}<script>`, width: 10, height: 10 }])).toEqual(
      [],
    );
  });
});
