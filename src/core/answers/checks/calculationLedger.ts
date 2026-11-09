/**
 * A check's calculations (ADR-0021, #707): the figures the model works out with `calculate`, the
 * sentence's number each is for, and whether the sentence still needs one worked out.
 */
import type { Figure, FigureContext } from "../../../shared/figures";
import type { Citation, ClaimCalculation, LimitRelation } from "../../api";
import { checkCalculates } from "../../providers/capabilities";
import type { PreparedChatModel } from "../../providers/chat";
import {
  answerLanguage,
  type CalculationSession,
  createCalculationSession,
  documentFigureContext,
  givenList,
  toldFigure,
  whole,
} from "../calculations";
import type { AnswerDocuments, createCitationSession } from "../citations";
import type { AnswerTools, CiteOptions } from "../engine";
import type { NotJudged } from "../judge";
import { agreesWith, comparedFigure, statedFigure } from "./calculated";
import { needsCalculation } from "./calculationGate";
import { foundCitations } from "./checkResults";
import type { ClaimCheckRequest } from "./claimCheck";
import { compare } from "./looks";
import { type ReadVerdict, readJudgement, STRICT_INSTRUCTIONS } from "./prompt";

interface StatedNumber {
  number: string;
  relation?: LimitRelation;
  /** The names of the inputs the model marked as a cost or deduction printed in brackets. */
  costs: ReadonlySet<string>;
  /** The calculate item as the model gave it, to work out again once its quotes are recorded. */
  given?: unknown;
}

export const calculatesIn = (
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

/** Each figure's context, as its Citation's Document gives it. */
export const figureContextIn =
  (documents: Pick<AnswerDocuments, "pageTexts">) => (citation: Citation) =>
    documentFigureContext(
      documents.pageTexts(citation.documentId, citation.contentHash, null, null),
    );

export function createCalculationLedger(
  request: Pick<ClaimCheckRequest, "claim" | "cited" | "model" | "signal">,
  documents: AnswerDocuments,
  session: ReturnType<typeof createCitationSession>,
  calculating: boolean,
) {
  const { signal } = request;
  const recorded = new Set<number>();
  let attempts = 0;
  let invalidInput = false;
  let calculationFailures = 0;
  const pending = new Map<number, StatedNumber>();
  const figures = createCalculationSession({
    documents,
    quotes: session.quotes,
    language: answerLanguage(request.claim),
    onRecord: (marker) => recorded.add(marker),
  });
  /** The sentence's number each figure is for, as the model named it, and how, by marker. */
  const stated = new Map<number, StatedNumber>();
  const figureContext = figureContextIn(documents);
  const tools: Required<Pick<AnswerTools, "calculate" | "calculationFailed">> = {
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
        return !statedFigure(request.claim, number.number, citation ? figureContext(citation) : {});
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
          const cites = (number.given as { inputs?: readonly unknown[] } | undefined)?.inputs ?? [];
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
        const own = citation && statedFigure(request.claim, number.number, figureContext(citation));
        const compared = figure && own ? comparedFigure(own, figure, number.costs) : null;
        if (figure && compared && compared !== figure)
          toldAtSize = toldAtSize.replace(toldFigure(marker, figure), () =>
            toldFigure(marker, compared),
          );
      }
      return toldAtSize;
    },
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
        tools.calculate([entry.given]);
    }
  };

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
        units: documents.pageTexts(citation.documentId, citation.contentHash, null, null),
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

  return {
    calculations: figures,
    /** The `calculate` Tool, for a model measured to use it; null otherwise. */
    tools: calculating ? tools : null,
    attempts: () => attempts,
    invalidInput: () => invalidInput,
    pending: () => pending.size > 0,
    retryPendingQuotes,
    costs: (marker: number): ReadonlySet<string> => stated.get(marker)?.costs ?? new Set(),
    worked: () => calculated(request.claim, figures, stated, figureContext),
    requiresCalculation,
    confirmationFailure: () => confirmationFailure,
  };
}

export type CalculationLedger = ReturnType<typeof createCalculationLedger>;

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
