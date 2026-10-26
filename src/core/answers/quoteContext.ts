import { type FigureContext, readFigures } from "../../shared/figures";
import type { PageText } from "../documents/passages";

export function numericQuoteProblem(
  quote: string,
  units: readonly Pick<PageText, "kind" | "text">[],
  context: FigureContext = {},
): string | null {
  if (!units.some((unit) => (unit.kind ?? "page") === "page")) return null;
  if (units.every((unit) => unit.text.trim() === quote.trim())) return null;
  const figures = readFigures(quote, context);
  const gaps = figures.map((figure, index) =>
    quote.slice(figures[index - 1]?.end ?? 0, figure.start),
  );
  gaps.push(quote.slice(figures.at(-1)?.end ?? 0));
  return figures.length > 0 && gaps.every((gap) => gap.replace(/[\s\p{P}|]/gu, "") === "")
    ? `the quote "${quote}" gives only numbers, without their row or role; quote the labelled row or sentence at the intended location, with its period or revision context, and select the number there. Fix its cite record too if it is used in the Answer.`
    : null;
}
