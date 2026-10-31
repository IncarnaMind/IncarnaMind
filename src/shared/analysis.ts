/**
 * Analyses (ADR-0023): the job an `AnalysisRuntime` runs, what a run comes
 * to, and the limits what it gives is cut to. What comes back from the
 * sandbox was made by code a model wrote, so it is read here, field by field,
 * and cut to the limits again before anything else uses it.
 *
 * Pure: the core, the main process and the tests share it.
 */
import { CHART_KINDS, type ChartKind, MAX_CHART_VALUES } from "./charts";
import type { MessageKey } from "./i18n";

/** The languages an Analysis is written in: Python first; JavaScript on QuickJS later (ADR-0023). */
export type AnalysisLanguage = "python";

/** A cell of a table an Analysis reads or gives: what its sheet stores, null where it is empty. */
export type AnalysisCell = string | number | boolean | null;

/** What an Analysis reads, under the name its code reads it by: `inputs["sales"]`. */
export type AnalysisInput =
  | {
      kind: "table";
      name: string;
      /** Each column's heading, in order. */
      columns: readonly string[];
      rows: readonly (readonly AnalysisCell[])[];
      /** The row number of `rows[0]` in its sheet, which reports of cells count from. */
      firstRow: number;
      /** Each row's own number in its sheet, where they don't all follow on from `firstRow`. */
      rowNumbers?: readonly number[];
    }
  | { kind: "number"; name: string; value: number };

export interface AnalysisJob {
  language: AnalysisLanguage;
  code: string;
  inputs: readonly AnalysisInput[];
  /** How long it may run, in ms; `ANALYSIS_TIME_LIMIT_MS` when absent. */
  timeLimitMs?: number;
}

/** How long a job runs before it is stopped, unless it says. */
export const ANALYSIS_TIME_LIMIT_MS = 60_000;

/**
 * What a run gives is cut to these: the rows and columns of each table, how
 * many tables, figures and charts, and the characters printed. The rest keep
 * what the code reports bounded however it was written.
 */
export const ANALYSIS_LIMITS = {
  rows: 200,
  columns: 30,
  tables: 20,
  figures: 100,
  charts: 5,
  chartRows: MAX_CHART_VALUES,
  pictures: 5,
  /** A picture's PNG, and its longest side in pixels: what a Note keeps of a pasted picture. */
  pictureBytes: 1_500_000,
  pictureEdge: 1600,
  /** The runs of consecutive rows a figure's rows are kept as: rows scattered wider aren't traced. */
  figureRowRuns: 2000,
  printed: 20_000,
  steps: 100,
  merges: 50,
  notNumbers: 50,
  literals: 200,
  /** Of each column's cells that are not numbers, how many are listed. */
  cellsListed: 20,
  labelCharacters: 200,
  cellCharacters: 300,
  errorCharacters: 4000,
} as const;

/** A table a run gave, cut to the limits. */
export interface AnalysisTable {
  columns: string[];
  rows: AnalysisCell[][];
  /** How many rows and columns it had: more than kept when it was cut. */
  rowCount: number;
  columnCount: number;
}

/** How `figure()` works a figure out from its column, which the app does again from the cells. */
export const FIGURE_HOW = ["sum", "mean", "min", "max", "count"] as const;
export type FigureHow = (typeof FIGURE_HOW)[number];

/**
 * The rows of an input a figure was worked out from (#2346): `figure(name,
 * column, how)`'s one column, or the rows and columns `result(..., of=)` names,
 * such as those a model was fitted on.
 */
export interface AnalysisFigureRows {
  /** The input, by the name the code reads it by. */
  input: string;
  /** The headings of the columns it used. */
  columns: string[];
  /** Its rows' numbers in the sheet, as runs of consecutive rows in order: [[2, 9], [11, 41]]. */
  rows: [number, number][];
  /** How many rows. */
  count: number;
  /** `figure()`'s; null for `result(..., of=)`, which the app doesn't work out again. */
  how: FigureHow | null;
}

/** A result the code gave with `result(name, value, label, unit)` or `figure(...)`: a figure or a table. */
export type AnalysisValue =
  | {
      kind: "figure";
      name: string;
      label: string;
      unit: string | null;
      value: number;
      /** The rows it was worked out from; absent when the code didn't name them. */
      of?: AnalysisFigureRows;
    }
  | { kind: "table"; name: string; label: string; unit: string | null; table: AnalysisTable };

/** What IncarnaMind's own arithmetic made of a `figure()` figure, from the cells it read (ADR-0025). */
export type AnalysisRecalculation =
  | { kind: "same"; value: number }
  | { kind: "differs"; value: number }
  | { kind: "unchecked"; reason: string };

/** A plot matplotlib drew, as a PNG (#2346). */
export interface AnalysisPicture {
  /** Its title, or its first chart's; "" when it has none. */
  title: string;
  /** The PNG, in base64. */
  png: string;
  /** In pixels. */
  width: number;
  height: number;
}

/** A step the code recorded with `step(label, data)`, and the rows and columns after it. */
export interface AnalysisStep {
  label: string;
  rows: number;
  columns: number;
}

/** A chart the code drew with `chart(kind, data, x, y, title)`: the column along its axis and those drawn. */
export interface AnalysisChart {
  kind: ChartKind;
  title: string;
  x: string;
  y: string[];
  table: AnalysisTable;
}

/** A merge in the code: how many rows of each side found a match. Null counts: they couldn't be counted. */
export interface AnalysisMerge {
  /** The code's line that merged. */
  line: number | null;
  how: string;
  leftRows: number;
  rightRows: number;
  /** Rows the merge gave. */
  rows: number;
  /** Rows of an outer merge on the same keys that both sides had. */
  matched: number | null;
  /** Rows of one side that matched none of the other's. */
  leftOnly: number | null;
  rightOnly: number | null;
}

/** Cells of an input's column of numbers that are not numbers: read as missing. */
export interface AnalysisNotNumbers {
  input: string;
  column: string;
  count: number;
  /** The first of them: the row in the sheet, and what the cell holds ("" when it is empty). */
  cells: { row: number; value: string }[];
}

/** A number written in the code, which a calculation should take from an input instead. */
export interface AnalysisLiteral {
  value: number;
  line: number;
  /** As written: "1_000", "-0.2". */
  text: string;
}

/** How many of each were left out to stay within the limits, and whether what was printed was cut. */
export interface AnalysisCut {
  figures: number;
  tables: number;
  charts: number;
  pictures: number;
  steps: number;
  merges: number;
  notNumbers: number;
  literals: number;
  printed: boolean;
}

/** What a run gave, in the order the code gave it: also when it ended in an error. */
export interface AnalysisOutput {
  steps: AnalysisStep[];
  results: AnalysisValue[];
  charts: AnalysisChart[];
  /** Absent in an Analysis run before pictures came back (#2346). */
  pictures?: AnalysisPicture[];
  /**
   * The titles of plots left out because their text has characters no bundled
   * font draws, such as Chinese, which would show as boxes.
   */
  withoutGlyphs?: string[];
  merges: AnalysisMerge[];
  notNumbers: AnalysisNotNumbers[];
  /** Listed before the code ran, so also when it failed. */
  literals: AnalysisLiteral[];
  /** What it printed and its warnings, up to `ANALYSIS_LIMITS.printed` characters. */
  printed: string;
  cut: AnalysisCut;
}

/**
 * Why Analyses can't run on this computer:
 * - "missing": this copy of IncarnaMind has no runtime, or its files are missing;
 * - "start": its sandbox or interpreter couldn't start;
 * - "no-sandbox": the app runs with Chromium's sandbox off (`--no-sandbox`), so
 *   nothing would keep the code from the computer.
 */
export type AnalysisUnavailableReason = "missing" | "start" | "no-sandbox";

/** How to turn the sandbox back on, for the distributions that block it. */
export const LINUX_SANDBOX_HELP_URL =
  "https://github.com/IncarnaMind/IncarnaMind/blob/main/docs/linux-sandbox.md";

/**
 * What the User reads where an Analysis would have been, when it couldn't
 * run, and the link that says how to fix it, where there is one.
 */
export const UNAVAILABLE_LINES: Readonly<
  Record<AnalysisUnavailableReason, { text: MessageKey; fix?: { label: MessageKey; url: string } }>
> = {
  missing: { text: "analysis.unavailable.missing" },
  start: { text: "analysis.unavailable.start" },
  "no-sandbox": {
    text: "analysis.unavailable.noSandbox",
    fix: { label: "analysis.unavailable.noSandbox.fix", url: LINUX_SANDBOX_HELP_URL },
  },
};

/** How a run ended. */
export type AnalysisEnd =
  | { kind: "done" }
  /** Python's own message, its last lines, and the line of the code it came from. */
  | { kind: "error"; message: string; line: number | null }
  | { kind: "timed-out"; limitMs: number }
  | { kind: "stopped" }
  | { kind: "out-of-memory" }
  /** Python or its window stopped under the code, for no reason it gave: the log has the detail. */
  | { kind: "crashed" }
  /** `detail`: technical, in English, for the log. */
  | { kind: "unavailable"; reason: AnalysisUnavailableReason; detail: string };

/** What the User reads of a run that crashed. */
export const CRASHED_LINE: MessageKey = "analysis.crashed";

export interface AnalysisResult {
  end: AnalysisEnd;
  output: AnalysisOutput;
  /** How long the code ran, in ms, starting the runtime left out. */
  ms: number;
}

/** What a runtime runs a language with, recorded with every run. */
export interface AnalysisVersions {
  language: AnalysisLanguage;
  /** The language's own version: "3.14.2". */
  languageVersion: string;
  /** What runs it, and its version: "Pyodide 314.0.7". */
  runtime: string;
  /** Each package it loads, by name: `{ numpy: "2.4.6" }`. */
  packages: Readonly<Record<string, string>>;
  /** SHA-256 of the helper every job runs through (`incarnamind`): its rules are part of the result. */
  helper: string;
  /** The IncarnaMind version that ran it. */
  app: string;
}

export const noAnalysisOutput = (): AnalysisOutput => ({
  steps: [],
  results: [],
  charts: [],
  pictures: [],
  withoutGlyphs: [],
  merges: [],
  notNumbers: [],
  literals: [],
  printed: "",
  cut: {
    figures: 0,
    tables: 0,
    charts: 0,
    pictures: 0,
    steps: 0,
    merges: 0,
    notNumbers: 0,
    literals: 0,
    printed: false,
  },
});

/** A run that ended before any code ran. */
export const endedBefore = (end: AnalysisEnd): AnalysisResult => ({
  end,
  output: noAnalysisOutput(),
  ms: 0,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function text(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}

const lineOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

function cell(value: unknown): AnalysisCell {
  if (typeof value === "string") return text(value, ANALYSIS_LIMITS.cellCharacters);
  if (finite(value) || typeof value === "boolean") return value;
  return null;
}

function listOf<T>(value: unknown, limit: number, read: (item: unknown) => T | null) {
  const items: T[] = [];
  let left = 0;
  for (const item of Array.isArray(value) ? value : []) {
    const found = read(item);
    if (found === null) continue;
    if (items.length < limit) items.push(found);
    else left++;
  }
  return { items, left };
}

function table(value: unknown, rowLimit: number): AnalysisTable | null {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) return null;
  const columns = value.columns
    .slice(0, ANALYSIS_LIMITS.columns)
    .map((heading) => text(heading, ANALYSIS_LIMITS.labelCharacters));
  const rows = value.rows
    .slice(0, rowLimit)
    .map((row) => columns.map((_, index) => (Array.isArray(row) ? cell(row[index]) : null)));
  return {
    columns,
    rows,
    rowCount: Math.max(count(value.rowCount), value.rows.length),
    columnCount: Math.max(count(value.columnCount), value.columns.length),
  };
}

const label = (value: unknown) => text(value, ANALYSIS_LIMITS.labelCharacters);

/** A label, heading or name as the helper cuts it to `ANALYSIS_LIMITS.labelCharacters`. */
export const analysisLabel = (value: string): string => label(value);

const rowNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** The rows a figure names, as the helper writes them: runs in order, apart; null for anything else. */
export function readFigureRows(raw: unknown): AnalysisFigureRows | null {
  if (!isRecord(raw) || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return null;
  const input = label(raw.input);
  const how = raw.how === null ? null : FIGURE_HOW.find((each) => each === raw.how);
  if (!input || how === undefined || raw.rows.length > ANALYSIS_LIMITS.figureRowRuns) return null;
  if (raw.columns.length === 0 || raw.columns.length > ANALYSIS_LIMITS.columns) return null;
  if (!raw.columns.every((heading) => typeof heading === "string")) return null;
  const rows: [number, number][] = [];
  let count = 0;
  for (const run of raw.rows) {
    if (!Array.isArray(run) || run.length !== 2) return null;
    const [from, to] = run;
    if (!rowNumber(from) || !rowNumber(to) || to < from) return null;
    const last = rows.at(-1);
    if (last && from <= last[1] + 1) return null;
    rows.push([from, to]);
    count += to - from + 1;
  }
  if (rows.length === 0 || raw.count !== count) return null;
  return { input, columns: raw.columns.map(label), rows, count, how };
}

function value(item: unknown): AnalysisValue | null {
  if (!isRecord(item)) return null;
  const named = {
    name: label(item.name),
    label: label(item.label),
    unit: typeof item.unit === "string" ? label(item.unit) : null,
  };
  if (!named.name) return null;
  if (item.kind === "figure") {
    if (!finite(item.value)) return null;
    if (item.of === undefined || item.of === null)
      return { kind: "figure", ...named, value: item.value };
    const of = readFigureRows(item.of);
    return of ? { kind: "figure", ...named, value: item.value, of } : null;
  }
  if (item.kind !== "table") return null;
  const read = table(item.table, ANALYSIS_LIMITS.rows);
  return read ? { kind: "table", ...named, table: read } : null;
}

const isChartKind = (kind: unknown): kind is ChartKind =>
  typeof kind === "string" && (CHART_KINDS as readonly string[]).includes(kind);

function chartOf(item: unknown): AnalysisChart | null {
  if (!isRecord(item) || !isChartKind(item.kind) || !Array.isArray(item.y)) return null;
  const read = table(item.table, ANALYSIS_LIMITS.chartRows);
  if (!read) return null;
  return {
    kind: item.kind,
    title: label(item.title),
    x: label(item.x),
    y: item.y.slice(0, ANALYSIS_LIMITS.columns).map(label),
    table: read,
  };
}

/** The start of every PNG, in base64. */
const PNG_BASE64 = "iVBORw0KGgo";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function pictureOf(item: unknown): AnalysisPicture | null {
  if (!isRecord(item) || typeof item.png !== "string") return null;
  const { png, width, height } = item;
  const edge = (side: unknown): side is number =>
    typeof side === "number" &&
    Number.isSafeInteger(side) &&
    side > 0 &&
    side <= ANALYSIS_LIMITS.pictureEdge;
  if (
    !png.startsWith(PNG_BASE64) ||
    png.length > Math.ceil(ANALYSIS_LIMITS.pictureBytes / 3) * 4 ||
    !BASE64.test(png) ||
    !edge(width) ||
    !edge(height)
  )
    return null;
  return { title: label(item.title), png, width, height };
}

const counted = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function mergeOf(item: unknown): AnalysisMerge | null {
  if (!isRecord(item)) return null;
  return {
    line: lineOf(item.line),
    how: label(item.how),
    leftRows: count(item.leftRows),
    rightRows: count(item.rightRows),
    rows: count(item.rows),
    matched: counted(item.matched),
    leftOnly: counted(item.leftOnly),
    rightOnly: counted(item.rightOnly),
  };
}

function notNumbersOf(item: unknown): AnalysisNotNumbers | null {
  if (!isRecord(item)) return null;
  const cells = listOf(item.cells, ANALYSIS_LIMITS.cellsListed, (each) =>
    isRecord(each) && lineOf(each.row) !== null
      ? { row: lineOf(each.row) ?? 0, value: label(each.value) }
      : null,
  ).items;
  return { input: label(item.input), column: label(item.column), count: count(item.count), cells };
}

function literalOf(item: unknown): AnalysisLiteral | null {
  if (!isRecord(item) || !finite(item.value)) return null;
  const line = lineOf(item.line);
  return line === null ? null : { value: item.value, line, text: label(item.text) };
}

/** What the sandbox says a run gave, read and cut to `ANALYSIS_LIMITS`; nothing for what isn't one. */
export function readAnalysisOutput(raw: unknown): AnalysisOutput {
  const output = noAnalysisOutput();
  if (!isRecord(raw)) return output;
  const given = isRecord(raw.cut) ? raw.cut : {};
  const left = { figure: 0, table: 0 };
  const kept = { figure: 0, table: 0 };
  const limit = { figure: ANALYSIS_LIMITS.figures, table: ANALYSIS_LIMITS.tables };
  for (const item of Array.isArray(raw.results) ? raw.results : []) {
    const found = value(item);
    if (!found) continue;
    if (kept[found.kind] < limit[found.kind]) {
      kept[found.kind]++;
      output.results.push(found);
    } else left[found.kind]++;
  }
  const steps = listOf(raw.steps, ANALYSIS_LIMITS.steps, (item) =>
    isRecord(item)
      ? { label: label(item.label), rows: count(item.rows), columns: count(item.columns) }
      : null,
  );
  const charts = listOf(raw.charts, ANALYSIS_LIMITS.charts, chartOf);
  const pictures = listOf(raw.pictures, ANALYSIS_LIMITS.pictures, pictureOf);
  const merges = listOf(raw.merges, ANALYSIS_LIMITS.merges, mergeOf);
  const notNumbers = listOf(raw.notNumbers, ANALYSIS_LIMITS.notNumbers, notNumbersOf);
  const literals = listOf(raw.literals, ANALYSIS_LIMITS.literals, literalOf);
  output.steps = steps.items;
  output.charts = charts.items;
  output.pictures = pictures.items;
  output.withoutGlyphs = listOf(raw.withoutGlyphs, ANALYSIS_LIMITS.pictures, (item) =>
    typeof item === "string" ? label(item) : null,
  ).items;
  output.merges = merges.items;
  output.notNumbers = notNumbers.items;
  output.literals = literals.items;
  const printed = typeof raw.printed === "string" ? raw.printed : "";
  output.printed = printed.slice(0, ANALYSIS_LIMITS.printed);
  output.cut = {
    figures: count(given.figures) + left.figure,
    tables: count(given.tables) + left.table,
    charts: count(given.charts) + charts.left,
    pictures: count(given.pictures) + pictures.left,
    steps: count(given.steps) + steps.left,
    merges: count(given.merges) + merges.left,
    notNumbers: count(given.notNumbers) + notNumbers.left,
    literals: count(given.literals) + literals.left,
    printed: given.printed === true || printed.length > ANALYSIS_LIMITS.printed,
  };
  return output;
}

/** How the sandbox says a run ended: the ends only the code can come to. */
export function readAnalysisEnd(raw: unknown): AnalysisEnd | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "done") return { kind: "done" };
  if (raw.kind === "out-of-memory") return { kind: "out-of-memory" };
  if (raw.kind !== "error") return null;
  const message = typeof raw.message === "string" ? raw.message : "";
  const limit = ANALYSIS_LIMITS.errorCharacters;
  return {
    kind: "error",
    message: message.length <= limit ? message : `…${message.slice(message.length - limit + 1)}`,
    line: lineOf(raw.line),
  };
}
