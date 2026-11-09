/**
 * The language a reading of Qwen3-ASR is in, as the words it wrote show it, by the names it takes
 * for its `language` option (#1031). The model starts each reading with its own guess
 * ("language English<asr_text>"), but sherpa-onnx strips that header and leaves the result's
 * `lang` empty, so the words it wrote are what is left to read the guess from. Latin letters are
 * English only with words no other language written in them shares; any other Latin text has no
 * language here.
 */

const HAN = /\p{Script=Han}/gu;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HANGUL = /\p{Script=Hangul}/gu;
const LATIN_WORDS = /\p{Script=Latin}+(?:'\p{Script=Latin}+)?/gu;
/** Characters only Cantonese is written with: Mandarin uses others for the same words. */
const CANTONESE = /[係喺嘅咗唔冇啲嘢佢哋噉乜嚟睇咩啱嗰嘞囉噃㗎攞搵諗]/gu;
/**
 * English words that no other language written in Latin letters is known to use as an everyday
 * word. The commonest are missing because one does: "is", "of", "we" (Dutch), "to", "my" (Polish,
 * Czech), "at", "have", "for" (Danish), "will", "not" (German), "but" (French), "are" (Romanian),
 * "it" ("IT"). With them, a phrase borrowed whole ("Nice-to-have") named its German sentence
 * English.
 */
const ENGLISH = new Set(
  [
    "the and you that this what with they there would your our she were does did think know ",
    "yeah it's that's don't i'm we're you're can't going should could",
  ]
    .join("")
    .split(" "),
);
/** Share of a reading's words in one script for it to be in that script's language. */
const ONE_SCRIPT = 0.8;

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** What `text` is written in: Han characters, kana, Hangul and Latin words, counted. */
function scriptsOf(text: string) {
  const han = count(text, HAN);
  const kana = count(text, KANA);
  const hangul = count(text, HANGUL);
  const latin = (text.match(LATIN_WORDS) ?? []).map((word) => word.toLowerCase());
  return { han, kana, hangul, latin, units: han + kana + hangul + latin.length };
}

const inEnglish = (latin: readonly string[]) =>
  new Set(latin.filter((word) => ENGLISH.has(word))).size >= 2;

/** The language of `text`, by Qwen3-ASR's names, or null when its words don't say. */
export function spokenLanguageOf(text: string): string | null {
  const { han, kana, hangul, latin, units } = scriptsOf(text);
  if (units === 0) return null;
  if (kana > 0 && (han + kana) / units >= ONE_SCRIPT) return "Japanese";
  if (hangul / units >= ONE_SCRIPT) return "Korean";
  if (han / units >= ONE_SCRIPT) return count(text, CANTONESE) >= 2 ? "Cantonese" : "Chinese";
  return latin.length / units >= ONE_SCRIPT && inEnglish(latin) ? "English" : null;
}

/**
 * Whether `text` is in Latin letters whose words name no language. It may be English without the
 * words that tell it, or any other language written in them: alone, it shows neither.
 */
export function unnamedLatin(text: string): boolean {
  const { latin, units } = scriptsOf(text);
  return latin.length > 0 && latin.length / units >= ONE_SCRIPT && !inEnglish(latin);
}

/** The script a language is written in, as a test of whether a text is in it at all. */
const SCRIPTS: Readonly<Record<string, RegExp>> = {
  Chinese: /\p{Script=Han}/u,
  Cantonese: /\p{Script=Han}/u,
  Japanese: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  Korean: /\p{Script=Hangul}/u,
  English: /\p{Script=Latin}/u,
};

/** Whether `text` has words, none of them in the script `language` is written in. */
export function writtenOutside(text: string, language: string): boolean {
  const script = SCRIPTS[language];
  return script !== undefined && /\p{L}/u.test(text) && !script.test(text);
}

/**
 * The words of a reading as two readings are compared: Latin words in lower case, "okay" as "ok",
 * and each Han character.
 */
const wordsOf = (text: string) =>
  new Set(
    (text.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{N}]+/gu) ?? []).map((word) =>
      word === "okay" ? "ok" : word,
    ),
  );

/** Whether two readings of the same speech share a word. */
export function shareAWord(one: string, other: string): boolean {
  const words = wordsOf(other);
  return [...wordsOf(one)].some((word) => words.has(word));
}

/**
 * English words Chinese speech says on their own, and abbreviations said letter by letter ("KPI",
 * "PPT", "k p i"): a Chinese call's short reading in them alone was said, not the model's slip.
 */
const SAID_IN_CHINESE = new Set(
  "ok okay email deadline meeting offer boss case bye sorry hello hi thanks yes no".split(" "),
);
const SPELLED = /^(?:\p{Lu}{2,5}|\p{L}(?:[\s.]+\p{L}){1,4})$/u;

/** Whether `text`, in another script than `language`'s, is words that language's speakers say. */
export function borrowedInto(text: string, language: string): boolean {
  if (language !== "Chinese" && language !== "Cantonese") return false;
  const said = text.replace(/[\p{P}\p{S}]+/gu, " ").trim();
  if (SPELLED.test(said)) return true;
  const words = said.toLowerCase().split(/\s+/u);
  return words.length > 0 && words.every((word) => SAID_IN_CHINESE.has(word));
}
