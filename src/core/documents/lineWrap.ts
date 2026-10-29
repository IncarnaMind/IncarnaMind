import { isSpaceless } from "../../shared/text";

const HANGUL = /\p{Script=Hangul}/u;
const LINE_BREAK = /(?<=[^\s])[^\S\n]*\n[^\S\n]*(?=[^\s])/gu;
const ENDS_SENTENCE = /[。．.！!？?；;：:…]/u;
const CLOSES = /[”’"'»›」』】》〉〕）]/u;

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

/**
 * A PDF's line break inside running text, joined the way a reader sees it:
 * gone beside Han, kana, Bopomofo or CJK and full-width punctuation, where no
 * space is written, and between two Hangul characters; one space where only
 * one side is Hangul, whose words keep their spaces; and nowhere else.
 *
 * A line that ends in sentence-ending punctuation, or in the mark that closes
 * it, keeps its break: that is where a paragraph or a list item ends, and the
 * model should read it as one.
 */
export function joinCjkLineWraps(text: string): string {
  return text.replace(LINE_BREAK, (match, offset: number) => {
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
