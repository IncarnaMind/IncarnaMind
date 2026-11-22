/**
 * A workbook someone else built, as a Note to check (#3278): one sheet, or a range of it, laid out
 * as a table the way a PDF's table is (./verifyTables), each row with a typed-in number a claim to
 * trace to the User's Documents, each formula worked out again by the workbook engine. Which cell
 * holds a typed-in number and which a formula is read from the file's structure here, never from a
 * word; what a number means is the checking model's reading, row by row.
 */
import * as Y from "yjs";
import { columnName, parseCellRef, type UnitText } from "../../../shared/units";
import { BLOCK_ID_ATTRIBUTE, type WorkbookSheetChoice } from "../../api";
import { formatNumber } from "../../documents/formats/numbers";
import {
  cellIndex,
  type WorkbookCell,
  type WorkbookModel,
  type WorkbookSheet,
  workbookModel,
} from "../../workbooks/model";
import type { CellRange } from "../../workbooks/parse";
import { cellsIn, placeKey, recalculate, WorkbookEngine } from "../../workbooks/recalculate";
import { type Scalar, toText } from "../../workbooks/values";
import type { NodeJSON } from "../blocks";

/** The most typed-in numbers one check takes: a bigger range is chosen smaller. */
export const MOST_TYPED_NUMBERS = 1_000;

const NUMBER_SHOWN = /^[\s(-]*[£$€¥]?\s*-?[\d,]*\.?\d+\s*[%)]?\s*[kKmMbB]?$/;
const FOUR_DIGIT_YEAR = /^(?:19|20)\d{2}$/;
const SCALE = "(?:[kKmMbB]|thousand|million|billion|trillion|[万亿])";
const NUMBER_TEXT = new RegExp(
  `^[\\s(-]*[£$€¥]?\\s*-?[\\d,]*\\.?\\d+\\s*[%)]?(?:\\s*${SCALE})?$`,
  "i",
);
const CURRENCY_TEXT = new RegExp(
  `^(?:(?:GBP|USD|EUR|JPY|CNY|RMB|CHF|CAD|AUD|HKD|SGD|INR|NZD|SEK|NOK|DKK|KRW|TWD)\\s*-?[\\d,]+(?:\\.\\d+)?(?:\\s*${SCALE})?|-?[\\d,]+(?:\\.\\d+)?(?:\\s*${SCALE})?\\s*(?:GBP|USD|EUR|JPY|CNY|RMB|CHF|CAD|AUD|HKD|SGD|INR|NZD|SEK|NOK|DKK|KRW|TWD))$`,
  "i",
);
const QUANTITY_TEXT =
  /^-?[\d,]+(?:\.\d+)?\s*(?:days?|weeks?|months?|years?|hours?|minutes?|bps|tonnes?|tons?|kg|km|miles?|shares?|units?)$/i;
const WORDS = /[\p{L}\p{N}]/u;

/** A cell holding a number someone typed, not one a formula worked out. */
export const isTyped = (cell: WorkbookCell): boolean =>
  cell.formula === null && typeof cell.saved === "number" && NUMBER_SHOWN.test(cell.shown);

/** A text cell that clearly states a figure ("GBP 500,000", "USD 1 million", "14 days"), never a bare year heading. */
function isTextFigure(shown: string): boolean {
  const trimmed = shown.trim();
  if (trimmed === "" || FOUR_DIGIT_YEAR.test(trimmed)) return false;
  return NUMBER_TEXT.test(trimmed) || CURRENCY_TEXT.test(trimmed) || QUANTITY_TEXT.test(trimmed);
}

const isHeaderRow = (cells: readonly WorkbookCell[]): boolean =>
  cells.length > 0 &&
  cells.every((cell) => cell.formula === null && !isTyped(cell) && !isTextFigure(cell.shown));

/** What a sheet or range holds, counted from occupied cells alone without building table nodes. */
export interface SheetCounts {
  typed: number;
  formulas: number;
  textRows: number;
}

/** Counts a sheet's (or range's) checkable content in linear time over occupied cells (#3575). */
export function sheetCounts(sheet: WorkbookSheet, range: CellRange | null): SheetCounts {
  const within = checkedRange(sheet, range);
  let firstRow = Number.POSITIVE_INFINITY;
  let firstColumn = Number.POSITIVE_INFINITY;
  const rows = new Map<number, WorkbookCell[]>();
  for (const cell of cellsIn(sheet, within)) {
    if (cell.row < firstRow) firstRow = cell.row;
    if (cell.column < firstColumn) firstColumn = cell.column;
    const list = rows.get(cell.row);
    if (list) list.push(cell);
    else rows.set(cell.row, [cell]);
  }
  const headed = isHeaderRow(rows.get(firstRow) ?? []);
  let typed = 0;
  let formulas = 0;
  let textRows = 0;
  for (const [row, cells] of rows) {
    if (headed && row === firstRow) continue;
    let rowTyped = 0;
    let rowFormulas = 0;
    let valueWords = false;
    for (const cell of cells) {
      if (cell.formula !== null) rowFormulas++;
      else if (isTyped(cell)) rowTyped++;
      else if (cell.column > firstColumn && WORDS.test(cell.shown)) valueWords = true;
    }
    typed += rowTyped;
    formulas += rowFormulas;
    if (rowTyped === 0 && rowFormulas === 0 && valueWords) textRows++;
  }
  return { typed, formulas, textRows };
}

/** The workbook of a Document's Units, or null when they aren't a workbook's (or hold no sheet). */
export function workbookOf(
  documentId: string,
  contentHash: string,
  units: readonly UnitText[],
): WorkbookModel | null {
  const model = workbookModel(documentId, contentHash, units);
  return model && model.sheets.length > 0 ? model : null;
}

export function sheetChoices(model: WorkbookModel): WorkbookSheetChoice[] {
  return model.sheets.map((sheet) => {
    const counts = sheetCounts(sheet, null);
    return {
      name: sheet.name,
      rows: sheet.rows.length,
      typed: counts.typed,
      formulas: counts.formulas,
      ...(counts.textRows > 0 && { textRows: counts.textRows }),
    };
  });
}

/** "B2:M40" as a range, or null when it isn't one. */
export function parseRange(text: string): CellRange | null {
  const [from, to, ...more] = text.trim().split(":");
  if (more.length > 0) return null;
  const first = parseCellRef(from ?? "");
  const last = parseCellRef(to ?? from ?? "");
  if (!first || !last) return null;
  return {
    top: Math.min(first.row, last.row),
    bottom: Math.max(first.row, last.row),
    left: Math.min(first.column, last.column),
    right: Math.max(first.column, last.column),
  };
}

/** A range as people write it, "B2:M40". */
export const rangeName = (range: CellRange): string =>
  `${columnName(range.left)}${range.top}:${columnName(range.right)}${range.bottom}`;

/** A row of the table: the sheet's row it is, and the places of its formula and typed-in cells. */
export interface TableRow {
  row: number;
  /** Their places in the table: the index into `SheetTable.columns`. */
  formulas: number[];
  typed: number[];
}

export interface SheetTable {
  node: NodeJSON;
  /** The sheet's columns the table has, in order. */
  columns: number[];
  /** The rows after the header, in order: row `i` of the table node is `rows[i]` (past a header row). */
  rows: TableRow[];
  headed: boolean;
  typed: number;
  formulas: number;
  /** Data rows with no formulas or typed-in numbers that `tableClaim` reads as claims (#3575). */
  textRows: number;
}

/** The range a check covers: the one given, else every cell the sheet holds. */
export const checkedRange = (sheet: WorkbookSheet, range: CellRange | null): CellRange =>
  range ?? {
    top: sheet.rows[0] ?? 1,
    bottom: sheet.lastRow,
    left: sheet.columns[0] ?? 0,
    right: sheet.lastColumn,
  };

const cellNode = (type: string, text: string, right: boolean): NodeJSON => ({
  type,
  attrs: { colspan: 1, rowspan: 1, ...(right && { align: "right" }) },
  content: [{ type: "paragraph", ...(text !== "" && { content: [{ type: "text", text }] }) }],
});

/** What a formula the file saved no result for works out to, and how its cell shows that. */
export interface WorkedCell {
  value: Scalar;
  shown: string;
}

/** A worked value as its cell's number format shows it, or as Excel's General does without one (#3412). */
function workedText(value: Scalar, format: string | undefined, date1904: boolean): string {
  if (typeof value === "number") return formatNumber(value, format, date1904);
  const text = toText(value);
  return typeof text === "string" ? text : text.code;
}

/** A cell's text in the Note: as the file shows it, or, for a formula it saved no result for, what that works out to. */
function cellText(cell: WorkbookCell | undefined, worked: ReadonlyMap<number, WorkedCell>): string {
  if (!cell) return "";
  const value = cell.unsaved ? worked.get(cellIndex(cell.row, cell.column)) : undefined;
  return value === undefined ? cell.shown : value.shown;
}

const NOTHING_WORKED: ReadonlyMap<number, WorkedCell> = new Map();

/**
 * The sheet, or the range of it, as a table, and what it holds: a header row when its first row
 * has only words. A formula the file saved no result for shows what `worked` says it works out to.
 */
export function sheetTable(
  sheet: WorkbookSheet,
  range: CellRange | null,
  worked: ReadonlyMap<number, WorkedCell> = NOTHING_WORKED,
): SheetTable {
  const within = checkedRange(sheet, range);
  const byRow = new Map<number, Map<number, WorkbookCell>>();
  for (const cell of cellsIn(sheet, within)) {
    const row = byRow.get(cell.row) ?? new Map<number, WorkbookCell>();
    row.set(cell.column, cell);
    byRow.set(cell.row, row);
  }
  const rowNumbers = [...byRow.keys()].sort((a, b) => a - b);
  const columns = [...new Set([...byRow.values()].flatMap((row) => [...row.keys()]))].sort(
    (a, b) => a - b,
  );
  const numeric = columns.map((column) =>
    rowNumbers.some((row) => {
      const cell = byRow.get(row)?.get(column);
      return (
        cell !== undefined &&
        (typeof cell.saved === "number" ||
          typeof worked.get(cellIndex(cell.row, cell.column))?.value === "number")
      );
    }),
  );
  const first = rowNumbers[0];
  const firstCells = first === undefined ? [] : [...(byRow.get(first)?.values() ?? [])];
  const headed = isHeaderRow(firstCells);
  const dataRows = headed ? rowNumbers.slice(1) : rowNumbers;
  const textOf = (row: number, column: number) => cellText(byRow.get(row)?.get(column), worked);
  let typed = 0;
  let formulas = 0;
  let textRows = 0;
  const rows: TableRow[] = dataRows.map((row) => {
    const cells = byRow.get(row) ?? new Map<number, WorkbookCell>();
    const formulaColumns: number[] = [];
    const typedColumns: number[] = [];
    columns.forEach((column, index) => {
      const cell = cells.get(column);
      if (!cell) return;
      if (cell.formula !== null) {
        formulas++;
        formulaColumns.push(index);
      } else if (isTyped(cell)) {
        typed++;
        typedColumns.push(index);
      }
    });
    if (
      formulaColumns.length === 0 &&
      typedColumns.length === 0 &&
      columns.slice(1).some((column) => WORDS.test(textOf(row, column)))
    ) {
      textRows++;
    }
    return { row, formulas: formulaColumns, typed: typedColumns };
  });
  return {
    headed,
    typed,
    formulas,
    textRows,
    rows,
    columns,
    node: {
      type: "table",
      content: [
        ...(headed && first !== undefined
          ? [
              {
                type: "tableRow",
                content: columns.map((column, index) =>
                  cellNode("tableHeader", textOf(first, column), numeric[index] === true),
                ),
              },
            ]
          : []),
        ...dataRows.map((row) => ({
          type: "tableRow",
          content: columns.map((column, index) =>
            cellNode("tableCell", textOf(row, column), numeric[index] === true),
          ),
        })),
      ],
    },
  };
}

/** A formula whose saved result is not what the workbook's own cells work out to, by its place. */
export interface FormulaDifferenceAt {
  row: number;
  column: number;
  saved: string;
  worked: string;
}

/** What working the formulas of a sheet or range out again came to. */
export interface FormulaCheck {
  /** Formula cells worked out again and compared with the result the file saved. */
  checked: number;
  /** Formula cells worked out here whose result the file didn't save: nothing to compare (#3412). */
  unsaved: number;
  /** Formula cells the engine can't work out (a function it doesn't read, another workbook): left unchecked. */
  unchecked: number;
  differs: FormulaDifferenceAt[];
  /** What each formula whose result the file didn't save works out to, by `cellIndex`. */
  worked: ReadonlyMap<number, WorkedCell>;
}

const shownValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "code" in value) return String((value as { code: string }).code);
  return String(value);
};

/**
 * Works the sheet's formulas out again, and finds those whose saved result differs. A cell after
 * one that differs is worked from the value worked out, so it is compared on its own formula.
 */
export async function checkFormulas(
  model: WorkbookModel,
  sheet: WorkbookSheet,
  range: CellRange | null,
  signal?: AbortSignal,
): Promise<FormulaCheck> {
  const cells = cellsIn(sheet, checkedRange(sheet, range)).filter((cell) => cell.formula !== null);
  const worked = new Map<number, WorkedCell>();
  if (cells.length === 0) return { checked: 0, unsaved: 0, unchecked: 0, differs: [], worked };
  const keys = cells.map((cell) => placeKey(sheet, cell.row, cell.column));
  const run = await recalculate(new WorkbookEngine(model), keys, {
    fromWorked: true,
    ...(signal && { signal }),
  });
  const differs: FormulaDifferenceAt[] = [];
  let unchecked = 0;
  let checked = 0;
  for (const cell of cells) {
    const result = run.results.get(placeKey(sheet, cell.row, cell.column));
    if (!result) {
      unchecked++;
      continue;
    }
    if (result.problem?.kind === "differs") {
      checked++;
      differs.push({
        row: cell.row,
        column: cell.column,
        saved: shownValue(result.problem.saved),
        worked: shownValue(result.problem.worked),
      });
    } else if (result.problem === null) checked++;
    else if (result.problem.kind === "no-saved-value" && result.worked !== undefined)
      worked.set(cellIndex(cell.row, cell.column), {
        value: result.worked,
        shown: workedText(result.worked, cell.format, model.date1904),
      });
    else unchecked++;
  }
  return { checked, unsaved: worked.size, unchecked, differs, worked };
}

const paragraphIdOf = (cell: unknown): string | null => {
  const paragraph = cell instanceof Y.XmlElement ? cell.toArray()[0] : null;
  const id = paragraph instanceof Y.XmlElement ? paragraph.getAttribute(BLOCK_ID_ATTRIBUTE) : null;
  return typeof id === "string" ? id : null;
};

/** The paragraph of a cell of the table as made into Blocks: `row` and `column` count from the table's data rows and columns. */
export function cellBlockId(
  element: Y.XmlElement,
  table: SheetTable,
  row: number,
  column: number,
): string | null {
  const at = element.toArray()[row + (table.headed ? 1 : 0)];
  return at instanceof Y.XmlElement ? paragraphIdOf(at.toArray()[column]) : null;
}
