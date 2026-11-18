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
import type {
  CheckFigure,
  Citation,
  CitationLocation,
  ClaimCheckResult,
  ClaimCorrection,
  DataKind,
  Document,
  ProviderError,
  ThirdPartyReason,
} from "../../api";
import type { Evidence, EvidenceScope } from "../../documents/evidence";
import type { Language } from "../../language";
import { checkCalculates, givesStructuredOutput } from "../../providers/capabilities";
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
  };
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
  cited?: readonly CheckedCitation[];
  /** The sentence's figures that IncarnaMind worked out itself: its check is told what each is. */
  figures?: readonly CheckFigure[];
  scope: EvidenceScope;
  model: PreparedChatModel;
  /**
   * What of the checks flow this check may send, the consent it was prepared on; all of it when
   * left out. Without "worked-figures" (the contradiction watch's), how its figures were worked
   * out stays on this computer, and the sentence is judged from the Passages alone.
   */
  sends?: readonly DataKind[];
  /** The Run reads the document being checked (#97): it is third-party from its start. */
  thirdParty?: readonly ThirdPartyReason[];
  /** The Note the sentence is in, whose source choices and earlier record cites apply. */
  mindId?: string;
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
   * (./decisionFirst). Given, they order each search's hits, and no reranking model runs.
   */
  about?: ReadonlyMap<string, number>;
  signal: AbortSignal;
}

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
const asWhole = (claim: string, { more, ...result }: Judged): ClaimCheckResult =>
  claim.length === 0
    ? { ...result, parts: [] }
    : resultFromParts([
        partWithResult({ kind: "fact", span: { start: 0, end: claim.length } }, result, more),
      ]);

/** A sentence's result, with the quotes that decide it beside the first, which its card shows too. */
type Judged = ClaimCheckResult & { more?: readonly Citation[] };

export function createClaimCheck(deps: ClaimCheckDependencies) {
  return async (request: ClaimCheckRequest): Promise<ClaimCheckResult> => {
    const result = await judged(deps, request);
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
  const { scoped, session, decisions, citedShown, looked, searches, tools } = setUpRun(
    deps,
    request,
    results,
    calculates,
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
  const figures =
    request.sends === undefined || request.sends.includes("worked-figures" satisfies DataKind)
      ? (request.figures ?? [])
      : [];
  const restsOnOwnFigure = (read: ReadVerdict) =>
    read.verdict === "supported" && figures.length > 0;
  const recorded = (read: ReadVerdict) =>
    (read.evidence ?? []).some((marker) => session.tools.hasRecord?.(marker) ?? false);
  // Each asks the model once, for something its reply lacks; none of them reads its verdict.
  const turnChecks: TurnCheck[] = [
    {
      name: "search-first",
      check(text) {
        const read = readVerdict(text);
        return read && !looked() && !restsOnOwnFigure(read)
          ? { claims: [], note: SEARCH_FIRST }
          : null;
      },
    },
    {
      name: "search-again",
      check: (text) =>
        looked() && searches() <= 1 && readVerdict(text)?.verdict === "unsupported"
          ? { claims: [], note: SEARCH_AGAIN }
          : null,
    },
    {
      name: "cite-first",
      check(text) {
        const read = readVerdict(text);
        return read &&
          looked() &&
          read.verdict !== "unsupported" &&
          !recorded(read) &&
          !restsOnOwnFigure(read)
          ? { claims: [], note: CITE_FIRST, requires: "cite" }
          : null;
      },
    },
  ];
  const language = deps.language();
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
      ),
    messages: [
      { role: "user", content: claimPrompt({ ...request, figures, citedShown, language }) },
    ],
    question: request.claim,
    model: model.thinking ?? model.model,
    documents: tools,
    tools: [],
    toolSet: "check",
    thirdParty: request.thirdParty ?? [],
    support: model.support,
    structuredOutput: givesStructuredOutput(model.capabilities),
    takesTemperature: model.capabilities.facts.temperature,
    ...(model.provider.kind === "openrouter" && {
      forcedToolChoice: model.capabilities.facts.forcedToolChoice,
    }),
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
  if (failed) return failedCheck(failed);
  if (!finished || reply.trim() === "") return notChecked("empty");
  // A model may write its verdict beside `cite` and only its sentence after: the turns from that
  // verdict on are read as one. A turn after it that declines takes the verdict back.
  const turns = [...setAside, reply];
  const from = turns.findLastIndex((turn) => readVerdict(turn) !== null);
  const read =
    from < 0 || turns.slice(from + 1).some(readsAsRefusal)
      ? null
      : readVerdict(turns.slice(from).join("\n"));
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
  const [evidence, ...more] = quotes;
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
          ...(evidence && { found: true as const, quoted: evidence }),
        },
        calculation: null,
        ...court.citedCase(null),
        ...facts(),
        excluded: [...facts().excluded, ...results.ownWorkings()],
      };
    // The one thing IncarnaMind confirms: the verdict's quote is in its Document.
    if (!evidence && !restsOnOwnFigure(read)) return notChecked("no-evidence");
    const correction = read.correction && correctionOf(request.claim, read.correction, quotes);
    return {
      verdict: read.verdict,
      evidence: evidence ?? null,
      ...(correction && { correction }),
      says: read.says,
      unsupported: null,
      calculation: null,
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
    return source && claim.includes(from) && from !== wording
      ? { from, choices: [{ wording, evidence: source }] }
      : null;
  }
}
