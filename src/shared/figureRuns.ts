import * as Y from "yjs";
import {
  type AnswerAnalysis,
  type AnswerAnalysisInput,
  CALCULATED_FIGURE_NODE,
  type CalculatedFigureAttributes,
  MIND_CONTENT_FIELD,
  MIND_FIGURE_RUNS_FIELD,
  type RetainedFigureAnalysis,
} from "../core/api";
import { isRecord } from "../core/errors";
import { ANALYSIS_LIMITS, type AnalysisVersions } from "./analysis";
import type { NodeJSON } from "./blockJson";
import { readCalculatedFigure, readFigureCitation, readFigureInput } from "./calculatedFigures";

const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function readInput(value: unknown): AnswerAnalysisInput | null {
  if (!isRecord(value) || !text(value.name) || !value.name || !text(value.sha256)) return null;
  if (value.kind === "figure") {
    const input = readFigureInput(value.input);
    return input ? { kind: "figure", name: value.name, input, sha256: value.sha256 } : null;
  }
  if (value.kind !== "range") return null;
  const citation = readFigureCitation(value.citation);
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
  };
}

function readVersions(value: unknown): AnalysisVersions | null {
  if (
    !isRecord(value) ||
    value.language !== "python" ||
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
    language: "python",
    languageVersion: value.languageVersion,
    runtime: value.runtime,
    packages,
    helper: value.helper,
    app: value.app,
  };
}

/** Reads provenance only; a clipboard record is not proof that its code ran. */
export function readFigureRun(value: unknown): RetainedFigureAnalysis | null {
  if (
    !isRecord(value) ||
    !text(value.id) ||
    !value.id ||
    !text(value.title) ||
    value.language !== "python" ||
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
    names.add(result.name);
    values.push({
      kind: "figure",
      name: result.name,
      label: result.label,
      unit: result.unit,
      value: result.value,
    });
  }
  const versions = value.versions === null ? null : readVersions(value.versions);
  if (value.versions !== null && versions === null) return null;
  return {
    id: value.id,
    title: value.title,
    language: "python",
    code: value.code,
    inputs,
    versions,
    codeSha256: value.codeSha256,
    ranAt: value.ranAt,
    values,
  };
}

export function retainFigureAnalysis(
  analysis: AnswerAnalysis,
  id: string,
  figures: readonly CalculatedFigureAttributes[],
): RetainedFigureAnalysis | null {
  if (analysis.end.kind !== "done") return null;
  const uses = figures.filter(
    (node) => node.analysisId === id && node.figure.analysis?.analysis === analysis.number,
  );
  if (uses.length === 0) return null;
  const results = analysis.output.results.filter(
    (result) =>
      result.kind === "figure" && uses.some((node) => node.figure.analysis?.result === result.name),
  );
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
  });
}

function collectUse(attrs: Record<string, unknown>, needed: Map<string, Set<string>>): void {
  const figure = readCalculatedFigure(attrs.figure);
  if (!figure?.analysis || !text(attrs.analysisId) || !attrs.analysisId) return;
  const values = needed.get(attrs.analysisId) ?? new Set<string>();
  values.add(figure.analysis.result);
  needed.set(attrs.analysisId, values);
}

function usesIn(blocks: readonly NodeJSON[]): Map<string, Set<string>> {
  const needed = new Map<string, Set<string>>();
  const visit = (nodes: readonly NodeJSON[]) => {
    for (const node of nodes) {
      if (node.type === CALCULATED_FIGURE_NODE && node.attrs) collectUse(node.attrs, needed);
      if (node.content) visit(node.content);
    }
  };
  visit(blocks);
  return needed;
}

const runKey = (id: string) => JSON.stringify([id]);
const valueKey = (id: string, name: string) => JSON.stringify([id, name]);

export function figureRunsFor(doc: Y.Doc, blocks: readonly NodeJSON[]): RetainedFigureAnalysis[] {
  const runs = doc.getMap<unknown>(MIND_FIGURE_RUNS_FIELD);
  return [...usesIn(blocks)].flatMap(([id, names]) => {
    const metadata = runs.get(runKey(id));
    if (!isRecord(metadata) || metadata.id !== id) return [];
    const values = [...names].flatMap((name) => {
      const value = runs.get(valueKey(id, name));
      return value === undefined ? [] : [value];
    });
    const run = readFigureRun({ ...metadata, values });
    return run ? [run] : [];
  });
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
    if (
      previous &&
      JSON.stringify({ ...previous, values: [] }) !== JSON.stringify({ ...next, values: [] })
    )
      throw new Error("The calculated figures name different Analysis runs with the same id.");
    const { values, ...metadata } = next;
    planned.set(key, metadata);
    for (const value of values) {
      const key = valueKey(next.id, value.name);
      const old = planned.get(key) ?? runs.get(key);
      if (old !== undefined && JSON.stringify(old) !== JSON.stringify(value))
        throw new Error("The calculated figures name different values from the same Analysis.");
      planned.set(key, value);
    }
    const prefix = `${key.slice(0, -1)},`;
    const count = new Set(
      [...runs.keys(), ...planned.keys()].filter((key) => key.startsWith(prefix)),
    ).size;
    if (count > ANALYSIS_LIMITS.figures)
      throw new Error("The calculated figures exceed the Analysis result limit.");
  }
  // Independent value keys let concurrent figures keep different results of the same run (#1932).
  for (const [key, value] of planned) runs.set(key, value);
}

/** Prune inside the same transaction as the content change, before its Undo item is captured. */
export function pruneFigureRuns(doc: Y.Doc): void {
  const needed = new Map<string, Set<string>>();
  const visit = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const node of parent.toArray()) {
      if (!(node instanceof Y.XmlElement)) continue;
      if (node.nodeName === CALCULATED_FIGURE_NODE) collectUse(node.getAttributes(), needed);
      visit(node);
    }
  };
  visit(doc.getXmlFragment(MIND_CONTENT_FIELD));
  const keys = new Set<string>();
  for (const [id, names] of needed) {
    keys.add(runKey(id));
    for (const name of names) keys.add(valueKey(id, name));
  }
  const runs = doc.getMap<unknown>(MIND_FIGURE_RUNS_FIELD);
  for (const key of runs.keys()) {
    if (!keys.has(key)) runs.delete(key);
  }
}
