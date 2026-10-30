/** The rows a check's card shows for a sentence (#2002): each part, and each member of a quantified part's domain, under its part's words. */
import type { ClaimCheckPart, ClaimPartCoverage } from "../core/api";

/** Whether a quantified part's domain is known: complete, and membership backed by a found quote. */
export function hasKnownDomain(coverage: ClaimPartCoverage): boolean {
  return (
    coverage.complete &&
    coverage.domainEvidence.some(
      (citation) =>
        citation.check === "found" && Boolean(citation.documentId && citation.quote?.trim()),
    )
  );
}

/** A card's rows: each part, and each member of a quantified part's domain, under its part's words. */
export function cardRows(
  parts: readonly ClaimCheckPart[],
): { part: ClaimCheckPart; label: string | null }[] {
  return parts.flatMap<{ part: ClaimCheckPart; label: string | null }>((part) => {
    if (!part.coverage) return [{ part, label: null }];
    const members = part.coverage.members.map((member) => ({
      part: { ...part, verdict: member.verdict, evidence: member.evidence, coverage: undefined },
      label: member.label,
    }));
    return hasKnownDomain(part.coverage)
      ? members
      : [{ part: { ...part, coverage: undefined }, label: null }, ...members];
  });
}
