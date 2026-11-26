/**
 * A quote an agent writes in a Note's text where its Citation goes, "[cite:<passageId>|<its exact
 * words>]", so the change that writes a claim cites it in that one call, with no `cite` call before
 * it (#3753). Each is cited as `cite` cites a quote and its token written in its place, or it is
 * taken out: none is left in the Note as words.
 */

const OPENING = "[cite:";
/** What parts a passageId from its words: "|", or "｜" as a Chinese keyboard types it. */
const PARTS = new Set(["|", "｜"]);
const MAX_ID_CHARS = 200;

/** Where a quote written inline may end, and its words if it ends there. */
export interface InlineEnd {
  /** Just past its closing "]". */
  end: number;
  words: string;
}

export interface InlineQuote {
  /** Its passageId as written, or a Citation's token, which stands for its Passage. */
  id: string;
  /**
   * Each "]" it may end at, nearest first. Its words may hold a "]" themselves, and no escape is
   * asked of the agent: only the Passage tells which "]" closes them.
   */
  ends: [InlineEnd, ...InlineEnd[]];
  /** As written, to its nearest end. */
  written: string;
}

/** A Markdown escape before "|" or "]" in a table's cell is the cell's, not the quote's. */
const wordsOf = (written: string) => written.replace(/\\([|\]])/g, "$1").trim();

function quoteAt(text: string, start: number, bound: number, maxWords: number): InlineQuote | null {
  let at = start + OPENING.length;
  while (text.charAt(at) === " ") at++;
  const idFrom = at;
  while (at < bound && at - idFrom <= MAX_ID_CHARS) {
    const character = text.charAt(at);
    if (PARTS.has(character) || character === "]" || character === "\\" || /\s/.test(character)) {
      break;
    }
    at++;
  }
  const id = text.slice(idFrom, at);
  while (text.charAt(at) === " ") at++;
  if (text.charAt(at) === "\\") at++;
  if (id === "" || !PARTS.has(text.charAt(at))) return null;
  const from = at + 1;
  const last = Math.min(bound, from + maxWords + 1);
  const ends: InlineEnd[] = [];
  for (let close = text.indexOf("]", from); close >= 0 && close < last; ) {
    const words = wordsOf(text.slice(from, close));
    if (words !== "") ends.push({ end: close + 1, words });
    close = text.indexOf("]", close + 1);
  }
  const [nearest, ...further] = ends;
  return nearest
    ? { id, ends: [nearest, ...further], written: text.slice(start, nearest.end) }
    : null;
}

/**
 * `text` with each quote written inline as `cite` puts it: the token it gives in its place, or,
 * given none, nothing, with the spaces before it, as the sentence reads without it. `cite` gives
 * the end it took, one of the quote's `ends`. A Citation's token ("[cite:k3x9a2b7]") is no such
 * quote and stays as written. Scanned by hand: a text runs to 100,000 characters (#3378).
 */
export function quotedInline(
  text: string,
  maxWords: number,
  cite: (quote: InlineQuote) => { end: number; token: string | null },
): string {
  let out = "";
  let copied = 0;
  for (let at = text.indexOf(OPENING); at >= 0; ) {
    const next = text.indexOf(OPENING, at + OPENING.length);
    const quote = quoteAt(text, at, next < 0 ? text.length : next, maxWords);
    if (quote) {
      const { end, token } = cite(quote);
      let before = at;
      if (token === null) {
        while (before > copied && (text[before - 1] === " " || text[before - 1] === "\t")) before--;
      }
      out += text.slice(copied, before) + (token ?? "");
      copied = end;
    }
    at = next;
  }
  return out + text.slice(copied);
}
