/**
 * The claim-check function (#96): one sentence checked against the Documents, the one way every
 * check judges a sentence.
 *
 * The sentence goes to its model whole, in its paragraph, with the Passages its own Citations
 * quote. The model may search the Documents for more, records each quote that decides the
 * sentence with `cite`, and gives one verdict (./prompt). IncarnaMind confirms one thing: that a
 * Supported or Contradicted verdict rests on a quote its Document holds (the Citation check).
 * No rule here changes the verdict the model gave. A refusal, a reply with no verdict, an empty
 * one or a provider's failure leaves the sentence not checked, with the reason; never Supported.
 *
 * A decision model the User's checks use reads the sentence first (./decisionFirst), and only a
 * sentence it leaves undecided comes here.
 */
import { partWithResult, resultFromParts } from "../../../shared/claimParts";
import { joinUnits, locationOf, quoteInUnits } from "../../../shared/locations";
import { workingAddsUp } from "../../../shared/plainFigures";
import { isClaim } from "../../../shared/sentences";
import type { AnalysisRuntime } from "../../adapters";
import type {
  AnswerAnalysis,
  CheckFigure,
  CheckWorking,
  Citation,
  CitationLocation,
  ClaimCheckFailure,
  ClaimCheckResult,
  ClaimCorrection,
  DataKind,
  Document,
  ProviderError,
  ThirdPartyReason,
} from "../../api";
import type { Evidence, EvidenceScope } from "../../documents/evidence";
import type { Language } from "../../language";
import type { LibraryLists } from "../../library/lists";
import {
  checkCalculates,
  givesStructuredOutput,
  offersAnalysis,
} from "../../providers/capabilities";
import type { PreparedChatModel } from "../../providers/chat";
import type { RecordCitePlace } from "../../recordCites/referents";
import type { AnswerDocuments, matchingOf } from "../citations";
import type { AnswerEngine, DocumentLanguage } from "../engine";
import type { TurnCheck } from "../turnChecks";
import { createCheckResults, uniqueCitations } from "./checkResults";
import {
  citedOutsideScope,
  courtDecisions,
  keptInside,
  listsFor,
  setUpRun,
  withoutDocumentLeftOut,
} from "./checkSetup";
import { explainedIn } from "./explanations";
import {
  checkInstructions,
  claimPrompt,
  type ReadVerdict,
  readsAsRefusal,
  readVerdict,
} from "./prompt";
import type { BatchCall } from "./sentenceBatch";

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
    getMany?(documentIds: readonly string[]): Document[];
    names?(): readonly import("../../../shared/citations").LiveDocument[];
    /** Whether a sheet or a CSV file is among the Documents to search. */
    searchableHasSheets?(documentIds: readonly string[] | null): boolean;
  };
  /** Where a check's model works a figure out over a data file's rows (ADR-0023); absent: it can't. */
  analysisRuntime?: AnalysisRuntime;
  /** The Library's own lists as a Note's check may see them, Folder walls applied (#2525). */
  libraryLists?(mindId: string | null): LibraryLists;
  /** The call a Transcript's Passage is from, for an Answer asked in the Note `callIn` holds a call of (#3005). */
  callMark?(callIn: string | null, documentId: string): BatchCall | null;
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
  context?: string;
  /** `context` is the deck's slide by this number that the sentence is on, as the file holds it (#3455). */
  onSlide?: number;
  /** The sentence's paragraph under its nearest heading: what a decision model reads with it. */
  near?: string;
  cited?: readonly CheckedCitation[];
  /** The sentence's figures that IncarnaMind worked out itself: its check is told what each is. */
  figures?: readonly CheckFigure[];
  scope: EvidenceScope;
  model: PreparedChatModel;
  /**
   * What of the checks flow this check may send, the consent it was prepared on; all of it when
   * left out. Without "worked-figures" (the contradiction watch's), how its figures were worked
   * out stays on this computer, and the sentence is judged from the Passages alone. Without
   * "analysis-results" (a check the User didn't start), no code runs over a data file's rows;
   * without "library-counts", none counts the Library's own lists.
   */
  sends?: readonly DataKind[];
  /** The Run reads the document being checked (#97): it is third-party from its start. */
  thirdParty?: readonly ThirdPartyReason[];
  /** The Note the sentence is in, whose source choices and earlier record cites apply. */
  mindId?: string;
  /** An outside agent started the check (#3317): what it is told must stay within what it may read. */
  outside?: true;
  /** The Note whose call the sentence's Answer was asked in (#3005). */
  callIn?: string;
  /** Where the sentence starts in the Note, for what its `Id.` and `supra` refer to. */
  place?: RecordCitePlace;
  /** The sentence as the Note has it (an inline node as U+FFFC), when `claim` is reworded. */
  recordClaim?: string;
  /** Names the Mind, for a provider's prompt cache. */
  cacheKey?: string;
  /**
   * The Passages the run's decision model found to be about the sentence, each with how surely
   * (./decisionFirst). Given, they come first in each search's hits.
   */
  about?: ReadonlyMap<string, number>;
  signal: AbortSignal;
}

/** The rows of each sheet or CSV file an Analysis read. */
export const rowsOf = (run: AnswerAnalysis) =>
  run.inputs.flatMap((input) => (input.kind === "range" ? [input] : []));

/** Why a sentence whose working didn't finish isn't checked. */
export const endedAs = ({ end }: AnswerAnalysis): ClaimCheckFailure =>
  end.kind === "timed-out"
    ? "rows-run-timed-out"
    : end.kind === "unavailable"
      ? "rows-unavailable"
      : "rows-run-failed";

/** The most of a working's code, in characters, that a check keeps for its card. */
const CODE_KEPT = 4_000;

/** What a check keeps of the Analysis its verdict rests on. */
export const workingOf = (run: AnswerAnalysis): CheckWorking => ({
  title: run.title,
  code: run.code.slice(0, CODE_KEPT),
  rows: rowsOf(run).map(({ citation, range, rows }) => ({ citation, range, count: rows })),
  ranAt: run.ranAt,
});

/**
 * Where `line` stands in `units`, from only the Units it covers: a page range never spans the whole
 * Document (#2226).
 */
export function lineLocation(
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

const SEARCH_FIRST =
  "You gave a verdict without reading any Passage. Search the User's Documents with search_documents first, then give your verdict from what you find.";

export const SEARCH_AGAIN =
  "Before you say the Documents don't state this sentence, search them once more with other words: its key terms alone, a plainer paraphrase, or the Documents' language where it differs from the sentence's. Then give your verdict in the same form, from everything you found.";

const CITE_FIRST =
  "Your verdict rests on no recorded quote. Call cite now with the quote that decides the sentence, then write your whole reply again, naming its marker on the Evidence line.";

/** The most markers a check's reply is read for when its Evidence line names none. */
const MARKERS_READ = 8;

/** The sentence as the one part of its result: what a sentence's mark and its card are made from. */
const asWhole = (
  claim: string,
  { more, retryRefusal: _retry, ...result }: Judged,
): ClaimCheckResult =>
  claim.length === 0
    ? { ...result, parts: [] }
    : resultFromParts([
        partWithResult({ kind: "fact", span: { start: 0, end: claim.length } }, result, more),
      ]);

/** A sentence's result, with the quotes that decide it beside the first, which its card shows too. */
type Judged = ClaimCheckResult & { more?: readonly Citation[]; retryRefusal?: true };

export function createClaimCheck(deps: ClaimCheckDependencies) {
  return async (request: ClaimCheckRequest): Promise<ClaimCheckResult> => {
    let result = await judged(deps, request);
    // A provider can refuse one request in a concurrent Note check with a passing 400 (#3339):
    // try the check once more from a clean Run before leaving the sentence Not checked.
    if (result.retryRefusal && !request.signal.aborted) {
      result = await judged(deps, request);
    }
    const explained = await explainedIn(result, {
      language: deps.language(),
      model: request.model,
      signal: request.signal,
    });
    return asWhole(request.claim, explained);
  };
}

async function judged(deps: ClaimCheckDependencies, request: ClaimCheckRequest): Promise<Judged> {
  const { signal, model } = request;
  const results = createCheckResults();
  const { facts, notChecked, failedCheck } = results;
  if (signal.aborted) return notChecked("stopped");
  if (request.claim.trim() === "") return notChecked("empty");
  const kept = keptInside(deps, request);
  if (kept) return kept;
  const leftOut = citedOutsideScope(deps, request);
  if (leftOut?.every)
    return {
      verdict: "not-checked",
      reason: "outside-scope",
      detail: leftOut.name,
      versions: [],
      excluded: [],
    };
  const calculates = model.support === "tools" && checkCalculates(model.capabilities);
  const sends = (kind: DataKind) => request.sends === undefined || request.sends.includes(kind);
  // A figure over a data file's rows is worked out again where the model can run code, the User
  // started the check, and a sheet or a CSV file is there to read (#3282); a sentence about the
  // Library itself is worked out from the Library's own lists (#2525), in a check that runs by
  // itself too (#3357).
  const sheets = deps.documents.searchableHasSheets?.(request.scope.documentIds) === true;
  const rows = sends("analysis-results");
  const libraryLists = sends("library-counts") ? listsFor(deps, request) : undefined;
  const runtime =
    model.support === "tools" &&
    offersAnalysis(model.capabilities) &&
    deps.analysisRuntime?.languages.some((each) => each.language === "python") &&
    ((rows && sheets) || libraryLists !== undefined)
      ? deps.analysisRuntime
      : undefined;
  const {
    scoped,
    session,
    decisions,
    citedShown,
    citedByTool,
    looked,
    searches,
    tools,
    workings,
    libraryRead,
  } = setUpRun(
    deps,
    request,
    results,
    calculates,
    runtime && { runtime, rows, lists: libraryLists },
  );
  let court: Awaited<ReturnType<typeof courtDecisions>>;
  try {
    court = await courtDecisions(decisions, scoped, signal);
  } catch (error) {
    if (signal.aborted) return notChecked("stopped");
    throw error;
  }

  // A figure IncarnaMind worked out itself is backed by its own record, which the model is given:
  // a sentence that only names it as its label says is Supported with no quote from a Document.
  const figures = sends("worked-figures") ? (request.figures ?? []) : [];
  const workedOut = () =>
    workings().some(
      (run) =>
        run.end.kind === "done" &&
        (rowsOf(run).length > 0 ||
          (run.output.results.some((each) => each.kind === "figure") &&
            libraryRead(run) !== undefined)),
    );
  const restsOnOwnFigure = (read: ReadVerdict) =>
    read.verdict === "supported" && figures.length > 0;
  const fallbackMarkers = Array.from({ length: MARKERS_READ }, (_, at) => at + 1);
  const hasFoundQuote = (read: ReadVerdict) => {
    const unfound = new Set((session.tools.unfoundQuotes?.() ?? []).map((each) => each.marker));
    const hasFound = (markers: readonly number[]) =>
      markers.some(
        (marker) => (session.tools.hasRecord?.(marker) ?? false) && !unfound.has(marker),
      );
    return hasFound(read.evidence ?? []) || hasFound(fallbackMarkers);
  };
  const recorded = (read: ReadVerdict) =>
    hasFoundQuote(read) ||
    (citedByTool() &&
      (read.evidence ?? []).some((marker) => session.tools.hasRecord?.(marker) ?? false));
  const readReply = (text: string, earlier: readonly string[] = []): ReadVerdict | null => {
    const turns = [...earlier, text];
    const from = turns.findLastIndex((turn) => readVerdict(turn) !== null);
    return from < 0 || turns.slice(from + 1).some(readsAsRefusal)
      ? null
      : readVerdict(turns.slice(from).join("\n"));
  };
  // The verdict the search-again ask is for (#3381): one resting on a quote it recorded is not.
  const saysNotStated = (read: ReadVerdict) =>
    read.verdict === "unsupported" && (read.word ?? "not-found") === "not-found" && !recorded(read);
  // Each asks the model once, for something its reply lacks; none of them reads its verdict.
  const turnChecks: TurnCheck[] = [
    {
      name: "search-first",
      check(text, earlier) {
        const read = readReply(text, earlier);
        return read && !looked() && !restsOnOwnFigure(read)
          ? { claims: [], note: SEARCH_FIRST }
          : null;
      },
    },
    {
      name: "search-again",
      check(text, earlier) {
        const read = readReply(text, earlier);
        return read && looked() && searches() <= 1 && saysNotStated(read)
          ? { claims: [], note: SEARCH_AGAIN }
          : null;
      },
    },
    {
      name: "cite-first",
      check(text, earlier) {
        const read = readReply(text, earlier);
        return read &&
          looked() &&
          read.verdict !== "unsupported" &&
          !recorded(read) &&
          !restsOnOwnFigure(read) &&
          !workedOut()
          ? { claims: [], note: CITE_FIRST, requires: "cite" }
          : null;
      },
    },
  ];
  const language = deps.language();
  const countsLibrary = runtime !== undefined && libraryLists !== undefined;
  let reply = "";
  let setAside: readonly string[] = [];
  let failed: ProviderError | null = null;
  let finished = false;
  for await (const event of deps.engine.generate({
    instructions: (mode, options) =>
      checkInstructions(
        mode,
        language,
        options?.passages,
        request.callIn !== undefined,
        calculates,
        runtime !== undefined && rows && sheets,
        countsLibrary,
      ),
    messages: [
      { role: "user", content: claimPrompt({ ...request, figures, citedShown, language }) },
    ],
    question: request.claim,
    model: model.thinking ?? model.model,
    documents: tools,
    tools: [],
    toolSet: "check",
    retrieveFirst: true,
    thirdParty: request.thirdParty ?? [],
    support: model.support,
    structuredOutput: givesStructuredOutput(model.capabilities),
    takesTemperature: model.capabilities.facts.temperature,
    ...(model.capabilities.facts.forcedToolChoice === false && { forcedToolChoice: false }),
    window: model.window,
    ...(model.capabilities.facts.maxOutput !== undefined && {
      maxOutput: model.capabilities.facts.maxOutput,
    }),
    retryQuotes: model.retryQuotes,
    cacheKey: request.cacheKey,
    isReply: (text) => readVerdict(text) !== null,
    turnChecks,
    signal,
  })) {
    if (event.type === "text-delta") reply += event.text;
    else if (event.type === "text-retracted") reply = reply.slice(0, -event.length);
    else if (event.type === "text-set-aside") setAside = event.texts;
    else if (event.type === "failed") failed = event.error;
    else if (event.type === "finished") finished = true;
  }
  if (signal.aborted) return notChecked("stopped");
  if (failed) {
    return {
      ...failedCheck(failed),
      ...(failed.kind === "refused" && { retryRefusal: true as const }),
    };
  }
  if (!finished || reply.trim() === "") return notChecked("empty");
  // A model may write its verdict beside `cite` and only its sentence after: the turns from that
  // verdict on are read as one. A turn after it that declines takes the verdict back.
  const turns = [...setAside, reply];
  const read = readReply(reply, setAside);
  if (!read) return notChecked(turns.some(readsAsRefusal) ? "refused" : "malformed");
  if (!looked() && !restsOnOwnFigure(read)) return notChecked("unread");

  session.check();
  const found = (markers: readonly number[]) =>
    uniqueCitations(
      markers.flatMap((marker) => {
        const citation = session.finalCitation(marker);
        return citation?.check === "found" ? [citation] : [];
      }),
    );
  const named = found(read.evidence ?? []);
  const quotes =
    named.length > 0 ? named : found(Array.from({ length: MARKERS_READ }, (_, at) => at + 1));
  const [quoted, ...more] = quotes;
  const recordedQuotes = () =>
    found(Array.from({ length: MARKERS_READ }, (_, at) => at + 1)).map((each) => each.quote);
  // A verdict with no quote of its own rests on the working, where the model worked the figure
  // out over a data file's rows: IncarnaMind confirms that the code finished, on the whole file.
  const runs = workings();
  const worked = runs.findLast((run) => run.end.kind === "done");
  if (!quoted && runs.length > 0) {
    const last = worked ?? runs.at(-1);
    const file = last ? (rowsOf(last)[0]?.citation.documentName ?? last.title) : null;
    if (!worked) return notChecked(last ? endedAs(last) : "rows-run-failed", file);
    if (rowsOf(worked).some((rows) => rows.cut)) return notChecked("rows-cut", file);
  }
  // A verdict rests on the Library only where the code gave a number: a run that read the lists
  // and gave none told the model nothing.
  const counted = worked?.output.results.some((each) => each.kind === "figure") === true;
  const lists = worked && counted ? libraryRead(worked) : undefined;
  const working = worked && { ...workingOf(worked), ...(lists && { library: lists.read }) };
  const evidence =
    quoted ?? (worked ? (rowsOf(worked)[0]?.citation ?? lists?.citation) : undefined);
  const result = ((): Judged => {
    if (read.verdict === "unsupported")
      return {
        verdict: "unsupported",
        evidence: null,
        says: null,
        unsupported: {
          ...(read.word && { word: read.word }),
          reason: read.says,
          covered: null,
          uncovered: null,
          ...(quoted && { found: true as const, quoted }),
        },
        calculation: null,
        ...(working && { working }),
        ...court.citedCase(null),
        ...facts(),
        ...(read.word === "own-view" && more.length > 0 && { more }),
        excluded: [...facts().excluded, ...results.ownWorkings()],
      };
    // The one thing IncarnaMind confirms: the verdict's quote is in its Document.
    if (!evidence && !restsOnOwnFigure(read)) return notChecked("no-evidence");
    const correction =
      read.correction &&
      correctionOf(request.claim, read.correction, quoted ? quotes : evidence ? [evidence] : []);
    return {
      verdict: read.verdict,
      evidence: evidence ?? null,
      ...(correction && { correction }),
      says: read.says,
      unsupported: null,
      calculation: null,
      ...(working && { working }),
      // A line of working shows only where its arithmetic adds up over the quotes' numbers (#3393).
      ...(read.working &&
        workingAddsUp(read.working, recordedQuotes()) !== false && { workedOut: read.working }),
      ...court.citedCase(evidence ?? null),
      ...facts(),
      ...(more.length > 0 && { more }),
    };
  })();
  return leftOut ? withoutDocumentLeftOut(result, leftOut.name) : result;

  /** The correction a contradiction offers: words the sentence has, and a quote that was found. */
  function correctionOf(
    claim: string,
    { from, wording, marker }: NonNullable<ReadVerdict["correction"]>,
    quotes: readonly Citation[],
  ): ClaimCorrection | null {
    const quoted = marker === null ? null : session.finalCitation(marker);
    const source = quoted?.check === "found" ? quoted : quotes[0];
    if (!source || !claim.includes(from) || from === wording) return null;
    // Never paste a raw pipe-delimited table row into a prose sentence, nor replace an entire
    // claim sentence (which drops its subject when the model pastes a shorter quote, #3339).
    if (wording.includes("|") && !from.includes("|") && !claim.includes("|")) return null;
    const stripEnd = (value: string) =>
      value
        .trim()
        .replace(/[.!?。！？…]+$/u, "")
        .trim();
    if (isClaim(claim) && stripEnd(from) === stripEnd(claim)) return null;
    return { from, choices: [{ wording, evidence: source }] };
  }
}
