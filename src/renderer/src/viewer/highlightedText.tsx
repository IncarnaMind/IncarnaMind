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
  const parts: ReactNode[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) parts.push(text.slice(at, range.start));
    parts.push(
      <mark
        key={range.start}
        data-quote-highlight=""
        {...quoteIndexProps(range.quote)}
        className={`quote-highlight${quoteClass(range.quote, step)}`}
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    at = range.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
