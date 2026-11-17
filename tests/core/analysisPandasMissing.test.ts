/**
 * A text pandas reads as missing by default counts as an empty cell when a figure() figure is
 * worked out again (#2577). The list is pandas' own (`STR_NA_VALUES`), matched whole, in its cases
 * and with no spaces; anything else a column holds that isn't a number still refuses (#2444), "-",
 * "—", "nil" and 无 among it. tests/main/analysisPandasMissing.test.ts checks the list and these
 * outcomes against the pandas the app bundles.
 */
import { describe, expect, test } from "vitest";
import { PANDAS_MISSING, recalculate } from "../../src/core/analysis/figureRows";
import type { AnalysisCell, AnalysisFigureRows, AnalysisInput } from "../../src/shared/analysis";

const GROWTH = [0.06, 0.08, 0.1];

/** A sheet whose growth column is `growth`, one cell a month from row 2. */
const column = (growth: AnalysisCell[]): AnalysisInput => ({
  kind: "table",
  name: "loans",
  columns: ["month", "growth"],
  firstRow: 2,
  rows: growth.map((cell, month) => [`2026-0${month + 1}`, cell]),
});

/** The growth column `GROWTH` with `cell` in its second row. */
const sheet = (cell: AnalysisCell): AnalysisInput =>
  column([GROWTH[0] ?? null, cell, GROWTH[1] ?? null, GROWTH[2] ?? null]);

const rowsOf = (how: AnalysisFigureRows["how"]): AnalysisFigureRows => ({
  input: "loans",
  columns: ["growth"],
  rows: [[2, 5]],
  count: 4,
  how,
});

const ofNumbers = {
  sum: 0.24,
  mean: 0.08,
  min: 0.06,
  max: 0.1,
  count: 3,
} as const;

describe("a text pandas reads as missing, in a column of numbers", () => {
  // protects=every text pandas reads as missing by default counts as an empty cell: a sum, mean, min, max and count over the rows are worked out again as the cells it skips, as pandas' own are (#2577); fails_when=such a text makes the figure unchecked ("isn't a number") as a word does
  test.each([...PANDAS_MISSING])("%s is an empty cell", (text) => {
    for (const [how, value] of Object.entries(ofNumbers)) {
      const check = recalculate(value, rowsOf(how as AnalysisFigureRows["how"]), [sheet(text)]);
      expect(check.kind, `${how} over "${text}"`).toBe("same");
    }
  });

  test("the list is pandas' 18 non-empty strings, none of them a number or a word that may mean zero", () => {
    expect([...PANDAS_MISSING].sort()).toEqual(
      [
        "#N/A",
        "#N/A N/A",
        "#NA",
        "-1.#IND",
        "-1.#QNAN",
        "-NaN",
        "-nan",
        "1.#IND",
        "1.#QNAN",
        "<NA>",
        "N/A",
        "NA",
        "NULL",
        "NaN",
        "None",
        "n/a",
        "nan",
        "null",
      ].sort(),
    );
    for (const text of ["", "-", "—", "–", "nil", "Nil", "无", "0"]) {
      expect(PANDAS_MISSING.has(text), `"${text}"`).toBe(false);
    }
  });
});

describe("anything else that isn't a number still refuses a figure (#2444)", () => {
  // protects=a text pandas doesn't read as missing is never skipped: a dash may be a zero, a word may be a figure the file counts, and pandas matches whole, in these cases, with no spaces; fails_when=a near miss or a dash counts as empty
  test.each([
    "-",
    "—",
    "–",
    "nil",
    "Nil",
    "无",
    "暂无",
    "不适用",
    "N/a",
    "n/A",
    "NAN",
    "na",
    "none",
    "NONE",
    "Null",
    " n/a",
    "n/a ",
    "n/a.",
    "N.A.",
    "n.a.",
    "missing",
    "TBD",
    "?",
  ])("%j refuses a mean, naming the cell", (text) => {
    const check = recalculate(0.08, rowsOf("mean"), [sheet(text)]);

    expect(check).toEqual({
      kind: "unchecked",
      reason: `1 cell of growth in the rows it names isn't a number: row 3 "${text}"`,
    });
  });

  test("a column whose cells all read as missing reads as an empty column does", () => {
    const missing = column(["n/a", "NaN", "", "null"]);
    const empty = column(["", "", "", ""]);

    expect(recalculate(0.08, rowsOf("mean"), [missing])).toEqual({
      kind: "unchecked",
      reason: "growth in loans holds text, not numbers",
    });
    expect(recalculate(0.08, rowsOf("mean"), [missing])).toEqual(
      recalculate(0.08, rowsOf("mean"), [empty]),
    );
  });

  test("a column of words stays text, whatever missing texts it holds", () => {
    expect(recalculate(0.08, rowsOf("mean"), [column(["high", "n/a", "low", "n/a"])])).toEqual({
      kind: "unchecked",
      reason: "growth in loans holds text, not numbers",
    });
  });

  test("a column of numbers that is mostly missing texts is still a column of numbers", () => {
    expect(recalculate(0.08, rowsOf("mean"), [column(["n/a", "n/a", "NA", 0.08])])).toEqual({
      kind: "same",
      value: 0.08,
    });
  });
});
