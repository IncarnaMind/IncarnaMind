import type {
  CheckedVersion,
  Citation,
  CitationAttributes,
  ClaimCheckFailure,
  ClaimCheckResult,
  ExcludedEvidence,
  LeftOutDocument,
  ProviderError,
} from "../../api";

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
    case "cut-short-small-window":
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
 * What every result of a check carries, gathered as it goes: the Document versions it read and
 * the Documents its searches left out.
 */
export function createCheckResults() {
  const versions = new Map<string, string>();
  const excluded = new Map<string, LeftOutDocument>();
  const facts = () => ({
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
  });
  const notChecked = (
    reason: ClaimCheckFailure,
    detail: string | null = null,
  ): ClaimCheckResult => ({ verdict: "not-checked", reason, detail, ...facts() });
  return {
    readVersion(documentId: string, contentHash: string) {
      versions.set(documentId, contentHash);
    },
    leftOut(each: ExcludedEvidence) {
      if (excluded.has(each.documentId)) return;
      excluded.set(each.documentId, {
        documentId: each.documentId,
        documentName: each.documentName,
        reason: each.reason,
      });
    },
    facts,
    notChecked,
    failedCheck(error: ProviderError): ClaimCheckResult {
      const { reason, detail } = failureOf(error);
      return notChecked(reason, detail);
    },
  };
}

export type CheckResults = ReturnType<typeof createCheckResults>;

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
