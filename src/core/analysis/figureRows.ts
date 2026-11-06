/**
 * A figure an Analysis gave with `figure(name, column, how)` (ADR-0025): the
 * sandbox says which rows of which input's column it is the sum, mean, min,
 * max or count of, and IncarnaMind works it out again here from the cells it
 * read from the Document itself, with its own arithmetic. Only a figure that
 * comes to the same number is given a marker: the code's word is never enough.
 */
import {
  ANALYSIS_LIMITS,
  type AnalysisCell,
  type AnalysisFigureRows,
  type AnalysisInput,
  type AnalysisRecalculation,
  analysisLabel,
  type FigureHow,
} from "../../shared/analysis";
import { figureText } from "../../shared/figures";
import { sameNumber } from "../../shared/formula";

export const isNumber = (cell: AnalysisCell): cell is number =>
  typeof cell === "number" && Number.isFinite(cell);

/** As the helper reads an input's column: numbers, when at least half its filled cells are. */
export function numeric(cells: readonly AnalysisCell[]): boolean {
  const filled = cells.filter((cell) => cell !== null && cell !== "");
  const numbers = filled.filter(isNumber).length;
  return numbers > 0 && numbers * 2 >= filled.length;
}

/** Neumaier's sum: as close as pandas' own, whatever order the rows come in. */
function sum(values: readonly number[]): number {
  let total = 0;
  let lost = 0;
  for (const value of values) {
    const next = total + value;
    lost += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
    total = next;
  }
  return total + lost;
}

export function reduce(how: Exclude<FigureHow, "count">, values: readonly number[]): number | null {
  if (how === "sum") return sum(values);
  if (values.length === 0) return null;
  if (how === "mean") return sum(values) / values.length;
  // Folded, not spread: a spread of every row overflows the stack past about 120,000 rows.
  const pick = how === "min" ? Math.min : Math.max;
  return values.reduce((kept, value) => pick(kept, value));
}

/**
 * Works out again what `of` says its figure is, from `inputs` as IncarnaMind
 * read them, and compares it with `value` to Excel's 15 digits.
 */
export function recalculate(
  value: number,
  of: AnalysisFigureRows,
  inputs: readonly AnalysisInput[],
): AnalysisRecalculation {
  const { how } = of;
  if (how === null) return { kind: "unchecked", reason: "it names no way to work it out" };
  const input = inputs.find((each) => each.name === of.input);
  if (input?.kind !== "table") return { kind: "unchecked", reason: `${of.input} isn't a range` };
  // Its cells are what a recognizer read: worked out again, they would only agree with themselves.
  if (input.readFromScan) {
    return {
      kind: "unchecked",
      reason: `${of.input}'s cells were read from a scan, which may have misread them, so a figure of them is never worked out again. Give it with result(name, value, label, unit, of=df) to show it as calculated by code, and say in the Answer that its numbers were read from a scan`,
    };
  }
  const [heading] = of.columns;
  const at = input.columns.flatMap((each, index) =>
    analysisLabel(each) === heading ? [index] : [],
  );
  const [column] = at;
  if (column === undefined || at.length > 1 || of.columns.length !== 1) {
    return { kind: "unchecked", reason: `${of.input} has no one column "${heading}"` };
  }
  const rowNumbers = input.rowNumbers ?? input.rows.map((_, index) => input.firstRow + index);
  const byRow = new Map(rowNumbers.map((row, index) => [row, input.rows[index] ?? []]));
  const cells: AnalysisCell[] = [];
  const notNumbers: NotNumber[] = [];
  // Row by row, stopping at the first the input doesn't have: the sandbox names the runs, and a
  // run as long as it likes is no more work than the input's own rows.
  for (const [from, to] of of.rows) {
    for (let row = from; row <= to; row++) {
      const cellsOfRow = byRow.get(row);
      if (!cellsOfRow) return { kind: "unchecked", reason: `${of.input} has no row ${row}` };
      const cell = cellsOfRow[column] ?? null;
      cells.push(cell);
      if (cell !== null && cell !== "" && !isNumber(cell)) {
        notNumbers.push({ row, value: analysisLabel(String(cell)) });
      }
    }
  }
  const numbers = numeric(input.rows.map((row) => row[column] ?? null));
  if (how !== "count" && !numbers) {
    return { kind: "unchecked", reason: `${heading} in ${of.input} holds text, not numbers` };
  }
  // The code's pandas skips them as it sums, so agreeing with it would vouch for a total that
  // leaves out a cell the file may count, such as an accounting "(100)" (#2444).
  if (numbers && notNumbers.length > 0) {
    const listed = notNumbers.slice(0, ANALYSIS_LIMITS.cellsListed);
    return {
      kind: "unchecked",
      reason: `${notNumbersText(notNumbers.length, heading ?? "", "in the rows it names")}: ${cellsText(listed, notNumbers.length)}`,
    };
  }
  const worked =
    how === "count"
      ? cells.filter(numbers ? isNumber : (cell) => cell !== null).length
      : reduce(how, cells.filter(isNumber));
  if (worked === null) {
    return { kind: "unchecked", reason: `the rows it names hold no numbers in ${heading}` };
  }
  return sameNumber(worked, value)
    ? { kind: "same", value: worked }
    : { kind: "differs", value: worked };
}

interface NotNumber {
  row: number;
  /** As the cell holds it; "" for an empty one. */
  value: string;
}

/** "2 cells of Revenue in the rows it names aren't numbers", for the model's report. */
export function notNumbersText(count: number, column: string, where: string): string {
  return count === 1
    ? `1 cell of ${column} ${where} isn't a number`
    : `${figureText("en", count)} cells of ${column} ${where} aren't numbers`;
}

/** 'row 5 "n/a", row 6 empty, …': the cells listed of `count`, for the model's report. */
export function cellsText(cells: readonly NotNumber[], count: number): string {
  const listed = cells.map((each) => `row ${each.row} ${each.value ? `"${each.value}"` : "empty"}`);
  return `${listed.join(", ")}${count > cells.length ? ", …" : ""}`;
}

/** Row numbers as runs of rows in a row, in order. */
export function rowRuns(rows: Iterable<number>): [number, number][] {
  const runs: [number, number][] = [];
  for (const row of [...new Set(rows)].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && row === last[1] + 1) last[1] = row;
    else runs.push([row, row]);
  }
  return runs;
}

/** "rows 2–9, 11, 14–41", the first few runs only: for the model's report. */
export function rowsText(rows: AnalysisFigureRows["rows"], shown = 6): string {
  const runs = rows
    .slice(0, shown)
    .map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`));
  const left = rows.length - shown;
  const more = left > 0 ? ` and ${left} more ${left === 1 ? "run" : "runs"}` : "";
  const one = rows.length === 1 && rows[0]?.[0] === rows[0]?.[1];
  return `${one ? "row" : "rows"} ${runs.join(", ")}${more}`;
}
