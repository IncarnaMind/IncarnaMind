/**
 * A quote as a person reads it (#905). The Citation check matches a quote against a PDF's text
 * with its line breaks and the hyphens that split words at them; a card shows the words: a
 * hyphen that split a word at a line end is gone ("em-\nploy" reads "employ"), a quote that stops
 * at one runs to the end of the word, and a real hyphen stays. Shown only; matching is unchanged.
 */
import type { TextRange } from "./quoteMatch";
import { isCjk } from "./text";

const SOFT_HYPHEN = "\u00ad";
const HYPHENS: ReadonlySet<string> = new Set(["-", "\u2010", "\u2011"]);

const LINE_END_HYPHEN = /([-\u2010-\u2015\u00ad])[^\S\n]*\r?\n[^\S\n]*(?=[\p{L}\p{N}])/gu;
const ANY_HYPHEN = /[-\u2010\u2011\u00ad]/u;
const WORD_CHARACTER = /[\p{L}\p{N}'’-]/u;
const LETTER = /\p{L}/u;
const UPPERCASE = /\p{Lu}/u;
const LOWERCASE = /\p{Ll}/u;
const CONTINUES = /^[^\S\n]*\r?\n[^\S\n]*(\p{L}[\p{L}\p{N}'’]*)/u;
const WHITESPACE_RUN = /\s+/gu;

// A hyphen only splits a word in a script written with spaces.
const isSpacedLetter = (character: string | undefined) =>
  character !== undefined && LETTER.test(character) && !isCjk(character);

function wordBefore(text: string, at: number): string {
  let start = at;
  while (start > 0 && WORD_CHARACTER.test(text.charAt(start - 1))) start--;
  return text.slice(start, at);
}

function wordAfter(text: string, at: number): string {
  let end = at;
  while (end < text.length && WORD_CHARACTER.test(text.charAt(end))) end++;
  return text.slice(at, end);
}

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const hasWord = (evidence: string, word: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapePattern(word)}(?![\\p{L}\\p{N}])`, "iu").test(evidence);

/**
 * The same rule as matching (a hyphen of its own either side of the break, or a small letter
 * before a capital), then what the page writes elsewhere, whole: "longterm" joins, "long-term" keeps.
 */
function isRealHyphen(before: string, after: string, evidence: string): boolean {
  if (before.includes("-") || after.includes("-")) return true;
  if (LOWERCASE.test(before.at(-1) ?? "") && UPPERCASE.test(after[0] ?? "")) return true;
  if (hasWord(evidence, `${before}${after}`)) return false;
  return hasWord(evidence, `${before}-${after}`);
}

/**
 * What a line break in a quote is: "join", a break a PDF's layout put in, which goes; "keep", one
 * the Document shows as its own (a text file's lines, a Word file's paragraphs, a transcript's
 * turns), which stays, so a quote that spans two turns reads as two (#3587).
 */
export type QuoteLines = "join" | "keep";

function read(raw: string, evidence: string, lines: QuoteLines = "join"): string {
  const joined = raw.replace(LINE_END_HYPHEN, (match, hyphen: string, offset: number) => {
    if (hyphen === SOFT_HYPHEN) return "";
    const letters = isSpacedLetter(raw[offset - 1]) && isSpacedLetter(raw[offset + match.length]);
    if (letters && HYPHENS.has(hyphen)) {
      const before = wordBefore(raw, offset);
      const after = wordAfter(raw, offset + match.length);
      return isRealHyphen(before, after, evidence) ? hyphen : "";
    }
    // A dash, or a hyphen before a digit, stays with the break gone ("COVID-19", "1990–1995").
    return /\s/u.test(raw[offset - 1] ?? " ") ? match : hyphen;
  });
  // Chinese and Japanese put no space between words, so a line break between them leaves none;
  // a space the writer typed (before a Latin word or a figure) stays.
  return joined
    .replace(WHITESPACE_RUN, (run, offset: number) => {
      if (!run.includes("\n")) return " ";
      if (lines === "keep") return run.replace(/[^\S\n]+/gu, "");
      const before = joined.charAt(offset - 1);
      const after = joined.charAt(offset + run.length);
      return (before !== "" && isCjk(before)) || (after !== "" && isCjk(after)) ? "" : " ";
    })
    .trim();
}

function wholeWord(text: string, { end }: TextRange): number {
  const stopsAtHyphen = ANY_HYPHEN.test(text[end - 1] ?? "") && isSpacedLetter(text[end - 2]);
  const hyphenFollows = isSpacedLetter(text[end - 1]) && ANY_HYPHEN.test(text[end] ?? "");
  if (!stopsAtHyphen && !hyphenFollows) return end;
  const from = end + (hyphenFollows ? 1 : 0);
  const next = CONTINUES.exec(text.slice(from));
  return next ? from + next[0].length : end;
}

/**
 * The quote found at `ranges` of a text (one for each part of a quote with an ellipsis, see
 * `findQuote`), read as words, a part that stops at a split word run to its end.
 */
export function readableQuote(
  text: string,
  ranges: readonly TextRange[],
  lines: QuoteLines = "join",
): string {
  return ranges
    .map((range) => read(text.slice(range.start, wholeWord(text, range)), text, lines))
    .join(" … ");
}

/** A quote read with nothing else to go by: a break in it is joined unless the hyphens are real by the rule. */
export const readableQuoteText = (quote: string): string => read(quote, "");
