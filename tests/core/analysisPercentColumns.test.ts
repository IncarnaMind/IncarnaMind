/**
 * How a "%" figure's column is written decides whether the figure is recorded (#2577). A mean of
 * 0.08 with unit "%", `figure(name, column, "mean")`, is recorded, and shown as a percent, only
 * where IncarnaMind's own mean of the column's cells, read as the file writes them, comes to the
 * same number; otherwise it gets no marker, and the sentence that wrote it holds the mark
 * "[number missing]" (tests/core/analysisFigureLeftOut.test.ts).
 *
 * Fifteen ways a month-on-month growth column is written, in the order they were probed on
 * `main` on 2026-11-16, each pinned at the recorder with the cells read by `readNumbers`, as the
 * app reads a range. A shape that is not recorded is the designed outcome, not a fault: a text cell
 * in the rows named is never skipped (#2444), and a column of percent points is not a column of
 * fractions. The one relaxation: a text pandas reads as missing by default ("n/a", "N/A", "NA",
 * "nan", "null", "#N/A" ...) counts as an empty cell (#2577, tests/core/analysisPandasMissing.test.ts),
 * so an "n/a" first month records; a "-" first month does not.
 */
import { describe, expect, test } from "vitest";
import { readNumbers } from "../../src/core/analysis/columnNumbers";
import { createAnalysisRecorder } from "../../src/core/analysis/recorder";
import type { CalculatedFigure } from "../../src/core/api";
import {
  type AnalysisCell,
  type AnalysisInput,
  type AnalysisRecalculation,
  noAnalysisOutput,
} from "../../src/shared/analysis";

const MONTHS = 12;

/** The column as a file writes it, one cell a month, from the file's second row. */
const column = (cell: (month: number) => AnalysisCell): AnalysisCell[] =>
  Array.from({ length: MONTHS }, (_, month) => cell(month));
const firstMonth = (first: AnalysisCell, others: AnalysisCell): AnalysisCell[] =>
  column((month) => (month === 0 ? first : others));

interface Recorded {
  name: string;
  cells: AnalysisCell[];
  value: number;
  /** The rows the figure names, as runs of the sheet's row numbers. */
  rows?: [number, number][];
  shown: string;
}

interface NotRecorded {
  name: string;
  cells: AnalysisCell[];
  value: number;
  rows?: [number, number][];
  check: AnalysisRecalculation["kind"];
  reason: string;
}

const RECORDED: Recorded[] = [
  {
    name: "fractions, 0.08 in every cell",
    cells: column(() => "0.08"),
    value: 0.08,
    shown: "8.0%",
  },
  { name: "8% in every cell", cells: column(() => "8%"), value: 0.08, shown: "8.0%" },
  { name: "8.0% in every cell", cells: column(() => "8.0%"), value: 0.08, shown: "8.0%" },
  {
    name: "full-width ８％ in every cell",
    cells: column(() => "８％"),
    value: 0.08,
    shown: "8.0%",
  },
  { name: "the number 0.08 in every cell", cells: column(() => 0.08), value: 0.08, shown: "8.0%" },
  {
    name: "percent cells that differ",
    cells: column((month) => `${5 + (month % 4)}%`),
    value: 0.065,
    shown: "6.5%",
  },
  {
    name: "an empty first month, the rows named from the first",
    cells: firstMonth("", "8%"),
    value: 0.08,
    shown: "8.0%",
  },
  {
    name: "an n/a first month, the rows named from the first",
    cells: firstMonth("n/a", "8%"),
    value: 0.08,
    shown: "8.0%",
  },
  {
    name: "an n/a first month, the rows named from the second",
    cells: firstMonth("n/a", "8%"),
    value: 0.08,
    rows: [[3, 13]],
    shown: "8.0%",
  },
];

const NOT_RECORDED: NotRecorded[] = [
  {
    name: "a dash first month, the rows named from the first",
    cells: firstMonth("-", "8%"),
    value: 0.08,
    check: "unchecked",
    reason: `1 cell of growth in the rows it names isn't a number: row 2 "-"`,
  },
  {
    name: "percent points, 8.0, under the fraction 0.08, an n/a first month",
    cells: firstMonth("n/a", "8.0"),
    value: 0.08,
    check: "differs",
    reason: "worked out as 8",
  },
  {
    name: "percent points, 8.0, under the fraction 0.08",
    cells: column(() => "8.0"),
    value: 0.08,
    check: "differs",
    reason: "worked out as 8",
  },
  {
    name: "the number 8 under the fraction 0.08",
    cells: column(() => 8),
    value: 0.08,
    check: "differs",
    reason: "worked out as 8",
  },
  {
    name: "percent points that differ under the fraction 0.065",
    cells: column((month) => `${5 + (month % 4)}.0`),
    value: 0.065,
    check: "differs",
    reason: "worked out as 6.5",
  },
  {
    name: "8% in every cell but one that writes 8",
    cells: column((month) => (month === 3 ? "8" : "8%")),
    value: 0.08,
    check: "unchecked",
    reason: "growth in loans holds text, not numbers",
  },
];

/** The sheet the Analysis read, its rows as IncarnaMind reads them from row 2. */
const loans = (growth: AnalysisCell[]): AnalysisInput => ({
  kind: "table",
  name: "loans",
  columns: ["month", "loans", "growth"],
  firstRow: 2,
  rows: readNumbers(
    growth.map((cell, month) => [
      `2026-${String(month + 1).padStart(2, "0")}`,
      1000 + month * 80,
      cell,
    ]),
  ),
});

/** What the recorder gives for the mean of `cells`, as the Answer's language shows it. */
function recorded(
  language: "en" | "zh-CN",
  cells: AnalysisCell[],
  value: number,
  rows: [number, number][],
) {
  const figures: CalculatedFigure[] = [];
  const recorder = createAnalysisRecorder({
    figure: (figure) => figures.push(figure),
    language,
  });
  const marked = recorder.mark(
    recorder.next(),
    {
      ...noAnalysisOutput(),
      results: [
        {
          kind: "figure",
          name: "growth",
          label: language === "en" ? "Average monthly loan growth" : "月均借阅增长率",
          unit: "%",
          value,
          of: {
            input: "loans",
            columns: ["growth"],
            rows,
            count: rows.reduce((total, [from, to]) => total + to - from + 1, 0),
            how: "mean",
          },
        },
      ],
    },
    [loans(cells)],
  );
  return { figures, marked };
}

describe.each(["en", "zh-CN"] as const)(
  "a % figure's column, in a %s Answer (#2577)",
  (language) => {
    // protects=every column a "%" figure is recorded for shows its mean as a percent, "8.0%" and not 0.08, in English and Chinese: the writing of a recorded figure is right (#2577 box 1); fails_when=a recorded percent figure is shown as its fraction or loses its unit
    test.each(RECORDED)("$name: recorded, shown as $shown", ({ cells, value, rows, shown }) => {
      const { figures, marked } = recorded(language, cells, value, rows ?? [[2, 13]]);

      expect(marked.markers.figures).toEqual([{ result: "growth", marker: 1 }]);
      expect(marked.recalculations).toEqual([
        { result: "growth", check: { kind: "same", value: expect.any(Number) } },
      ]);
      expect(figures).toHaveLength(1);
      expect(figures[0]?.shown).toBe(shown);
      expect(figures[0]?.unit).toEqual({ kind: "percent" });
    });

    // protects=a column whose mean IncarnaMind can't work out to the figure's number gets no marker, so its sentence holds the mark and never the model's number (#2444, #2577); fails_when=a figure over a text cell, a mixed column or percent points is recorded as the model gave it
    test.each(NOT_RECORDED)(
      "$name: not recorded ($check)",
      ({ cells, value, rows, check, reason }) => {
        const { figures, marked } = recorded(language, cells, value, rows ?? [[2, 13]]);

        expect(marked.markers.figures).toEqual([]);
        expect(figures).toEqual([]);
        const [only] = marked.recalculations ?? [];
        expect(only?.check.kind).toBe(check);
        const said =
          only?.check.kind === "unchecked"
            ? only.check.reason
            : only?.check.kind === "differs"
              ? `worked out as ${only.check.value}`
              : "";
        expect(said).toBe(reason);
      },
    );
  },
);
