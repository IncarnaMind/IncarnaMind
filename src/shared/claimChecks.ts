/**
 * A sentence's check (#96), as its mark stores it in the Mind
 * (`ClaimCheckAttributes`), read the same way by the core and the editor,
 * and whether it still holds: a check made from text, Documents or a scope
 * that have changed since needs a re-check.
 */
import {
  type CheckedVersion,
  type Citation,
  type CitationAttributes,
  type ClaimCheckAction,
  type ClaimCheckAttributes,
  type ClaimCheckBasis,
  type ClaimCheckFailure,
  type ClaimCheckScope,
  type ClaimVerdict,
  claimCheckActions,
  type FigureCheckAttributes,
  type RecordCiteResult,
  type SearchScope,
  type UnsupportedReason,
  type WholeRead,
} from "../core/api";
import { type RecordCiteNote, shortFormsThrough } from "../core/recordCites/referents";
import { citedInputs } from "./calculatedFigures";
import {
  CLAIM_CHECK_FAILURES,
  checkWithParts,
  keepCheckAsView,
  partCitations,
  readCheckedVersions,
  readClaimCalculation,
  readClaimCorrection,
  readClaimParts,
  readClaimScope,
  readExcludedDocuments,
  readReadDocuments,
  readUnsupportedReason,
  resultFromParts,
} from "./claimParts";
import { aggregateFigureStates, figureProblem, readFigureFinding } from "./figureChecks";
import type { MessageKey } from "./i18n";
import { parseLocation } from "./locations";
import { folderScope, hasSearchScope, sameScope } from "./searchScope";
import { comparableCheckSentence, comparableSentence, isClaim } from "./sentences";

/** The most sentences with Citations one write of the assistant's has checked as it lands (#1111): past it, a long draft would wait minutes and cost dozens of requests. */
export const SENTENCES_CHECKED_AT_MOST = 12;

const STATES: readonly ClaimCheckAttributes["state"][] = [
  "checking",
  "supported",
  "unsupported",
  "contradicted",
  "not-checked",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function readOf(value: unknown): WholeRead | null {
  if (!isRecord(value)) return null;
  const { pages, of } = value;
  return typeof pages === "number" && typeof of === "number" && pages >= 0 && of >= pages
    ? { pages, of }
    : null;
}

/** Where a check looked: the Mind's chosen scope, else its Folder; null for every Document. */
export function checkedScope(scope: ClaimCheckScope): SearchScope | null {
  if (scope.chosen) return scope.chosen;
  return !scope.widened && scope.folderId !== null ? folderScope(scope.folderId) : null;
}

/** Whether a check looked in a scope narrower than all Documents: a Folder, a Tag, or Documents the User picked. */
export const checkSearchedNarrowerThanAll = (scope: ClaimCheckScope): boolean =>
  !scope.widened && checkedScope(scope) !== null;

function recordCitesOf(value: unknown): RecordCiteResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((each) => {
    if (!isRecord(each)) return [];
    const raw = text(each.raw);
    const outcome = [
      "supported",
      "partly",
      "unsupported",
      "choose",
      "not-found",
      "not-checked",
    ].find((known) => known === each.outcome);
    if (!raw || !outcome) return [];
    const location = each.location === undefined ? undefined : parseLocation(each.location);
    if (each.location !== undefined && location === null) return [];
    const nearby = each.nearby;
    const nearbyLocation = isRecord(nearby) ? parseLocation(nearby.location) : null;
    return [
      {
        raw,
        outcome: outcome as RecordCiteResult["outcome"],
        ...(CLAIM_CHECK_FAILURES.find((reason) => reason === each.reason)
          ? { reason: each.reason as ClaimCheckFailure }
          : {}),
        ...(each.detail === null
          ? { detail: null }
          : text(each.detail) !== null
            ? { detail: each.detail as string }
            : {}),
        ...(typeof each.from === "number" && Number.isInteger(each.from) && each.from >= 0
          ? { from: each.from }
          : {}),
        ...(typeof each.to === "number" && Number.isInteger(each.to) && each.to >= 0
          ? { to: each.to }
          : {}),
        ...(text(each.documentId) ? { documentId: text(each.documentId) as string } : {}),
        ...(text(each.documentName) ? { documentName: text(each.documentName) as string } : {}),
        ...(text(each.contentHash) ? { contentHash: text(each.contentHash) as string } : {}),
        ...(location ? { location } : {}),
        ...(typeof each.pageFrom === "number" && Number.isInteger(each.pageFrom)
          ? { pageFrom: each.pageFrom }
          : {}),
        ...(typeof each.pageTo === "number" && Number.isInteger(each.pageTo)
          ? { pageTo: each.pageTo }
          : {}),
        ...(text(each.passage) !== null ? { passage: text(each.passage) as string } : {}),
        ...(text(each.covered) ? { covered: text(each.covered) as string } : {}),
        ...(text(each.uncovered) ? { uncovered: text(each.uncovered) as string } : {}),
        ...(Array.isArray(each.via) && each.via.every((cite) => typeof cite === "string")
          ? { via: each.via as string[] }
          : {}),
        ...(Array.isArray(each.candidates)
          ? {
              candidates: each.candidates.flatMap((candidate) =>
                isRecord(candidate) && text(candidate.id) && text(candidate.name)
                  ? [{ id: candidate.id as string, name: candidate.name as string }]
                  : [],
              ),
            }
          : {}),
        ...(nearbyLocation &&
        isRecord(nearby) &&
        typeof nearby.pageFrom === "number" &&
        typeof nearby.pageTo === "number" &&
        text(nearby.passage) !== null
          ? {
              nearby: {
                location: nearbyLocation,
                pageFrom: nearby.pageFrom as number,
                pageTo: nearby.pageTo as number,
                passage: nearby.passage as string,
              },
            }
          : {}),
      },
    ];
  });
}

/**
 * A check or result with its record cites and the Document versions they read, the one rule for
 * all of them: a Document already listed keeps its version, and each other cited Document is
 * listed once, at the version its first cite read. No part or figure holds these, since record
 * cites are read apart from them (#1709).
 */
export function keepRecordCites<Check extends { versions: CheckedVersion[] }>(
  check: Check,
  recordCites: readonly RecordCiteResult[] | undefined,
): Check & { recordCites?: RecordCiteResult[] } {
  if (!recordCites) return check;
  const versions = new Map(check.versions.map((version) => [version.documentId, version]));
  for (const cite of recordCites) {
    if (cite.documentId && cite.contentHash && !versions.has(cite.documentId))
      versions.set(cite.documentId, { documentId: cite.documentId, contentHash: cite.contentHash });
  }
  return { ...check, recordCites: [...recordCites], versions: [...versions.values()] };
}

/** A check's attributes as a mark holds them, or null when they aren't one's. Unknown values read safely. */
function readCheckBasis(value: unknown): ClaimCheckBasis | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const state = STATES.find((each) => each === value.state);
  if (!id || !state) return null;
  const action: ClaimCheckAction =
    claimCheckActions.find((each) => each === value.action) ?? "find-support";
  const read = readOf(value.read);
  const recordCites = recordCitesOf(value.recordCites);
  const correction = readClaimCorrection(value.correction);
  const check: ClaimCheckAttributes = {
    id,
    request: text(value.request) ?? "",
    action,
    state,
    reason: CLAIM_CHECK_FAILURES.find((each) => each === value.reason) ?? null,
    detail: text(value.detail),
    providerId: text(value.providerId),
    modelId: text(value.modelId),
    text: text(value.text) ?? "",
    evidence: isRecord(value.evidence) ? (value.evidence as unknown as CitationAttributes) : null,
    ...(state === "contradicted" && correction && { correction }),
    says: text(value.says),
    unsupported: readUnsupportedReason(value.unsupported),
    calculation: readClaimCalculation(value.calculation),
    citedCaseUnchecked: value.citedCaseUnchecked === true,
    citedCaseFound: value.citedCaseFound === true,
    scope: readClaimScope(value.scope),
    versions: readCheckedVersions(value.versions),
    excluded: readExcludedDocuments(value.excluded),
    ...(value.readDocuments !== undefined && {
      readDocuments: readReadDocuments(value.readDocuments),
    }),
    ...(recordCites && { recordCites }),
    checkedAt: text(value.checkedAt) ?? "",
    ...(value.kept === true && { kept: true }),
    ...(read && { read }),
  };
  if (value.parts !== undefined && value.parts !== null) {
    const parts = readClaimParts(value.parts, check.text, check.state);
    check.parts = parts ?? [];
    if (parts === null) {
      check.state = "not-checked";
      check.reason = "malformed";
      check.detail = null;
    } else if (check.state !== "checking") {
      const result = resultFromParts(parts);
      delete check.correction;
      check.parts = result.parts ?? [];
      check.state = result.verdict;
      check.versions = keepRecordCites(
        { ...check, versions: result.versions },
        recordCites,
      ).versions;
      check.excluded = result.excluded;
      if (result.verdict === "not-checked") {
        check.reason = result.reason;
        check.detail = result.detail;
      } else {
        check.reason = null;
        check.detail = null;
        check.evidence = result.evidence;
        if (result.correction) check.correction = result.correction;
        check.says = result.says;
        check.unsupported = result.unsupported;
        check.calculation = result.calculation;
        check.citedCaseUnchecked = result.citedCaseUnchecked;
        check.citedCaseFound = result.citedCaseFound;
      }
    }
    if (check.state === "not-checked") {
      check.evidence = null;
      check.says = null;
      check.unsupported = null;
      check.calculation = null;
      check.citedCaseUnchecked = false;
      check.citedCaseFound = false;
    }
  }
  return check;
}

export function readClaimCheck(value: unknown): ClaimCheckAttributes | null {
  const basis = readCheckBasis(value);
  if (!basis || !isRecord(value)) return null;
  if (basis.parts) {
    const { recordCites, ...check } = basis;
    return keepRecordCites(
      check.kept ? keepCheckAsView(check) : checkWithParts(check, check.parts ?? []),
      recordCites,
    );
  }
  const figures: FigureCheckAttributes[] = [];
  if (value.figures != null) {
    if (!Array.isArray(value.figures)) return null;
    const ids = new Set<string>();
    for (const raw of value.figures) {
      const child = readCheckBasis(raw);
      const finding = readFigureFinding(raw);
      if (!child || !finding || ids.has(child.id)) return null;
      ids.add(child.id);
      figures.push({ ...child, ...finding });
    }
  }
  const remainder = value.remainder == null ? value.remainder : readCheckBasis(value.remainder);
  if (value.remainder != null && !remainder) return null;
  return {
    ...basis,
    ...(value.figures != null && { figures }),
    ...(remainder !== undefined && { remainder }),
  };
}

/**
 * Why a check no longer holds: its sentence was edited (an accepted change
 * or a restored Checkpoint edits it too), a Document it read has a new
 * version, one its result rests on was deleted, the Mind moved to another
 * Folder ("scope"), or the Search scope the User set for the Mind changed.
 */
export type RecheckReason =
  | "edited"
  | "new-version"
  | "document-removed"
  | "scope"
  | "search-scope"
  /** Checked before each of its figures was checked with its own source (#1459). */
  | "figures"
  /** What one of its `Id.` or `supra` refers back to reads otherwise now (#1709). */
  | "referent";

/** A check as it shows now; "kept": the User keeps the sentence as their own view, and it shows nothing. */
export type ClaimCheckShown =
  | { state: "checking" }
  | { state: ClaimVerdict }
  | { state: "not-checked"; reason: ClaimCheckFailure }
  | { state: "needs-recheck"; why: RecheckReason }
  | { state: "kept" };

/** What a check is compared with. */
export interface ClaimCheckNow {
  figureContexts?: ReadonlyMap<string, string> | null;
  /** The sentence is a table cell holding figures the one Check checks each with its own source; unknown when absent. */
  figured?: boolean;
  /** The sentence as it reads now: all of the sentences its marked text is in. */
  text: string;
  /** Each live Document's current version, by id; null while they aren't known. */
  versions: ReadonlyMap<string, string> | null;
  /** The Mind's Folder now; null for none. */
  folderId: string | null;
  /** The Search scope the User set for the Mind now (`mindScopeOf`); null for none. */
  scope: SearchScope | null;
  /** The Note the sentence is in, for what its `Id.` and `supra` refer back to now; unknown when absent. */
  note?: RecordCiteNote;
  /** The sentence as the Note holds it, its Citations included, where `text` leaves them out: what its record cites are read in. */
  noteText?(): string;
}

/** Whether a sentence's `Id.` or `supra` refers back through other cites now than when it was checked. */
function referentsMoved(check: ClaimCheckBasis, now: ClaimCheckNow): boolean {
  const checked = (check.recordCites ?? []).flatMap((cite) => (cite.via ? [cite.via] : []));
  if (!now.note || checked.length === 0) return false;
  const current = shortFormsThrough(now.noteText?.() ?? now.text, now.note);
  return (
    current.length !== checked.length ||
    checked.some(
      (via, index) =>
        via.length !== current[index]?.length ||
        via.some((cite, at) => cite !== current[index]?.[at]),
    )
  );
}

function scopeChanged(searched: ClaimCheckScope, now: ClaimCheckNow): boolean {
  const chosen = now.scope && !sameScope(now.scope, folderScope(now.folderId)) ? now.scope : null;
  if (searched.chosen) return !chosen || !sameScope(chosen, searched.chosen);
  return chosen !== null && (hasSearchScope(chosen) || searched.folderId !== null);
}

/**
 * The part of an unsupported sentence a Passage the check quoted states, that
 * quote, and the part it doesn't; null unless the check quoted one.
 */
export function coveredPart(
  why: UnsupportedReason | null,
): { covered: string; uncovered: string; quoted: CitationAttributes; quote: string } | null {
  return why?.covered && why.uncovered && why.quoted?.quote
    ? {
        covered: why.covered,
        uncovered: why.uncovered,
        quoted: why.quoted,
        quote: why.quoted.quote,
      }
    : null;
}

/**
 * Whether nothing in its scope was about an unsupported sentence (#1608): its card is headed Not
 * found and says where it looked, and its Word comment says the same. A Passage the check found
 * makes it Unsupported: one quoted as saying something different or as stating part of it, or one
 * it read and judged (`UnsupportedReason.found`). A sentence with Citations, one citing a court
 * decision no Document holds, and one only the User's own workings state have cards of their own.
 */
export function saysNotFound(
  shown: ClaimCheckShown,
  check: ClaimCheckAttributes,
  citations: number,
): boolean {
  return (
    shown.state === "unsupported" &&
    citations === 0 &&
    check.evidence === null &&
    !check.citedCaseUnchecked &&
    !check.excluded.some((left) => left.reason === "own-workings") &&
    !check.unsupported?.found &&
    coveredPart(check.unsupported) === null
  );
}

function recordEvidence(cite: RecordCiteResult): CitationAttributes | null {
  if (!cite.documentId || !cite.documentName || !cite.location || cite.passage === undefined)
    return null;
  return {
    passageId: null,
    documentId: cite.documentId,
    documentName: cite.documentName,
    contentHash: cite.contentHash ?? null,
    pageFrom: cite.pageFrom ?? null,
    pageTo: cite.pageTo ?? null,
    location: cite.location,
    quote: cite.passage,
    check: "found",
    checkReason: null,
  };
}

/**
 * What a check's result rests on: its evidence, every correction choice's evidence, the Passage
 * quoted for the part of an unsupported sentence it covers, and the quotes a worked-out figure
 * read its numbers from.
 */
export function restsOn(check: ClaimCheckAttributes): (CitationAttributes | Citation)[] {
  const inputs = check.calculation ? citedInputs(check.calculation.figure) : [];
  return [
    check.evidence,
    ...(check.correction?.choices.map((choice) => choice.evidence) ?? []),
    check.unsupported?.quoted ?? null,
    ...inputs.flatMap((input) => [input.citation, input.unitStatement?.citation ?? null]),
    ...(check.recordCites ?? []).flatMap((cite) => [
      recordEvidence(cite),
      cite.nearby
        ? recordEvidence({
            ...cite,
            location: cite.nearby.location,
            pageFrom: cite.nearby.pageFrom,
            pageTo: cite.nearby.pageTo,
            passage: cite.nearby.passage,
          })
        : null,
    ]),
    ...(check.parts?.flatMap(partCitations) ?? []),
    ...(check.figures ?? []).flatMap((figure) => [
      ...restsOn(figure),
      figure.source ?? null,
      figure.sourceInput?.citation ?? null,
      figure.sourceInput?.unitStatement?.citation ?? null,
      ...(figure.calculated?.figure.inputs ?? []).flatMap((input) => [
        input.citation,
        input.unitStatement?.citation ?? null,
      ]),
      ...(figure.sourceFooting ?? []).flatMap((proof) =>
        proof.inputs.flatMap((input) => [input.citation, input.unitStatement?.citation ?? null]),
      ),
    ]),
    ...(check.remainder ? restsOn(check.remainder) : []),
  ].filter((each): each is CitationAttributes | Citation => each !== null);
}

/** How a check shows, given the sentence, the Documents and the Mind's Folder and scope as they are now. */
function basisShown(check: ClaimCheckBasis, now: ClaimCheckNow): ClaimCheckShown {
  if (check.state === "checking") return { state: "checking" };
  if (
    check.parts !== undefined
      ? now.text !== check.text
      : comparableCheckSentence(now.text) !== comparableCheckSentence(check.text)
  ) {
    return { state: "needs-recheck", why: "edited" };
  }
  if (referentsMoved(check, now)) return { state: "needs-recheck", why: "referent" };
  if (check.kept) return { state: "kept" };
  if (now.versions) {
    const relied = new Set([
      ...restsOn(check).map((each) => each.documentId),
      ...(check.readDocuments ?? []).map((each) => each.documentId),
    ]);
    for (const version of check.versions) {
      const current = now.versions.get(version.documentId);
      // A Document only read, gone, takes nothing from the result: an example's, swapped for the interface language, among them (#962).
      if (current === undefined && relied.has(version.documentId)) {
        return { state: "needs-recheck", why: "document-removed" };
      }
      if (current !== undefined && current !== version.contentHash) {
        return { state: "needs-recheck", why: "new-version" };
      }
    }
  }
  if (!check.scope.widened && !check.scope.chosen && check.scope.folderId !== now.folderId) {
    return { state: "needs-recheck", why: "scope" };
  }
  // Contradiction watch looks in the Mind's Folder, and a whole read in the User's pick.
  if (
    !check.scope.widened &&
    check.action !== "contradiction-watch" &&
    check.action !== "check-against-document" &&
    scopeChanged(check.scope, now)
  ) {
    return { state: "needs-recheck", why: "search-scope" };
  }
  if (check.state === "not-checked")
    return { state: "not-checked", reason: check.reason ?? "failed" };
  return { state: check.state };
}

/** A sentence's own record cite that doesn't back it where it points (#1709). */
const RECORD_MISSES: ReadonlySet<RecordCiteResult["outcome"]> = new Set([
  "unsupported",
  "not-found",
  "choose",
]);

/**
 * What a check's margin glyph shows: its sentence's state, but Unsupported rather than Supported
 * while one of the sentence's own record cites is Unsupported, Not found or Choose (#1709).
 */
export function claimMarkState<State extends ClaimCheckShown["state"]>(
  state: State,
  check: Pick<ClaimCheckAttributes, "recordCites">,
): State | "unsupported" {
  return state === "supported" &&
    (check.recordCites ?? []).some((cite) => RECORD_MISSES.has(cite.outcome))
    ? "unsupported"
    : state;
}

export function claimCheckShown(check: ClaimCheckAttributes, now: ClaimCheckNow): ClaimCheckShown {
  if (!check.figures?.length || check.kept) {
    const shown = basisShown(check, now);
    // A verdict stored before each figure got its own never read a table cell's row and column,
    // so a right cell could stand as Unsupported (#1459): it is checked again, not kept.
    return now.figured === true &&
      check.action === "check-against-documents" &&
      (shown.state === "supported" ||
        shown.state === "unsupported" ||
        shown.state === "contradicted")
      ? { state: "needs-recheck", why: "figures" }
      : shown;
  }
  if (
    comparableCheckSentence(now.text) === comparableCheckSentence(check.text) &&
    referentsMoved(check, now)
  ) {
    return { state: "needs-recheck", why: "referent" };
  }
  const figures = check.figures.map((figure) => figureCheckShown(figure, now));
  return aggregateFigureStates(
    figures,
    check.remainder === null
      ? null
      : check.remainder
        ? basisShown(check.remainder, now)
        : undefined,
  );
}

export function figureCheckShown(
  figure: FigureCheckAttributes,
  now: ClaimCheckNow,
): ClaimCheckShown {
  const shown = basisShown(figure, now);
  // Unknown contexts (null) are a reader that hasn't read them yet, not a change to them.
  if (
    shown.state !== "kept" &&
    shown.state !== "checking" &&
    figure.context !== undefined &&
    now.figureContexts != null &&
    now.figureContexts.get(figure.id) !== figure.context
  )
    return { state: "needs-recheck", why: "edited" };
  return shown.state !== "kept" &&
    shown.state !== "needs-recheck" &&
    shown.state !== "contradicted" &&
    figureProblem(figure) !== null
    ? { state: "unsupported" }
    : shown;
}

/**
 * Whether Documents added to its scope since could change a check (#993): one
 * found unsupported or not checked. A supported or contradicted one already
 * has its evidence, contradiction watch makes its own checks again, and a
 * whole read covered only the User's pick.
 */
export const addedCouldChange = (check: ClaimCheckAttributes, shown: ClaimCheckShown): boolean =>
  check.action !== "contradiction-watch" &&
  check.action !== "check-against-document" &&
  check.checkedAt !== "" &&
  (shown.state === "unsupported" ||
    shown.state === "not-checked" ||
    (shown.state === "supported" && (check.readDocuments?.length ?? 0) > 0));

/**
 * A sentence as every surface counts it (#1909): a claim no check covers now
 * is "to check", whether it has no check at all, one that failed, or one that
 * no longer holds; a verdict that holds covers it; a sentence the User keeps
 * as their own view, one the last whole-Mind check found makes no claim, and
 * one that makes no claim count as nothing.
 */
export type CheckedSentence =
  | { kind: "covered" }
  | { kind: "checking" }
  | { kind: "to-check"; fresh: boolean; why: "none" | "failed" | "recheck" }
  | { kind: "kept" }
  | { kind: "not-claim" };

/** A kept mark's place and the words it was made on. */
export interface KeptMark {
  from: number;
  to: number;
  text: string;
}

/**
 * Whether a sentence is at a kept mark's place (#1909): the one rule the core
 * and the window read, so a kept sentence elsewhere with the same words
 * doesn't hide the margin's mark on this one.
 */
export function keptOn(
  kept: readonly KeptMark[],
  sentence: { from: number; to: number; text: string },
): boolean {
  const words = comparableSentence(sentence.text);
  return kept.some(
    (mark) =>
      mark.from < sentence.to && mark.to > sentence.from && comparableSentence(mark.text) === words,
  );
}

export function checkedSentence(input: {
  text: string;
  hasFigures?: boolean;
  /** How its check shows now; null for none. */
  check: ClaimCheckShown | null;
  /** The last whole-Mind check found it makes no claim. */
  skipped: boolean;
  /** A kept mark is at this sentence's place. */
  kept: boolean;
}): CheckedSentence {
  // A check that shows decides first: a verdict on a figure or a short line is still a verdict (#1909).
  if (input.check) {
    switch (input.check.state) {
      case "kept":
        return { kind: "kept" };
      case "checking":
        return { kind: "checking" };
      case "supported":
      case "unsupported":
      case "contradicted":
        return { kind: "covered" };
      case "not-checked":
        return { kind: "to-check", fresh: false, why: "failed" };
      case "needs-recheck":
        return { kind: "to-check", fresh: false, why: "recheck" };
    }
  }
  if (input.kept) return { kind: "kept" };
  if (input.skipped || (!input.hasFigures && !isClaim(input.text))) return { kind: "not-claim" };
  return { kind: "to-check", fresh: true, why: "none" };
}

/** How many of these sentences a check still has to make: the one count (#1909). */
export function toCheckCount(sentences: Iterable<CheckedSentence>): number {
  let count = 0;
  for (const sentence of sentences) if (sentence.kind === "to-check") count++;
  return count;
}

/**
 * A sentence's check as a record lists it: the counts' keys (`needsRecheck` is a Document or the
 * scope that changed), and "changed" once its words were edited. Null while it is still checking,
 * and for a sentence the User keeps as their own view.
 */
export type SentenceResult =
  | "supported"
  | "unsupported"
  | "notFound"
  | "contradicted"
  | "needsRecheck"
  | "notChecked"
  | "changed";

/** Each result's words: the check record and the AI use statement say one result's name the same way. */
export const SENTENCE_RESULT_LABELS: Readonly<Record<SentenceResult, MessageKey>> = {
  supported: "aiStatement.sentences.supported",
  contradicted: "aiStatement.sentences.contradicted",
  notFound: "aiStatement.sentences.notFound",
  unsupported: "aiStatement.sentences.unsupported",
  needsRecheck: "aiStatement.sentences.recheck",
  notChecked: "aiStatement.sentences.notChecked",
  changed: "aiStatement.sentences.changed",
};

/**
 * A sentence's result, as the record and the AI use statement count it: Not found apart from
 * Unsupported by the card's own rule (`saysNotFound`), so an unsupported sentence the check
 * found no Passage for is never counted as one it did.
 */
export function sentenceResultOf(
  shown: ClaimCheckShown,
  check: ClaimCheckAttributes,
  citations: number,
): SentenceResult | null {
  switch (shown.state) {
    case "checking":
    case "kept":
      return null;
    case "needs-recheck":
      return shown.why === "edited" ? "changed" : "needsRecheck";
    case "not-checked":
      return "notChecked";
    case "unsupported":
      return saysNotFound(shown, check, citations) ? "notFound" : "unsupported";
    default:
      return shown.state;
  }
}
