import { CJK } from "../../shared/text";

const FULL_WIDTH_PUNCTUATION =
  "\\u3000-\\u303f\\ufe30-\\ufe4f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65";
const WRAP_SIDE = `${CJK}${FULL_WIDTH_PUNCTUATION}`;
const LINE_WRAP = /[^\S\n]*\n[^\S\n]*/gu;
const WRAP_SIDE_CHAR = new RegExp(`[${WRAP_SIDE}]`, "u");
const HANGUL = /\p{Script=Hangul}/u;

/** A break with two CJK sides is removed as before; a newly eligible one beside Hangul becomes one space. */
export function joinCjkLineWraps(text: string): string {
  return text.replace(LINE_WRAP, (match: string, offset: number) => {
    const before = text.slice(0, offset);
    const after = text.slice(offset + match.length);
    if (/(?:^|\n)[^\S\n]*$/.test(before) || /^[^\S\n]*\n/.test(after)) return match;
    const left = before.at(-1) ?? "";
    const right = after.at(0) ?? "";
    const leftCjk = WRAP_SIDE_CHAR.test(left);
    const rightCjk = WRAP_SIDE_CHAR.test(right);
    if (!leftCjk && !rightCjk) return match;
    return (HANGUL.test(left) && !rightCjk) || (HANGUL.test(right) && !leftCjk) ? " " : "";
  });
}

/** Whether applying only that join rule takes the earlier text to the later text. */
export function onlyCjkLineWrapChange(earlier: string, later: string): boolean {
  return earlier !== later && joinCjkLineWraps(earlier) === later;
}
