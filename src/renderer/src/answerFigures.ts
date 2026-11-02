/**
 * What an Answer's one `calculate` call left: how many figures it shows, and
 * which of its figure markers it couldn't calculate, named by the number the
 * Answer wrote, so its end says what is missing and why (#2313).
 */
import type { AnswerToolCall, UncalculatedFigure } from "../../core/api";
import type { Language } from "../../core/language";
import type { Translate } from "./objects";

export interface AnswerFigures {
  calculated: number;
  uncalculated: number;
  /** The figures it couldn't calculate: the markers and the numbers written before them. */
  missing: readonly UncalculatedFigure[];
}

const isCalculated = (call: AnswerToolCall) => call.tool === "calculate";

export function figuresOf(calls: readonly AnswerToolCall[]): AnswerFigures {
  const call = calls.find(isCalculated);
  const missing = call?.uncalculatedFigures ?? [];
  return {
    calculated: call?.resultCount ?? 0,
    uncalculated: call?.uncalculated ?? 0,
    missing,
  };
}

/**
 * What the Answer's end says for its figures: "1 figure couldn't be calculated:
 * 6.55. It was written without a calculation IncarnaMind could check.", with a
 * list in the language's pattern for more. A figure the Answer wrote no number
 * before keeps only the count, never the marker's syntax (#2313).
 */
export function uncalculatedWords(
  figures: AnswerFigures,
  t: Translate,
  language: Language,
): string {
  const named = figures.missing.flatMap((figure) => (figure.written ? [figure.written] : []));
  const everyFigureNamed = figures.uncalculated > 0 && named.length === figures.uncalculated;
  if (!everyFigureNamed) {
    return figures.uncalculated === 1
      ? t("answer.figures.uncalculated.one")
      : t("answer.figures.uncalculated", { count: figures.uncalculated });
  }
  const list = new Intl.ListFormat(language, { type: "conjunction" }).format(named);
  return figures.uncalculated === 1
    ? t("answer.figures.uncalculated.named.one", { figures: list })
    : t("answer.figures.uncalculated.named", { count: figures.uncalculated, figures: list });
}
