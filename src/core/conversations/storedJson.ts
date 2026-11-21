import type {
  AnswerAnalysis,
  AnswerCoverage,
  AnswerPhase,
  AnswerSteps,
  AnswerToolCall,
  Citation,
  FigureInput,
  MarkedCitation,
  MarkedFigure,
  UncitedCheck,
} from "../api";
import { isRecord } from "../errors";

export const PHASES: Record<AnswerPhase, true> = {
  "waiting-for-consent": true,
  loading: true,
  searching: true,
  writing: true,
  "checking-quotes": true,
  "checking-figures": true,
  "checking-claims": true,
};

export const timeOrNull = (value: unknown): string | null =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;

/** The records in a list stored as JSON; none when it isn't one (written by a newer version, say). */
export function storedList<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed.filter(isRecord) as T[]) : [];
  } catch {
    return [];
  }
}

const KNOWN_STEP_KEYS = new Set([
  "sentAt",
  "finishedAt",
  "phases",
  "reasoning",
  "readShare",
  "citedAfterChecking",
  "notCitedAfterAsking",
  "firstWordMs",
  "careful",
  "unbackedClaims",
  "unbackedCommands",
  "unrunTools",
  "calculateUnavailable",
  "askedAgainFor",
  "example",
  "coverage",
  "writtenFrom",
  "stillReading",
  "sent",
  "textBehind",
  "pressed",
  "readPassages",
  "uncitedChecks",
]);

const KNOWN_PHASE_KEYS = new Set(["phase", "at"]);
const KNOWN_REASONING_KEYS = new Set(["summary", "ms"]);
const KNOWN_COVERAGE_KEYS = new Set(["kind", "used", "rest"]);
const KNOWN_COVERAGE_USED_KEYS = new Set(["id", "name"]);
const KNOWN_WRITTEN_FROM_KEYS = new Set(["documents", "total"]);
const KNOWN_STILL_READING_KEYS = new Set(["count", "name"]);
const KNOWN_SENT_KEYS = new Set(["documents", "transcript"]);
const KNOWN_UNCITED_CHECK_KEYS = new Set(["sentence", "check", "verdict", "judgedAt"]);

const KNOWN_CITATION_KEYS = new Set([
  "marker",
  "passageId",
  "documentId",
  "documentName",
  "contentHash",
  "pageFrom",
  "pageTo",
  "location",
  "quote",
  "given",
  "yourNoteAt",
  "check",
  "checkReason",
  "unsure",
  "quotedWords",
  "quotedWordsFound",
  "verdict",
  "foundByCheck",
  "searchedScope",
  "unstated",
  "cells",
  "judgedAt",
  "passedAt",
]);

const KNOWN_QUOTE_CELL_KEYS = new Set(["name", "value"]);
const KNOWN_UNSTATED_KEYS = new Set(["covered", "uncovered", "missing"]);

const KNOWN_FIGURE_KEYS = new Set([
  "marker",
  "label",
  "formula",
  "inputs",
  "value",
  "unit",
  "approximate",
  "shown",
  "show",
  "literals",
  "engine",
  "written",
  "analysis",
  "workbook",
]);

const KNOWN_FIGURE_INPUT_KEYS = new Set([
  "name",
  "label",
  "citation",
  "number",
  "cell",
  "unitStatement",
]);

const KNOWN_ANALYSIS_KEYS = new Set([
  "number",
  "title",
  "language",
  "code",
  "inputs",
  "versions",
  "codeSha256",
  "outputSha256",
  "end",
  "output",
  "ms",
  "ranAt",
  "markers",
  "recalculations",
  "tableChecks",
  "files",
  "outFiles",
]);

const KNOWN_ANALYSIS_INPUT_KEYS = new Set([
  "kind",
  "name",
  "citation",
  "range",
  "rows",
  "columns",
  "rowCount",
  "cut",
  "setAside",
  "sha256",
  "table",
  "input",
]);

const KNOWN_TOOL_CALL_KEYS = new Set([
  "id",
  "tool",
  "source",
  "connector",
  "input",
  "status",
  "approval",
  "resultCount",
  "passages",
  "error",
  "forced",
  "signInRequired",
  "script",
  "webPage",
  "uncalculated",
  "uncalculatedFigures",
  "mindChange",
  "mindProblem",
  "analysis",
  "found",
  "command",
  "commandProblem",
  "asked",
]);

const KNOWN_MIND_CHANGE_KEYS = new Set([
  "mindId",
  "created",
  "filled",
  "request",
  "proposals",
  "changed",
  "added",
  "sentences",
  "removed",
  "swapped",
  "touched",
  "stretchAt",
  "paragraphs",
  "tables",
  "charts",
  "chartNotDrawn",
  "unlinkedSources",
  "droppedSources",
  "extraCells",
  "figuresLeftOut",
  "revised",
  "replacedOwn",
  "cited",
  "citations",
  "uncited",
  "unrecorded",
  "selfCheck",
]);

const KNOWN_SELF_CHECK_KEYS = new Set([
  "request",
  "blocks",
  "checkable",
  "cited",
  "sent",
  "checked",
  "failed",
  "look",
  "leftOut",
  "running",
  "undone",
  "stopped",
  "stop",
  "blocked",
]);

const KNOWN_COMMAND_DONE_KEYS = new Set([
  "command",
  "run",
  "items",
  "into",
  "file",
  "inOutputLocation",
  "marking",
  "window",
  "mindId",
  "yours",
  "folder",
  "setting",
  "folders",
  "tags",
  "unorganized",
  "skipped",
]);

const KNOWN_COMMAND_WINDOW_KEYS = new Set(["changed", "running"]);

function mergeKnownKeys(
  raw: unknown,
  knownKeys: ReadonlySet<string>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(raw)) return { ...next };
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!knownKeys.has(key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function carryExtraFields(raw: unknown, next: unknown, knownKeys?: ReadonlySet<string>): unknown {
  if (Array.isArray(next)) {
    if (!Array.isArray(raw)) return next;
    return next.map((item, idx) => carryExtraFields(raw[idx], item));
  }
  if (!isRecord(next) || !isRecord(raw)) return next;
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (knownKeys ? !knownKeys.has(key) : !(key in next)) {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) {
      merged[key] = carryExtraFields(raw[key], value);
    }
  }
  return merged;
}

function mergeStoredPhases(
  existingPhases: unknown,
  nextPhases: readonly { phase: AnswerPhase; at: string }[],
  knownPhases: Record<string, true> = PHASES,
): Record<string, unknown>[] {
  if (!Array.isArray(existingPhases)) return nextPhases.map((each) => ({ ...each }));
  const knownOriginals: Record<string, unknown>[] = [];
  const unknownAfter = new Map<number, Record<string, unknown>[]>();
  for (const item of existingPhases) {
    if (!isRecord(item) || typeof item.phase !== "string" || item.phase === "") continue;
    if (Object.hasOwn(knownPhases, item.phase)) {
      if (timeOrNull(item.at) !== null) knownOriginals.push(item);
      continue;
    }
    const list = unknownAfter.get(knownOriginals.length) ?? [];
    list.push(item);
    unknownAfter.set(knownOriginals.length, list);
  }
  const merged: Record<string, unknown>[] = [...(unknownAfter.get(0) ?? [])];
  const usedOriginals = new Set<number>();
  for (let i = 0; i < nextPhases.length; i++) {
    const next = nextPhases[i];
    if (!next) continue;
    let matchIndex = knownOriginals.findIndex(
      (orig, idx) => !usedOriginals.has(idx) && orig.phase === next.phase && orig.at === next.at,
    );
    if (matchIndex < 0 && !usedOriginals.has(i) && knownOriginals[i]?.phase === next.phase) {
      matchIndex = i;
    }
    if (matchIndex >= 0) {
      usedOriginals.add(matchIndex);
      merged.push(
        mergeKnownKeys(knownOriginals[matchIndex], KNOWN_PHASE_KEYS, {
          phase: next.phase,
          at: next.at,
        }),
      );
    } else {
      merged.push({ phase: next.phase, at: next.at });
    }
    merged.push(...(unknownAfter.get(i + 1) ?? []));
  }
  for (const [afterCount, items] of unknownAfter) {
    if (afterCount > nextPhases.length) merged.push(...items);
  }
  return merged;
}

function mergeStoredCoverage(
  rawCoverage: unknown,
  coverage: AnswerCoverage,
): Record<string, unknown> {
  const rawUsed = isRecord(rawCoverage) && Array.isArray(rawCoverage.used) ? rawCoverage.used : [];
  const usedRawIndices = new Set<number>();
  const used = coverage.used.map((item, idx) => {
    let matchIndex = rawUsed.findIndex(
      (orig, rIdx) => !usedRawIndices.has(rIdx) && isRecord(orig) && orig.id === item.id,
    );
    if (matchIndex < 0 && !usedRawIndices.has(idx) && isRecord(rawUsed[idx])) {
      matchIndex = idx;
    }
    if (matchIndex >= 0) {
      usedRawIndices.add(matchIndex);
      return mergeKnownKeys(rawUsed[matchIndex], KNOWN_COVERAGE_USED_KEYS, {
        id: item.id,
        name: item.name,
      });
    }
    return { id: item.id, name: item.name };
  });
  return mergeKnownKeys(rawCoverage, KNOWN_COVERAGE_KEYS, {
    kind: coverage.kind,
    used,
    rest: coverage.rest,
  });
}

function mergeStoredUncitedChecks(
  rawChecks: unknown,
  checks: readonly UncitedCheck[],
): Record<string, unknown>[] {
  const rawList = Array.isArray(rawChecks) ? rawChecks : [];
  const usedRawIndices = new Set<number>();
  return checks.map((item, idx) => {
    let matchIndex = rawList.findIndex(
      (orig, rIdx) =>
        !usedRawIndices.has(rIdx) && isRecord(orig) && orig.sentence === item.sentence,
    );
    if (matchIndex < 0 && !usedRawIndices.has(idx) && isRecord(rawList[idx])) {
      matchIndex = idx;
    }
    if (matchIndex >= 0) {
      usedRawIndices.add(matchIndex);
      return mergeKnownKeys(rawList[matchIndex], KNOWN_UNCITED_CHECK_KEYS, {
        sentence: item.sentence,
        check: item.check,
        verdict: item.verdict,
        judgedAt: item.judgedAt,
      });
    }
    return {
      sentence: item.sentence,
      check: item.check,
      verdict: item.verdict,
      judgedAt: item.judgedAt,
    };
  });
}

export interface KnownStepShape {
  stepKeys?: ReadonlySet<string>;
  phases?: Record<string, true>;
}

/**
 * Lays this version's validated `steps` over `raw` (the row's stored `steps` JSON), keeping
 * unknown values, unknown sub-object fields, and unknown phases in their place (#3072).
 */
export function mergeStoredSteps(
  raw: string | null,
  steps: AnswerSteps,
  readSteps: (value: string | null) => AnswerSteps | null,
  known?: KnownStepShape,
): string {
  const stepKeys = known?.stepKeys ?? KNOWN_STEP_KEYS;
  const knownPhases = known?.phases ?? PHASES;
  const clean = readSteps(JSON.stringify(steps)) ?? steps;
  if (raw === null) return JSON.stringify(clean);
  let existing: unknown;
  try {
    existing = JSON.parse(raw);
  } catch {
    return JSON.stringify(clean);
  }
  if (!isRecord(existing)) return JSON.stringify(clean);
  const nextPhases = clean.phases.filter((each) => Object.hasOwn(knownPhases, each.phase));
  const next: Record<string, unknown> = {
    sentAt: clean.sentAt,
    finishedAt: clean.finishedAt,
    phases: mergeStoredPhases(existing.phases, nextPhases, knownPhases),
    reasoning:
      clean.reasoning === null
        ? null
        : mergeKnownKeys(existing.reasoning, KNOWN_REASONING_KEYS, {
            summary: clean.reasoning.summary,
            ms: clean.reasoning.ms,
          }),
    ...(clean.readShare !== undefined && { readShare: clean.readShare }),
    ...(clean.citedAfterChecking !== undefined && {
      citedAfterChecking: clean.citedAfterChecking,
    }),
    ...(clean.notCitedAfterAsking === true && { notCitedAfterAsking: true }),
    ...(clean.firstWordMs !== undefined && { firstWordMs: clean.firstWordMs }),
    ...(clean.careful === true && { careful: true }),
    ...(clean.unbackedClaims !== undefined && { unbackedClaims: clean.unbackedClaims }),
    ...(clean.unbackedCommands !== undefined && { unbackedCommands: clean.unbackedCommands }),
    ...(clean.unrunTools !== undefined && {
      unrunTools: clean.unrunTools,
      ...(clean.calculateUnavailable === true && { calculateUnavailable: true }),
    }),
    ...(clean.askedAgainFor !== undefined && { askedAgainFor: clean.askedAgainFor }),
    ...(clean.example === true && { example: true }),
    ...(clean.textBehind === true && { textBehind: true }),
    ...(clean.readPassages !== undefined && { readPassages: clean.readPassages }),
    ...(clean.uncitedChecks !== undefined && {
      uncitedChecks: mergeStoredUncitedChecks(existing.uncitedChecks, clean.uncitedChecks),
    }),
    ...(clean.coverage !== undefined && {
      coverage: mergeStoredCoverage(existing.coverage, clean.coverage),
    }),
    ...(clean.writtenFrom !== undefined && {
      writtenFrom: mergeKnownKeys(existing.writtenFrom, KNOWN_WRITTEN_FROM_KEYS, {
        documents: clean.writtenFrom.documents,
        total: clean.writtenFrom.total,
      }),
    }),
    ...(clean.stillReading !== undefined && {
      stillReading: mergeKnownKeys(existing.stillReading, KNOWN_STILL_READING_KEYS, {
        count: clean.stillReading.count,
        ...(clean.stillReading.name !== undefined && { name: clean.stillReading.name }),
      }),
    }),
    ...(clean.sent !== undefined && {
      sent: mergeKnownKeys(existing.sent, KNOWN_SENT_KEYS, {
        documents: clean.sent.documents,
        ...(clean.sent.transcript === true && { transcript: true }),
      }),
    }),
    ...(clean.pressed !== undefined && { pressed: clean.pressed }),
  };
  if (known?.stepKeys) {
    for (const key of Object.keys(next)) {
      if (!stepKeys.has(key)) delete next[key];
    }
  }
  return JSON.stringify(mergeKnownKeys(existing, stepKeys, next));
}

function mergeCitationRecord(
  rawItem: unknown,
  citation: Citation | MarkedCitation,
): Record<string, unknown> {
  if (!isRecord(rawItem)) return { ...citation };
  const next: Record<string, unknown> = { ...citation };
  if (citation.location !== null && isRecord(rawItem.location)) {
    next.location = carryExtraFields(rawItem.location, citation.location);
  }
  if (citation.quotedWords !== undefined && isRecord(rawItem.quotedWords)) {
    next.quotedWords = carryExtraFields(rawItem.quotedWords, citation.quotedWords);
  }
  if (citation.unstated !== undefined && isRecord(rawItem.unstated)) {
    next.unstated = carryExtraFields(rawItem.unstated, citation.unstated, KNOWN_UNSTATED_KEYS);
  }
  if (Array.isArray(citation.cells) && Array.isArray(rawItem.cells)) {
    const rawCells = rawItem.cells;
    next.cells = citation.cells.map((cell, idx) =>
      isRecord(rawCells[idx])
        ? mergeKnownKeys(rawCells[idx], KNOWN_QUOTE_CELL_KEYS, {
            name: cell.name,
            value: cell.value,
          })
        : cell,
    );
  }
  return mergeKnownKeys(rawItem, KNOWN_CITATION_KEYS, next);
}

/**
 * Lays `citations` over `raw` (the row's stored `citations` JSON), keeping unknown fields on each
 * Citation and its nested check records and cells (#3072).
 */
export function mergeStoredCitations(raw: string, citations: readonly MarkedCitation[]): string {
  const rawList = storedList<Record<string, unknown>>(raw);
  if (rawList.length === 0) return JSON.stringify(citations);
  const usedRawIndices = new Set<number>();
  const merged = citations.map((citation) => {
    let matchIndex = rawList.findIndex(
      (orig, idx) =>
        !usedRawIndices.has(idx) &&
        orig.marker === citation.marker &&
        orig.documentId === citation.documentId &&
        orig.quote === citation.quote,
    );
    if (matchIndex < 0) {
      matchIndex = rawList.findIndex(
        (orig, idx) => !usedRawIndices.has(idx) && orig.marker === citation.marker,
      );
    }
    if (matchIndex < 0) return citation;
    usedRawIndices.add(matchIndex);
    return mergeCitationRecord(rawList[matchIndex], citation);
  });
  return JSON.stringify(merged);
}

function mergeFigureInput(rawInput: unknown, input: FigureInput): Record<string, unknown> {
  if (!isRecord(rawInput)) return { ...input };
  const next: Record<string, unknown> = {
    ...input,
    citation: mergeCitationRecord(rawInput.citation, input.citation),
    number: carryExtraFields(rawInput.number, input.number),
    cell: input.cell === null ? null : carryExtraFields(rawInput.cell, input.cell),
    unitStatement:
      input.unitStatement === null
        ? null
        : isRecord(rawInput.unitStatement)
          ? carryExtraFields(rawInput.unitStatement, {
              ...input.unitStatement,
              citation: mergeCitationRecord(
                rawInput.unitStatement.citation,
                input.unitStatement.citation,
              ),
            })
          : input.unitStatement,
  };
  return mergeKnownKeys(rawInput, KNOWN_FIGURE_INPUT_KEYS, next);
}

function mergeFigureInputs(
  rawInputs: unknown,
  inputs: readonly FigureInput[],
): Record<string, unknown>[] {
  const rawList = Array.isArray(rawInputs) ? rawInputs : [];
  const usedRawIndices = new Set<number>();
  return inputs.map((input, idx) => {
    let matchIndex = rawList.findIndex(
      (orig, rIdx) => !usedRawIndices.has(rIdx) && isRecord(orig) && orig.name === input.name,
    );
    if (matchIndex < 0 && !usedRawIndices.has(idx) && isRecord(rawList[idx])) {
      matchIndex = idx;
    }
    if (matchIndex < 0) return { ...input };
    usedRawIndices.add(matchIndex);
    return mergeFigureInput(rawList[matchIndex], input);
  });
}

/**
 * Lays `figures` over `raw` (the row's stored `figures` JSON), keeping unknown fields on each
 * figure and its nested inputs (#3072).
 */
export function mergeStoredFigures(raw: string, figures: readonly MarkedFigure[]): string {
  const rawList = storedList<Record<string, unknown>>(raw);
  if (rawList.length === 0) return JSON.stringify(figures);
  const usedRawIndices = new Set<number>();
  const merged = figures.map((figure) => {
    const matchIndex = rawList.findIndex(
      (orig, idx) => !usedRawIndices.has(idx) && orig.marker === figure.marker,
    );
    if (matchIndex < 0) return figure;
    usedRawIndices.add(matchIndex);
    const rawFigure = rawList[matchIndex];
    if (!rawFigure) return figure;
    const next: Record<string, unknown> = {
      ...figure,
      inputs: mergeFigureInputs(rawFigure.inputs, figure.inputs),
      show: carryExtraFields(rawFigure.show, figure.show),
      ...(figure.analysis !== undefined && {
        analysis: carryExtraFields(rawFigure.analysis, figure.analysis),
      }),
      ...(figure.workbook !== undefined && {
        workbook: carryExtraFields(rawFigure.workbook, figure.workbook),
      }),
    };
    return mergeKnownKeys(rawFigure, KNOWN_FIGURE_KEYS, next);
  });
  return JSON.stringify(merged);
}

/**
 * Lays `analyses` over `raw` (the row's stored `analyses` JSON), keeping unknown fields on each
 * Analysis and its nested inputs (#3072).
 */
export function mergeStoredAnalyses(raw: string, analyses: readonly AnswerAnalysis[]): string {
  const rawList = storedList<Record<string, unknown>>(raw);
  if (rawList.length === 0) return JSON.stringify(analyses);
  const usedRawIndices = new Set<number>();
  const merged = analyses.map((analysis) => {
    const matchIndex = rawList.findIndex(
      (orig, idx) => !usedRawIndices.has(idx) && orig.number === analysis.number,
    );
    if (matchIndex < 0) return analysis;
    usedRawIndices.add(matchIndex);
    const rawAnalysis = rawList[matchIndex];
    if (!rawAnalysis) return analysis;
    const rawInputs = Array.isArray(rawAnalysis.inputs) ? rawAnalysis.inputs : [];
    const usedInputIndices = new Set<number>();
    const inputs = analysis.inputs.map((input, idx) => {
      let inputMatch = rawInputs.findIndex(
        (orig, rIdx) =>
          !usedInputIndices.has(rIdx) &&
          isRecord(orig) &&
          orig.name === input.name &&
          orig.kind === input.kind,
      );
      if (inputMatch < 0 && !usedInputIndices.has(idx) && isRecord(rawInputs[idx])) {
        inputMatch = idx;
      }
      if (inputMatch < 0) return input;
      usedInputIndices.add(inputMatch);
      const rawInput = rawInputs[inputMatch];
      if (!isRecord(rawInput)) return input;
      if (input.kind === "range") {
        const nextRange: Record<string, unknown> = {
          ...input,
          citation: mergeCitationRecord(rawInput.citation, input.citation),
          ...(input.setAside !== undefined && {
            setAside: carryExtraFields(rawInput.setAside, input.setAside),
          }),
          ...(input.table !== undefined && {
            table: carryExtraFields(rawInput.table, input.table),
          }),
        };
        return mergeKnownKeys(rawInput, KNOWN_ANALYSIS_INPUT_KEYS, nextRange);
      }
      const nextFigure: Record<string, unknown> = {
        ...input,
        input: mergeFigureInput(rawInput.input, input.input),
      };
      return mergeKnownKeys(rawInput, KNOWN_ANALYSIS_INPUT_KEYS, nextFigure);
    });
    const next: Record<string, unknown> = {
      ...analysis,
      inputs,
      versions:
        analysis.versions === null
          ? null
          : carryExtraFields(rawAnalysis.versions, analysis.versions),
      end: carryExtraFields(rawAnalysis.end, analysis.end),
      output: carryExtraFields(rawAnalysis.output, analysis.output),
      markers: carryExtraFields(rawAnalysis.markers, analysis.markers),
    };
    return mergeKnownKeys(rawAnalysis, KNOWN_ANALYSIS_KEYS, next);
  });
  return JSON.stringify(merged);
}

/**
 * Lays `toolCalls` over `raw` (the row's stored `tool_calls` JSON), keeping unknown fields on each
 * call and its nested records (#3072).
 */
export function mergeStoredToolCalls(raw: string, toolCalls: readonly AnswerToolCall[]): string {
  const rawList = storedList<Record<string, unknown>>(raw);
  if (rawList.length === 0) return JSON.stringify(toolCalls);
  const usedRawIndices = new Set<number>();
  const merged = toolCalls.map((call) => {
    const matchIndex = rawList.findIndex(
      (orig, idx) => !usedRawIndices.has(idx) && orig.id === call.id,
    );
    if (matchIndex < 0) return call;
    usedRawIndices.add(matchIndex);
    const rawCall = rawList[matchIndex];
    if (!rawCall) return call;
    const next: Record<string, unknown> = { ...call };
    if (call.connector !== undefined && isRecord(rawCall.connector)) {
      next.connector = carryExtraFields(rawCall.connector, call.connector);
    }
    if (call.error !== undefined && isRecord(rawCall.error)) {
      next.error = carryExtraFields(rawCall.error, call.error);
    }
    if (call.mindChange !== undefined && isRecord(rawCall.mindChange)) {
      const rawChange = rawCall.mindChange;
      const nextChange: Record<string, unknown> = { ...call.mindChange };
      if (call.mindChange.selfCheck !== undefined && isRecord(rawChange.selfCheck)) {
        const rawCheck = rawChange.selfCheck;
        const nextCheck: Record<string, unknown> = { ...call.mindChange.selfCheck };
        if (call.mindChange.selfCheck.blocked !== undefined && isRecord(rawCheck.blocked)) {
          nextCheck.blocked = carryExtraFields(rawCheck.blocked, call.mindChange.selfCheck.blocked);
        }
        nextChange.selfCheck = mergeKnownKeys(rawCheck, KNOWN_SELF_CHECK_KEYS, nextCheck);
      }
      next.mindChange = mergeKnownKeys(rawChange, KNOWN_MIND_CHANGE_KEYS, nextChange);
    }
    if (call.command !== undefined && isRecord(rawCall.command)) {
      const rawCommand = rawCall.command;
      const nextCommand: Record<string, unknown> = { ...call.command };
      if (call.command.window !== undefined && isRecord(rawCommand.window)) {
        nextCommand.window = mergeKnownKeys(rawCommand.window, KNOWN_COMMAND_WINDOW_KEYS, {
          ...call.command.window,
        });
      }
      next.command = mergeKnownKeys(rawCommand, KNOWN_COMMAND_DONE_KEYS, nextCommand);
    }
    return mergeKnownKeys(rawCall, KNOWN_TOOL_CALL_KEYS, next);
  });
  return JSON.stringify(merged);
}
