import { isCjk, isSpaceless } from "../../shared/text";

const HANGUL = /\p{Script=Hangul}/u;
const LINE_BREAK = /(?<=[^\s])[^\S\n]*\n[^\S\n]*(?=[^\s])/gu;
const ENDS_SENTENCE = /[。．.！!？?；;：:…]/u;
const CLOSES = /[”’"'»›」』】》〉〕）]/u;
const SPACE = /\s/u;

/** The character at `at`, or empty past the end, however many UTF-16 code units it takes. */
function charAt(text: string, at: number): string {
  const code = text.codePointAt(at);
  return code === undefined ? "" : String.fromCodePoint(code);
}

function charBefore(text: string, at: number): string {
  const low = text.charCodeAt(at - 1);
  const high = text.charCodeAt(at - 2);
  const pair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return text.slice(pair ? at - 2 : at - 1, at);
}

/** The first character of `line` that isn't a space, or empty. */
function firstVisible(line: string): string {
  const at = line.search(/[^\s]/u);
  return at < 0 ? "" : charAt(line, at);
}

/** The last character of `line` that isn't a space, or empty. */
function lastVisible(line: string): string {
  let end = line.length;
  while (end > 0 && SPACE.test(line.charAt(end - 1))) end--;
  return end === 0 ? "" : charBefore(line, end);
}

/** A line of a page as printed: what it says, the size it is set in, and where its right end is. */
export interface PrintedLine {
  text: string;
  /** Its largest font size, in points. */
  size: number;
  /** Its right end, in points from the page's left edge. */
  right: number;
}

/** A larger size is a different size past this share: a PDF rounds the sizes it writes. */
const SAME_SIZE = 1.05;

/**
 * Whether `after` continues `before` as a wrapped line, or the page broke
 * the line itself — at a heading, a new paragraph or a new column.
 *
 * A wrapped sentence keeps its font size across the break; a heading is set
 * in a size of its own. And the line it wraps to does not reach farther
 * right than it did: where the page writes no space between words, it ends a
 * line because the next character doesn't fit, so it gives up at most one
 * character of the measure and the next line stays under it. A line that
 * gave up more room than that was ended on purpose.
 *
 * Beside Hangul, Latin or a number, the second test says nothing: the page
 * may wrap before a whole word, which can leave the next line farther right.
 * There only the size tells, and a break that could be a wrap keeps the text
 * rule's join.
 */
export function isWrappedLine(before: PrintedLine, after: PrintedLine): boolean {
  if (before.size > 0 && after.size > 0) {
    const [small, large] =
      before.size < after.size ? [before.size, after.size] : [after.size, before.size];
    if (large > small * SAME_SIZE) return false;
  }
  const ends = lastVisible(before.text);
  const starts = firstVisible(after.text);
  if (ends === "" || starts === "") return false;
  if (!isSpaceless(ends) || !isSpaceless(starts)) return true;
  return after.right <= before.right + Math.max(before.size, after.size);
}

/** A page's text as extraction reads it, and the newlines in it that the page ended itself. */
export interface PrintedText {
  text: string;
  /**
   * The offsets in `text` of the newlines a page ended itself (see
   * `isWrappedLine`). An offset names one break, not every line that reads
   * the same: a page may print one line as a heading and again as wrapped
   * text, and only the heading keeps its break.
   */
  kept: ReadonlySet<number>;
}

const TRAILING_SPACE = /[^\S\n]+$/;
const LEADING_SPACE = /^[^\S\n]+/;

/**
 * A page's text from its printed lines: a break the page wrapped is joined
 * as extraction always joined it, beside Han, kana or Hangul, and the
 * newline of one it broke itself is named in `kept`, so that the wider join,
 * made when the page is processed, leaves it alone (see `joinCjkLineWraps`).
 */
export function joinPrintedLines(lines: readonly PrintedLine[]): PrintedText {
  const kept = new Set<number>();
  let text = "";
  for (const [index, line] of lines.entries()) {
    const before = lines[index - 1];
    if (before === undefined) {
      text = line.text;
      continue;
    }
    if (!isWrappedLine(before, line)) {
      if (lastVisible(before.text) !== "" && firstVisible(line.text) !== "") kept.add(text.length);
      text += `\n${line.text}`;
      continue;
    }
    const joins = isCjk(lastVisible(before.text)) && isCjk(firstVisible(line.text));
    text = joins
      ? `${text.replace(TRAILING_SPACE, "")}${line.text.replace(LEADING_SPACE, "")}`
      : `${text}\n${line.text}`;
  }
  const leading = text.length - text.trimStart().length;
  return {
    text: text.trim(),
    kept: new Set([...kept].map((at) => at - leading).filter((at) => at >= 0)),
  };
}

/**
 * A PDF's line break inside running text, joined the way a reader sees it:
 * gone beside Han, kana, Bopomofo or CJK and full-width punctuation, where no
 * space is written, and between two Hangul characters; one space where only
 * one side is Hangul, whose words keep their spaces; and nowhere else.
 *
 * A line that ends in sentence-ending punctuation, or in the mark that closes
 * it, keeps its break: that is where a paragraph or a list item ends, and the
 * model should read it as one. So does a break at a newline named in
 * `keptAt`: one the page made itself, such as a heading's (see
 * `isWrappedLine`).
 */
export function joinCjkLineWraps(text: string, keptAt?: ReadonlySet<number>): string {
  return text.replace(LINE_BREAK, (match, offset: number) => {
    if (keptAt?.has(offset + match.indexOf("\n"))) return match;
    const before = charBefore(text, offset);
    const after = charAt(text, offset + match.length);
    if (ENDS_SENTENCE.test(before) || CLOSES.test(before)) return match;
    if (isSpaceless(before) || isSpaceless(after)) return "";
    if (!HANGUL.test(before) && !HANGUL.test(after)) return match;
    return HANGUL.test(before) && HANGUL.test(after) ? "" : " ";
  });
}

/** Whether applying only that join rule takes the earlier text to the later text. */
export function onlyCjkLineWrapChange(earlier: string, later: string): boolean {
  return earlier !== later && joinCjkLineWraps(earlier) === later;
}
