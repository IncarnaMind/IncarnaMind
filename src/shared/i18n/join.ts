import type { Language } from "../../core/language";

const FULL_WIDTH_PUNCTUATION = /[，。：；？！、（）“”‘’…—《》【】]$/u;
const FULL_WIDTH_PUNCTUATION_START = /^[，。：；？！、（）“”‘’…—《》【】]/u;
const HAN_END = /\p{Script=Han}$/u;
const HAN_START = /^\p{Script=Han}/u;

/**
 * What goes between two pieces of text a screen puts side by side: a space in
 * English; in Chinese none after or before full-width punctuation or a space
 * already there, or between Chinese characters, else a space (docs/agents/zh-CN.md).
 */
export function gap(language: Language, before: string, after: string): string {
  if (language !== "zh-CN") return " ";
  if (before === "" || after === "" || /\s$/u.test(before) || /^\s/u.test(after)) return "";
  if (FULL_WIDTH_PUNCTUATION.test(before) || FULL_WIDTH_PUNCTUATION_START.test(after)) return "";
  return HAN_END.test(before) && HAN_START.test(after) ? "" : " ";
}

/** "A and B", "A、B 和 C": a space where 和 meets a Latin letter or a digit (docs/agents/zh-CN.md). */
export function listOf(items: readonly string[], language: Language): string {
  const latin = /[A-Za-z0-9%]/;
  return new Intl.ListFormat(language, { type: "conjunction" })
    .formatToParts(items)
    .map((part, at, parts) => {
      if (part.type !== "literal" || !/^\p{Script=Han}+$/u.test(part.value)) return part.value;
      const before = latin.test(parts[at - 1]?.value.at(-1) ?? "") ? " " : "";
      const after = latin.test(parts[at + 1]?.value.charAt(0) ?? "") ? " " : "";
      return before + part.value + after;
    })
    .join("");
}
