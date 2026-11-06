/**
 * A table an Analysis gave, worked out again column by column when the Analysis runs (#2378). A
 * column counts as recalculated only when exactly one rule reproduces every cell of it: the sum,
 * mean, min or max of one input column, or the count, over the input rows whose key column holds
 * the row's label (its first cell). IncarnaMind reads the cells itself, with the arithmetic and
 * the refusals `figure()` gets (./figureRows). Nothing is guessed: two rules that fit, as sum,
 * mean, min and max do over one-row groups, or none, leave the column not recalculated.
 */
import {
  type AnalysisCell,
  type AnalysisColumnCheck,
  type AnalysisColumnRule,
  type AnalysisInput,
  type AnalysisTable,
  analysisLabel,
} from "../../shared/analysis";
import { sameNumber } from "../../shared/formula";
import { isNumber, numeric, reduce } from "./figureRows";

type TableInput = Extract<AnalysisInput, { kind: "table" }>;

const AGGREGATES = ["sum", "mean", "min", "max"] as const;

// "2023" and 2023 are two labels, as pandas groups them.
const labelKey = (cell: AnalysisCell): string | null =>
  cell === null || cell === "" || typeof cell === "boolean" ? null : JSON.stringify(cell);

/** Null when a label has no rows: no rule over the input's rows gives its cells. */
function groupsOf(input: TableInput, key: number, labels: readonly string[]): number[][] | null {
  const wanted = new Map(labels.map((label) => [label, [] as number[]]));
  input.rows.forEach((row, index) => {
    const label = labelKey(row[key] ?? null);
    if (label !== null) wanted.get(label)?.push(index);
  });
  const groups = labels.map((label) => wanted.get(label) ?? []);
  return groups.every((group) => group.length > 0) ? groups : null;
}

/** Null where the cells refuse it, as `recalculate` does. */
function worked(
  input: TableInput,
  column: number,
  how: AnalysisColumnRule["how"],
  groups: readonly number[][],
): (number | null)[] {
  if (how === "count") return groups.map((group) => group.length);
  return groups.map((group) => {
    const cells = group.map((index) => input.rows[index]?.[column] ?? null);
    // pandas skips a cell that isn't a number as it sums: agreeing with it would vouch for a total
    // that leaves out a cell the file may count (#2444).
    if (cells.some((cell) => cell !== null && cell !== "" && !isNumber(cell))) return null;
    return reduce(how, cells.filter(isNumber));
  });
}

const reproduces = (values: readonly (number | null)[], cells: readonly AnalysisCell[]) =>
  cells.every((cell, at) => {
    const value = values[at];
    return isNumber(cell) && value !== null && value !== undefined && sameNumber(value, cell);
  });

/** What IncarnaMind made of each column of numbers of `table` after its first, from `inputs`. */
export function checkTableColumns(
  table: AnalysisTable,
  inputs: readonly AnalysisInput[],
): AnalysisColumnCheck[] {
  const columns = table.columns.flatMap((_, column) =>
    column > 0 && table.rows.some((row) => isNumber(row[column] ?? null)) ? [column] : [],
  );
  const labels = table.rows.map((row) => labelKey(row[0] ?? null));
  const unchecked = columns.map((column) => ({ column, rule: null, rows: 0 }));
  if (labels.length === 0 || labels.some((label) => label === null)) return unchecked;
  const keys = labels as string[];
  // Two rows of one label are two groups the code made apart: no rule over the label's rows reads them.
  if (new Set(keys).size !== keys.length) return unchecked;
  const fits = new Map<number, { rule: AnalysisColumnRule; rows: number }[]>(
    columns.map((column) => [column, []]),
  );
  for (const input of inputs) {
    // Its cells are what a recognizer read: worked out again, they would only agree with themselves.
    if (input.kind !== "table" || input.readFromScan) continue;
    input.columns.forEach((keyHeading, key) => {
      const groups = groupsOf(input, key, keys);
      if (!groups) return;
      const rows = groups.reduce((total, group) => total + group.length, 0);
      const candidates: { rule: AnalysisColumnRule; values: (number | null)[] }[] = [
        {
          rule: {
            input: input.name,
            key: analysisLabel(keyHeading),
            value: analysisLabel(keyHeading),
            how: "count",
          },
          values: worked(input, key, "count", groups),
        },
      ];
      input.columns.forEach((valueHeading, value) => {
        if (value === key || !numeric(input.rows.map((row) => row[value] ?? null))) return;
        for (const how of AGGREGATES)
          candidates.push({
            rule: {
              input: input.name,
              key: analysisLabel(keyHeading),
              value: analysisLabel(valueHeading),
              how,
            },
            values: worked(input, value, how, groups),
          });
      });
      for (const column of columns) {
        const cells = table.rows.map((row) => row[column] ?? null);
        for (const candidate of candidates)
          if (reproduces(candidate.values, cells))
            fits.get(column)?.push({ rule: candidate.rule, rows });
      }
    });
  }
  return columns.map((column) => {
    const fitting = fits.get(column) ?? [];
    const [only] = fitting;
    return only && fitting.length === 1
      ? { column, rule: only.rule, rows: only.rows }
      : { column, rule: null, rows: 0 };
  });
}
