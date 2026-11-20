/**
 * A table written in a text, as the checks read one: a row's cells apart by tabs or bars, the run
 * of rows that hold a number, and the heading rows above them.
 */
import { readFigures } from "../../../shared/figures";
import { memoized } from "../../../shared/memo";

/** A table's row: its cells apart by tabs or bars. */
export const isRow = (line: string): boolean => line.includes("\t") || /\S\s*\|\s*\S/.test(line);
/** A Markdown table's rule under its heading line: "|---|:---:|". */
export const isRule = (line: string): boolean => /^[\s|:-]+$/.test(line) && line.includes("-");

/** A row's cells, by the separator it uses: tabs in a sheet, else bars. */
export const cellsOf = (line: string): string[] => line.split(line.includes("\t") ? "\t" : "|");

/** Which cell of `line` holds offset `at`. */
const cellAt = (line: string, at: number): number => cellsOf(line.slice(0, at)).length - 1;

// Read without dates, a period ("Q3 2026", "2025年") is no number.
const holdsNumber = (cell: string | undefined) =>
  cell !== undefined && readFigures(cell, { midLine: true }).length > 0;

/**
 * The table whose row holds offset `at` of `text`: its lines, the row's index and column, the run
 * of rows that hold a number around it (`top` to `end`), and above them its heading rows (from
 * `head`). Null when `at` isn't in a table's row.
 */
export function tableAt(
  text: string,
  at: number,
): {
  lines: string[];
  index: number;
  column: number;
  top: number;
  head: number;
  end: number;
} | null {
  const { lines, starts, lineAt, runOf } = linesOf(text);
  const index = lineAt(at);
  const line = lines[index] ?? "";
  if (!isRow(line)) return null;
  return { lines, index, column: cellAt(line, at - (starts[index] ?? 0)), ...runOf(index) };
}

/**
 * `text`'s lines, where each starts, and which holds an offset, read once for all the numbers of a
 * long table the unit check meets; with the run of rows around a row (`tableAt`).
 */
export const linesOf = memoized(
  4,
  (text: string) => text,
  (text: string) => {
    const lines = text.split("\n");
    const starts: number[] = [];
    let offset = 0;
    for (const line of lines) {
      starts.push(offset);
      offset += line.length + 1;
    }
    const lineAt = (at: number): number => {
      let [low, high] = [0, starts.length - 1];
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((starts[middle] ?? 0) <= at) low = middle;
        else high = middle - 1;
      }
      return low;
    };
    const known = new Map<number, boolean>();
    const cells = new Map<string, boolean>();
    const holds = (cell: string) => {
      const found = cells.get(cell) ?? holdsNumber(cell);
      cells.set(cell, found);
      return found;
    };
    // A row's numbers stand mostly to the right of its label, so its cells are read from the right.
    const numbered = (at: number): boolean => {
      const row = lines[at];
      if (row === undefined) return false;
      const found = known.get(at) ?? (isRow(row) && cellsOf(row).reverse().some(holds));
      known.set(at, found);
      return found;
    };
    const runs = new Map<number, { top: number; head: number; end: number }>();
    // A reader writes no line for a blank row, so two tables can run on as one: a row with no
    // number (a heading, a rule, a caption) starts the number's own table, and the rows of no
    // number just above it are its headings.
    const runOf = (index: number) => {
      const read = runs.get(index);
      if (read) return read;
      let top = index;
      while (top > 0 && numbered(top - 1)) top--;
      let head = top;
      while (head > 0 && isRow(lines[head - 1] ?? "") && !numbered(head - 1)) head--;
      let end = index;
      while (numbered(end + 1)) end++;
      const run = { top, head, end };
      // Every row of a run of numbered rows has the same run; a row of no number has its own.
      if (numbered(index)) for (let at = top; at <= end; at++) runs.set(at, run);
      return run;
    };
    return { lines, starts, lineAt, runOf };
  },
);

export type Table = NonNullable<ReturnType<typeof tableAt>>;
