/**
 * What a figure's number measures, as a check's Figures line names it (#2255): the sentence's
 * words for it, its quote's words, and the model's judgement in the same reply of whether the two
 * name the same measure. A "differs" takes support away. A table's cell is the one place the code
 * can tell on its own: words that are another row's label or another column's heading of the
 * cell's own table name another number. Anything else is left to the check as before.
 */
import { MARKER } from "../../../shared/answerSentences";
import { readFigures, readStatedUnits } from "../../../shared/figures";
import { memoized } from "../../../shared/memo";
import { isRecord } from "../../errors";

/** The words a Figures item names for what its number measures, as the reply gives them. */
export interface FigureMeasure {
  sentence: string;
  /** Null when the quote names nothing but its number. */
  quote: string | null;
  match: "same" | "differs";
}

const MEASURE_CHARACTERS = 300;
/** The longest words a reason shows: a longer copy leaves the reason to the reply's own words. */
const SHOWN_CHARACTERS = 80;

/** An item's measure as written, or null when it gives none that can be read. */
export function readMeasure(value: unknown): FigureMeasure | null {
  if (!isRecord(value)) return null;
  const { sentence, quote, match } = value;
  // The reply's words carry a marker where they repeat a recorded quote: it isn't theirs.
  const words = (text: unknown) => {
    const bare = typeof text === "string" ? text.replace(MARKER, "").trim() : "";
    return bare !== "" && bare.length <= MEASURE_CHARACTERS ? bare : null;
  };
  const said = words(sentence);
  const quoted = quote === null ? null : words(quote);
  if (said === null || (quoted === null && quote !== null)) return null;
  if (match !== "same" && match !== "differs") return null;
  return { sentence: said, quote: quoted, match };
}

// Letters and digits in runs, a Han character on its own, case and width aside.
const wordsOf = (text: string): string[] =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .match(/\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}\p{M}])+/gu) ?? [];

function inOrder(all: readonly string[], part: readonly string[]): boolean {
  if (part.length === 0) return false;
  for (let at = 0; at + part.length <= all.length; at++) {
    if (part.every((word, index) => all[at + index] === word)) return true;
  }
  return false;
}

const holds = (text: string, words: string): boolean => inOrder(wordsOf(text), wordsOf(words));

/**
 * `text` with its figures and stated units taken out: what is left says what they are. A table's
 * label is read for whether it names something, then again for whether a sentence says it.
 */
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
const isRule = (line: string): boolean => /^[\s|:-]+$/.test(line) && line.includes("-");

/** Width, case and runs of spaces aside; a sheet's tabs and every line break stay. */
const flat = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\S\n\t]+/g, " ")
    .replace(/ ?\n ?/g, "\n");

const digit = (char: string | undefined) => char !== undefined && /\p{N}/u.test(char);
/** A letter of a script that writes spaces between words: Chinese runs into its numbers. */
const spaced = (char: string | undefined) =>
  char !== undefined &&
  /\p{L}/u.test(char) &&
  !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);

/**
 * Where flat `text` writes `quote` as text, any run of spaces, tabs or a line break in it taken
 * for another: "21%" isn't in "21.5%", "121%" or "1.21%", nor "rent" in "current".
 */
function placesOf(text: string, quote: string): { start: number; end: number }[] {
  const part = flat(quote).trim();
  if (part === "") return [];
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Whether the quote's `edge` runs on into `text` at `at`, the way `step` goes.
  const runsOn = (edge: string | undefined, at: number, step: -1 | 1) =>
    (digit(edge) && (digit(text[at]) || (/[.,]/.test(text[at] ?? "") && digit(text[at + step])))) ||
    (spaced(edge) && spaced(text[at]));
  return [...text.matchAll(new RegExp(escaped, "gu"))]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }))
    .filter(({ start, end }) => !runsOn(part[0], start - 1, -1) && !runsOn(part.at(-1), end, 1));
}

/** The number a figure is bound to, as its quote writes it, and where in the quote. */
export interface BoundNumber {
  chars: string;
  at: number;
}

/** Where `bound` is in flat `text`'s stretch from `start` to `end`: the one the quote writes, counted from its start. */
function boundAt(
  text: string,
  { start, end }: { start: number; end: number },
  quote: string,
  bound: BoundNumber,
): number {
  const nth = placesOf(flat(quote.slice(0, bound.at + bound.chars.length)), bound.chars).length - 1;
  const inside = placesOf(text.slice(start, end), bound.chars);
  const pick = inside[nth] ?? inside[0];
  return pick ? start + pick.start : start;
}

/** A row's cells, by the separator it uses: tabs in a sheet, else bars. */
const cellsOf = (line: string): string[] => line.split(line.includes("\t") ? "\t" : "|");

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

type Table = NonNullable<ReturnType<typeof tableAt>>;

// In side-by-side panels ("| Revenue | 12% | Operating margin | 94% |") the first cell
// labels another number: the label is the nearest named cell to the left, never one with a
// digit, a value the figure reader may leave unread ("6.1p", "2.6 days").
const labelOf = (row: readonly string[], column: number) =>
  row
    .slice(0, column)
    .reverse()
    .find((cell) => namesSomething(cell) && !/\p{Nd}/u.test(cell));

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
 * or a slash, and its cell of the table's units column.
 */
export function rowLabels(table: Table): { label: string; unit: string } {
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
  };
}

/** The names `table` gives its number: the nearest named cell to its left and the heading of its own column. */
export const ownNames = (table: Table): string[] =>
  [
    labelOf(cellsOf(table.lines[table.index] ?? ""), table.column) ?? "",
    ...alignedHeadings(table).map((heading) => cellsOf(heading)[table.column] ?? ""),
  ].filter(namesSomething);

/** The names a table gives its number one way, its own and its other numbers'. */
export interface CellNames {
  own: string[];
  /**
   * The names of its other numbers that `keep` takes, each with its number's cell. Read only when
   * asked, `keep` first: a long table's rows cost more to read than a sentence's names.
   */
  others(keep: (name: string) => boolean): { name: string; cell: string }[];
}

/**
 * The names `table` gives its number and its other numbers: by row, its row's label (the nearest
 * named cell to its left) and the label of each other row of its table that holds a number in its
 * column; by column, its own column's headings and the heading of each other column that holds a
 * number in its row. Null when its row has no label.
 */
export function cellNames(table: Table): { rows: CellNames; columns: CellNames } | null {
  const { lines, index, column, top, end } = table;
  const cells = cellsOf(lines[index] ?? "");
  const label = labelOf(cells, column);
  // A label merged over several rows is written once, or trimmed away: such a row can't say whose
  // its number is.
  if (label === undefined) return null;
  const headings = alignedHeadings(table);
  // Only another number's own names name it: a heading over the labels ("Revenue (£m)"), a
  // section row or a units column names no other number.
  return {
    rows: {
      own: [label],
      others: (keep) =>
        lines.slice(top, end + 1).flatMap((line, place) => {
          if (place + top === index) return [];
          const row = cellsOf(line);
          const name = labelOf(row, column) ?? "";
          const cell = row[column];
          return keep(name) && holdsNumber(cell) ? [{ name, cell: cell ?? "" }] : [];
        }),
    },
    columns: {
      own: headings.map((heading) => cellsOf(heading)[column] ?? ""),
      others: (keep) =>
        headings.flatMap((heading) =>
          cellsOf(heading).flatMap((name, place) =>
            place !== column && keep(name) && holdsNumber(cells[place])
              ? [{ name, cell: cells[place] ?? "" }]
              : [],
          ),
        ),
    },
  };
}

/**
 * The names of the cell that holds `quote`'s number in `text`'s table, once `text` holds the
 * quote once: its own and those of the table's other numbers (`cellNames`). Null when the number
 * isn't in a table's row, its row has no label, or `text` doesn't hold the quote just once.
 */
function cellOf(
  text: string,
  quote: string,
  bound: BoundNumber,
): { own: string[]; others: string[] } | null {
  const all = flat(text);
  const [found, more] = placesOf(all, quote);
  if (!found || more) return null;
  const table = tableAt(all, boundAt(all, found, quote, bound));
  const names = table && cellNames(table);
  if (!table || !names) return null;
  return {
    own: ownNames(table),
    others: [...names.columns.others(namesSomething), ...names.rows.others(namesSomething)].map(
      ({ name }) => name,
    ),
  };
}

/** A measure's words, their digits left out. */
const named = (text: string): string[] => wordsOf(text).filter((word) => !/^\p{N}+$/u.test(word));

/** Whether `text` holds the measure's `words`, their digits left out of both. */
const namedIn = (text: string, words: string): boolean => inOrder(named(text), named(words));

/** Whether `text` says `name`'s words beside its numbers and stated units: "二厂人数为31人" says "人数". */
export function saysName(text: string, name: string): boolean {
  const words = withoutNumbers(name);
  return /\p{L}/u.test(words) && namedIn(text, words);
}

/** Whether `text` names just what `words` do: "Revenue" isn't "Revenue per store". */
const namedAs = (text: string, words: string): boolean =>
  named(text).join(" ") === named(words).join(" ");

export type MeasureFinding =
  | { kind: "same" }
  /** `shown`: the two measures as a reason names them; null when either can't be shown as written. */
  | { kind: "differs"; shown: { measured: string; claimed: string } | null }
  /** The quote's words for a table cell are another row's label or another column's heading. */
  | { kind: "other-cell" }
  /** Nothing the code can tell apart: the check goes on as it did before measures. */
  | { kind: "unknown" };

/**
 * Whether a figure's source measures what the sentence's figure does. `sentence`: the texts the
 * sentence's words may come from (the sentence, its figure's label and context, its paragraph);
 * `quote`: the source quote, and `bound` the number in it; `passage`: the texts the quote is in,
 * its cited pages first, read only for a table's cell.
 */
export function measureFinding(
  measure: FigureMeasure | null,
  sentence: readonly string[],
  quote: string,
  bound: BoundNumber,
  passage: () => readonly string[],
): MeasureFinding {
  if (!measure) return { kind: "unknown" };
  const said = measure.sentence;
  const quoted = measure.quote;
  // The first text that holds the quote once decides, its cited pages before the rest.
  const cell = () => {
    for (const text of passage()) {
      if (placesOf(flat(text), quote).length > 0) return cellOf(text, quote, bound);
    }
    return null;
  };
  // The same words on both sides can't name two measures: a model that compared the numbers.
  // Their digits count here: "Scope 1 emissions" isn't "Scope 2 emissions".
  if (measure.match === "differs" && quoted !== null && holds(quoted, said) && holds(said, quoted))
    return { kind: "unknown" };
  if (measure.match === "differs") {
    const shown = (words: string, texts: readonly string[]) =>
      words.length <= SHOWN_CHARACTERS &&
      readFigures(words, { midLine: true }).length === 0 &&
      texts.some((text) => holds(text, words));
    const where = quoted === null ? [] : [quote, ...(cell()?.own ?? [])];
    return {
      kind: "differs",
      shown:
        quoted !== null && shown(quoted, where) && shown(said, sentence)
          ? { measured: quoted, claimed: said }
          : null,
    };
  }
  const tabled = quote.split("\n").some(isRow) || !namesSomething(quote);
  const found = quoted === null || !tabled ? null : cell();
  if (found === null || quoted === null) return { kind: "unknown" };
  if (found.own.some((names) => namedIn(names, quoted))) return { kind: "same" };
  if (found.others.some((names) => namedAs(names, quoted))) return { kind: "other-cell" };
  return { kind: "unknown" };
}
