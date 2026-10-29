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
  CALCULATED_FIGURE_NODE,
  CHART_NODE,
  CITATION_NODE,
  type CitationAttributes,
  type CitationCheck,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
} from "../../../core/api";
import { chartCheckText, chartPoints, readChart } from "../../../shared/charts";
import {
  type CheckedSentence,
  checkedSentence,
  type KeptMark,
  keptOn,
} from "../../../shared/claimChecks";
import { readFigures } from "../../../shared/figures";
import { memoized } from "../../../shared/memo";
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
 * how many. `toCheck`: every claim no check covers now, `failed` and
 * `recheck` the parts of that count whose check failed or no longer holds;
 * `checking`: the claims a run is checking right now, not done yet;
 * `kept`: the sentences the User keeps as their own view, which count as
 * handled; `tableCells` are the parts of `toCheck` a table holds (#1194);
 * `checkable`: every claim a check reads, to check, checking or covered;
 * `supported`: the covered claims a check found supported, the ones with no
 * Citation among them; `checkedAt`: the newest check among the claims one
 * covers, for "Checked {time}"; `unexamined`: the parts of `toCheck`
 * the last whole-Mind check didn't examine, since no reply said whether they
 * make a claim (#1682).
 */
export interface NoteHealth {
  found: number[];
  notFound: number[];
  /** The covered claims that need a look: contradicted, unsupported, or one of their Citations not found. */
  lookClaims: number[];
  /** The Citations not found on those claims: a reason's count, never a claim's (#1941). */
  lookNotFound: number[];
  unsupported: number[];
  contradicted: number[];
  toCheck: number[];
  failed: number[];
  recheck: number[];
  checking: number[];
  kept: number[];
  tableCells: number[];
  noCitation: number[];
  checkable: number;
  supported: number;
  checkedAt: string | null;
  unexamined: number[];
}

/** A digit or a Chinese numeral: a sentence with neither holds no figure, and isn't read for one. */
const MAY_HOLD_FIGURE = /[\d〇零一二三四五六七八九十百千万亿两]/;

/** Whether a sentence holds a figure, read once while its words stay the same: the health is counted again after every change. */
const holdsFigures = memoized(
  20_000,
  (words: string) => words,
  (words: string) => MAY_HOLD_FIGURE.test(words) && readFigures(words).length > 0,
);

/** Blocks whose text isn't counted. */
const UNCOUNTED: ReadonlySet<string> = new Set(["question", "heading", "codeBlock", "blockMath"]);

/** Words or a node a change adds: not the Mind's until it is accepted. */
const proposed = (node: ProseMirrorNode) =>
  readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE])?.kind === "insert" ||
  node.marks.some((mark) => mark.type.name === PROPOSAL_INSERT_MARK);

/** What each sentence counts with, read the same way from the core and the window. */
export interface SentenceInput {
  claims: readonly ShownClaim[];
  /** The last whole-Mind check found these sentences make no claim, by `sentenceKey`. */
  skipped?: ReadonlySet<string>;
  /** The last whole-Mind check couldn't tell whether these make a claim, by `sentenceKey`. */
  unexamined?: ReadonlySet<string>;
  /** The marks the User keeps as their own view, at their places. */
  kept?: readonly KeptMark[];
}

export interface NoteHealthInput extends SentenceInput {
  citationCheck: (attributes: CitationAttributes) => CitationCheck;
}

/** One sentence a check reads, where it is and how it counts. */
export interface SentencePlace {
  kind?: "chart";
  /** The whole sentence's first and last characters in the document. */
  from: number;
  to: number;
  /** As checks read it: an inline node as U+FFFC, a line break as "\n". */
  text: string;
  claim: ShownClaim | null;
  citations: { attributes: CitationAttributes; at: number; pos: number }[];
  /** Its top-level Block's id: what a write's "Check the rest" scopes itself to (#1909). */
  blockId: unknown;
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
  doc.descendants((node, pos) => {
    if (UNCOUNTED.has(node.type.name) || proposed(node)) return false;
    if (node.type.name === CHART_NODE) {
      const chart = readChart(node.attrs);
      if (chartPoints(chart).length === 0) return false;
      const text = chartCheckText(chart);
      const from = pos;
      const to = pos + node.nodeSize;
      const claim =
        input.claims.find((claim) => claim.kind === "chart" && claim.from === from) ?? null;
      visit({
        kind: "chart",
        from,
        to,
        text,
        claim,
        citations: [],
        blockId: node.attrs[BLOCK_ID_ATTRIBUTE],
        inTable: false,
        state: checkedSentence({
          text,
          hasFigures: true,
          check: claim?.shown ?? null,
          skipped: false,
          kept: keptOn(kept, { from, to, text }),
        }),
      });
      return false;
    }
    if (!node.isTextblock) return true;
    if (node.type.name !== "paragraph") return false;
    const blockId = doc.resolve(pos + 1).node(1).attrs[BLOCK_ID_ATTRIBUTE];
    const { text, starts, ends, inline } = paragraphPlaces(node, pos, proposed);
    const citations = inline.flatMap(({ node: child, at, pos: place }) =>
      child.type.name === CITATION_NODE
        ? [{ attributes: child.attrs as CitationAttributes, at, pos: place }]
        : [],
    );
    const table = inTable(doc, pos);
    const figures = inline.filter(({ node }) => node.type.name === CALCULATED_FIGURE_NODE);
    for (const span of sentenceSpans(
      text,
      figures.map(({ at }) => at),
    )) {
      const from = starts[span.from] ?? pos;
      const to = ends[span.to - 1] ?? from;
      const claim = input.claims.find((each) => each.from < to && each.to > from) ?? null;
      const words = text.slice(span.from, span.to);
      const state = checkedSentence({
        text: words,
        hasFigures:
          figures.some(({ at }) => at >= span.from && at < span.to) || holdsFigures(words),
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
    lookClaims: [],
    lookNotFound: [],
    unsupported: [],
    contradicted: [],
    toCheck: [],
    failed: [],
    recheck: [],
    checking: [],
    kept: [],
    tableCells: [],
    noCitation: [],
    checkable: 0,
    supported: 0,
    checkedAt: null,
    unexamined: [],
  };
  const unexamined = input.unexamined ?? new Set<string>();
  eachSentence(doc, input, ({ from, text, claim, citations, inTable: table, state, kind }) => {
    const missing: number[] = [];
    for (const citation of citations) {
      const check = input.citationCheck(citation.attributes);
      if (check === "found") health.found.push(citation.pos);
      else if (check === "not-found") {
        health.notFound.push(citation.pos);
        missing.push(citation.pos);
      }
    }
    if (state.kind === "to-check") {
      health.checkable++;
      health.toCheck.push(from);
      if (state.why === "failed") health.failed.push(from);
      else if (state.why === "recheck") health.recheck.push(from);
      if (state.fresh && unexamined.has(sentenceKey(text))) health.unexamined.push(from);
      if (table) health.tableCells.push(from);
      return;
    }
    if (state.kind === "kept") {
      health.kept.push(from);
      return;
    }
    if (state.kind === "checking") {
      health.checkable++;
      health.checking.push(from);
      return;
    }
    if (state.kind !== "covered" || !claim) return;
    health.checkable++;
    const checkedAt = claim.check.checkedAt;
    if (
      checkedAt !== "" &&
      !Number.isNaN(Date.parse(checkedAt)) &&
      (health.checkedAt === null || Date.parse(checkedAt) > Date.parse(health.checkedAt))
    ) {
      health.checkedAt = checkedAt;
    }
    const unsupported = claim.shown.state === "unsupported";
    const contradicted = claim.shown.state === "contradicted";
    if (unsupported) health.unsupported.push(from);
    else if (contradicted) health.contradicted.push(from);
    else {
      health.supported++;
      if (kind !== "chart" && isClaim(text) && citations.length === 0) health.noCitation.push(from);
    }
    if (unsupported || contradicted || missing.length > 0) {
      health.lookClaims.push(from);
      health.lookNotFound.push(...missing);
    }
  });
  return health;
}

/** What a check found and what is left of a Mind, for the card's one summary line (#1941). */
export interface HealthSummary {
  /** The covered claims a check found supported. */
  supported: number;
  /**
   * What needs a look: the claims, counted once each however many things are wrong with one
   * (D276), and the Citations not found on them, which the reason names separately (#1941).
   */
  look: { claims: number; contradicted: number; unsupported: number; notFound: number };
  /** The claims nothing has checked yet. */
  toCheck: number;
  /** The supported claims that cite nowhere, so they still need a Citation. */
  noCitation: number;
}

/**
 * The card's one summary, counted and decided from the same `NoteHealth` its
 * rows show, so the two can never disagree (#1941): "everything checked" only
 * when nothing is left — no claim that needs a look, none not checked, no
 * supported claim with no Citation, and no file a narrowed check couldn't read
 * (D266) — otherwise what is left, in D276's words. Null while a check runs or
 * a problem shows: the card says that in its place.
 */
export function healthSummary(
  health: NoteHealth,
  { running, problem, unread }: { running: boolean; problem: boolean; unread: number },
): { kind: "all" } | { kind: "left"; summary: HealthSummary } | null {
  if (running || problem || health.checkable === 0 || health.checking.length > 0) return null;
  const summary: HealthSummary = {
    supported: health.supported,
    look: {
      claims: health.lookClaims.length,
      contradicted: health.contradicted.length,
      unsupported: health.unsupported.length,
      notFound: health.lookNotFound.length,
    },
    toCheck: health.toCheck.length,
    noCitation: health.noCitation.length,
  };
  const left = summary.look.claims + summary.toCheck + summary.noCitation;
  if (left > 0) return { kind: "left", summary };
  return unread > 0 ? null : { kind: "all" };
}

/**
 * Every sentence a check reads that no check covers now, where it is and what
 * it cites (#1909); `within` keeps only those a write's Blocks hold.
 */
export function sentencesToCheck(
  state: EditorState,
  skipped: ReadonlySet<string> = new Set(),
  within?: (place: SentencePlace) => boolean,
): SentencePlace[] {
  const places: SentencePlace[] = [];
  eachSentence(
    state.doc,
    { claims: shownClaims(state), skipped, kept: keptSpans(state) },
    (place) => {
      if (place.state.kind === "to-check" && (!within || within(place))) places.push(place);
    },
  );
  return places;
}

/**
 * The whole sentences a check still has to make in this Note, as ranges to
 * check (#1909); `within` keeps only those a write's Blocks hold.
 */
export function toCheckRanges(
  state: EditorState,
  skipped: ReadonlySet<string> = new Set(),
  within?: (place: SentencePlace) => boolean,
): { from: number; to: number }[] {
  return sentencesToCheck(state, skipped, within).map(({ from, to }) => ({ from, to }));
}
