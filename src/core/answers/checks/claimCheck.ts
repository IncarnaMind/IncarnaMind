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

import { citedInputs } from "../../../shared/calculatedFigures";
import { type CaseCitation, caseCitations, isOpinionOf } from "../../../shared/caseCitations";
import { writtenLike } from "../../../shared/figureSchedule";
import {
  type Figure,
  type FigureContext,
  FiguresNotRead,
  readFigures,
} from "../../../shared/figures";
import { type MessageKey, type MessageParams, translate } from "../../../shared/i18n";
import type { InlineTextProjection } from "../../../shared/inlineText";
import { LIBRARY_FACTS } from "../../../shared/libraryFacts";
import { formatLocation, joinUnits, locationOf, quoteInUnits } from "../../../shared/locations";
import { isPeriod } from "../../../shared/periods";
import { NUMBERS } from "../../../shared/rewriteWords";
import { sentenceSpans } from "../../../shared/sentences";
import { type UnreadFigures, unreadFiguresDetail } from "../../../shared/unreadFigures";
import type {
  CheckedVersion,
  CheckFigure,
  Citation,
  CitationAttributes,
  CitationLocation,
  CitationSupport,
  ClaimCalculation,
  ClaimCheckFailure,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimCorrection,
  ClaimJudgment,
  ClaimPartCoverage,
  ClaimPartPlan,
  ClaimPartSpan,
  Document,
  FigureCheckResult,
  FigureInput,
  LeftOutDocument,
  LimitRelation,
  PassageSearchResult,
  ProviderError,
  SearchScope,
  ThirdPartyReason,
  UnsupportedReason,
} from "../../api";
import type { CitationSource } from "../../documents";
import type { Evidence, EvidenceScope } from "../../documents/evidence";
import type { PageText } from "../../documents/passages";
import type { WindowedPassage } from "../../documents/search";
import { isRecord } from "../../errors";
import type { Language } from "../../language";
import { checkCalculates, givesStructuredOutput } from "../../providers/capabilities";
import type { PreparedChatModel } from "../../providers/chat";
import { OUTPUT_LIMITS, outputTokens } from "../../providers/outputLimits";
import type { RecordCitePlace } from "../../recordCites/referents";
import type { Slots } from "../../runs/stop";
import {
  answerLanguage,
  type CalculationSession,
  createCalculationSession,
  documentFigureContext,
  givenList,
  toldFigure,
  whole,
} from "../calculations";
import { givenAmounts } from "../changedScale";
import {
  type AnswerDocuments,
  createCitationSession,
  documentNamedAmong,
  matchingOf,
} from "../citations";
import {
  type AnswerEngine,
  type AnswerTools,
  answerTemperature,
  type CitationRecordInput,
  type CiteOptions,
  type DocumentLanguage,
  documentToolDefinitions,
  type SearchResultForModel,
} from "../engine";
import { fieldsOf, type Judged, json, judge, lines, list, type NotJudged } from "../judge";
import type { TurnCheck, TurnFinding } from "../turnChecks";
import { checkAbsence, fitsWholeRead, type Presence } from "./absence";
import { agreesWith, comparedFigure, statedFigure } from "./calculated";
import { needsCalculation } from "./calculationGate";
import { explainedIn } from "./explanations";
import {
  aboutSomeoneElse,
  analysisItemDisagrees,
  checkFigureReply,
  figureJudgment,
  givesItsOwnNumber,
  oneVerdict,
  readFigureReply,
  readFigureSource,
  uncheckedFigureResults,
  verdictMarkers,
  withSentenceVerdict,
} from "./figureChecks";
import { type FilePropertySearch, withFileProperties } from "./fileProperties";
import { type LibraryFactSearch, type LibraryListing, withLibraryFacts } from "./libraryFacts";
import { figuresMatch, nearestLine } from "./nearest";
import {
  type AbsenceAnswer,
  CHECK_TAGS,
  CONFIRM_INSTRUCTIONS,
  COVERED_EVIDENCE_INSTRUCTIONS,
  changesItsMind,
  checkInstructions,
  claimPrompt,
  confirmParts,
  deniesItself,
  EVIDENCE_INSTRUCTIONS,
  evidenceParts,
  givesNoEvidence,
  heldDetailLines,
  NEAREST_INSTRUCTIONS,
  namesNothing,
  ownDetailDiffers,
  ownDetailUnread,
  ownWords,
  PRESENCE_INSTRUCTIONS,
  partInstructions,
  presenceParts,
  type ReadCorrection,
  type ReadVerdict,
  readEvidence,
  readJudgement,
  readPart,
  readPresence,
  readRecheck,
  readsAsRefusal,
  readVerdict,
  recheckInstructions,
  replyAcrossTurns,
  STRICT_INSTRUCTIONS,
  STRICT_PRESENCE_INSTRUCTIONS,
} from "./prompt";
import { searchAgain } from "./searchAgain";
import { type BoundNumber, type CheckedText, dollarClause, unitNotStated } from "./units";

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
}

/** A Citation the sentence has, as its check reads it: `passageId` when it quotes the Document as it is now. */
export interface CheckedCitation {
  documentName: string;
  quote: string;
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

/** Why a provider's failure left a claim not checked. */
export function failureOf(error: ProviderError): {
  reason: ClaimCheckFailure;
  detail: string | null;
} {
  switch (error.kind) {
    case "rate-limit":
      return { reason: "rate-limit", detail: null };
    case "cost-cap":
      // The budget and the spend, as JSON, for the card to say in the User's currency format.
      return error.budget
        ? { reason: "read-budget", detail: JSON.stringify(error.budget) }
        : { reason: "cost-cap", detail: null };
    case "plan-limit":
      return { reason: "plan-limit", detail: null };
    case "out-of-credit":
      return { reason: "out-of-credit", detail: null };
    case "consent-revoked":
      return { reason: "consent-revoked", detail: null };
    case "local-mode":
      return { reason: "local-mode", detail: null };
    case "no-answer":
      return { reason: "empty", detail: null };
    case "cut-short":
      return { reason: "cut-short", detail: null };
    default:
      return { reason: "failed", detail: error.message };
  }
}

/** A claim check's failure that the run's other claims share: waited out, or it stops the run. */
export function runFailureOf(result: ClaimCheckResult): ProviderError | null {
  if (result.verdict !== "not-checked") return null;
  const { reason } = result;
  if (reason !== "rate-limit" && reason !== "cost-cap" && reason !== "plan-limit") return null;
  return { kind: reason, message: result.detail ?? reason };
}

const SEARCH_FIRST =
  "You gave a verdict without searching the User's Documents. Search them with search_documents first, then give your verdict from what you find.";

/** A whole read's window, searched again: every search of it finds the same Passages. */
const WINDOW_SHOWN: SearchResultForModel = {
  text: "Every search in this check finds the same Passages, and an earlier search returned them all: answer with them.",
  passageCount: 0,
};

export type AtomicClaimCheckResult = ClaimCheckResult & {
  checkedEvidence?: readonly Citation[];
  coverage?: ClaimPartCoverage;
  /** In a whole-read window: the Passages that reached the model in the request it answered. */
  readPassages?: readonly string[];
  /** In a whole-read window: the absence the sentence states holds in this window's text. */
  absenceHeld?: true;
};
const FIGURES_LINE =
  "Your reply has no Figures line that can be read. Write your whole reply again, ending with the one Figures: line, its JSON object on that line.";

const REMAINDER_LINE =
  'Your Figures line gives no remainder. Give "remainder": null when the sentence asserts nothing beyond its figures, or its other assertion as the instructions say, then write your whole reply again.';

const analysisNamesNote = (problems: readonly string[]) =>
  [
    "Your Figures line disagrees with itself for an Analysis's figure:",
    ...problems,
    'For each, give "names":"same" with verdict supported, relation equals, topic found, roles same and scope same only when the sentence names the figure as its label and rule say; "names":"other" with verdict unsupported when it names another figure; otherwise "names":"unclear" with verdict unsupported. Then write your whole reply again.',
  ].join("\n");

const figureSourcesNote = (problems: readonly string[], unrecorded: readonly number[]) =>
  [
    ...(unrecorded.length > 0
      ? [
          `Your Figures line names ${unrecorded.map((marker) => `[^${marker}]`).join(", ")}, never recorded: call cite now with each quote it uses, under the marker you gave it.`,
        ]
      : []),
    ...(problems.length > 0
      ? ["Some sources in your Figures line can't be read:", ...problems.map((each) => `- ${each}`)]
      : []),
    "Fix each one, then write your whole reply again, its Figures line included.",
  ].join("\n");

/**
 * A verdict whose requested figures aren't bound is asked for once more, as `calculate` answers
 * an input it can't read: Claude Haiku 5.5 wrote its verdict and stopped, skipped the cite
 * call, or left out the heading that states a sheet's unit, for about a third of sentences
 * with figures. A figure the model calls contradicted or unsupported is asked about only when
 * its source gives the very number it contradicts; with a source that can't be read it is
 * Unsupported, since asked to cite a number its quote doesn't hold, Claude Haiku 5.5 often wrote
 * prose in place of its reply (#2184). A remainder is asked for only when the reply's own verdict
 * is Supported: a stricter one stands for the sentence's other words (`withSentenceVerdict`).
 * `asking` is told each reply asked about, read across its turns by `across`, which keeps the
 * Duty and Condition lines held back across an earlier ask (#1766).
 */
function figuresReplied(
  request: ClaimCheckRequest,
  calculations: Pick<CalculationSession, "number" | "figure">,
  searched: () => boolean,
  recorded: (marker: number) => boolean,
  asking: (text: string) => void,
  across: (last: string, setAside?: readonly string[]) => string,
): TurnCheck[] {
  const figures = request.figures ?? [];
  const asked = (text: string) => figures.length > 0 && searched() && readVerdict(text) !== null;
  const ask = (text: string, finding: TurnFinding): TurnFinding => {
    asking(text);
    return finding;
  };
  return [
    {
      name: "figures-line",
      check(last, setAside = []) {
        const text = across(last, setAside);
        if (!asked(text)) return null;
        const read = readFigureReply(text, figures, request.claim);
        if (!read) return ask(text, { claims: [], note: FIGURES_LINE });
        // Without its remainder a Supported reply can't be settled, so it is asked for as the line is.
        return read.remainder === undefined && readVerdict(text)?.verdict === "supported"
          ? ask(text, { claims: [], note: REMAINDER_LINE })
          : null;
      },
    },
    {
      // The judge decides an Analysis figure: a reply whose fields disagree is asked once (#2378).
      name: "analysis-names",
      check(last, setAside = []) {
        const text = across(last, setAside);
        const read = asked(text) ? readFigureReply(text, figures, request.claim) : null;
        if (!read) return null;
        const problems = read.items.flatMap((item) => {
          const target = figures.find((figure) => figure.id === item.id);
          // One the request gave no evidence for, behind a wall, has nothing to name.
          const disagrees =
            target?.calculated?.figure.analysis && target.analysisRecord?.label !== undefined
              ? analysisItemDisagrees(item)
              : null;
          return target && disagrees ? [`${target.reading.chars}: ${disagrees}.`] : [];
        });
        return problems.length > 0
          ? ask(text, { claims: [], note: analysisNamesNote(problems) })
          : null;
      },
    },
    {
      name: "figures-sources",
      check(last, setAside = []) {
        const text = across(last, setAside);
        const read = asked(text) ? readFigureReply(text, figures, request.claim) : null;
        if (!read) return null;
        // A supported figure with no source must record its quote, not only write it in prose:
        // told to give its source, Claude Haiku 5.5 wrote a marker and no cite, and the check ended
        // no-evidence with a quote the reader could see.
        let needsCite = false;
        const problems = read.items.flatMap((item) => {
          const target = figures.find((figure) => figure.id === item.id);
          if (!target) return [];
          if (item.verdict !== "supported") {
            const judged = item.topic === "found" && item.scope === "same" && item.roles === "same";
            const source =
              judged && item.verdict === "contradicted" && item.source
                ? readFigureSource(calculations, target, item.source)
                : null;
            if (source && "input" in source && givesItsOwnNumber(target, source.input))
              return [
                `${target.reading.chars}: you call it contradicted, but its source gives the same number, ${source.input.number.chars}; give as source the number the Document gives for its own subject, period, column and unit, or the verdict that number gives.`,
              ];
            // Claude Haiku 5.5 left a case it could read undecided: it gave neither the number the
            // Document states nor what differs, so its verdict rests on nothing a reader can see.
            // An Analysis's figure and a saved calculation have no source in a Document by design.
            return !target.calculated &&
              target.analysisRecord == null &&
              item.source === null &&
              item.calculation === null &&
              item.says === null
              ? [
                  `${target.reading.chars}: you give neither the Document's number nor what differs; give as source the number the Document gives for its own subject, period, column and unit, with the reading its context takes where its readings offer one, or the verdict that number gives.`,
                ]
              : [];
          }
          if (!item.source && item.calculation !== null && !calculations.figure(item.calculation))
            return [
              `${target.reading.chars}: calculation [=${item.calculation}] wasn't worked out in this check; call calculate for it, or give its source.`,
            ];
          if (!item.source) {
            if (item.calculation !== null || target.calculated) return [];
            needsCite = true;
            return [
              `${target.reading.chars}: a supported figure needs its source (a quote recorded with cite, and the number as it writes it) or its calculation.`,
            ];
          }
          const source = readFigureSource(calculations, target, item.source);
          return "problem" in source ? [`${target.reading.chars}: ${source.problem}`] : [];
        });
        const remainder = read.remainder?.citation;
        if (remainder && !recorded(remainder))
          problems.push(`remainder: [^${remainder}] isn't recorded; record it with cite first.`);
        const unrecorded = [
          ...new Set(
            [
              ...read.items.flatMap((item) =>
                item.verdict === "supported" && item.source?.citation ? [item.source.citation] : [],
              ),
              ...(remainder ? [remainder] : []),
            ].filter((marker) => !recorded(marker)),
          ),
        ];
        return problems.length > 0 || unrecorded.length > 0
          ? ask(text, {
              claims: [],
              note: figureSourcesNote(problems, unrecorded),
              ...((unrecorded.length > 0 || needsCite) && { requires: "cite" }),
            })
          : null;
      },
    },
  ];
}

/**
 * A check reads only what a Document's words say: no date beside its Passages. The one Answers see
 * (#548) is its file's created or modified day, or the latest year its first page mentions, and a
 * check read it as the Document's own date: "dated 2026" was backed by a contract's delivery start,
 * "自 2026 年 11 月起" (#2311).
 */
export const NO_DATE = (): null => null;

/** Passages as every check shows them, and so counts them: with its prompt's tags defused (#2423). */
export const checkSession = (documents: Parameters<typeof createCitationSession>[0]) =>
  createCitationSession(documents, { onRecord: () => undefined, defuses: CHECK_TAGS });

function citedSources(
  cited: readonly CheckedCitation[],
  scope: EvidenceScope,
  documents: ClaimCheckDependencies["documents"],
): CitationSource[] {
  const found = new Map<string, CitationSource>();
  for (const { passageId } of cited) {
    const source = passageId ? documents.citationSource(passageId) : null;
    if (
      !source ||
      source.documentDeleted ||
      source.notCited ||
      scope.excluded.has(source.documentId) ||
      (scope.documentIds !== null && !scope.documentIds.includes(source.documentId))
    )
      continue;
    found.set(source.passageId, source);
  }
  return [...found.values()];
}

function checkedTextOf(
  citation: Citation,
  pageTexts: ClaimCheckDependencies["documents"]["pageTexts"],
): CheckedText {
  const text = (from: number | null, to: number | null) =>
    pageTexts(citation.documentId, citation.contentHash, from, to)
      .map((unit) => unit.text)
      .join("\n");
  return {
    cited: () =>
      citation.pageFrom === null ? citation.quote : text(citation.pageFrom, citation.pageTo),
    document: () => text(null, null),
  };
}

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

const asPassage = (source: CitationSource): WindowedPassage => ({
  ...source,
  seq: 0,
  position: 0,
  windowFrom: 0,
  windowTo: 0,
});

const calculatesIn = (
  model: Pick<PreparedChatModel, "support" | "capabilities">,
  request: Pick<ClaimCheckRequest, "figures">,
): boolean =>
  model.support === "tools" &&
  checkCalculates(model.capabilities) &&
  // An Analysis's figures are worked out by IncarnaMind already: a sentence of only those has
  // nothing to calculate, and a calculation of one would only fail its check (#2378).
  !(
    request.figures?.length && request.figures.every((figure) => figure.calculated?.figure.analysis)
  );

/** What a check Run starts from: its sentence, read in its paragraph, beside what it cites. */
export type CheckStart = Pick<ClaimCheckRequest, "claim" | "context" | "cited" | "figures"> & {
  /** Its first turn names the sentence's parts (`ClaimCheckRequest.findParts`). */
  findsParts?: boolean;
  /** It may show the Library's facts (`ClaimCheckRequest.searched`), so it sorts as their checks do. */
  library?: boolean;
};

/** A check Run's instructions, for the way its model gives Citations, and its prompt. */
function runStart(request: CheckStart, language: Language, calculating: boolean) {
  return {
    instructions: (mode: CitationSupport | "no-documents", passages?: string) =>
      checkInstructions(
        mode,
        language,
        passages,
        calculating,
        (request.figures?.length ?? 0) > 0,
        request.findsParts === true,
        request.library === true,
        request.claim,
      ),
    prompt: (citedShown: string | null) => claimPrompt({ ...request, citedShown, language }),
  };
}

/**
 * What every request of a check Run sends before the Passages its search returns: its
 * instructions, its prompt and its Tools' definitions, as the Run builds them. A model that can't
 * call Tools is sent the Passages in its instructions, and no Tools.
 */
export function checkRunStart(
  deps: Pick<ClaimCheckDependencies, "documents" | "language">,
  request: CheckStart & { scope: EvidenceScope },
  model: Pick<PreparedChatModel, "support" | "capabilities">,
): { instructions: string; prompt: string; tools: string } {
  const calculating = calculatesIn(model, request);
  const start = runStart(request, deps.language(), calculating);
  const cited = citedSources(request.cited ?? [], request.scope, deps.documents);
  const { documents } = deps;
  const session = checkSession({
    citationSource: (passageId) => documents.citationSource(passageId),
    pageTexts: (documentId, contentHash, from, to) =>
      documents.pageTexts(documentId, contentHash, from, to),
    documentDate: NO_DATE,
  });
  const mode = model.support ?? "tools";
  const tools: AnswerTools = {
    documentCount: 1,
    documentLanguages: deps.documents.searchableLanguages(request.scope.documentIds),
    ...(deps.documents.getMany && { fileProperties: true }),
    searchDocuments: async () => ({ text: "", passageCount: 0 }),
    cite: () => "",
    ...(calculating && { calculate: () => "" }),
  };
  return {
    instructions: start.instructions(mode),
    prompt: start.prompt(cited.length > 0 ? session.measure(cited.map(asPassage)) : null),
    tools: mode === "tools" ? documentToolDefinitions(tools, "check") : "",
  };
}

export function createClaimCheck(deps: ClaimCheckDependencies) {
  return withLibraryFacts(deps, (withLibrary) =>
    withFileProperties(withLibrary, createSentenceCheck),
  );
}

function createSentenceCheck(deps: ClaimCheckDependencies) {
  // The Passages each check was given or shown, so that a text whose figures couldn't be read is
  // named by the one it came from.
  const passagesOf = new WeakMap<ClaimCheckRequest, () => readonly string[]>();
  // A check's judgement of the quotes it was given after its verdict, for its Supported result.
  const judgedAfter = new WeakMap<
    ClaimCheckRequest,
    (result: AtomicClaimCheckResult) => Promise<AtomicClaimCheckResult>
  >();
  const unitsOf = (citation: Citation) =>
    deps.documents.pageTexts(citation.documentId, citation.contentHash, null, null);
  const check = async function checkClaim(
    request: ClaimCheckRequest,
  ): Promise<AtomicClaimCheckResult> {
    const { scope, signal } = request;
    const outsideCited = (request.cited ?? []).flatMap((citation) => {
      const source = citation.passageId ? deps.documents.citationSource(citation.passageId) : null;
      if (!source || deps.walledDocument(source.documentId) === null) return [];
      const outside =
        scope.documentIds === null ||
        !scope.documentIds.includes(source.documentId) ||
        scope.excluded.has(source.documentId);
      return outside ? [{ citation, source }] : [];
    });
    if (request.cited && request.cited.length > 0 && outsideCited.length === request.cited.length) {
      const [kept] = outsideCited;
      if (!kept) throw new Error("An outside Citation is missing.");
      return {
        verdict: "not-checked",
        reason: "kept-inside",
        detail: deps.walledFolderName(kept.source.documentId) ?? kept.source.documentName,
        versions: [],
        excluded: [],
      };
    }
    let searches = 0;
    const read = new Map<string, string>();
    const readPassages = new Set<string>();
    const excluded = new Map<string, LeftOutDocument>();
    const decisions = caseCitations(request.originalClaim ?? request.claim);
    const workings = new Map<string, PassageSearchResult[]>();
    const scoped: AnswerDocuments = {
      searchableCount: () => deps.documents.searchableCount(scope.documentIds),
      // A search may name one Document, as an Answer's may: the one a Citation quotes, often.
      documentNamed: (name) =>
        documentNamedAmong(
          deps.documents
            .searchableBySize(scope.documentIds)
            .filter((each) => !scope.excluded.has(each.id)),
          name,
        ),
      async search(query, searchSignal, within, options) {
        const found = request.window
          ? null
          : await deps.evidence.search(
              query,
              within ? { ...scope, documentIds: [...within] } : scope,
              searchSignal,
            );
        // A web search's result never settles a citation of a court decision.
        const matched = (request.window ?? found?.passages ?? []).filter(
          (passage) => decisions.length === 0 || !deps.documents.savedBySearch(passage.documentId),
        );
        const passages = [
          ...matched,
          ...(options?.properties && deps.fileProperties
            ? deps.fileProperties.add(matched, within, options)
            : []),
          ...(options?.library && deps.libraryFacts ? deps.libraryFacts.add() : []),
        ];
        if (!request.window) {
          for (const passage of passages) read.set(passage.documentId, passage.contentHash);
        }
        for (const each of found?.excluded ?? []) {
          if (each.reason === "own-workings") {
            workings.set(each.documentId, [
              ...(workings.get(each.documentId) ?? []),
              ...each.passages,
            ]);
          }
          if (excluded.has(each.documentId)) continue;
          excluded.set(each.documentId, {
            documentId: each.documentId,
            documentName: each.documentName,
            reason: each.reason,
          });
        }
        return passages;
      },
      citationSource: (passageId) => deps.documents.citationSource(passageId),
      pageTexts: (documentId, contentHash, from, to) =>
        deps.documents.pageTexts(documentId, contentHash, from, to),
      documentDate: NO_DATE,
      passagesBetween: (documentId, from, to) =>
        deps.documents.passagesBetween(documentId, from, to),
    };
    // Which of two Documents that disagree is newer orders a correction's choices (#1481): the
    // host's own date for each, never shown to the model as the Document's words.
    const newestFirst = (documentId: string) => deps.documents.documentDate(documentId);
    const session = checkSession(scoped);
    // The words a Citation quotes don't say where they stand: a sheet row's year is in its
    // sheet's name and heading row, which the check reads only in the Passage itself (#1459).
    const citedPassages = citedSources(request.cited ?? [], scope, deps.documents);
    for (const passage of citedPassages) read.set(passage.documentId, passage.contentHash);
    const citedShown = citedPassages.length > 0 ? session.show(citedPassages.map(asPassage)) : null;
    passagesOf.set(request, () => [
      ...citedPassages.map((passage) => passage.passageId),
      ...session.shownPassages().map((passage) => passage.passageId),
    ]);
    // The Passages a Citation quotes are shown from the scope, so a verdict on them has looked.
    const looked = () => searches > 0 || citedShown !== null;
    const { model } = request;
    const calculating = calculatesIn(model, request);
    const recorded = new Set<number>();
    let attempts = 0;
    let invalidInput = false;
    let calculationFailures = 0;
    const pending = new Map<number, StatedNumber>();
    const figures = createCalculationSession({
      documents: scoped,
      quotes: session.quotes,
      language: answerLanguage(request.claim),
      onRecord: (marker) => recorded.add(marker),
    });
    /** The sentence's number each figure is for, as the model named it, and how, by marker. */
    const stated = new Map<number, StatedNumber>();
    /** In a whole read's window: whether a search has returned the window, the searches in turn. */
    let windowShown: Promise<boolean> = Promise.resolve(false);
    const tools: AnswerTools = {
      get documentCount() {
        return session.tools.documentCount;
      },
      documentLanguages: deps.documents.searchableLanguages(scope.documentIds),
      ...(deps.fileProperties && { fileProperties: true }),
      ...(deps.libraryFacts && { libraryFacts: true }),
      // Only the model's searches count: looking up a cited court decision shows it nothing.
      searchDocuments: (query, searchSignal, options) => {
        searches++;
        if (!request.window) {
          const { fileProperties, libraryFacts } = deps;
          return session.tools.searchDocuments(query, searchSignal, options).then((found) => {
            const told =
              options?.properties && fileProperties ? fileProperties.told(found, options) : found;
            return options?.library && libraryFacts ? libraryFacts.told(told) : told;
          });
        }
        // Claude Haiku 5.5 searched a window two or three times, at once or in turn, and each
        // search returned the whole window again: its verdict request carried it two or three
        // times (#1554).
        const found = windowShown.then((shown) =>
          shown ? WINDOW_SHOWN : session.tools.searchDocuments(query, searchSignal, options),
        );
        windowShown = found.then(
          (result) => result === WINDOW_SHOWN || result.passageCount > 0,
          () => false,
        );
        return found;
      },
      cite: (records, options) => session.tools.cite(records, options),
      hasRecord: (marker) => session.tools.hasRecord?.(marker) ?? false,
      unfoundQuotes: () => session.tools.unfoundQuotes?.() ?? [],
      correctQuote: (marker, quote) => session.tools.correctQuote?.(marker, quote) ?? false,
      ...(calculating && {
        calculationFailed() {
          attempts++;
          invalidInput = true;
          calculationFailures++;
          stated.clear();
        },
        calculate(given: readonly unknown[], options?: CiteOptions) {
          // An empty list works nothing out: Claude Haiku 5.5 sends one beside a plain cite, and the
          // quote alone decides such a sentence (#2002).
          if (given.length === 0) return figures.calculate(given, options);
          attempts++;
          if (calculationFailures >= 2)
            return "The calculation and its repair were refused. Finish the check and say the arithmetic could not be checked.";
          recorded.clear();
          const named = new Map<number, StatedNumber>();
          for (const each of given) {
            const fields =
              typeof each === "object" && each !== null ? (each as Record<string, unknown>) : {};
            const marker = whole(fields.marker);
            const inputs = Array.isArray(fields.inputs) ? (fields.inputs as unknown[]) : [];
            const costs = inputs.flatMap((input) => {
              const { name, bracketedCost } = (input ?? {}) as Record<string, unknown>;
              return bracketedCost === true && typeof name === "string" ? [name] : [];
            });
            if (marker !== null && typeof fields.stated === "string" && fields.stated.trim() !== "")
              named.set(marker, {
                number: fields.stated.trim(),
                ...((fields.relation === "at most" || fields.relation === "at least") && {
                  relation: fields.relation,
                }),
                costs: new Set(costs),
                given: each,
              });
          }
          const result = figures.calculate(givenList(given), options);
          const unbound = [...named].find(([marker, number]) => {
            if (!recorded.has(marker)) return false;
            const citation = figures.figure(marker)?.inputs[0]?.citation;
            return !statedFigure(
              request.claim,
              number.number,
              citation ? figureContext(citation) : {},
            );
          });
          invalidInput = named.size !== given.length || unbound !== undefined;
          if (invalidInput) {
            stated.clear();
            calculationFailures++;
            return unbound
              ? `Nothing was recorded for this sentence: stated ${JSON.stringify(unbound[1].number)} is not a readable quantity in the sentence. Copy the exact quantity characters from the sentence in its original language. ${calculationFailures >= 2 ? "The calculation and its repair were refused; finish the check and say the arithmetic could not be checked." : "Repair this input once with calculate."}`
              : result;
          }
          for (const [marker, number] of named) {
            if (recorded.has(marker)) {
              stated.set(marker, number);
              const citation = figures.figure(marker)?.inputs[0]?.citation;
              const context = citation ? figureContext(citation) : {};
              const repaired = statedFigure(request.claim, number.number, context);
              for (const [failedMarker, failed] of pending) {
                const previous = statedFigure(request.claim, failed.number, context);
                if (
                  repaired &&
                  previous?.start === repaired.start &&
                  failed.relation === number.relation
                )
                  pending.delete(failedMarker);
              }
            } else {
              stated.delete(marker);
              pending.set(marker, number);
              // A quote on a citation the sentence has, or one already recorded, may only be a
              // `cite` that ran in this same turn: that is no failed repair (#2719). A citation
              // that neither names can never be recorded, so it uses the one repair.
              const cites =
                (number.given as { inputs?: readonly unknown[] } | undefined)?.inputs ?? [];
              const known = cites.every((input) => {
                const marker =
                  typeof input === "object" && input !== null
                    ? whole((input as Record<string, unknown>).citation)
                    : null;
                return (
                  marker === null ||
                  marker <= (request.cited?.length ?? 0) ||
                  session.tools.hasRecord?.(marker) === true
                );
              });
              if (!known) calculationFailures++;
            }
          }
          // The model is told the figure it will be judged on: a cost it marked as printed in
          // brackets is taken at its size, as the card shows it (#1908).
          let toldAtSize = result;
          for (const [marker, number] of stated) {
            const figure = figures.figure(marker);
            const citation = figure?.inputs[0]?.citation;
            const own =
              citation && statedFigure(request.claim, number.number, figureContext(citation));
            const compared = figure && own ? comparedFigure(own, figure, number.costs) : null;
            if (figure && compared && compared !== figure)
              toldAtSize = toldAtSize.replace(toldFigure(marker, figure), () =>
                toldFigure(marker, compared),
              );
          }
          return toldAtSize;
        },
      }),
    };

    /**
     * A figure calculated before the `cite` beside it recorded its quote is worked out again once
     * the quote is there: a turn's Tool calls run at once, and Claude Haiku 5.5 calls `calculate`
     * and `cite` in one turn, so the calculation raced the record and left the check Not checked.
     */
    const retryPendingQuotes = () => {
      for (const entry of [...pending.values()]) {
        if (entry.given === undefined) continue;
        const fields =
          typeof entry.given === "object" && entry.given !== null
            ? (entry.given as Record<string, unknown>)
            : {};
        const inputs = Array.isArray(fields.inputs) ? fields.inputs : [];
        const markers = inputs.flatMap((input) => {
          const marker =
            typeof input === "object" && input !== null
              ? whole((input as Record<string, unknown>).citation)
              : null;
          return marker === null ? [] : [marker];
        });
        if (markers.length === 0) continue;
        if (markers.every((marker) => session.tools.hasRecord?.(marker) === true))
          tools.calculate?.([entry.given]);
      }
    };

    const unstatedUnit = (
      citations: readonly Citation[],
      claim = request.claim,
      bound?: readonly BoundNumber[],
      worked?: readonly Figure[],
    ): { why: UnsupportedReason; quote: Citation | null; decides: boolean } | null => {
      const checked = citations.map((citation) => ({
        citation,
        ...checkedTextOf(citation, scoped.pageTexts),
      }));
      const found = unitNotStated(claim, checked, bound, worked);
      if (!found) return null;
      const t = (key: MessageKey, params?: MessageParams) =>
        translate(deps.language(), key, params);
      const { amount } = found;
      const candidates = checked
        .filter((text) => found.matches.some((each) => each.text === text))
        .map(({ citation }) => citation);
      const unique = new Map(
        candidates.map((citation) => [
          JSON.stringify([
            citation.documentId,
            citation.contentHash,
            citation.passageId,
            citation.pageFrom,
            citation.pageTo,
            citation.location,
            citation.quote,
          ]),
          citation,
        ]),
      );
      const repeated = found.matches.some((each, at) =>
        found.matches
          .slice(0, at)
          .some((earlier) => earlier.text === each.text && earlier.start !== each.start),
      );
      const single = !repeated && unique.size === 1 ? (unique.values().next().value ?? null) : null;
      const quote =
        single &&
        readFigures(single.quote, { ...figureContext(single), midLine: true }).some(
          (figure) => figure.chars === amount,
        )
          ? single
          : null;
      const problem = (why: UnsupportedReason, decides = false) => ({ why, quote, decides });
      if (found.kind === "which dollar" || found.kind === "yuan sign") {
        const document = candidates[0]?.documentName ?? "";
        const key =
          found.kind === "which dollar"
            ? "claim.unsupported.whichDollar"
            : "claim.unsupported.yuanSign";
        // The Document doesn't say the currency, so it neither backs nor contradicts one (#2226).
        const reason = t(key, { document, amount });
        return problem({ reason, covered: null, uncovered: null, found: true }, true);
      }
      // A Library fact's number is the Library's, not a Document's (#2525).
      const unitKey =
        candidates.length > 0 && candidates.every((each) => each.documentId === LIBRARY_FACTS)
          ? "claim.unsupported.unit.library"
          : "claim.unsupported.unit";
      if (found.kind === "scale") {
        return problem({
          found: true,
          reason: t(unitKey, { amount, figure: found.figure }),
          covered: t("claim.unsupported.currency.covered", { amount }),
          uncovered: t("claim.unsupported.scale.uncovered", { figure: found.figure }),
        });
      }
      if (found.kind === "unit") {
        const reason = t(unitKey, { amount, figure: found.figure });
        return problem({ reason, covered: null, uncovered: null, found: true });
      }
      return problem({
        found: true,
        reason: t("claim.unsupported.currency.reason", { amount }),
        covered: t("claim.unsupported.currency.covered", { amount }),
        uncovered: t("claim.unsupported.currency.uncovered", { currency: found.currency }),
      });
    };
    let retainedEvidence: Citation[] = [];
    let namedEvidence: Citation[] = [];
    let retainedCoverage: ClaimPartCoverage | undefined;
    const facts = () => ({
      ...(retainedEvidence.length > 0 && { checkedEvidence: retainedEvidence }),
      ...(retainedCoverage && { coverage: retainedCoverage }),
      versions: [...read].map(
        ([documentId, contentHash]): CheckedVersion => ({ documentId, contentHash }),
      ),
      excluded: [...excluded.values()].filter(
        (each) =>
          each.reason === "own-file" ||
          each.reason === "own-note" ||
          each.reason === "checked-document" ||
          each.reason === "same-text",
      ),
      ...(request.window && { readPassages: [...readPassages] }),
    });
    const workingsSayingIt = (): LeftOutDocument[] =>
      [...workings].flatMap(([documentId, passages]) => {
        const left = excluded.get(documentId);
        const speaks = passages.some(
          (passage) =>
            figuresMatch(request.claim, passage.text) &&
            nearestLine(request.claim, [{ id: passage.passageId, text: passage.text }]),
        );
        return left && speaks ? [left] : [];
      });
    const unchecked = (reason: ClaimCheckFailure, detail: string | null = null): ClaimJudgment => ({
      verdict: "not-checked",
      reason,
      detail,
      ...facts(),
    });
    const notChecked = (
      reason: ClaimCheckFailure,
      detail: string | null = null,
    ): ClaimCheckResult => {
      const result = unchecked(reason, detail);
      return request.figures?.length ? uncheckedFigureResults(request.figures, result) : result;
    };
    const failedCheck = (error: ProviderError): ClaimCheckResult => {
      const { reason, detail } = failureOf(error);
      return notChecked(reason, detail);
    };
    /** A judge's question that came to no reading, as the sentence's result says it. */
    const unjudged = (failure: NotJudged): ClaimCheckResult => {
      if (failure.reason === "stopped") return notChecked("stopped");
      if (failure.error) return failedCheck(failure.error);
      return notChecked(failure.reason === "refused" ? "refused" : "malformed");
    };

    let opinions: Opinions;
    try {
      opinions = await opinionsOf(decisions, scoped, signal);
    } catch (error) {
      if (signal.aborted) return notChecked("stopped");
      throw error;
    }
    const citedCase = (evidence: Citation | null) => ({
      citedCaseUnchecked: opinions.missing,
      citedCaseFound:
        !opinions.missing &&
        evidence !== null &&
        opinions.documentIds.has(evidence.documentId ?? ""),
    });
    let fits: boolean | undefined;
    const readsWhole = () => {
      fits ??= fitsWholeRead(request.scope.documentIds, deps.documents);
      return fits;
    };
    const absenceFor = async (
      absence: AbsenceAnswer,
      searched: ClaimCheckResult["verdict"],
    ): Promise<AtomicClaimCheckResult | null> => {
      // A search that found and cited the thing contradicts its absence as any sentence is
      // contradicted: the whole read decides only whether search may say Supported.
      if (searched === "contradicted") return null;
      // A check that ended Not checked (refused, unread, no verdict) stays so: no whole read.
      if (searched === "not-checked") return null;
      if (absence === "no") return null;
      // An answer that can't be read may hide an absence, which search alone never backs; and
      // the whole read is only for a sentence known to assert one.
      if (absence === null) return searched === "supported" ? notChecked("malformed") : null;
      if (signal.aborted) return notChecked("stopped");
      return checkAbsence({
        request,
        documents: deps.documents,
        session,
        versions: read,
        facts,
        citedCase,
        fits: readsWhole(),
        notChecked,
        failedCheck,
        lookAt: (evidence, absent, first) =>
          lookForPresence(request, evidence, absent, session, signal, first),
      });
    };

    const figureContext = (citation: Citation) =>
      documentFigureContext(
        scoped.pageTexts(citation.documentId, citation.contentHash, null, null),
      );
    const confirmations = new Map<string, Promise<boolean>>();
    let confirmationFailure: NotJudged | null = null;
    const requiresCalculation = async (verdict: ReadVerdict | null): Promise<boolean> => {
      if (!calculating || !verdict) return false;
      session.check();
      const checked = calculated(request.claim, figures, stated, figureContext);
      const citations = [
        ...foundCitations(session.finalCitation, null, verdict.evidence ?? undefined),
        ...checked.flatMap(({ calculation }) =>
          calculation.figure.inputs.map((input) => input.citation),
        ),
      ];
      if (invalidInput || pending.size > 0) return true;
      if (
        attempts === 0 &&
        citations.length === 0 &&
        session.shownPassages().some((passage) => passage.text.includes(request.claim.trim()))
      )
        return false;
      return needsCalculation({
        claim: request.claim,
        verdict,
        attempted: attempts > 0,
        computed: checked.map(({ number }) => number),
        inputs: checked.flatMap(({ calculation }) =>
          calculation.figure.inputs.map((input) => input.number),
        ),
        citations: citations.map((citation) => ({
          citation,
          units: scoped.pageTexts(citation.documentId, citation.contentHash, null, null),
        })),
        confirm: (figure, quoted) => {
          const key = JSON.stringify([figure.start, figure.end, quoted]);
          const existing = confirmations.get(key);
          if (existing) return existing;
          const confirmed = compare(
            request,
            quoted,
            session,
            signal,
            { id: "strict-figure", instructions: STRICT_INSTRUCTIONS },
            readJudgement,
            figure,
          ).then((result) => {
            if (!result.ok && (result.error || result.reason === "stopped"))
              confirmationFailure = result;
            return result.ok && result.value === "same";
          });
          confirmations.set(key, confirmed);
          return confirmed;
        },
      });
    };

    let reply = "";
    let heard = "";
    let parted = false;
    const hear = (text: string) => {
      if (parted || !request.findParts) return;
      parted = true;
      request.findParts(text);
    };
    let setAside: readonly string[] = [];
    // The Duty and Condition lines that took support away before an ask about something else: the
    // engine sets aside no turn across an ask, and a difference the check wrote down holds (#1766).
    // An ask for those very lines drops them, as the reply written again answers it.
    let heldBack: readonly string[] = [];
    const across = (last: string, aside: readonly string[] = []) =>
      replyAcrossTurns(last, heldBack.length > 0 ? [heldBack.join("\n"), ...aside] : aside);
    // Set by any reply that compared other words than the sentence's, whether or not the ask was
    // still free: a later reply that gives none is held back as one that gives other words.
    let askedForOwnWords = false;
    let askedAbout: string | null = null;
    let failed: ProviderError | null = null;
    let finished = false;
    // A run that read a Document a wall keeps from this check backs nothing here, and what it read
    // never goes to the model: its label, rows and code stay out of the request (#2378).
    const walledRun = (figure: CheckFigure) =>
      (figure.analysisRecord?.citations ?? []).some(
        ({ documentId }) =>
          deps.walledDocument(documentId) !== null &&
          (scope.documentIds === null ||
            !scope.documentIds.includes(documentId) ||
            scope.excluded.has(documentId)),
      );
    const asked: ClaimCheckRequest = {
      ...request,
      ...(request.figures && {
        figures: request.figures.map((figure) =>
          figure.analysisRecord && walledRun(figure)
            ? {
                ...figure,
                analysisRecord: {
                  recalculated: figure.analysisRecord.recalculated,
                  citations: figure.analysisRecord.citations,
                },
              }
            : figure,
        ),
      }),
    };
    const start = runStart(
      {
        ...asked,
        findsParts: request.findParts !== undefined,
        library: deps.libraryFacts !== undefined,
      },
      deps.language(),
      calculating,
    );
    for await (const event of deps.engine.generate({
      instructions: (mode, options) => start.instructions(mode, options?.passages),
      messages: [{ role: "user", content: start.prompt(citedShown) }],
      question: request.claim,
      model: model.model,
      documents: tools,
      ...(request.window && {
        fitted: (passageIds: readonly string[]) => {
          const fitted = new Set(passageIds);
          for (const passage of request.window ?? []) {
            if (!fitted.has(passage.passageId)) continue;
            read.set(passage.documentId, passage.contentHash);
            readPassages.add(passage.passageId);
          }
        },
      }),
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
      ...(request.findParts && { afterFirstStep: hear }),
      // A model may give its verdict before it has looked: Claude Haiku 5.5 did, about one check
      // in six of a whole Mind.
      turnChecks: [
        {
          name: "search-first",
          check: (text) =>
            !looked() && readVerdict(text) ? { claims: [], note: SEARCH_FIRST } : null,
        },
        // In a window of a whole read every search returns that window: the read is the search.
        ...(request.window ? [] : [searchAgain(() => searches, readsWhole)]),
        ...(deps.fileProperties ? [deps.fileProperties.turnCheck] : []),
        ...(deps.libraryFacts
          ? [deps.libraryFacts.turnCheck(() => session.tools.recordedQuotes?.() ?? [])]
          : []),
        ...figuresReplied(
          asked,
          figures,
          looked,
          (marker) => session.tools.hasRecord?.(marker) ?? false,
          (text) => {
            askedAbout = text;
          },
          across,
        ),
        {
          name: "calculate-first",
          // A sentence checked figure by figure gives each figure's calculation on its Figures
          // line (`figuresReplied`), never a Calculation line.
          check: async (text) =>
            !request.figures?.length &&
            attempts === 0 &&
            (await requiresCalculation(readVerdict(text)))
              ? {
                  claims: [],
                  note: "The numerical check is incomplete. If the Documents let you work out the claim's quantity or comparison, call calculate with the cited inputs, formula and stated quantity before giving a verdict. Never calculate in your head. If a Document states the claim directly, record its deciding quote and write Calculation: none. Otherwise name each required quantity on a Calculation: line; if its inputs cannot be found, say that it could not be calculated.",
                }
              : null,
        },
        {
          name: "roles-own-words",
          check: (text, aside) => {
            const read = across(text, aside);
            const verdict = readVerdict(read);
            if (!verdict || !comparesOtherWords(verdict, request.claim, false)) return null;
            askedForOwnWords = true;
            return { claims: [], writeOnly: true, note: ROLES_OWN_WORDS };
          },
        },
        {
          name: "own-detail",
          check: (text, aside) => {
            const read = across(text, aside);
            const verdict = readVerdict(read);
            // One line that already differs takes the support away: no ask can give it back.
            if (
              verdict?.verdict !== "supported" ||
              ownDetailDiffers(verdict) ||
              !ownDetailUnread(verdict)
            )
              return null;
            return {
              claims: [],
              writeOnly: true,
              note: deniesItself(read) ? DETAIL_DENIED : DETAIL_LINES,
            };
          },
        },
      ],
      onAsk: (note, last, aside) => {
        heldBack =
          note === DETAIL_LINES || note === DETAIL_DENIED
            ? []
            : heldDetailLines(across(last, aside));
      },
      signal,
    })) {
      if (event.type === "text-delta") {
        reply += event.text;
        heard += event.text;
      } else if (event.type === "text-retracted") reply = reply.slice(0, -event.length);
      else if (event.type === "text-set-aside") setAside = event.texts;
      else if (event.type === "failed") failed = event.error;
      else if (event.type === "finished") finished = true;
    }
    if (!failed) hear(heard);
    deps.fileProperties?.replied(across(reply, setAside));
    deps.libraryFacts?.replied(across(reply, setAside));
    if (signal.aborted) return notChecked("stopped");
    if (failed) return failedCheck(failed);
    if (request.figures?.length) {
      if (!finished || reply.trim() === "") return notChecked("empty");
      const written = across(reply, setAside);
      // Its last word changed its mind: neither verdict, nor an earlier reply's, stands (#2817).
      if (changesItsMind(written)) return notChecked("malformed");
      // Asked about its Figures line, a model that can't do what it was asked may write prose
      // in place of its reply ("I can't rewrite that Figures entry…"): the reply asked about stands.
      // One that writes only its Figures line again leaves its verdict on the sentence standing.
      const text =
        askedAbout !== null &&
        readVerdict(written) === null &&
        readFigureReply(written, request.figures, request.claim) === null
          ? askedAbout
          : written;
      if (readsAsRefusal(text)) return notChecked("refused");
      // A refusal after an ask is the model's last word: the reply asked about can still make the
      // sentence stricter, never Supported.
      const declined = text !== written && readsAsRefusal(written);
      if (!looked()) return notChecked("unread");
      // A saved figure is worked out again from its own inputs, within the check's scope.
      const saved = new Map(
        citedSources(
          request.figures
            .flatMap((figure) =>
              figure.calculated && !figure.calculated.figure.analysis
                ? citedInputs(figure.calculated.figure)
                : [],
            )
            .flatMap((input) => [
              input.citation,
              ...(input.unitStatement ? [input.unitStatement.citation] : []),
            ]),
          scope,
          deps.documents,
        ).map((source) => [source.passageId, source] as const),
      );
      session.show(
        [...saved.values()].map((source) => ({
          ...source,
          seq: 0,
          position: 0,
          windowFrom: 0,
          windowTo: 0,
        })),
      );
      session.check();
      // The run's final reply decides each figure: an earlier reply's Figures line never stands
      // over a later reply that gives none, or another (#2591). A final turn that answers in prose
      // instead of a reply keeps the reply asked about, for the sentence and its figures (#2184).
      const figuresText = text;
      if (invalidInput || pending.size > 0) {
        retryPendingQuotes();
        session.check();
        if (invalidInput) return notChecked("no-evidence");
        // A figure left pending may be a calculation the model abandoned for a readable source:
        // only a reply that still rests on an unworked calculation can't be decided (#2719).
        if (pending.size > 0) {
          const read = readFigureReply(figuresText, request.figures, request.claim);
          const reliesOnUnrecorded =
            read?.items.some(
              (item) => item.calculation !== null && !figures.figure(item.calculation),
            ) ?? false;
          if (reliesOnUnrecorded) return notChecked("no-evidence");
        }
      }
      const judged = async (
        said: ReadVerdict,
        words: string,
        evidence: Citation | null,
      ): Promise<ClaimJudgment> => {
        const result = figureJudgment(said, evidence, facts(), citedCase(evidence));
        if (result.verdict !== "contradicted" || !evidence) return result;
        const confirmation = await confirmContradiction(
          { ...request, claim: words, figures: undefined },
          evidence,
          session,
          signal,
        );
        if ("failed" in confirmation) {
          const failure = failureOf(confirmation.failed);
          return unchecked(failure.reason, failure.detail);
        }
        if (confirmation.kind === "stopped") return unchecked("stopped");
        if (confirmation.kind === "malformed") return unchecked("malformed");
        if (confirmation.kind === "confirmed") return result;
        const doubted = figureJudgment(
          { ...said, verdict: "unsupported" },
          evidence,
          facts(),
          citedCase(evidence),
        );
        // Not upheld, it is Unsupported as a sentence without figures is: its card shows the part
        // the quote states, quoting it, when the reply names that part.
        return doubted.verdict === "unsupported" && said.covered && said.uncovered
          ? { ...doubted, unsupported: { ...UNBACKED, ...doubted.unsupported, quoted: evidence } }
          : doubted;
      };
      const verdictText = readVerdict(text) === null ? (askedAbout ?? text) : text;
      const said = readVerdict(verdictText);
      const checkedFigures = await checkFigureReply({
        requested: request.figures,
        claim: request.claim,
        ...(request.context !== undefined && { paragraph: request.context }),
        reply: figuresText,
        calculations: figures,
        citation: (marker) => session.finalCitation(marker),
        facts,
        caseFlags: citedCase,
        costs: (marker) => stated.get(marker)?.costs ?? new Set(),
        unitReason: (figure, citations, bound) =>
          unstatedUnit(citations, figure, bound)?.why ?? null,
        units: (citation) =>
          deps.documents.pageTexts(citation.documentId, citation.contentHash, null, null),
        around: (citation) => {
          const text = checkedTextOf(citation, scoped.pageTexts);
          // With no pages cited, the cited text is the quote alone, which places it nowhere.
          return citation.pageFrom === null ? [text.document()] : [text.cited(), text.document()];
        },
        otherMeasure: (amount, measure, claimed) => ({
          reason: translate(deps.language(), "claim.unsupported.otherMeasure", {
            amount,
            measure,
            claimed,
          }),
          covered: null,
          uncovered: null,
          found: true,
        }),
        unitsMayDiffer: (amount) => ({
          kind: "units",
          reason: translate(deps.language(), "claim.unsupported.unitsMayDiffer", { amount }),
          covered: null,
          uncovered: null,
          found: true,
        }),
        keptInside: (documentId) =>
          deps.walledDocument(documentId) !== null &&
          (scope.documentIds === null ||
            !scope.documentIds.includes(documentId) ||
            scope.excluded.has(documentId))
            ? (deps.walledFolderName(documentId) ?? documentId)
            : null,
        misnamed: (label) => ({
          kind: "analysis-name",
          reason: translate(deps.language(), "claim.analysisName", { label }),
          covered: null,
          uncovered: null,
          found: true,
        }),
        signal,
        remainder: (remainder) =>
          judged(
            remainder,
            remainder.text,
            remainder.citation === null ? null : session.finalCitation(remainder.citation),
          ),
      });
      // The reply's own Roles line gives the sentence to someone its Passage doesn't name: each
      // number bound to that Passage is someone else's, and neither backs nor contradicts it.
      const result = said?.roles === "other" ? aboutSomeoneElse(checkedFigures) : checkedFigures;
      // The sentence's contradiction is judged on the quote its own words cite, not a figure's.
      // A sentence whose words cite no quote of their own rests on its figures' quotes, so a
      // Supported verdict never turns a result its figures settled into Not checked.
      const cited =
        verdictMarkers(verdictText)
          .map((marker) => session.finalCitation(marker))
          .find((citation) => citation?.check === "found") ??
        decidingCitation(session.finalCitation) ??
        (result.verdict === "not-checked" ? null : result.evidence);
      // A contradiction with no quote found is asked for its quote once, as a sentence without
      // figures is: Claude Haiku 5.5 wrote its record into the reply instead of calling cite in
      // about one contradicted check in seven (#2184). Asked under the markers its Evidence line
      // names, the record is also the quote its Change and To lines give (#1481).
      const unrecorded = (verdict: ReadVerdict): number[] => {
        const rejected = new Set(session.summary().rejectedRecords.map(({ marker }) => marker));
        const named = [...new Set(verdict.evidence ?? [])];
        return named.every(
          (marker) => session.finalCitation(marker) === null && !rejected.has(marker),
        )
          ? named
          : [];
      };
      const sentence = async (verdict: ReadVerdict): Promise<ClaimJudgment> => {
        if (declined && verdict.verdict === "supported") return unchecked("refused");
        if (comparesOtherWords(verdict, request.claim, askedForOwnWords))
          return unchecked("malformed");
        if (
          verdict.verdict === "supported" &&
          ownDetailUnread(verdict) &&
          !ownDetailDiffers(verdict)
        )
          return unchecked("malformed");
        const evidence =
          cited ??
          (verdict.verdict === "contradicted"
            ? await askForEvidence(request, verdict, session, signal, null, unrecorded(verdict))
            : null);
        if (signal.aborted) return unchecked("stopped");
        if (!isFailed(evidence)) return judged(verdict, request.claim, evidence);
        const failure = failureOf(evidence.failed);
        return unchecked(failure.reason, failure.detail);
      };
      if (signal.aborted) return result;
      const figureResult = oneVerdict(
        said
          ? await withSentenceVerdict(result, () => sentence(said), said.correction?.from ?? null)
          : // Figures that all check out never make a sentence Supported without a verdict to read.
            result.verdict === "supported"
            ? await withSentenceVerdict(result, async () => unchecked("malformed"))
            : result,
      );
      // A correction is kept only on the one result it changes, the contradicted figure or else the
      // rest of the words, and only when every other result stands or is a figure it writes over.
      const withCorrection = (checked: ClaimCheckResult): ClaimCheckResult => {
        if (checked.verdict !== "contradicted" || checked.remainder === undefined) return checked;
        const figures = checked.figures ?? [];
        const { remainder } = checked;
        const results = [
          ...figures.map((figure) => figure.result),
          ...(remainder ? [remainder] : []),
        ];
        if (results.filter((each) => each.verdict === "contradicted").length !== 1) return checked;
        const sentence = request.originalClaim ?? request.claim;
        if (
          figures.some(
            (figure) =>
              figure.calculated ||
              ("calculation" in figure.result &&
                figure.result.calculation &&
                !checkedNumber(figure)) ||
              figure.locator.kind !== "text" ||
              figure.context !== sentence ||
              figure.footing.length > 0 ||
              (figure.sourceFooting?.length ?? 0) > 0,
          )
        )
          return checked;
        const context = documentFigureContext([{ text: sentence }]);
        const corrected = (
          read: ReadCorrection | undefined,
          citation: (marker: number) => Citation | null,
        ) => correctionFor(sentence, request.claim, read, citation, newestFirst, context, unitsOf);
        const stated = corrected(said?.correction, session.finalCitation);
        const owner = figures.find((figure) => figure.result.verdict === "contradicted");
        let found = stated;
        // Figures the old words write over, all or some of their words ("1,500" of "1,500 units").
        const writesOver = (from: string, chars: string) =>
          readFigures(from, context).some((old) => chars.includes(old.chars));
        if (owner) {
          const deciding = checkedNumber(owner);
          const changes = (from: string, to: string) => {
            const first = request.claim.indexOf(from);
            const written = writtenAt(request.claim, first, from, to, context) ?? [];
            return (
              readFigures(from, context).length === 1 &&
              writesOver(from, owner.reading.chars) &&
              (deciding
                ? // The Document may write its number twice: 人民币九万八千元（¥98,000）.
                  written.some((each) => sameNumber(each, deciding.number))
                : written.length === 1 && written[0]?.unit.kind === owner.reading.unit.kind)
            );
          };
          // The figure's own check already found the Document's number and its quote, so the
          // correction is that number in place of the sentence's: Claude Haiku 5.5 named the whole
          // sentence as its old words (#1481). Its Change and To lines stand when they change this
          // figure to the same number, in the Document's words, as they can give a second
          // Document's.
          found = stated?.correction.choices.every((choice) =>
            changes(stated.correction.from, choice.wording),
          )
            ? stated
            : // A number of the other sign never takes this one's place: the sentence's "a loss
              // of 1,250" is the Document's "(1,250)".
              deciding && Math.sign(deciding.number.value) === Math.sign(owner.reading.value)
              ? corrected(
                  {
                    from: owner.reading.chars,
                    choices: [{ wording: deciding.number.chars, marker: 1 }],
                  },
                  () => deciding.citation,
                )
              : null;
        } else {
          // Old words of the rest of the sentence lie outside its figures, where the reply names
          // that rest, unless they write over a figure; a sentence judged whole may be corrected
          // anywhere.
          const rest = readFigureReply(
            figuresText,
            request.figures ?? [],
            request.claim,
          )?.remainder;
          if (
            !stated ||
            (rest &&
              !rest.text.includes(stated.correction.from) &&
              !figures.some((figure) => writesOver(stated.correction.from, figure.reading.chars)))
          )
            return checked;
        }
        if (!found) return checked;
        // Every other result stands, or is a figure whose words the correction writes over: its
        // number couldn't be compared, and the Document's takes its place.
        const { from } = found.correction;
        if (
          figures.some(
            (figure) =>
              figure !== owner &&
              figure.result.verdict !== "supported" &&
              !(figure.result.verdict === "unsupported" && writesOver(from, figure.reading.chars)),
          ) ||
          (owner && remainder && remainder.verdict !== "supported")
        )
          return checked;
        const decision = {
          evidence: found.evidence,
          correction: found.correction,
          ...citedCase(found.evidence),
        };
        return {
          ...checked,
          ...decision,
          figures: figures.map((figure) =>
            figure === owner ? { ...figure, result: { ...figure.result, ...decision } } : figure,
          ),
          remainder:
            !owner && remainder?.verdict === "contradicted"
              ? { ...remainder, ...decision }
              : remainder,
        };
      };
      const absence = await absenceFor(said?.absence ?? null, figureResult.verdict);
      return absence ?? withCorrection(figureResult);
    }
    if (confirmationFailure) return unjudged(confirmationFailure);
    if (invalidInput || pending.size > 0) return notChecked("no-evidence");
    const checked = calculated(request.claim, figures, stated, figureContext);
    retainedEvidence = uniqueCitations(
      checked.flatMap(({ calculation }) =>
        calculation.figure.inputs.flatMap((input) => [
          input.citation,
          ...(input.unitStatement ? [input.unitStatement.citation] : []),
        ]),
      ),
    );
    // A sentence the reply's Roles line gives to someone its Passages don't name is no sentence of
    // theirs: no figure worked out from their numbers backs or contradicts it (#1766).
    const elsewhere = readVerdict(across(reply, setAside))?.roles === "other";
    const worked = elsewhere
      ? null
      : (checked.find(({ calculation }) => !calculation.agrees) ?? checked[0] ?? null);
    // A figure that disagrees contradicts the sentence. One that agrees settles only that number:
    // the model's verdict still stands on the rest of the sentence.
    if (worked && !worked.calculation.agrees) {
      return {
        verdict: "contradicted",
        evidence: worked.evidence,
        says: null,
        unsupported: null,
        calculation: worked.calculation,
        ...citedCase(worked.evidence),
        ...facts(),
      };
    }
    if (!finished || reply.trim() === "") return notChecked("empty");
    const refused = readsAsRefusal(reply);
    let verdict = readVerdict(across(reply, setAside));
    if (!verdict) return notChecked(refused ? "refused" : "malformed");
    if (!looked()) return notChecked("unread");
    // Whatever its verdict line says: a contradiction's judgements compared only the figures
    // ("Managers… 30 days" against the Employee's 27), and an absence's whole read would find
    // nothing of them either (#1766).
    if (elsewhere)
      return {
        verdict: "unsupported",
        evidence: null,
        says: null,
        unsupported: { reason: verdict.says, covered: null, uncovered: null, found: true },
        calculation: null,
        ...citedCase(null),
        ...facts(),
      };
    session.check();
    if (verdict.evidence === null || verdict.coverage === null) return notChecked("malformed");
    const namedMarkers = [
      ...(verdict.evidence ?? []),
      ...(verdict.coverage?.members.flatMap((member) => member.evidence) ?? []),
      ...(verdict.coverage?.domainEvidence ?? []),
    ];
    const rejectedMarkers = new Set(
      session.summary().rejectedRecords.map((record) => record.marker),
    );
    const missing = [
      ...new Set(namedMarkers.filter((marker) => session.finalCitation(marker) === null)),
    ];
    const givenAfter = new Set<string>();
    // A quote the model gave only when asked for one after its verdict was found on its page, never
    // compared with the sentence: each backs a Supported result only once the strict judgement finds,
    // on its own, that it says what the sentence says. Judged with a quote that does, an unrelated
    // one was carried through (#2816).
    judgedAfter.set(request, async (result) => {
      if (result.verdict !== "supported") return result;
      const notGiven = <T extends CitationKeyed>(list: readonly T[]): T[] =>
        list.filter((each) => !givenAfter.has(citationKey(each)));
      const cited = uniqueCitations([
        ...(result.evidence ? [result.evidence] : []),
        ...(result.checkedEvidence ?? []),
      ]);
      for (const citation of cited.filter((each) => givenAfter.has(citationKey(each)))) {
        const judged = await compare(
          request,
          citation,
          session,
          signal,
          { id: "strict", instructions: STRICT_INSTRUCTIONS },
          readJudgement,
        );
        if (judged.ok && judged.value === "same") continue;
        // The Not checked result shows none of those quotes either.
        retainedEvidence = notGiven(retainedEvidence);
        if (retainedCoverage) {
          retainedCoverage = {
            ...retainedCoverage,
            members: retainedCoverage.members.map((member) => ({
              ...member,
              evidence: notGiven(member.evidence),
            })),
            domainEvidence: notGiven(retainedCoverage.domainEvidence),
          };
        }
        if (signal.aborted) return notChecked("stopped");
        if (!judged.ok && judged.error) return failedCheck(judged.error);
        return notChecked("no-evidence");
      }
      return result;
    });
    if (
      missing.length > 0 &&
      !namedMarkers.some((marker) => {
        const citation = session.finalCitation(marker);
        return (citation !== null || rejectedMarkers.has(marker)) && citation?.check !== "found";
      })
    ) {
      const recovered = await askForEvidence(request, verdict, session, signal, null, missing);
      if (isFailed(recovered)) failed = recovered.failed;
      for (const citation of missing.map((marker) => session.finalCitation(marker)))
        if (citation) givenAfter.add(citationKey(citation));
    }
    const namedCitations = namedMarkers.map((marker) => session.finalCitation(marker));
    namedEvidence = uniqueCitations([
      ...(verdict.evidence === undefined ? foundCitations(session.finalCitation, null) : []),
      ...namedCitations.filter((citation): citation is Citation => citation?.check === "found"),
    ]);
    retainedEvidence = uniqueCitations([...retainedEvidence, ...namedEvidence]);
    if (signal.aborted) return notChecked("stopped");
    if (failed) return failedCheck(failed);
    if (namedCitations.some((citation) => citation?.check !== "found"))
      return notChecked("no-evidence");
    if (verdict.coverage) {
      const coverage = verdict.coverage;
      const citations = (markers: readonly number[]) =>
        uniqueCitations(
          markers.flatMap((marker) => {
            const citation = session.finalCitation(marker);
            return citation?.check === "found" ? [citation] : [];
          }),
        );
      retainedCoverage = {
        unit: coverage.unit,
        quantifier: coverage.quantifier,
        complete: coverage.complete,
        members: coverage.members.map((member) => ({
          ...member,
          evidence: citations(member.evidence),
        })),
        domainEvidence: citations(coverage.domainEvidence),
      };
      const backed = coverage.members.filter((member) => member.verdict === "supported").length;
      const enough =
        coverage.quantifier === "most"
          ? backed > coverage.members.length / 2
          : backed === coverage.members.length;
      if ((!coverage.complete || !enough) && verdict.verdict === "supported") {
        verdict = { ...verdict, verdict: "unsupported", says: null };
      }
    }
    if (comparesOtherWords(verdict, request.claim, askedForOwnWords))
      return notChecked("malformed");
    // A Supported reply that gives no Duty or Condition word, even asked again, compared neither;
    // one whose other line differs is Unsupported below.
    if (verdict.verdict === "supported" && ownDetailUnread(verdict) && !ownDetailDiffers(verdict))
      return notChecked("malformed");
    const absence = await absenceFor(verdict.absence ?? null, verdict.verdict);
    if (absence) return absence;
    if (await requiresCalculation(verdict))
      return confirmationFailure ? unjudged(confirmationFailure) : notChecked("no-evidence");
    // A worked figure settles its number alone: never Supported over a reply that records another
    // duty or a dropped condition, or gives neither line (#1766, #1708).
    const byCalculation: ClaimCheckResult | null =
      worked && !ownDetailDiffers(verdict) && !ownDetailUnread(verdict)
        ? (await requiresCalculation({ ...verdict, verdict: "supported" }))
          ? notChecked("no-evidence")
          : {
              verdict: "supported",
              evidence: worked.evidence,
              says: null,
              unsupported: null,
              calculation: worked.calculation,
              ...citedCase(worked.evidence),
              ...facts(),
            }
        : null;
    if (confirmationFailure) return unjudged(confirmationFailure);
    /** Unsupported, with the nearest line when it states another value for the same thing (#770). */
    const unsupported = async (
      why: UnsupportedReason = { reason: null, covered: null, uncovered: null },
      found?: Citation | null,
      judgedNearest?: Citation | null,
    ): Promise<ClaimCheckResult> => {
      const nearest =
        judgedNearest === undefined
          ? await nearestDifferent(request, session, signal)
          : judgedNearest;
      if (signal.aborted) return notChecked("stopped");
      // A card that quotes the Passage covering part of the sentence never says it found nothing.
      // A sentence's own Citations, a court decision no Document holds, or only the User's own
      // workings saying it take the card instead, so their check asks for no quote.
      const quoted =
        nearest ||
        (!why.kind && (!why.covered || !why.uncovered)) ||
        (request.cited?.length ?? 0) > 0 ||
        opinions.missing ||
        workingsSayingIt().length > 0
          ? null
          : found === null
            ? null
            : (found ??
              decidingCitation(session.finalCitation) ??
              // Only the card's quote rests on it: the verdict stands without.
              notFailed(await askForEvidence(request, verdict, session, signal, why.covered)));
      if (signal.aborted) return notChecked("stopped");
      retainedEvidence = uniqueCitations([
        ...retainedEvidence,
        ...(quoted ? [quoted] : []),
        ...(nearest ? [nearest] : []),
      ]);
      const left = facts();
      return {
        verdict: "unsupported",
        evidence: nearest,
        says: null,
        unsupported: quoted ? { ...why, quoted } : why,
        calculation: worked?.calculation ?? null,
        ...citedCase(nearest),
        ...left,
        excluded: nearest ? left.excluded : [...left.excluded, ...workingsSayingIt()],
      };
    };
    // The fields-only second look (#2313): a judge's own reply that said it could not state the
    // sentence, and then said the claim is stated and the same, is asked once more. Only a field
    // of its second reply that differs counts, its Duty and Condition among them (#1766, #1708),
    // and it lowers the sentence to Unsupported; a second reply that calls it supported is Not
    // checked, as an inconsistent one is: on held-out sentences whose Passage gives only a goal, a
    // draft or another contract's terms, it called them supported with every field the same (#2816).
    const rechecked = async (
      again: ReadVerdict,
      shown: Citation | null,
    ): Promise<ClaimCheckResult> =>
      ownDetailDiffers(again) || again.scope === "wider"
        ? unsupported(
            {
              reason: again.says,
              covered: again.covered,
              uncovered: again.uncovered,
              found: true,
            },
            shown,
            null,
          )
        : notChecked("malformed");
    session.check();
    if (verdict.reasonKind) {
      return unsupported(
        {
          kind: verdict.reasonKind,
          reason: translate(
            deps.language(),
            verdict.reasonKind === "forecast-certainty" ? "claim.forecast" : "claim.unbackedCause",
          ),
          covered: verdict.covered,
          uncovered: verdict.uncovered,
          found: true,
        },
        namedEvidence[0] ?? null,
        null,
      );
    }
    if (verdict.verdict === "unsupported" && !byCalculation) {
      // Its fields say the claim is stated and the same, while its verdict says otherwise: ask
      // once more, and only a field that differs settles it (#2313, #2816).
      const stated = namedEvidence[0] ?? null;
      if (
        stated !== null &&
        verdict.topic === "found" &&
        verdict.scope === "same" &&
        verdict.roles === "same" &&
        (verdict.time === undefined || verdict.time === "same") &&
        !ownDetailDiffers(verdict) &&
        !ownDetailUnread(verdict) &&
        verdict.absence === "no" &&
        !unstatedUnit(
          [stated, ...retainedEvidence],
          request.claim,
          undefined,
          checked.map(({ number }) => number),
        )?.why &&
        quoteStatesDetail(request.claim, stated.quote)
      ) {
        const again = await compare(
          request,
          stated,
          session,
          signal,
          recheck(deps.language()),
          readRecheck,
        );
        return again.ok ? rechecked(again.value, stated) : unjudged(again);
      }
      // A part covered stands only for a claim whose own topic a Passage is about: the reply's own
      // field says so, so a neighbouring topic's line is never shown as part of the claim.
      const onTopic = verdict.topic !== "not found";
      const parts = onTopic && verdict.covered !== null && verdict.uncovered !== null;
      return unsupported({
        reason: verdict.says,
        covered: onTopic ? verdict.covered : null,
        uncovered: onTopic ? verdict.uncovered : null,
        ...((verdict.topic === "found" || parts) && { found: true }),
      });
    }
    const cited = namedEvidence[0] ?? (await askForEvidence(request, verdict, session, signal));
    if (cited && !isFailed(cited) && namedEvidence.length === 0) givenAfter.add(citationKey(cited));
    const evidence = cited ?? worked?.evidence ?? null;
    const onlyCalculation = cited === null && worked?.evidence != null;
    if (signal.aborted) return notChecked("stopped");
    if (isFailed(evidence)) return failedCheck(evidence.failed);
    if (!evidence) return notChecked("no-evidence");
    retainedEvidence = uniqueCitations([...retainedEvidence, evidence]);
    const deciding = retainedEvidence;
    const unitProblem = unstatedUnit(
      [
        evidence,
        ...retainedEvidence,
        ...checked.flatMap(({ calculation }) =>
          calculation.figure.inputs.map((input) => input.citation),
        ),
      ],
      request.claim,
      undefined,
      checked.map(({ number }) => number),
    );
    const unit = unitProblem?.why ?? null;
    if (unit && (verdict.verdict !== "contradicted" || onlyCalculation || unitProblem?.decides))
      return unsupported(unit, unitProblem?.quote ?? null, null);
    // An unsupported reply with no topic or part named can be missing only the derived figure.
    // Only a reason or part about that figure alone is settled; a found topic or any independent
    // reason or part stays unsupported.
    if (byCalculation && verdict.verdict === "unsupported") {
      const onTopic = verdict.topic !== "not found";
      const parts = onTopic && verdict.covered !== null && verdict.uncovered !== null;
      const derivedReason =
        worked !== null &&
        verdict.says !== null &&
        derivedFigureOnly(verdict.says, worked.calculation.stated, figureContext(worked.evidence));
      const derivedPart =
        worked !== null &&
        verdict.uncovered !== null &&
        derivedFigureOnly(
          verdict.uncovered,
          worked.calculation.stated,
          figureContext(worked.evidence),
        );
      const independentReason = verdict.says !== null && !derivedReason;
      const independentPart = parts && !derivedPart;
      if (
        independentReason ||
        independentPart ||
        (!derivedReason && !derivedPart && verdict.topic === "found")
      )
        return unsupported(
          {
            reason: verdict.says,
            covered: onTopic ? verdict.covered : null,
            uncovered: onTopic ? verdict.uncovered : null,
            found: true,
          },
          evidence,
        );
    }
    // The reply's own parts, else the model is asked for them once: a part too long to be a
    // phrase left Claude Sonnet 5.5's "Employees…" Supported (#1647).
    const parts = async (quoted: Citation | readonly Citation[]) =>
      verdict.covered && verdict.uncovered
        ? { covered: verdict.covered, uncovered: verdict.uncovered }
        : await partOf(request, quoted, session, signal, deps.language());
    // A general word for the Passage's own party is backed for that party only: the wider group
    // is the part the Documents don't cover (DESIGN.md › Checks). Another party, the parties the
    // other way round, or must for may is no support at all: Claude Haiku 5.5 called "must pay"
    // Supported against "may pay", then named the difference (#1668). The reply says each in a
    // field of its own, so the verdict doesn't rest on the model weighing it; so is whether a thing
    // has happened or is still to happen (#2311), and a duty or a condition put otherwise (#1766,
    // #1708).
    const differs = ownDetailDiffers(verdict);
    if (verdict.verdict === "supported" && (verdict.scope === "wider" || differs)) {
      const part = await parts(deciding);
      if (signal.aborted) return notChecked("stopped");
      if (isFailed(part)) return failedCheck(part.failed);
      // The Passage the check cited states the term's own value, so no nearest line is asked about.
      const nearest = differs ? undefined : null;
      if (part.covered && part.uncovered)
        return unsupported({ reason: verdict.says, ...part, found: true }, evidence, nearest);
      // Parts that can't be read still leave the sentence wider than its Passage: never Supported.
      return unsupported({ ...UNBACKED, reason: verdict.says });
    }
    if (verdict.verdict === "contradicted") {
      // The judgements disagree with the check: the card shows the part the quote states
      // (DESIGN.md › Checks).
      const inDoubt = async (): Promise<ClaimCheckResult> => {
        if (unit) return unsupported(unit, unitProblem?.quote ?? null, null);
        if (verdict.topic === "not found") return unsupported();
        const part = await parts(deciding);
        if (signal.aborted) return notChecked("stopped");
        if (isFailed(part)) return failedCheck(part.failed);
        if (!part.covered || !part.uncovered) return unsupported(UNBACKED);
        // A judgement has just compared this very quote with the sentence: no nearest line.
        return unsupported({ reason: verdict.says, ...part, found: true }, evidence, null);
      };
      const confirmation = await confirmContradiction(request, deciding, session, signal);
      if ("failed" in confirmation) return failedCheck(confirmation.failed);
      if (confirmation.kind === "stopped") return notChecked("stopped");
      // The Passage is about something else: what is nearest may still say something different.
      if (confirmation.kind === "unrelated") {
        return unit
          ? unsupported(unit, unitProblem?.quote ?? null, null)
          : unsupported(verdict.topic === "not found" ? undefined : UNBACKED);
      }
      // A part whose quote states it on its own, and whose own Roles, Time, Duty, Condition and
      // Scope agree: the reply's contradiction was about words outside the part, as a sentence's
      // figure is for a part about when it happened. Its fields disagree with its verdict, so it is
      // asked once more; its second reply can only lower it (#2313, #2816).
      const sentence = request.originalClaim;
      if (
        confirmation.kind === "states" &&
        !unit &&
        !byCalculation &&
        !ownDetailDiffers(verdict) &&
        !ownDetailUnread(verdict) &&
        verdict.scope !== "wider" &&
        !comparesOtherWords({ ...verdict, verdict: "supported" }, request.claim, true) &&
        sentence !== undefined &&
        isPartOf(sentence, request.claim) &&
        evidence !== null &&
        quoteStatesDetail(request.claim, evidence.quote)
      ) {
        const again = await compare(
          request,
          deciding,
          session,
          signal,
          recheck(deps.language()),
          readRecheck,
        );
        return again.ok ? rechecked(again.value, evidence) : unjudged(again);
      }
      // A whole sentence keeps the card of what the quote covers, never Supported: in one word it
      // called the parties the other way round the same (#1668, #2313).
      if (confirmation.kind === "doubt" || confirmation.kind === "states") return inDoubt();
      // A false contradiction is the worst verdict a check gives, and one judgement upheld near
      // misses (#1647): the strict one finds the quote doesn't state the sentence's detail, and
      // then the card shows the part the quote states (DESIGN.md › Checks). Its "same" doesn't
      // count: writing a Chinese sentence in English, it read a reversed reporting line backwards.
      if (confirmation.kind === "malformed") return notChecked("malformed");
    }
    if (byCalculation && verdict.verdict !== "contradicted") return byCalculation;
    const corrected =
      verdict.verdict === "contradicted"
        ? correctionFor(
            request.originalClaim ?? request.claim,
            request.claim,
            verdict.correction,
            session.finalCitation,
            newestFirst,
            documentFigureContext([{ text: request.originalClaim ?? request.claim }]),
            unitsOf,
          )
        : null;
    const decided = corrected?.evidence ?? evidence;
    return {
      verdict: verdict.verdict,
      evidence: decided,
      ...(corrected && { correction: corrected.correction }),
      says: verdict.says,
      unsupported: null,
      calculation: worked?.calculation ?? null,
      ...citedCase(decided),
      ...facts(),
    };
  };
  return async function checkClaim(request: ClaimCheckRequest): Promise<AtomicClaimCheckResult> {
    try {
      const checked = await check(request);
      const result = (await judgedAfter.get(request)?.(checked)) ?? checked;
      return result.verdict === "supported"
        ? withDollarClause(deps, request.claim, result)
        : explainedIn(result, {
            language: deps.language(),
            model: request.model,
            signal: request.signal,
          });
    } catch (error) {
      if (!(error instanceof FiguresNotRead)) throw error;
      return figuresNotRead(deps, request, error, passagesOf.get(request)?.() ?? []);
    }
  };
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

/**
 * A Supported reply whose Roles line gives other words than the sentence's as its own compared
 * something else: Claude Haiku 5.5 wrote the Passage's direction ("向人力资源总监汇报" for
 * "人力资源总监向乙方汇报"), "none" for "should be carried over", then called the two the same
 * (#1766). It can't be read as support.
 */
const ROLES_OWN_WORDS =
  "Your Roles line's first side isn't the sentence's own words. Copy from the sentence, word for word and in its own order, the words that say who does it, for or to whom, and whether it must or may happen, or, when it names no one, the words for what happens; then \" / \" and the Passage's words; then same, differs or other. Then give your whole reply again.";

/**
 * How a Supported reply whose Duty or Condition line is missing or can't be read is asked for it
 * again. It names the Duty line's words: a line with the same duty in two words ("has to / must,
 * same") can't be read, and the form's word on each side can (#1766).
 */
const DETAIL_FORM =
  "your whole reply again in the form asked for: its Duty line gives each side as one of must, should, may, must not or none, and its Condition line each side's condition as written, or none; each line ends with same or differs.";

const DETAIL_LINES = `Your reply has no Duty or Condition line that can be read. Write ${DETAIL_FORM}`;

/** A reply whose own Duty or Condition sides deny its "same" is told so: the ask names what is wrong. */
const DETAIL_DENIED = `Your reply's Duty or Condition line says same while its two sides differ: two different duties, or a condition on one side and none on the other. Compare the two sides again and write ${DETAIL_FORM}`;

/**
 * `asked`: a reply of this check has already given other words than the sentence's. A Roles line
 * naming nothing on either side is held back only where the reply's own Scope line names the
 * sentence's party or term: a figure's or a cell's sentence often names neither ("Scope: none,
 * same" for 杠杆率仍应在3.25倍的契约上限之内), but one that names the Tenant has its words to copy.
 */
export function comparesOtherWords(verdict: ReadVerdict, claim: string, asked: boolean): boolean {
  if (verdict.verdict !== "supported") return false;
  const sides = verdict.rolesSides;
  if (sides === undefined) return asked;
  if (namesNothing(sides)) return asked || verdict.scopeNames === true;
  return !ownWords(sides[0] ?? "", claim);
}

interface StatedNumber {
  number: string;
  relation?: LimitRelation;
  /** The names of the inputs the model marked as a cost or deduction printed in brackets. */
  costs: ReadonlySet<string>;
  /** The calculate item as the model gave it, to work out again once its quotes are recorded. */
  given?: unknown;
}

/**
 * The figure the model worked out for a number of the sentence, once every
 * input's quote is found, and whether the number agrees with it. Every number
 * the model named must hold, the sentence's figure and its limit alike: the
 * first that disagrees decides, whatever their order (#1908). Null when there
 * is none to decide by: no figure recorded for a number the sentence has, an
 * input's quote not found, or a result that can't be compared.
 */
function calculated(
  claim: string,
  figures: CalculationSession,
  stated: ReadonlyMap<number, StatedNumber>,
  contextOf: (citation: Citation) => FigureContext,
): { number: Figure; evidence: Citation; calculation: ClaimCalculation }[] {
  figures.check();
  const checked: { number: Figure; evidence: Citation; calculation: ClaimCalculation }[] = [];
  for (const [marker, { number: named, relation, costs }] of stated) {
    const figure = figures.figure(marker);
    const first = figure?.inputs[0]?.citation;
    if (!figure || !first) continue;
    const number = statedFigure(claim, named, contextOf(first));
    if (!number) continue;
    if (
      figure.inputs.some(
        (input) =>
          input.citation.check !== "found" ||
          (input.unitStatement && input.unitStatement.citation.check !== "found"),
      )
    )
      continue;
    const compared = comparedFigure(number, figure, costs);
    const agrees = compared && agreesWith(number, compared, { relation });
    if (!compared || agrees === null) continue;
    const worked = {
      number,
      evidence: first,
      calculation: {
        figure: compared,
        stated: number.chars,
        agrees,
        ...(relation && { relation }),
      },
    };
    checked.push(worked);
  }
  return checked;
}

/**
 * The most requests a check sends once its Run has ended, beside a whole read's absence judgement
 * and looks: its evidence asked for twice with every Passage it read, once for the records it
 * named and once for the one it rests on (`evidence`, the most each may write); and its quotes
 * compared with the sentence alone (`comparisons`): a contradiction's two looks, its parts and the
 * nearest line, and for a sentence with figures the rest's two looks and one for each figure.
 */
export function afterRun(figures: number): {
  evidence: number[];
  comparisons: number;
  comparing: number;
} {
  return {
    evidence: [OUTPUT_LIMITS.evidence.most, outputTokens("evidence")],
    comparisons: 4 + (figures > 0 ? 2 + figures : 0),
    comparing: Math.max(...COMPARISONS.map((id) => outputTokens(id))),
  };
}

/**
 * A model that gave a verdict without a record of the Passage that decides
 * it, or with a quote the check doesn't find, is asked once more, in one
 * request, for that record from the Passages it read (Claude Haiku 5.5 left
 * `cite` out of about one check in four). The record is taken as structured
 * output's are, and counts only when the check finds its quote. With
 * `covered`, it is the Passage that states that part of an unsupported sentence.
 */
async function askForEvidence(
  request: ClaimCheckRequest,
  verdict: ReadVerdict,
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  covered: string | null = null,
  markers: readonly number[] = [],
): Promise<Citation | null | Failed> {
  const passages = session.shownPassages();
  if (passages.length === 0) return null;
  // Asked for the one marker its reply names, Claude Haiku 5.5 gave the record alone, as an ask for
  // no marker takes it, for a quote it had written into its reply instead of calling cite (#2184).
  // Beside other markers, a record alone may be another one's copied.
  const named = new Set([
    ...(verdict.evidence ?? []),
    ...(verdict.coverage?.members.flatMap((member) => member.evidence) ?? []),
    ...(verdict.coverage?.domainEvidence ?? []),
  ]);
  const [asked] = markers;
  const only =
    markers.length === 1 && asked !== undefined && named.size === 1 && named.has(asked)
      ? asked
      : undefined;
  const judged = await judge({
    model: request.model.model,
    question:
      covered === null
        ? { id: "evidence", instructions: EVIDENCE_INSTRUCTIONS }
        : { id: "covered-evidence", instructions: COVERED_EVIDENCE_INSTRUCTIONS },
    parts: evidenceParts({ claim: request.claim, ...verdict, covered, passages, markers }),
    data: CHECK_TAGS,
    reply: json((value) => {
      const alone =
        markers.length === 0 || only !== undefined
          ? oneRecord(value, only ?? EVIDENCE_MARKER)
          : null;
      return alone ?? (markers.length === 0 ? null : markedRecords(value, markers));
    }),
    items: markers.length,
    retries: 1,
    signal,
    temperature: answerTemperature(request.model.capabilities.facts.temperature),
  });
  if (!judged.ok) {
    if (judged.reason === "stopped" || !judged.error) return null;
    console.error(`A check's evidence couldn't be asked for again: ${judged.error.message}`);
    return { failed: judged.error };
  }
  const records = judged.value;
  if (records.length === 0) return null;
  session.tools.cite(records, { structured: true });
  session.check();
  const citations = records.map((record) => session.finalCitation(record.marker));
  return citations.every((citation) => citation?.check === "found") ? (citations[0] ?? null) : null;
}

/** The record a reply gives alone, as `marker`'s; none for `{"passage": null}`; null otherwise. */
function oneRecord(value: unknown, marker: number): CitationRecordInput[] | null {
  if (givesNoEvidence(value)) return [];
  const record = readEvidence(value);
  return record ? [{ marker, ...record }] : null;
}

/** Each asked marker's record, every one once and none else; null otherwise. */
function markedRecords(value: unknown, markers: readonly number[]): CitationRecordInput[] | null {
  const reply = fieldsOf(value, { citations: list });
  if (!reply || reply.citations.length !== markers.length) return null;
  const missing = new Set(markers);
  const records: CitationRecordInput[] = [];
  for (const given of reply.citations) {
    const marker = isRecord(given) ? given.marker : undefined;
    if (typeof marker !== "number" || !missing.delete(marker)) return null;
    const record = readEvidence(given);
    if (!record) return null;
    records.push({ marker, ...record });
  }
  return records;
}

/** The questions a judge is asked about a sentence and one quote, read in its Passage. */
const COMPARISONS = ["confirm", "strict", "strict-figure", "recheck", "nearest", "parts"] as const;

interface Comparison {
  id: (typeof COMPARISONS)[number];
  instructions: string;
}

const recheck = (language: Language): Comparison => ({
  id: "recheck",
  instructions: recheckInstructions(language),
});

// In a whole check a model leant to "contradicted" for near misses: a figure for a related thing,
// another site in a parallel Document (#97). Judged alone, the sentence beside its quote, it didn't.
async function compare<T>(
  request: ClaimCheckRequest,
  quoted: Citation | readonly Citation[],
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  question: Comparison,
  read: (reply: string) => T | null,
  quantity?: Figure,
): Promise<Judged<T>> {
  const citations: readonly Citation[] = "quote" in quoted ? [quoted] : quoted;
  const passages = citations.map(
    (citation) =>
      session.shownPassages().find((each) => each.passageId === citation.passageId)?.text ??
      citation.quote,
  );
  const { model } = request;
  return judge({
    model: model.model,
    question,
    parts: confirmParts({
      claim: request.claim,
      quote: citations.map((citation) => citation.quote).join("\n"),
      passage: passages.join("\n"),
      quantity,
    }),
    data: CHECK_TAGS,
    reply: lines(read),
    retries: 1,
    signal,
    temperature: answerTemperature(model.capabilities.facts.temperature),
  });
}

interface Failed {
  failed: ProviderError;
}

const isFailed = (value: unknown): value is Failed =>
  typeof value === "object" && value !== null && "failed" in value;

const notFailed = <T>(value: T | Failed): T | null => (isFailed(value) ? null : value);

/**
 * Whether `claim` is one part of `sentence`, not the whole sentence but for spaces and punctuation
 * around it, as the part path tells a part from the sentence it fills (#2313).
 */
export function isPartOf(sentence: string, claim: string): boolean {
  const at = sentence.indexOf(claim);
  return (
    at >= 0 && !/^[\s\p{P}]*$/u.test(sentence.slice(0, at) + sentence.slice(at + claim.length))
  );
}

/** Words that say how a part relates to its own detail, not the detail itself. */
const DETAIL_LINKS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "those",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

/**
 * Whether the deciding quote states the part's own detail in its own order: its content words
 * stand consecutively, its numbers whole, and in Chinese a run stands whole. One judgement called
 * a part's own detail the same when the quote had another there, and the part read Supported
 * (#2313).
 */
export function quoteStatesDetail(claim: string, quote: string): boolean {
  const normalize = (text: string) =>
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\bcan['’]t\b/g, "cannot")
      .replace(/\bwon['’]t\b/g, "will not")
      .replace(/\bshan['’]t\b/g, "shall not")
      .replace(/n['’]t\b/g, " not");
  const words = (text: string) =>
    text.match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu) ?? [];
  const text = normalize(quote);
  const own = normalize(claim);
  const negations = (each: string) =>
    [...each.matchAll(/\b(?:not|no|never|without|nor|cannot)\b|[不未没无非]/gu)].length;
  if (negations(text) > negations(own)) return false;
  // A number is its whole digits, so "3.9" is compared with "3.9" and never split into "3" and
  // "9", which the word tokenizer would drop; a comma is a thousands mark.
  const numbers = (each: string) =>
    (each.match(/\d+(?:[.,]\d+)*/g) ?? []).map((number) => number.replace(/,/g, ""));
  const quoteNumbers = new Set(numbers(text));
  for (const number of numbers(own)) if (!quoteNumbers.has(number)) return false;
  const content = (word: string) =>
    !/\d/.test(word) &&
    !/^\p{Script=Han}+$/u.test(word) &&
    word.length >= 2 &&
    !DETAIL_LINKS.has(word);
  const quoteWords = words(text);
  const quoteContent = quoteWords.filter(content);
  const ownContent = words(own).filter(content);
  const consecutive =
    ownContent.length === 0 ||
    quoteContent.some((_, start) =>
      ownContent.every((word, offset) => quoteContent[start + offset] === word),
    );
  if (!consecutive) return false;
  for (const word of words(own))
    if (/^\p{Script=Han}+$/u.test(word) && !text.includes(word)) return false;
  return true;
}

async function confirmContradiction(
  request: ClaimCheckRequest,
  quoted: Citation | readonly Citation[],
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
): Promise<
  | { kind: "unrelated" | "states" | "doubt" | "confirmed" | "malformed" | "stopped" }
  | { failed: ProviderError }
> {
  const first = await compare(
    request,
    quoted,
    session,
    signal,
    { id: "confirm", instructions: CONFIRM_INSTRUCTIONS },
    readJudgement,
  );
  if (signal.aborted) return { kind: "stopped" };
  if (!first.ok && first.error) return { failed: first.error };
  const judged = first.ok ? first.value : null;
  if (judged === "neither") return { kind: "unrelated" };
  if (judged === "same") return { kind: "states" };
  const strict = await compare(
    request,
    quoted,
    session,
    signal,
    { id: "strict", instructions: STRICT_INSTRUCTIONS },
    readJudgement,
  );
  if (signal.aborted) return { kind: "stopped" };
  if (!strict.ok) return strict.error ? { failed: strict.error } : { kind: "malformed" };
  return { kind: strict.value === "neither" ? "doubt" : "confirmed" };
}

/**
 * Whether the quote a window's judgement gives for what the sentence says is absent states it is
 * there: two looks, each asked that and nothing else (#1554); with `first`, only the first.
 */
async function lookForPresence(
  request: ClaimCheckRequest,
  quoted: Citation,
  absent: string | null,
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  first = false,
): Promise<Presence> {
  const passage =
    session.shownPassages().find((each) => each.passageId === quoted.passageId)?.text ??
    quoted.quote;
  const { model } = request;
  const looks = [
    { id: "presence" as const, instructions: PRESENCE_INSTRUCTIONS },
    ...(first
      ? []
      : [{ id: "strict-presence" as const, instructions: STRICT_PRESENCE_INSTRUCTIONS }]),
  ];
  for (const question of looks) {
    const looked = await judge({
      model: model.model,
      question,
      parts: presenceParts({
        claim: request.claim,
        absent,
        quote: quoted.quote,
        document: quoted.documentName ?? "",
        passage,
      }),
      data: CHECK_TAGS,
      reply: lines(readPresence),
      retries: 1,
      signal,
      temperature: answerTemperature(model.capabilities.facts.temperature),
    });
    if (!looked.ok) {
      if (looked.reason === "stopped") return { kind: "stopped" };
      return looked.error ? { failed: looked.error } : { kind: "malformed" };
    }
    if (looked.value !== "there") return { kind: looked.value };
  }
  return { kind: "there" };
}

async function partOf(
  request: ClaimCheckRequest,
  quoted: Citation | readonly Citation[],
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  language: Language,
): Promise<{ covered: string | null; uncovered: string | null } | Failed> {
  const asked = await compare(
    request,
    quoted,
    session,
    signal,
    { id: "parts", instructions: partInstructions(language) },
    readPart,
  );
  if (asked.ok) return asked.value;
  if (!asked.error) return { covered: null, uncovered: null };
  console.error(`A sentence's parts couldn't be asked for: ${asked.error.message}`);
  return { failed: asked.error };
}

interface Opinions {
  documentIds: ReadonlySet<string>;
  missing: boolean;
}

function startOf(documents: AnswerDocuments, documentId: string, contentHash: string): string {
  const [first] = documents.pageTexts(documentId, contentHash, 1, 1);
  return first?.text ?? documents.pageTexts(documentId, contentHash, null, null)[0]?.text ?? "";
}

async function opinionsOf(
  decisions: readonly CaseCitation[],
  documents: AnswerDocuments,
  signal: AbortSignal,
): Promise<Opinions> {
  const documentIds = new Set<string>();
  let missing = false;
  for (const decision of decisions) {
    const query = [decision.name, decision.cite].filter(Boolean).join(" ");
    const found = await documents.search(query, signal);
    const candidates = new Map(found.map((each) => [each.documentId, each]));
    const opinions = [...candidates.values()].filter((each) =>
      isOpinionOf(
        {
          name: each.documentName,
          start: startOf(documents, each.documentId, each.contentHash),
        },
        decision,
      ),
    );
    if (opinions.length === 0) missing = true;
    for (const each of opinions) documentIds.add(each.documentId);
  }
  return { documentIds, missing };
}

/**
 * For a sentence found unsupported: the nearest line of what the Run read, as
 * a Citation whose quote the check found, when judged alone it states another
 * value for the very thing the sentence says (30 days of leave against the
 * Document's 27). Never "contradicted": the verdict stays unsupported, and the
 * card shows what the Document says. Null when nothing read is near enough, or
 * the nearest line doesn't differ.
 */
async function nearestDifferent(
  request: ClaimCheckRequest,
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
): Promise<Citation | null> {
  const line = nearestLine(request.claim, session.shownPassages());
  if (!line) return null;
  session.tools.cite(
    [{ marker: NEAREST_MARKER, passage: line.id, location: null, quote: line.text }],
    {
      structured: true,
    },
  );
  session.check();
  const citation = session.finalCitation(NEAREST_MARKER);
  if (citation?.check !== "found") return null;
  const judged = await compare(
    request,
    citation,
    session,
    signal,
    { id: "nearest", instructions: NEAREST_INSTRUCTIONS },
    readJudgement,
  );
  if (!judged.ok && judged.error)
    console.error(`A nearest line couldn't be judged: ${judged.error.message}`);
  return judged.ok && judged.value === "conflict" ? citation : null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// A calculation settles one missing figure, not another coordinated or adjoining clause.
const ANOTHER_CLAUSE =
  /(?:[;；,，:：—]|\b(?:and|but|or|yet|however|although|though|while|whereas)\b|和|与|及|以及|并且|但|但是|然而|或|或者|而)/iu;

const derivedFigureOnly = (text: string, stated: string, document: FigureContext) =>
  sentenceSpans(text).length === 1 &&
  !ANOTHER_CLAUSE.test(text) &&
  statedFigure(text, stated, document) !== null;

/**
 * A Passage the check found and judged that doesn't back the sentence, with nothing to quote from it:
 * Unsupported, never Not found (#1608).
 */
const UNBACKED: UnsupportedReason = { reason: null, covered: null, uncovered: null, found: true };

/** The marker the nearest line is recorded under: apart from the model's and the evidence's. */
const NEAREST_MARKER = 98;

/** The marker the record asked for once more is given: apart from any the model gave. */
const EVIDENCE_MARKER = 99;

/** Where `text` names a period: "Q2 2025", "第二季度", "2026年4月". */
function periodSpans(text: string): { from: number; to: number }[] {
  const words: { from: number; to: number }[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (match.index === undefined) continue;
    words.push({ from: match.index, to: match.index + match[0].length });
  }
  const candidates: { from: number; to: number }[] = [];
  for (const [index, word] of words.entries()) {
    for (const end of words.slice(index, index + 4)) {
      candidates.push({ from: word.from, to: end.to });
    }
  }
  for (let end = 0; end < text.length; end++) {
    if (!/[年季度月]/u.test(text[end] ?? "")) continue;
    for (let start = Math.max(0, end - 24); start < end; start++) {
      candidates.push({ from: start, to: end + 1 });
    }
  }
  return candidates.filter((span) => isPeriod(text.slice(span.from, span.to)));
}

function namedPeriods(text: string): string[] {
  return periodSpans(text)
    .map((span) => text.slice(span.from, span.to).normalize("NFKC").toLocaleLowerCase())
    .sort();
}

function keepsNamedPeriods(from: string, replacement: string): boolean {
  const before = namedPeriods(from);
  if (before.length === 0) return true;
  const after = namedPeriods(replacement);
  return before.length === after.length && before.every((period, index) => period === after[index]);
}

/**
 * The Document's number a figure was checked against: its source, or the one number a calculation
 * only names, as Claude Haiku 5.5 sent the lease's $14,250 as the calculation "rent" (#1481). Null
 * for a number worked out.
 */
function checkedNumber(figure: FigureCheckResult): FigureInput | null {
  if (figure.sourceInput) return figure.sourceInput;
  const calculation = "calculation" in figure.result ? figure.result.calculation?.figure : null;
  const [input, ...more] = calculation?.inputs ?? [];
  return input &&
    more.length === 0 &&
    calculation?.literals.length === 0 &&
    calculation.formula.trim() === input.name
    ? input
    : null;
}

const scriptOf = (text: string): "han" | "latin" | null =>
  /\p{Script=Han}/u.test(text) ? "han" : /\p{Script=Latin}/u.test(text) ? "latin" : null;

/**
 * Whether `wording` is in the language of the words it replaces, or of the nearest words around
 * them when they have none: Claude Haiku 5.5 gave a Chinese sentence's 60日内 "within 30 days",
 * and an English sentence that names 华信公司 "30日内" (#1481). Figures alone fit anywhere.
 */
function inLanguageAt(claim: string, first: number, end: number, wording: string): boolean {
  const written = scriptOf(wording);
  if (written === null) return true;
  const nearest =
    [...claim.slice(0, first)].reverse().find((char) => scriptOf(char) !== null) ??
    [...claim.slice(end)].find((char) => scriptOf(char) !== null) ??
    "";
  return written === (scriptOf(claim.slice(first, end)) ?? scriptOf(nearest));
}

export const sameNumber = (
  a: { value: number; unit: unknown },
  b: { value: number; unit: unknown },
) =>
  Math.abs(a.value - b.value) <= 1e-9 * Math.max(1, Math.abs(a.value), Math.abs(b.value)) &&
  JSON.stringify(a.unit) === JSON.stringify(b.unit);

/**
 * The figures the corrected sentence reads where the old words and any figure they were part of
 * stood, or null when a figure the old words were part of doesn't read whole again: "1.5" of
 * "1.5亿元" written as "120,000,000元" leaves 亿元 behind (#1481).
 */
function writtenAt(
  claim: string,
  first: number,
  from: string,
  wording: string,
  context: FigureContext,
): Figure[] | null {
  const end = first + from.length;
  const old = readFigures(claim, context).filter((each) => each.start < end && each.end > first);
  const start = Math.min(first, ...old.map((each) => each.start));
  const stop = Math.max(end, ...old.map((each) => each.end)) + wording.length - from.length;
  const corrected = claim.slice(0, first) + wording + claim.slice(end);
  const written = readFigures(corrected, context).filter(
    (each) => each.start < stop && each.end > start,
  );
  const partOfOne = old.some((each) => each.start < first || each.end > end);
  return partOfOne && (written[0]?.start !== start || written.at(-1)?.end !== stop)
    ? null
    : written;
}

const isDigit = (char: string | undefined) => char !== undefined && /\p{Nd}/u.test(char);

/**
 * The written number `start`–`end` is part of, its digits and what joins them taken whole: "10"
 * of "10–12", which the figure reader doesn't read as a range.
 */
function numberAround(text: string, start: number, end: number): string {
  const joins = (at: number, beyond: number) =>
    /[–—\-/.,~～]/u.test(text[at] ?? "") && isDigit(text[beyond]);
  let from = start;
  if (isDigit(text[from])) {
    while (from > 0 && (isDigit(text[from - 1]) || joins(from - 1, from - 2))) from--;
  }
  let to = end;
  if (isDigit(text[to - 1])) {
    while (to < text.length && (isDigit(text[to]) || joins(to, to + 1))) to++;
  }
  return text.slice(from, to);
}

/** Where a clause ends: "," or ";" before a space, a sentence's stop, or their Chinese forms. */
const CLAUSE_END = /[,;](?=\s)|\.(?=\s|$)|[，；。！？!?]/gu;

/** A word at a seam: a number, a Latin word, a run of Chinese numerals, or one other character. */
const SEAM_TOKEN =
  /\p{Nd}+(?:[.,]\p{Nd}+)*|\p{Script=Latin}+|[〇零一二两三四五六七八九十百千万亿]+|\S/gu;

const isNumeral = (token: string) => /^[\p{Nd}〇零一二两三四五六七八九十百千万亿]/u.test(token);

/** What stands just before `index`: a word, or "" where a clause starts. */
function wordBefore(text: string, index: number): string {
  const head = text.slice(0, index).trimEnd();
  if (head === "" || /[,;:.，；：。！？!?]$/u.test(head)) return "";
  return (head.match(SEAM_TOKEN)?.at(-1) ?? "").toLocaleLowerCase();
}

/** What stands just after `index`: a word, or "" where a clause ends. */
function wordAfter(text: string, index: number): string {
  const tail = text.slice(index).trimStart();
  if (tail === "" || /^(?:[，；：。！？!?]|[,;:.](?:\s|$))/u.test(tail)) return "";
  return (tail.match(SEAM_TOKEN)?.[0] ?? "").toLocaleLowerCase();
}

/**
 * Whether each end of the wording joins the sentence as the Document's words join their own: it
 * keeps the old words' word at that end (any number for a number), or the sentence goes on from
 * it as the quote does, with the same word or a clause's end. "Westmarch but" before "of London",
 * "monthly rent of $14,250" after "The base rent is" and 的西境公司 after 出租人为 don't (#1481).
 */
function seamsHold(
  claim: string,
  first: number,
  from: string,
  wording: string,
  quote: string,
  at: number,
): boolean {
  const corrected = claim.slice(0, first) + wording + claim.slice(first + from.length);
  const old = from.match(SEAM_TOKEN) ?? [];
  const now = wording.match(SEAM_TOKEN) ?? [];
  const keeps = (a: string | undefined, b: string | undefined) =>
    a !== undefined &&
    b !== undefined &&
    ((isNumeral(a) && isNumeral(b)) || a.toLocaleLowerCase() === b.toLocaleLowerCase());
  const end = at + wording.length;
  return (
    (keeps(old[0], now[0]) || wordBefore(corrected, first) === wordBefore(quote, at)) &&
    (keeps(old.at(-1), now.at(-1)) ||
      wordAfter(corrected, first + wording.length) === wordAfter(quote, end))
  );
}

/** Text as compared for a range: one space for any run of them, and one dash for any dash. */
const spacedAsOne = (text: string) => text.replace(/\s*[–—−‐-]\s*/gu, "-").replace(/\s+/gu, " ");

/**
 * Where `wording` stands in `quote`: its one place, never inside a longer number; -1 when it
 * isn't there or stands in more than one place, so no other stretch of the quote can vouch for it.
 */
function placeIn(quote: string, wording: string): number {
  const places: number[] = [];
  for (let at = quote.indexOf(wording); at >= 0; at = quote.indexOf(wording, at + 1)) {
    const runsOn =
      (isDigit(wording[0]) && isDigit(quote[at - 1])) ||
      (isDigit(wording.at(-1)) && isDigit(quote[at + wording.length]));
    if (!runsOn) places.push(at);
  }
  return places.length === 1 ? (places[0] ?? -1) : -1;
}

/**
 * Whether the clause the corrected words sit in, from its first number to its last with whatever
 * joins them, is what the quote writes around those words where they stand in it. A range is one
 * clause however it is joined, so this fails closed on any connector: "8" over "10" of "10 to 12",
 * 10至12 or 10到12 leaves the User's 12 beside the Document's 8, even where the quote has "8 to
 * 12" in another clause or "18 to 120" (#1481). The numbers of a named period are left to the
 * period rules, which hold wherever the quote names it.
 */
function clauseHeld(
  corrected: string,
  first: number,
  end: number,
  quote: string,
  at: number,
): boolean {
  const ends = [...corrected.matchAll(CLAUSE_END)].map((match) => match.index);
  const start = Math.max(0, ...ends.filter((at) => at < first).map((at) => at + 1));
  const stop = Math.min(corrected.length, ...ends.filter((at) => at >= end));
  const clause = corrected.slice(start, stop);
  const periods = periodSpans(clause);
  const numbers = [...clause.matchAll(NUMBERS)].filter(
    (match) =>
      !periods.some((span) => span.from <= match.index && span.to >= match.index + match[0].length),
  );
  const [head] = numbers;
  const last = numbers.at(-1);
  if (!head || !last) return true;
  const before = spacedAsOne(corrected.slice(Math.min(first, start + head.index), first));
  const after = spacedAsOne(
    corrected.slice(end, Math.max(end, start + last.index + last[0].length)),
  );
  const quoteBefore = spacedAsOne(quote.slice(0, at));
  const quoteAfter = spacedAsOne(quote.slice(at + end - first));
  return (
    quoteBefore.endsWith(before) &&
    quoteAfter.startsWith(after) &&
    !(isDigit(before[0]) && isDigit(quoteBefore[quoteBefore.length - before.length - 1])) &&
    !(isDigit(after.at(-1)) && isDigit(quoteAfter[after.length]))
  );
}

/**
 * Whether the corrected sentence reads, where the old words stood, the very numbers the quote
 * reads in the same words, with their scale and sign, written as the quote writes them: "1.5" of
 * "$1.5m" written as "1,200,000" reads $1,200,000m, "4,620.00" is not the quote's "(4,620.00)",
 * "$1.2m" over "$1.5" of "$1.5m" reads $1.2mm, and "8" over "10" of "10–12" reads 8–12 (#1481).
 */
function readsAsQuote(
  claim: string,
  first: number,
  from: string,
  wording: string,
  quote: string,
  context: FigureContext,
): boolean {
  const written = writtenAt(claim, first, from, wording, context);
  const at = placeIn(quote, wording);
  if (written === null || at < 0) return false;
  const corrected = claim.slice(0, first) + wording + claim.slice(first + from.length);
  const end = first + wording.length;
  if (
    numberAround(corrected, first, end) !== numberAround(quote, at, at + wording.length) ||
    !clauseHeld(corrected, first, end, quote, at)
  )
    return false;
  const quoted = readFigures(quote, documentFigureContext([{ text: quote }])).filter(
    (each) => each.start < at + wording.length && each.end > at,
  );
  return (
    written.length === quoted.length &&
    written.every((each, index) => {
      const same = quoted[index];
      return same !== undefined && sameNumber(each, same) && quote.includes(each.chars);
    })
  );
}

/**
 * The Document's words as far as `quote` holds them, to the end of a clause: Claude Haiku 5.5 went
 * on past its quote with ", less any amounts properly deducted" (#1481). Null when it holds none.
 */
function heldBy(quote: string, wording: string): string | null {
  if (quote.includes(wording)) return wording;
  // An English comma ends a clause only before a space: 1,200 is one number.
  const ends = [...wording.matchAll(/\s*(?:[,;](?=\s)|[，；])/gu)]
    .map((match) => match.index)
    .reverse();
  for (const end of ends) {
    const clause = wording.slice(0, end);
    if (clause !== "" && quote.includes(clause)) return clause;
  }
  return null;
}

/** The one figure `words` are, or null when they are more or less than a figure. */
function figureOnly(words: string, context: FigureContext): Figure | null {
  const read = readFigures(words, context);
  return read.length === 1 && read[0]?.chars === words.trim() ? read[0] : null;
}

/** Whether `quote` names every period `sentence` does: a Document's value for another is no correction. */
function namesPeriodsOf(sentence: string, quote: string): boolean {
  const named = new Set(namedPeriods(quote));
  return namedPeriods(sentence).every((period) => named.has(period));
}

/** An overlap at least this long, or one character that isn't a letter or digit ("$", " "). */
const overlaps = (words: string) => words.length >= 2 || /^[^\p{L}\p{N}]$/u.test(words);

/**
 * The Document's words as they fit between `before` and `after`: without the words either side
 * already has. Asked for 60日内, Claude Haiku 5.5 gave 货款应在开票后45日内支付 (#1481).
 */
function inPlace(before: string, after: string, wording: string): string {
  // Whatever its case: Claude Haiku 5.5 gave "The term is 10 to 12 months." the wording "the term
  // is 8 to 10 months" (#1481).
  const lower = (text: string) => text.toLocaleLowerCase();
  let start = 0;
  for (let length = Math.min(before.length, wording.length); length > 0; length--) {
    const words = wording.slice(0, length);
    if (lower(before).endsWith(lower(words)) && overlaps(words)) {
      start = length;
      break;
    }
  }
  let end = wording.length;
  for (let length = Math.min(after.length, wording.length - start); length > 0; length--) {
    const words = wording.slice(wording.length - length);
    if (lower(after).startsWith(lower(words)) && overlaps(words)) {
      end = wording.length - length;
      break;
    }
  }
  return wording.slice(start, end);
}

/**
 * Whether the Document's words for a figure are one bare number where the sentence's figure has a
 * unit or a scale: "151.2" in place of 1.402 亿英镑 would leave 亿英镑 behind, or drop it (#2081).
 */
function dropsUnit(old: Figure, words: string, context: FigureContext): boolean {
  const [now, ...more] = readFigures(words, context);
  return (
    now !== undefined &&
    more.length === 0 &&
    (old.unit.kind !== "plain" || old.scale !== 1) &&
    now.unit.kind === "plain" &&
    now.scale === 1
  );
}

/**
 * The Document's figure written as the sentence writes its own (#2081): "2.6 million pounds" in
 * place of 二百四十万英镑 is 260万英镑, and "151.2" under "All figures in £ million" in place of
 * 1.402 亿英镑 is 1.512 亿英镑. Its amount is the one its Document gives it, read as a changed
 * scale is (../changedScale): with its own scale word, its row's unit or the unit its line or page
 * states; a bare number with none of them has no amount to write. Null unless the old words and the
 * Document's are one figure each, of one unit and sign, and the sentence then reads that amount where
 * the old words stood. A Document's figure of no unit the reader knows ("pounds" may be a weight)
 * takes the sentence's, as the check judged the two the same thing.
 */
function writtenAsSentence(
  claim: string,
  first: number,
  from: string,
  old: Figure,
  words: string,
  citation: Citation,
  units: readonly PageText[],
  context: FigureContext,
): string | null {
  const [quoted, ...more] = readFigures(words, documentFigureContext([{ text: words }]));
  const at = placeIn(citation.quote, words);
  if (
    !quoted ||
    more.length > 0 ||
    at < 0 ||
    quoted.rangeTo !== null ||
    old.rangeTo !== null ||
    old.ambiguous.length > 0
  )
    return null;
  const given = givenAmounts({ citation: { quote: citation.quote }, units: [...units] }).filter(
    (each) =>
      each.start >= at &&
      each.start < at + words.length &&
      // A bare number is worth what its Document says only where it says its scale.
      (each.scaled || (each.reading.scale === 1 && old.scale === 1)),
  );
  const [worth] = given;
  if (!worth || given.some((each) => each.value !== worth.value)) return null;
  const { reading } = worth;
  const ofAmounts =
    old.unit.kind === "currency" || old.unit.kind === "other" || old.unit.kind === "plain";
  const sameUnit = JSON.stringify(reading.unit) === JSON.stringify(old.unit);
  if (
    (!sameUnit && !(reading.unit.kind === "plain" && ofAmounts)) ||
    Math.sign(reading.value) !== Math.sign(old.value)
  )
    return null;
  const shares = old.unit.kind === "percent" || old.unit.kind === "points";
  const most = shares
    ? reading.decimals
    : Math.max(0, reading.decimals + Math.round(Math.log10(old.scale / reading.scale)));
  // As few decimals as write the amount whole: 260 万英镑 is £2.6 million, not £2.60 million.
  const amount = Math.abs(reading.value) * (shares ? 100 : 1 / old.scale);
  const decimals =
    [...Array(most + 1).keys()].find(
      (places) => Math.abs(Number(amount.toFixed(places)) - amount) <= 1e-9 * Math.max(1, amount),
    ) ?? most;
  const written = writtenLike(old, reading.value, decimals);
  const [read, ...others] = writtenAt(claim, first, from, written, context) ?? [];
  return read && others.length === 0 && sameNumber(read, { value: reading.value, unit: old.unit })
    ? written
    : null;
}

/**
 * A confirmed contradiction's correction of `claim`, a part of `sentence` or all of it: old words
 * that occur once in it, never all the sentence's words, each choice's wording in its own found
 * quote, or that quote's figure written as the sentence writes its own, keeping the sentence's
 * named periods.
 */
export function correctionFor(
  sentence: string,
  claim: string,
  read: ReadCorrection | undefined,
  finalCitation: (marker: number) => Citation | null,
  documentDate: AnswerDocuments["documentDate"],
  context: FigureContext,
  /** The stored text of the Units a Citation's Document holds, for the scale it states. */
  units: (citation: Citation) => readonly PageText[] = () => [],
): { correction: ClaimCorrection; evidence: Citation } | null {
  if (!read || read.from === "" || read.choices.length < 1 || read.choices.length > 2) return null;
  const first = claim.indexOf(read.from);
  if (first < 0 || first !== claim.lastIndexOf(read.from)) return null;
  // Old words that are all of the sentence would rewrite it, not correct its contradicted part:
  // Claude Haiku 5.5 named a whole Chinese sentence so (#1481).
  const kept = claim.slice(0, first) + claim.slice(first + read.from.length);
  if (sentence === claim && !/[\p{L}\p{N}]/u.test(kept)) return null;
  const markers = new Set<number>();
  const wordings = new Set<string>();
  const choices: ({ wording: string; marker: number } & { evidence: Citation })[] = [];
  const figure = figureOnly(read.from, context);
  const end = first + read.from.length;
  // The Document's own words first: a figure written again that says what they say is no choice.
  const ownFirst = [...read.choices].sort(
    (a, b) =>
      Number(!inLanguageAt(claim, first, end, a.wording)) -
      Number(!inLanguageAt(claim, first, end, b.wording)),
  );
  for (const stated of ownFirst) {
    const inPlaceOf = (words: string) =>
      inPlace(claim.slice(0, first), claim.slice(first + read.from.length), words);
    const citation = finalCitation(stated.marker);
    const placed = inPlaceOf(stated.wording);
    const held = citation?.check === "found" ? heldBy(citation.quote, placed) : null;
    if (!citation || held === null) return null;
    // Cut to a clause, the words may end with what follows the old ones: 30日内无息退还.
    const fitted = held === placed ? placed : inPlaceOf(held);
    // A figure takes the Document's figure of its own kind, not the words around it.
    const figures = figure && !figureOnly(fitted, context) ? readFigures(fitted, context) : [];
    const same = figures.filter((each) => each.unit.kind === figure?.unit.kind);
    const quoted = { ...stated, wording: same.length === 1 && same[0] ? same[0].chars : fitted };
    // A figure in another language, or a bare number for one with a unit or scale, is written as
    // the sentence writes its own (#2081); any other words in another language are left out, as a
    // choice no one could take.
    const own =
      inLanguageAt(claim, first, end, quoted.wording) &&
      !(figure && dropsUnit(figure, quoted.wording, context));
    const written =
      own || !figure
        ? null
        : writtenAsSentence(
            claim,
            first,
            read.from,
            figure,
            quoted.wording,
            citation,
            units(citation),
            context,
          );
    if (
      !own &&
      (written === null || !inLanguageAt(claim, first, end, written) || wordings.has(written))
    )
      continue;
    const choice = written === null ? quoted : { ...quoted, wording: written };
    const place = written === null ? placeIn(citation.quote, choice.wording) : 0;
    if (
      written === null &&
      (place < 0 || !seamsHold(claim, first, read.from, choice.wording, citation.quote, place))
    )
      return null;
    if (
      markers.has(choice.marker) ||
      choice.wording === "" ||
      choice.wording === read.from ||
      !keepsNamedPeriods(read.from, choice.wording) ||
      !keepsNamedPeriods(
        claim,
        claim.slice(0, first) + choice.wording + claim.slice(first + read.from.length),
      ) ||
      wordings.has(choice.wording) ||
      !namesPeriodsOf(claim, citation.quote) ||
      (written === null &&
        !readsAsQuote(claim, first, read.from, choice.wording, citation.quote, context))
    )
      return null;
    markers.add(choice.marker);
    wordings.add(choice.wording);
    choices.push({ ...choice, evidence: citation });
  }
  const sorted = choices.sort(
    (a, b) =>
      (documentDate(b.evidence.documentId)?.date ?? "").localeCompare(
        documentDate(a.evidence.documentId)?.date ?? "",
      ) || a.marker - b.marker,
  );
  const [newest] = sorted;
  if (!newest) return null;
  return {
    correction: {
      from: read.from,
      choices: sorted.map(({ wording, evidence }) => ({ wording, evidence })),
    },
    evidence: newest.evidence,
  };
}

function foundCitations(
  finalCitation: (marker: number) => Citation | null,
  deciding: Citation | null,
  markers: readonly number[] = [1, 2, 3, 4],
): Citation[] {
  const found: Citation[] = [];
  for (const marker of markers) {
    const citation = finalCitation(marker);
    if (citation?.check !== "found") continue;
    if (deciding && citationKey(citation) === citationKey(deciding)) continue;
    found.push(citation);
  }
  return uniqueCitations(found);
}

/** The Citation that decides a claim: marker 1's, or the first other marker's, whose quote the check found. */
function decidingCitation(finalCitation: (marker: number) => Citation | null): Citation | null {
  for (let marker = 1; marker <= 4; marker++) {
    const citation = finalCitation(marker);
    if (citation?.check === "found") return citation;
  }
  return null;
}

type CitationKeyed = Pick<
  CitationAttributes,
  "documentId" | "contentHash" | "passageId" | "pageFrom" | "pageTo" | "location" | "quote"
>;

const citationKey = (citation: CitationKeyed) =>
  JSON.stringify([
    citation.documentId,
    citation.contentHash,
    citation.passageId,
    citation.pageFrom,
    citation.pageTo,
    citation.location,
    citation.quote,
  ]);

const uniqueCitations = (citations: readonly Citation[]): Citation[] => [
  ...new Map(citations.map((citation) => [citationKey(citation), citation])).values(),
];
