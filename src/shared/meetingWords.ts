/**
 * Words to know (#1031): the names and terms the User wants Meetings' Transcripts to get right,
 * kept with their settings, newest first, and the script Transcripts write Chinese in.
 */
import type { LanguagePreference } from "../core/language";

export const MAX_MEETING_WORDS = 100;
export const MAX_MEETING_WORD_LENGTH = 60;

/** A word as the list compares it: two that differ only in case or width are one word. */
export const wordKey = (word: string) => word.normalize("NFKC").toLowerCase();

/** A word typed into the list, as it is kept: on one line, without spaces at its ends. */
export const cleanWord = (typed: string) => typed.replace(/\s+/gu, " ").trim();

export const isMeetingWords = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_MEETING_WORDS &&
  value.every(
    (word) =>
      typeof word === "string" &&
      word !== "" &&
      word === cleanWord(word) &&
      word.length <= MAX_MEETING_WORD_LENGTH,
  ) &&
  new Set(value.map(wordKey)).size === value.length;

export const CHINESE_SCRIPTS = ["simplified", "traditional"] as const;
export type ChineseScript = (typeof CHINESE_SCRIPTS)[number];

export const isChineseScript = (value: unknown): value is ChineseScript =>
  CHINESE_SCRIPTS.some((script) => script === value);

/** Whether a language tag ("zh-TW", "zh_HK", "zh-Hant") writes Chinese in Traditional characters. */
function writesTraditional(tag: string): boolean {
  try {
    return new Intl.Locale(tag.replace(/_/g, "-")).maximize().script === "Hant";
  } catch {
    return false;
  }
}

/**
 * The script the User's Transcripts are written in: the one chosen in Settings › Meetings, else
 * the interface's. The interface has only Simplified Chinese, so one that follows the computer
 * takes the script of the computer's first Chinese language (Traditional for zh-TW and zh-HK).
 */
export function transcriptScript(
  chosen: ChineseScript | null,
  language: LanguagePreference,
  systemLanguages: readonly string[],
): ChineseScript {
  if (chosen) return chosen;
  if (language !== "zh-CN") {
    const chinese = systemLanguages.find((tag) => tag.toLowerCase().split(/[-_]/)[0] === "zh");
    if (chinese && writesTraditional(chinese)) return "traditional";
  }
  return "simplified";
}
