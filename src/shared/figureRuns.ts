import * as Y from "yjs";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  ANALYSIS_TABLE_NODE,
  type AnalysisRangeInput,
  type AnalysisTableBinding,
  type AnalysisTableRows,
  type AnswerAnalysis,
  type AnswerAnalysisInput,
  CALCULATED_FIGURE_NODE,
  type CalculatedFigureAttributes,
  type Citation,
  type ConversationAnswer,
  type FigureInput,
  MIND_FIGURE_RUNS_FIELD,
  type RetainedAnalysisTable,
  type RetainedFigureAnalysis,
  type RetainedFigureValue,
} from "../core/api";
import { isRecord } from "../core/errors";
import {
  ANALYSIS_LIMITS,
  type AnalysisLanguage,
  type AnalysisRecalculation,
  type AnalysisTableKey,
  type AnalysisVersions,
  readAnalysisTable,
  readAnalysisTableKey,
  readFigureRows,
  readTableCheck,
  sameTableKey,
} from "./analysis";
import type { NodeJSON } from "./blockJson";
import {
  calculatedFigureNode,
  readCalculatedFigureEvidence,
  readFigureCitation,
  readFigureInput,
} from "./calculatedFigures";
import { printedValue } from "./printedFigures";

const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const figureRunId = (answerId: string, analysis: AnswerAnalysis): string =>
  JSON.stringify([
    answerId,
    analysis.number,
    analysis.ranAt,
    analysis.codeSha256,
    analysis.inputs.map((input) => [input.name, input.sha256]),
  ]);

/** The binding a table Block, or a caption's marker, holds (#2378); null for any other. */
export function readTableBinding(value: unknown): AnalysisTableBinding | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return null;
  const table = readAnalysisTableKey(value.table);
  return table ? { id: value.id, table } : null;
}

export const sameBinding = (a: AnalysisTableBinding, b: AnalysisTableBinding): boolean =>
  a.id === b.id && sameTableKey(a.table, b.table);

/** The Analysis tables `blocks` hold, by the binding each table Block or caption marker names. */
export function boundTablesIn(blocks: readonly NodeJSON[]): AnalysisTableBinding[] {
  return blocks.flatMap((node) => {
    const binding =
      node.type === "table" || node.type === ANALYSIS_TABLE_NODE
        ? readTableBinding(node.attrs?.[ANALYSIS_TABLE_ATTRIBUTE])
        : null;
    return [...(binding ? [binding] : []), ...boundTablesIn(node.content ?? [])];
  });
}

export function calculatedFiguresIn(
  blocks: readonly NodeJSON[],
): Omit<CalculatedFigureAttributes, "id">[] {
  return blocks.flatMap((node) => {
    const figure =
      node.type === CALCULATED_FIGURE_NODE ? readCalculatedFigureEvidence(node.attrs) : null;
    if (node.type === CALCULATED_FIGURE_NODE && !figure)
      throw new Error("The calculated figure's record is invalid.");
    return [...(figure ? [figure] : []), ...calculatedFiguresIn(node.content ?? [])];
  });
}

export function figureRunsOfAnswer(
  answer: Pick<ConversationAnswer, "id" | "analyses">,
  blocks: readonly NodeJSON[],
): RetainedFigureAnalysis[] {
  const figures = calculatedFiguresIn(blocks);
  const tables = boundTablesIn(blocks);
  return answer.analyses.flatMap((analysis) => {
    const run = retainFigureAnalysis(analysis, figureRunId(answer.id, analysis), figures, tables);
    return run ? [run] : [];
  });
}

/** A Document table's rows as a Note keeps them (#448); undefined for a sheet's range or one that doesn't read. */
function readTableRows(value: unknown): AnalysisTableRows | undefined {
  if (!isRecord(value) || !count(value.number) || !Array.isArray(value.rows)) return undefined;
  const rows: AnalysisTableRows["rows"] = [];
  for (const row of value.rows) {
    if (!isRecord(row) || !count(row.row) || !count(row.unit)) return undefined;
    if (row.quote !== null && !text(row.quote)) return undefined;
    rows.push({ row: row.row, unit: row.unit, quote: row.quote });
  }
  return {
    number: value.number,
    rows,
    ...(value.scan === true && { scan: true as const }),
    ...(count(value.marks) && value.marks > 0 && { marks: value.marks }),
  };
}

function readInput(value: unknown): AnswerAnalysisInput | null {
  if (!isRecord(value) || !text(value.name) || !value.name || !text(value.sha256)) return null;
  if (value.kind === "figure") {
    const input = readFigureInput(value.input);
    return input ? { kind: "figure", name: value.name, input, sha256: value.sha256 } : null;
  }
  if (value.kind !== "range") return null;
  const citation = readFigureCitation(value.citation);
  const table = readTableRows(value.table);
  if (
    !citation ||
    !text(value.range) ||
    !value.range ||
    !count(value.rows) ||
    !count(value.columns) ||
    !count(value.rowCount) ||
    value.rowCount < value.rows ||
    typeof value.cut !== "boolean"
  )
    return null;
  return {
    kind: "range",
    name: value.name,
    citation,
    range: value.range,
    rows: value.rows,
    columns: value.columns,
    rowCount: value.rowCount,
    cut: value.cut,
    sha256: value.sha256,
    ...(table && { table }),
  };
}

const languageOf = (value: unknown): AnalysisLanguage | null =>
  value === "python" || value === "bash" ? value : null;

function readVersions(value: unknown): AnalysisVersions | null {
  const language = isRecord(value) ? languageOf(value.language) : null;
  if (
    !isRecord(value) ||
    !language ||
    !text(value.languageVersion) ||
    !text(value.runtime) ||
    !text(value.helper) ||
    !text(value.app) ||
    !isRecord(value.packages) ||
    !Object.values(value.packages).every(text)
  )
    return null;
  const packages: Record<string, string> = {};
  for (const [name, version] of Object.entries(value.packages)) {
    if (text(version)) Object.defineProperty(packages, name, { value: version, enumerable: true });
  }
  return {
    language,
    languageVersion: value.languageVersion,
    runtime: value.runtime,
    packages,
    helper: value.helper,
    app: value.app,
  };
}

/** What IncarnaMind made of a kept figure when its Analysis ran; null for a record that isn't one. */
function readRecalculation(value: unknown): AnalysisRecalculation | null {
  if (!isRecord(value)) return null;
  if (value.kind === "unchecked")
    return text(value.reason) ? { kind: "unchecked", reason: value.reason } : null;
  if (value.kind !== "same" && value.kind !== "differs") return null;
  return typeof value.value === "number" && Number.isFinite(value.value)
    ? { kind: value.kind, value: value.value }
    : null;
}

/** Reads provenance only; a clipboard record is not proof that its code ran. */
export function readFigureRun(value: unknown): RetainedFigureAnalysis | null {
  const language = isRecord(value) ? languageOf(value.language) : null;
  if (
    !isRecord(value) ||
    !text(value.id) ||
    !value.id ||
    !text(value.title) ||
    !language ||
    !text(value.code) ||
    !text(value.codeSha256) ||
    !text(value.ranAt) ||
    !Array.isArray(value.inputs) ||
    !Array.isArray(value.values) ||
    value.values.length > ANALYSIS_LIMITS.figures
  )
    return null;
  const inputs: AnswerAnalysisInput[] = [];
  for (const given of value.inputs) {
    const input = readInput(given);
    if (!input) return null;
    inputs.push(input);
  }
  const values: RetainedFigureAnalysis["values"] = [];
  const names = new Set<string>();
  for (const result of value.values) {
    if (
      !isRecord(result) ||
      result.kind !== "figure" ||
      !text(result.name) ||
      !result.name ||
      names.has(result.name) ||
      !text(result.label) ||
      !(result.unit === null || text(result.unit)) ||
      typeof result.value !== "number" ||
      !Number.isFinite(result.value)
    )
      return null;
    const of = result.of === undefined ? undefined : readFigureRows(result.of);
    if (of === null) return null;
    const check = result.check == null ? undefined : readRecalculation(result.check);
    if (result.check != null && check === null) return null;
    names.add(result.name);
    values.push({
      kind: "figure",
      name: result.name,
      label: result.label,
      unit: result.unit,
      value: result.value,
      ...(of && { of }),
      ...(check && { check }),
    });
  }
  const versions = value.versions === null ? null : readVersions(value.versions);
  if (value.versions !== null && versions === null) return null;
  const tables = value.tables === undefined ? [] : readTables(value.tables);
  if (!tables) return null;
  return {
    id: value.id,
    title: value.title,
    language,
    code: value.code,
    inputs,
    versions,
    codeSha256: value.codeSha256,
    ranAt: value.ranAt,
    values,
    ...(tables.length > 0 && { tables }),
  };
}

function readTables(value: unknown): RetainedAnalysisTable[] | null {
  if (!Array.isArray(value) || value.length > ANALYSIS_LIMITS.tables + ANALYSIS_LIMITS.charts)
    return null;
  const tables: RetainedAnalysisTable[] = [];
  for (const each of value) {
    if (!isRecord(each) || !text(each.label)) return null;
    const key = readAnalysisTableKey(each.key);
    const table = readAnalysisTable(each.table);
    const checked = readTableCheck({ table: each.key, columns: each.columns });
    if (!key || !table || !checked || tables.some((kept) => sameTableKey(kept.key, key)))
      return null;
    tables.push({ key, label: each.label, table, columns: checked.columns });
  }
  return tables;
}

/**
 * The records a clipboard gives, without a check: only a record this app keeps of an Analysis it ran
 * proves what the core made of its figure, and a clipboard's can say anything (#2378).
 */
export function withoutChecks(records: unknown): unknown {
  if (!Array.isArray(records)) return records;
  return records.map((record) => {
    if (!isRecord(record) || !Array.isArray(record.values)) return record;
    return {
      ...record,
      values: record.values.map((value) => {
        if (!isRecord(value)) return value;
        const copy: Record<string, unknown> = { ...value };
        delete copy.check;
        return copy;
      }),
      ...(Array.isArray(record.tables) && {
        tables: record.tables.map((table) =>
          isRecord(table) && Array.isArray(table.columns)
            ? {
                ...table,
                columns: table.columns.map((column) =>
                  isRecord(column) ? { ...column, rule: null, rows: 0 } : column,
                ),
              }
            : table,
        ),
      }),
    };
  });
}

/** A kept value without what the core made of it: what a clipboard record and the Note's own must share. */
function withoutCheck(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = { ...value };
  delete copy.check;
  return copy;
}

/** The tables of `analysis` that `bound` names, as a Note keeps them. */
function retainedTables(
  analysis: AnswerAnalysis,
  id: string,
  bound: readonly AnalysisTableBinding[],
): RetainedAnalysisTable[] {
  if (analysis.end.kind !== "done") return [];
  const named = (key: AnalysisTableKey) =>
    bound.some((binding) => binding.id === id && sameTableKey(binding.table, key));
  const columnsOf = (key: AnalysisTableKey) =>
    analysis.tableChecks?.find((each) => sameTableKey(each.table, key))?.columns ?? [];
  return [
    ...analysis.output.results.flatMap((result) => {
      const key = { result: result.name };
      return result.kind === "table" && named(key)
        ? [{ key, label: result.label, table: result.table, columns: columnsOf(key) }]
        : [];
    }),
    ...analysis.output.charts.flatMap((chart, index) => {
      const key = { chart: index };
      return named(key)
        ? [{ key, label: chart.title, table: chart.table, columns: columnsOf(key) }]
        : [];
    }),
  ];
}

export function retainFigureAnalysis(
  analysis: AnswerAnalysis,
  id: string,
  figures: readonly Omit<CalculatedFigureAttributes, "id">[],
  bound: readonly AnalysisTableBinding[] = [],
): RetainedFigureAnalysis | null {
  const uses = figures.filter(
    (node) => node.analysisId === id && node.figure.analysis?.analysis === analysis.number,
  );
  const tables = retainedTables(analysis, id, bound);
  if (uses.length === 0 && tables.length === 0) return null;
  const checks = new Map((analysis.recalculations ?? []).map((each) => [each.result, each.check]));
  // A run that didn't finish gives no results, but what it printed before it ended was printed.
  const names = new Set(uses.flatMap((node) => node.figure.analysis?.result ?? []));
  const given = [
    ...(analysis.end.kind === "done" ? analysis.output.results : []),
    ...[...names].flatMap((name) => printedValue(analysis, name) ?? []),
  ];
  const results: RetainedFigureValue[] = given.flatMap((result) => {
    if (result.kind !== "figure") return [];
    if (!uses.some((node) => node.figure.analysis?.result === result.name)) return [];
    const check = checks.get(result.name);
    return [check ? { ...result, check } : result];
  });
  if (
    uses.some(
      (node) =>
        !results.some(
          (result) =>
            result.kind === "figure" &&
            result.name === node.figure.analysis?.result &&
            result.value === node.figure.value,
        ),
    )
  )
    return null;
  return readFigureRun({
    id,
    title: analysis.title,
    language: analysis.language,
    code: analysis.code,
    inputs: analysis.inputs,
    versions: analysis.versions,
    codeSha256: analysis.codeSha256,
    ranAt: analysis.ranAt,
    values: results,
    ...(tables.length > 0 && { tables }),
  });
}

type FigureUses = Map<string, Map<string, Set<number | boolean>>>;

function collectUse(attrs: Record<string, unknown>, needed: FigureUses): boolean {
  const node = readCalculatedFigureEvidence(attrs);
  if (!node) return false;
  const { figure, analysisId } = node;
  if (!figure.analysis) return true;
  if (!analysisId) return false;
  const values = needed.get(analysisId) ?? new Map<string, Set<number | boolean>>();
  const expected = values.get(figure.analysis.result) ?? new Set<number | boolean>();
  expected.add(figure.value);
  values.set(figure.analysis.result, expected);
  needed.set(analysisId, values);
  return true;
}

function usesIn(blocks: readonly NodeJSON[]): FigureUses {
  const needed: FigureUses = new Map();
  for (const node of calculatedFiguresIn(blocks)) collectUse({ ...node }, needed);
  return needed;
}

const runKey = (id: string) => JSON.stringify([id]);
const valueKey = (id: string, name: string) => JSON.stringify([id, name]);
// Three parts, where a value's key has two: no result's name can make one.
const tableKey = (id: string, key: AnalysisTableKey) => JSON.stringify([id, "table", key]);

/**
 * Whether the Note `doc` keeps the run a table is bound to, and that table of it (#2378): only then
 * are its cells the run's. A table bound to a run the Note lost is a typed table, checked as one.
 */
export function tableKept(doc: Y.Doc, binding: AnalysisTableBinding): boolean {
  const runs = doc.getMap<unknown>(MIND_FIGURE_RUNS_FIELD);
  const metadata = runs.get(runKey(binding.id));
  return (
    isRecord(metadata) &&
    metadata.id === binding.id &&
    isRecord(runs.get(tableKey(binding.id, binding.table)))
  );
}

/** A table Block's binding while the Note `doc` keeps its run; null for any other table. */
export function keptBinding(doc: Y.Doc | null, value: unknown): AnalysisTableBinding | null {
  const binding = readTableBinding(value);
  return binding && doc && tableKept(doc, binding) ? binding : null;
}

/** Each run `blocks` name with a table, and which of its tables. */
function tablesUsedIn(blocks: readonly NodeJSON[]): Map<string, AnalysisTableKey[]> {
  const used = new Map<string, AnalysisTableKey[]>();
  for (const { id, table } of boundTablesIn(blocks)) {
    const keys = used.get(id) ?? [];
    if (!keys.some((key) => sameTableKey(key, table))) keys.push(table);
    used.set(id, keys);
  }
  return used;
}

/**
 * The records `blocks`' figures name, as many as the Note still keeps: a figure whose record is
 * missing or isn't the one it shows reads as its value and Not checked, never as an error. An
 * earlier build could leave one behind, and a Note must open and export whatever it holds (#2378).
 */
export function figureRunsFor(doc: Y.Doc, blocks: readonly NodeJSON[]): RetainedFigureAnalysis[] {
  const runs = doc.getMap<unknown>(MIND_FIGURE_RUNS_FIELD);
  const found: RetainedFigureAnalysis[] = [];
  const figures = usesIn(blocks);
  const tables = tablesUsedIn(blocks);
  for (const id of new Set([...figures.keys(), ...tables.keys()])) {
    const names = figures.get(id) ?? new Map<string, Set<number | boolean>>();
    const metadata = runs.get(runKey(id));
    if (!isRecord(metadata) || metadata.id !== id) continue;
    // A table the Note no longer keeps reads as a typed table: only its own cells lose the record.
    const kept = (tables.get(id) ?? []).flatMap((key) => {
      const table = runs.get(tableKey(id, key));
      return isRecord(table) ? [table] : [];
    });
    // Each value the Note still keeps and shows as it was is read; one the Note lost takes only
    // its own figure's check, never the Analysis's other values (#2378).
    const values = [...names.keys()].flatMap((name) => {
      const value = runs.get(valueKey(id, name));
      if (value === undefined || !isRecord(value)) return [];
      const expected = names.get(name);
      if (
        expected?.size !== 1 ||
        (typeof value.value !== "number" && typeof value.value !== "boolean")
      )
        return [];
      return expected.has(value.value) ? [value] : [];
    });
    if (values.length === 0 && kept.length === 0) continue;
    const run = readFigureRun({ ...metadata, values, tables: kept });
    if (run) found.push(run);
  }
  return found;
}

export function readFigureRunClosure(
  blocks: readonly NodeJSON[],
  records: unknown,
): RetainedFigureAnalysis[] {
  if (!Array.isArray(records)) throw new Error("Analysis records must be a list.");
  const doc = new Y.Doc();
  try {
    installFigureRuns(doc, records);
    const runs = figureRunsFor(doc, blocks);
    // A clipboard that names an Analysis must carry the whole record its figures read from: a
    // paste that would leave one unread is refused, unlike a Note an earlier build left behind.
    const kept = new Map(
      runs.map((run) => [run.id, new Set(run.values.map((value) => value.name))]),
    );
    const missing = [...usesIn(blocks)].some(([id, names]) => {
      const values = kept.get(id);
      return !values || [...names.keys()].some((name) => !values.has(name));
    });
    const tableMissing = [...tablesUsedIn(blocks)].some(([id, keys]) => {
      const tables = runs.find((run) => run.id === id)?.tables ?? [];
      return keys.some((key) => !tables.some((table) => sameTableKey(table.key, key)));
    });
    if (missing || tableMissing)
      throw new Error("The calculated figure's Analysis record is missing.");
    return runs;
  } finally {
    doc.destroy();
  }
}

/** Install inside the transaction that inserts the figures, including the same Undo scope. */
export function installFigureRuns(doc: Y.Doc, records: readonly unknown[]): void {
  const runs = doc.getMap<unknown>(MIND_FIGURE_RUNS_FIELD);
  const planned = new Map<string, unknown>();
  for (const record of records) {
    const next = readFigureRun(record);
    if (!next) throw new Error("The calculated figure's Analysis record is invalid.");
    const key = runKey(next.id);
    const before = planned.get(key) ?? runs.get(key);
    const previous = isRecord(before) ? readFigureRun({ ...before, values: [] }) : null;
    const { values, tables = [], ...metadata } = next;
    // Its values and tables are kept apart, each under a key of its own: the run is what they share.
    if (
      previous &&
      JSON.stringify({ ...previous, values: [] }) !== JSON.stringify({ ...metadata, values: [] })
    )
      throw new Error("The calculated figures name different Analysis runs with the same id.");
    planned.set(key, metadata);
    for (const table of tables) {
      const at = tableKey(next.id, table.key);
      const old = planned.get(at) ?? runs.get(at);
      if (old !== undefined && JSON.stringify(old) !== JSON.stringify(table)) {
        // A clipboard's column checks are no proof, as a value's check is none: the Note's own stand.
        const asGiven = (each: unknown) =>
          JSON.stringify(isRecord(each) ? { ...each, columns: undefined } : each);
        if (asGiven(old) !== asGiven(table))
          throw new Error("The calculated figures name different values from the same Analysis.");
        continue;
      }
      planned.set(at, table);
    }
    for (const value of values) {
      const key = valueKey(next.id, value.name);
      const old = planned.get(key) ?? runs.get(key);
      if (old !== undefined && JSON.stringify(old) !== JSON.stringify(value)) {
        // A clipboard record carries no check (#2378): the Note's own record of the same value keeps its own.
        if (JSON.stringify(withoutCheck(old)) !== JSON.stringify(withoutCheck(value)))
          throw new Error("The calculated figures name different values from the same Analysis.");
        if (isRecord(old) && old.check !== undefined && value.check !== undefined)
          throw new Error("The calculated figures name different values from the same Analysis.");
        if (value.check === undefined) continue;
      }
      planned.set(key, value);
    }
    const prefix = `${key.slice(0, -1)},`;
    const tablePrefix = `${prefix}"table",`;
    const count = new Set(
      [...runs.keys(), ...planned.keys()].filter(
        (key) => key.startsWith(prefix) && !key.startsWith(tablePrefix),
      ),
    ).size;
    if (count > ANALYSIS_LIMITS.figures)
      throw new Error("The calculated figures exceed the Analysis result limit.");
  }
  // Independent value keys let concurrent figures keep different results of the same run (#1932).
  for (const [key, value] of planned) runs.set(key, value);
}

export interface CalculatedSources {
  inputs: FigureInput[];
  ranges: AnalysisRangeInput[];
  analysis: RetainedFigureAnalysis | null;
}

export function calculatedSources(
  attributes: CalculatedFigureAttributes,
  doc: Y.Doc | null,
): CalculatedSources {
  const inputs = [...attributes.figure.inputs];
  const ranges: AnalysisRangeInput[] = [];
  let analysis: RetainedFigureAnalysis | null = null;
  if (attributes.figure.analysis) {
    analysis =
      (doc
        ? figureRunsFor(doc, [
            calculatedFigureNode(attributes.figure, attributes.id, attributes.analysisId),
          ])[0]
        : null) ?? null;
    // A record the Note no longer keeps leaves the figure reading as its value, with only the
    // inputs its own text names (#2378).
    for (const input of analysis?.inputs ?? []) {
      if (input.kind === "figure") inputs.push(input.input);
      else ranges.push(input);
    }
  }
  return { inputs, ranges, analysis };
}

/** Each Citation a figure is worked out from, in the order a style cites them, with the input's label or the range's name. */
export function labelledCitations(
  sources: CalculatedSources,
): { label: string; citation: Citation }[] {
  return [
    ...sources.inputs.flatMap((input) => {
      const label = input.label.trim() || input.name;
      return [
        { label, citation: input.citation },
        ...(input.unitStatement ? [{ label, citation: input.unitStatement.citation }] : []),
      ];
    }),
    ...sources.ranges.map((range) => ({ label: range.name, citation: range.citation })),
  ];
}

export const calculatedCitations = (sources: CalculatedSources): Citation[] =>
  labelledCitations(sources).map(({ citation }) => citation);

/** What IncarnaMind made of a kept figure when the Analysis ran; null when the Note kept no check. */
export function retainedCheck(
  sources: CalculatedSources | null,
  result: string | undefined,
): AnalysisRecalculation | null {
  if (!sources?.analysis || result === undefined) return null;
  return sources.analysis.values.find((value) => value.name === result)?.check ?? null;
}
