/**
 * A table's rows and the names it gives a number, as the unit checks read them: a row's cells
 * apart by tabs or bars, the run of rows that hold a number, and the heading rows above them.
 */
import { readFigures, readStatedUnits } from "../../../shared/figures";
import { memoized } from "../../../shared/memo";

/** `text` with its figures and stated units taken out: what is left says what they are. */
const withoutNumbers = memoized(
  16,
  (text: string) => text,
  (text: string): string => {
    const spans = [
      ...readFigures(text, { dates: true, midLine: true }),
      ...readStatedUnits(text),
    ].sort((a, b) => b.start - a.start);
    let rest = text;
    for (const { start, end } of spans) rest = `${rest.slice(0, start)} ${rest.slice(end)}`;
    return rest;
  },
);

/** Whether `text` has a word of its own beside its numbers: a name for what they measure. */
export const namesSomething = (text: string): boolean => /\p{L}/u.test(withoutNumbers(text));

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

// A heading row that doesn't line up with the row (a reader that drops a blank corner cell,
// a merged heading written once) can't say which heading is the number's, or whose another is.
const alignedHeadings = ({ lines, index, top, head }: Table): string[] =>
  lines
    .slice(head, top)
    .filter(
      (heading) =>
        !isRule(heading) && cellsOf(heading).length === cellsOf(lines[index] ?? "").length,
    );

/** The words that name a unit: "单位：万吨" states one, and a column headed 单位 or Unit holds each row's. */
export const UNIT_WORD = "(?:(?:计量|金额|货币|数量)?单位|units?)";
const UNIT_HEADING = new RegExp(`^\\s*${UNIT_WORD}\\s*$`, "iu");

/** The column that `table`'s headings name its units column, or -1: of two, none says whose. */
function unitsColumn(table: Table): number {
  const columns = new Set(
    alignedHeadings(table).flatMap((heading) =>
      cellsOf(heading).flatMap((cell, at) => (UNIT_HEADING.test(cell) ? [at] : [])),
    ),
  );
  const [only] = columns;
  return columns.size === 1 && only !== undefined ? only : -1;
}

/**
 * The cells that may name `table`'s number in its row: from the nearest named cell to its left,
 * each named cell up to its label or to a cell that names nothing (another panel's value). One
 * that holds a digit is a value or a label with a note number ("Earnings per share (note 7)"), and
 * nothing in the cell says which: the label rule leaves it out, and a reader that must not miss a
 * name reads it too. Read for a unit, a units column's cell (`units`) names nothing.
 */
export function possibleLabels(table: Table, units = -1): string[] {
  const left = cellsOf(table.lines[table.index] ?? "")
    .slice(0, table.column)
    .filter((_, at) => at !== units)
    .reverse();
  const names: string[] = [];
  for (const cell of left.slice(Math.max(left.findIndex(namesSomething), 0))) {
    if (!namesSomething(cell)) break;
    names.push(cell);
    if (!/\p{Nd}/u.test(cell)) break;
  }
  return names;
}

/**
 * The cells of its row that label `table`'s number for its unit: the nearest that may name it, a
 * note number and all ("原煤产量（万吨）（注1）"), where a cell left of the number holds a bracket
 * or a slash, and its cell of the table's units column (`units`, or -1).
 */
export function rowLabels(table: Table): { label: string; unit: string; units: number } {
  const units = unitsColumn(table);
  const cells = cellsOf(table.lines[table.index] ?? "");
  // Only a bracket or a slash states a unit in a label, and a long table's labels mostly hold none:
  // reading each to find which is the number's would cost its every row a figure reading.
  const marked = cells
    .slice(0, table.column)
    .some((cell, at) => at !== units && /[(（[［【〔/／]/u.test(cell));
  return {
    label: marked ? (possibleLabels(table, units)[0] ?? "") : "",
    unit: units >= 0 && units !== table.column ? (cells[units] ?? "") : "",
    units,
  };
}
