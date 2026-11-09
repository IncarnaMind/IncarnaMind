/**
 * Placing the markers a model left out, only where its quote holds the words (#2847). Call help
 * shows a found Citation as checked and judges nothing more, so a record placed after words its
 * quote doesn't state is a ✓ nobody gave. A record goes after a clause, or a run of clauses, of a
 * line the reply may cite (`spans`), when its quote holds them:
 *
 * - every figure of the words is in the quote, by kind and unit: "30 分钟" is no "30 天", "$3" no
 *   "3 docks", "两小时" is "2 小时";
 * - the quote doesn't say the opposite: no word it negates is said there without a negation, and
 *   no word negated there is said in the quote without one ("not covered" against "covers",
 *   不承保 against 承保);
 * - the quote holds `MIN_SHARE` of the words' own words (English words with their endings folded,
 *   common words aside; Chinese, Japanese or Korean by each two neighbouring characters), and
 *   the words are worth `MIN_WORDS` at least (./markerPlacement, `wordsWorth`).
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

/** The least share of a clause's words its quote must hold. */
const MIN_SHARE = 0.6;
/** The least a clause must be worth, in words, to take a marker. */
const MIN_WORDS = 2;

const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const CJK_RUN = new RegExp(`[${CJK_CLASS}]+`, "gu");
const LATIN_WORD = new RegExp(`(?:(?![${CJK_CLASS}])[\\p{L}'’])+`, "gu");
const CLAUSE_MARK = /[,，;；.。!！?？:：、]/u;
const CJK_NEGATION = /[不没未无非]/u;
const LATIN_NEGATION = /^(?:not|no|never|without|cannot)$|n['’]t$/iu;
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
/** What a Chinese numeral counts, so "三十天" is a figure but "一律" or "一样" isn't. */
const MEASURES = "个天年月日分小周次台张名元万倍折号点位家辆单件岁";
const FIGURE = new RegExp(
  `([$€£¥])?\\s?(\\d+(?:[.,]\\d+)*(?::\\d{2})?|[零〇一二两三四五六七八九十百千]+(?=[${MEASURES}]))\\s?(%|\\p{Script=Han}|[a-z]+)?`,
  "giu",
);

/** A figure: its currency, its value and the unit it counts, empty when none is given. */
interface Figure {
  currency: string;
  value: string;
  unit: string;
}

function chineseValue(run: string): number {
  let total = 0;
  let digit = 0;
  for (const character of run) {
    const unit = CHINESE_UNITS[character];
    if (unit !== undefined) {
      total += (digit || 1) * unit;
      digit = 0;
    } else digit = CHINESE_DIGITS[character] ?? 0;
  }
  return total + digit;
}

/** An English word without the ending its forms differ by: "covers", "covered" and "cover" are one. */
const folded = (word: string) =>
  word
    .toLowerCase()
    .replace(/['’]s$/u, "")
    .replace(/(?<=\p{L}{3})(?:ing|ed|es|s)$/u, "");

/** The figures of a text, each with its currency and unit: "$50,000", "30 分钟", "5 minutes". */
export function figuresOf(text: string): Figure[] {
  return [...text.matchAll(FIGURE)].map((found) => {
    const [, currency = "", number = "", unit = ""] = found;
    const value = /\d/u.test(number)
      ? number.includes(":")
        ? number
        : String(Number(number.replace(/,(?=\d{3}(?!\d))/gu, "")))
      : String(chineseValue(number));
    const latin = /^[a-z]+$/iu.test(unit);
    return {
      currency,
      value,
      unit: latin ? (STOP_WORDS.has(unit.toLowerCase()) ? "" : folded(unit)) : unit,
    };
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
  let negating = false;
  for (const [word] of text.matchAll(LATIN_WORD)) {
    if (LATIN_NEGATION.test(word)) {
      negating = true;
      continue;
    }
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    const each = folded(lower);
    if (negating) negated.add(each);
    else words.add(each);
    negating = false;
  }
  for (const [run] of text.matchAll(CJK_RUN)) {
    const characters = [...run];
    for (let at = 0; at + 1 < characters.length; at++) {
      const pair = `${characters[at]}${characters[at + 1]}`;
      if (CJK_NEGATION.test(pair)) continue;
      if (at > 0 && CJK_NEGATION.test(characters[at - 1] as string)) negated.add(pair);
      else words.add(pair);
    }
  }
  return { words, negated };
}

/** Whether `quote` holds `words`: their figures by kind and unit, never the opposite, most of their words. */
export function holds(quote: string, words: string): boolean {
  const said = words.replace(LEADING_TIME, "");
  if (wordsWorth(said) < MIN_WORDS) return false;
  const figures = figuresOf(quote);
  if (!figuresOf(said).every((claim) => figures.some((each) => sameFigure(claim, each))))
    return false;
  // Figures are weighed above; their characters, 三十 or 天, would count again as pairs.
  const theirs = read(quote.replace(FIGURE, " "));
  const ours = read(said.replace(FIGURE, " "));
  for (const word of theirs.negated) if (ours.words.has(word)) return false;
  for (const word of ours.negated) if (theirs.words.has(word)) return false;
  const own = [...ours.words, ...ours.negated];
  if (own.length === 0) return false;
  const held = own.filter((word) => theirs.words.has(word) || theirs.negated.has(word)).length;
  return held / own.length >= MIN_SHARE;
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
    while (end > from && /\s/u.test(text[end - 1] as string)) end--;
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
      clauses.slice(start).map((last) => ({
        words: plain.slice(first.from, last.end),
        end: last.end,
      })),
    );
  });
  const insertions: { at: number; marker: number }[] = [];
  const placed: PlacedMarker[] = [];
  for (const record of missing) {
    const best = runs
      .filter((run) => holds(record.quote, run.words))
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
