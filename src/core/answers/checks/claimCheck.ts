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
import type { FigureContext, FigureUnit } from "../../../shared/figures";
import { type MessageKey, type MessageParams, translate } from "../../../shared/i18n";
import { sentenceSpans } from "../../../shared/sentences";
import type {
  CheckedVersion,
  CheckFigure,
  Citation,
  ClaimCalculation,
  ClaimCheckFailure,
  ClaimCheckResult,
  ClaimJudgment,
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
import type { Language } from "../../language";
import { calculates, givesStructuredOutput } from "../../providers/capabilities";
import type { PreparedChatModel } from "../../providers/chat";
import { classifyProviderError } from "../../providers/providerErrors";
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
  type CiteOptions,
  type DocumentLanguage,
} from "../engine";
import type { TurnCheck } from "../turnChecks";
import { agreesWith, statedFigure } from "./calculated";
import {
  checkFigureReply,
  figureJudgment,
  figureReplyText,
  readFigureReply,
  readFigureSource,
  uncheckedFigureResults,
} from "./figureChecks";
import { figuresMatch, nearestLine } from "./nearest";
import {
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
import { unitNotStated } from "./units";

export interface ClaimCheckDependencies {
  /** The interface language: what a check's sentence is written in. */
  language(): Language;
  engine: AnswerEngine;
  evidence: Pick<Evidence, "search">;
  documents: Pick<AnswerDocuments, "citationSource" | "pageTexts" | "documentDate"> & {
    searchableCount(documentIds: readonly string[] | null): number;
    searchableLanguages(documentIds: readonly string[] | null): DocumentLanguage[];
    /** The Documents with Passages to search, with their names: what a search names one by. */
    searchableBySize(documentIds: readonly string[] | null): { id: string; name: string }[];
    savedBySearch(documentId: string): boolean;
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
  figures?: readonly CheckFigure[];
  context?: string;
  cited?: readonly CheckedCitation[];
  scope: EvidenceScope;
  model: PreparedChatModel;
  /** The Run reads the document being checked (#97): it is third-party from its start. */
  thirdParty?: readonly ThirdPartyReason[];
  /** Names the Mind, for a provider's prompt cache. */
  cacheKey?: string;
  signal: AbortSignal;
}

/** Why a provider's failure left a claim not checked. */
function failureOf(error: ProviderError): { reason: ClaimCheckFailure; detail: string | null } {
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

const FIGURES_LINE =
  "Your reply has no Figures line that can be read. Write your whole reply again, ending with the one Figures: line, its JSON object on that line.";

const figureSourcesNote = (problems: readonly string[], unrecorded: readonly number[]) =>
  [
    ...(unrecorded.length > 0
      ? [
          `Your Figures line names ${unrecorded.map((marker) => `[^${marker}]`).join(", ")}, never recorded: call cite now with each quote it uses, under the marker you gave it.`,
        ]
      : []),
    "Some sources in your Figures line can't be read:",
    ...problems.map((problem) => `- ${problem}`),
    "Fix each one, then write your whole reply again, its Figures line included.",
  ].join("\n");

/**
 * A verdict whose requested figures aren't bound is asked for once more, as `calculate` answers
 * an input it can't read: Claude Haiku 5.5 wrote its verdict and stopped, skipped the cite
 * call, or left out the heading that states a sheet's unit, for about a third of sentences
 * with figures.
 */
function figuresReplied(
  request: ClaimCheckRequest,
  calculations: Pick<CalculationSession, "number">,
  searched: () => boolean,
  recorded: (marker: number) => boolean,
): TurnCheck[] {
  const figures = request.figures ?? [];
  const asked = (text: string) =>
    figures.length > 0 && searched() && !readsAsRefusal(text) && readVerdict(text) !== null;
  return [
    {
      name: "figures-line",
      check: (text) =>
        asked(text) && !readFigureReply(text, figures, request.claim)
          ? { claims: [], note: FIGURES_LINE }
          : null,
    },
    {
      name: "figures-sources",
      check(text) {
        const read = asked(text) ? readFigureReply(text, figures, request.claim) : null;
        if (!read) return null;
        const problems = read.items.flatMap((item) => {
          const target = figures.find((figure) => figure.id === item.id);
          if (!target) return [];
          if (!item.source)
            return item.calculation === null && item.verdict !== "unsupported" && !target.calculated
              ? [
                  `${target.reading.chars}: a ${item.verdict} figure needs its source (a quote recorded with cite, and the number as it writes it) or its calculation.`,
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
                item.source?.citation ? [item.source.citation] : [],
              ),
              ...(remainder ? [remainder] : []),
            ].filter((marker) => !recorded(marker)),
          ),
        ];
        return problems.length > 0
          ? { claims: [], note: figureSourcesNote(problems, unrecorded) }
          : null;
      },
    },
  ];
}

/** The Passages a sentence's Citations quote that its check may read: live, cited and in its scope. */
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
  return async function checkClaim(request: ClaimCheckRequest): Promise<ClaimCheckResult> {
    const { scope, signal } = request;
    let searches = 0;
    const read = new Map<string, string>();
    const excluded = new Map<string, LeftOutDocument>();
    const decisions = caseCitations(request.claim);
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
    const { model } = request;
    const calculating = model.support === "tools" && calculates(model.capabilities);
    const figures = createCalculationSession({
      documents: scoped,
      quotes: session.quotes,
      language: answerLanguage(request.claim),
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
        calculate(given: readonly unknown[], options?: CiteOptions) {
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
              stated.set(marker, {
                number: fields.stated.trim(),
                ...((fields.relation === "at most" || fields.relation === "at least") && {
                  relation: fields.relation,
                }),
                costs: new Set(costs),
              });
          }
          return figures.calculate(givenList(given), options);
        },
      }),
    };

    const unstatedUnit = (
      citations: readonly Citation[],
      claim = request.claim,
      bound?: readonly { chars: string; unit: FigureUnit }[],
    ): UnsupportedReason | null => {
      const checked = citations.map((citation) => {
        const text = (from: number | null, to: number | null) =>
          scoped
            .pageTexts(citation.documentId, citation.contentHash, from, to)
            .map((unit) => unit.text)
            .join("\n");
        return {
          cited: () =>
            citation.pageFrom === null ? citation.quote : text(citation.pageFrom, citation.pageTo),
          document: () => text(null, null),
        };
      });
      const found = unitNotStated(claim, checked, bound);
      if (!found) return null;
      const t = (key: MessageKey, params?: MessageParams) =>
        translate(deps.language(), key, params);
      const { amount } = found;
      if (found.kind === "scale") {
        return {
          found: true,
          reason: t("claim.unsupported.unit", { amount, figure: found.figure }),
          covered: t("claim.unsupported.currency.covered", { amount }),
          uncovered: t("claim.unsupported.scale.uncovered", { figure: found.figure }),
        };
      }
      if (found.kind === "unit") {
        const reason = t("claim.unsupported.unit", { amount, figure: found.figure });
        return { reason, covered: null, uncovered: null, found: true };
      }
      return {
        found: true,
        reason: t("claim.unsupported.currency.reason", { amount }),
        covered: t("claim.unsupported.currency.covered", { amount }),
        uncovered: t("claim.unsupported.currency.uncovered", { currency: found.currency }),
      };
    };
    const facts = () => ({
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

    let reply = "";
    let setAside: readonly string[] = [];
    let failed: ProviderError | null = null;
    let finished = false;
    for await (const event of deps.engine.generate({
      instructions: (mode, options) =>
        checkInstructions(
          mode,
          deps.language(),
          options?.passages,
          calculating,
          (request.figures?.length ?? 0) > 0,
        ),
      messages: [
        {
          role: "user",
          content: claimPrompt({ ...request, citedShown, language: deps.language() }),
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
      window: model.window,
      retryQuotes: model.retryQuotes,
      cacheKey: request.cacheKey,
      isReply: (text) => readVerdict(text) !== null,
      // A model may give its verdict before it has looked: Claude Haiku 5.5 did, about one check
      // in six of a whole Mind.
      turnChecks: [
        {
          name: "search-first",
          check: (text) =>
            searches === 0 && readVerdict(text) ? { claims: [], note: SEARCH_FIRST } : null,
        },
        searchAgain(() => searches),
        ...figuresReplied(
          request,
          figures,
          () => searches > 0,
          (marker) => session.tools.hasRecord?.(marker) ?? false,
        ),
      ],
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
    if (request.figures?.length) {
      if (!finished || reply.trim() === "") return notChecked("empty");
      if (readsAsRefusal(reply)) return notChecked("refused");
      if (searches === 0) return notChecked("unread");
      // A saved figure is worked out again from its own inputs, wherever the model searched.
      const saved = new Map(
        request.figures
          .flatMap((figure) =>
            figure.calculated && !figure.calculated.figure.analysis
              ? figure.calculated.figure.inputs
              : [],
          )
          .flatMap((input) => [
            input.citation,
            ...(input.unitStatement ? [input.unitStatement.citation] : []),
          ])
          .flatMap((citation) => {
            const source = deps.documents.citationSource(citation.passageId);
            return source ? [[source.passageId, source] as const] : [];
          }),
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
      return checkFigureReply({
        requested: request.figures,
        claim: request.claim,
        reply: figureReplyText(reply, setAside),
        calculations: figures,
        citation: (marker) => session.finalCitation(marker),
        facts,
        caseFlags: citedCase,
        costs: (marker) => stated.get(marker)?.costs ?? new Set(),
        unitReason: (figure, citations, bound) => unstatedUnit(citations, figure, bound),
        signal,
        async remainder(remainder) {
          const evidence =
            remainder.citation === null ? null : session.finalCitation(remainder.citation);
          const result = figureJudgment(remainder, evidence, facts(), citedCase(evidence));
          if (result.verdict !== "contradicted" || !evidence) return result;
          const confirmation = await confirmContradiction(
            { ...request, claim: remainder.text, figures: undefined },
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
          if (confirmation.kind !== "confirmed")
            return figureJudgment(
              { ...remainder, verdict: "unsupported" },
              evidence,
              facts(),
              citedCase(evidence),
            );
          return result;
        },
      });
    }
    const figureContext = (citation: Citation) =>
      documentFigureContext(
        scoped.pageTexts(citation.documentId, citation.contentHash, null, null),
      );
    const worked = calculated(request.claim, figures, stated, figureContext);
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
      };
    }
    const byCalculation: ClaimCheckResult | null = worked && {
      verdict: "supported",
      evidence: worked.evidence,
      says: null,
      unsupported: null,
      calculation: worked.calculation,
      ...citedCase(worked.evidence),
      ...facts(),
    };
    if (!finished || reply.trim() === "") return notChecked("empty");
    // Claude Haiku 5.5 may write the verdict lines in the turn that calls `cite` after its search,
    // with no marker, and only the sentence after it: the Answer sets that turn aside as a
    // preamble (#1673). Only the last such turn with a verdict counts, so another one's preamble
    // never becomes what the Document says, and a refusal after it is the reply's last word.
    const refused = readsAsRefusal(reply);
    const withVerdict = refused
      ? undefined
      : setAside.findLast((text) => readVerdict(text) !== null);
    const verdict =
      readVerdict(reply) ??
      (withVerdict === undefined ? null : readVerdict(`${withVerdict}\n\n${reply}`));
    if (!verdict) return notChecked(refused ? "refused" : "malformed");
    if (searches === 0) return notChecked("unread");
    /** Unsupported, with the nearest line when it states another value for the same thing (#770). */
    const unsupported = async (
      why: UnsupportedReason = { reason: null, covered: null, uncovered: null },
      found: Citation | null = null,
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
        !why.covered ||
        !why.uncovered ||
        (request.cited?.length ?? 0) > 0 ||
        opinions.missing ||
        workingsSayingIt().length > 0
          ? null
          : (found ??
            decidingCitation(session.finalCitation) ??
            (await askForEvidence(request, verdict, session, signal, why.covered)));
      if (signal.aborted) return notChecked("stopped");
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
    session.check();
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
      decidingCitation(session.finalCitation) ??
      (await askForEvidence(request, verdict, session, signal));
    const evidence = cited ?? worked?.evidence ?? null;
    const onlyCalculation = cited === null && worked?.evidence != null;
    if (signal.aborted) return notChecked("stopped");
    if (!evidence) return notChecked("no-evidence");
    const unit = unstatedUnit([evidence, ...foundCitations(session.finalCitation, evidence)]);
    if (unit && (verdict.verdict !== "contradicted" || onlyCalculation))
      return unsupported(unit, evidence, null);
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
    const parts = async (quoted: Citation) =>
      verdict.covered && verdict.uncovered
        ? { covered: verdict.covered, uncovered: verdict.uncovered }
        : await partOf(request, quoted, session, signal, deps.language());
    // A general word for the Passage's own party is backed for that party only: the wider group
    // is the part the Documents don't cover (DESIGN.md › Checks). Another party, the parties the
    // other way round, or must for may is no support at all: Claude Haiku 5.5 called "must pay"
    // Supported against "may pay", then named the difference (#1668). The reply says each in a
    // field of its own, so the verdict doesn't rest on the model weighing it.
    const differs = verdict.roles === "differs";
    if (verdict.verdict === "supported" && (verdict.scope === "wider" || differs)) {
      const part = await parts(evidence);
      if (signal.aborted) return notChecked("stopped");
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
        if (unit) return unsupported(unit, evidence, null);
        if (byCalculation) return byCalculation;
        if (verdict.topic === "not found") return unsupported();
        const part = await parts(evidence);
        if (signal.aborted) return notChecked("stopped");
        if (!part.covered || !part.uncovered) return unsupported(UNBACKED);
        // A judgement has just compared this very quote with the sentence: no nearest line.
        return unsupported({ reason: verdict.says, ...part, found: true }, evidence, null);
      };
      const confirmation = await confirmContradiction(request, evidence, session, signal);
      if ("failed" in confirmation) return failedCheck(confirmation.failed);
      if (confirmation.kind === "stopped") return notChecked("stopped");
      // The Passage is about something else: what is nearest may still say something different.
      if (confirmation.kind === "unrelated") {
        return unit
          ? unsupported(unit, evidence, null)
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
): { evidence: Citation; calculation: ClaimCalculation } | null {
  figures.check();
  let agreeing: { evidence: Citation; calculation: ClaimCalculation } | null = null;
  for (const [marker, { number: named, relation, costs }] of stated) {
    const figure = figures.figure(marker);
    const first = figure?.inputs[0]?.citation;
    if (!figure || !first) continue;
    const number = statedFigure(claim, named, contextOf(first));
    if (!number) continue;
    if (figure.inputs.some((input) => input.citation.check !== "found")) continue;
    const agrees = agreesWith(number, figure, { relation, costs });
    if (agrees === null) continue;
    const worked = {
      evidence: first,
      calculation: { figure, stated: number.chars, agrees, ...(relation && { relation }) },
    };
    if (!agrees) return worked;
    agreeing ??= worked;
  }
  return agreeing;
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
): Promise<Citation | null> {
  const passages = session.shownPassages();
  if (passages.length === 0) return null;
  const { model } = request;
  let reply: string;
  try {
    ({ text: reply } = await generateText({
      model: model.model,
      instructions: covered === null ? EVIDENCE_INSTRUCTIONS : COVERED_EVIDENCE_INSTRUCTIONS,
      prompt: evidencePrompt({ claim: request.claim, ...verdict, covered, passages }),
      temperature: answerTemperature(model.capabilities.facts.temperature),
      maxOutputTokens: 600,
      maxRetries: 1,
      abortSignal: signal,
    }));
  } catch (error) {
    if (!signal.aborted)
      console.error(`A check's evidence couldn't be asked for again: ${messageOf(error)}`);
    return null;
  }
  const record = readEvidence(reply);
  if (!record) return null;
  session.tools.cite([{ marker: EVIDENCE_MARKER, ...record }], { structured: true });
  session.check();
  const citation = session.finalCitation(EVIDENCE_MARKER);
  return citation?.check === "found" ? citation : null;
}

// In a whole check a model leant to "contradicted" for near misses: a figure for a related thing,
// another site in a parallel Document (#97). Judged alone, the sentence beside its quote, it didn't.
async function compare(
  request: ClaimCheckRequest,
  quoted: Citation,
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  instructions: string,
): Promise<{ reply: string } | { failed: ProviderError }> {
  const passage = session.shownPassages().find((each) => each.passageId === quoted.passageId);
  const { model } = request;
  try {
    const { text } = await generateText({
      model: model.model,
      instructions,
      prompt: confirmPrompt({
        claim: request.claim,
        quote: quoted.quote,
        passage: passage?.text ?? quoted.quote,
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

async function confirmContradiction(
  request: ClaimCheckRequest,
  quoted: Citation,
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
  quoted: Citation,
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  language: Language,
): Promise<ReturnType<typeof readPart>> {
  const asked = await compare(request, quoted, session, signal, partInstructions(language));
  if ("reply" in asked) return readPart(asked.reply);
  if (!signal.aborted)
    console.error(`A sentence's parts couldn't be asked for: ${asked.failed.message}`);
  return { covered: null, uncovered: null };
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
  deciding: Citation,
): Citation[] {
  const found: Citation[] = [];
  for (let marker = 1; marker <= 4; marker++) {
    const citation = finalCitation(marker);
    if (citation?.check !== "found") continue;
    if (citation.documentId === deciding.documentId && citation.quote === deciding.quote) continue;
    found.push(citation);
  }
  return found;
}

/** The Citation that decides a claim: marker 1's, or the first other marker's, whose quote the check found. */
function decidingCitation(finalCitation: (marker: number) => Citation | null): Citation | null {
  for (let marker = 1; marker <= 4; marker++) {
    const citation = finalCitation(marker);
    if (citation?.check === "found") return citation;
  }
  return null;
}
