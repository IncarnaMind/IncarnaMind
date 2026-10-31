/**
 * The check of a figure code gave in the OS sandbox (spike, docs/adr/0025):
 * what the code wrote in results.json is read field by field, since a model
 * wrote the code, and a figure that names the column and rows it came from
 * is worked out again here, from the Document's own cells, with the app's
 * arithmetic. Only then is it "recalculated"; the code's own word is never
 * enough.
 */
import type { AnalysisCell } from "../../shared/analysis";
import { sameNumber } from "../../shared/formula";

export const FIGURE_HOW = ["sum", "mean", "min", "max", "count"] as const;
export type FigureHow = (typeof FIGURE_HOW)[number];

/** The cells a figure says it was worked out from. */
export interface FigureSource {
  input: string;
  sheet: string | null;
  column: string;
  /** Each row's number in its sheet, the headings being row 1. */
  rows: number[];
  how: FigureHow;
}

export interface ClaimedFigure {
  name: string;
  label: string;
  unit: string | null;
  value: number;
  of: FigureSource | null;
}

export type FigureCheck =
  | { kind: "recalculated"; value: number }
  | { kind: "differs"; value: number }
  | { kind: "unchecked"; reason: string };

/** An input's rows as the app reads them: its headings, and each row's cells by its number. */
export interface InputTable {
  columns: readonly string[];
  rows: ReadonlyMap<number, readonly AnalysisCell[]>;
}

const MAX_FIGURES = 100;
const MAX_ROWS = 1_000_000;

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown, limit = 200): string | null =>
  typeof value === "string" ? value.slice(0, limit) : null;

function readSource(value: unknown): FigureSource | null {
  const given = fields(value);
  const input = text(given.input);
  const column = text(given.column);
  const how = FIGURE_HOW.find((each) => each === given.how);
  const rows = Array.isArray(given.rows) ? given.rows.slice(0, MAX_ROWS) : null;
  if (!input || column === null || !how || !rows) return null;
  if (!rows.every((row) => Number.isInteger(row) && row >= 2)) return null;
  return { input, sheet: text(given.sheet), column, rows: rows as number[], how };
}

/** The figures in results.json, as far as they can be read; at most `MAX_FIGURES`. */
export function readFigures(json: unknown): ClaimedFigure[] {
  const given = fields(json).figures;
  if (!Array.isArray(given)) return [];
  return given.slice(0, MAX_FIGURES).flatMap((each) => {
    const figure = fields(each);
    const name = text(figure.name);
    const value = figure.value;
    if (!name || typeof value !== "number" || !Number.isFinite(value)) return [];
    return [
      {
        name,
        label: text(figure.label) ?? name,
        unit: text(figure.unit, 20),
        value,
        of: figure.of === undefined ? null : readSource(figure.of),
      },
    ];
  });
}

function reduce(how: FigureHow, values: readonly number[]): number | null {
  if (how === "count") return values.length;
  if (values.length === 0) return null;
  if (how === "min") return Math.min(...values);
  if (how === "max") return Math.max(...values);
  const sum = values.reduce((total, each) => total + each, 0);
  return how === "sum" ? sum : sum / values.length;
}

/**
 * Works `figure` out again from the cells it names, read by `table` (the
 * app's own reading of the copied Document), and says whether it is the
 * same number to Excel's 15 digits.
 */
export function checkFigure(
  figure: ClaimedFigure,
  table: (input: string, sheet: string | null) => InputTable | null,
): FigureCheck {
  const source = figure.of;
  if (!source) return { kind: "unchecked", reason: "it doesn't name the cells it came from" };
  const read = table(source.input, source.sheet);
  if (!read) return { kind: "unchecked", reason: `${source.input} isn't one of its inputs` };
  const column = read.columns.indexOf(source.column);
  if (column < 0)
    return { kind: "unchecked", reason: `${source.input} has no column "${source.column}"` };
  const values: number[] = [];
  for (const row of source.rows) {
    const cells = read.rows.get(row);
    if (!cells) return { kind: "unchecked", reason: `${source.input} has no row ${row}` };
    const cell = cells[column] ?? null;
    if (cell === null || cell === "") continue;
    if (typeof cell !== "number") {
      return { kind: "unchecked", reason: `row ${row}'s ${source.column} isn't a number` };
    }
    values.push(cell);
  }
  const value = reduce(source.how, values);
  if (value === null) return { kind: "unchecked", reason: "the cells it names hold no numbers" };
  return sameNumber(value, figure.value)
    ? { kind: "recalculated", value }
    : { kind: "differs", value };
}

/** A CSV's records, quotes and all; blank records left out, as pandas leaves them out. */
function csvRecords(source: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  const end = () => {
    record.push(cell);
    cell = "";
  };
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    if (quoted) {
      if (char === '"' && source[at + 1] === '"') {
        cell += '"';
        at++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") end();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[at + 1] === "\n") at++;
      end();
      if (record.some((each) => each !== "")) records.push(record);
      record = [];
    } else cell += char;
  }
  if (cell !== "" || record.length > 0) {
    end();
    if (record.some((each) => each !== "")) records.push(record);
  }
  return records;
}

const PLAIN_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** A CSV's rows as `checkFigure` reads them: numbered from 2 under its headings. */
export function csvTable(source: string): InputTable {
  const [headings = [], ...records] = csvRecords(source);
  const rows = new Map<number, AnalysisCell[]>();
  records.forEach((record, index) => {
    rows.set(
      index + 2,
      record.map((cell) =>
        cell === "" ? null : PLAIN_NUMBER.test(cell.trim()) ? Number(cell) : cell,
      ),
    );
  });
  return { columns: headings, rows };
}
