/**
 * How a workbook looks, besides its values: what the sheet preview draws to
 * show a sheet as Excel does (ADR-0011). Read only for the preview
 * (`readWorkbook(…, { layout })`); indexing never asks for it, so what is
 * stored and quoted doesn't depend on it.
 */
import type { DisplayValue } from "./numberDisplay";
import type { CellStyle, FontStyle } from "./xlsxStyles";

/** A cell's place as one number, row (from 1) by column (from 0): Excel has 16,384 columns. */
export const cellIndex = (row: number, column: number): number => row * 16_384 + column;

/** A run of a cell's rich text, in its own font. */
export interface TextRun {
  text: string;
  font?: FontStyle;
}

/** A point on the sheet: a cell, and an offset into it in CSS pixels. */
export interface SheetPoint {
  /** From 1. */
  row: number;
  /** From 0. */
  column: number;
  x: number;
  y: number;
}

/** A picture, chart or shape over the sheet's cells. */
export interface SheetDrawing {
  kind: "picture" | "chart" | "shape";
  /** Its top-left corner on the sheet. */
  from: SheetPoint;
  /** Its bottom-right corner, when it is anchored at two cells. */
  to?: SheetPoint;
  /** Its size in CSS pixels, when it is anchored at one cell. */
  size?: { width: number; height: number };
  /** A picture as a `data:` URL; null when its format can't be shown (EMF, WMF, too large). */
  src?: string | null;
  /** What it says: a picture's description, a chart's title, a shape's text. */
  text?: string;
  /** A chart's type: "bar", "line", "pie", … */
  chart?: string;
  /** A shape's fill, #RRGGBB. */
  fill?: string;
}

export interface RowLayout {
  /** In CSS pixels. */
  height?: number;
  hidden?: boolean;
  /** The cell format of the row's cells that the sheet doesn't list. */
  style?: number;
}

export interface ColumnLayout {
  /** In CSS pixels. */
  width?: number;
  hidden?: boolean;
  /** The cell format of the column's cells that the sheet doesn't list. */
  style?: number;
}

export interface SheetLayout {
  /** Cell formats (indexes into the workbook's styles) by `cellIndex`, empty cells too. */
  styles: Map<number, number>;
  /** What a cell shows as Excel shows it, where that differs from its indexed value. */
  shown: Map<number, DisplayValue>;
  /** Cells whose text is in runs of their own fonts. */
  runs: Map<number, TextRun[]>;
  /** Booleans and errors, which Excel centres. */
  centred: Set<number>;
  /** Formulas the file saved no result for: shown as such, never as 0 (#1514). */
  noValue: Set<number>;
  /** Notes on cells, which Excel marks with a red corner. */
  notes: Map<number, string>;
  /** By row number, from 1. */
  rows: Map<number, RowLayout>;
  /** By column, from 0. */
  columns: Map<number, ColumnLayout>;
  /** In CSS pixels. */
  defaultRowHeight: number;
  defaultColumnWidth: number;
  showGridLines: boolean;
  /** Rows and columns frozen at the top and left, as Excel's frozen panes. */
  frozen: { rows: number; columns: number } | null;
  drawings: SheetDrawing[];
  /** The last row and column (1- and 0-based) that formatting or drawings reach. */
  extent: { rows: number; columns: number };
  /** The sheet tab's colour, #RRGGBB. */
  tabColor?: string;
}

export interface WorkbookLayout {
  /** The cell formats, by index. */
  styles: CellStyle[];
  /** The Normal style's font: cells without a format of their own. */
  defaultFont: FontStyle;
  /** The sheet Excel opens at, by its index among the sheets read (hidden ones are not). */
  activeSheet: number;
}

/** What the sheet preview asks `readWorkbook` for. */
export interface LayoutOptions {
  /** The system's short date (Excel's format 14), e.g. "m/d/yyyy". */
  shortDate?: string;
}

/** An empty layout, with Excel's defaults. */
export function emptyLayout(): SheetLayout {
  return {
    styles: new Map(),
    shown: new Map(),
    runs: new Map(),
    centred: new Set(),
    noValue: new Set(),
    notes: new Map(),
    rows: new Map(),
    columns: new Map(),
    defaultRowHeight: 20,
    defaultColumnWidth: 64,
    showGridLines: true,
    frozen: null,
    drawings: [],
    extent: { rows: 0, columns: 0 },
  };
}

/** Excel's points as CSS pixels. */
export const pointsToPixels = (points: number): number => Math.round((points * 96) / 72);

/** A column width as Excel stores it (in characters of the default font, padding included) in CSS pixels. */
export const widthToPixels = (width: number): number => Math.round(width * 7);
