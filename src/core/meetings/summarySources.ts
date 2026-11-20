import { findQuote } from "../../shared/quoteMatch";
import { transcriptCueLines, type UnitText } from "../../shared/units";
import {
  normalizeSummaryEvidence,
  originalSummaryCue,
  type StoredSummaryQuote,
  summaryEvidenceCue,
  summaryQuoteWords,
} from "./summaryEvidence";

function originalExcerpt(text: string, words: string): string {
  const [range] = findQuote(text, words) ?? [];
  if (range) {
    const excerpt = text.slice(range.start, range.end);
    if (normalizeSummaryEvidence(excerpt) === words) return excerpt;
  }
  return text;
}

export function meetingSummarySources(
  units: readonly UnitText[],
  quotes: readonly StoredSummaryQuote[],
) {
  const lines = transcriptCueLines(units).map(({ startMs, endMs, text }) => ({
    startMs,
    endMs,
    text,
    excerpts: new Set<string>(),
  }));
  const speech = lines.map(summaryEvidenceCue);
  for (const quote of quotes) {
    const index = originalSummaryCue(quote, speech);
    const only = index === undefined ? undefined : lines[index];
    if (only) only.excerpts.add(originalExcerpt(only.text, summaryQuoteWords(quote)));
  }
  return lines.flatMap(({ startMs, endMs, text, excerpts }) => {
    if (excerpts.size === 0) return [];
    const longest = [...excerpts].sort((a, b) => b.length - a.length)[0] ?? text;
    return [
      {
        startMs,
        endMs,
        text: [...excerpts].every((excerpt) => longest.includes(excerpt)) ? longest : text,
      },
    ];
  });
}
