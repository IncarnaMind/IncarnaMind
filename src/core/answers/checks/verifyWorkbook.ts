/**
 * A workbook someone else built, as a Note to check (#3278): one sheet, or a range of it, laid out
 * as a table the way a PDF's table is (./verifyTables), each row with a typed-in number a claim to
 * trace to the User's Documents, each formula worked out again by the workbook engine. Which cell
 * holds a typed-in number and which a formula is read from the file's structure here, never from a
 * word; what a number means is the checking model's reading, row by row.
 */
import { columnName, parseCellRef } from "../../../shared/units";
import type { NodeJSON } from "../blocks";
import {
  type WorkbookCell,
  type WorkbookModel,
  type WorkbookSheet,
  workbookModel,
} from "../../workbooks/model";
import type { CellRange } from "../../workbooks/parse";
import { cellsIn, placeKey, recalculate, WorkbookEngine } from "../../workbooks/recalculate";
import type { UnitText } from "../../../shared/units";

/** The most typed-in numbers one check takes: a bigger range is chosen smaller. */
export const MOST_TYPED_NUMBERS = 1_000;

/** What a sheet holds, for the choice of what to check. */
export interface SheetChoice {
  name: string;
  /** Rows with anything in them. */
  rows: number;
  /** Numbers typed into cells. */
  typed: number;
  /** Cells with a formula. */
  formulas: number;
}

const NUMBER_SHOWN = /^[\s(-]*[£$€¥]?\s*-?[\d,]*\.?\d+\s*[%)]?\s*[kKmMbB]?$/;

/** A cell holding a number someone typed, not one a formula worked out. */
export const isTyped = (cell: WorkbookCell): boolean =>
  cell.formula === null && typeof cell.saved === "number" && NUMBER_SHOWN.test(cell.shown);

/** The workbook of a Document's Units, or null when they aren't a workbook's (or hold no sheet). */
export function workbookOf(
  documentId: string,
  contentHash: string,
  units: readonly UnitText[],
): WorkbookModel | null {
  const model = workbookModel(documentId, contentHash, units);
  return model && model.sheets.length > 0 ? model : null;
}

export function sheetChoices(model: WorkbookModel): SheetChoice[] {
  return model.sheets.map((sheet) => {
    let typed = 0;
    let formulas = 0;
    for (const cell of sheet.cells.values()) {
      if (cell.formula !== null) formulas++;
      else if (isTyped(cell)) typed++;
    }
    return { name: sheet.name, rows: sheet.rows.length, typed, formulas };
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

/** A row of the table: the sheet's row it is, whether it has typed-in numbers, and its formulas. */
export interface TableRow {
  row: number;
  typed: boolean;
  /** The columns of its formula cells, with their places in the table (`column` counts from the table's own first). */
  formulas: { column: number; sheetColumn: number }[];
}

export interface SheetTable {
  node: NodeJSON;
  /** The rows after the header, in order: row `i` of the table node is `rows[i]` (past a header row). */
  rows: TableRow[];
  headed: boolean;
  typed: number;
  formulas: number;
}

const cellNode = (type: string, text: string, right: boolean): NodeJSON => ({
  type,
  attrs: { colspan: 1, rowspan: 1, ...(right && { align: "right" }) },
  content: [{ type: "paragraph", ...(text !== "" && { content: [{ type: "text", text }] }) }],
});

/** The sheet, or the range of it, as a table, and what it holds: a header row when its first row has only words. */
export function sheetTable(sheet: WorkbookSheet, range: CellRange | null): SheetTable {
  const within: CellRange = range ?? {
    top: sheet.rows[0] ?? 1,
    bottom: sheet.lastRow,
    left: sheet.columns[0] ?? 0,
    right: sheet.lastColumn,
  };
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
      return cell !== undefined && typeof cell.saved === "number";
    }),
  );
  const first = rowNumbers[0];
  const firstCells = first === undefined ? [] : [...(byRow.get(first)?.values() ?? [])];
  const headed =
    firstCells.length > 0 && firstCells.every((cell) => cell.formula === null && !isTyped(cell));
  const dataRows = headed ? rowNumbers.slice(1) : rowNumbers;
  let typed = 0;
  let formulas = 0;
  const rows: TableRow[] = dataRows.map((row) => {
    const cells = byRow.get(row) ?? new Map<number, WorkbookCell>();
    const formulaColumns: TableRow["formulas"] = [];
    let hasTyped = false;
    columns.forEach((column, index) => {
      const cell = cells.get(column);
      if (!cell) return;
      if (cell.formula !== null) {
        formulas++;
        formulaColumns.push({ column: index, sheetColumn: column });
      } else if (isTyped(cell)) {
        typed++;
        hasTyped = true;
      }
    });
    return { row, typed: hasTyped, formulas: formulaColumns };
  });
  const textOf = (row: number, column: number) => byRow.get(row)?.get(column)?.shown ?? "";
  return {
    headed,
    typed,
    formulas,
    rows,
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

/** A formula whose saved result is not what the workbook's own cells work out to. */
export interface FormulaDifference {
  row: number;
  column: number;
  saved: string;
  worked: string;
}

/** What working the formulas of a sheet or range out again came to. */
export interface FormulaCheck {
  /** Formula cells worked out again and compared. */
  checked: number;
  /** Formula cells the engine can't work out (a function it doesn't read, a volatile one): left unchecked. */
  unchecked: number;
  differs: FormulaDifference[];
}

const shownValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "code" in value) return String((value as { code: string }).code);
  return String(value);
};

/** Works the sheet's formulas out again, and finds those whose saved result differs. */
export async function checkFormulas(
  model: WorkbookModel,
  sheet: WorkbookSheet,
  range: CellRange | null,
  signal?: AbortSignal,
): Promise<FormulaCheck> {
  const within = range ?? {
    top: 1,
    bottom: sheet.lastRow,
    left: 0,
    right: sheet.lastColumn,
  };
  const cells = cellsIn(sheet, within).filter((cell) => cell.formula !== null);
  if (cells.length === 0) return { checked: 0, unchecked: 0, differs: [] };
  const keys = cells.map((cell) => placeKey(sheet, cell.row, cell.column));
  const run = await recalculate(new WorkbookEngine(model), keys, signal ? { signal } : {});
  const differs: FormulaDifference[] = [];
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
    else unchecked++;
  }
  return { checked, unchecked, differs };
}
