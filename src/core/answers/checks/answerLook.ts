/**
 * Before an Answer's sentence settles as Unsupported, it is checked once more as a sentence the
 * assistant writes into a Note is (#3020, #2809): that check searches the Answer's scope, walls
 * applied, for what the sentence's Citations don't cover, and its verdict is the sentence's. A
 * Passage it finds for a part becomes that part's Citation in the Answer's own number series. A
 * look that couldn't judge the sentence leaves it as its batch read it.
 */
import { restsElsewhere } from "../../../shared/citedNow";
import type {
  CitationAttributes,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartSpan,
  MarkedCitation,
} from "../../api";

/** How many of an Answer's sentences take the look, in the Answer's order: the rest read as their batch read them. */
export const LOOKS_AN_ANSWER = 3;

/** A Passage the look found for a part of the sentence that none of its Citations holds. */
export interface FoundPassage {
  /** The part's words, as offsets in the sentence without its markers. */
  span: ClaimPartSpan;
  citation: CitationAttributes;
}

/** What the look read of a sentence. */
export interface LookResult {
  check: "found" | "unsupported" | "contradicted";
  /** For unsupported or contradicted: what the Documents say, in one plain sentence. */
  verdict: string | null;
  /**
   * For unsupported: a short phrase for what the Documents state of the sentence and one for what
   * they don't, and the sentence's own words for each part no Passage states (#2809).
   */
  unsupported: { covered: string | null; uncovered: string | null; missing: string[] } | null;
  found: FoundPassage[];
}

type Decided = Pick<
  ClaimCheckPart,
  | "span"
  | "verdict"
  | "evidence"
  | "decidingEvidence"
  | "calculation"
  | "readDocuments"
  | "kept"
  | "figures"
  | "coverage"
>;

/** The sentence's parts as the look judged them: its one judgement, when it named no parts. */
function partsOf(result: ClaimCheckResult, sentence: string): Decided[] {
  if (result.parts && result.parts.length > 0) return result.parts;
  if (result.verdict === "not-checked") return [];
  return [
    {
      span: { start: 0, end: sentence.length },
      verdict: result.verdict,
      evidence: result.evidence ? [result.evidence] : [],
      decidingEvidence: result.evidence ? 0 : null,
      calculation: result.calculation,
      ...(result.readDocuments && { readDocuments: result.readDocuments }),
      ...(result.kept && { kept: result.kept }),
    },
  ];
}

/**
 * The look's result for an Answer's sentence; null when it gave no verdict, so the batch's stands.
 * Code never turns a verdict: Supported here is the look's own model's.
 */
export function lookResult(
  result: ClaimCheckResult,
  sentence: string,
  citations: readonly MarkedCitation[],
): LookResult | null {
  if (result.verdict === "not-checked") return null;
  const found = partsOf(result, sentence).flatMap((part): FoundPassage[] => {
    if (!restsElsewhere(part, citations, sentence)) return [];
    const citation = part.evidence[part.decidingEvidence ?? 0];
    return citation ? [{ span: part.span, citation }] : [];
  });
  if (result.verdict === "supported") {
    return { check: "found", verdict: null, unsupported: null, found };
  }
  if (result.verdict === "contradicted") {
    return { check: "contradicted", verdict: result.says, unsupported: null, found };
  }
  const { reason = null, covered = null, uncovered = null } = result.unsupported ?? {};
  const missing = (result.parts ?? [])
    .filter((part) => part.verdict === "unsupported")
    .map((part) => sentence.slice(part.span.start, part.span.end).trim())
    .filter((words) => words.length > 0);
  return {
    check: "unsupported",
    verdict: reason,
    unsupported: { covered, uncovered, missing },
    found,
  };
}
