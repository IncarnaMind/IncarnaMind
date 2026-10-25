/**
 * Scoring transcription (#85, used by #136 and the meeting set in eval/meetings): word error
 * rate for English, character error rate for Chinese, and an error rate for the two mixed, after
 * the same normalisation on the reference and on what the engine said. The rules, fixed and
 * tested (tests/eval/transcriptionScoring.test.ts):
 * - case is folded, and full-width letters and digits become ASCII (NFKC);
 * - tags such as [laughter], [unk] and <unk> are dropped;
 * - traditional Chinese characters become the simplified ones (src/shared/hanVariants.ts);
 * - the hesitations "uh", "um", "er", "erm", "hm", "hmm", "mm", "mmm", "mhm", "呃" and "嗯" are
 *   dropped: engines leave them out and references keep them;
 * - apostrophes inside a word are dropped ("you're" is "youre"), and the commas inside a number
 *   ("1,000"); every other punctuation mark and symbol becomes a space;
 * - numbers are digits: "twenty five", "二十五" and "25" are all "25" ("two thousand and ten",
 *   "二零一零" and "2010" are "2010"). English number words are read in runs, Chinese numerals in
 *   runs of numeral characters (those next to an ASCII digit, and 百 千 万 亿 alone, are left);
 * - English is compared word by word; Chinese character by character, each run of Latin letters
 *   or digits as one unit, so a number is one unit; whitespace is dropped.
 */
import { SIMPLIFIED } from "../../src/shared/hanVariants";

const TAGS = /\[[^\]]*\]|<[^>]*>/g;
const ENGLISH_HESITATIONS = new Set(["uh", "um", "er", "erm", "hm", "hmm", "mm", "mmm", "mhm"]);
const HAN_HESITATIONS = /[呃嗯]/gu;

const ONES = new Map(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
    .split(" ")
    .map((word, value) => [word, value]),
);
const TENS = new Map(
  "twenty thirty forty fifty sixty seventy eighty ninety"
    .split(" ")
    .map((word, index) => [word, (index + 2) * 10]),
);
const SCALES = new Map([
  ["thousand", 1_000],
  ["million", 1_000_000],
  ["billion", 1_000_000_000],
]);

/** Runs of English number words as digits; any other word as it is. */
function englishNumbers(tokens: readonly string[]): string[] {
  const isNumber = (word: string | undefined) =>
    word !== undefined &&
    (ONES.has(word) || TENS.has(word) || word === "hundred" || SCALES.has(word));
  const out: string[] = [];
  let at = 0;
  while (at < tokens.length) {
    if (!isNumber(tokens[at])) {
      out.push(tokens[at] as string);
      at++;
      continue;
    }
    let total = 0;
    let group = 0;
    let last: "none" | "ones" | "teens" | "tens" | "hundred" | "scale" = "none";
    let used = 0;
    for (; at + used < tokens.length; used++) {
      const word = tokens[at + used] as string;
      const ones = ONES.get(word);
      const tens = TENS.get(word);
      const scale = SCALES.get(word);
      const fresh = last === "none" || last === "hundred" || last === "scale";
      if (ones !== undefined && ones < 10) {
        const afterTens = last === "tens" && group % 10 === 0;
        if (!(fresh || afterTens) || (ones === 0 && last !== "none")) break;
        group += ones;
        last = "ones";
      } else if (ones !== undefined || tens !== undefined) {
        if (!fresh) break;
        group += ones ?? (tens as number);
        last = ones !== undefined ? "teens" : "tens";
      } else if (word === "hundred") {
        if (!(last === "none" || last === "ones" || last === "teens")) break;
        group = (group === 0 ? 1 : group) * 100;
        last = "hundred";
      } else if (scale !== undefined) {
        if (last === "scale") break;
        total += (group === 0 ? 1 : group) * scale;
        group = 0;
        last = "scale";
      } else if (word === "and") {
        const next = tokens[at + used + 1];
        if (
          !(last === "hundred" || last === "scale") ||
          !isNumber(next) ||
          ONES.get(next as string) === 0
        ) {
          break;
        }
      } else {
        break;
      }
    }
    out.push(String(total + group));
    at += used;
  }
  return out;
}

const HAN_DIGITS = new Map(
  Array.from("零一二三四五六七八九", (char, value) => [char, value] as const).concat([
    ["〇", 0],
    ["两", 2],
  ]),
);
const HAN_UNITS = new Map([
  ["十", 10],
  ["百", 100],
  ["千", 1_000],
]);
const HAN_BIG_UNITS = new Map([
  ["万", 10_000],
  ["亿", 100_000_000],
]);
const HAN_NUMERAL = /[零〇一二三四五六七八九两十百千万亿]+/gu;

function hanNumber(run: string): string {
  const chars = Array.from(run);
  if (chars.every((char) => HAN_DIGITS.has(char))) {
    return chars.map((char) => HAN_DIGITS.get(char)).join("");
  }
  let total = 0;
  let section = 0;
  let pending = 0;
  for (const char of chars) {
    const digit = HAN_DIGITS.get(char);
    const unit = HAN_UNITS.get(char);
    const big = HAN_BIG_UNITS.get(char);
    if (digit !== undefined) pending = digit;
    else if (unit !== undefined) {
      section += (pending === 0 ? 1 : pending) * unit;
      pending = 0;
    } else if (big !== undefined) {
      total += (section + pending === 0 ? 1 : section + pending) * big;
      section = 0;
      pending = 0;
    }
  }
  return String(total + section + pending);
}

function hanNumbers(text: string): string {
  return text.replace(HAN_NUMERAL, (run, offset: number, whole: string) => {
    const before = whole[offset - 1];
    if (before !== undefined && before >= "0" && before <= "9") return run;
    if (/^[百千万亿]+$/u.test(run)) return run;
    return hanNumber(run);
  });
}

/** Text with case folded, punctuation and symbols gone, and numbers as digits, words separated by single spaces. */
export function normalise(text: string): string {
  const cleaned = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(TAGS, " ")
    .replace(/\p{Script=Han}/gu, (char) => SIMPLIFIED.get(char) ?? char)
    .replace(HAN_HESITATIONS, "")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/(\p{L})['’](\p{L})/gu, "$1$2")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned
    .split(" ")
    .filter((word) => word !== "" && !ENGLISH_HESITATIONS.has(word))
    .map(hanNumbers);
  return englishNumbers(tokens).join(" ");
}

/** English: the words. */
export const words = (text: string): string[] => normalise(text).split(" ").filter(Boolean);

/** Chinese: each Han character, and each run of Latin letters or digits, as a unit. */
export const characters = (text: string): string[] =>
  normalise(text).match(/\p{Script=Han}|[^\p{Script=Han}\s]+/gu) ?? [];

/** Edits (substitutions, deletions, insertions) to turn `hypothesis` into `reference`. */
export function editDistance(reference: readonly string[], hypothesis: readonly string[]): number {
  const ids = new Map<string, number>();
  const intern = (unit: string): number => {
    let id = ids.get(unit);
    if (id === undefined) {
      id = ids.size;
      ids.set(unit, id);
    }
    return id;
  };
  const ref = Int32Array.from(reference, intern);
  const hyp = Int32Array.from(hypothesis, intern);
  let previous = Int32Array.from({ length: hyp.length + 1 }, (_, index) => index);
  let current = new Int32Array(hyp.length + 1);
  for (let i = 1; i <= ref.length; i++) {
    current[0] = i;
    const unit = ref[i - 1];
    for (let j = 1; j <= hyp.length; j++) {
      const substitution = (previous[j - 1] as number) + (unit === hyp[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    [previous, current] = [current, previous];
  }
  return previous[hyp.length] as number;
}

export interface ErrorRate {
  errors: number;
  /** Units in the reference. */
  total: number;
  rate: number;
}

export function errorRate(reference: readonly string[], hypothesis: readonly string[]): ErrorRate {
  const errors = editDistance(reference, hypothesis);
  return {
    errors,
    total: reference.length,
    rate: reference.length === 0 ? 0 : errors / reference.length,
  };
}
