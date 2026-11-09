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
  ANALYSIS_TABLE_ATTRIBUTE,
  ANALYSIS_TABLE_NODE,
  CALCULATED_FIGURE_NODE,
  CHART_NODE,
  CITATION_NODE,
  type CitationAttributes,
  type CitationCheck,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
} from "../../../core/api";
import {
  type AnalysisTableShown,
  columnEarns,
  tableNeedsLook,
} from "../../../shared/analysisTables";
import {
  chartCheckText,
  chartPoints,
  fromAnalysisOnly,
  givesValue,
  gridOfTable,
  readChart,
  type SourceGrid,
} from "../../../shared/charts";
import {
  type CheckedSentence,
  cantBeChecked,
  checkedSentence,
  type KeptMark,
  keptOn,
  supportedByOwnNotesOnly,
} from "../../../shared/claimChecks";
import { ANALYSIS_REASONS } from "../../../shared/figureChecks";
import { readTableBinding } from "../../../shared/figureRuns";
import { readFigures } from "../../../shared/figures";
import { memoized } from "../../../shared/memo";
import { sentenceKey } from "../../../shared/mindCheck";
import { readProposalAttribute } from "../../../shared/proposals";
import { INLINE_NODE, isClaim, onlyNamesItsTable } from "../../../shared/sentences";
import { claimPlaces, keptSpans, markOf, type ShownClaim, shownClaims } from "./claimChecks";
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
 * `recheck` the parts of that count whose check failed or no longer holds,
 * `uncheckable` the failed ones a re-run cannot settle and `edited` the
 * rechecks a change to a sentence that had run made;
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
  /**
   * The sentences that need a look: a covered claim contradicted or unsupported, or any sentence
   * one of whose Citations isn't found, whatever its state, except while it is checked (#2831).
   */
  lookClaims: number[];
  /** The Citations not found on those sentences: a reason's count, never a sentence's (#1941). */
  lookNotFound: number[];
  unsupported: number[];
  contradicted: number[];
  toCheck: number[];
  failed: number[];
  /** The failed checks running again cannot settle: a Citation kept inside another Folder. */
  uncheckable: number[];
  /**
   * The sentences whose figure an Analysis gave and IncarnaMind couldn't work out again (#2378):
   * no check can change them, so they never hold the Note back from Checked.
   */
  notRecalculated: number[];
  recheck: number[];
  /** The rechecks a change to their sentence made, which a check of it can settle. */
  edited: number[];
  checking: number[];
  kept: number[];
  tableCells: number[];
  noCitation: number[];
  /** The supported claims whose only evidence is one of the User's own notes (#335). */
  ownNotes: number[];
  /** The covered claims a check found supported with none of their Citations not found: no look needed (#2831). */
  supportedAt: number[];
  checkable: number;
  supported: number;
  checkedAt: string | null;
  unexamined: number[];
}

/** A check that landed a verdict: an edit of its sentence is a re-check, not an upgrade of one that never ran. */
const RAN: ReadonlySet<string> = new Set(["supported", "unsupported", "contradicted"]);

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
  omitted?: readonly KeptMark[];
  /** Whether the Note keeps the run a bound table names; one it lost is counted as a typed table. */
  tableKept?: (table: ProseMirrorNode) => boolean;
}

export interface NoteHealthInput extends SentenceInput {
  citationCheck: (attributes: CitationAttributes) => CitationCheck;
  /**
   * What an Analysis's own table shows (#2378): it needs a look once, as one figure; a column not
   * recalculated counts as one figure not recalculated; one worked out again is a verdict earned.
   */
  tableShown?: (table: ProseMirrorNode) => AnalysisTableShown | null;
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

/** Each table's grid, read once while the table stays the same. */
const grids = new WeakMap<ProseMirrorNode, SourceGrid>();

/** Whether the paragraph at `pos` is in a table's value cell (`givesValue`), as the core reads it. */
function inValueCell(doc: ProseMirrorNode, pos: number): boolean {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth - 2; depth > 0; depth--) {
    const table = $pos.node(depth);
    if (table.type.name !== "table") continue;
    const grid = grids.get(table) ?? gridOfTable(table.toJSON());
    grids.set(table, grid);
    return givesValue(grid, $pos.index(depth), $pos.index(depth + 1));
  }
  return false;
}

/** A line's text as the core's check reads it: an inline node as U+FFFC, a line break as "\n". */
const lineText = (paragraph: ProseMirrorNode): string =>
  paragraph.textBetween(0, paragraph.content.size, "\n", (leaf) =>
    leaf.type.name === "hardBreak" ? "\n" : INLINE_NODE,
  );

const holdsTableMarker = (paragraph: ProseMirrorNode): boolean => {
  let holds = false;
  paragraph.forEach((child) => {
    if (child.type.name === ANALYSIS_TABLE_NODE) holds = true;
  });
  return holds;
};

function eachSentence(
  doc: ProseMirrorNode,
  input: SentenceInput,
  visit: (place: SentencePlace) => void,
  visitTable?: (table: ProseMirrorNode, pos: number) => void,
): void {
  const skipped = input.skipped ?? new Set<string>();
  const kept = input.kept ?? [];
  doc.descendants((node, pos) => {
    if (UNCOUNTED.has(node.type.name) || proposed(node)) return false;
    // An Analysis's own table and its caption are its run's, never sentences to check (#2378).
    if (
      node.type.name === "table" &&
      readTableBinding(node.attrs[ANALYSIS_TABLE_ATTRIBUTE]) &&
      (input.tableKept?.(node) ?? true)
    ) {
      visitTable?.(node, pos);
      return false;
    }
    if (
      node.type.name === "paragraph" &&
      holdsTableMarker(node) &&
      onlyNamesItsTable(lineText(node))
    )
      return false;
    if (node.type.name === CHART_NODE) {
      const chart = readChart(node.attrs);
      if (chartPoints(chart).length === 0 || fromAnalysisOnly(chart)) return false;
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
    const { sentences, inline } = claimPlaces(node, pos, proposed);
    const citations = inline.flatMap(({ node: child, at, pos: place }) =>
      child.type.name === CITATION_NODE
        ? [{ attributes: child.attrs as CitationAttributes, at, pos: place }]
        : [],
    );
    const table = inTable(doc, pos);
    const value = table && inValueCell(doc, pos);
    const figures = inline.filter(({ node }) => node.type.name === CALCULATED_FIGURE_NODE);
    for (const span of sentences) {
      const { from, to } = span;
      const claim = input.claims.find((each) => each.from < to && each.to > from) ?? null;
      const words = span.text;
      const hasFigures =
        figures.some(({ at }) => at >= span.start && at < span.end) || holdsFigures(words);
      const state = checkedSentence({
        text: words,
        hasFigures,
        check: claim?.shown ?? null,
        // As the core sends it: a value cell's figure is never left out by another sentence's words.
        skipped:
          (skipped.has(sentenceKey(words)) && !(value && hasFigures)) ||
          keptOn(input.omitted ?? [], { from, to, text: words }),
        kept: keptOn(kept, { from, to, text: words }),
      });
      visit({
        from,
        to,
        text: words,
        claim,
        citations: citations.filter((each) => each.pos >= from && each.pos < to),
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
    uncheckable: [],
    notRecalculated: [],
    recheck: [],
    edited: [],
    checking: [],
    kept: [],
    tableCells: [],
    noCitation: [],
    ownNotes: [],
    supportedAt: [],
    checkable: 0,
    supported: 0,
    checkedAt: null,
    unexamined: [],
  };
  const unexamined = input.unexamined ?? new Set<string>();
  eachSentence(
    doc,
    input,
    ({ from, text, claim, citations, inTable: table, state, kind }) => {
      const missing: number[] = [];
      for (const citation of citations) {
        const check = input.citationCheck(citation.attributes);
        if (check === "found") health.found.push(citation.pos);
        else if (check === "not-found") {
          health.notFound.push(citation.pos);
          missing.push(citation.pos);
        }
      }
      // A Citation whose quoted words aren't found puts its sentence under needs a look, whatever
      // the sentence's state, except while it is being checked (#2831).
      const lookFor = (counted: boolean) => {
        if (missing.length === 0) return false;
        if (!counted) health.checkable++;
        health.lookClaims.push(from);
        health.lookNotFound.push(...missing);
        return true;
      };
      if (state.kind === "to-check") {
        health.checkable++;
        lookFor(true);
        health.toCheck.push(from);
        if (state.why === "failed") {
          health.failed.push(from);
          if (claim && cantBeChecked(claim.shown)) health.uncheckable.push(from);
          if (claim?.shown.state === "not-checked" && ANALYSIS_REASONS.has(claim.shown.reason))
            health.notRecalculated.push(from);
        } else if (state.why === "recheck") {
          health.recheck.push(from);
          // An edit marks a check that ran and would still hold with its own words; one that never
          // ran, or whose Document changed since, stays Not checked in the headline (#2313).
          if (
            claim?.shown.state === "needs-recheck" &&
            claim.shown.why === "edited" &&
            RAN.has(claim.check.state) &&
            claim.holdsWithItsText === true
          )
            health.edited.push(from);
        }
        if (state.fresh && unexamined.has(sentenceKey(text))) health.unexamined.push(from);
        if (table) health.tableCells.push(from);
        return;
      }
      if (state.kind === "checking") {
        health.checkable++;
        health.checking.push(from);
        return;
      }
      if (state.kind === "kept") {
        if (!lookFor(false)) health.kept.push(from);
        return;
      }
      if (state.kind !== "covered" || !claim) {
        lookFor(false);
        return;
      }
      health.checkable++;
      const checkedAt = claim.check.checkedAt;
      if (
        checkedAt !== "" &&
        !Number.isNaN(Date.parse(checkedAt)) &&
        (health.checkedAt === null || Date.parse(checkedAt) > Date.parse(health.checkedAt))
      ) {
        health.checkedAt = checkedAt;
      }
      const unsupported = markOf(claim) === "unsupported";
      const contradicted = claim.shown.state === "contradicted";
      if (unsupported) health.unsupported.push(from);
      else if (contradicted) health.contradicted.push(from);
      else {
        health.supported++;
        if (missing.length === 0) health.supportedAt.push(from);
        if (kind !== "chart" && supportedByOwnNotesOnly(claim.check)) health.ownNotes.push(from);
        if (kind !== "chart" && isClaim(text) && citations.length === 0)
          health.noCitation.push(from);
      }
      if (unsupported || contradicted) {
        health.lookClaims.push(from);
        health.lookNotFound.push(...missing);
      } else lookFor(true);
    },
    (table, pos) => {
      const shown = input.tableShown?.(table);
      if (!shown) return;
      const { kind } = shown.state;
      if (kind === "kept-inside" || kind === "unavailable") return;
      health.checkable++;
      if (tableNeedsLook(shown)) {
        health.lookClaims.push(pos);
        return;
      }
      const unearned = shown.columns.filter((column) => !columnEarns(column)).length;
      if (shown.columns.length > unearned) {
        health.supported++;
        health.supportedAt.push(pos);
      }
      // A table counts once, however many of its columns weren't recalculated (#2313).
      if (unearned > 0) {
        health.toCheck.push(pos);
        health.failed.push(pos);
        health.notRecalculated.push(pos);
      }
    },
  );
  health.lookClaims.sort((a, b) => a - b);
  return health;
}

/**
 * The check card's rows (#2831): its sentences, each in one row by its one state, so the rows add
 * up to the sentences a check reads. What needs a look (unsupported, contradicted, or a Citation
 * not found: its own card says which), what is supported, with the ones only the User's own notes
 * back named under it (`ownNotes`, of the supported), what is being checked, what a check
 * couldn't settle (`cantCheck`, its reason in each sentence's own card, #2313) and what isn't
 * checked, the sentences the last whole check couldn't sort among them (named on that check's
 * line too). Each counts once, in its worst state: needs a look, then not checked, then
 * supported, so an Analysis table with a column not recalculated is one not checked. Rows with
 * none are left out.
 */
export const CHECK_ROWS = [
  "look",
  "supported",
  "ownNotes",
  "checking",
  "cantCheck",
  "toCheck",
] as const;
export type CheckRow = (typeof CHECK_ROWS)[number];

export function checkRows(health: NoteHealth): { row: CheckRow; places: readonly number[] }[] {
  const look = new Set(health.lookClaims);
  const recalculated = new Set(health.notRecalculated);
  const cantCheck = [...new Set(health.failed)].filter(
    (pos) => !look.has(pos) && !recalculated.has(pos),
  );
  const cant = new Set(cantCheck);
  const toCheck = [...new Set(health.toCheck)].filter((pos) => !look.has(pos) && !cant.has(pos));
  const notChecked = new Set(toCheck);
  const supportedAt = health.supportedAt.filter((pos) => !look.has(pos) && !notChecked.has(pos));
  const supported = new Set(supportedAt);
  const places: Record<CheckRow, readonly number[]> = {
    look: health.lookClaims,
    supported: supportedAt,
    ownNotes: health.ownNotes.filter((pos) => supported.has(pos)),
    checking: health.checking,
    cantCheck,
    toCheck,
  };
  return CHECK_ROWS.flatMap((row) =>
    places[row].length > 0 ? [{ row, places: places[row] }] : [],
  );
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
 * when nothing is left — no sentence that needs a look, none not checked, and
 * no file a narrowed check couldn't read (#1915). A supported sentence with no
 * Citation counts as done (#2831). Null while a check runs or a problem shows:
 * the card says that in its place.
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
  // A supported sentence counts as done: finding a Citation for it is the check's job (#2831).
  const left = summary.look.claims + summary.toCheck;
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
  omitted: readonly KeptMark[] = [],
): SentencePlace[] {
  const places: SentencePlace[] = [];
  eachSentence(
    state.doc,
    { claims: shownClaims(state), skipped, kept: keptSpans(state), omitted },
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
  omitted: readonly KeptMark[] = [],
): { from: number; to: number }[] {
  return sentencesToCheck(state, skipped, within, omitted).map(({ from, to }) => ({ from, to }));
}
