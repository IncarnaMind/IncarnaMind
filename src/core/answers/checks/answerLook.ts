/**
 * Before an Answer's sentence settles as Unsupported, it is checked once more as a sentence the
 * assistant writes into a Note is (#3020, #2809): that check searches the Answer's scope, walls
 * applied, for what the sentence's Citations don't cover, and its verdict is the sentence's. A
 * Passage it finds for a part becomes that part's Citation in the Answer's own number series. A
 * look that couldn't judge the sentence leaves it as its batch read it.
 */
import { citesPassage } from "../../../shared/citedNow";
import { leftOutByAssistant, partsWrittenBy } from "../../../shared/claimParts";
import { citationLocation } from "../../../shared/locations";
import type {
  CitationAttributes,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartSpan,
  MarkedCitation,
} from "../../api";
import { citationKey } from "./checkResults";

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

const isNoPassage = (citation: CitationAttributes) => {
  const kind = citationLocation(citation)?.kind;
  return kind === "properties" || kind === "library";
};

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
  const passed = partsOf(result, sentence).filter((part) => part.verdict === "supported");
  // An Answer cites Passages of Documents: a part passed on a file's own properties or the
  // Library's facts gives the Answer no verdict, and its sentence stays as its batch read it (#2311).
  if (result.verdict === "supported" && passed.some((part) => part.evidence.some(isNoPassage))) {
    return null;
  }
  // The assistant wrote every sentence of an Answer: where the check left a conclusion of the
  // assistant's own out, the rest passing is no verdict on the sentence (#3019).
  if (
    result.verdict === "supported" &&
    partsWrittenBy(result.parts ?? [], true).some(leftOutByAssistant)
  ) {
    return null;
  }
  const held = new Set<string>();
  // A list's items rest on a Passage each: every Passage a part's verdict cites, once.
  const found = partsOf(result, sentence).flatMap((part): FoundPassage[] =>
    part.verdict !== "supported"
      ? []
      : part.evidence.flatMap((citation) => {
          const passage = citation.passageId ?? citationKey(citation);
          if (held.has(passage) || citesPassage(citations, citation, sentence)) return [];
          held.add(passage);
          return [{ span: part.span, citation }];
        }),
  );
  if (result.verdict === "supported") {
    return { check: "found", verdict: null, unsupported: null, found };
  }
  if (result.verdict === "contradicted") {
    return { check: "contradicted", verdict: result.says, unsupported: null, found };
  }
  const { reason = null, covered = null, uncovered = null } = result.unsupported ?? {};
  const whole = sentence.trim().replace(/[.。]$/u, "");
  const missing = (result.parts ?? [])
    .filter((part) => part.verdict === "unsupported")
    .map((part) => sentence.slice(part.span.start, part.span.end).trim())
    // A part that is the whole sentence names nothing: the check's own phrases say what is missing.
    .filter((words) => words.length > 0 && words.replace(/[.。]$/u, "") !== whole);
  return {
    check: "unsupported",
    verdict: reason,
    unsupported: { covered, uncovered, missing },
    found,
  };
}
