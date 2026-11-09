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
/** A text's pieces in order: one Chinese, Japanese or Korean character, or one other word. */
const PIECE = new RegExp(`[${CJK_CLASS}]|(?:(?![${CJK_CLASS}])[\\p{L}'’])+`, "gu");
const CJK = new RegExp(`[${CJK_CLASS}]`, "u");
const CLAUSE_MARK = /[,，;；.。!！?？:：、]/u;
const CJK_NEGATION = /[不没未无非]/u;
/** Words that start with a negating character and negate nothing. */
const NOT_NEGATING = new Set(["非常", "无论", "不仅", "不但", "不过", "不断", "未来"]);
/** How many words, or two-character pairs, after a negation it reaches: "no longer available", 没有包含. */
const NEGATION_REACH = 2;
const LATIN_NEGATION =
  /^(?:not|no|never|without|cannot|none|nor|neither|nothing|nobody|nowhere)$|n['’]t$/iu;
/** Chinese characters that say little alone, as "our" or "the" do: a pair with one says nothing. */
const CJK_FUNCTION = new Set([..."我你您他她它们的了吗呢吧啊这那个"]);
/**
 * Words whose opposite one word turns: a clause and a quote that each say only one side of a
 * pair say opposite things, however many other words they share.
 */
const OPPOSITES: readonly (readonly [RegExp, RegExp])[] = [
  [/\bbefore\b/iu, /\bafter\b/iu],
  [/\bearlier\b/iu, /\blater\b/iu],
  [/\bmore\b/iu, /\b(?:less|fewer)\b/iu],
  [/\bmin(?:imum)?\b/iu, /\bmax(?:imum)?\b/iu],
  [/\bleast\b/iu, /\bmost\b/iu],
  [/\b(?:above|over)\b/iu, /\b(?:below|under)\b/iu],
  [/\bfirst\b/iu, /\blast\b/iu],
  [/\binclud/iu, /\bexclud/iu],
  [/\bfree\b/iu, /\b(?:paid|charged)\b/iu],
  [/\b(?:raise|increase)/iu, /\b(?:lower|cut|decrease|reduce)/iu],
  [/前/u, /后/u],
  [/以上/u, /以下/u],
  [/最高|最多|至多/u, /最低|最少|至少/u],
  [/免费/u, /收费/u],
  [/上调|增加|提高|上涨/u, /下调|减少|降低|下降/u],
  [/早/u, /晚/u],
];
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
const NOT_COUNTING =
  /^(?:一[样起律直定般致切些下旦同边面共向再并]|万一|十分(?!钟)|万(?![零〇一二两三四五六七八九十百千\d]))/u;
/** Words that count but name no unit, so the character after them is the unit too: 5 个工作日, 三个月. */
const CLASSIFIER_CHARACTERS = "个位名家次台张件辆条套份项";
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
  `([$€£¥])?\\s?(\\d+(?:[.,]\\d+)*(?::\\d{2})?|[零〇一二两三四五六七八九十百千万]+(?:点[零〇一二三四五六七八九]+)?(?=\\p{Script=Han})|\\b(?:${ENGLISH_NUMBER})(?:[- ](?:${ENGLISH_NUMBER}))*\\b)\\s?(%|[${CLASSIFIER_CHARACTERS}]\\p{Script=Han}|\\p{Script=Han}|[a-z]+)?`,
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

/** A Chinese numeral's value: 三十 is 30, 两万 20000, 一点五 1.5, and digits alone are read in a row, 九五 as 95. */
function chineseValue(run: string): number {
  const [whole = "", fraction] = run.split("点");
  if (fraction !== undefined) {
    return Number(
      `${chineseValue(whole)}.${[...fraction].map((each) => CHINESE_DIGITS[each] ?? 0).join("")}`,
    );
  }
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
  return figuresIn(withPercents(text)).map(({ figure }) => figure);
}

/** Each figure of a text and where it is; a numeral that counts nothing (一样, 十分) is left as words. */
function figuresIn(text: string): { figure: Figure; from: number; to: number }[] {
  return [...text.matchAll(FIGURE)].flatMap((found) => {
    const [whole, currency = "", number = "", given = ""] = found;
    if (NOT_COUNTING.test(text.slice(found.index).trimStart())) return [];
    const unit = given;
    if (CJK_FUNCTION.has(unit)) return [];
    const value = /\d/u.test(number)
      ? digitValue(number)
      : /[a-z]/iu.test(number)
        ? String(englishValue(number))
        : String(chineseValue(number));
    const latin = /^[a-z]+$/iu.test(unit);
    const from = found.index;
    const to = from + whole.length;
    return [
      {
        figure: {
          currency,
          value,
          unit: latin ? (STOP_WORDS.has(unit.toLowerCase()) ? "" : folded(unit)) : unit,
        },
        from,
        to,
      },
    ];
  });
}

/** Whether a quote's figure is the claim's: the same currency and value, and its unit where the claim names one. */
const sameFigure = (claim: Figure, quote: Figure) =>
  claim.currency === quote.currency &&
  claim.value === quote.value &&
  (claim.unit === "" || claim.unit === quote.unit);

/** A figure's key, so a negated figure can be told from a stated one. */
const keyOf = ({ currency, value, unit }: Figure) => `#${currency}${value}${unit}`;

/**
 * A text's words, and those within a negation's reach, as `holds` compares them; its figures are
 * among them by key, so "not $200" negates the figure, but they count toward no share.
 */
function read(given: string): { words: Set<string>; negated: Set<string> } {
  const text = withPercents(given);
  const words = new Set<string>();
  const negated = new Set<string>();
  const figures = figuresIn(text);
  // The pieces in order: words, two-character pairs, negations and figures.
  const pieces: { at: number; kind: "word" | "negation" | "figure"; key: string }[] = [];
  for (const { figure, from } of figures)
    pieces.push({ at: from, kind: "figure", key: keyOf(figure) });
  const outside = (at: number) => !figures.some(({ from, to }) => at >= from && at < to);
  const found = [...text.matchAll(PIECE)].filter((each) => outside(each.index));
  found.forEach((each, index) => {
    const [piece] = each;
    if (!CJK.test(piece)) {
      if (LATIN_NEGATION.test(piece)) pieces.push({ at: each.index, kind: "negation", key: "" });
      else if (!STOP_WORDS.has(piece.toLowerCase()))
        pieces.push({ at: each.index, kind: "word", key: folded(piece) });
      return;
    }
    const next = found[index + 1];
    const adjacent =
      next !== undefined && next.index === each.index + piece.length && CJK.test(next[0]);
    const second = adjacent ? (next?.[0] ?? "") : "";
    if (CJK_NEGATION.test(piece) && !NOT_NEGATING.has(`${piece}${second}`)) {
      pieces.push({ at: each.index, kind: "negation", key: "" });
      return;
    }
    if (!adjacent || CJK_NEGATION.test(second)) return;
    if (CJK_FUNCTION.has(piece) || CJK_FUNCTION.has(second)) return;
    pieces.push({ at: each.index, kind: "word", key: `${piece}${second}` });
  });
  let reach = 0;
  for (const piece of pieces.sort((a, b) => a.at - b.at)) {
    if (piece.kind === "negation") {
      reach = NEGATION_REACH;
      continue;
    }
    (reach > 0 ? negated : words).add(piece.key);
    reach = Math.max(0, reach - 1);
  }
  return { words, negated };
}

/**
 * The share of a text's own words, figures aside, that a quote holds; 1 for a text with none. A
 * Chinese, Japanese or Korean pair counts as held when both its characters are in the quote, as an
 * English word does wherever it stands: 每个月 for 每月 loses nothing.
 */
function shareHeld(theirs: ReturnType<typeof read>, quote: string, text: string): number {
  const ours = read(text);
  const own = [...ours.words, ...ours.negated].filter((word) => !word.startsWith("#"));
  if (own.length === 0) return 1;
  const held = (word: string) =>
    theirs.words.has(word) ||
    theirs.negated.has(word) ||
    (CJK.test(word) && [...word].every((character) => quote.includes(character)));
  return own.filter(held).length / own.length;
}

/** Whether two texts each say only one side of a pair of opposites. */
const oppose = (a: string, b: string) =>
  OPPOSITES.some(
    ([one, other]) =>
      (one.test(a) && !other.test(a) && other.test(b) && !one.test(b)) ||
      (other.test(a) && !one.test(a) && one.test(b) && !other.test(b)),
  );

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
  if (oppose(quote, whole)) return false;
  const theirs = read(quote);
  const ours = read(whole);
  for (const word of theirs.negated) if (ours.words.has(word)) return false;
  for (const word of ours.negated) if (theirs.words.has(word)) return false;
  if (![...ours.words, ...ours.negated].some((word) => !word.startsWith("#"))) return false;
  return said.every((clause) => shareHeld(theirs, quote, clause) >= MIN_SHARE);
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
