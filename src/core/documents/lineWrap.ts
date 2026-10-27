import { CJK } from "../../shared/text";

const FULL_WIDTH_PUNCTUATION =
  "\\u3000-\\u303f\\ufe30-\\ufe4f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65";
const WRAP_SIDE = `${CJK}${FULL_WIDTH_PUNCTUATION}`;
const CJK_ON_LEFT = new RegExp(`([${WRAP_SIDE}])[^\\S\\n]*\\n[^\\S\\n]*`, "gu");
const CJK_ON_RIGHT = new RegExp(`[^\\S\\n]*\\n[^\\S\\n]*(?=[${WRAP_SIDE}])`, "gu");

/** A PDF's line break beside CJK text or full-width punctuation is not a space. */
export function joinCjkLineWraps(text: string): string {
  return text.replace(CJK_ON_LEFT, "$1").replace(CJK_ON_RIGHT, "");
}

/** Whether applying only that join rule takes the earlier text to the later text. */
export function onlyCjkLineWrapChange(earlier: string, later: string): boolean {
  return earlier !== later && joinCjkLineWraps(earlier) === later;
}
