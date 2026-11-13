/**
 * Words in quotation marks as the quote check reads them (#483, #2712): which marks pair, where a
 * span opens and closes, the words between them as the model meant them, and whether they are long
 * enough to be a quote rather than a term or a name. The core's quote check (core/answers/quotedWords)
 * and call help's reader (./helpReplyRead) both ask these, so a line's quote is read by one rule.
 */

/** The quotation marks a quote may be wrapped in, each opening with its closing one. */
export const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
  ["«", "»"],
];

/**
 * Where a new Unit starts inside a Passage given to the model ("[p. 4]",
 * "[slide 4]", "[§ 2.1 Sensitivity]", "[Revenue, rows 2–41]", "[lines 51–100]"),
 * where a slide's speaker notes start ("[speaker notes]"), where a Word
 * comment starts ("[comment by Reviewer]"), and a row the file sets aside
 * ("[row 4, struck through]", core/answers/sheetRows).
 */
const LOCATION_MARK =
  /\[(?:p\.\s*\d+(?:[–-]\d+)?|slides?\s+\d+(?:[–-]\d+)?|(?:[^\]\n]{1,100},\s*)?rows?\s+\d+(?:[–-]\d+)?(?:, (?:struck through|hidden))*|lines?\s+\d+(?:[–-]\d+)?|§[^\]\n]{0,200}|speaker notes|comment(?: by [^\]\n]{1,100})?|\d{1,2}:\d{2}(?::\d{2})?(?: [^\]\n]{1,60})?)\]/gi;

/**
 * The quote as the model meant it: without location marks, without the
 * ellipses and quotation marks models put around a quote. Its words are left alone.
 */
export function cleanQuote(raw: string): string {
  // The marks of a scan's unsure words (#535) are the Passage's, never the quote's.
  let quote = raw.replace(/[⟦⟧]/gu, "").replace(LOCATION_MARK, " ").trim();
  for (;;) {
    const before = quote;
    quote = quote
      .replace(/^(?:\.{3}|…)\s*/u, "")
      .replace(/\s*(?:\.{3}|…)$/u, "")
      .trim();
    for (const [open, close] of QUOTE_PAIRS) {
      if (quote.length > 1 && quote.startsWith(open) && quote.endsWith(close)) {
        quote = quote.slice(open.length, -close.length).trim();
      }
    }
    if (quote === before) return quote;
  }
}

/** A span counts as a quote with at least this many words... */
const MIN_WORDS = 4;
/** ...or, in Chinese or Japanese, this many characters. */
const MIN_CJK_CHARACTERS = 6;

/** The longest a quoted span may be, in characters: a longer one is a stray mark paired with a far one. */
const MAX_SPAN = 400;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const WORD = /\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const MARKER = /\[\^(\d{1,4})\]/g;
/** The comma or full stop that US and Chinese typography put inside the closing mark: not the Document's words. */
const TRAILING_PUNCTUATION = /[\s,.;:!?，。；：！？、]+$/u;

/** Whether words are long enough to be a quote. */
export function isQuote(words: string): boolean {
  const spaced = words.replace(CJK, " ");
  return (
    (spaced.match(WORD)?.length ?? 0) >= MIN_WORDS ||
    (words.match(CJK)?.length ?? 0) >= MIN_CJK_CHARACTERS
  );
}

export interface Span {
  start: number;
  /** After the closing mark. */
  end: number;
}

/** Where a quotation mark opens at `at`: an ASCII one needs a space or punctuation before it, and a word after. */
function opensAt(text: string, at: number, open: string, close: string): boolean {
  if (open !== close && open !== "‘") return true;
  const before = text[at - 1];
  const after = text[at + 1];
  return (
    (before === undefined || !LETTER_OR_DIGIT.test(before)) &&
    after !== undefined &&
    !/\s/u.test(after)
  );
}

/** The index of the mark that closes one opened before `from`, or -1. */
function closingFrom(text: string, from: number, open: string, close: string): number {
  const limit = Math.min(text.length, from + MAX_SPAN);
  for (let at = from; at < limit; at++) {
    if (text[at] !== close) continue;
    const next = text[at + 1];
    // A closing ’ is not an apostrophe in a word ("firm’s"); a closing " follows its words, not a space.
    if (open === "‘" && next !== undefined && LETTER_OR_DIGIT.test(next)) continue;
    if (open === close && /\s/u.test(text[at - 1] ?? "")) continue;
    return at;
  }
  return -1;
}

/** The quoted spans of a block of text, in order. */
export function spansOf(text: string): Span[] {
  const pairs = new Map(QUOTE_PAIRS.filter(([open]) => open !== "'"));
  const spans: Span[] = [];
  for (let at = 0; at < text.length; at++) {
    const open = text[at] as string;
    const close = pairs.get(open);
    if (close === undefined || !opensAt(text, at, open, close)) continue;
    const end = closingFrom(text, at + 1, open, close);
    if (end === -1) continue;
    spans.push({ start: at, end: end + 1 });
    at = end;
  }
  return spans;
}

/** The words of a quoted span of `text`, as the quote check reads them. */
export const spanWords = (text: string, span: Span): string =>
  cleanQuote(
    text
      .slice(span.start + 1, span.end - 1)
      .replace(MARKER, "")
      .replace(/[*`]+/g, ""),
  )
    .replace(/\s+/g, " ")
    .replace(TRAILING_PUNCTUATION, "");

/** Whether `text` puts words in quotation marks that the quote check reads as a quote. */
export const holdsQuote = (text: string): boolean =>
  spansOf(text).some((span) => isQuote(spanWords(text, span)));
