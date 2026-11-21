import type {
  AnswerCoverage,
  AnswerPhase,
  AnswerSteps,
  MarkedCitation,
  QuoteCell,
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

type KnownKeys<T> = Readonly<Record<keyof T, true>>;

const STEP_KEYS = {
  sentAt: true,
  finishedAt: true,
  phases: true,
  reasoning: true,
  readShare: true,
  citedAfterChecking: true,
  notCitedAfterAsking: true,
  firstWordMs: true,
  careful: true,
  unbackedClaims: true,
  unbackedCommands: true,
  unrunTools: true,
  calculateUnavailable: true,
  askedAgainFor: true,
  example: true,
  coverage: true,
  writtenFrom: true,
  stillReading: true,
  sent: true,
  textBehind: true,
  pressed: true,
  readPassages: true,
  uncitedChecks: true,
} satisfies KnownKeys<Required<AnswerSteps>>;

const PHASE_KEYS = {
  phase: true,
  at: true,
} satisfies KnownKeys<AnswerSteps["phases"][number]>;

const REASONING_KEYS = {
  summary: true,
  ms: true,
} satisfies KnownKeys<NonNullable<AnswerSteps["reasoning"]>>;

const COVERAGE_KEYS = {
  kind: true,
  used: true,
  rest: true,
} satisfies KnownKeys<AnswerCoverage>;

const COVERAGE_USED_KEYS = {
  id: true,
  name: true,
} satisfies KnownKeys<AnswerCoverage["used"][number]>;

const WRITTEN_FROM_KEYS = {
  documents: true,
  total: true,
} satisfies KnownKeys<NonNullable<AnswerSteps["writtenFrom"]>>;

const STILL_READING_KEYS = {
  count: true,
  name: true,
} satisfies KnownKeys<Required<NonNullable<AnswerSteps["stillReading"]>>>;

const SENT_KEYS = {
  documents: true,
  transcript: true,
} satisfies KnownKeys<Required<NonNullable<AnswerSteps["sent"]>>>;

const UNCITED_CHECK_KEYS = {
  sentence: true,
  check: true,
  verdict: true,
  judgedAt: true,
} satisfies KnownKeys<UncitedCheck>;

const QUOTE_CELL_KEYS = {
  name: true,
  value: true,
} satisfies KnownKeys<QuoteCell>;

function mergeKnownKeys(
  raw: unknown,
  knownKeys: Readonly<Record<string, true>>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(raw)) return { ...next };
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(knownKeys, key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function mergeStoredPhases(
  existingPhases: unknown,
  nextPhases: readonly { phase: AnswerPhase; at: string }[],
): Record<string, unknown>[] {
  if (!Array.isArray(existingPhases)) return nextPhases.map((each) => ({ ...each }));
  const knownOriginals: Record<string, unknown>[] = [];
  const unknownAfter = new Map<number, Record<string, unknown>[]>();
  for (const item of existingPhases) {
    if (!isRecord(item) || typeof item.phase !== "string" || item.phase === "") continue;
    if (Object.hasOwn(PHASES, item.phase)) {
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
    const matchIndex = knownOriginals.findIndex(
      (orig, idx) => !usedOriginals.has(idx) && orig.phase === next.phase && orig.at === next.at,
    );
    if (matchIndex >= 0) {
      usedOriginals.add(matchIndex);
      merged.push(
        mergeKnownKeys(knownOriginals[matchIndex], PHASE_KEYS, {
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
  const used = coverage.used.map((item) => {
    const matchIndex = rawUsed.findIndex(
      (orig, rIdx) => !usedRawIndices.has(rIdx) && isRecord(orig) && orig.id === item.id,
    );
    if (matchIndex >= 0) {
      usedRawIndices.add(matchIndex);
      return mergeKnownKeys(rawUsed[matchIndex], COVERAGE_USED_KEYS, {
        id: item.id,
        name: item.name,
      });
    }
    return { id: item.id, name: item.name };
  });
  return mergeKnownKeys(rawCoverage, COVERAGE_KEYS, {
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
  return checks.map((item) => {
    const matchIndex = rawList.findIndex(
      (orig, rIdx) =>
        !usedRawIndices.has(rIdx) && isRecord(orig) && orig.sentence === item.sentence,
    );
    if (matchIndex >= 0) {
      usedRawIndices.add(matchIndex);
      return mergeKnownKeys(rawList[matchIndex], UNCITED_CHECK_KEYS, {
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

/**
 * Lays this version's `steps` over `raw` (the row's stored `steps` JSON), keeping unknown values,
 * unknown sub-object fields, and unknown phases in their place (#3072).
 */
export function mergeStoredSteps(raw: string | null, steps: AnswerSteps): string {
  if (raw === null) return JSON.stringify(steps);
  let existing: unknown;
  try {
    existing = JSON.parse(raw);
  } catch {
    return JSON.stringify(steps);
  }
  if (!isRecord(existing)) return JSON.stringify(steps);
  const next: Record<string, unknown> = {
    sentAt: steps.sentAt,
    finishedAt: steps.finishedAt,
    phases: mergeStoredPhases(existing.phases, steps.phases),
    reasoning:
      steps.reasoning === null
        ? null
        : mergeKnownKeys(existing.reasoning, REASONING_KEYS, {
            summary: steps.reasoning.summary,
            ms: steps.reasoning.ms,
          }),
    ...(steps.readShare !== undefined && { readShare: steps.readShare }),
    ...(steps.citedAfterChecking !== undefined && {
      citedAfterChecking: steps.citedAfterChecking,
    }),
    ...(steps.notCitedAfterAsking === true && { notCitedAfterAsking: true }),
    ...(steps.firstWordMs !== undefined && { firstWordMs: steps.firstWordMs }),
    ...(steps.careful === true && { careful: true }),
    ...(steps.unbackedClaims !== undefined && { unbackedClaims: steps.unbackedClaims }),
    ...(steps.unbackedCommands !== undefined && { unbackedCommands: steps.unbackedCommands }),
    ...(steps.unrunTools !== undefined && {
      unrunTools: steps.unrunTools,
      ...(steps.calculateUnavailable === true && { calculateUnavailable: true }),
    }),
    ...(steps.askedAgainFor !== undefined && { askedAgainFor: steps.askedAgainFor }),
    ...(steps.example === true && { example: true }),
    ...(steps.textBehind === true && { textBehind: true }),
    ...(steps.readPassages !== undefined && { readPassages: steps.readPassages }),
    ...(steps.uncitedChecks !== undefined && {
      uncitedChecks: mergeStoredUncitedChecks(existing.uncitedChecks, steps.uncitedChecks),
    }),
    ...(steps.coverage !== undefined && {
      coverage: mergeStoredCoverage(existing.coverage, steps.coverage),
    }),
    ...(steps.writtenFrom !== undefined && {
      writtenFrom: mergeKnownKeys(existing.writtenFrom, WRITTEN_FROM_KEYS, {
        documents: steps.writtenFrom.documents,
        total: steps.writtenFrom.total,
      }),
    }),
    ...(steps.stillReading !== undefined && {
      stillReading: mergeKnownKeys(existing.stillReading, STILL_READING_KEYS, {
        count: steps.stillReading.count,
        ...(steps.stillReading.name !== undefined && { name: steps.stillReading.name }),
      }),
    }),
    ...(steps.sent !== undefined && {
      sent: mergeKnownKeys(existing.sent, SENT_KEYS, {
        documents: steps.sent.documents,
        ...(steps.sent.transcript === true && { transcript: true }),
      }),
    }),
    ...(steps.pressed !== undefined && { pressed: steps.pressed }),
  };
  return JSON.stringify(mergeKnownKeys(existing, STEP_KEYS, next));
}

/**
 * Carries unknown fields on `QuoteCell` entries from `raw` (`row.citations`) when `withStoredCells`
 * stripped them from the in-memory `MarkedCitation` (#3072).
 */
export function withStoredRawCells(
  raw: string,
  citations: readonly MarkedCitation[],
): readonly MarkedCitation[] {
  if (raw === "[]" || !citations.some((citation) => citation.cells !== undefined)) {
    return citations;
  }
  const rawList = storedList<Record<string, unknown>>(raw);
  if (rawList.length === 0) return citations;
  const usedRawIndices = new Set<number>();
  return citations.map((citation) => {
    if (!citation.cells) return citation;
    const matchIndex = rawList.findIndex(
      (orig, idx) =>
        !usedRawIndices.has(idx) &&
        orig.marker === citation.marker &&
        orig.documentId === citation.documentId &&
        orig.quote === citation.quote,
    );
    if (matchIndex < 0) return citation;
    usedRawIndices.add(matchIndex);
    const rawCells = rawList[matchIndex]?.cells;
    if (!Array.isArray(rawCells)) return citation;
    const cells = citation.cells.map((cell, idx) => {
      const rawCell = rawCells[idx];
      return isRecord(rawCell) && rawCell.name === cell.name && rawCell.value === cell.value
        ? (mergeKnownKeys(rawCell, QUOTE_CELL_KEYS, {
            name: cell.name,
            value: cell.value,
          }) as unknown as QuoteCell)
        : cell;
    });
    return { ...citation, cells };
  });
}
