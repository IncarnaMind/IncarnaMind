/**
 * What an Answer's one `calculate` call left: how many figures it shows, and
 * which of its figure markers it couldn't calculate, named by the number the
 * Answer wrote, so its end says what is missing and why (#2313).
 */
import type { AnswerToolCall, UncalculatedFigure } from "../../core/api";
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
 * 6.55. It was written without a calculation IncarnaMind could check." A
 * figure with no number written before it is named by its marker, as "[=1]".
 */
export function uncalculatedWords(figures: AnswerFigures, t: Translate): string {
  const named = figures.missing
    .map((figure) => figure.written ?? `[=${figure.marker}]`)
    .join(t("answer.figures.uncalculated.join"));
  if (figures.uncalculated === 1) {
    return figures.missing.length === 0
      ? t("answer.figures.uncalculated.one")
      : t("answer.figures.uncalculated.named.one", { figures: named });
  }
  return figures.missing.length === 0
    ? t("answer.figures.uncalculated", { count: figures.uncalculated })
    : t("answer.figures.uncalculated.named", {
        count: figures.uncalculated,
        figures: named,
      });
}
