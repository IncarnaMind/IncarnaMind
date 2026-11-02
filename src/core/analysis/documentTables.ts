/**
 * Tables in PDF, Word and PowerPoint Documents as an Analysis's Inputs (#448), read as the index
 * read them when it stored their Units (`UnitLabel.tables`), so every cell is the app's own and
 * cited where the Document has it: a table that runs over pages is one table, its rows numbered
 * as a sheet's are, the headings row 1. Each cell is found again in its Unit's stored text before
 * it is read; one that isn't there, or that a scan's recognizer was unsure of, stays text, so a
 * figure over it is never worked out again (fail closed).
 */
import type { AnalysisCell, AnalysisInput } from "../../shared/analysis";
import { unitLocation } from "../../shared/locations";
import type { UnitText } from "../../shared/units";
import type { AnalysisRangeInput, Citation } from "../api";
import type { CitationSource } from "../documents";
import { unsureSpansIn } from "../documents/scan/layout";
import { isFigure, withoutFootnoteMark } from "../documents/tableCells";
import { parseRange, readRange } from "./ranges";

/** A cell of a Document's table, as an Analysis reads it. */
interface TableCell {
  /** Its text, without the footnote mark after a figure. */
  text: string;
  /** It is in its Unit's stored text, where its row is, and no scan was unsure of it. */
  placed: boolean;
  /** The footnote mark left out of it, or "". */
  mark: string;
}

export interface DocumentTableRow {
  /** Its number in the table, as a sheet's: the headings are row 1. */
  row: number;
  /** The Unit it is in: a PDF's page, a deck's slide, a Word file's section. */
  unit: number;
  cells: TableCell[];
  /** Its text as the Unit holds it, first cell to last; null when its cells aren't there together. */
  quote: string | null;
}

export interface DocumentTable {
  /** In its Document, from 1, in reading order. */
  number: number;
  headings: string[];
  rows: DocumentTableRow[];
  /** Read from a scan's picture (#397): what was recognized, not the PDF's own text. */
  scan: boolean;
}

const BETWEEN_CELLS = /^[ \t]*$/;

/** Where `cells` lie in `text` from `from`, in order with only spaces or tabs between them. */
function rowAt(text: string, cells: readonly string[], from: number): [number, number] | null {
  const [first, ...rest] = cells;
  if (first === undefined) return null;
  for (let start = text.indexOf(first, from); start >= 0; start = text.indexOf(first, start + 1)) {
    let end = start + first.length;
    const fits = rest.every((cell) => {
      const at = text.indexOf(cell, end);
      if (at < 0 || !BETWEEN_CELLS.test(text.slice(end, at))) return false;
      end = at + cell.length;
      return true;
    });
    if (fits) return [start, end];
  }
  return null;
}

/** The one place `cell` is in `text`; null where it is nowhere or more than once. */
function onlyPlace(text: string, cell: string): number | null {
  const at = text.indexOf(cell);
  return at >= 0 && text.indexOf(cell, at + 1) < 0 ? at : null;
}

const overlaps = (spans: readonly [number, number][], from: number, to: number) =>
  spans.some(([start, end]) => start < to && from < end);

/** A Unit's tables' rows, each found again in its text: in order, else cell by cell. */
function placeRows(unit: UnitText, cursor: { at: number }, rows: readonly string[][]) {
  const unsure = unsureSpansIn({ text: unit.text, label: unit.label ?? null });
  return rows.map((row) => {
    const filled = row.map((cell) => cell.trim()).filter((cell) => cell !== "");
    const span = rowAt(unit.text, filled, cursor.at) ?? rowAt(unit.text, filled, 0);
    if (span) cursor.at = span[1];
    let at = span?.[0] ?? 0;
    const cells = row.map((written): TableCell => {
      const whole = written.trim();
      const read = isFigure(whole) ? withoutFootnoteMark(whole) : { text: whole, mark: "" };
      if (whole === "") return { text: "", placed: true, mark: "" };
      const found = span ? unit.text.indexOf(whole, at) : onlyPlace(unit.text, whole);
      if (found === null || found < 0) return { ...read, placed: false };
      if (span) at = found + whole.length;
      return { ...read, placed: !overlaps(unsure, found, found + whole.length) };
    });
    return { cells, quote: span ? unit.text.slice(span[0], span[1]) : null };
  });
}

/** Every table of a Document version's Units, numbered in reading order, rows across Units joined. */
export function documentTables(units: readonly UnitText[]): DocumentTable[] {
  const tables: DocumentTable[] = [];
  /** The Unit the last table read had rows on. */
  let lastUnit: number | null = null;
  for (const unit of units) {
    const stored = unit.label?.tables ?? [];
    const page = unit.page;
    if (page === null || stored.length === 0) continue;
    const cursor = { at: 0 };
    for (const [index, table] of stored.entries()) {
      const last = tables.at(-1);
      const goesOn =
        last !== undefined &&
        index === 0 &&
        table.continues === true &&
        lastUnit === page - 1 &&
        last.headings.length === table.headings.length;
      const into: DocumentTable =
        goesOn && last
          ? last
          : { number: tables.length + 1, headings: table.headings, rows: [], scan: false };
      if (!goesOn) tables.push(into);
      for (const row of placeRows(unit, cursor, table.rows)) {
        into.rows.push({ row: into.rows.length + 2, unit: page, ...row });
      }
      if (unit.label?.scan) into.scan = true;
      lastUnit = page;
    }
  }
  return tables;
}

/** "p. 41", "pp. 2–4", "slide 2", "sections 3–4": where a table's rows are, for the model. */
export function tableWhereText(
  rows: readonly { unit: number }[],
  kind: UnitText["kind"] | "rows" | "lines" | "time" | undefined,
): string {
  const units = [...new Set(rows.map((row) => row.unit))];
  const [first, last] = [units[0] ?? 0, units.at(-1) ?? 0];
  const span = first === last ? `${first}` : `${first}–${last}`;
  if (kind === "slide") return first === last ? `slide ${span}` : `slides ${span}`;
  if (kind === "section") return first === last ? `section ${span}` : `sections ${span}`;
  return first === last ? `p. ${span}` : `pp. ${span}`;
}

function listed(table: DocumentTable, kind: UnitText["kind"]): string {
  const named = table.headings.some((heading) => heading !== "")
    ? table.headings
    : (table.rows[0]?.cells.map((cell) => cell.text) ?? []);
  const columns = named.map((heading) => heading || "…").join(" | ");
  return `table ${table.number} (${tableWhereText(table.rows, kind)}): "${columns}", ${table.rows.length} rows`;
}

export type TableRead =
  | {
      ok: true;
      job: Extract<AnalysisInput, { kind: "table" }>;
      record: Omit<AnalysisRangeInput, "sha256">;
    }
  | { ok: false; problem: string };

const MAX_LISTED = 12;

/** Which of the Document's tables `given` names: by its number, or the one the Passage shows. */
function chosen(
  tables: readonly DocumentTable[],
  source: CitationSource,
  given: unknown,
  kind: UnitText["kind"],
): DocumentTable | string {
  const list = () => {
    const shown = tables.slice(0, MAX_LISTED).map((table) => `- ${listed(table, kind)}`);
    const more = tables.length > MAX_LISTED ? `\n- and ${tables.length - MAX_LISTED} more` : "";
    return `${shown.join("\n")}${more}`;
  };
  if (given !== undefined) {
    const named = tables.find((table) => table.number === Number(given));
    return (
      named ??
      `${source.documentName} has no table ${String(given)}; give "table" as one of its tables:\n${list()}`
    );
  }
  const from = source.pageFrom ?? 1;
  const to = source.pageTo ?? from;
  const shown = tables.filter((table) =>
    table.rows.some((row) => row.unit >= from && row.unit <= to),
  );
  const [only] = shown.length === 1 ? shown : tables.length === 1 ? tables : [];
  if (only) return only;
  return `${shown.length > 1 ? "this Passage shows" : `${source.documentName} has`} more than one table: give "table" as the one to read:\n${list()}`;
}

/**
 * A table of the Document `source` is a Passage of, as an Analysis's Input `name`: the table the
 * Passage shows, or the one `given.table` numbers, cut to `given.range` as a sheet's range is.
 */
export function documentTableInput(
  name: string,
  given: Record<string, unknown>,
  source: CitationSource,
  units: readonly UnitText[],
): TableRead {
  const tables = documentTables(units);
  if (tables.length === 0) {
    return {
      ok: false,
      problem: `${source.documentName} has no table of figures with rows and columns the app could read; quote its numbers with calculate instead`,
    };
  }
  const kind = units[0]?.kind ?? "page";
  const table = chosen(tables, source, given.table, kind);
  if (typeof table === "string") return { ok: false, problem: table };
  const parsed = parseRange(typeof given.range === "string" ? given.range : undefined);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  // A cell not found where the Document has it reads as nothing here, and goes back as its text
  // once the column's numbers are read, so it never turns into a number of its own.
  const cells = new Map<number, AnalysisCell[]>([[1, table.headings]]);
  const unplaced = new Map<number, Map<number, string>>();
  for (const row of table.rows) {
    cells.set(
      row.row,
      row.cells.map((cell, column) => {
        if (cell.text === "") return null;
        if (cell.placed) return cell.text;
        unplaced.set(row.row, (unplaced.get(row.row) ?? new Map()).set(column, cell.text));
        return null;
      }),
    );
  }
  const read = readRange(cells, parsed.bounds);
  if (!read || read.rows.length === 0) {
    return {
      ok: false,
      problem: `the range has no rows under its headings in table ${table.number}`,
    };
  }
  read.rowNumbers.forEach((number, index) => {
    for (const [column, text] of unplaced.get(number) ?? []) {
      const at = column - parsed.bounds.firstColumn;
      const row = read.rows[index];
      if (row && at >= 0 && at < row.length) row[at] = text;
    }
  });
  const kept = new Set(read.rowNumbers);
  const rows = table.rows.filter((row) => kept.has(row.row));
  const first = rows.find((row) => row.quote !== null);
  if (!first) {
    return {
      ok: false,
      problem: `the rows of table ${table.number} aren't in ${source.documentName}'s text as it was read; quote its numbers with calculate instead`,
    };
  }
  const shown = [...new Set(rows.map((row) => row.unit))];
  const [from, to] = [shown[0] ?? first.unit, shown.at(-1) ?? first.unit];
  const unit = units.find((each) => each.page === first.unit);
  const location = unit ? unitLocation(unit) : null;
  const citation: Citation = {
    passageId: source.passageId,
    documentId: source.documentId,
    documentName: source.documentName,
    contentHash: source.contentHash,
    pageFrom: from,
    pageTo: to,
    location:
      location && (location.kind === "page" || location.kind === "slide")
        ? { kind: location.kind, from, to }
        : location,
    quote: first.quote ?? "",
    check: "found",
    checkReason: null,
  };
  const inRange = (column: number) =>
    column >= parsed.bounds.firstColumn && column < parsed.bounds.firstColumn + read.columns.length;
  const marks = rows.reduce(
    (sum, row) => sum + row.cells.filter((cell, column) => cell.mark && inRange(column)).length,
    0,
  );
  return {
    ok: true,
    job: {
      kind: "table",
      name,
      columns: read.columns,
      rows: read.rows,
      firstRow: read.rowNumbers[0] ?? 2,
      rowNumbers: read.rowNumbers,
      ...(table.scan && { readFromScan: true as const }),
    },
    record: {
      kind: "range",
      name,
      citation,
      range: read.range,
      rows: read.rows.length,
      columns: read.columns.length,
      rowCount: read.rowCount,
      cut: read.cut,
      table: {
        number: table.number,
        rows: rows.map((row) => ({ row: row.row, unit: row.unit, quote: row.quote })),
        ...(table.scan && { scan: true as const }),
        ...(marks > 0 && { marks }),
      },
    },
  };
}
