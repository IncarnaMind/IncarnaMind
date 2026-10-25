/**
 * A Mind's health (#96): its Citations found and not found, whatever their
 * sentence's verdict, and its sentences without support: those checked as unsupported or
 * contradicted, and those that make a claim with no Citation; then those
 * whose check needs a re-check or couldn't be made. Each part keeps where
 * its sentences or Citations are, top to bottom, so it can move to the next.
 * A sentence is in one part: a claim with no check counts as "not checked yet"
 * when it has a Citation or an Answer wrote it, and as having no Citation otherwise.
 *
 * Its own sentences count: in paragraphs, lists, quotes and Answers added to
 * it, not in headings, Questions, code, formulas, tables or footnotes.
 * Changes still waiting don't count: the words and Citations they would
 * add aren't the Mind's yet.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  CITATION_NODE,
  type CitationAttributes,
  type CitationCheck,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
} from "../../../core/api";
import { sentenceKey } from "../../../shared/mindCheck";
import { readProposalAttribute } from "../../../shared/proposals";
import { isClaim, sentenceSpans } from "../../../shared/sentences";
import { paragraphPlaces, type ShownClaim } from "./claimChecks";
import { BLOCK_ID_ATTRIBUTE } from "./noteSchema";

export const HEALTH_PARTS = [
  "found",
  "notFound",
  "unsupported",
  "contradicted",
  "noCitation",
  "recheck",
  "notChecked",
] as const;
export type HealthPart = (typeof HEALTH_PARTS)[number];

/**
 * Where each part's sentences or Citations are, top to bottom: its count is
 * how many. `unchecked`: the sentences that make a claim with no check, that
 * have a Citation or that an Answer wrote, but those the last whole-Mind check
 * found make none (#737).
 */
export type NoteHealth = Record<HealthPart, number[]> & { unchecked: number[] };

/** Blocks whose text isn't counted. */
const UNCOUNTED: ReadonlySet<string> = new Set([
  "question",
  "heading",
  "codeBlock",
  "blockMath",
  "table",
  "chart",
]);

/** Words or a node a change adds: not the Mind's until it is accepted. */
const proposed = (node: ProseMirrorNode) =>
  readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE])?.kind === "insert" ||
  node.marks.some((mark) => mark.type.name === PROPOSAL_INSERT_MARK);

const PROBLEM: Partial<Record<ShownClaim["shown"]["state"], HealthPart>> = {
  unsupported: "unsupported",
  contradicted: "contradicted",
  "needs-recheck": "recheck",
  "not-checked": "notChecked",
};

export function noteHealth(
  doc: ProseMirrorNode,
  claims: readonly ShownClaim[],
  citationCheck: (attributes: CitationAttributes) => CitationCheck,
  skipped: ReadonlySet<string> = new Set(),
  /** Whether an Answer wrote the block with this id: its claims are to check, cited or not. */
  writtenByAnswer: (blockId: unknown) => boolean = () => false,
): NoteHealth {
  const health: NoteHealth = {
    found: [],
    notFound: [],
    unsupported: [],
    contradicted: [],
    noCitation: [],
    recheck: [],
    notChecked: [],
    unchecked: [],
  };
  doc.descendants((node, pos) => {
    if (UNCOUNTED.has(node.type.name) || proposed(node)) return false;
    if (!node.isTextblock) return true;
    if (node.type.name !== "paragraph") return false;
    const answered = writtenByAnswer(doc.resolve(pos + 1).node(1).attrs[BLOCK_ID_ATTRIBUTE]);
    const { text, starts, ends, inline } = paragraphPlaces(node, pos, proposed);
    const citations = inline.flatMap(({ node: child, at, pos: place }) =>
      child.type.name === CITATION_NODE
        ? [{ at, pos: place, attributes: child.attrs as CitationAttributes }]
        : [],
    );
    for (const span of sentenceSpans(text)) {
      const from = starts[span.from] ?? pos;
      const to = ends[span.to - 1] ?? from;
      const claim = claims.find((each) => each.from < to && each.to > from);
      const words = text.slice(span.from, span.to);
      const problem = claim && PROBLEM[claim.shown.state];
      if (problem) health[problem].push(from);
      const cited = citations.filter((each) => each.at >= span.from && each.at < span.to);
      for (const citation of cited) {
        const check = citationCheck(citation.attributes);
        if (check === "found") health.found.push(citation.pos);
        else if (check === "not-found") health.notFound.push(citation.pos);
      }
      const toCheck =
        !claim &&
        isClaim(words) &&
        !skipped.has(sentenceKey(words)) &&
        (cited.length > 0 || answered);
      if (toCheck) health.unchecked.push(from);
      else if (!problem && cited.length === 0 && isClaim(words)) health.noCitation.push(from);
    }
    return false;
  });
  return health;
}
