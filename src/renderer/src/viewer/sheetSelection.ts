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
 * The range's rows as the Document stores them, one part for each Unit: the
 * lines of the rows of its own that the User selected, in the Unit's order, so
 * the check finds them where they were selected. A later Unit's text begins
 * with the repeated header line, which `label.header` marks: a part that starts
 * at the Unit's first own row starts with that line too, or the selected rows
 * wouldn't be one stretch of the Document's text across a block edge. A Unit
 * whose own rows aren't selected adds nothing, even when the range takes the
 * header row that its text repeats. A row with nothing in it isn't a line.
 */
export function rangeParts(range: SheetRange, units: readonly TextUnit[]): SelectedPart[] {
  const parts: SelectedPart[] = [];
  for (const unit of units) {
    const rows = unit.label?.rows ?? [];
    const lines = unit.text.split("\n");
    const header = unit.label?.header === true ? rows[0] : undefined;
    const from = unit.label?.from ?? 0;
    const selected: string[] = [];
    let own = 0;
    rows.forEach((row, index) => {
      // The repeated header is context for this Unit's rows, not one of them.
      if (header !== undefined && row === header) return;
      if (row < range.fromRow || row > range.toRow) return;
      const line = lines[index];
      if (line !== undefined) selected.push(line);
      own += 1;
    });
    if (own === 0) continue;
    // The header line comes before the block's own rows in the text: a part that starts at
    // the block's first row must start with it, or it isn't one stretch of the Document.
    if (header !== undefined && range.fromRow <= from && lines[0] !== undefined) {
      selected.unshift(lines[0]);
    }
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

/** Whether a cell's row and column fall inside the range. */
export const isInRange = (range: SheetRange, row: number, column: number): boolean =>
  row >= range.fromRow &&
  row <= range.toRow &&
  column >= range.fromColumn &&
  column <= range.toColumn;

/** The range a drag's two corners cover, each row and column between them. */
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
