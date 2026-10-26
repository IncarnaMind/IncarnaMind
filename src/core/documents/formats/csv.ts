/**
 * CSV → one sheet of cells, and Units of blocks of rows (see ./grid).
 * RFC 4180: quoted fields, doubled quotes, CRLF or LF line ends; the
 * delimiter is a comma, or a tab or semicolon when the first line says so.
 * Values stay as written. Past `MAX_ROWS` rows or `MAX_CELLS` cells, reading
 * stops and the sheet says it was cut short. Ported from the office-formats spike.
 */
import type { TextUnit } from "../../../shared/units";
import { decodeText } from "../decode";
import { ExtractionError } from "./errors";
import { type Cell, gridUnits, MAX_CELLS, MAX_ROWS, type Workbook } from "./grid";

const NUMBER = /^[-+]?[£$€¥]?\(?\d[\d,]*(?:\.\d+)?\)?%?$/;

function delimiterOf(text: string): string {
  const first = text.slice(0, text.indexOf("\n") >>> 0);
  if (first.includes("\t")) return "\t";
  if (first.includes(";") && !first.includes(",")) return ";";
  return ",";
}

/** The rows of a CSV text, at most `maxRows` (and about `maxCells` cells), and whether there were more. */
export function parseCsv(
  text: string,
  maxRows = MAX_ROWS,
  maxCells = MAX_CELLS,
): { rows: string[][]; truncated: boolean } {
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let cells = 0;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    cells += row.length;
    row = [];
    field = "";
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at] as string;
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') {
        field += '"';
        at++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[at + 1] === "\n") at++;
      endRow();
      if ((rows.length >= maxRows || cells >= maxCells) && at + 1 < text.length) {
        return { rows, truncated: true };
      }
    } else field += char;
  }
  if (field !== "" || row.length) endRow();
  return { rows, truncated: false };
}

export interface CsvResult {
  units: TextUnit[];
  /** The one sheet, as a workbook for the grid. */
  workbook: Workbook;
}

export function extractCsv(bytes: Uint8Array): CsvResult {
  const text = decodeText(bytes);
  if (text === null)
    throw new ExtractionError("unreadable", "The file holds binary data, not text.");
  const { rows, truncated } = parseCsv(text.replace(/^\uFEFF/, ""));
  const cells: Cell[] = [];
  let columnCount = 0;
  rows.forEach((values, index) => {
    values.forEach((raw, column) => {
      const value = raw.trim();
      if (value === "") return;
      cells.push({ row: index + 1, column, value, numeric: NUMBER.test(value) });
      columnCount = Math.max(columnCount, column + 1);
    });
  });
  const sheet = {
    name: "",
    cells,
    merges: [],
    rowCount: rows.length,
    columnCount,
    columnWidths: [],
  };
  return {
    units: gridUnits([sheet], false),
    workbook: { sheets: [sheet], truncated, hiddenSheets: [], rowsCut: [], sheetsNotRead: [] },
  };
}
