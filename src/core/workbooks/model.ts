/**
 * A workbook as a model (#2347): each cell's saved value beside its formula,
 * its defined names, and what of it wasn't read, built from the rows Units a
 * version of a workbook was stored as (see ../documents/formats/xlsx). The
 * Units are what a Citation quotes, so a figure worked out from this model is
 * cited to the very text it was read from.
 */
import { cellNumber, columnName, type UnitText, type WorkbookFacts } from "../../shared/units";
import { cellName, ERROR_CODES, type FormulaNode, parseFormula } from "./parse";
import { error, type Scalar } from "./values";

export interface WorkbookCell {
  row: number;
  column: number;
  /** The value the workbook saved: a formula's last result. Null for an empty cell. */
  saved: Scalar;
  /** As the cell shows it, as its Unit's text holds it. */
  shown: string;
  /** As the workbook writes it, without its "="; an array formula in braces. Null for a constant. */
  formula: string | null;
  /** The workbook saved no result for its formula. */
  unsaved: boolean;
  /** The Unit whose text holds it, for its Citation. */
  unit: UnitText | null;
}

export interface WorkbookSheet {
  name: string;
  index: number;
  cells: Map<number, WorkbookCell>;
  /** Filled rows, in order, each with its cells by column. */
  rows: number[];
  rowCells: Map<number, WorkbookCell[]>;
  /** Filled columns, in order, each with its rows in order. */
  columns: number[];
  columnRows: Map<number, number[]>;
  lastRow: number;
  lastColumn: number;
  /** The first row the reading limit left out; null when every row was read. */
  cutFrom: number | null;
}

export interface DefinedName {
  name: string;
  /** The sheet it belongs to; null for the whole workbook's. */
  sheet: string | null;
  refersTo: string;
}

export interface WorkbookModel {
  documentId: string;
  contentHash: string;
  sheets: WorkbookSheet[];
  /** Sheets by their name, upper-cased: Excel's sheet names ignore case. */
  byName: Map<string, WorkbookSheet>;
  names: DefinedName[];
  /** Sheets the workbook has that weren't read, upper-cased. */
  unread: Set<string>;
  date1904: boolean;
  /** Excel works its circular references out by iterating (File › Options › Formulas). */
  iterate: boolean;
  /** Excel was set to calculate by hand, so a saved result may be older than its inputs. */
  manual: boolean;
  formulaCount: number;
}

/** A cell's place as one number, as ../documents/formats/sheetLayout counts it. */
export const cellIndex = (row: number, column: number): number => row * 16_384 + column;

const PLAIN_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const ERROR_TEXT: ReadonlySet<string> = new Set(ERROR_CODES);

function savedValue(shown: string, unit: UnitText, ref: string): Scalar {
  const label = unit.label;
  const given = label?.saved?.[ref];
  if (given !== undefined) return given;
  const stored = cellNumber(label, ref);
  if (stored !== null) return stored;
  if (shown === "") return null;
  if (shown === "TRUE" || shown === "FALSE") return shown === "TRUE";
  if (ERROR_TEXT.has(shown)) return error(shown as (typeof ERROR_CODES)[number]);
  if (PLAIN_NUMBER.test(shown)) return Number(shown);
  return shown;
}

function emptySheet(name: string, index: number): WorkbookSheet {
  return {
    name,
    index,
    cells: new Map(),
    rows: [],
    rowCells: new Map(),
    columns: [],
    columnRows: new Map(),
    lastRow: 0,
    lastColumn: -1,
    cutFrom: null,
  };
}

/** Whether a version's Units are a workbook's rows that keep their formulas (processing version 19 on). */
export const hasFormulas = (units: readonly UnitText[]): boolean =>
  units.some((unit) => unit.kind === "rows" && unit.label?.workbook !== undefined);

/** The model of one version of a workbook, from its Units; null when they aren't a workbook's. */
export function workbookModel(
  documentId: string,
  contentHash: string,
  units: readonly UnitText[],
): WorkbookModel | null {
  const rowsUnits = units.filter((unit) => unit.kind === "rows" && unit.label?.sheet !== undefined);
  const facts: WorkbookFacts | undefined = rowsUnits.find((unit) => unit.label?.workbook)?.label
    ?.workbook;
  if (!facts) return null;
  const sheets: WorkbookSheet[] = [];
  const byName = new Map<string, WorkbookSheet>();
  const sheetOf = (name: string) => {
    const key = name.toUpperCase();
    let sheet = byName.get(key);
    if (!sheet) {
      sheet = emptySheet(name, sheets.length);
      sheets.push(sheet);
      byName.set(key, sheet);
    }
    return sheet;
  };
  const put = (sheet: WorkbookSheet, cell: WorkbookCell) => {
    sheet.cells.set(cellIndex(cell.row, cell.column), cell);
  };
  let formulaCount = 0;
  for (const unit of rowsUnits) {
    const sheet = sheetOf(unit.label?.sheet ?? "");
    const rows = unit.label?.rows ?? [];
    const first = unit.label?.column ?? 0;
    const lines = unit.text.split("\n");
    lines.forEach((line, index) => {
      const row = rows[index];
      if (row === undefined) return;
      line.split("\t").forEach((shown, offset) => {
        if (shown === "") return;
        const column = first + offset;
        const at = cellIndex(row, column);
        if (sheet.cells.has(at)) return;
        const ref = cellName(row, column);
        put(sheet, {
          row,
          column,
          saved: savedValue(shown, unit, ref),
          shown,
          formula: null,
          unsaved: false,
          unit,
        });
      });
    });
  }
  for (const unit of rowsUnits) {
    const sheet = sheetOf(unit.label?.sheet ?? "");
    for (const [ref, formula] of Object.entries(unit.label?.formulas ?? {})) {
      const parsed = /^([A-Z]{1,3})(\d+)$/.exec(ref);
      if (!parsed) continue;
      const row = Number(parsed[2]);
      const column = columnIndex(parsed[1] ?? "A");
      const at = cellIndex(row, column);
      const cell = sheet.cells.get(at);
      if (cell) {
        if (cell.formula === null) formulaCount++;
        cell.formula = formula;
      } else {
        formulaCount++;
        const given = unit.label?.saved?.[ref];
        put(sheet, {
          row,
          column,
          saved: given ?? null,
          shown: "",
          formula,
          unsaved: given === undefined,
          unit: given === undefined ? null : unit,
        });
      }
    }
  }
  for (const sheet of sheets) indexSheet(sheet);
  for (const cut of facts.cut ?? []) {
    const sheet = byName.get(cut.sheet.toUpperCase());
    if (sheet) sheet.cutFrom = cut.from;
  }
  const unread = new Set((facts.unread ?? []).map((name) => name.toUpperCase()));
  for (const sheet of sheets) unread.delete(sheet.name.toUpperCase());
  return {
    documentId,
    contentHash,
    sheets,
    byName,
    names: facts.names ?? [],
    unread,
    date1904: facts.date1904 === true,
    iterate: facts.iterate === true,
    manual: facts.manual === true,
    formulaCount,
  };
}

function columnIndex(letters: string): number {
  let value = 0;
  for (const letter of letters) value = value * 26 + (letter.charCodeAt(0) - 64);
  return value - 1;
}

function indexSheet(sheet: WorkbookSheet): void {
  const ordered = [...sheet.cells.values()].sort((a, b) => a.row - b.row || a.column - b.column);
  for (const cell of ordered) {
    let row = sheet.rowCells.get(cell.row);
    if (!row) {
      row = [];
      sheet.rowCells.set(cell.row, row);
      sheet.rows.push(cell.row);
    }
    row.push(cell);
    let column = sheet.columnRows.get(cell.column);
    if (!column) {
      column = [];
      sheet.columnRows.set(cell.column, column);
    }
    column.push(cell.row);
    sheet.lastRow = Math.max(sheet.lastRow, cell.row);
    sheet.lastColumn = Math.max(sheet.lastColumn, cell.column);
  }
  sheet.columns = [...sheet.columnRows.keys()].sort((a, b) => a - b);
}

/** The first index of a sorted list at or after `value`. */
export function firstAtOrAfter(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] ?? 0) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** A defined name, as a formula on `sheet` sees it: its sheet's own first, then the workbook's. */
export function definedName(
  model: WorkbookModel,
  sheet: string | null,
  name: string,
  written: string | null = null,
): DefinedName | null {
  const wanted = name.toUpperCase();
  const scope = (written ?? sheet)?.toUpperCase() ?? null;
  return (
    (scope !== null
      ? model.names.find(
          (each) => each.sheet?.toUpperCase() === scope && each.name.toUpperCase() === wanted,
        )
      : undefined) ??
    (written === null
      ? model.names.find((each) => each.sheet === null && each.name.toUpperCase() === wanted)
      : undefined) ??
    null
  );
}

const parsed = new WeakMap<DefinedName, FormulaNode>();
export function nameFormula(name: DefinedName): FormulaNode {
  let node = parsed.get(name);
  if (!node) {
    node = parseFormula(name.refersTo);
    parsed.set(name, node);
  }
  return node;
}

/** A cell as its sheet and A1 reference write it: "Assumptions!C5". */
export function placeName(sheet: string, row: number, column: number): string {
  return `${sheet}!${columnName(column)}${row}`;
}
