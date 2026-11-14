/**
 * A quote that is cells of a table, as call help's quote line draws it (#2847): each cell's words
 * as the quote gives them, after its column's name where the table gives one. The tables are read
 * by the readers the app already has: a PDF's, Word file's or deck's from the tables its index
 * stored (`documentTables`); a sheet's or CSV's rows (`shownSheetRows`) under the header row the
 * index finds (`headerRow`); and a table written with tabs or bars in a Unit's text, found as the
 * figure checks find one (`tableAt`), but named only by a Markdown heading line its rule proves.
 * A cell no heading names keeps no name: no name is ever one the table doesn't give.
 */
import type { UnitText } from "../../shared/units";
import { documentTables } from "../analysis/documentTables";
import { sheetsOf, shownSheetRows } from "../analysis/ranges";
import type { QuoteCell } from "../api";
import { type Cell, headerRow, looksLikeFigure } from "../documents/formats/grid";
import { cellsOf, isRow, isRule, tableAt } from "./checks/figureMeasures";

export type { QuoteCell };

/** The most cells a quote's line names: a wider row draws as quoted. */
export const MOST_CELLS = 24;
/** The longest name or value a cell holds, in characters: a longer one draws the row as quoted. */
export const LONGEST_CELL = 200;

/** A table as its cells read: each column's heading ("" for none), and its rows below them. */
interface Grid {
  headings: readonly string[];
  rows: readonly (readonly string[])[];
}

/** A word, and where it is in its text. */
interface Word {
  text: string;
  start: number;
  end: number;
}

const wordsOf = (text: string): Word[] =>
  [...text.matchAll(/[^\s|]+/gu)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));

const same = (a: string, b: string) => a.normalize("NFKC") === b.normalize("NFKC");

/**
 * Where the quote's words run through `words` in order, each the same word but the first, which
 * may be a word's end, and the last, which may be its start, as a quote cut inside a cell is: the
 * index of the first, for each place it runs.
 */
function runsOf(said: readonly Word[], words: readonly { text: string }[]): number[] {
  const ends = (part: string, whole: string) => same(whole.slice(-part.length), part);
  const starts = (part: string, whole: string) => same(whole.slice(0, part.length), part);
  const found: number[] = [];
  for (let from = 0; from + said.length <= words.length; from++) {
    const fits = said.every((word, index) => {
      const there = words[from + index]?.text ?? "";
      if (said.length === 1) return same(word.text, there);
      if (index === 0) return ends(word.text, there);
      if (index === said.length - 1) return starts(word.text, there);
      return same(word.text, there);
    });
    if (fits) found.push(from);
  }
  return found;
}

/** The quote's own words for each cell it touches, in order, from where each of its words is. */
function cellsTouched(
  quote: string,
  said: readonly Word[],
  places: readonly { cell: string; name: string | null }[],
): QuoteCell[] {
  const cells: { key: string; name: string | null; first: Word; last: Word }[] = [];
  said.forEach((word, index) => {
    const place = places[index];
    if (!place) return;
    const open = cells.at(-1);
    if (open && open.key === place.cell) open.last = word;
    else cells.push({ key: place.cell, name: place.name, first: word, last: word });
  });
  return cells.map(({ name, first, last }) => ({
    name,
    value: quote.slice(first.start, last.end),
  }));
}

const named = (heading: string, value: string): string | null => {
  const name = heading.replace(/\s+/g, " ").trim();
  return name === "" || same(name, value) ? null : name;
};

/** A table's cells the quote runs through, with their columns' headings. */
function inGrid(quote: string, said: readonly Word[], grid: Grid): QuoteCell[][] {
  const words = grid.rows.flatMap((row, at) =>
    row.flatMap((text, column) =>
      wordsOf(text).map((word) => ({ ...word, cell: `${at}:${column}`, column })),
    ),
  );
  return runsOf(said, words).map((from) =>
    cellsTouched(
      quote,
      said,
      said.map((_, index) => {
        const word = words[from + index];
        return { cell: word?.cell ?? "", name: grid.headings[word?.column ?? -1] ?? "" };
      }),
    ).map((cell) => ({ ...cell, name: named(cell.name ?? "", cell.value) })),
  );
}

/** A sheet's or CSV's rows under its header row, as a grid from column A. */
function sheetGrids(units: readonly UnitText[]): Grid[] {
  return sheetsOf(units).map((sheet) => {
    const shown = shownSheetRows(units, sheet);
    const lineOf = (row: number) => {
      const line = shown.get(row);
      return line ? [...new Array<string>(line.first).fill(""), ...line.shown] : [];
    };
    const cells = new Map<number, Cell[]>(
      [...shown.keys()].map((row) => [
        row,
        lineOf(row).map((value, column) => ({
          row,
          column,
          value,
          numeric: looksLikeFigure(value.trim()),
        })),
      ]),
    );
    const header = headerRow(cells);
    const below = [...shown.keys()].filter((row) => header === null || row > header);
    return {
      headings: header === null ? [] : lineOf(header),
      rows: below.sort((a, b) => a - b).map(lineOf),
    };
  });
}

/**
 * The heading line over row `index` of a table written in text: the line just above the nearest
 * Markdown rule ("|---|") above the row, every line between them a row of the table, with as many
 * cells as the row. Null where no rule proves one: rows apart by tabs, or rows of words above
 * numbered ones, which may be the table's headings, a section's label, a caption or its own rows.
 */
function headingLine(lines: readonly string[], index: number): string[] | null {
  for (let at = index - 1; at > 0; at--) {
    const line = lines[at] ?? "";
    if (!isRow(line)) return null;
    if (!isRule(line)) continue;
    const heading = lines[at - 1] ?? "";
    if (!isRow(heading) || isRule(heading)) return null;
    const cells = cellsOf(heading);
    return cells.length === cellsOf(lines[index] ?? "").length ? cells : null;
  }
  return null;
}

/**
 * A table written in a Unit's text with tabs or bars: the cells the quote runs through. A Unit
 * whose tables its index stored is read from those alone, its own reading of its place.
 */
function inText(quote: string, said: readonly Word[], unit: UnitText): QuoteCell[][] {
  if (unit.kind === "rows" || (unit.label?.tables?.length ?? 0) > 0) return [];
  const words = wordsOf(unit.text);
  return runsOf(said, words).flatMap((from) => {
    const places: { cell: string; name: string | null }[] = [];
    for (let index = 0; index < said.length; index++) {
      const at = words[from + index]?.start ?? 0;
      const table = tableAt(unit.text, at);
      if (!table || !isRow(table.lines[table.index] ?? "")) return [];
      const heading = headingLine(table.lines, table.index);
      places.push({
        cell: `${table.index}:${table.column}`,
        name: heading?.[table.column] ?? "",
      });
    }
    return [
      cellsTouched(quote, said, places).map((cell) => ({
        ...cell,
        name: named(cell.name ?? "", cell.value),
      })),
    ];
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A stored Citation's cells, read tolerantly: a list of two or more cells within the caps, each
 * words with a name or none; anything else, malformed or in part, is none, and its quote line
 * draws as quoted.
 */
export function storedCells(value: unknown): QuoteCell[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > MOST_CELLS) return null;
  const cells: QuoteCell[] = [];
  for (const each of value) {
    if (!isRecord(each)) return null;
    const { name, value: words } = each;
    if (typeof words !== "string" || words === "" || words.length > LONGEST_CELL) return null;
    if (name === "") return null;
    if (name !== null && (typeof name !== "string" || name.length > LONGEST_CELL)) return null;
    cells.push({ name, value: words });
  }
  return cells;
}

/**
 * A quote's cells, when it is two or more cells of a table in the cited Units, in order: each with
 * its column's name where the table gives one, and its own words whole. Null when it isn't, when
 * the Units hold it in two places that name its cells otherwise, or when it is wider or longer
 * than a line holds (`MOST_CELLS`, `LONGEST_CELL`): its line then draws it as quoted.
 */
export function quoteCells(quote: string, units: readonly UnitText[]): QuoteCell[] | null {
  const said = wordsOf(quote);
  if (said.length < 2) return null;
  const readings = [
    ...documentTables(units).flatMap((table) =>
      inGrid(quote, said, {
        headings: table.headings,
        rows: table.rows.map((row) => row.cells.map((cell) => cell.text)),
      }),
    ),
    ...sheetGrids(units).flatMap((grid) => inGrid(quote, said, grid)),
    ...units.flatMap((unit) => inText(quote, said, unit)),
  ].filter((cells) => cells.length >= 2);
  const [first] = readings;
  if (!first) return null;
  if (readings.some((each) => JSON.stringify(each) !== JSON.stringify(first))) return null;
  const fits =
    first.length <= MOST_CELLS &&
    first.every(
      ({ name, value }) => value.length <= LONGEST_CELL && (name?.length ?? 0) <= LONGEST_CELL,
    );
  return fits ? first : null;
}
