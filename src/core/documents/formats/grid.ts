/**
 * Sheets of cells, from an Excel workbook or a CSV file, and the Units they
 * are stored in: each sheet in blocks of rows (ADR-0011).
 *
 * A block's text has one line per row, listing the row's cells from the
 * sheet's first column, separated by tabs, so the cells read in order and a
 * cell's place in the text gives its reference. A block holds up to
 * `BLOCK_ROWS` rows and about `BLOCK_CHARACTERS` characters (about 400
 * tokens), whichever comes first, so a Passage of about 500 tokens takes in
 * a block or two. Every block after a sheet's first repeats its header row
 * at the top, so each Passage knows its columns. Pure.
 */
import {
  columnName,
  parseCellRef,
  type TextUnit,
  type UnitLabel,
  type WorkbookFacts,
} from "../../../shared/units";
import type { SheetLayout, WorkbookLayout } from "./sheetLayout";

/** The most rows a block holds. */
export const BLOCK_ROWS = 100;
/** About how many characters of rows a block holds: about 400 tokens. */
export const BLOCK_CHARACTERS = 1600;
/**
 * The most rows one pass reads from a Document, over all its sheets: the rest
 * are left out. Hidden sheets are read in a pass of their own, so a workbook
 * read with them can read up to twice this (#740).
 */
export const MAX_ROWS = 20_000;
/** The most cells one pass reads from a Document. */
export const MAX_CELLS = 500_000;

export interface Cell {
  /** From 1. */
  row: number;
  /** From 0. */
  column: number;
  /** As shown: formatted as the file's number format says. */
  value: string;
  /** A number (or date), shown right-aligned. */
  numeric: boolean;
  /**
   * The cell's number as the file stores it, when its shown text isn't that
   * number written plainly ("4.2%" for 0.04213). Not for dates, which stay
   * ISO text.
   */
  raw?: number;
}

export interface Sheet {
  name: string;
  cells: Cell[];
  /** Merged ranges, e.g. "A1:F1". */
  merges: string[];
  /** The last row and column used: 1-based and 0-based. */
  rowCount: number;
  columnCount: number;
  /** Column widths in CSS pixels, where the file sets them, by column from 0. */
  columnWidths: number[];
  /** How the sheet looks, when the sheet preview asked for it (./sheetLayout). */
  layout?: SheetLayout;
  /** A workbook's formulas by cell, without "=" (#2347); see `UnitLabel.formulas`. */
  formulas?: Map<string, string>;
  /** Values its cells saved that their shown text doesn't give, by cell (#2347); see `UnitLabel.saved`. */
  saved?: Map<string, number | string | boolean>;
}

export interface Workbook {
  sheets: Sheet[];
  /** Rows were left out because the file is over `MAX_ROWS` rows or `MAX_CELLS` cells. */
  truncated: boolean;
  /** Hidden and very hidden sheets left out, by name, in the file's order (#740). */
  hiddenSheets: string[];
  /** Sheets with rows left out at the reading limit: the first row not read, from 1 (#740). */
  rowsCut: { sheet: string; from: number }[];
  /** Sheets after the limit was reached, from which nothing was read (#740). */
  sheetsNotRead: string[];
  /** The workbook's styles, when the sheet preview asked for them. */
  layout?: WorkbookLayout;
  /** What its formulas need beyond its cells (#2347). */
  facts?: WorkbookFacts;
}

const NUMERIC = /^[-+(]?[£$€¥]?\d[\d,.]*%?\)?$/;

/** Whether a cell holds words rather than a figure, even one stored as text ("1,200"). */
export const holdsWords = (cell: Pick<Cell, "value" | "numeric">): boolean =>
  !cell.numeric && !NUMERIC.test(cell.value);

/** Whether a row looks like a header: two cells or more, mostly words. */
export function looksLikeHeader(cells: readonly Pick<Cell, "value" | "numeric">[]): boolean {
  if (cells.length < 2) return false;
  const words = cells.filter(holdsWords).length;
  return words * 2 > cells.length;
}

/** The sheet's header row: among its first 10 rows, the first that looks like one. */
export function headerRow(rows: ReadonlyMap<number, Cell[]>): number | null {
  const numbers = [...rows.keys()].sort((a, b) => a - b).slice(0, 10);
  return numbers.find((number) => looksLikeHeader(rows.get(number) ?? [])) ?? null;
}

/** A row's line: its cells from `firstColumn`, tab-separated, empty cells empty. */
function rowLine(cells: readonly Cell[], firstColumn: number): string {
  const values: string[] = [];
  for (const cell of cells)
    values[cell.column - firstColumn] = cell.value.replace(/[\t\n\r]+/g, " ");
  return Array.from(values, (value) => value ?? "").join("\t");
}

/**
 * Puts a sheet's formulas and saved values (#2347) in the labels of the Units
 * that hold their rows; a cell whose row has nothing to show goes in the
 * nearest Unit above it, or the sheet's first.
 */
function placeCellFacts(
  sheet: Sheet,
  labels: readonly { rows: number[]; label: UnitLabel }[],
): void {
  if (labels.length === 0) return;
  const byRow = new Map<number, UnitLabel>();
  for (const { rows, label } of labels) for (const row of rows) byRow.set(row, label);
  const labelOf = (ref: string): UnitLabel | undefined => {
    const row = parseCellRef(ref)?.row ?? 0;
    const own = byRow.get(row);
    if (own) return own;
    return (labels.findLast((each) => (each.rows[0] ?? 0) <= row) ?? labels[0])?.label;
  };
  for (const [ref, formula] of sheet.formulas ?? []) {
    const label = labelOf(ref);
    if (label) label.formulas = { ...label.formulas, [ref]: formula };
  }
  for (const [ref, value] of sheet.saved ?? []) {
    const label = labelOf(ref);
    if (label) label.saved = { ...label.saved, [ref]: value };
  }
}

/**
 * Units for sheets: blocks of rows, numbered on from `firstUnit`. `named`:
 * the sheets have names to show (a workbook's), unlike a CSV's one sheet.
 * A workbook's `facts` go in its first Unit's label.
 */
export function gridUnits(
  sheets: readonly Sheet[],
  named: boolean,
  firstUnit = 1,
  facts?: WorkbookFacts,
): TextUnit[] {
  const units: TextUnit[] = [];
  for (const sheet of sheets) {
    const labels: { rows: number[]; label: UnitLabel }[] = [];
    const rows = new Map<number, Cell[]>();
    let firstColumn = Number.POSITIVE_INFINITY;
    for (const cell of sheet.cells) {
      const list = rows.get(cell.row) ?? [];
      list.push(cell);
      rows.set(cell.row, list);
      firstColumn = Math.min(firstColumn, cell.column);
    }
    if (rows.size === 0) continue;
    for (const list of rows.values()) list.sort((a, b) => a.column - b.column);
    const numbers = [...rows.keys()].sort((a, b) => a - b);
    const header = headerRow(rows);
    const headerLine = header === null ? null : rowLine(rows.get(header) ?? [], firstColumn);

    let at = 0;
    while (at < numbers.length) {
      const block: number[] = [];
      const lines: string[] = [];
      let characters = 0;
      while (at < numbers.length && block.length < BLOCK_ROWS) {
        const number = numbers[at] as number;
        const line = rowLine(rows.get(number) ?? [], firstColumn);
        if (block.length > 0 && characters + line.length > BLOCK_CHARACTERS) break;
        block.push(number);
        lines.push(line);
        characters += line.length + 1;
        at++;
      }
      const first = block[0] as number;
      // Sparse: only cells whose shown text isn't their number, by reference ("C12").
      const values: Record<string, number> = {};
      for (const number of block) {
        for (const cell of rows.get(number) ?? []) {
          if (cell.raw !== undefined) values[`${columnName(cell.column)}${number}`] = cell.raw;
        }
      }
      const repeatHeader = header !== null && headerLine !== null && first > header;
      const label: UnitLabel = {
        ...(named ? { sheet: sheet.name } : {}),
        from: first,
        to: block.at(-1) as number,
        rows: repeatHeader ? [header, ...block] : block,
        column: firstColumn,
        ...(repeatHeader ? { header: true } : {}),
        ...(Object.keys(values).length > 0 ? { values } : {}),
      };
      labels.push({ rows: block, label });
      units.push({
        page: firstUnit + units.length,
        kind: "rows",
        label,
        text: (repeatHeader ? [headerLine, ...lines] : lines).join("\n"),
        anchors: null,
      });
    }
    placeCellFacts(sheet, labels);
  }
  const head = units[0];
  if (facts && head?.label) head.label.workbook = facts;
  return units;
}
