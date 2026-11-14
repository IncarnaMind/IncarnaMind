/**
 * The claim-check function (#96): one claim checked against the Documents
 * in a check Run, the one way Check against Documents checks a
 * sentence, and later verify (#97) and contradiction watch (#112).
 *
 * The Run is the Answer engine's Tool-calling loop (ADR-0007) with the check
 * Tool set: the Documents' search and `cite`, nothing else (ADR-0013, #78).
 * Its searches leave out what a check may not use as evidence (#80): the
 * files IncarnaMind wrote, unless counted, the User's own workings and the
 * document being checked.
 * The model records the Passage that decides the claim with `cite`, and its
 * quote must pass the Citation check before the verdict is taken: a
 * "supported" or "contradicted" without a quote that is found is not
 * checked. A refusal, a reply with no verdict, an empty one or a provider's
 * failure leaves the claim not checked, with the reason; never supported.
 *
 * A model measured to use `calculate` (ADR-0021) is offered it too, for a
 * figure the sentence states that no Passage does but their numbers give
 * (#707). It names the sentence's number as `stated`; IncarnaMind works the
 * figure out and compares, not the model. A figure that disagrees contradicts
 * the sentence; one that agrees settles that number only, and the model's
 * verdict on the rest of the sentence still stands.
 */

import { FiguresNotRead, readFigures } from "../../../shared/figures";
import { translate } from "../../../shared/i18n";
import type { InlineTextProjection } from "../../../shared/inlineText";
import { formatLocation, joinUnits, locationOf, quoteInUnits } from "../../../shared/locations";
import { type UnreadFigures, unreadFiguresDetail } from "../../../shared/unreadFigures";
import type {
  CheckFigure,
  Citation,
  CitationLocation,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartCoverage,
  ClaimPartPlan,
  ClaimPartSpan,
  Document,
  SearchScope,
  ThirdPartyReason,
} from "../../api";
import type { CitationSource } from "../../documents";
import type { Evidence, EvidenceScope, EvidenceSearch } from "../../documents/evidence";
import type { WindowedPassage } from "../../documents/search";
import type { Language } from "../../language";
import { type CheckPathsOverride, searchesFirst } from "../../providers/catalog/checkPaths";
import type { PreparedChatModel } from "../../providers/chat";
import type { RecordCitePlace } from "../../recordCites/referents";
import type { Slots } from "../../runs/stop";
import { type AnswerDocuments, matchingOf } from "../citations";
import type { AnswerEngine, DocumentLanguage, SearchResultForModel } from "../engine";
import { absenceAfterSearch, fitsWholeRead } from "./absence";
import { calculatesIn, createCalculationLedger, figureContextIn } from "./calculationLedger";
import { createCheckResults, uniqueCitations } from "./checkResults";
import { checkRun, type RunTranscript } from "./checkRun";
import {
  type CourtDecisions,
  citedOutsideScope,
  courtDecisions,
  keptInside,
  setUpRun,
  withoutDocumentLeftOut,
} from "./checkSetup";
import { explainedIn } from "./explanations";
import { uncheckedFigureResults } from "./figureChecks";
import { figuresVerdict } from "./figuresVerdict";
import { type FilePropertySearch, withFileProperties } from "./fileProperties";
import { type LibraryFactSearch, type LibraryListing, withLibraryFacts } from "./libraryFacts";
import { lookForPresence } from "./looks";
import { plainVerdict } from "./plainVerdict";
import { checkedTextOf, unitGate } from "./unitGate";
import { dollarClause } from "./units";

export interface ClaimCheckDependencies {
  /** The interface language: what a check's sentence is written in. */
  language(): Language;
  /** The wall a Document belongs to, or null when it belongs to none. */
  walledDocument(documentId: string): string | null;
  /** The name of that wall's Folder, or null when it belongs to none. */
  walledFolderName(documentId: string): string | null;
  engine: AnswerEngine;
  evidence: Pick<Evidence, "search">;
  documents: Pick<AnswerDocuments, "citationSource" | "pageTexts" | "documentDate" | "speakers"> & {
    searchableCount(documentIds: readonly string[] | null): number;
    passagesBetween(
      documentId: string,
      from: number,
      to: number,
    ): import("../../documents/search").WindowedPassage[];
    searchableLanguages(documentIds: readonly string[] | null): DocumentLanguage[];
    /** The Documents with Passages to search, with their names: what a search names one by. */
    searchableBySize(documentIds: readonly string[] | null): { id: string; name: string }[];
    savedBySearch(documentId: string): boolean;
    /** How many Units each Document's current version has, read from stored counts. */
    unitCounts(documentIds: readonly string[]): ReadonlyMap<string, number>;
    getMany?(documentIds: readonly string[]): Document[];
    names?(): readonly import("../../../shared/citations").LiveDocument[];
  };
  /** The Run's searches may show the Documents' file properties (./fileProperties). */
  fileProperties?: FilePropertySearch;
  /** What a scope sees of the Library, Folder walls applied, from a Note in `mindId` (./libraryFacts). */
  libraryListing?(mindId: string | null, searched: SearchScope | null): LibraryListing;
  /** The Run's searches may show the Library's own facts (./libraryFacts). */
  libraryFacts?: LibraryFactSearch;
  /** Which models check by the faster paths, instead of the lists beside the catalog; only tests and the evaluation pass one. */
  checkPaths?: CheckPathsOverride;
}

/** A search of a sentence's own words, started before its check (#2532): its check's search of those words. */
export interface AheadSearch {
  query: string;
  found: Promise<EvidenceSearch>;
}

/**
 * A Citation the sentence has, as its check reads it: `documentId` while its Document is live,
 * `passageId` when it quotes the Document as it is now.
 */
export interface CheckedCitation {
  documentName: string;
  quote: string;
  documentId?: string;
  passageId?: string;
}

export interface ClaimCheckRequest {
  claim: string;
  projection?: InlineTextProjection;
  figureIds?: readonly string[];
  // A legal prefix can govern later literal parts without being repeated in them (#2002).
  originalClaim?: string;
  figures?: readonly CheckFigure[];
  context?: string;
  cited?: readonly CheckedCitation[];
  scope: EvidenceScope;
  /**
   * The Search scope `scope` was resolved from, as its chip names it; null for every Document.
   * Only a check that gives it may be shown the Library's facts (./libraryFacts).
   */
  searched?: SearchScope | null;
  model: PreparedChatModel;
  /** The Run reads the document being checked (#97): it is third-party from its start. */
  thirdParty?: readonly ThirdPartyReason[];
  /** The Note the sentence is in, whose source choices and earlier record cites apply. */
  mindId?: string;
  /** Where the sentence starts in the Note, for what its `Id.` and `supra` refer to. */
  place?: RecordCitePlace;
  /** The sentence as the Note has it (an inline node as U+FFFC), when `claim` is reworded. */
  recordClaim?: string;
  /** Names the Mind, for a provider's prompt cache. */
  cacheKey?: string;
  /** An explicit whole-read window (./wholeRead): every search in this Run stays within it. */
  window?: readonly WindowedPassage[];
  /** The sentence's own search, made before its check started. */
  ahead?: AheadSearch;
  /**
   * A check of a flow the search-first gate measured (Check this Note, a write's checks): only
   * these may search first on a listed model (#2532); Verify and the watch check as before.
   */
  searchFirst?: true;
  signal: AbortSignal;
  parts?: readonly ClaimPartPlan[];
  only?: ClaimPartSpan;
  previous?: readonly ClaimCheckPart[];
  /** Parts already Supported or Contradicted keep their results: a whole read looks for the rest (#1554). */
  undecidedOnly?: boolean;
  /** A whole read goes on from one of the same pick stopped at its budget: only the parts it stopped before judging are read. */
  resumesStopped?: boolean;
  /** The run's limit on model checks at once, which its claims' parts share. */
  slots?: Slots;
  /** The User didn't ask about this sentence: an opinion in it is left out, never checked. */
  opinionsLeftOut?: boolean;
  /**
   * The Run's first turn names the sentence's parts: told what that turn wrote before any further
   * request, or what the Run wrote when it calls no Tool.
   */
  findParts?: (heard: string) => void;
}

export type AtomicClaimCheckResult = ClaimCheckResult & {
  checkedEvidence?: readonly Citation[];
  coverage?: ClaimPartCoverage;
  /** In a whole-read window: the Passages that reached the model in the request it answered. */
  readPassages?: readonly string[];
  /** In a whole-read window: the absence the sentence states holds in this window's text. */
  absenceHeld?: true;
};

/**
 * Where `line` stands in `units`, from only the Units it covers: a page range never spans the whole
 * Document (#2226).
 */
function lineLocation(
  units: ReturnType<ClaimCheckDependencies["documents"]["pageTexts"]>,
  line: string,
  matching: ReturnType<typeof matchingOf>,
): CitationLocation | null {
  const ranges = quoteInUnits(units, line, matching);
  if (!ranges) return null;
  const { starts } = joinUnits(units);
  const covered = units.map((unit, index) => {
    const start = starts[index] as number;
    return ranges.some((range) => range.start < start + unit.text.length && range.end > start);
  });
  const first = covered.indexOf(true);
  const last = covered.lastIndexOf(true);
  if (first < 0 || last < 0) return null;
  const offset = starts[first] as number;
  return locationOf(
    units.slice(first, last + 1),
    ranges.map((range) => ({ start: range.start - offset, end: range.end - offset })),
  );
}

function withDollarClause(
  deps: ClaimCheckDependencies,
  claim: string,
  result: AtomicClaimCheckResult,
): AtomicClaimCheckResult {
  if (result.verdict !== "supported") return result;
  const citations = uniqueCitations([
    ...(result.evidence ? [result.evidence] : []),
    ...(result.checkedEvidence ?? []),
  ]).filter((citation) => citation.check === "found");
  if (citations.length === 0) return result;
  const checked = citations.map((citation) => ({
    citation,
    text: checkedTextOf(citation, deps.documents.pageTexts),
  }));
  const found = dollarClause(
    claim,
    checked.map((each) => ({ text: each.text, quote: each.citation.quote })),
  );
  const source = found ? checked.find((each) => each.text === found.text)?.citation : undefined;
  if (!found || !source) return result;
  const units = deps.documents.pageTexts(source.documentId, source.contentHash, null, null);
  const location = lineLocation(units, found.line, matchingOf(units));
  const where = location
    ? formatLocation(location, (key, params) => translate(deps.language(), key, params), {
        speakers:
          location.kind === "time" ? (deps.documents.speakers?.(source.documentId) ?? null) : null,
      })
    : null;
  const place = [source.documentName, where].filter(Boolean).join(" · ");
  return {
    ...result,
    currencyClause: translate(
      deps.language(),
      place === "" ? "claim.currencyClause.noSource" : "claim.currencyClause",
      place === "" ? { quote: found.line } : { quote: found.line, source: place },
    ),
  };
}

export function createClaimCheck(deps: ClaimCheckDependencies) {
  return withLibraryFacts(deps, (withLibrary) =>
    withFileProperties(withLibrary, createSentenceCheck),
  );
}

function createSentenceCheck(deps: ClaimCheckDependencies) {
  return (request: ClaimCheckRequest) => checkSentence(deps, request);
}

/**
 * Whether a check on this request's model searches its sentence's own words before its first
 * request and hands the Passages over (#2532): an uncited sentence of a flow the gate measured,
 * outside a whole read, on a model that calls Tools and is listed for it. A Run that names its
 * sentence's parts names them before its first search, as it did before.
 */
export function handsOff(
  deps: Pick<ClaimCheckDependencies, "checkPaths">,
  request: Pick<ClaimCheckRequest, "model" | "window" | "cited" | "findParts" | "searchFirst">,
): boolean {
  const { model } = request;
  return (
    request.searchFirst === true &&
    !request.window &&
    !request.findParts &&
    (request.cited?.length ?? 0) === 0 &&
    (model.support ?? "tools") === "tools" &&
    searchesFirst({ catalogId: model.provider.catalogId, modelId: model.modelId }, deps.checkPaths)
  );
}

/** What a check's verdict is read with, set up before its first request. */
export interface PreparedCheck {
  results: ReturnType<typeof createCheckResults>;
  setup: ReturnType<typeof setUpRun>;
  calculating: boolean;
  ledger: ReturnType<typeof createCalculationLedger>;
  court: CourtDecisions;
  readsWhole(): boolean;
}

/** A check set up before its first request; null when stopped while it looked up the court decisions it cites. */
export async function prepareCheck(
  deps: ClaimCheckDependencies,
  request: ClaimCheckRequest,
): Promise<PreparedCheck | null> {
  const results = createCheckResults(request);
  const setup = setUpRun(deps, request, results);
  const { scoped, session } = setup;
  const calculating = calculatesIn(request.model, request);
  const ledger = createCalculationLedger(request, scoped, session, calculating);
  let court: CourtDecisions;
  try {
    court = await courtDecisions(setup.decisions, scoped, request.signal);
  } catch (error) {
    if (request.signal.aborted) return null;
    throw error;
  }
  let fits: boolean | undefined;
  const readsWhole = () => {
    fits ??= fitsWholeRead(request.scope.documentIds, deps.documents);
    return fits;
  };
  return { results, setup, calculating, ledger, court, readsWhole };
}

/** The verdict a check's reply comes to, once its Run or its first reply has ended. */
export function verdictOfReply(
  deps: ClaimCheckDependencies,
  request: ClaimCheckRequest,
  prepared: PreparedCheck,
  transcript: RunTranscript,
): Promise<AtomicClaimCheckResult> {
  const { results, setup, ledger, court, readsWhole } = prepared;
  const { scoped, session, looked } = setup;
  const { facts, notChecked, failedCheck } = results;
  const { signal } = request;
  const { citedCase } = court;
  const figureContext = figureContextIn(scoped);
  const verdicts = {
    transcript,
    looked,
    session,
    scoped,
    ledger,
    results,
    court,
    citedCase,
    unstatedUnit: unitGate(deps, scoped, figureContext),
    figureContext,
    absenceFor: absenceAfterSearch({
      request,
      documents: deps.documents,
      session,
      readVersion: results.readVersion,
      facts,
      citedCase,
      fits: readsWhole,
      notChecked,
      failedCheck,
      lookAt: (evidence, absent, first) =>
        lookForPresence(request, evidence, absent, session, signal, first),
    }),
    // Which of two Documents that disagree is newer orders a correction's choices (#1481): the
    // host's own date for each, never shown to the model as the Document's words.
    newestFirst: (documentId: string) => deps.documents.documentDate(documentId),
    unitsOf: (citation: Citation) =>
      deps.documents.pageTexts(citation.documentId, citation.contentHash, null, null),
  };
  const { figures } = request;
  return figures?.length
    ? figuresVerdict(deps, { ...request, figures }, verdicts)
    : plainVerdict(deps, request, verdicts);
}

/**
 * A check's result as the sentence shows it: Supported with its currency clause, anything else
 * explained in the interface's language; figures that couldn't be read leave it not checked,
 * named by the Passage they came from (`shownPassageIds`).
 */
export async function shownResult(
  deps: ClaimCheckDependencies,
  request: ClaimCheckRequest,
  decide: () => Promise<AtomicClaimCheckResult>,
  shownPassageIds: () => readonly string[],
): Promise<AtomicClaimCheckResult> {
  const leftOut = citedOutsideScope(deps, request);
  try {
    const decided = await decide();
    const result = leftOut ? withoutDocumentLeftOut(decided, leftOut.name) : decided;
    return result.verdict === "supported"
      ? withDollarClause(deps, request.claim, result)
      : explainedIn(result, {
          language: deps.language(),
          model: request.model,
          signal: request.signal,
        });
  } catch (error) {
    if (!(error instanceof FiguresNotRead)) throw error;
    return figuresNotRead(deps, request, error, shownPassageIds());
  }
}

async function checkSentence(
  deps: ClaimCheckDependencies,
  request: ClaimCheckRequest,
): Promise<AtomicClaimCheckResult> {
  // The Passages the check was given or shown, so that a text whose figures couldn't be read is
  // named by the one it came from.
  let shownPassageIds: () => readonly string[] = () => [];
  const leftOut = citedOutsideScope(deps, request);
  const decide = async (): Promise<AtomicClaimCheckResult> => {
    const kept = keptInside(deps, request);
    if (kept) return kept;
    if (leftOut?.every)
      return {
        verdict: "not-checked",
        reason: "outside-scope",
        detail: leftOut.name,
        versions: [],
        excluded: [],
      };
    const { signal } = request;
    const prepared = await prepareCheck(deps, request);
    if (!prepared) return createCheckResults(request).notChecked("stopped");
    const { results, setup, calculating, ledger, readsWhole } = prepared;
    shownPassageIds = setup.shownPassageIds;
    let handed: SearchResultForModel | null = null;
    if (handsOff(deps, request) && setup.citedShown === null) {
      try {
        handed = await setup.handOff(signal);
      } catch (error) {
        if (signal.aborted) return results.notChecked("stopped");
        throw error;
      }
    }
    const transcript = await checkRun(deps, request, {
      tools: setup.tools(ledger.tools),
      session: setup.session,
      citedShown: setup.citedShown,
      handed,
      looked: setup.looked,
      searches: setup.searches,
      readsWhole,
      calculating,
      ledger,
      results,
    });
    if (signal.aborted) return results.notChecked("stopped");
    if (transcript.failed) return results.failedCheck(transcript.failed);
    return verdictOfReply(deps, request, prepared, transcript);
  };
  return shownResult(deps, request, decide, () => shownPassageIds());
}

/**
 * A check whose figures couldn't be read (#2510) is never Supported, and its text is never taken
 * for one that holds no figures: it is not checked, and says where, as the Passage the text came
 * from, else the sentence itself.
 */
function figuresNotRead(
  deps: ClaimCheckDependencies,
  request: ClaimCheckRequest,
  error: FiguresNotRead,
  passageIds: readonly string[],
): AtomicClaimCheckResult {
  const loose = (text: string) => text.replace(/\s+/g, " ").trim();
  const unread = loose(error.text);
  const holds = (text: string) => unread !== "" && loose(text).includes(unread);
  // The text read may be a quote of a Passage, or a search's result that holds several: the place
  // is the Passage whose own figures can't be read.
  const near = passageIds
    .map((id) => deps.documents.citationSource(id))
    .filter(
      (each): each is CitationSource =>
        each !== null &&
        (holds(each.text) || (loose(each.text) !== "" && unread.includes(loose(each.text)))),
    );
  const source = near.find((each) => !figuresReadIn(each.text)) ?? near[0] ?? null;
  const sentence = [request.claim, request.originalClaim, request.recordClaim].some(
    (text) => text !== undefined && (holds(text) || unread.includes(loose(text))),
  );
  const where = source
    ? `Passage ${source.passageId}`
    : sentence
      ? "its sentence"
      : "a text it read";
  console.error(`A check couldn't read the figures in ${where}: ${messageOf(error.cause)}`);
  const result: ClaimCheckResult = source
    ? {
        verdict: "not-checked",
        reason: "figures-not-read",
        detail: unreadFiguresDetail(unreadPlaceOf(deps, source)),
        versions: [{ documentId: source.documentId, contentHash: source.contentHash }],
        excluded: [],
      }
    : {
        verdict: "not-checked",
        reason: sentence ? "sentence-figures-not-read" : "figures-not-read",
        detail: null,
        versions: [],
        excluded: [],
      };
  return request.figures?.length ? uncheckedFigureResults(request.figures, result) : result;
}

function figuresReadIn(text: string): boolean {
  try {
    readFigures(text);
    return true;
  } catch (error) {
    if (error instanceof FiguresNotRead) return false;
    throw error;
  }
}

function unreadPlaceOf(deps: ClaimCheckDependencies, source: CitationSource): UnreadFigures {
  const { documentId, documentName, contentHash, pageFrom, pageTo } = source;
  const units =
    pageFrom === null || pageTo === null
      ? []
      : deps.documents.pageTexts(documentId, contentHash, pageFrom, pageTo);
  const location = units.length > 0 ? locationOf(units, null) : null;
  return { documentId, documentName, contentHash, pageFrom, pageTo, location };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
