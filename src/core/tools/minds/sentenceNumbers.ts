/**
 * The numbers a sentence states, read so that a sentence the assistant adds can be told from one
 * that restates the old text (#1385): one that keeps the old words but changes a figure (950 →
 * 1,200, 五天 → 十五天, million → billion, 3 March → 3 May) says something new. Read wide on
 * purpose, unlike ../../../shared/figures, which leaves out dates, years and Chinese numerals:
 * here a number read where none was meant can only hold a sentence to its Citation, never let a
 * new figure pass.
 */

const CURRENCY = "[$€£¥₹]";
// A sign, a currency and a run of scales are part of a number: "-$3千万" is one number.
const DIGITS = new RegExp(
  `(-?)(${CURRENCY}?)(\\d+(?:[,，]\\d{3})*(?:\\.\\d+)?)([千万亿]*)(?:\\s?(thousand|million|billion|trillion|bn|mn|m|k)\\b)?`,
  "gi",
);
const SCALES: Readonly<Record<string, number>> = {
  千: 1e3,
  万: 1e4,
  亿: 1e8,
  thousand: 1e3,
  k: 1e3,
  million: 1e6,
  mn: 1e6,
  m: 1e6,
  billion: 1e9,
  bn: 1e9,
  trillion: 1e12,
};
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
// A lone 一 is a number only before what counts things: in 进一步, 一般 and 一方 it is a word.
const COUNTED = /^[个天年月日周次倍名项份元条位件家岁小分秒台本]/;
const WORDS =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const WORD_SCALES: Readonly<Record<string, number>> = {
  hundred: 100,
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
};
const WORD_NUMBER = new RegExp(
  `\\b(?:(${TENS.join("|")})(?:[-\\s](${WORDS.slice(1, 10).join("|")}))?|(${WORDS.join("|")}))\\b(?:\\s(hundred|thousand|million|billion)\\b)?`,
  "gi",
);
// "one" is a pronoun in these: no one, one of the parties.
const OF_AFTER = /^\s+of\b/i;
const NO_BEFORE = /\bno\s+$/i;
// Capitalised only: "may" is a verb far more often than a month.
const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );
const MONTH = new RegExp(
  `\\b(${MONTHS.join("|")}|${MONTHS.map((month) => month.slice(0, 3)).join("|")})\\b`,
  "g",
);
const WEEKDAY = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g;

/**
 * A Chinese numeral's value: "十五" 15, "两万五" 25000, "一亿三千万" 130000000, and digits alone
 * one by one ("二〇二五" 2025). A scale alone ("亿") is one of it.
 */
function hanValue(numeral: string): number {
  const characters = [...numeral];
  if (characters.length > 1 && characters.every((character) => character in HAN_DIGITS)) {
    return Number(characters.map((character) => HAN_DIGITS[character]).join(""));
  }
  let hundredMillions = 0;
  let tenThousands = 0;
  let section = 0;
  let digit = 0;
  let lastUnit = 0;
  for (const [at, character] of characters.entries()) {
    const value = HAN_DIGITS[character];
    const unit = HAN_UNITS[character];
    if (value !== undefined) {
      digit = value;
      // "两万五": a last digit straight after a unit is a tenth of that unit.
      const previous = characters[at - 1];
      if (at === characters.length - 1 && previous && !(previous in HAN_DIGITS) && lastUnit >= 10) {
        digit = value * (lastUnit / 10);
      }
    } else if (unit !== undefined) {
      section += (digit === 0 && section === 0 ? 1 : digit) * unit;
      digit = 0;
      lastUnit = unit;
    } else if (character === "万") {
      tenThousands = (section + digit || 1) * 1e4;
      section = 0;
      digit = 0;
      lastUnit = 1e4;
    } else if (character === "亿") {
      hundredMillions = (tenThousands + section + digit || 1) * 1e8;
      tenThousands = 0;
      section = 0;
      digit = 0;
      lastUnit = 1e8;
    }
  }
  return hundredMillions + tenThousands + section + digit;
}

/** A value as compared: "1,200", "1200" and "1200.0" alike. */
const keyOf = (value: number) => String(Math.round(value * 1e9) / 1e9);

/** The numbers `sentence` states, each as a value, whatever script or separators it is written in. */
export function sentenceNumbers(sentence: string): Set<string> {
  const text = sentence.normalize("NFKC");
  const found = new Set<string>();
  const blank = (match: string) => " ".repeat(match.length);
  let rest = text.replace(
    DIGITS,
    (match: string, sign: string, currency: string, number: string, han: string, word?: string) => {
      const scale = [...han, ...(word ? [word.toLowerCase()] : [])].reduce(
        (product, each) => product * (SCALES[each] ?? 1),
        1,
      );
      const value = `${sign}${keyOf(Number(number.replace(/[,，]/g, "")) * scale)}`;
      // Bare too, so a restatement may leave the currency out but never name another.
      found.add(value);
      if (currency) found.add(`${currency}${value}`);
      return blank(match);
    },
  );
  const afterDigits = rest;
  rest = afterDigits.replace(HAN_NUMERAL, (match: string, at: number) => {
    if (match === "一" && !COUNTED.test(afterDigits.slice(at + 1))) return match;
    found.add(keyOf(hanValue(match)));
    return blank(match);
  });
  const afterHan = rest;
  rest = afterHan.replace(
    WORD_NUMBER,
    (match: string, tens?: string, ones?: string, word?: string, scale?: string, at = 0) => {
      const lower = (word ?? "").toLowerCase();
      const pronoun =
        lower === "one" &&
        !scale &&
        (OF_AFTER.test(afterHan.slice(at + match.length)) || NO_BEFORE.test(afterHan.slice(0, at)));
      if (pronoun) return match;
      const value = tens
        ? (TENS.indexOf(tens.toLowerCase()) + 2) * 10 +
          (ones ? WORDS.indexOf(ones.toLowerCase()) : 0)
        : WORDS.indexOf(lower);
      found.add(keyOf(value * (scale ? (WORD_SCALES[scale.toLowerCase()] ?? 1) : 1)));
      return blank(match);
    },
  );
  for (const match of rest.matchAll(MONTH)) {
    const name = match[1] ?? "";
    found.add(`month ${MONTHS.findIndex((month) => month.startsWith(name.slice(0, 3))) + 1}`);
  }
  for (const match of rest.matchAll(WEEKDAY)) found.add(match[1] ?? "");
  return found;
}
