import * as Y from "yjs";
import {
  type AnalysisRangeInput,
  type AnswerAnalysis,
  type AnswerAnalysisInput,
  CALCULATED_FIGURE_NODE,
  type CalculatedFigureAttributes,
  type Citation,
  type ConversationAnswer,
  type FigureInput,
  MIND_CONTENT_FIELD,
  MIND_FIGURE_RUNS_FIELD,
  type RetainedFigureAnalysis,
} from "../core/api";
import { InvalidInputError, isRecord } from "../core/errors";
import { ANALYSIS_LIMITS, type AnalysisVersions, readFigureRows } from "./analysis";
import type { NodeJSON } from "./blockJson";
import {
  calculatedFigureNode,
  readCalculatedFigureEvidence,
  readFigureCitation,
  readFigureInput,
} from "./calculatedFigures";
import { perBlock } from "./memo";

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
  return answer.analyses.flatMap((analysis) => {
    const run = retainFigureAnalysis(analysis, figureRunId(answer.id, analysis), figures);
    return run ? [run] : [];
  });
}

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
    const of = result.of === undefined ? undefined : readFigureRows(result.of);
    if (of === null) return null;
    names.add(result.name);
    values.push({
      kind: "figure",
      name: result.name,
      label: result.label,
      unit: result.unit,
      value: result.value,
      ...(of && { of }),
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
  figures: readonly Omit<CalculatedFigureAttributes, "id">[],
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

export function figureRunsFor(doc: Y.Doc, blocks: readonly NodeJSON[]): RetainedFigureAnalysis[] {
  const runs = doc.getMap<unknown>(MIND_FIGURE_RUNS_FIELD);
  return [...usesIn(blocks)].map(([id, names]) => {
    const metadata = runs.get(runKey(id));
    if (!isRecord(metadata) || metadata.id !== id)
      throw new Error("The calculated figure's Analysis record is missing.");
    const values = [...names.keys()].flatMap((name) => {
      const value = runs.get(valueKey(id, name));
      return value === undefined ? [] : [value];
    });
    const run = readFigureRun({ ...metadata, values });
    if (
      !run ||
      run.values.length !== names.size ||
      run.values.some((value) => {
        const expected = names.get(value.name);
        return expected?.size !== 1 || !expected.has(value.value);
      })
    )
      throw new Error("The calculated figure's value is not in its Analysis record.");
    return run;
  });
}

export function readFigureRunClosure(
  blocks: readonly NodeJSON[],
  records: unknown,
): RetainedFigureAnalysis[] {
  if (!Array.isArray(records)) throw new Error("Analysis records must be a list.");
  const doc = new Y.Doc();
  try {
    installFigureRuns(doc, records);
    return figureRunsFor(doc, blocks);
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

const figuresOfBlock = perBlock((block) => {
  const found: Record<string, unknown>[] = [];
  const visit = (element: Y.XmlElement) => {
    if (element.nodeName === CALCULATED_FIGURE_NODE) found.push(element.getAttributes());
    for (const node of element.toArray()) if (node instanceof Y.XmlElement) visit(node);
  };
  visit(block);
  return found;
});

/** Prune inside the same transaction as the content change, before its Undo item is captured. */
export function pruneFigureRuns(doc: Y.Doc): void {
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) return;
  const runs = doc.getMap<unknown>(MIND_FIGURE_RUNS_FIELD);
  if (runs.size === 0) return;
  const needed: FigureUses = new Map();
  for (const node of doc.getXmlFragment(MIND_CONTENT_FIELD).toArray()) {
    if (!(node instanceof Y.XmlElement)) continue;
    for (const attributes of figuresOfBlock(node)) if (!collectUse(attributes, needed)) return;
  }
  const keys = new Set<string>();
  for (const [id, names] of needed) {
    keys.add(runKey(id));
    for (const name of names.keys()) keys.add(valueKey(id, name));
  }
  for (const key of runs.keys()) {
    if (!keys.has(key)) runs.delete(key);
  }
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
    if (!doc) throw new InvalidInputError({ key: "error.figure.evidenceMissing" });
    analysis =
      figureRunsFor(doc, [
        calculatedFigureNode(attributes.figure, attributes.id, attributes.analysisId),
      ])[0] ?? null;
    if (!analysis) throw new InvalidInputError({ key: "error.figure.evidenceMissing" });
    for (const input of analysis.inputs) {
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
