import type { ClaimCheckResult, RecordCiteResult } from "../../src/core";
import type { WatchedRequest } from "../repeats/requests";
import { type ExpectedRecordCite, includesText, type RecordSetCase } from "./set";

export interface RecordCiteMiss {
  caseId: string;
  raw: string;
  reasons: string[];
  expected: ExpectedRecordCite | null;
  actual: RecordCiteResult | null;
}

export interface RecordCaseResult {
  test: RecordSetCase;
  result: ClaimCheckResult | null;
  failure: string | null;
  requests: WatchedRequest[];
  misses: RecordCiteMiss[];
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function scoreCite(
  test: RecordSetCase,
  expected: ExpectedRecordCite,
  actual: RecordCiteResult | undefined,
  keyOf: (id: string | undefined) => string | undefined,
): RecordCiteMiss | null {
  const reasons: string[] = [];
  if (!actual) reasons.push("no cite result");
  else {
    if (actual.raw !== expected.raw) reasons.push(`raw ${actual.raw} instead of ${expected.raw}`);
    if (actual.outcome !== expected.outcome) {
      reasons.push(`${actual.outcome} instead of ${expected.outcome}`);
    }
    if (expected.document && keyOf(actual.documentId) !== expected.document) {
      reasons.push(
        `Document ${keyOf(actual.documentId) ?? "missing"} instead of ${expected.document}`,
      );
    }
    if (expected.location && !sameJson(actual.location, expected.location)) {
      reasons.push(
        `Location ${JSON.stringify(actual.location)} instead of ${JSON.stringify(expected.location)}`,
      );
    }
    if (!includesText(actual.passage, expected.passageContains)) {
      reasons.push(`Passage does not contain ${expected.passageContains}`);
    }
    if (expected.candidates) {
      const candidates = (actual.candidates ?? []).map((candidate) => keyOf(candidate.id)).sort();
      if (!sameJson(candidates, [...expected.candidates].sort())) {
        reasons.push(
          `candidates ${candidates.join(", ")} instead of ${expected.candidates.join(", ")}`,
        );
      }
    }
    if (expected.nearby) {
      if (!actual.nearby) reasons.push("no nearby suggestion");
      else {
        if (!sameJson(actual.nearby.location, expected.nearby.location)) {
          reasons.push(`nearby Location ${JSON.stringify(actual.nearby.location)} is wrong`);
        }
        if (!includesText(actual.nearby.passage, expected.nearby.passageContains)) {
          reasons.push(`nearby Passage does not contain ${expected.nearby.passageContains}`);
        }
      }
    } else if (actual.nearby) {
      reasons.push("unexpected nearby suggestion");
    }
    if (expected.parts && (!actual.covered?.trim() || !actual.uncovered?.trim())) {
      reasons.push("Partly does not name both covered and uncovered parts");
    }
  }
  return reasons.length > 0
    ? { caseId: test.id, raw: expected.raw, reasons, expected, actual: actual ?? null }
    : null;
}

export function scoreRecordCase(
  test: RecordSetCase,
  result: ClaimCheckResult | null,
  failure: string | null,
  requests: WatchedRequest[],
  keyOf: (id: string | undefined) => string | undefined,
): RecordCaseResult {
  const actual = result?.recordCites ?? [];
  const misses = test.cites.flatMap((expected, index) => {
    const miss = scoreCite(test, expected, actual[index], keyOf);
    return miss ? [miss] : [];
  });
  for (const extra of actual.slice(test.cites.length)) {
    misses.push({
      caseId: test.id,
      raw: extra.raw,
      reasons: ["unexpected extra cite result"],
      expected: null,
      actual: extra,
    });
  }
  return { test, result, failure, requests, misses };
}
