/**
 * The numbers a sentence states, read so that a sentence the assistant adds can be told from one
 * that restates the old text (#1385): one that keeps the old words but changes a figure (950 →
 * 1,200, 五天 → 十五天) says something new. Read wide on purpose, unlike ../../../shared/figures,
 * which leaves out dates, years and Chinese numerals that are words ("一方"): here a number read
 * where none was meant can only hold a sentence to its Citation, never let a new figure pass.
 */

// Its scale is part of it: "3万" is one number, not 3 and a Chinese 万.
const DIGITS = /(\d+(?:[,，]\d{3})*(?:\.\d+)?)([千万亿]?)/g;
const SCALES: Readonly<Record<string, number>> = { 千: 1e3, 万: 1e4, 亿: 1e8 };
const HAN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const HAN_UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1e3 };
const HAN_NUMERAL = /[零〇一二两三四五六七八九十百千万亿]+/g;
const WORDS: readonly string[] = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS: readonly string[] = [
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
const WORD_NUMBER = new RegExp(
  `\\b(?:(${TENS.join("|")})(?:[-\\s](${WORDS.slice(1, 10).join("|")}))?|(${WORDS.join("|")}))\\b`,
  "gi",
);

/** A Chinese numeral's value: "十五" 15, "三万" 30000, "二〇二五" 2025 (digits alone, one by one). */
function hanValue(numeral: string): number {
  const characters = [...numeral];
  if (characters.every((character) => character in HAN_DIGITS) && characters.length > 1) {
    return Number(characters.map((character) => HAN_DIGITS[character]).join(""));
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const character of characters) {
    const value = HAN_DIGITS[character];
    const unit = HAN_UNITS[character];
    const scale = character === "万" ? 1e4 : character === "亿" ? 1e8 : undefined;
    if (value !== undefined) digit = value;
    else if (unit !== undefined) {
      section += (digit === 0 ? 1 : digit) * unit;
      digit = 0;
    } else if (scale !== undefined) {
      total = (total + section + digit) * scale;
      section = 0;
      digit = 0;
    }
  }
  return total + section + digit;
}

/** A value as compared: "1,200", "1200" and "1200.0" alike. */
const keyOf = (value: number) => String(Math.round(value * 1e9) / 1e9);

/** The numbers `sentence` states, each as a value, whatever script or separators it is written in. */
export function sentenceNumbers(sentence: string): Set<string> {
  const text = sentence.normalize("NFKC");
  const found = new Set<string>();
  const digits = text.replace(DIGITS, (match: string, number: string, scale: string) => {
    found.add(keyOf(Number(number.replace(/[,，]/g, "")) * (SCALES[scale] ?? 1)));
    return " ".repeat(match.length);
  });
  for (const match of digits.matchAll(HAN_NUMERAL)) found.add(keyOf(hanValue(match[0])));
  for (const match of digits.matchAll(WORD_NUMBER)) {
    const [, tens, ones, word] = match;
    const value = tens
      ? (TENS.indexOf(tens.toLowerCase()) + 2) * 10 + (ones ? WORDS.indexOf(ones.toLowerCase()) : 0)
      : WORDS.indexOf((word ?? "").toLowerCase());
    found.add(keyOf(value));
  }
  return found;
}
