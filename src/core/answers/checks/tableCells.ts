/**
 * A sentence in a table's cell, read as a User reads the table (#1459). The table is laid out on
 * its grid first (`tableLayout`), so a merged cell and a heading over two rows stand where they
 * show. The cell is then said with its row's labels (the cells in words to its left, and the
 * section row above it) and its column's headings, and with the cells in words to its right, such
 * as a unit or currency column: "收入 — 2024年: 100; 单位: 万元". Beside it go the line before
 * the table, the headings and the cell's row, its other figures left out: shown them, Claude
 * Haiku 5.5 called a right cell Contradicted for a wrong one beside it. A heading the grid doesn't
 * settle is left out rather than named wrong. Every check of a Mind's own sentences reads a cell
 * this way; Verify reads a PDF's tables by the row (./verifyTables).
 */
import { comparableSentence, sentenceSpans } from "../../../shared/sentences";
import { type TableCell, tableLayout } from "../../mindText";

/** A cell as the table holds it: its text as checks read it, and how it spans. */
export interface CellText {
  text: string;
  header: boolean;
  colspan: number;
  rowspan: number;
}

/** A table laid out on its grid, read once for all its cells. */
export interface TableReading {
  /** By row, then column: the cell that covers that place, null where none does. */
  grid: (CellText | null)[][];
  /** Where each cell starts. */
  at: Map<CellText, { row: number; column: number }>;
  /** How many of the first rows are headings. */
  headingRows: number;
  /** Each column's headings, top row first. */
  headings: string[];
  /** By row: the section's row nearest above it. */
  sections: string[];
  /** The line before the table, where its caption or unit line is. */
  before: string;
}

/** A section's own row in a table: "Revenue:" with nothing else in its row. */
export const isSection = (texts: readonly string[]) =>
  /[:：]$/.test(texts[0] ?? "") && texts.slice(1).every((text) => text === "");

const YEAR = /(?:19|20)\d{2}/g;
const LONGEST_CAPTION = 120;
const LONGEST_QUALIFIER = 40;

/** "2024", "2024年上半年", "Q1 2024", "FY2024/25": a period, not a figure. */
const isPeriod = (text: string) =>
  text.length <= 24 && /(?:19|20)\d{2}/.test(text) && !/\d{3,}/.test(text.replace(YEAR, ""));

const isFigure = (text: string) => /\d/.test(text) && !isPeriod(text);

const plain = (cell: CellText | null | undefined) => comparableSentence(cell?.text ?? "");

const inWords = (cell: CellText) => plain(cell) !== "" && !isFigure(plain(cell));

const distinct = (places: readonly (CellText | null | undefined)[]) => [
  ...new Set(places.filter((each): each is CellText => each != null)),
];

// A long paragraph before the table would bring in figures its row leaves out: only its last
// sentence, which leads into the table, goes.
function captionOf(text: string): string {
  const words = comparableSentence(text);
  if (words.length <= LONGEST_CAPTION) return words;
  const last = sentenceSpans(text).at(-1);
  return last ? comparableSentence(text.slice(last.from, last.to)) : "";
}

/** A section's row: its one cell with text ends with a colon, or spans the table. */
function sectionOf(places: readonly (CellText | null)[]): string | null {
  const [first, ...rest] = distinct(places);
  if (!first || rest.some((each) => plain(each) !== "")) return null;
  const spansTable = places.length > 1 && places.every((each) => each === first);
  return isSection([plain(first)]) || spansTable ? plain(first) : null;
}

export function readTable(rows: readonly (readonly CellText[])[], before: string): TableReading {
  const cells = new Map<TableCell, CellText>();
  const laid = tableLayout(
    rows.map((row) =>
      row.map((each) => {
        const cell: TableCell = {
          header: each.header,
          colspan: each.colspan,
          rowspan: each.rowspan,
          align: null,
          content: [],
        };
        cells.set(cell, each);
        return cell;
      }),
    ),
  );
  const at = new Map<CellText, { row: number; column: number }>();
  const grid = laid.rows.map((slots, row) => {
    const places: (CellText | null)[] = [];
    for (const slot of slots) {
      const cell = slot.cell ? (cells.get(slot.cell) ?? null) : null;
      if (cell && !slot.continued) at.set(cell, { row, column: places.length });
      for (let wide = slot.cell?.colspan ?? 1; wide > 0; wide--) places.push(cell);
    }
    while (places.length < laid.columns) places.push(null);
    return places;
  });
  const firstData = rows.findIndex((row) => row.length === 0 || row.some((each) => !each.header));
  const headingRows = firstData < 0 ? rows.length : firstData;
  const headings = Array.from({ length: laid.columns }, (_, column) =>
    distinct(grid.slice(0, headingRows).map((row) => row[column]))
      .map(plain)
      .filter((text) => text !== "")
      .join(" "),
  );
  let section = "";
  const sections = grid.map((places, row) => {
    const above = section;
    if (row >= headingRows) section = sectionOf(places) ?? section;
    return row < headingRows ? "" : above;
  });
  return { grid, at, headingRows, headings, sections, before: captionOf(before) };
}

// "" where the cell has none, or where the columns it spans have different ones: no heading is
// better than a wrong one.
function headingOf(table: TableReading, cell: CellText): string {
  const place = table.at.get(cell);
  if (!place || place.row < table.headingRows) return "";
  const spanned = table.headings.slice(place.column, place.column + cell.colspan);
  return spanned.every((each) => each === spanned[0]) ? (spanned[0] ?? "") : "";
}

/**
 * What a check sends for a sentence of `cell`: the claim, and what the table says of it. A figure
 * takes the cells in words to its right with it (a unit, a currency); a cell in words takes none,
 * since they are claims of their own.
 */
export function readCell(
  table: TableReading,
  cell: CellText,
  sentence: string,
): { claim: string; table: string } {
  const place = table.at.get(cell) ?? { row: 0, column: 0 };
  const row = distinct(table.grid[place.row] ?? []);
  const inHeadings = place.row < table.headingRows;
  const leftOf = (each: CellText) => (table.at.get(each)?.column ?? 0) < place.column;
  const labels = inHeadings ? [] : row.filter((each) => leftOf(each) && inWords(each));
  const qualifiers =
    inHeadings || inWords(cell)
      ? []
      : row.filter(
          (each) =>
            each !== cell &&
            !leftOf(each) &&
            inWords(each) &&
            plain(each).length <= LONGEST_QUALIFIER,
        );
  const section = table.sections[place.row] ?? "";
  const label = [labels.length > 0 ? section : section.replace(/[:：]$/, ""), ...labels.map(plain)]
    .filter((each) => each !== "")
    .join(" ");
  const heading = headingOf(table, cell);
  const said = [label && `${label} —`, heading && `${heading}:`, sentence]
    .filter((each) => each !== "")
    .join(" ");
  const qualified = qualifiers.map((each) => {
    const its = headingOf(table, each);
    return its ? `${its}: ${plain(each)}` : plain(each);
  });
  const shown = row.map((each) =>
    each === cell || labels.includes(each) || qualifiers.includes(each) || plain(each) === ""
      ? plain(each)
      : "…",
  );
  return {
    claim: qualified.length > 0 ? `${said}; ${qualified.join("; ")}` : said,
    table: [
      table.before,
      inHeadings ? "" : row.map((each) => headingOf(table, each)).join(" | "),
      shown.join(" | "),
    ]
      .filter((each) => each.replaceAll("|", "").trim() !== "")
      .join("\n"),
  };
}
