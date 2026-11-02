/**
 * What the tasks write their inputs with: a seeded random sequence, so every
 * run writes the same bytes, and the files a User would have (CSV, a
 * workbook with or without formulas). PDF, Word and PowerPoint files come
 * from the tests' own builders (tests/helpers), as the other evaluations'.
 */
import { createHash } from "node:crypto";
import { xlsxPackage } from "../../tests/helpers/office";
import { zipFingerprint } from "../../tests/helpers/zip";
import type { TaskInputs } from "./task";

/** A sequence of numbers in [0, 1) from `seed`: mulberry32. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw from `next`, by Box–Muller. */
export function normal(next: () => number): number {
  const u = Math.max(next(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

/** A whole number from `from` to `to`, both included. */
export const between = (next: () => number, from: number, to: number): number =>
  from + Math.floor(next() * (to - from + 1));

/** Rounded to `places` decimals, as a sheet stores a typed amount. */
export const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Digits, Latin letters and a few signs in their full-width forms: "ＣＣ０７". */
export const fullWidth = (text: string): string =>
  text.replace(/[0-9A-Za-z%,.-]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0));

type CsvCell = string | number | null;

/** CSV as a spreadsheet writes it: quoted where a cell needs it, CRLF line ends. */
export function csv(rows: readonly (readonly CsvCell[])[]): string {
  const cell = (value: CsvCell) => {
    if (value === null) return "";
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

/** A formula cell: its formula without "=", and the value Excel saved for it. */
export interface FormulaCell {
  formula: string;
  value: number | string;
}

export type SheetCell = string | number | null | FormulaCell;

export interface SheetData {
  name: string;
  /** Rows from 1, columns from A. */
  rows: readonly (readonly SheetCell[])[];
  /** Merged ranges, "A1:C1". */
  merges?: readonly string[];
}

export const columnName = (index: number): string => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
};

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function cellXml(ref: string, value: SheetCell): string {
  if (value === null) return "";
  if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === "string")
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  const formula = `<f>${escapeXml(value.formula)}</f>`;
  return typeof value.value === "number"
    ? `<c r="${ref}">${formula}<v>${value.value}</v></c>`
    : `<c r="${ref}" t="str">${formula}<v>${escapeXml(value.value)}</v></c>`;
}

/** An .xlsx of these sheets, in order: numbers as numbers, text inline, formulas with their saved values. */
export function xlsx(sheets: readonly SheetData[]): Uint8Array {
  return xlsxPackage({
    sheets: sheets.map((sheet) => {
      const rows = sheet.rows
        .map((cells, index) => {
          const row = index + 1;
          const xml = cells.map((value, column) => cellXml(`${columnName(column)}${row}`, value));
          return `<row r="${row}">${xml.join("")}</row>`;
        })
        .join("");
      const merges = sheet.merges?.length
        ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
        : "";
      return { name: sheet.name, xml: `<sheetData>${rows}</sheetData>${merges}` };
    }),
  });
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];

/**
 * SHA-256 over a task's files and data, in order: what reference.json was worked out from. A
 * workbook, document or deck counts by its zip fingerprint, since its deflated bytes differ
 * between builds of zlib (on CI's Linux and on macOS).
 */
export function inputsHash(inputs: TaskInputs): string {
  const hash = createHash("sha256");
  for (const file of inputs.files) {
    const zipped = ZIP.every((byte, index) => file.bytes[index] === byte);
    hash.update(`file:${file.name}\n`).update(zipped ? zipFingerprint(file.bytes) : file.bytes);
  }
  for (const [name, text] of Object.entries(inputs.data))
    hash.update(`data:${name}\n`).update(text);
  return hash.digest("hex");
}

/** UTF-8 bytes of a text. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
