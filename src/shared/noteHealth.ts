/**
 * A Note's health, counted one sentence at a time (#96, #1909): the one rule the page's badge and
 * check card count by, and the one an outside agent's check reply counts by (#3453), so what an
 * agent says of a Note is what its page shows. `countSentence` adds a sentence to a `NoteHealth`;
 * `checkRows` sorts the whole into the card's rows. The window walks its document for the
 * sentences; the core has them from the Note's checks.
 */
import type { CitationAttributes, CitationCheck, ClaimCheckAttributes } from "../core/api";
import { type AnalysisTableShown, columnEarns, tableNeedsLook } from "./analysisTables";
import {
  type CheckedSentence,
  type ClaimCheckShown,
  canBeCited,
  cantBeChecked,
  claimMarkState,
  foundElsewhere,
  supportedByOwnNotesOnly,
} from "./claimChecks";
import { ANALYSIS_REASONS } from "./figureChecks";
import { sentenceKey } from "./mindCheck";
import { isClaim } from "./sentences";

/**
 * Where each part's sentences or Citations are, top to bottom: its count is
 * how many. `toCheck`: every claim no check covers now, `failed` and
 * `recheck` the parts of that count whose check failed or no longer holds,
 * `uncheckable` the failed ones a re-run cannot settle and `edited` the
 * rechecks a change to a sentence that had run made;
 * `checking`: the claims a run is checking right now, not done yet;
 * `kept`: the sentences the User keeps as written, and `keptCharts` the
 * charts they keep as their view, which count as handled; `tableCells` are the parts of `toCheck` a table holds (#1194);
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
  keptCharts: number[];
  tableCells: number[];
  noCitation: number[];
  /** The supported claims whose only evidence is one of the User's own notes (#335). */
  ownNotes: number[];
  /** The covered claims a check found supported with none of their Citations not found: no look needed (#2831). */
  supportedAt: number[];
  /**
   * The claims Supported, not yet cited (#3019): a model checked them and its ✓ shows once the
   * Passage it found is their Citation. Counted apart: never supported, never to check.
   */
  notYetCited: number[];
  /**
   * The supported claims with a Passage their check found that no Citation of theirs is on yet
   * (#3358): they count among the supported, and the card offers them with the ones above.
   */
  citable: number[];
  /** The sentences the check found to be their writer's own view (#3322): checked, never a look. */
  ownViews: number[];
  checkable: number;
  supported: number;
  checkedAt: string | null;
  unexamined: number[];
}

/** A check that landed a verdict: an edit of its sentence is a re-check, not an upgrade of one that never ran. */
const RAN: ReadonlySet<string> = new Set(["supported", "unsupported", "contradicted"]);

/** A sentence's check as counting reads it: the window's `ShownClaim` and the core's marks both fit. */
export interface CountedClaim {
  kind?: "chart";
  shown: ClaimCheckShown;
  check: ClaimCheckAttributes;
  holdsWithItsText?: boolean;
}

/** One sentence a check reads, as it counts. */
export interface CountedSentence {
  kind?: "chart";
  /** Where it is, which is how a row lists it: its first character in the window, its number in the core. */
  from: number;
  /** As checks read it: an inline node as U+FFFC, a line break as "\n". */
  text: string;
  claim: CountedClaim | null;
  /** Its Citations, each with how its quote reads now. */
  citations: readonly {
    attributes: Partial<CitationAttributes>;
    pos: number;
    check: CitationCheck;
  }[];
  /** It is in a table cell. */
  inTable: boolean;
  state: CheckedSentence;
}

export const emptyHealth = (): NoteHealth => ({
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
  keptCharts: [],
  tableCells: [],
  noCitation: [],
  ownNotes: [],
  supportedAt: [],
  notYetCited: [],
  citable: [],
  ownViews: [],
  checkable: 0,
  supported: 0,
  checkedAt: null,
  unexamined: [],
});

/** Adds a sentence to the health: what its check found and where it counts. */
export function countSentence(
  health: NoteHealth,
  { from, text, claim, citations, inTable: table, state, kind }: CountedSentence,
  unexamined: ReadonlySet<string> = new Set(),
): void {
  const checkedAt = (at: string) => {
    if (
      at !== "" &&
      !Number.isNaN(Date.parse(at)) &&
      (health.checkedAt === null || Date.parse(at) > Date.parse(health.checkedAt))
    )
      health.checkedAt = at;
  };
  const missing: number[] = [];
  for (const citation of citations) {
    const { check } = citation;
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
  if (claim && foundElsewhere(claim)) {
    health.checkable++;
    checkedAt(claim.check.checkedAt);
    if (!lookFor(true)) health.notYetCited.push(from);
    return;
  }
  // Counted as its opinion left out is (#3019): it neither holds the badge back nor counts
  // among the supported.
  if (claim?.shown.state === "not-checked" && claim.shown.reason === "assistant-conclusion") {
    health.checkable++;
    checkedAt(claim.check.checkedAt);
    lookFor(true);
    return;
  }
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
    if (!lookFor(false)) (kind === "chart" ? health.keptCharts : health.kept).push(from);
    return;
  }
  if (state.kind !== "covered" || !claim) {
    lookFor(false);
    return;
  }
  health.checkable++;
  checkedAt(claim.check.checkedAt);
  if (claim.shown.state === "own-view") {
    if (!lookFor(true)) health.ownViews.push(from);
    return;
  }
  const unsupported = claimMarkState(claim.shown.state, claim.check) === "unsupported";
  const contradicted = claim.shown.state === "contradicted";
  if (unsupported) health.unsupported.push(from);
  else if (contradicted) health.contradicted.push(from);
  else {
    health.supported++;
    if (missing.length === 0) health.supportedAt.push(from);
    if (kind !== "chart" && supportedByOwnNotesOnly(claim.check)) health.ownNotes.push(from);
    if (kind !== "chart" && isClaim(text) && citations.length === 0) health.noCitation.push(from);
    if (
      missing.length === 0 &&
      canBeCited(
        claim,
        citations.map((each) => each.attributes),
      )
    )
      health.citable.push(from);
  }
  if (unsupported || contradicted) {
    health.lookClaims.push(from);
    health.lookNotFound.push(...missing);
  } else lookFor(true);
}

/** Adds an Analysis's own table to the health (#2378): one look, one supported, or each column not recalculated. */
export function countTable(health: NoteHealth, from: number, shown: AnalysisTableShown): void {
  const { kind } = shown.state;
  if (kind === "kept-inside" || kind === "unavailable") return;
  health.checkable++;
  if (tableNeedsLook(shown)) {
    health.lookClaims.push(from);
    return;
  }
  const unearned = shown.columns.filter((column) => !columnEarns(column)).length;
  if (shown.columns.length > unearned) {
    health.supported++;
    health.supportedAt.push(from);
  }
  for (let at = 0; at < unearned; at++) {
    health.toCheck.push(from);
    health.failed.push(from);
    health.notRecalculated.push(from);
  }
}

/**
 * The check card's rows (#2831): its sentences, each in one row by its one state, so the rows add
 * up to the sentences a check reads. What needs a look (unsupported, contradicted, or a Citation
 * not found: its own card says which), what is supported, with the ones only the User's own notes
 * back named under it (`ownNotes`, of the supported), what can be cited: Supported, not yet cited
 * (#3019), and supported with a Passage to add (#3358),
 * what is its writer's own view (#3322), what is being checked and what isn't checked, the
 * sentences the last whole check couldn't sort among them (named on that check's line too). Each
 * counts once, in its worst state: needs a look, then not checked, then supported, so an Analysis
 * table with a column not recalculated is one not checked. Rows with none are left out.
 */
export const CHECK_ROWS = [
  "look",
  "supported",
  "ownNotes",
  "notYetCited",
  "ownViews",
  "checking",
  "toCheck",
  "cantCheck",
] as const;
export type CheckRow = (typeof CHECK_ROWS)[number];

export function checkRows(health: NoteHealth): { row: CheckRow; places: readonly number[] }[] {
  const look = new Set(health.lookClaims);
  const distinct = [...new Set(health.toCheck)].filter((pos) => !look.has(pos));
  const notChecked = new Set(distinct);
  // A table is counted per column not recalculated, as the badge and the table's own card count it
  // (#3212): its place stands once for each.
  const columns = new Map<number, number>();
  for (const pos of health.notRecalculated) columns.set(pos, (columns.get(pos) ?? 0) + 1);
  // Split what waits for Check ("not checked yet") from what a check read and can't settle (#3270).
  const unsettled = new Set([...health.uncheckable, ...health.notRecalculated]);
  const toCheck: number[] = [];
  const cantCheck: number[] = [];
  for (const pos of distinct) {
    if (unsettled.has(pos)) {
      const repeats = Math.max(1, columns.get(pos) ?? 0);
      for (let at = 0; at < repeats; at++) cantCheck.push(pos);
    } else {
      toCheck.push(pos);
    }
  }
  const citable = new Set(health.citable);
  const supportedAt = health.supportedAt.filter(
    (pos) => !look.has(pos) && !notChecked.has(pos) && !citable.has(pos),
  );
  const supported = new Set(supportedAt);
  const places: Record<CheckRow, readonly number[]> = {
    look: health.lookClaims,
    supported: supportedAt,
    ownNotes: health.ownNotes.filter((pos) => supported.has(pos)),
    notYetCited: [...health.notYetCited, ...health.citable].sort((a, b) => a - b),
    ownViews: health.ownViews,
    checking: health.checking,
    toCheck,
    cantCheck,
  };
  return CHECK_ROWS.flatMap((row) =>
    places[row].length > 0 ? [{ row, places: places[row] }] : [],
  );
}

/**
 * The row of the card that counts one sentence, by the rule the page counts all of them by; null
 * when no row does, as for the assistant's own conclusion.
 */
export function checkRowOf(sentence: CountedSentence): CheckRow | null {
  const health = emptyHealth();
  countSentence(health, sentence);
  // `ownNotes` lists a supported sentence a second time, under `supported`.
  return checkRows(health).find(({ row }) => row !== "ownNotes")?.row ?? null;
}
