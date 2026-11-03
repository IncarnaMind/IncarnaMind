/**
 * A range of cells the User selected in a sheet (#118): its place, its
 * cells as the note's table shows them, and its rows as the Document's own
 * text, one part for each of its Units, for the Citation check against them.
 */
import type { AskedTable, SelectedPart } from "../../../core/api";
import type { Translate } from "../../../shared/locations";
import type { TextUnit } from "../../../shared/units";

/** A range of cells in one sheet: rows from 1, columns from 0. */
export interface SheetRange {
  /** The sheet's name; null for a CSV's one sheet. */
  sheet: string | null;
  fromRow: number;
  toRow: number;
  fromColumn: number;
  toColumn: number;
  /** The sheet's own header row, if it has one: it comes along with the range. */
  headerRow: number | null;
}

/** What one cell shows. */
export type CellText = (row: number, column: number) => string;

/** The rows and columns the range covers. */
export const rangeSize = (
  range: SheetRange,
  t: Translate,
): { text: string; rows: number; columns: number } => {
  const rows = range.toRow - range.fromRow + 1;
  const columns = range.toColumn - range.fromColumn + 1;
  const rowWord = t(rows === 1 ? "viewer.selection.size.rows.one" : "viewer.selection.size.rows", {
    count: String(rows),
  });
  const columnWord = t(
    columns === 1 ? "viewer.selection.size.columns.one" : "viewer.selection.size.columns",
    { count: String(columns) },
  );
  return {
    text: t("viewer.selection.size", { rows: rowWord, columns: columnWord }),
    rows,
    columns,
  };
};

/** The range's cells, column by column from its first to its last, and the sheet's header row when it holds one. */
export function rangeTable(range: SheetRange, textOf: CellText): AskedTable {
  const header =
    range.headerRow !== null && range.headerRow < range.fromRow
      ? columnsOf(range, range.headerRow, textOf)
      : null;
  const rows: string[][] = [];
  for (let row = range.fromRow; row <= range.toRow; row++) rows.push(columnsOf(range, row, textOf));
  return { header, rows };
}

const columnsOf = (range: SheetRange, row: number, textOf: CellText): string[] => {
  const cells: string[] = [];
  for (let column = range.fromColumn; column <= range.toColumn; column++) {
    cells.push(textOf(row, column));
  }
  return cells;
};

/**
 * The range's rows as the Document stores them, one part for each Unit: each
 * of the Unit's lines that is a row selected, in the Unit's own order, so the
 * check finds them where the User selected them. A later Unit's `label.rows`
 * begins with the sheet's header row, and its text begins with that row's
 * line too, so a row's line is at the same index in both; a row with nothing
 * in it isn't a line at all.
 */
export function rangeParts(range: SheetRange, units: readonly TextUnit[]): SelectedPart[] {
  const parts: SelectedPart[] = [];
  for (const unit of units) {
    const rows = unit.label?.rows ?? [];
    const lines = unit.text.split("\n");
    const selected: string[] = [];
    rows.forEach((row, index) => {
      if (row < range.fromRow || row > range.toRow) return;
      const line = lines[index];
      if (line !== undefined) selected.push(line);
    });
    const text = selected.join("\n");
    if (text.trim() !== "") parts.push({ unit: unit.page, text });
  }
  return parts;
}

/** The range as copying cells from a spreadsheet gives it: its header row first, then each row, cells tab-separated. */
export function rangeTsv(table: AskedTable): string {
  return [...(table.header ? [table.header] : []), ...table.rows]
    .map((cells) => cells.map((cell) => cell.replace(/[\t\n\r]+/g, " ")).join("\t"))
    .join("\n");
}

/** The row and column of a cell's reference, or null. */
export const isInRange = (range: SheetRange, row: number, column: number): boolean =>
  row >= range.fromRow &&
  row <= range.toRow &&
  column >= range.fromColumn &&
  column <= range.toColumn;

/** The two corners of a range, in the order the User dragged them. */
export function rangeBetween(
  anchor: { row: number; column: number },
  focus: { row: number; column: number },
  sheet: string | null,
  headerRow: number | null,
): SheetRange {
  return {
    sheet,
    fromRow: Math.min(anchor.row, focus.row),
    toRow: Math.max(anchor.row, focus.row),
    fromColumn: Math.min(anchor.column, focus.column),
    toColumn: Math.max(anchor.column, focus.column),
    headerRow,
  };
}
