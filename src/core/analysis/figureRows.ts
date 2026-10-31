/**
 * A figure an Analysis gave with `figure(name, column, how)` (ADR-0025): the
 * sandbox says which rows of which input's column it is the sum, mean, min,
 * max or count of, and IncarnaMind works it out again here from the cells it
 * read from the Document itself, with its own arithmetic. Only a figure that
 * comes to the same number is given a marker: the code's word is never enough.
 */
import {
  type AnalysisCell,
  type AnalysisFigureRows,
  type AnalysisInput,
  type AnalysisRecalculation,
  analysisLabel,
  type FigureHow,
} from "../../shared/analysis";
import { sameNumber } from "../../shared/formula";

const isNumber = (cell: AnalysisCell): cell is number =>
  typeof cell === "number" && Number.isFinite(cell);

/** As the helper reads an input's column: numbers, when at least half its filled cells are. */
function numeric(cells: readonly AnalysisCell[]): boolean {
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

function reduce(how: Exclude<FigureHow, "count">, values: readonly number[]): number | null {
  if (how === "sum") return sum(values);
  if (values.length === 0) return null;
  if (how === "mean") return sum(values) / values.length;
  return how === "min" ? Math.min(...values) : Math.max(...values);
}

/** Every row number in `rows`, in order. */
export function rowNumbersOf(rows: AnalysisFigureRows["rows"]): number[] {
  return rows.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, at) => from + at));
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
  for (const row of rowNumbersOf(of.rows)) {
    const cellsOfRow = byRow.get(row);
    if (!cellsOfRow) return { kind: "unchecked", reason: `${of.input} has no row ${row}` };
    cells.push(cellsOfRow[column] ?? null);
  }
  const numbers = numeric(input.rows.map((row) => row[column] ?? null));
  if (how !== "count" && !numbers) {
    return { kind: "unchecked", reason: `${heading} in ${of.input} holds text, not numbers` };
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
