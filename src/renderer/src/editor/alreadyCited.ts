import type { EditorState } from "@tiptap/pm/state";
import type { CitationAttributes, CitationCheck } from "../../../core/api";
import { continuesCitation, overlapsCitation } from "../../../shared/citationOverlap";
import { type NumberedCitation, numberedCitations } from "./citationNumbers";
import type { ShownClaim } from "./claimChecks";

/** The Citations a check's sentence holds, with their numbers in the Mind. */
export const citationsOf = (state: EditorState, claim: ShownClaim): NumberedCitation[] =>
  numberedCitations(state).filter(
    (each) => each.pos >= claim.sentence.from && each.pos < claim.sentence.to,
  );

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

export function citationDecision(state: EditorState, claim: ShownClaim): CitationDecision {
  const { evidence, calculation } = claim.check;
  if (!evidence || calculation) return { kind: "none" };
  const cited = citationsOf(state, claim).filter(
    ({ attributes }) =>
      attributes.documentId !== null && attributes.documentId === evidence.documentId,
  );
  const overlapping = cited.filter(({ attributes }) => overlapsCitation(attributes, evidence));
  const valid = overlapping.filter(({ attributes }) => !DOESNT_HOLD.has(attributes.check));
  // A Citation whose own check says it doesn't hold is replaced, never widened: it is broken, not
  // partial. A valid one on the same words comes first, or replacing the broken one would put a
  // second Citation on them.
  const invalid = overlapping.find(({ attributes }) => DOESNT_HOLD.has(attributes.check));
  if (valid.length === 0 && invalid) return { kind: "replace", citation: invalid, evidence };
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
  const replace = cited.find(({ attributes }) => DOESNT_HOLD.has(attributes.check));
  if (replace) return { kind: "replace", citation: replace, evidence };
  return { kind: "add" };
}
