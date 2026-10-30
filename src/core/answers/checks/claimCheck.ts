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

import { generateText } from "ai";
import { type CaseCitation, caseCitations, isOpinionOf } from "../../../shared/caseCitations";
import type { LiveDocument } from "../../../shared/citations";
import { partWithResult, readPartPlans } from "../../../shared/claimParts";
import { formatClaimFacetPeriod } from "../../../shared/dates";
import { displayName } from "../../../shared/documentNames";
import { type Figure, type FigureContext, readFigures } from "../../../shared/figures";
import { type MessageKey, type MessageParams, translate } from "../../../shared/i18n";
import type { InlineTextProjection } from "../../../shared/inlineText";
import { sentenceSpans } from "../../../shared/sentences";
import { speakerName } from "../../../shared/speakers";
import { normaliseText } from "../../../shared/text";
import type {
  CheckedVersion,
  CheckFigure,
  Citation,
  ClaimCalculation,
  ClaimCheckFailure,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimJudgment,
  ClaimPartCoverage,
  ClaimPartPlan,
  ClaimPartSpan,
  Document,
  LeftOutDocument,
  LimitRelation,
  PassageSearchResult,
  ProviderError,
  RecordAiUseInput,
  ThirdPartyReason,
  UnsupportedReason,
} from "../../api";
import type { CitationSource } from "../../documents";
import type { Evidence, EvidenceScope } from "../../documents/evidence";
import { isRecord } from "../../errors";
import type { Language } from "../../language";
import { calculates, givesStructuredOutput } from "../../providers/capabilities";
import type { PreparedChatModel } from "../../providers/chat";
import { classifyProviderError } from "../../providers/providerErrors";
import type { RecordCitePlace } from "../../recordCites/referents";
import type { Slots } from "../../runs/stop";
import {
  answerLanguage,
  type CalculationSession,
  createCalculationSession,
  documentFigureContext,
  givenList,
  whole,
} from "../calculations";
import { type AnswerDocuments, createCitationSession, documentNamedAmong } from "../citations";
import {
  type AnswerEngine,
  type AnswerTools,
  answerTemperature,
  type CitationRecordInput,
  type CiteOptions,
  type DocumentLanguage,
} from "../engine";
import type { TurnCheck, TurnFinding } from "../turnChecks";
import { checkAbsence, fitsWholeRead } from "./absence";
import { readAttributionReply } from "./attributionReply";
import { agreesWith, statedFigure } from "./calculated";
import { needsCalculation } from "./calculationGate";
import {
  checkFigureReply,
  figureJudgment,
  figureReplyText,
  givesItsOwnNumber,
  readFigureReply,
  readFigureSource,
  uncheckedFigureResults,
  verdictMarkers,
  withSentenceVerdict,
} from "./figureChecks";
import { figuresMatch, nearestLine } from "./nearest";
import {
  type AbsenceAnswer,
  CONFIRM_INSTRUCTIONS,
  COVERED_EVIDENCE_INSTRUCTIONS,
  checkInstructions,
  claimPrompt,
  confirmPrompt,
  EVIDENCE_INSTRUCTIONS,
  evidencePrompt,
  NEAREST_INSTRUCTIONS,
  partInstructions,
  type ReadVerdict,
  readEvidence,
  readJudgement,
  readPart,
  readsAsRefusal,
  readVerdict,
  STRICT_INSTRUCTIONS,
} from "./prompt";
import { searchAgain } from "./searchAgain";
import { sourceAttribution, sourceNameIn } from "./sourceAttribution";
import { speakerAttribution } from "./speakerAttribution";
import { inCurrentPeriodWindow, periodInEvidence } from "./statedPeriod";
import { type BoundNumber, unitNotStated } from "./units";

export interface ClaimCheckDependencies {
  /** The interface language: what a check's sentence is written in. */
  language(): Language;
  now(): Date;
  /** The wall a Document belongs to, or null when it belongs to none. */
  walledDocument(documentId: string): string | null;
  walledFolder(mindId: string | null): string | null;
  /** The name of that wall's Folder, or null when it belongs to none. */
  walledFolderName(documentId: string): string | null;
  engine: AnswerEngine;
  evidence: Pick<Evidence, "search">;
  documents: Pick<AnswerDocuments, "citationSource" | "pageTexts" | "documentDate"> & {
    names(): readonly LiveDocument[];
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
  };
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
  sourceContext?: readonly ClaimPartPlan[];
  figures?: readonly CheckFigure[];
  context?: string;
  cited?: readonly CheckedCitation[];
  scope: EvidenceScope;
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
  signal: AbortSignal;
  parts?: readonly ClaimPartPlan[];
  only?: ClaimPartSpan;
  previous?: readonly ClaimCheckPart[];
  /** The run's limit on model checks at once, which its claims' parts share. */
  slots?: Slots;
  /** The User didn't ask about this sentence: an opinion in it is left out, never checked. */
  opinionsLeftOut?: boolean;
  /**
   * The Run's first turn names the sentence's parts: told what that turn wrote before any further
   * request, or what the Run wrote when it calls no Tool.
   */
  findParts?: (heard: string) => readonly ClaimPartPlan[] | null | undefined;
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
      return { reason: "cost-cap", detail: null };
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

/** Records a sentence a model judged as a use of AI (#906); one it couldn't judge isn't one. */
export function recordJudged(
  record: (inputs: RecordAiUseInput[]) => void,
  mindId: string,
  model: PreparedChatModel,
  result: ClaimCheckResult,
  at: string,
): void {
  if (result.verdict === "not-checked") return;
  record([
    {
      mindId,
      kind: "sentence-checked",
      providerId: model.provider.id,
      modelId: model.modelId,
      characters: 0,
      occurredAt: at,
    },
  ]);
}

const SEARCH_FIRST =
  "You gave a verdict without searching the User's Documents. Search them with search_documents first, then give your verdict from what you find.";

export type AtomicClaimCheckResult = ClaimCheckResult & {
  checkedEvidence?: readonly Citation[];
  coverage?: ClaimPartCoverage;
  facetParts?: readonly ClaimCheckPart[];
  remainderText?: string;
  ordinaryTarget?: ClaimPartSpan;
};
const FIGURES_LINE =
  "Your reply has no Figures line that can be read. Write your whole reply again, ending with the one Figures: line, its JSON object on that line.";

const REMAINDER_LINE =
  'Your Figures line gives no remainder. Give "remainder": null when the sentence asserts nothing beyond its figures, or its other assertion as the instructions say, then write your whole reply again.';

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
 * `asking` is told each reply asked about.
 */
function figuresReplied(
  request: ClaimCheckRequest,
  calculations: Pick<CalculationSession, "number" | "figure">,
  searched: () => boolean,
  recorded: (marker: number) => boolean,
  asking: (text: string) => void,
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
      check(text) {
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
      name: "figures-sources",
      check(text) {
        const read = asked(text) ? readFigureReply(text, figures, request.claim) : null;
        if (!read) return null;
        const problems = read.items.flatMap((item) => {
          const target = figures.find((figure) => figure.id === item.id);
          if (!target) return [];
          if (item.verdict !== "supported") {
            const judged = item.topic === "found" && item.scope === "same" && item.roles === "same";
            const source =
              judged && item.verdict === "contradicted" && item.source
                ? readFigureSource(calculations, target, item.source)
                : null;
            return source && "input" in source && givesItsOwnNumber(target, source.input)
              ? [
                  `${target.reading.chars}: you call it contradicted, but its source gives the same number, ${source.input.number.chars}; give as source the number the Document gives for its own subject, period, column and unit, or the verdict that number gives.`,
                ]
              : [];
          }
          if (!item.source && item.calculation !== null && !calculations.figure(item.calculation))
            return [
              `${target.reading.chars}: calculation [=${item.calculation}] wasn't worked out in this check; call calculate for it, or give its source.`,
            ];
          if (!item.source)
            return item.calculation === null && !target.calculated
              ? [
                  `${target.reading.chars}: a supported figure needs its source (a quote recorded with cite, and the number as it writes it) or its calculation.`,
                ]
              : [];
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
              ...(unrecorded.length > 0 && { requires: "cite" }),
            })
          : null;
      },
    },
  ];
}

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

export function createClaimCheck(deps: ClaimCheckDependencies) {
  return async function checkClaim(request: ClaimCheckRequest): Promise<AtomicClaimCheckResult> {
    const { scope, signal } = request;
    const checkedAt = deps.now();
    const checkingOnlyFacets =
      request.parts !== undefined &&
      request.parts.length > 0 &&
      request.parts.every((part) => part.facet !== undefined);
    const documentIds = scope.documentIds === null ? null : new Set(scope.documentIds);
    const sourceDocuments = () =>
      deps.documents
        .names()
        .filter(
          (document) =>
            !scope.excluded.has(document.id) &&
            (documentIds
              ? documentIds.has(document.id)
              : deps.walledDocument(document.id) === null),
        )
        .flatMap((document) =>
          document.name === undefined
            ? []
            : [
                {
                  id: document.id,
                  name: displayName({ name: document.name, title: document.title }),
                  title: document.title,
                },
              ],
        );
    const sourceContext = () => {
      const original = request.originalClaim ?? request.claim;
      const plans = readPartPlans(request.sourceContext ?? request.parts ?? [], original) ?? [];
      if (!plans.some((part) => part.facet?.kind === "source" && part.facet.selectedDocumentId))
        return [];
      const live = sourceDocuments();
      const wall = deps.walledFolder(request.cacheKey ?? null);
      const key = (text: string) => normaliseText(text).toLocaleLowerCase();
      return plans.filter((part) => {
        const facet = part.facet;
        if (facet?.kind !== "source" || !facet.selectedDocumentId) return false;
        const chosen = live.find((document) => document.id === facet.selectedDocumentId);
        if (!chosen || deps.walledDocument(chosen.id) !== wall) return false;
        return facet.named
          ? key(original.slice(facet.named.start, facet.named.end)) === key(chosen.name)
          : sourceNameIn(original.slice(part.span.start, part.span.end), chosen.name);
      });
    };
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
    const excluded = new Map<string, LeftOutDocument>();
    const decisions = caseCitations(request.originalClaim ?? request.claim);
    const workings = new Map<string, PassageSearchResult[]>();
    const scoped: AnswerDocuments = {
      searchableCount: () => deps.documents.searchableCount(scope.documentIds),
      // A search may name one Document, as an Answer's may: the one a Citation quotes, often.
      documentNamed: (name) => {
        const selected = new Set(
          sourceContext().flatMap((part) =>
            part.facet?.kind === "source" && part.facet.selectedDocumentId
              ? [part.facet.selectedDocumentId]
              : [],
          ),
        );
        const chosen = sourceDocuments().filter(
          (document) =>
            selected.has(document.id) &&
            (name === document.id ||
              (sourceNameIn(name, document.name) && sourceNameIn(document.name, name))),
        );
        if (chosen.length > 0) return chosen.length === 1 ? (chosen[0]?.id ?? null) : null;
        return documentNamedAmong(
          deps.documents
            .searchableBySize(scope.documentIds)
            .filter((each) => !scope.excluded.has(each.id)),
          name,
        );
      },
      async search(query, searchSignal, within) {
        const found = await deps.evidence.search(
          query,
          within ? { ...scope, documentIds: [...within] } : scope,
          searchSignal,
        );
        // A web search's result never settles a citation of a court decision.
        const passages =
          decisions.length === 0
            ? found.passages
            : found.passages.filter((passage) => !deps.documents.savedBySearch(passage.documentId));
        for (const passage of passages) read.set(passage.documentId, passage.contentHash);
        for (const each of found.excluded) {
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
      documentDate: (documentId) => deps.documents.documentDate(documentId),
      passagesBetween: (documentId, from, to) =>
        deps.documents.passagesBetween(documentId, from, to),
    };
    const session = createCitationSession(scoped, { onRecord: () => undefined });
    // The words a Citation quotes don't say where they stand: a sheet row's year is in its
    // sheet's name and heading row, which the check reads only in the Passage itself (#1459).
    const citedPassages = citedSources(request.cited ?? [], scope, deps.documents);
    for (const passage of citedPassages) read.set(passage.documentId, passage.contentHash);
    const citedShown =
      citedPassages.length > 0
        ? session.show(
            citedPassages.map((source) => ({
              ...source,
              seq: 0,
              position: 0,
              windowFrom: 0,
              windowTo: 0,
            })),
          )
        : null;
    // The Passages a Citation quotes are shown from the scope, so a verdict on them has looked.
    const looked = () => searches > 0 || citedShown !== null;
    const { model } = request;
    const calculating = model.support === "tools" && calculates(model.capabilities);
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
    const tools: AnswerTools = {
      get documentCount() {
        return session.tools.documentCount;
      },
      documentLanguages: deps.documents.searchableLanguages(scope.documentIds),
      // Only the model's searches count: looking up a cited court decision shows it nothing.
      searchDocuments: (query, searchSignal, options) => {
        searches++;
        return session.tools.searchDocuments(query, searchSignal, options);
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
            }
          }
          if (pending.size > 0) calculationFailures++;
          return result;
        },
      }),
    };

    const unstatedUnit = (
      citations: readonly Citation[],
      claim = request.claim,
      bound?: readonly BoundNumber[],
      worked?: readonly Figure[],
    ): { why: UnsupportedReason; quote: Citation | null; decides: boolean } | null => {
      const checked = citations.map((citation) => {
        const text = (from: number | null, to: number | null) =>
          scoped
            .pageTexts(citation.documentId, citation.contentHash, from, to)
            .map((unit) => unit.text)
            .join("\n");
        return {
          citation,
          cited: () =>
            citation.pageFrom === null ? citation.quote : text(citation.pageFrom, citation.pageTo),
          document: () => text(null, null),
        };
      });
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
      if (found.kind === "scale") {
        return problem({
          found: true,
          reason: t("claim.unsupported.unit", { amount, figure: found.figure }),
          covered: t("claim.unsupported.currency.covered", { amount }),
          uncovered: t("claim.unsupported.scale.uncovered", { figure: found.figure }),
        });
      }
      if (found.kind === "unit") {
        const reason = t("claim.unsupported.unit", { amount, figure: found.figure });
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
    let facetParts: readonly ClaimCheckPart[] | undefined;
    let facetPlans = request.parts?.filter((plan) => plan.facet !== undefined) ?? [];
    let plannedParts = request.parts;
    const ordinaryPart = () => {
      const plans =
        plannedParts && readPartPlans(plannedParts, request.originalClaim ?? request.claim);
      const ordinary = plans?.filter((part) => part.facet === undefined);
      return ordinary?.length === 1 ? ordinary[0] : undefined;
    };
    const ordinaryRequest = (): ClaimCheckRequest => {
      const part = ordinaryPart();
      if (!part || !plannedParts?.some((plan) => plan.facet)) return request;
      const original = request.originalClaim ?? request.claim;
      return {
        ...request,
        claim: original.slice(part.span.start, part.span.end),
        originalClaim: original,
        parts: plannedParts,
      };
    };
    const facts = () => ({
      ...(retainedEvidence.length > 0 && { checkedEvidence: retainedEvidence }),
      ...(retainedCoverage && { coverage: retainedCoverage }),
      ...(facetParts && { facetParts }),
      versions: [...read].map(
        ([documentId, contentHash]): CheckedVersion => ({ documentId, contentHash }),
      ),
      excluded: [...excluded.values()].filter(
        (each) => each.reason === "own-file" || each.reason === "checked-document",
      ),
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
    ): Promise<ClaimCheckResult | null> => {
      if (checkingOnlyFacets) return null;
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
        prompt,
        documents: deps.documents,
        session,
        versions: read,
        facts,
        citedCase,
        fits: readsWhole(),
        notChecked,
        failedCheck,
      });
    };

    const figureContext = (citation: Citation) =>
      documentFigureContext(
        scoped.pageTexts(citation.documentId, citation.contentHash, null, null),
      );
    const confirmations = new Map<string, Promise<boolean>>();
    let confirmationFailure: ProviderError | null = null;
    const requiresCalculation = async (verdict: ReadVerdict | null): Promise<boolean> => {
      if (checkingOnlyFacets) return false;
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
            STRICT_INSTRUCTIONS,
            figure,
          ).then((result) => {
            if ("failed" in result) {
              confirmationFailure = result.failed;
              return false;
            }
            return readJudgement(result.reply) === "same";
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
      const plans = request.findParts(text);
      if (plans) {
        plannedParts = plans;
        facetPlans = plans.filter((plan) => plan.facet !== undefined);
      }
    };
    let setAside: readonly string[] = [];
    let askedAbout: string | null = null;
    let askedFigures: string | null = null;
    let failed: ProviderError | null = null;
    let finished = false;
    const sourceChoices = sourceContext();
    const prompt = claimPrompt({
      ...request,
      citedShown,
      language: deps.language(),
      sourceContext: sourceChoices,
      sourceDocuments:
        sourceChoices.length > 0
          ? sourceDocuments().filter(
              (document) =>
                deps.walledDocument(document.id) === deps.walledFolder(request.cacheKey ?? null),
            )
          : [],
      ...(Number.isFinite(checkedAt.getTime()) && { checkedAt: checkedAt.toISOString() }),
    });
    for await (const event of deps.engine.generate({
      instructions: (mode, options) =>
        checkInstructions(
          mode,
          deps.language(),
          options?.passages,
          calculating,
          (request.figures?.length ?? 0) > 0,
          request.findParts !== undefined,
          facetPlans.length > 0,
        ),
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      question: request.claim,
      model: model.model,
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
        searchAgain(() => searches, readsWhole),
        ...figuresReplied(
          request,
          figures,
          looked,
          (marker) => session.tools.hasRecord?.(marker) ?? false,
          (text) => {
            askedAbout = text;
            if (readFigureReply(text, request.figures ?? [], request.claim)) askedFigures = text;
          },
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
      ],
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
    if (signal.aborted) return notChecked("stopped");
    if (failed) return failedCheck(failed);
    const ordinaryTarget = ordinaryPart()?.span;
    const targetProof = ordinaryTarget ? { ordinaryTarget } : {};
    const written = figureReplyText(reply, setAside);
    // Asked about its Figures line, a model that can't do what it was asked may write prose
    // in place of its reply ("I can't rewrite that Figures entry…"): the reply asked about stands.
    // One that writes only its Figures line again leaves its verdict on the sentence standing.
    const figureText =
      askedAbout !== null &&
      readVerdict(written) === null &&
      readFigureReply(written, request.figures ?? [], request.claim) === null
        ? askedAbout
        : written;
    const verdictText = readVerdict(figureText) === null ? (askedAbout ?? figureText) : figureText;
    // Claude Haiku 5.5 may write the verdict lines in the turn that calls `cite` after its search,
    // with no marker, and only the sentence after it: the Answer sets that turn aside as a
    // preamble (#1673). Only the last such turn with a verdict counts, so another one's preamble
    // never becomes what the Document says, and a refusal after it is the reply's last word.
    const refused = readsAsRefusal(reply);
    const withVerdict = refused
      ? undefined
      : setAside.findLast((text) => readVerdict(text) !== null);
    let verdict =
      readVerdict(reply) ??
      (withVerdict === undefined ? null : readVerdict(`${withVerdict}\n\n${reply}`));
    const checked =
      request.figures?.length || confirmationFailure || invalidInput || pending.size > 0
        ? []
        : calculated(request.claim, figures, stated, figureContext);
    const worked = checked.find(({ calculation }) => !calculation.agrees) ?? checked[0] ?? null;
    const replies = readAttributionReply(reply, request.originalClaim ?? request.claim, facetPlans);
    const evidenceVerdict = request.figures?.length ? readVerdict(verdictText) : verdict;
    session.check();
    const namedMarkers = [
      ...(evidenceVerdict?.evidence ?? []),
      ...(evidenceVerdict?.coverage?.members.flatMap((member) => member.evidence) ?? []),
      ...(evidenceVerdict?.coverage?.domainEvidence ?? []),
    ];
    const declaredMarkers = [
      ...(!request.figures?.length ? namedMarkers : []),
      ...replies.flatMap((facet) => facet?.evidence ?? []),
    ];
    const rejectedMarkers = new Set(
      session.summary().rejectedRecords.map((record) => record.marker),
    );
    const missing = [
      ...new Set(declaredMarkers.filter((marker) => session.finalCitation(marker) === null)),
    ];
    if (
      finished &&
      reply.trim() !== "" &&
      !refused &&
      (!request.figures?.length || !readsAsRefusal(written)) &&
      looked() &&
      !confirmationFailure &&
      !invalidInput &&
      pending.size === 0 &&
      worked?.calculation.agrees !== false &&
      evidenceVerdict &&
      evidenceVerdict.evidence !== null &&
      evidenceVerdict.coverage !== null &&
      missing.length > 0 &&
      !declaredMarkers.some((marker) => {
        const citation = session.finalCitation(marker);
        return (citation !== null || rejectedMarkers.has(marker)) && citation?.check !== "found";
      })
    ) {
      const recovered = await askForEvidence(
        ordinaryRequest(),
        evidenceVerdict,
        session,
        signal,
        null,
        missing,
        replies.flatMap((parsed, index) => {
          const plan = facetPlans[index];
          return parsed && plan?.facet
            ? [
                {
                  text: (request.originalClaim ?? request.claim).slice(
                    plan.span.start,
                    plan.span.end,
                  ),
                  kind: plan.facet.kind,
                  evidence: parsed.evidence,
                },
              ]
            : [];
        }),
      );
      if (isFailed(recovered)) {
        retainedEvidence = foundCitations(session.finalCitation, null, declaredMarkers);
        return failedCheck(recovered.failed);
      }
      if (signal.aborted) return notChecked("stopped");
    }
    if (facetPlans.length > 0) {
      facetParts = await Promise.all(
        facetPlans.map(async (plan, index) => {
          const parsed = replies[index];
          const base = {
            versions: [...read].map(([documentId, contentHash]) => ({ documentId, contentHash })),
            excluded: [...excluded.values()].filter(
              (left) => left.reason === "own-file" || left.reason === "checked-document",
            ),
          };
          const unavailable = (reason: ClaimCheckFailure, evidence: readonly Citation[] = []) =>
            partWithResult(
              plan,
              { verdict: "not-checked", reason, detail: null, ...base },
              evidence,
            );
          const unsupported = (reason: string, found: boolean): ClaimJudgment => ({
            verdict: "unsupported",
            evidence: null,
            says: null,
            unsupported: {
              reason,
              covered: null,
              uncovered: null,
              ...(found && { found: true }),
            },
            calculation: null,
            ...citedCase(null),
            ...base,
          });
          const catalog = sourceDocuments();
          const selectedDocumentId =
            plan.facet?.kind === "source" ? plan.facet.selectedDocumentId : undefined;
          if (selectedDocumentId && !catalog.some((document) => document.id === selectedDocumentId))
            return partWithResult(
              { ...plan, facet: { kind: "source" } },
              unsupported(translate(deps.language(), "claim.source.chooseAgain"), false),
            );
          if (!parsed) return unavailable("malformed");
          const quoted = parsed.evidence.map((marker) => session.finalCitation(marker));
          if (quoted.some((citation) => citation?.check !== "found"))
            return unavailable("no-evidence");
          const citations = quoted.filter((citation): citation is Citation => citation !== null);
          const evidence = citations[0] ?? null;
          let judged = figureJudgment(parsed, evidence, base, citedCase(evidence));
          let canonicalPlan = plan;
          if (plan.facet?.kind === "source") {
            if (typeof parsed.sourceName !== "string") return unavailable("malformed");
            const source = sourceAttribution({
              words: (request.originalClaim ?? request.claim).slice(plan.span.start, plan.span.end),
              sourceName: parsed.sourceName,
              selectedDocumentId: plan.facet.selectedDocumentId,
              documents: catalog,
              evidence: citations,
            });
            if (!source) return unavailable("malformed");
            if (!source.named) return unavailable("malformed");
            canonicalPlan = {
              ...plan,
              facet: {
                ...source.facet,
                named: {
                  start: plan.span.start + source.named.start,
                  end: plan.span.start + source.named.end,
                },
                candidates: source.candidates.map((candidate) => ({ documentId: candidate.id })),
              },
            };
            if (source.outcome === "choose-again")
              judged = unsupported(translate(deps.language(), "claim.source.chooseAgain"), false);
            else if (source.outcome === "ambiguous")
              judged = unsupported(
                translate(deps.language(), "claim.source.ambiguous", {
                  n: source.candidates.length,
                  name: parsed.sourceName,
                }),
                citations.length > 0,
              );
            else if (source.outcome === "other") {
              if (!source.document) return unavailable("no-evidence");
              judged = unsupported(
                translate(deps.language(), "claim.source.other", {
                  actual: source.document.name,
                  named: parsed.sourceName,
                }),
                true,
              );
            } else if (source.outcome === "missing") {
              if (parsed.verdict !== "unsupported") return unavailable("no-evidence");
              judged = unsupported(
                translate(deps.language(), "claim.source.missing", { name: parsed.sourceName }),
                false,
              );
            }
          }
          if (judged.verdict === "not-checked") return unavailable(judged.reason);
          if (plan.facet?.kind === "speaker") {
            const speaker = speakerAttribution({
              words: (request.originalClaim ?? request.claim).slice(plan.span.start, plan.span.end),
              claimedSpeaker: parsed.claimedSpeaker,
              actualSpeaker: parsed.actualSpeaker,
              actualSpeakerNamed: parsed.actualSpeakerNamed,
              speakerOrigin: parsed.speakerOrigin,
              proofs: citations.map((citation) => ({
                citation,
                units: scoped.pageTexts(
                  citation.documentId,
                  citation.contentHash,
                  citation.pageFrom,
                  citation.pageTo,
                ),
              })),
            });
            if (!speaker) return unavailable("no-evidence", citations);
            if (speaker.outcome) {
              if (!evidence) return unavailable("no-evidence");
              judged = unsupported(
                translate(
                  deps.language(),
                  speaker.outcome === "unknown" ? "claim.speaker.unknown" : "claim.speaker.other",
                  {
                    document: evidence.documentName,
                    speaker: speakerName(speaker.speaker, (key, params) =>
                      translate(deps.language(), key, params),
                    ),
                    claimed: parsed.claimedSpeaker ?? "",
                  },
                ),
                true,
              );
            }
          }
          if (plan.facet?.kind === "time") {
            if (!evidence) return unavailable("no-evidence");
            if (!Number.isFinite(checkedAt.getTime())) return unavailable("malformed");
            const period =
              parsed.period &&
              periodInEvidence(
                parsed.period,
                citations.map((cite) => cite.quote),
              )
                ? parsed.period
                : undefined;
            canonicalPlan = { ...plan, facet: { kind: "time", ...(period && { period }) } };
            const document = evidence.documentName;
            const t = (key: MessageKey, params: MessageParams) =>
              translate(deps.language(), key, params);
            const label = period
              ? formatClaimFacetPeriod(period, deps.language(), { now: checkedAt })
              : "";
            const year = period ? Number(period.end.slice(0, 4)) : null;
            const wantedYear =
              parsed.time === "this-year"
                ? checkedAt.getUTCFullYear()
                : parsed.time === "last-year"
                  ? checkedAt.getUTCFullYear() - 1
                  : null;
            const applies =
              period !== undefined &&
              (parsed.time === "present"
                ? inCurrentPeriodWindow(period, checkedAt)
                : wantedYear !== null
                  ? year === wantedYear && period.start <= checkedAt.toISOString().slice(0, 10)
                  : parsed.time === "explicit");
            if (!applies) {
              judged = {
                verdict: "unsupported",
                evidence: null,
                says: null,
                unsupported: {
                  reason: period
                    ? t("claim.time.stale", { period: label, document })
                    : t("claim.time.noPeriod", { document }),
                  covered: null,
                  uncovered: null,
                  found: true,
                },
                calculation: null,
                ...citedCase(evidence),
                ...base,
              };
            } else if (judged.verdict === "supported") {
              judged = { ...judged, says: t("claim.time.supported", { period: label, document }) };
            }
          }
          if (judged.verdict === "contradicted") {
            if (!evidence) return unavailable("no-evidence");
            if (plan.facet?.kind !== "time")
              judged = figureJudgment(
                { ...parsed, verdict: "unsupported" },
                evidence,
                base,
                citedCase(evidence),
              );
            else {
              const confirmation = await confirmContradiction(
                {
                  ...request,
                  claim: request.originalClaim ?? request.claim,
                  parts: [plan],
                  figures: undefined,
                },
                evidence,
                session,
                signal,
              );
              if ("failed" in confirmation)
                return unavailable(failureOf(confirmation.failed).reason);
              if (confirmation.kind === "stopped") return unavailable("stopped");
              if (confirmation.kind === "malformed") return unavailable("malformed");
              if (confirmation.kind !== "confirmed")
                judged = figureJudgment(
                  { ...parsed, verdict: "unsupported" },
                  evidence,
                  base,
                  citedCase(evidence),
                );
            }
          }
          return partWithResult(canonicalPlan, judged, citations);
        }),
      );
    }
    if (request.figures?.length) {
      if (!finished || reply.trim() === "") return notChecked("empty");
      if (readsAsRefusal(figureText)) return notChecked("refused");
      // A refusal after an ask is the model's last word: the reply asked about can still make the
      // sentence stricter, never Supported.
      const declined = figureText !== written && readsAsRefusal(written);
      if (!looked()) return notChecked("unread");
      // A saved figure is worked out again from its own inputs, within the check's scope.
      const saved = new Map(
        citedSources(
          request.figures
            .flatMap((figure) =>
              figure.calculated && !figure.calculated.figure.analysis
                ? figure.calculated.figure.inputs
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
      if (invalidInput || pending.size > 0) return notChecked("no-evidence");
      let remainderText: string | undefined;
      const judged = async (
        said: ReadVerdict,
        target: ClaimCheckRequest,
        evidence: Citation | null,
      ): Promise<ClaimJudgment> => {
        const result = figureJudgment(said, evidence, facts(), citedCase(evidence));
        if (result.verdict !== "contradicted" || !evidence) return result;
        const confirmation = await confirmContradiction(
          { ...target, figures: undefined },
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
      const said = readVerdict(verdictText);
      // A reply asked about its Figures line that gives its verdict again without one keeps the
      // last line that reads: each figure is still compared with its own quote.
      const figuresText =
        readFigureReply(figureText, request.figures, request.claim) === null
          ? (askedFigures ?? figureText)
          : figureText;
      const result = await checkFigureReply({
        requested: request.figures,
        claim: request.claim,
        reply: figuresText,
        calculations: figures,
        citation: (marker) => session.finalCitation(marker),
        facts,
        caseFlags: citedCase,
        costs: (marker) => stated.get(marker)?.costs ?? new Set(),
        unitReason: (figure, citations, bound) =>
          unstatedUnit(citations, figure, bound)?.why ?? null,
        signal,
        remainder: (remainder) => {
          remainderText = remainder.text;
          return judged(
            remainder,
            {
              ...request,
              claim: remainder.text,
              originalClaim: request.originalClaim ?? request.claim,
              parts: undefined,
            },
            remainder.citation === null ? null : session.finalCitation(remainder.citation),
          );
        },
      });
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
      // about one contradicted check in seven (#2184).
      const sentence = async (verdict: ReadVerdict): Promise<ClaimJudgment> => {
        if (declined && verdict.verdict === "supported") return unchecked("refused");
        const evidence =
          cited ??
          (verdict.verdict === "contradicted"
            ? await askForEvidence(ordinaryRequest(), verdict, session, signal)
            : null);
        if (!isFailed(evidence)) return judged(verdict, ordinaryRequest(), evidence);
        const failure = failureOf(evidence.failed);
        return unchecked(failure.reason, failure.detail);
      };
      const figureResult =
        signal.aborted || (plannedParts !== undefined && !ordinaryPart())
          ? result
          : said
            ? await withSentenceVerdict(result, () => sentence(said))
            : result.verdict === "supported"
              ? await withSentenceVerdict(result, async () => unchecked("malformed"))
              : result;
      const absence = signal.aborted
        ? null
        : await absenceFor(said?.absence ?? null, figureResult.verdict);
      return {
        ...(absence ?? figureResult),
        ...targetProof,
        ...(facetParts && { facetParts }),
        ...(remainderText !== undefined && { remainderText }),
      };
    }
    if (confirmationFailure) return failedCheck(confirmationFailure);
    if (invalidInput || pending.size > 0) return notChecked("no-evidence");
    retainedEvidence = uniqueCitations(
      checked.flatMap(({ calculation }) =>
        calculation.figure.inputs.flatMap((input) => [
          input.citation,
          ...(input.unitStatement ? [input.unitStatement.citation] : []),
        ]),
      ),
    );
    // A figure that disagrees contradicts the sentence. One that agrees settles only that
    // number: the model's verdict still stands on the rest of the sentence.
    if (worked && !worked.calculation.agrees) {
      return {
        verdict: "contradicted",
        evidence: worked.evidence,
        says: null,
        unsupported: null,
        calculation: worked.calculation,
        ...citedCase(worked.evidence),
        ...facts(),
        ...targetProof,
      };
    }
    if (!finished || reply.trim() === "") return notChecked("empty");
    if (!verdict) return notChecked(refused ? "refused" : "malformed");
    if (!looked()) return notChecked("unread");
    session.check();
    if (verdict.evidence === null || verdict.coverage === null) return notChecked("malformed");
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
    const absence = await absenceFor(verdict.absence ?? null, verdict.verdict);
    if (absence) return { ...absence, ...targetProof, ...(facetParts && { facetParts }) };
    if (await requiresCalculation(verdict))
      return confirmationFailure ? failedCheck(confirmationFailure) : notChecked("no-evidence");
    const byCalculation: ClaimCheckResult | null = worked
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
            ...targetProof,
          }
      : null;
    if (confirmationFailure) return failedCheck(confirmationFailure);
    /** Unsupported, with the nearest line when it states another value for the same thing (#770). */
    const unsupported = async (
      why: UnsupportedReason = { reason: null, covered: null, uncovered: null },
      found?: Citation | null,
      judgedNearest?: Citation | null,
    ): Promise<ClaimCheckResult> => {
      const nearest =
        judgedNearest === undefined
          ? await nearestDifferent(ordinaryRequest(), session, signal)
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
              notFailed(
                await askForEvidence(ordinaryRequest(), verdict, session, signal, why.covered),
              ));
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
        ...targetProof,
        excluded: nearest ? left.excluded : [...left.excluded, ...workingsSayingIt()],
      };
    };
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
    const cited =
      namedEvidence[0] ?? (await askForEvidence(ordinaryRequest(), verdict, session, signal));
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
        : await partOf(ordinaryRequest(), quoted, session, signal, deps.language());
    // A general word for the Passage's own party is backed for that party only: the wider group
    // is the part the Documents don't cover (DESIGN.md › Checks). Another party, the parties the
    // other way round, or must for may is no support at all: Claude Haiku 5.5 called "must pay"
    // Supported against "may pay", then named the difference (#1668). The reply says each in a
    // field of its own, so the verdict doesn't rest on the model weighing it.
    const differs = verdict.roles === "differs";
    if (verdict.verdict === "supported" && (verdict.scope === "wider" || differs)) {
      const part = await parts(deciding);
      if (signal.aborted) return notChecked("stopped");
      if (isFailed(part)) return failedCheck(part.failed);
      // The Passage the check cited states the term's own value, so no nearest line is asked about.
      const nearest = differs ? undefined : null;
      if (part.covered && part.uncovered)
        return unsupported({ reason: verdict.says, ...part, found: true }, evidence, nearest);
      if (differs) return unsupported({ ...UNBACKED, reason: verdict.says });
    }
    if (
      byCalculation &&
      onlyCalculation &&
      verdict.verdict === "contradicted" &&
      verdict.says === null &&
      verdict.covered === null &&
      verdict.uncovered === null
    )
      return byCalculation;
    if (verdict.verdict === "contradicted") {
      // The judgements disagree with the check: the card shows the part the quote states
      // (DESIGN.md › Checks).
      const inDoubt = async (): Promise<ClaimCheckResult> => {
        if (unit) return unsupported(unit, unitProblem?.quote ?? null, null);
        if (byCalculation) return byCalculation;
        if (verdict.topic === "not found") return unsupported();
        const part = await parts(deciding);
        if (signal.aborted) return notChecked("stopped");
        if (isFailed(part)) return failedCheck(part.failed);
        if (!part.covered || !part.uncovered) return unsupported(UNBACKED);
        // A judgement has just compared this very quote with the sentence: no nearest line.
        return unsupported({ reason: verdict.says, ...part, found: true }, evidence, null);
      };
      const confirmation = await confirmContradiction(ordinaryRequest(), deciding, session, signal);
      if ("failed" in confirmation) return failedCheck(confirmation.failed);
      if (confirmation.kind === "stopped") return notChecked("stopped");
      // The Passage is about something else: what is nearest may still say something different.
      if (confirmation.kind === "unrelated") {
        return unit
          ? unsupported(unit, unitProblem?.quote ?? null, null)
          : (byCalculation ?? unsupported(verdict.topic === "not found" ? undefined : UNBACKED));
      }
      // Never Supported: in one word it called the parties the other way round the same (#1668).
      if (confirmation.kind === "doubt") return inDoubt();
      // A false contradiction is the worst verdict a check gives, and one judgement upheld near
      // misses (#1647): the strict one finds the quote doesn't state the sentence's detail, and
      // then the card shows the part the quote states (DESIGN.md › Checks). Its "same" doesn't
      // count: writing a Chinese sentence in English, it read a reversed reporting line backwards.
      if (confirmation.kind === "malformed") return notChecked("malformed");
    }
    if (byCalculation && verdict.verdict !== "contradicted") return byCalculation;
    return {
      verdict: verdict.verdict,
      evidence,
      says: verdict.says,
      unsupported: null,
      calculation: worked?.calculation ?? null,
      ...citedCase(evidence),
      ...facts(),
      ...targetProof,
    };
  };
}

interface StatedNumber {
  number: string;
  relation?: LimitRelation;
  /** The names of the inputs the model marked as a cost or deduction printed in brackets. */
  costs: ReadonlySet<string>;
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
    const agrees = agreesWith(number, figure, { relation, costs });
    if (agrees === null) continue;
    const worked = {
      number,
      evidence: first,
      calculation: { figure, stated: number.chars, agrees, ...(relation && { relation }) },
    };
    checked.push(worked);
  }
  return checked;
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
  facets: Parameters<typeof evidencePrompt>[0]["facets"] = [],
): Promise<Citation | null | Failed> {
  const passages = session.shownPassages();
  if (passages.length === 0) return null;
  const { model } = request;
  let reply: string;
  try {
    ({ text: reply } = await generateText({
      model: model.model,
      instructions: covered === null ? EVIDENCE_INSTRUCTIONS : COVERED_EVIDENCE_INSTRUCTIONS,
      prompt: evidencePrompt({
        claim: request.claim,
        originalClaim: request.originalClaim,
        parts: request.parts,
        ...verdict,
        covered,
        passages,
        markers,
        facets,
      }),
      temperature: answerTemperature(model.capabilities.facts.temperature),
      maxOutputTokens: Math.min(4000, 600 * Math.max(1, markers.length)),
      maxRetries: 1,
      abortSignal: signal,
    }));
  } catch (error) {
    if (!signal.aborted)
      console.error(`A check's evidence couldn't be asked for again: ${messageOf(error)}`);
    return { failed: classifyProviderError(error) };
  }
  const records: CitationRecordInput[] = [];
  if (markers.length === 0) {
    const record = readEvidence(reply);
    if (!record) return null;
    records.push({ marker: EVIDENCE_MARKER, ...record });
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
    } catch {
      return null;
    }
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.citations) ||
      parsed.citations.length !== markers.length
    )
      return null;
    const missing = new Set(markers);
    for (const given of parsed.citations) {
      if (!isRecord(given) || typeof given.marker !== "number" || !missing.delete(given.marker))
        return null;
      const record = readEvidence(JSON.stringify(given));
      if (!record) return null;
      records.push({ marker: given.marker, ...record });
    }
  }
  session.tools.cite(records, { structured: true });
  session.check();
  const citations = records.map((record) => session.finalCitation(record.marker));
  return citations.every((citation) => citation?.check === "found") ? (citations[0] ?? null) : null;
}

// In a whole check a model leant to "contradicted" for near misses: a figure for a related thing,
// another site in a parallel Document (#97). Judged alone, the sentence beside its quote, it didn't.
async function compare(
  request: ClaimCheckRequest,
  quoted: Citation | readonly Citation[],
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  instructions: string,
  quantity?: Figure,
): Promise<{ reply: string } | { failed: ProviderError }> {
  const citations: readonly Citation[] = "quote" in quoted ? [quoted] : quoted;
  const passages = citations.map(
    (citation) =>
      session.shownPassages().find((each) => each.passageId === citation.passageId)?.text ??
      citation.quote,
  );
  const { model } = request;
  try {
    const { text } = await generateText({
      model: model.model,
      instructions,
      prompt: confirmPrompt({
        claim: request.claim,
        originalClaim: request.originalClaim,
        parts: request.parts,
        quote: citations.map((citation) => citation.quote).join("\n"),
        passage: passages.join("\n"),
        quantity,
      }),
      temperature: answerTemperature(model.capabilities.facts.temperature),
      maxOutputTokens: 300,
      maxRetries: 1,
      abortSignal: signal,
    });
    return { reply: text };
  } catch (error) {
    return { failed: classifyProviderError(error) };
  }
}

interface Failed {
  failed: ProviderError;
}

const isFailed = (value: unknown): value is Failed =>
  typeof value === "object" && value !== null && "failed" in value;

const notFailed = <T>(value: T | Failed): T | null => (isFailed(value) ? null : value);

async function confirmContradiction(
  request: ClaimCheckRequest,
  quoted: Citation | readonly Citation[],
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
): Promise<
  | { kind: "unrelated" | "doubt" | "confirmed" | "malformed" | "stopped" }
  | { failed: ProviderError }
> {
  const first = await compare(request, quoted, session, signal, CONFIRM_INSTRUCTIONS);
  if (signal.aborted) return { kind: "stopped" };
  if ("failed" in first) return first;
  const judged = readJudgement(first.reply);
  if (judged === "neither") return { kind: "unrelated" };
  if (judged === "same") return { kind: "doubt" };
  const strict = await compare(request, quoted, session, signal, STRICT_INSTRUCTIONS);
  if (signal.aborted) return { kind: "stopped" };
  if ("failed" in strict) return strict;
  const strictly = readJudgement(strict.reply);
  return { kind: strictly === null ? "malformed" : strictly === "neither" ? "doubt" : "confirmed" };
}

async function partOf(
  request: ClaimCheckRequest,
  quoted: Citation | readonly Citation[],
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  language: Language,
): Promise<ReturnType<typeof readPart> | Failed> {
  const asked = await compare(request, quoted, session, signal, partInstructions(language));
  if ("reply" in asked) return readPart(asked.reply);
  if (!signal.aborted)
    console.error(`A sentence's parts couldn't be asked for: ${asked.failed.message}`);
  return { failed: asked.failed };
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
  const judged = await compare(request, citation, session, signal, NEAREST_INSTRUCTIONS);
  if ("failed" in judged) {
    if (!signal.aborted)
      console.error(`A nearest line couldn't be judged: ${judged.failed.message}`);
    return null;
  }
  return readJudgement(judged.reply) === "conflict" ? citation : null;
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

const citationKey = (citation: Citation) =>
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
