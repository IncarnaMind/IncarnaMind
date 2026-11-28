import { cueTarget } from "../../shared/units";
import type { Cue } from "../documents/formats/vtt";

interface LocatedSummaryQuote {
  words: string;
  targets: string[];
}

export type StoredSummaryQuote = string | LocatedSummaryQuote;

export function normalizeSummaryEvidence(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[，：；！？（）]/gu, (mark) => String.fromCharCode(mark.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

export function summaryEvidenceCue({
  startMs,
  endMs,
  text,
}: Pick<Cue, "startMs" | "endMs" | "text">) {
  return {
    target: cueTarget(Math.max(0, startMs), Math.max(0, endMs)),
    words: normalizeSummaryEvidence(text),
  };
}

type EvidenceCue = ReturnType<typeof summaryEvidenceCue>;

export function summaryQuoteWords(quote: StoredSummaryQuote): string {
  return typeof quote === "string" ? normalizeSummaryEvidence(quote) : quote.words;
}

function* matchingSummaryCues(quote: StoredSummaryQuote, cues: readonly EvidenceCue[]) {
  const words = summaryQuoteWords(quote);
  const targets = typeof quote === "string" ? null : new Set(quote.targets);
  if (!words || targets?.size === 0) return;
  for (const [index, cue] of cues.entries()) {
    if ((!targets || targets.has(cue.target)) && cue.words.includes(words)) {
      yield { index, target: cue.target };
    }
  }
}

export function storeSummaryQuote(
  quote: string,
  cues: readonly EvidenceCue[],
): LocatedSummaryQuote {
  const words = normalizeSummaryEvidence(quote);
  return { words, targets: Array.from(matchingSummaryCues(words, cues), ({ target }) => target) };
}

export function storeSummaryQuotes(
  quotes: readonly string[],
  cues: readonly EvidenceCue[],
): LocatedSummaryQuote[] {
  const entries = quotes.map((quote) => {
    const words = normalizeSummaryEvidence(quote);
    return { words, matches: Array.from(matchingSummaryCues(words, cues)) };
  });
  const anchors = entries.filter(({ matches }) => matches.length === 1);
  const anchorIndex = anchors.length === 1 ? anchors[0]?.matches[0]?.index : undefined;
  return entries.map(({ words, matches }) => {
    if (anchorIndex !== undefined && matches.length > 1) {
      let best = Infinity;
      let closest: typeof matches = [];
      for (const match of matches) {
        const distance = Math.abs(match.index - anchorIndex);
        if (distance < best) {
          best = distance;
          closest = [match];
        } else if (distance === best) {
          closest.push(match);
        }
      }
      if (closest.length === 1 && closest[0]) {
        return { words, targets: [closest[0].target] };
      }
    }
    return { words, targets: matches.map(({ target }) => target) };
  });
}

export function sameSummaryQuote(a: StoredSummaryQuote, b: LocatedSummaryQuote): boolean {
  return (
    typeof a !== "string" &&
    a.words === b.words &&
    a.targets.length === b.targets.length &&
    a.targets.every((target, index) => target === b.targets[index])
  );
}

export function summaryQuoteSurvives(
  quote: StoredSummaryQuote,
  cues: readonly EvidenceCue[],
): boolean {
  return matchingSummaryCues(quote, cues).next().done === false;
}

export function originalSummaryCue(quote: StoredSummaryQuote, cues: readonly EvidenceCue[]) {
  // Even a surviving lone match was ambiguous when first cited if there were other candidates.
  if (typeof quote !== "string" && quote.targets.length !== 1) return undefined;
  const matches = matchingSummaryCues(quote, cues);
  const first = matches.next();
  return !first.done && matches.next().done ? first.value.index : undefined;
}
