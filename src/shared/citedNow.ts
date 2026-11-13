import type {
  CitationAttributes,
  CitationCheck,
  ClaimCheckAttributes,
  ClaimCheckPart,
} from "../core/api";
import { type CitedPlace, continuesCitation, overlapsCitation } from "./citationOverlap";
import { checkedCitation, resultFromParts } from "./claimParts";
import { citationLocation } from "./locations";

/** A Citation's own checks that say it doesn't hold: the card replaces one, never widens it (#1620). */
export const DOESNT_HOLD: ReadonlySet<CitationCheck> = new Set([
  "not-found",
  "unsupported",
  "contradicted",
]);

/** One of a sentence's Citations as the Note holds it now. */
export type HeldCitation = Partial<CitedPlace> & {
  check?: CitationCheck | null;
  foundByCheck?: true | null;
};

/**
 * Whether the sentence has a Citation its writer gave it: only then can a ✓ stand beside a Citation
 * whose words don't say it (#2739). One with none, or only Passages its checks found, keeps its ✓
 * and the "+" that offers the rest, as it always did.
 */
const writerCited = (citations: readonly HeldCitation[]) =>
  citations.some((citation) => citation.foundByCheck !== true);

const placeOf = (citation: HeldCitation): CitedPlace => ({
  documentId: citation.documentId ?? null,
  contentHash: citation.contentHash ?? null,
  pageFrom: citation.pageFrom ?? null,
  pageTo: citation.pageTo ?? null,
  quote: citation.quote ?? null,
});

/**
 * Whether the sentence's Citations hold the Passage a check found, as its card says "Already
 * cited" (#1620): one that holds is on the same words, and none of them is a part of a clause the
 * sentence says more of, which the card widens instead.
 */
export function citesPassage(
  citations: readonly HeldCitation[],
  found: CitedPlace,
  sentence: string,
): boolean {
  const on = citations
    .filter((citation) => !citation.check || !DOESNT_HOLD.has(citation.check))
    .map(placeOf)
    .filter((citation) => overlapsCitation(citation, found));
  return on.length > 0 && !on.some((citation) => continuesCitation(citation, found, sentence));
}

type Judged = Pick<
  ClaimCheckPart,
  "verdict" | "evidence" | "decidingEvidence" | "calculation" | "readDocuments" | "kept"
> &
  Partial<Pick<ClaimCheckPart, "figures" | "coverage">>;

/**
 * The Passage a Supported part rests on, where a Note's Citation could quote it: none for a figure
 * worked out, a whole read, a list's members, a file's properties or the Library's facts.
 */
function restingPassage(part: Judged): CitationAttributes | null {
  if (
    part.verdict !== "supported" ||
    part.kept ||
    part.calculation ||
    part.coverage ||
    (part.figures?.length ?? 0) > 0 ||
    (part.readDocuments?.length ?? 0) > 0 ||
    part.decidingEvidence === null
  )
    return null;
  const evidence = part.evidence[part.decidingEvidence ?? 0];
  if (!evidence || checkedCitation(evidence) === null) return null;
  const kind = citationLocation(evidence)?.kind;
  return kind === "properties" || kind === "library" ? null : evidence;
}

/**
 * Whether a part's ✓ rests on a Passage the sentence's Citations don't hold: it shows none until
 * that Passage is one of them (#3019).
 */
export function restsElsewhere(
  part: Judged,
  citations: readonly HeldCitation[],
  sentence: string,
): boolean {
  if (!writerCited(citations)) return false;
  const passage = restingPassage(part);
  return passage !== null && !citesPassage(citations, placeOf(passage), sentence);
}

const elsewhere = { verdict: "not-checked", reason: "found-elsewhere", detail: null } as const;

/**
 * A check as the sentence's Citations read it now (#3019): a Supported part whose Passage they
 * don't hold reads Not checked, `found-elsewhere`, and the sentence takes its parts' worst result.
 * Adding that Passage as a Citation brings the model's own verdict back with no new request, and
 * Undo takes it away again. The mark keeps what the check gave: this is a reading, never written.
 */
export function asCitedNow(
  check: ClaimCheckAttributes,
  citations: readonly HeldCitation[],
  sentence: string,
): ClaimCheckAttributes {
  if (!writerCited(citations) || check.kept || (check.figures?.length ?? 0) > 0) return check;
  if (!check.parts) {
    const { evidence } = check;
    const whole: Judged = {
      verdict: check.state,
      evidence: evidence ? [evidence] : [],
      calculation: check.calculation,
      ...(check.readDocuments && { readDocuments: check.readDocuments }),
    };
    if (!evidence || !restsElsewhere(whole, citations, sentence)) return check;
    // A mark made before parts were kept shows its Passage on a row of its own, with Add as Citation.
    const part: ClaimCheckPart = {
      span: { start: 0, end: check.text.length },
      kind: "fact",
      ...elsewhere,
      evidence: [evidence],
      says: null,
      unsupported: null,
      calculation: null,
      versions: check.versions,
      excluded: check.excluded,
      citedCaseUnchecked: false,
      citedCaseFound: false,
    };
    return { ...notCheckedNow(check), parts: [part] };
  }
  let moved = false;
  const parts = check.parts.map((part) => {
    if (!restsElsewhere(part, citations, sentence)) return part;
    moved = true;
    return { ...part, ...elsewhere };
  });
  if (!moved) return check;
  if (check.state === "checking") return { ...check, parts };
  const result = resultFromParts(parts);
  if (result.verdict !== "not-checked") return { ...check, parts };
  return { ...notCheckedNow(check, result.reason, result.detail), parts };
}

function notCheckedNow(
  { correction: _correction, ...check }: ClaimCheckAttributes,
  reason: ClaimCheckAttributes["reason"] = elsewhere.reason,
  detail: string | null = null,
): ClaimCheckAttributes {
  return {
    ...check,
    state: "not-checked",
    reason,
    detail,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
  };
}
