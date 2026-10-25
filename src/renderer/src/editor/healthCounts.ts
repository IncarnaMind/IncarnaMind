/**
 * A Mind's health (#96, #1909): its Citations found and not found, whatever
 * their sentence's verdict, and its claims: those a check covers (unsupported,
 * contradicted, or with a Citation), and those still to check. One rule counts
 * the sentences a check reads (`checkedSentence` in ../../../shared/claimChecks):
 * a claim no check covers now is to check.
 *
 * Its own sentences count: in paragraphs, lists, quotes, Answers and table
 * cells added to it, not in headings, Questions, code, formulas or footnotes.
 * Changes still waiting don't count: the words and Citations they would add
 * aren't the Mind's yet.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  CITATION_NODE,
  type CitationAttributes,
  type CitationCheck,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
} from "../../../core/api";
import {
  type CheckedSentence,
  checkedSentence,
  type KeptMark,
  keptOn,
} from "../../../shared/claimChecks";
import { sentenceKey } from "../../../shared/mindCheck";
import { readProposalAttribute } from "../../../shared/proposals";
import { isClaim, sentenceSpans } from "../../../shared/sentences";
import { keptSpans, paragraphPlaces, type ShownClaim, shownClaims } from "./claimChecks";
import { BLOCK_ID_ATTRIBUTE } from "./noteSchema";

export const HEALTH_PARTS = [
  "found",
  "notFound",
  "unsupported",
  "contradicted",
  "toCheck",
  "noCitation",
] as const;
export type HealthPart = (typeof HEALTH_PARTS)[number];

/**
 * Where each part's sentences or Citations are, top to bottom: its count is
 * how many. `toCheck`: every claim no check covers now; `tableCells` and
 * `citable` are the parts of that count a table holds and that a Citation or
 * an Answer's words make (#1194, #1909); `checkable`: every claim a check
 * reads, to check or covered.
 */
export interface NoteHealth {
  found: number[];
  notFound: number[];
  unsupported: number[];
  contradicted: number[];
  toCheck: number[];
  tableCells: number[];
  citable: number[];
  noCitation: number[];
  checkable: number;
}

/** Blocks whose text isn't counted. */
const UNCOUNTED: ReadonlySet<string> = new Set([
  "question",
  "heading",
  "codeBlock",
  "blockMath",
  "chart",
]);

/** Words or a node a change adds: not the Mind's until it is accepted. */
const proposed = (node: ProseMirrorNode) =>
  readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE])?.kind === "insert" ||
  node.marks.some((mark) => mark.type.name === PROPOSAL_INSERT_MARK);

/** What each sentence counts with, read the same way from the core and the window. */
export interface SentenceInput {
  claims: readonly ShownClaim[];
  /** The last whole-Mind check found these sentences make no claim, by `sentenceKey`. */
  skipped?: ReadonlySet<string>;
  /** The marks the User keeps as their own view, at their places. */
  kept?: readonly KeptMark[];
  /** Whether an Answer wrote the block with this id. */
  writtenByAnswer?: (blockId: unknown) => boolean;
}

export interface NoteHealthInput extends SentenceInput {
  citationCheck: (attributes: CitationAttributes) => CitationCheck;
}

/** One sentence a check reads, where it is and how it counts. */
export interface SentencePlace {
  /** The whole sentence's first and last characters in the document. */
  from: number;
  to: number;
  /** As checks read it: an inline node as U+FFFC, a line break as "\n". */
  text: string;
  claim: ShownClaim | null;
  citations: { attributes: CitationAttributes; at: number; pos: number }[];
  /** Its top-level Block's id: the one an Answer's origin names. */
  blockId: unknown;
  /** An Answer wrote its block. */
  answered: boolean;
  /** It is in a table cell. */
  inTable: boolean;
  state: CheckedSentence;
}

const inTable = (doc: ProseMirrorNode, pos: number): boolean => {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === "table") return true;
  }
  return false;
};

function eachSentence(
  doc: ProseMirrorNode,
  input: SentenceInput,
  visit: (place: SentencePlace) => void,
): void {
  const skipped = input.skipped ?? new Set<string>();
  const kept = input.kept ?? [];
  const writtenByAnswer = input.writtenByAnswer ?? (() => false);
  doc.descendants((node, pos) => {
    if (UNCOUNTED.has(node.type.name) || proposed(node)) return false;
    if (!node.isTextblock) return true;
    if (node.type.name !== "paragraph") return false;
    const blockId = doc.resolve(pos + 1).node(1).attrs[BLOCK_ID_ATTRIBUTE];
    const answered = writtenByAnswer(blockId);
    const { text, starts, ends, inline } = paragraphPlaces(node, pos, proposed);
    const citations = inline.flatMap(({ node: child, at, pos: place }) =>
      child.type.name === CITATION_NODE
        ? [{ attributes: child.attrs as CitationAttributes, at, pos: place }]
        : [],
    );
    const table = inTable(doc, pos);
    for (const span of sentenceSpans(text)) {
      const from = starts[span.from] ?? pos;
      const to = ends[span.to - 1] ?? from;
      const claim = input.claims.find((each) => each.from < to && each.to > from) ?? null;
      const words = text.slice(span.from, span.to);
      const state = checkedSentence({
        text: words,
        check: claim?.shown ?? null,
        skipped: skipped.has(sentenceKey(words)),
        kept: keptOn(kept, { from, to, text: words }),
      });
      visit({
        from,
        to,
        text: words,
        claim,
        citations: citations.filter((each) => each.at >= span.from && each.at < span.to),
        blockId,
        answered,
        inTable: table,
        state,
      });
    }
    return false;
  });
}

export function noteHealth(doc: ProseMirrorNode, input: NoteHealthInput): NoteHealth {
  const health: NoteHealth = {
    found: [],
    notFound: [],
    unsupported: [],
    contradicted: [],
    toCheck: [],
    tableCells: [],
    citable: [],
    noCitation: [],
    checkable: 0,
  };
  eachSentence(doc, input, ({ from, text, claim, citations, answered, inTable: table, state }) => {
    for (const citation of citations) {
      const check = input.citationCheck(citation.attributes);
      if (check === "found") health.found.push(citation.pos);
      else if (check === "not-found") health.notFound.push(citation.pos);
    }
    if (state.kind === "to-check") {
      health.checkable++;
      health.toCheck.push(from);
      if (table) health.tableCells.push(from);
      // A Citation, an Answer's words, or a check that failed or no longer holds shows the badge (#1194).
      if (citations.length > 0 || answered || state.why !== "none") health.citable.push(from);
      return;
    }
    if (state.kind !== "covered" || !claim) return;
    health.checkable++;
    if (claim.shown.state === "unsupported") health.unsupported.push(from);
    else if (claim.shown.state === "contradicted") health.contradicted.push(from);
    else if (isClaim(text) && citations.length === 0) health.noCitation.push(from);
  });
  return health;
}

/** Whether the card can say everything is checked: a sentence was checked, none is left, and no unsupported or contradicted sentence shows (#1909). */
export function everythingChecked(
  health: NoteHealth,
  { running, problem }: { running: boolean; problem: boolean },
): boolean {
  return (
    !running &&
    !problem &&
    health.checkable > 0 &&
    health.toCheck.length === 0 &&
    health.unsupported.length === 0 &&
    health.contradicted.length === 0
  );
}

/**
 * The whole sentences a check still has to make in this Mind, as ranges to
 * check (#1909); `within` keeps only those a write's Blocks hold.
 */
export function toCheckRanges(
  state: EditorState,
  skipped: ReadonlySet<string> = new Set(),
  within?: (place: SentencePlace) => boolean,
): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  eachSentence(
    state.doc,
    { claims: shownClaims(state), skipped, kept: keptSpans(state) },
    (place) => {
      if (place.state.kind === "to-check" && (!within || within(place))) {
        ranges.push({ from: place.from, to: place.to });
      }
    },
  );
  return ranges;
}
