import { type ReactNode, useContext } from "react";
import { type QuoteRange, QuoteStepContext, quoteClass, quoteIndexProps } from "./quoteSteps";

/** A string with the parts inside `ranges` (in order) marked as a quote's highlight, as the text view marks it. */
export function HighlightedText({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly QuoteRange[] | undefined;
}): ReactNode {
  const step = useContext(QuoteStepContext);
  if (!ranges || ranges.length === 0) return text;
  // Quotes of one chip may overlap: the text is cut at every edge, each piece written once, and
  // a piece two quotes share is shown as the one the viewer is on.
  const points = [
    ...new Set([0, text.length, ...ranges.flatMap((range) => [range.start, range.end])]),
  ]
    .filter((point) => point >= 0 && point <= text.length)
    .sort((a, b) => a - b);
  const parts: ReactNode[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const from = points[index] as number;
    const to = points[index + 1] as number;
    const covering = ranges.filter((range) => range.start <= from && range.end >= to);
    if (covering.length === 0) {
      parts.push(text.slice(from, to));
      continue;
    }
    const shown = (covering.find((range) => range.quote === step) ?? covering[0]) as QuoteRange;
    parts.push(
      <mark
        key={from}
        data-quote-highlight=""
        {...quoteIndexProps(shown.quote)}
        className={`quote-highlight${quoteClass(shown.quote, step)}`}
      >
        {text.slice(from, to)}
      </mark>,
    );
  }
  return <>{parts}</>;
}
