import type { EditorState } from "@tiptap/pm/state";
import type {
  CitationAttributes,
  CitationCheck,
  CitationParagraph,
  ClaimCheckPart,
  QuotedWords,
} from "../../../core/api";
import { continuesCitation, overlapsCitation } from "../../../shared/citationOverlap";
import { parseQuotedWords, type QuotedWordsOnPage, quotedWordsAt } from "../../../shared/citations";
import { citationLocation } from "../../../shared/locations";
import { type NumberedCitation, numberedCitations } from "./citationNumbers";
import { citationParagraphAt } from "./citationParagraph";
import type { ShownClaim } from "./claimChecks";

/** The Citations a check's sentence holds, with their numbers in the Mind. */
export const citationsOf = (state: EditorState, claim: ShownClaim): NumberedCitation[] =>
  numberedCitations(state).filter(
    (each) => each.pos >= claim.sentence.from && each.pos < claim.sentence.to,
  );

/**
 * The places a sentence's card may cite its quoted words at (#2712): each Passage its check
 * found, for each Citation of that Document in the sentence whose quoted words weren't found,
 * for the core to look for them there (`useQuotedWordsOnPage`).
 */
export function quotedWordsAsks(
  state: EditorState,
  claim: ShownClaim,
): { words: QuotedWords; cited: CitationAttributes; paragraph: CitationParagraph | null }[] {
  const found = [
    claim.check.evidence,
    ...(claim.check.parts ?? []).flatMap((part) => part.evidence),
  ].filter((evidence): evidence is CitationAttributes => evidence?.check === "found");
  return citationsOf(state, claim).flatMap(({ attributes, pos }) => {
    const words = parseQuotedWords(attributes.quotedWords);
    if (!words || attributes.documentId === null) return [];
    const paragraph = citationParagraphAt(state.doc, pos);
    return found
      .filter((evidence) => evidence.documentId === attributes.documentId)
      .map((cited) => ({ words, cited, paragraph }));
  });
}

const DOESNT_HOLD: ReadonlySet<CitationCheck> = new Set([
  "not-found",
  "unsupported",
  "contradicted",
]);

/**
 * What a supported sentence's card offers for the Passage its check found
 * (#1620): the Citation that doesn't hold, which the Passage should replace;
 * the Citation that already covers it, as it is or widened to the whole clause;
 * Add as Citation when the sentence cites nothing on those words; or none, for
 * a figure worked out or nothing found.
 */
export type CitationDecision =
  | { kind: "already"; citation: NumberedCitation }
  | { kind: "widen"; citation: NumberedCitation; evidence: CitationAttributes }
  | { kind: "replace"; citation: NumberedCitation; evidence: CitationAttributes }
  | { kind: "add" }
  | { kind: "none" };

export function citationDecision(
  state: EditorState,
  claim: ShownClaim,
  onPage?: QuotedWordsOnPage,
): CitationDecision {
  const { evidence, calculation } = claim.check;
  if (!evidence || calculation || ofProperties(evidence)) return { kind: "none" };
  return decisionFor(state, claim, evidence, onPage);
}

/**
 * A file's properties (#2458) and the Library's facts (#2525) are no Passage a Note's Citation
 * could quote: a check names them in its row, and the Note's Citations stay quotes of the
 * Documents' text, which every check reads.
 */
const ofProperties = (evidence: CitationAttributes) => {
  const kind = citationLocation(evidence)?.kind;
  return kind === "properties" || kind === "library";
};

/**
 * What a supported part's row offers for each Passage its check found, by the
 * sentence's rules (#2002): a part worked out by a calculation offers none.
 */
export function partDecisions(
  state: EditorState,
  claim: ShownClaim,
  part: ClaimCheckPart,
  onPage?: QuotedWordsOnPage,
): { evidence: CitationAttributes; decision: CitationDecision }[] {
  if (part.verdict !== "supported" || part.calculation) return [];
  return part.evidence
    .filter((evidence) => evidence.check === "found" && !ofProperties(evidence))
    .map((evidence) => ({ evidence, decision: decisionFor(state, claim, evidence, onPage) }));
}

function decisionFor(
  state: EditorState,
  claim: ShownClaim,
  evidence: CitationAttributes,
  onPage?: QuotedWordsOnPage,
): CitationDecision {
  const cited = citationsOf(state, claim).filter(
    ({ attributes }) =>
      attributes.documentId !== null && attributes.documentId === evidence.documentId,
  );
  // Replace may write "found" only where the words the sentence put in quotation marks are on
  // the Passage's page too, or the Citation's card would say they are found when nothing looked
  // for them (#483, #1808, #2712).
  const replaceable = ({ attributes, pos }: NumberedCitation) =>
    quotedWordsAt(
      attributes.quotedWords,
      evidence,
      onPage && { onPage, paragraph: citationParagraphAt(state.doc, pos) },
    );
  const overlapping = cited.filter(({ attributes }) => overlapsCitation(attributes, evidence));
  const valid = overlapping.filter(({ attributes }) => !DOESNT_HOLD.has(attributes.check));
  // A Citation whose own check says it doesn't hold is replaced, never widened: it is broken, not
  // partial. A valid one on the same words comes first, or replacing the broken one would put a
  // second Citation on them.
  const invalid = overlapping.find(({ attributes }) => DOESNT_HOLD.has(attributes.check));
  if (valid.length === 0 && invalid) {
    return replaceable(invalid)
      ? { kind: "replace", citation: invalid, evidence }
      : { kind: "already", citation: invalid };
  }
  let wider: NumberedCitation | null = null;
  for (const each of valid) {
    if (
      continuesCitation(each.attributes, evidence, claim.sentence.text) &&
      (wider === null ||
        (each.attributes.quote?.length ?? 0) > (wider.attributes.quote?.length ?? 0))
    ) {
      wider = each;
    }
  }
  if (wider) return { kind: "widen", citation: wider, evidence };
  const already = valid[0];
  if (already) return { kind: "already", citation: already };
  const replace = cited.find((each) => DOESNT_HOLD.has(each.attributes.check) && replaceable(each));
  if (replace) return { kind: "replace", citation: replace, evidence };
  return { kind: "add" };
}
