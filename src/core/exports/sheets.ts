/**
 * A workbook as the .xlsx writer (./xlsx) takes it (#132): sheets whose rows
 * and columns have ids of their own, so what builds a sheet names a cell by
 * the row and column it means and never counts letters. A comparison table
 * is one such book (./comparisonSheet); a later sheet in a Mind can be another.
 */

export interface SheetBook {
  sheets: Sheet[];
}

export interface Sheet {
  id: string;
  /** As its tab shows it; the writer keeps it to what Excel allows. */
  name: string;
  columns: SheetColumn[];
  rows: SheetRow[];
  /** The rows at the top and the columns at the left kept in view as the sheet scrolls. */
  frozen?: { rows: number; columns: number };
}

export interface SheetColumn {
  id: string;
  /** In characters of the default font, as Excel measures a column. */
  width?: number;
}

export interface SheetRow {
  id: string;
  header?: boolean;
  cells: SheetCell[];
}

export type CellValue =
  | { kind: "text"; text: string }
  | { kind: "number"; number: number }
  /** A day, "YYYY-MM-DD", written as the date serial Excel counts from 1900. */
  | { kind: "date"; date: string }
  | { kind: "empty" };

/** A cell of the book, by its sheet, row and column ids. */
export interface CellRef {
  sheet: string;
  row: string;
  column: string;
}

/** A formula as Excel's text, its references given as cells or ranges of the book: `["SUM(", { from, to }, ")"]`. */
export type Formula = (string | CellRef | { from: CellRef; to: CellRef })[];

export interface SheetCell {
  column: string;
  value: CellValue;
  /** An Excel number format: "0.0%", `"$"#,##0.0,,"m"`, "d mmmm yyyy". None: General. */
  format?: string;
  /** Excel works it out on opening; `value` is shown until then, if anything. */
  formula?: Formula;
  /** Its note, as Excel shows one when the cell is pointed at. */
  note?: string;
  link?: CellRef;
  wrap?: boolean;
}
