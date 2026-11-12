import type {
  CheckedVersion,
  Citation,
  CitationAttributes,
  ClaimCheckFailure,
  ClaimCheckResult,
  ClaimJudgment,
  ClaimPartCoverage,
  ExcludedEvidence,
  LeftOutDocument,
  PassageSearchResult,
  ProviderError,
  UnsupportedReason,
} from "../../api";
import type { WindowedPassage } from "../../documents/search";
import type { NotJudged } from "../judge";
import type { ClaimCheckRequest } from "./claimCheck";
import { uncheckedFigureResults } from "./figureChecks";
import { figuresMatch, nearestLine } from "./nearest";

/** Why a provider's failure left a claim not checked. */
export function failureOf(error: ProviderError): {
  reason: ClaimCheckFailure;
  detail: string | null;
} {
  switch (error.kind) {
    case "rate-limit":
      return { reason: "rate-limit", detail: null };
    case "cost-cap":
      // The budget and the spend, as JSON, for the card to say in the User's currency format.
      return error.budget
        ? { reason: "read-budget", detail: JSON.stringify(error.budget) }
        : { reason: "cost-cap", detail: null };
    case "plan-limit":
      return { reason: "plan-limit", detail: null };
    case "out-of-credit":
      return { reason: "out-of-credit", detail: null };
    case "consent-revoked":
      return { reason: "consent-revoked", detail: null };
    case "local-mode":
      return { reason: "local-mode", detail: null };
    case "no-answer":
      return { reason: "empty", detail: null };
    case "cut-short":
      return { reason: "cut-short", detail: null };
    default:
      return { reason: "failed", detail: error.message };
  }
}

/** A claim check's failure that the run's other claims share: waited out, or it stops the run. */
export function runFailureOf(result: ClaimCheckResult): ProviderError | null {
  if (result.verdict !== "not-checked") return null;
  const { reason } = result;
  if (reason !== "rate-limit" && reason !== "cost-cap" && reason !== "plan-limit") return null;
  return { kind: reason, message: result.detail ?? reason };
}

/**
 * A Passage the check found and judged that doesn't back the sentence, with nothing to quote from it:
 * Unsupported, never Not found (#1608).
 */
export const UNBACKED: UnsupportedReason = {
  reason: null,
  covered: null,
  uncovered: null,
  found: true,
};

/**
 * What every result of a check carries, gathered as it goes: the Document versions it read, the
 * Documents its searches left out, in a whole read's window the Passages that reached the model,
 * and the quotes and coverage it keeps as evidence.
 */
export function createCheckResults(
  request: Pick<ClaimCheckRequest, "claim" | "figures" | "window">,
) {
  const versions = new Map<string, string>();
  const readPassages = new Set<string>();
  const excluded = new Map<string, LeftOutDocument>();
  const workings = new Map<string, PassageSearchResult[]>();
  let retainedEvidence: Citation[] = [];
  let retainedCoverage: ClaimPartCoverage | undefined;
  const facts = () => ({
    ...(retainedEvidence.length > 0 && { checkedEvidence: retainedEvidence }),
    ...(retainedCoverage && { coverage: retainedCoverage }),
    versions: [...versions].map(
      ([documentId, contentHash]): CheckedVersion => ({ documentId, contentHash }),
    ),
    excluded: [...excluded.values()].filter(
      (each) =>
        each.reason === "own-file" ||
        each.reason === "own-note" ||
        each.reason === "checked-document" ||
        each.reason === "same-text",
    ),
    ...(request.window && { readPassages: [...readPassages] }),
  });
  const workingsSayingIt = (): LeftOutDocument[] =>
    [...workings].flatMap(([documentId, passages]) => {
      const left = excluded.get(documentId);
      const speaks = passages.some(
        (passage) =>
          figuresMatch(request.claim, passage.text) &&
          nearestLine(request.claim, [{ id: passage.passageId, text: passage.text }]),
      );
      return left && speaks ? [left] : [];
    });
  const unchecked = (reason: ClaimCheckFailure, detail: string | null = null): ClaimJudgment => ({
    verdict: "not-checked",
    reason,
    detail,
    ...facts(),
  });
  const notChecked = (
    reason: ClaimCheckFailure,
    detail: string | null = null,
  ): ClaimCheckResult => {
    const result = unchecked(reason, detail);
    return request.figures?.length ? uncheckedFigureResults(request.figures, result) : result;
  };
  const failedCheck = (error: ProviderError): ClaimCheckResult => {
    const { reason, detail } = failureOf(error);
    return notChecked(reason, detail);
  };
  /** A judge's question that came to no reading, as the sentence's result says it. */
  const unjudged = (failure: NotJudged): ClaimCheckResult => {
    if (failure.reason === "stopped") return notChecked("stopped");
    if (failure.error) return failedCheck(failure.error);
    return notChecked(failure.reason === "refused" ? "refused" : "malformed");
  };
  return {
    readVersion(documentId: string, contentHash: string) {
      versions.set(documentId, contentHash);
    },
    readInWindow(passage: WindowedPassage) {
      versions.set(passage.documentId, passage.contentHash);
      readPassages.add(passage.passageId);
    },
    leftOut(each: ExcludedEvidence) {
      if (each.reason === "own-workings") {
        workings.set(each.documentId, [...(workings.get(each.documentId) ?? []), ...each.passages]);
      }
      if (excluded.has(each.documentId)) return;
      excluded.set(each.documentId, {
        documentId: each.documentId,
        documentName: each.documentName,
        reason: each.reason,
      });
    },
    evidence: (): readonly Citation[] => retainedEvidence,
    keepEvidence(citations: readonly Citation[]) {
      retainedEvidence = uniqueCitations([...retainedEvidence, ...citations]);
    },
    keepCoverage(coverage: ClaimPartCoverage) {
      retainedCoverage = coverage;
    },
    /** Takes the quotes keyed in `keys` out of the evidence and coverage kept. */
    dropEvidence(keys: ReadonlySet<string>) {
      const notGiven = <T extends CitationKeyed>(list: readonly T[]): T[] =>
        list.filter((each) => !keys.has(citationKey(each)));
      retainedEvidence = notGiven(retainedEvidence);
      if (retainedCoverage) {
        retainedCoverage = {
          ...retainedCoverage,
          members: retainedCoverage.members.map((member) => ({
            ...member,
            evidence: notGiven(member.evidence),
          })),
          domainEvidence: notGiven(retainedCoverage.domainEvidence),
        };
      }
    },
    facts,
    workingsSayingIt,
    unchecked,
    notChecked,
    failedCheck,
    unjudged,
  };
}

export type CheckResults = ReturnType<typeof createCheckResults>;

export function foundCitations(
  finalCitation: (marker: number) => Citation | null,
  deciding: Citation | null,
  markers: readonly number[] = [1, 2, 3, 4],
): Citation[] {
  const found: Citation[] = [];
  for (const marker of markers) {
    const citation = finalCitation(marker);
    if (citation?.check !== "found") continue;
    if (deciding && citationKey(citation) === citationKey(deciding)) continue;
    found.push(citation);
  }
  return uniqueCitations(found);
}

/** The Citation that decides a claim: marker 1's, or the first other marker's, whose quote the check found. */
export function decidingCitation(
  finalCitation: (marker: number) => Citation | null,
): Citation | null {
  for (let marker = 1; marker <= 4; marker++) {
    const citation = finalCitation(marker);
    if (citation?.check === "found") return citation;
  }
  return null;
}

export type CitationKeyed = Pick<
  CitationAttributes,
  "documentId" | "contentHash" | "passageId" | "pageFrom" | "pageTo" | "location" | "quote"
>;

export const citationKey = (citation: CitationKeyed) =>
  JSON.stringify([
    citation.documentId,
    citation.contentHash,
    citation.passageId,
    citation.pageFrom,
    citation.pageTo,
    citation.location,
    citation.quote,
  ]);

export const uniqueCitations = (citations: readonly Citation[]): Citation[] => [
  ...new Map(citations.map((citation) => [citationKey(citation), citation])).values(),
];
