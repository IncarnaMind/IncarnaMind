import type { CitationAttributes, ClaimCheckAttributes } from "../../../core/api";
import { boundedQuote } from "../../../shared/claimParts";

/** What a quote does for its sentence, as the check that found it said. */
export type QuoteRole = "otherwise" | "so";

/** A check card's quotes, grouped by what they do; `role` null where the check didn't say. */
export interface QuoteGroup<T> {
  role: QuoteRole | null;
  quotes: T[];
}

/**
 * A card's quotes in groups (#3715): those that say otherwise first, then those that say so, as
 * the check named them. Where it named none, a contradicted sentence's one quote is what
 * contradicts it, and any other's quotes stay together with no label.
 */
export function quoteGroups(
  check: Pick<ClaimCheckAttributes, "otherwise">,
  state: string,
  quotes: readonly CitationAttributes[],
): QuoteGroup<CitationAttributes>[] {
  if (quotes.length === 0) return [];
  if (state === "supported") return [{ role: null, quotes: [...quotes] }];
  const named = check.otherwise;
  if (!named) {
    return [
      {
        role: state === "contradicted" && quotes.length === 1 ? "otherwise" : null,
        quotes: [...quotes],
      },
    ];
  }
  const rank = (quote: CitationAttributes) =>
    quote.quote === null ? -1 : named.indexOf(boundedQuote(quote.quote));
  // Those that say otherwise in the order the check named them, the first the one it named first.
  const otherwise = quotes.filter((quote) => rank(quote) >= 0).sort((a, b) => rank(a) - rank(b));
  return [
    { role: "otherwise" as const, quotes: otherwise },
    { role: "so" as const, quotes: quotes.filter((quote) => rank(quote) < 0) },
  ].filter((group) => group.quotes.length > 0);
}
