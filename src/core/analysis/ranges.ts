import type { AnalysisCell } from "../../shared/analysis";
import { cellNumber, columnName, parseCellRef, type UnitText } from "../../shared/units";

/** The most rows, and cells, one range gives an Analysis: more, and only its first rows are read. */
export const MAX_RANGE_ROWS = 20_000;
export const MAX_RANGE_CELLS = 500_000;

/** Rows and columns of a sheet, from 1 and 0 as A1 references count them; null ends: to the sheet's last. */
export interface RangeBounds {
  firstRow: number;
  lastRow: number | null;
  firstColumn: number;
  lastColumn: number | null;
}

export type ParsedRange =
  | { ok: true; sheet: string | null; bounds: RangeBounds }
  | { ok: false; problem: string };

const WHOLE: RangeBounds = { firstRow: 1, lastRow: null, firstColumn: 0, lastColumn: null };

/**
 * A range as the model writes it: "A1:F1240", "'Q3 2025'!B2:D40", "rows
 * 1–1,240" or "1-1240"; nothing, the whole sheet.
 */
export function parseRange(written: string | undefined): ParsedRange {
  const text = (written ?? "").trim();
  if (text === "") return { ok: true, sheet: null, bounds: WHOLE };
  const named = /^(?:'((?:[^']|'')+)'|([^!'\s][^!]*))!(.+)$/.exec(text);
  const sheet = named ? (named[1]?.replaceAll("''", "'") ?? named[2]?.trim() ?? null) : null;
  const rest = (named?.[3] ?? text).trim();
  const rows = /^(?:rows?\s*)?(\d[\d,]*)\s*(?:[-–—~～]|to|至|到)\s*(\d[\d,]*)$/iu.exec(rest);
  if (rows) {
    const from = Number((rows[1] ?? "").replaceAll(",", ""));
    const to = Number((rows[2] ?? "").replaceAll(",", ""));
    if (from < 1 || to < from)
      return { ok: false, problem: `rows ${rest} run backwards or start before row 1` };
    return { ok: true, sheet, bounds: { ...WHOLE, firstRow: from, lastRow: to } };
  }
  const [start, end] = rest.split(":").map((part) => part.trim());
  const from = start ? parseCellRef(start) : null;
  const to = end ? parseCellRef(end) : null;
  if (!from || (end !== undefined && !to)) {
    return {
      ok: false,
      problem: `"${written}" is not a range: give one like "A1:F1240" or "rows 1-1240"`,
    };
  }
  const last = to ?? from;
  if (last.row < from.row || last.column < from.column) {
    return { ok: false, problem: `${rest} runs backwards: give its top-left cell first` };
  }
  return {
    ok: true,
    sheet,
    bounds: {
      firstRow: from.row,
      lastRow: last.row,
      firstColumn: from.column,
      lastColumn: last.column,
    },
  };
}

const PLAIN_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const GROUPED_NUMBER = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

function cellOf(shown: string, label: UnitText["label"], ref: string): AnalysisCell {
  const stored = cellNumber(label, ref);
  if (stored !== null) return stored;
  if (shown === "") return null;
  if (PLAIN_NUMBER.test(shown)) return Number(shown);
  // A CSV keeps the text it has: "1,240" is a number with thousands separators.
  if (GROUPED_NUMBER.test(shown)) return Number(shown.replaceAll(",", ""));
  return shown;
}

/** Each row of a sheet (or of a CSV, `sheet` null) in a Document version's Units, by its number, cells from column A. */
export function sheetRows(
  units: readonly UnitText[],
  sheet: string | null,
): Map<number, AnalysisCell[]> {
  const rows = new Map<number, AnalysisCell[]>();
  for (const unit of units) {
    if (unit.kind !== "rows" || (unit.label?.sheet ?? null) !== sheet) continue;
    const numbers = unit.label?.rows ?? [];
    const first = unit.label?.column ?? 0;
    unit.text.split("\n").forEach((line, index) => {
      const row = numbers[index];
      if (row === undefined || rows.has(row)) return;
      const cells: AnalysisCell[] = new Array<AnalysisCell>(first).fill(null);
      line.split("\t").forEach((shown, offset) => {
        cells.push(cellOf(shown, unit.label, `${columnName(first + offset)}${row}`));
      });
      rows.set(row, cells);
    });
  }
  return rows;
}

/** The sheets a Document version's rows hold, in order: one null for a CSV's. */
export function sheetsOf(units: readonly UnitText[]): (string | null)[] {
  const found: (string | null)[] = [];
  for (const unit of units) {
    if (unit.kind !== "rows") continue;
    const sheet = unit.label?.sheet ?? null;
    if (!found.includes(sheet)) found.push(sheet);
  }
  return found;
}

export interface ReadRange {
  headingRow: number;
  /** Each column's heading, from the range's first row; its letter where that row is empty. */
  columns: string[];
  rows: AnalysisCell[][];
  /** The sheet's number of each row: an empty row of the sheet isn't one of them. */
  rowNumbers: number[];
  /** As read, in A1 terms: "A1:F1240". */
  range: string;
  /** How many rows the range has under its headings: more than `rows` when it was cut. */
  rowCount: number;
  /**
   * Only part of it was read: it has more rows or cells than an Analysis
   * reads, or it runs to the end of a sheet that was itself cut when its
   * Document was read, at the same limits.
   */
  cut: boolean;
}

/** The range of a sheet's rows, its first row the headings; null when it holds none. */
export function readRange(
  rows: ReadonlyMap<number, readonly AnalysisCell[]>,
  bounds: RangeBounds,
): ReadRange | null {
  const numbers = [...rows.keys()]
    .filter((row) => row >= bounds.firstRow && (bounds.lastRow === null || row <= bounds.lastRow))
    .sort((a, b) => a - b);
  const [headingRow, ...dataRows] = numbers;
  if (headingRow === undefined) return null;
  const widest = Math.max(...numbers.map((row) => rows.get(row)?.length ?? 0));
  const lastColumn = Math.min(bounds.lastColumn ?? widest - 1, widest - 1);
  if (lastColumn < bounds.firstColumn) return null;
  const width = lastColumn - bounds.firstColumn + 1;
  const slice = (row: number) =>
    Array.from(
      { length: width },
      (_, offset) => rows.get(row)?.[bounds.firstColumn + offset] ?? null,
    );
  const columns = slice(headingRow).map((cell, offset) =>
    cell === null || cell === "" ? columnName(bounds.firstColumn + offset) : String(cell),
  );
  const kept = Math.min(dataRows.length, MAX_RANGE_ROWS, Math.floor(MAX_RANGE_CELLS / width));
  const read = dataRows.slice(0, kept);
  const lastStored = Math.max(...rows.keys());
  const cells = [...rows.values()].reduce(
    (sum, row) => sum + row.filter((cell) => cell !== null).length,
    0,
  );
  const sheetCut = rows.size >= MAX_RANGE_ROWS || cells >= MAX_RANGE_CELLS;
  const toTheEnd = bounds.lastRow === null || bounds.lastRow > lastStored;
  const lastRead = read.at(-1) ?? headingRow;
  return {
    headingRow,
    columns,
    rows: read.map(slice),
    rowNumbers: read,
    range: `${columnName(bounds.firstColumn)}${headingRow}:${columnName(lastColumn)}${lastRead}`,
    rowCount: dataRows.length,
    cut: read.length < dataRows.length || (sheetCut && toTheEnd),
  };
}
