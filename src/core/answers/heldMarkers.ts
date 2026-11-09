/**
 * Placing the markers a model left out, only where its quote holds the words (#2847). Call help
 * shows a found Citation as checked and judges nothing more, so a record placed after words its
 * quote doesn't state is a ✓ nobody gave. A record goes after a clause, or a run of clauses, of a
 * line the reply may cite (`spans`), when its quote holds them:
 *
 * - every figure of the words is in the quote, by kind and unit, in digits or in words: "30 分钟"
 *   is no "30 天", "$3" no "3 docks", "两小时" is "2 小时", "sixty days" is "60 days", 百分之二十
 *   is "20%";
 * - the quote doesn't say the opposite: no word within a negation's reach in one is said in the
 *   other without it ("no longer available" against "available", 没有包含 against 包含);
 * - the quote holds `MIN_SHARE` of each clause's own words (English words with their endings
 *   folded, common words aside; Chinese, Japanese or Korean by each two neighbouring characters,
 *   pairs with a character such as 的 or 们 aside), so a clause it doesn't hold never rides on one
 *   it does, and the words are worth `MIN_WORDS` at least (./markerPlacement, `wordsWorth`).
 *
 * The longest run that holds is taken, and its marker goes right after it, after any marker there
 * and before its closing mark. A record that fits no such words shows nowhere.
 */
import { MARKER } from "../../shared/answerSentences";
import { type MarkerRecord, type PlacedMarker, STOP_WORDS, wordsWorth } from "./markerPlacement";

/** A span of the reply, by offset. */
export interface Span {
  from: number;
  to: number;
}

/** The least share of each clause's words its quote must hold. */
const MIN_SHARE = 0.7;
/** The least a clause must be worth, in words, to take a marker. */
const MIN_WORDS = 2;

const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const CJK_RUN = new RegExp(`[${CJK_CLASS}]+`, "gu");
const LATIN_WORD = new RegExp(`(?:(?![${CJK_CLASS}])[\\p{L}'’])+`, "gu");
const CLAUSE_MARK = /[,，;；.。!！?？:：、]/u;
const CJK_NEGATION = /[不没未无非]/u;
/** Words that start with a negating character and negate nothing. */
const NOT_NEGATING = new Set(["非常", "无论", "不仅", "不但", "不过", "不断", "未来"]);
/** How many words, or two-character pairs, after a negation it reaches: "no longer available", 没有包含. */
const NEGATION_REACH = 2;
const LATIN_NEGATION = /^(?:not|no|never|without|cannot|none|nor)$|n['’]t$/iu;
/** Chinese characters that say little alone, as the common English words do: a pair with one says nothing. */
const CJK_FUNCTION = new Set([..."我你您他她它们的了是在和与跟也都就这那吗呢吧啊之其"]);
/** A moment's time at a line's start ("5:05 “…”"), which no quote of the call holds. */
const LEADING_TIME = /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*/u;

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
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
const CHINESE_UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };
/**
 * Words a Chinese numeral starts that count nothing, or no more than "a" does in English: every
 * other numeral before a Chinese character is a figure.
 */
const NOT_COUNTING = /^(?:一[样起律直定般致切些下旦同边面点共向再并个次位家]|万一|十分)/u;
const ENGLISH_NUMBERS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
};
const ENGLISH_NUMBER = Object.keys(ENGLISH_NUMBERS).join("|");
const FIGURE = new RegExp(
  `([$€£¥])?\\s?(\\d+(?:[.,]\\d+)*(?::\\d{2})?|[零〇一二两三四五六七八九十百千万]+(?=\\p{Script=Han})|\\b(?:${ENGLISH_NUMBER})(?:[- ](?:${ENGLISH_NUMBER}))*\\b)\\s?(%|\\p{Script=Han}|[a-z]+)?`,
  "giu",
);
/** A percentage written out in Chinese, 百分之二十, read as "二十%". */
const CHINESE_PERCENT = /百分之([零〇一二两三四五六七八九十百千\d.]+)/gu;

/** A figure: its currency, its value and the unit it counts, empty when none is given. */
interface Figure {
  currency: string;
  value: string;
  unit: string;
}

/** A Chinese numeral's value: 三十 is 30, 两万 20000, and digits alone are read in a row, 九五 as 95. */
function chineseValue(run: string): number {
  if (![...run].some((character) => character in CHINESE_UNITS || character === "万")) {
    return Number([...run].map((character) => CHINESE_DIGITS[character] ?? 0).join(""));
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const character of run) {
    const unit = CHINESE_UNITS[character];
    if (character === "万") {
      total += (section + digit) * 10_000;
      section = 0;
      digit = 0;
    } else if (unit !== undefined) {
      section += (digit || 1) * unit;
      digit = 0;
    } else digit = CHINESE_DIGITS[character] ?? 0;
  }
  return total + section + digit;
}

/** An English number in words: "sixty", "twenty-five", "two hundred". */
function englishValue(words: string): number {
  let total = 0;
  for (const word of words.toLowerCase().split(/[- ]/u)) {
    const value = ENGLISH_NUMBERS[word] ?? 0;
    total = value >= 100 ? (total || 1) * value : total + value;
  }
  return total;
}

/** A number as written in digits: "50,000" is 50000, "1,50" is 1.5, "1.20" is 1.2. */
function digitValue(number: string): string {
  if (number.includes(":")) return number;
  const grouped = number.replace(/,(?=\d{3}(?!\d))/gu, "");
  const value = Number(grouped.replace(",", "."));
  return Number.isNaN(value) ? number : String(value);
}

/** An English word without the ending its forms differ by: "covers", "covered" and "cover" are one. */
const folded = (word: string) =>
  word
    .toLowerCase()
    .replace(/['’]s$/u, "")
    .replace(/(?<=\p{L}{3})(?:ing|ed|es|s)$/u, "");

/** A text with its Chinese percentages in digits: 百分之二十 as 20%. */
const withPercents = (text: string) =>
  text.replace(
    CHINESE_PERCENT,
    (_, number: string) => `${/\d/u.test(number) ? number : chineseValue(number)}%`,
  );

/** The figures of a text, each with its currency and unit: "$50,000", "30 分钟", "5 minutes". */
export function figuresOf(text: string): Figure[] {
  return [...withPercents(text).matchAll(FIGURE)].flatMap((found) => {
    const [whole, currency = "", number = "", unit = ""] = found;
    if (NOT_COUNTING.test(whole.trim()) || CJK_FUNCTION.has(unit)) return [];
    const value = /\d/u.test(number)
      ? digitValue(number)
      : /[a-z]/iu.test(number)
        ? String(englishValue(number))
        : String(chineseValue(number));
    const latin = /^[a-z]+$/iu.test(unit);
    return [
      {
        currency,
        value,
        unit: latin ? (STOP_WORDS.has(unit.toLowerCase()) ? "" : folded(unit)) : unit,
      },
    ];
  });
}

/** Whether a quote's figure is the claim's: the same currency and value, and its unit where the claim names one. */
const sameFigure = (claim: Figure, quote: Figure) =>
  claim.currency === quote.currency &&
  claim.value === quote.value &&
  (claim.unit === "" || claim.unit === quote.unit);

/** A text's words, and those it negates, as `holds` compares them. */
function read(text: string): { words: Set<string>; negated: Set<string> } {
  const words = new Set<string>();
  const negated = new Set<string>();
  let reach = 0;
  for (const [word] of text.matchAll(LATIN_WORD)) {
    if (LATIN_NEGATION.test(word)) {
      reach = NEGATION_REACH;
      continue;
    }
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    const each = folded(lower);
    if (reach > 0) negated.add(each);
    else words.add(each);
    reach = Math.max(0, reach - 1);
  }
  for (const [run] of text.matchAll(CJK_RUN)) {
    const characters = [...run];
    const negations = characters.flatMap((character, at) =>
      CJK_NEGATION.test(character) && !NOT_NEGATING.has(`${character}${characters[at + 1] ?? ""}`)
        ? [at]
        : [],
    );
    for (let at = 0; at + 1 < characters.length; at++) {
      const first = characters[at] ?? "";
      const second = characters[at + 1] ?? "";
      const pair = `${first}${second}`;
      if (negations.includes(at) || negations.includes(at + 1)) continue;
      if (CJK_FUNCTION.has(first) || CJK_FUNCTION.has(second)) continue;
      const negatedBy = negations.some((each) => at > each && at - each <= NEGATION_REACH);
      if (negatedBy) negated.add(pair);
      else words.add(pair);
    }
  }
  return { words, negated };
}

/** The share of a text's own words that a quote's words hold; 1 for a text with none. */
function shareHeld(theirs: ReturnType<typeof read>, text: string): number {
  const ours = read(text.replace(FIGURE, " "));
  const own = [...ours.words, ...ours.negated];
  if (own.length === 0) return 1;
  return (
    own.filter((word) => theirs.words.has(word) || theirs.negated.has(word)).length / own.length
  );
}

/**
 * Whether `quote` holds the clauses `clauses`, read as one run: every figure by kind and unit,
 * never the opposite, and `MIN_SHARE` of each clause's own words, so a clause it doesn't hold
 * never rides on one it does.
 */
export function holds(given: string, ...clauses: readonly string[]): boolean {
  const quote = withPercents(given);
  const said = clauses.map((clause) => withPercents(clause.replace(LEADING_TIME, "")));
  const whole = said.join(" ");
  if (wordsWorth(whole) < MIN_WORDS) return false;
  const figures = figuresOf(quote);
  if (!figuresOf(whole).every((claim) => figures.some((each) => sameFigure(claim, each))))
    return false;
  // Figures are weighed above; their characters, 三十 or 天, would count again as pairs.
  const theirs = read(quote.replace(FIGURE, " "));
  const ours = read(whole.replace(FIGURE, " "));
  for (const word of theirs.negated) if (ours.words.has(word)) return false;
  for (const word of ours.negated) if (theirs.words.has(word)) return false;
  if (ours.words.size + ours.negated.size === 0) return false;
  return said.every((clause) => shareHeld(theirs, clause) >= MIN_SHARE);
}

/** The clauses of a span: each one's text and where its words end, before its closing mark. */
function clausesOf(text: string, span: Span): { from: number; end: number }[] {
  const clauses: { from: number; end: number }[] = [];
  let from = span.from;
  for (let at = span.from; at <= span.to; at++) {
    const character = text[at] ?? "";
    const ends =
      at === span.to ||
      character === "\n" ||
      (CLAUSE_MARK.test(character) &&
        !(/\d/u.test(text[at - 1] ?? "") && /\d/u.test(text[at + 1] ?? "")));
    if (!ends) continue;
    let end = at;
    while (end > from && /\s/u.test(text[end - 1] ?? "")) end--;
    if (end > from) clauses.push({ from, end });
    from = at + 1;
  }
  return clauses;
}

/** Where a marker goes after words ending at `end`: past the markers already there. */
function afterMarkers(text: string, end: number): number {
  const marker = /^\s*\[\^\d{1,4}\]/u;
  let at = end;
  for (let found = marker.exec(text.slice(at)); found; found = marker.exec(text.slice(at))) {
    at += found[0].length;
  }
  return at;
}

/**
 * The reply with each record's marker placed after the words its quote holds, for records whose
 * marker the reply doesn't have and `accepted` takes; a record that fits nowhere is left out.
 */
export function withHeldMarkers(
  answer: string,
  records: readonly MarkerRecord[],
  accepted: (marker: number) => boolean,
  spans: readonly Span[],
): { text: string; placed: PlacedMarker[] } {
  const present = new Set([...answer.matchAll(MARKER)].map((found) => Number(found[1])));
  const missing = [...new Map(records.map((record) => [record.marker, record])).values()]
    .filter((record) => !present.has(record.marker) && accepted(record.marker))
    .sort((a, b) => a.marker - b.marker);
  if (missing.length === 0) return { text: answer, placed: [] };
  const plain = answer.replace(MARKER, (found) => " ".repeat(found.length));
  const runs = spans.flatMap((span) => {
    const clauses = clausesOf(plain, span);
    return clauses.flatMap((first, start) =>
      clauses.slice(start).map((last, length) => ({
        clauses: clauses
          .slice(start, start + length + 1)
          .map((clause) => plain.slice(clause.from, clause.end)),
        words: plain.slice(first.from, last.end),
        end: last.end,
      })),
    );
  });
  const insertions: { at: number; marker: number }[] = [];
  const placed: PlacedMarker[] = [];
  for (const record of missing) {
    const best = runs
      .filter((run) => holds(record.quote, ...run.clauses))
      .sort((a, b) => wordsWorth(b.words) - wordsWorth(a.words))[0];
    if (!best) continue;
    insertions.push({ at: afterMarkers(answer, best.end), marker: record.marker });
    placed.push({ marker: record.marker, at: "sentence" });
  }
  let text = answer;
  for (const { at, marker } of [...insertions].sort((a, b) => b.at - a.at || b.marker - a.marker)) {
    text = `${text.slice(0, at)}[^${marker}]${text.slice(at)}`;
  }
  return { text, placed };
}
