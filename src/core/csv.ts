/**
 * CSV as spreadsheets read it: UTF-8 with a byte order mark so Excel opens Chinese, CRLF
 * between rows, and a leading apostrophe on a cell a spreadsheet would take as a formula.
 */
export const CSV_BYTE_ORDER_MARK = "﻿";

export const csvCell = (value: string | number | null): string => {
  if (value === null) return "";
  const text = typeof value === "number" ? String(value) : value;
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export const csvRow = (cells: readonly (string | number | null)[]): string =>
  cells.map(csvCell).join(",");
