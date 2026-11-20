import { findQuote } from "../../shared/quoteMatch";
import { transcriptCueLines, type UnitText } from "../../shared/units";
import { normalizeSummaryEvidence } from "./summaryItems";

function originalExcerpt(text: string, words: string): string {
  const [range] = findQuote(text, words) ?? [];
  if (range) {
    const excerpt = text.slice(range.start, range.end);
    if (normalizeSummaryEvidence(excerpt) === words) return excerpt;
  }
  return text;
}

export function meetingSummarySources(units: readonly UnitText[], quotes: readonly string[]) {
  const lines = transcriptCueLines(units).map(({ startMs, endMs, text }) => ({
    startMs,
    endMs,
    text,
    words: normalizeSummaryEvidence(text),
    excerpts: new Set<string>(),
  }));
  for (const quote of quotes) {
    const words = normalizeSummaryEvidence(quote);
    if (!words) continue;
    const matches = lines.filter((line) => line.words.includes(words));
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only) only.excerpts.add(originalExcerpt(only.text, words));
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
