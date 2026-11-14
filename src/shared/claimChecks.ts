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
  type ClaimCheckPart,
  type ClaimCheckScope,
  type ClaimReadDocument,
  type ClaimVerdict,
  claimCheckActions,
  type FigureCheckAttributes,
  type FigureFootingNow,
  type RecordCiteResult,
  type RetainedFigureAnalysis,
  type SearchScope,
  type UnsupportedReason,
  type WholeRead,
} from "../core/api";
import { type RecordCiteNote, shortFormsThrough } from "../core/recordCites/referents";
import { citedInputs } from "./calculatedFigures";
import { asCitedNow, type HeldCitation } from "./citedNow";
import {
  CLAIM_CHECK_FAILURES,
  checkWithParts,
  keepCheckAsView,
  leftOutByAssistant,
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
import { readLibraryVersion } from "./libraryFacts";
import { parseLocation } from "./locations";
import { folderScope, hasSearchScope, sameScope } from "./searchScope";
import { comparableCheckSentence, comparableSentence, isClaim } from "./sentences";

/**
 * The most sentences with Citations one write of the assistant's had checked before its reply
 * (#1111): what a sentence marked "too-many" then says. Since #2830 a write checks every sentence.
 */
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
    ...(text(value.fromAnswer) !== null && { fromAnswer: text(value.fromAnswer) as string }),
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

/** A model that judged what a sentence's verdict shows, and when. */
export interface CheckJudge {
  providerId: string | null;
  modelId: string;
  checkedAt: string;
}

const isVerdict = (state: unknown): boolean =>
  state === "supported" || state === "unsupported" || state === "contradicted";

/**
 * Who judged what a sentence's verdict shows (#1667), oldest first: each part's own model and time,
 * a figure's and the rest of its sentence's where they were judged apart, else the check's. A
 * judgment with no model or time named is left out; none for a sentence with no verdict.
 */
export function checkJudges(check: ClaimCheckAttributes): CheckJudge[] {
  if (!isVerdict(check.state)) return [];
  type Judged = {
    providerId?: string | null;
    modelId?: string | null;
    checkedAt?: string;
    kept?: true;
  };
  // A judgment without a model or time of its own has its owner's: a part's figure its part's.
  const judge = (...owners: Judged[]): CheckJudge[] => {
    const chain = [...owners, check];
    const by = chain.find((each) => each.modelId !== undefined);
    const checkedAt = chain.find((each) => each.checkedAt)?.checkedAt;
    return by?.modelId && checkedAt
      ? [{ providerId: by.providerId ?? null, modelId: by.modelId, checkedAt }]
      : [];
  };
  const shown = (each: { verdict?: unknown; state?: unknown; kept?: true }) =>
    isVerdict(each.verdict ?? each.state) && !each.kept;
  const judges = check.parts?.length
    ? check.parts.filter(shown).flatMap((part) => {
        const within = [
          ...(part.figures ?? []).map((figure) => figure.result),
          ...(part.remainder ? [part.remainder] : []),
        ].filter(shown);
        return within.length > 0 ? within.flatMap((result) => judge(result, part)) : judge(part);
      })
    : check.figures?.length
      ? [...check.figures, ...(check.remainder ? [check.remainder] : [])]
          .filter(shown)
          .flatMap((child) => judge(child))
      : judge(check);
  return judges.sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
}

/**
 * The models a verdict card's last line names, each once in the order used, and the latest time
 * (#1667); null when no judgment names one.
 */
export function checkedWith(
  check: ClaimCheckAttributes,
): { models: { providerId: string | null; modelId: string }[]; checkedAt: string } | null {
  const judges = checkJudges(check);
  const latest = judges.at(-1);
  if (!latest) return null;
  const models = new Map(
    judges.map(({ providerId, modelId }) => [
      `${providerId}\u0000${modelId}`,
      { providerId, modelId },
    ]),
  );
  return { models: [...models.values()], checkedAt: latest.checkedAt };
}

/**
 * Why a check no longer holds: its sentence was edited (an accepted change
 * or a restored Checkpoint edits it too), a Document it read has a new
 * version, one its result rests on was deleted, the Mind moved to another
 * Folder while the result rests on a whole Folder's contents ("scope"), or the
 * Search scope the User set for the Mind changed. A result its Citations back
 * stays true wherever the Note is filed.
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
  | "referent"
  /** A fact of the Library it rests on says otherwise now (#2525). */
  | "library";

/** A check as it shows now; "kept": the User keeps the sentence as their own view, and it shows nothing. */
export type ClaimCheckShown =
  | { state: "checking" }
  | { state: ClaimVerdict }
  | { state: "not-checked"; reason: ClaimCheckFailure }
  | { state: "needs-recheck"; why: RecheckReason }
  | { state: "kept" };

/**
 * The failures a check on the same sentence and Documents cannot settle: the Citation it needs
 * is kept inside another Folder or outside the Note's Search scope (#3083), or the sentence
 * describes the Library in a way its facts can't settle (#2525). A reply that failed, was refused
 * or couldn't be used, a service limit, a cap, a stop, or a sentence a later Check takes may be
 * settled next time, so those stay Not checked.
 */
export const UNCHECKABLE_FAILURES: ReadonlySet<ClaimCheckFailure> = new Set([
  "kept-inside",
  "outside-scope",
  "library-unsettled",
]);

/** Whether a check's result is one a check cannot settle for this sentence, rather than one still to make. */
export function cantBeChecked(shown: ClaimCheckShown): boolean {
  return shown.state === "not-checked" && UNCHECKABLE_FAILURES.has(shown.reason);
}

/** A figure's footing against its table as the Note's marks and numbers are now (#2998). */
export type LiveFooting = Omit<FigureFootingNow, "id">;

/**
 * Each figure's footing as the Note is now, by its id; a figure that is no total has none. A
 * figure's verdict reads this, never the footing stored when its check landed, which went stale
 * once a cell it counts landed later or changed. "not-yet-known" only where it can't be known yet
 * (the editor, before the Note's figures are first read), and then the stored footing stands.
 */
export type NoteFooting = ReadonlyMap<string, LiveFooting> | "not-yet-known";

/** What a check is compared with. */
export interface ClaimCheckNow {
  footing: NoteFooting;
  figureContexts?: ReadonlyMap<string, string> | null;
  /** The sentence is a table cell holding figures the one Check checks each with its own source; unknown when absent. */
  figured?: boolean;
  /** The sentence as it reads now: all of the sentences its marked text is in. */
  text: string;
  /**
   * The sentence's Citations as the Note holds them now: a ✓ resting on a Passage the check found
   * shows only once that Passage is one of them (`asCitedNow`, #3019). Every reading of a sentence
   * gives them; absent only where a figure's own check is read, which rests on no Passage of its.
   */
  citations?: readonly HeldCitation[];
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
  /** The walled Folder that keeps a Document inside it, seen from the Note; null when it may read it. */
  keptInside?: ((documentId: string) => string | null) | null;
}

/** A verdict a check landed, the only kind a Folder move has a result to keep (#2313). */
const LANDED: ReadonlySet<ClaimCheckBasis["state"]> = new Set([
  "supported",
  "unsupported",
  "contradicted",
]);

/** Whether a result rests on any Citation at all: a found quote stays true wherever the Note is filed (#2313). */
const backedByCitation = (check: ClaimCheckBasis): boolean =>
  restsOn(check).some((each) => each.documentId !== null);

/** Whether the check read whole Documents: an absence rests on the Folder's contents, and a move changes them (#2313). */
function readWholeFolder(check: {
  readDocuments?: readonly ClaimReadDocument[];
  parts?: readonly ClaimCheckPart[];
}): boolean {
  // The editor's mark declares every attribute, so an unread Document list is [] and not absent.
  return (
    (check.readDocuments?.length ?? 0) > 0 ||
    (check.parts ?? []).some((part) => (part.readDocuments?.length ?? 0) > 0)
  );
}

/** Whether anything the check judged is Unsupported: a quote backs only what it states, and the rest said nothing in the Folder it searched (#2313). */
function saysUnsupported(check: ClaimCheckBasis): boolean {
  return (
    check.state === "unsupported" ||
    (check.parts ?? []).some((part) => part.verdict === "unsupported")
  );
}

/** Whether a sentence's `Id.` or `supra` refers back through other cites now than when it was checked. */
function referentsMoved(check: ClaimCheckBasis, now: Omit<ClaimCheckNow, "footing">): boolean {
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

function scopeChanged(searched: ClaimCheckScope, now: Omit<ClaimCheckNow, "footing">): boolean {
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
 * Whether the card lists a check's parts as rows (#2002): more than one, or one with a card of
 * its own. A check with rows shows each part's own result there; the sentence's result is the
 * parts' verdict, Not found only when every part found nothing (#2313).
 */
export function showsPartRows(check: Pick<ClaimCheckAttributes, "parts">): boolean {
  return Boolean(
    check.parts &&
      (check.parts.length > 1 ||
        check.parts.some(
          (part) =>
            part.kind === "opinion" ||
            part.coverage ||
            part.evidence.length > 1 ||
            part.unsupported?.kind,
        )),
  );
}

/**
 * Whether one part's own check found nothing (#2313): no quoted Passage, no Passage read and
 * judged, no court decision, none of the User's own workings, and no covered quote.
 */
export function partFoundNothing(part: ClaimCheckPart): boolean {
  return (
    part.verdict === "unsupported" &&
    part.evidence.length === 0 &&
    !part.citedCaseUnchecked &&
    !part.excluded.some((left) => left.reason === "own-workings") &&
    !part.unsupported?.found &&
    coveredPart(part.unsupported) === null
  );
}

/**
 * Whether nothing in its scope was about an unsupported sentence (#1608): its card is headed Not
 * found and says where it looked, and its Word comment says the same. A Passage the check found
 * makes it Unsupported: one quoted as saying something different or as stating part of it, or one
 * it read and judged (`UnsupportedReason.found`). A sentence with Citations, one citing a court
 * decision no Document holds, or one only the User's own workings state is Unsupported; one whose
 * parts the card lists as rows is Not found only when every part found nothing (#2313).
 */
export function saysNotFound(
  shown: ClaimCheckShown,
  check: ClaimCheckAttributes,
  citations: number,
): boolean {
  if (shown.state !== "unsupported") return false;
  if (showsPartRows(check)) {
    return Boolean(check.parts?.length) && (check.parts ?? []).every(partFoundNothing);
  }
  return (
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

/**
 * Why a result read at `versions` needs checking again with the Documents as they are now; null
 * when none it depends on changed. `relied`: what it rests on, which it can't do without.
 */
function staleVersions(
  versions: ClaimCheckBasis["versions"],
  relied: () => readonly { documentId: string | null }[],
  now: Pick<ClaimCheckNow, "versions">,
  fromAnswer: boolean,
): RecheckReason | null {
  if (!now.versions) return null;
  const restsOnIds = new Set(relied().map((each) => each.documentId));
  for (const version of versions) {
    const current = now.versions.get(version.documentId);
    // A fact of the Library not known yet is taken as it was: the window asks for them apart.
    if (readLibraryVersion(version.documentId)) {
      if (current !== undefined && current !== version.contentHash) return "library";
      continue;
    }
    // A Document only read, gone, takes nothing from the result: an example's, swapped for the interface language, among them (#962).
    // A carried check relied on every Citation its Answer judged, not only the one that decided.
    if (current === undefined && (restsOnIds.has(version.documentId) || fromAnswer))
      return "document-removed";
    if (current !== undefined && current !== version.contentHash) return "new-version";
  }
  return null;
}

/** How a check shows, given the sentence, the Documents and the Mind's Folder and scope as they are now. */
function basisShown(check: ClaimCheckBasis, now: Omit<ClaimCheckNow, "footing">): ClaimCheckShown {
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
  const stale = staleVersions(
    check.versions,
    () => [...restsOn(check), ...(check.readDocuments ?? [])],
    now,
    check.fromAnswer !== undefined,
  );
  if (stale) return { state: "needs-recheck", why: stale };
  // A landed result searched the Folder it was in: filed elsewhere with Documents never read, a
  // whole-Folder read or a result with no quote to rest on must be checked there (#2313). A check
  // that landed nothing is not a result the move can rewrite.
  if (
    LANDED.has(check.state) &&
    !check.scope.widened &&
    !check.scope.chosen &&
    check.scope.folderId !== now.folderId &&
    (!backedByCitation(check) || readWholeFolder(check) || saysUnsupported(check))
  ) {
    return { state: "needs-recheck", why: "scope" };
  }
  // Contradiction watch looks in the Mind's Folder, and a whole read in the User's pick.
  if (
    !check.scope.widened &&
    check.action !== "contradiction-watch" &&
    check.action !== "check-against-document" &&
    // A carried check searched the Answer's Question, not this Note's scope: moving the Note
    // changes nothing it read (#2313).
    check.fromAnswer === undefined &&
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
 * Whether every Document that supports the sentence is one of the User's own notes (#335):
 * its own evidence and the evidence of each supported part, with nothing read whole behind it.
 * A Document of theirs that also supports it makes this false, so the mark stays the usual one.
 */
export function supportedByOwnNotesOnly(check: {
  state: ClaimCheckAttributes["state"];
  evidence: CitationAttributes | null;
  parts?: readonly Pick<ClaimCheckPart, "verdict" | "evidence">[];
  readDocuments?: readonly unknown[];
}): boolean {
  if (check.state !== "supported") return false;
  if ((check.readDocuments ?? []).length > 0) return false;
  const evidence = [
    ...(check.evidence ? [check.evidence] : []),
    ...(check.parts ?? []).flatMap((part) => (part.verdict === "supported" ? part.evidence : [])),
  ];
  return evidence.length > 0 && evidence.every((each) => typeof each.yourNoteAt === "string");
}

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

/**
 * Whether a sentence reads Not checked only because what it says is missing couldn't be read whole,
 * every other part of it Supported (#3019): its line says what was checked. A sentence that is only
 * that absence, or holds any other part, keeps its reason's own line.
 */
export function absenceBesideFact(
  check: Pick<ClaimCheckAttributes, "parts">,
  shown: ClaimCheckShown,
): boolean {
  if (shown.state !== "not-checked" || shown.reason !== "absence-read-limit") return false;
  const parts = check.parts ?? [];
  return (
    parts.some((part) => part.verdict === "supported") &&
    parts.every(
      (part) =>
        part.verdict === "supported" ||
        (part.verdict === "not-checked" && part.reason === "absence-read-limit"),
    )
  );
}

export function claimCheckShown(check: ClaimCheckAttributes, now: ClaimCheckNow): ClaimCheckShown {
  if (!check.figures?.length || check.kept) {
    const shown = basisShown(asCitedNow(check, now.citations ?? [], now.text), now);
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
  // Its figures each have their own check, and its remainder holds only its facts: an opinion
  // Check anyway is judging reads as a plain sentence being checked, one it judged counts beside
  // them, and the assistant's own left out still takes its ✓ (#3019).
  const opinions = (check.parts ?? []).filter((part) => part.kind === "opinion" && !part.itself);
  if (opinions.some((part) => part.verdict === "checking")) return { state: "checking" };
  const shown = aggregateFigureStates(
    [
      ...check.figures.map((figure) => figureCheckShown(figure, now)),
      ...opinions.flatMap((part) =>
        part.verdict === null ? [] : [opinionShown(part, part.verdict, now)],
      ),
    ],
    check.remainder === null
      ? null
      : check.remainder
        ? basisShown(check.remainder, now)
        : undefined,
  );
  if (shown.state !== "supported") return shown;
  return opinions.some(leftOutByAssistant)
    ? { state: "not-checked", reason: "assistant-conclusion" }
    : shown;
}

/** How an opinion part Check anyway judged shows, read against the Documents as they are now. */
function opinionShown(
  part: ClaimCheckPart,
  verdict: NonNullable<ClaimCheckPart["verdict"]>,
  now: ClaimCheckNow,
): ClaimCheckShown {
  if (verdict === "checking") return { state: "checking" };
  const stale = staleVersions(
    part.versions,
    () => [...partCitations(part), ...(part.readDocuments ?? [])],
    now,
    false,
  );
  if (stale) return { state: "needs-recheck", why: stale };
  if (verdict === "not-checked") return { state: "not-checked", reason: part.reason ?? "failed" };
  return { state: verdict };
}

/**
 * How an Analysis figure shows (#2378). Its number is what the core worked out when the Analysis
 * ran, while the Documents it read are as they were; Not checked otherwise. Whether its sentence
 * names it is its own check's: Supported only once the claim judge read the sentence as naming it,
 * Unsupported once it read another figure's name there, and no verdict before a check or once the
 * sentence's words changed. The User's own Keep of the sentence stands.
 */
export function analysisFigureShown(
  shown: ClaimCheckShown,
  figure: {
    /** The record the Note keeps of the figure's Analysis; null when it kept none. */
    run: RetainedFigureAnalysis | null;
    result: string | null;
    /** Each live Document's version now; null while they aren't known. */
    versions: ReadonlyMap<string, string> | null;
    /** The walled Folder that keeps a Document inside it, seen from the Note; null when it may read it. */
    keptInside?: ((documentId: string) => string | null) | null;
    /** The figure's own check: whether the claim judge read its sentence as naming it (`named`). */
    check?: Pick<FigureCheckAttributes, "state" | "unsupported" | "named"> | null;
  },
): ClaimCheckShown {
  if (figure.result === null || shown.state === "kept") return shown;
  const value = figure.run?.values.find((each) => each.name === figure.result);
  // Its run read a Document a wall keeps from this Note (#1934): it backs nothing here.
  if (
    figure.keptInside &&
    (figure.run?.inputs ?? []).some((input) => {
      const citation = input.kind === "figure" ? input.input.citation : input.citation;
      return figure.keptInside?.(citation.documentId) != null;
    })
  )
    return { state: "not-checked", reason: "kept-inside" };
  // A figure that names an Analysis whose record the Note no longer keeps reads as its value and
  // Not checked: a recalculation can't stand for a record that is gone, and an earlier build could
  // take one away (#2378).
  if (!value) return { state: "not-checked", reason: "analysis-gone" };
  if (value.check?.kind !== "same") return { state: "not-checked", reason: "analysis" };
  for (const input of figure.run?.inputs ?? []) {
    const citation = input.kind === "figure" ? input.input.citation : input.citation;
    const current = figure.versions?.get(citation.documentId);
    if (figure.versions && current === undefined)
      return { state: "needs-recheck", why: "document-removed" };
    if (current !== undefined && citation.contentHash !== null && current !== citation.contentHash)
      return { state: "needs-recheck", why: "new-version" };
  }
  if (shown.state === "needs-recheck" || shown.state === "checking") return shown;
  if (figure.check?.state === "unsupported" && figure.check.unsupported?.kind === "analysis-name")
    return { state: "unsupported" };
  // Its own check's total that doesn't add up is Unsupported whoever named it; a verdict on the
  // sentence's words, or an earlier check's on a source, never stood for an Analysis's figure.
  if (shown.state === "unsupported" && figure.check && figure.check.state !== "unsupported")
    return shown;
  if (shown.state === "supported" && figure.check?.state === "supported" && figure.check.named)
    return shown;
  return shown.state === "not-checked" ? shown : { state: "not-checked", reason: "unread" };
}

// An Analysis figure's evidence is its run's inputs, each one: behind a wall the Note is now
// outside, the check made inside it backs nothing (#2378).
const analysisKeptInside = (figure: FigureCheckAttributes, now: Omit<ClaimCheckNow, "footing">) =>
  figure.calculated?.figure.analysis &&
  [figure.evidence?.documentId, ...figure.versions.map((version) => version.documentId)].some(
    (documentId) => documentId && now.keptInside?.(documentId),
  );

/** How a figure's own check shows, before its table's footing is read: whether it still holds. */
export function figureBasisShown(
  figure: FigureCheckAttributes,
  now: Omit<ClaimCheckNow, "footing">,
): ClaimCheckShown {
  if (analysisKeptInside(figure, now)) return { state: "not-checked", reason: "kept-inside" };
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
  return shown;
}

const NOT_FOOTED: LiveFooting = { footing: [], waiting: false };

export function figureCheckShown(
  figure: FigureCheckAttributes,
  now: ClaimCheckNow,
): ClaimCheckShown {
  const shown = figureBasisShown(figure, now);
  if (
    analysisKeptInside(figure, now) ||
    shown.state === "kept" ||
    shown.state === "needs-recheck" ||
    shown.state === "contradicted"
  )
    return shown;
  const live =
    now.footing === "not-yet-known"
      ? { footing: figure.footing, waiting: false }
      : (now.footing.get(figure.id) ?? NOT_FOOTED);
  // A cell it counts is still out: shown now, its verdict could turn once that cell lands, with
  // nothing changed by the User (#2998), whether or not its own check could be made.
  if (live.waiting) return { state: "checking" };
  return figureProblem({ ...figure, footing: live.footing }) !== null
    ? { state: "unsupported" }
    : shown;
}

/**
 * Whether Documents added to its scope since could change a check (#993): one
 * found unsupported or not checked. A supported or contradicted one already
 * has its evidence, as have one whose ✓ waits on the Passage it found becoming
 * a Citation and one beside the assistant's own conclusion (#3019), unless an
 * absence read whole backs it, which a new Document can still disprove;
 * contradiction watch makes its own checks again, and a whole read covered
 * only the User's pick.
 */
export const addedCouldChange = (check: ClaimCheckAttributes, shown: ClaimCheckShown): boolean =>
  check.action !== "contradiction-watch" &&
  check.action !== "check-against-document" &&
  check.checkedAt !== "" &&
  (shown.state === "unsupported" ||
    (shown.state === "not-checked" &&
      shown.reason !== "found-elsewhere" &&
      shown.reason !== "assistant-conclusion") ||
    ((shown.state === "supported" ||
      (shown.state === "not-checked" && shown.reason === "assistant-conclusion")) &&
      (check.readDocuments?.length ?? 0) > 0));

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
        // Checked: what is left is the assistant's own conclusion, which no check settles (#3019).
        return input.check.reason === "assistant-conclusion"
          ? { kind: "covered" }
          : { kind: "to-check", fresh: false, why: "failed" };
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
