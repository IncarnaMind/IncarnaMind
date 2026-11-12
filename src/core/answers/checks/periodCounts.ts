/**
 * How many days, weeks, months, quarters or years a sentence states, as the Figures the gate holds
 * to the cited Passages (#2943, #2953). A number is read by the figure reader, as every number is,
 * so its separators are decided in one place; what the reader doesn't read (a fraction, a number
 * in words, a number in words and in figures) is read here. A count that can't be read has the
 * value NaN, which no Passage states, so its sentence is left not judged, never passed.
 */
import { type Figure, type FigureContext, readFigures } from "../../../shared/figures";
import {
  figuresOf,
  INTEGER_WORDS,
  NUMBER_WORD,
  SCALES,
  wholeNumberWords,
} from "../../../shared/numberWords";

/**
 * Whether a text before a single period makes it say which one, not how many: "这一年", "那一年",
 * "每一年", "同一年", "另一年", "哪一年" and "当一年" are this, that, every, the same, another,
 * which and a year. A 当 that ends a word ("应当") is no prefix; 前 and 后 stay out because
 * "前后一年" counts a year or so (#2215).
 */
export const PERIOD_DEMONSTRATIVE = /(?:[这那每同另哪]|(?<!\p{Script=Han})当)\s*$/u;

const EN_PERIOD =
  "(?:[ -]+(?:consecutive|successive))?[ -]+(years?|months?|weeks?|days?|quarters?)\\b";

const COUNT_REACH = 40;
const WORD_REACH = 90;

const HALF = "[ -]and[ -]a[ -]half";
const HALF_AT_END = new RegExp(`${HALF}$`, "i");
const ROUND_NUMBER = `an?[ -](?:hundred|${[...SCALES.keys()].join("|")})(?:[ -](?:${NUMBER_WORD})|(?<=hundred|thousand|million|billion|trillion) and (?:${NUMBER_WORD}))*|an?[ -]dozen`;
const SPELLED = `(?:${ROUND_NUMBER}|${INTEGER_WORDS})(?:${HALF})?`;
const SPELLED_AT_END = new RegExp(`\\b(${SPELLED})$`, "i");
const SPELLED_ALL = new RegExp(`^(?:${SPELLED})$`, "i");
const NEAR_OF_RANGE = new RegExp(`\\b(${SPELLED})\\s*(?:[–—-]|\\bto\\b)\\s*$`, "i");
const NEAR_AFTER_BETWEEN = new RegExp(`\\bbetween\\s+(${SPELLED})\\s+and\\s+$`, "i");

/** What stands before a period word: where it starts, and the value of each number it holds. */
interface Quantity {
  start: number;
  /** A range holds its far end, then its near end. */
  values: number[];
  /** Digits after the decimal mark, when the reader counted them. */
  decimals?: number;
}

interface FigureAt {
  figure: Figure;
  start: number;
  previous?: { figure: Figure; start: number; end: number };
}

const asCount = (value: number | null): number =>
  value !== null && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : Number.NaN;

const decimalsOf = (value: number): number => (String(value).split(".")[1] ?? "").length;

const startsInsideWord = (text: string, start: number): boolean =>
  /\w/.test(text.charAt(start - 1));

/** The figure that ends at `at`, read as any number is from the characters before `through`, which may take in the period word after it. */
function figureEndingAt(
  text: string,
  at: number,
  through: number,
  context: FigureContext,
): FigureAt | undefined {
  const from = Math.max(0, at - COUNT_REACH);
  const local = text.slice(from, through);
  const figures = readFigures(local, { ...context, dates: true, midLine: true, header: null });
  const index = figures.findLastIndex(
    (each) => each.end === at - from || (each.start < at - from && each.end === local.length),
  );
  const figure = figures[index];
  if (!figure) return undefined;
  const previous = figures[index - 1];
  return {
    figure,
    start: from + figure.start,
    previous: previous && {
      figure: previous,
      start: from + previous.start,
      end: from + previous.end,
    },
  };
}

/** Ambiguities that leave a count readable: a unit or currency the sentence states for its amounts can't apply to a number before a period word (#2953). */
const READABLE_AS_COUNT: ReadonlySet<string> = new Set(["separator", "range", "scale", "currency"]);

/**
 * The values a figure the reader read gives a count: a comma or a point it can't place is taken
 * as the first way it lists, a range is its far end, then its near end.
 */
function countValues(figure: Figure): number[] {
  const kinds = figure.ambiguous.map(({ kind }) => kind);
  if (kinds.some((kind) => !READABLE_AS_COUNT.has(kind))) return [Number.NaN];
  if (kinds.includes("scale") && kinds.includes("range")) return [Number.NaN];
  const asWritten = figure.ambiguous
    .flatMap(({ readings }) => readings)
    .find((reading) => reading.scale === 1 && reading.unit.kind === "plain");
  const value = kinds.includes("scale") ? (asWritten?.value ?? Number.NaN) : figure.value;
  return kinds.includes("range") ? [asCount(figure.rangeTo), asCount(value)] : [asCount(value)];
}

const CJK_RANGE_GAP = /^\s*(?:[-–—~～]|至|到)\s*$/;
const YEAR_LIKE = /^(?:19|20)\d{2}(?![\d,.'])/;

/** Whether a figure before a range's connective can be its near end: not a percentage, an amount, a scaled number or a bare year, which stay what they are (#2953). */
function canBeNearEnd(figure: Figure): boolean {
  const [value, ...more] = countValues(figure);
  return (
    figure.unit.kind === "plain" &&
    figure.scale === 1 &&
    figure.currency === null &&
    figure.footnote === null &&
    more.length === 0 &&
    value !== undefined &&
    !Number.isNaN(value) &&
    !YEAR_LIKE.test(figure.chars)
  );
}

/**
 * The values of `found`, and of the figure just before it when the two are the ends of a range the
 * reader leaves apart: "3至5" in Chinese, "between 3 and 5". The reader joins every other English
 * range itself ("3 to 5", "3 - 5") and leaves "20% to 45" and "in 2023 to 30" as two figures.
 */
function withRangeStart(
  text: string,
  found: FigureAt,
  cjk: boolean,
): { values: number[]; start: number } {
  const values = countValues(found.figure);
  const { previous } = found;
  if (!previous || !canBeNearEnd(previous.figure)) return { values, start: found.start };
  const gap = text.slice(previous.end, found.start);
  const joined = cjk
    ? CJK_RANGE_GAP.test(gap)
    : /^\s*and\s*$/i.test(gap) && /\bbetween\s*$/i.test(text.slice(0, previous.start));
  if (!joined) return { values, start: found.start };
  return { values: [...values, ...countValues(previous.figure)], start: previous.start };
}

const YEAR_NAME_UNIT = /^ +(?:year|quarter|month)$/i;
const DATE_END =
  /^(?:\s*(?:$|[.,;:!?)\]}"”…—–])|[ -]end\b|\s+(?:and|or|but|vs|versus|compared|against|was|were|is|are)\b)/i;

/**
 * Whether the period word after a year ends what it names: "the 2024 year", "2024 year end",
 * "Q3 2024 quarter". Where it describes what follows ("a 2000 year history", "2000 year old") or the
 * text doesn't say ("the 2024 year results"), the number counts.
 */
const namesYear = (text: string, at: number, matched: string): boolean =>
  YEAR_NAME_UNIT.test(matched) && DATE_END.test(text.slice(at + matched.length));

const spokenNumbers = (words: string) =>
  figuresOf(
    words
      .toLowerCase()
      .split(/[ -]+/)
      .filter((each) => each !== "and"),
  );

function spelledYear(words: string): boolean {
  if (HALF_AT_END.test(words)) return false;
  const [first, second, ...more] = spokenNumbers(words);
  if (!first || more.length > 0) return false;
  if (!second) return first.value >= 1900 && first.value <= 2099;
  return (first.value === 19 || first.value === 20) && second.value <= 99;
}

function spelledValue(words: string): number {
  const lower = words.toLowerCase();
  const whole = lower.replace(HALF_AT_END, "");
  const half = whole === lower ? 0 : 0.5;
  if (/^an?[ -]dozen$/.test(whole)) return asCount(12 + half);
  const value = wholeNumberWords(whole.replace(/^an?[ -]/, "one "));
  return asCount(value === null ? null : value + half);
}

const SCIENTIFIC_AT_END = /(?<![\w.])\p{Nd}+(?:\.\p{Nd}+)?[eE][+-]?\p{Nd}+$/u;

function scientific(window: string, at: number): Quantity | undefined {
  const found = SCIENTIFIC_AT_END.exec(window);
  return found ? { start: at - found[0].length, values: [Number.NaN] } : undefined;
}

function bracketValue(inner: string, context: FigureContext): number | undefined {
  if (SPELLED_ALL.test(inner)) return spelledValue(inner);
  const figures = readFigures(inner, { ...context, dates: true, midLine: true, header: null });
  const [only] = figures;
  if (figures.length !== 1 || !only || only.start !== 0 || only.end !== inner.length) {
    return undefined;
  }
  const values = countValues(only);
  return values.length === 1 ? (values[0] ?? Number.NaN) : Number.NaN;
}

const BRACKETED_AT_END = /[(（]\s*([^()（）]{1,40}?)\s*[)）]$/u;

/** A number in words and in figures, in either order: "ten (10) days", "30 (thirty) days", "三十（30）天". They must agree. */
function bracketed(text: string, at: number, context: FigureContext): Quantity | undefined {
  const window = text.slice(Math.max(0, at - WORD_REACH), at);
  const bracket = BRACKETED_AT_END.exec(window);
  const inner = bracket?.[1];
  if (!bracket || inner === undefined) return undefined;
  const innerValue = bracketValue(inner, context);
  if (innerValue === undefined) return undefined;
  let outerEnd = at - window.length + bracket.index;
  while (outerEnd > 0 && /\s/.test(text.charAt(outerEnd - 1))) outerEnd--;
  const words = SPELLED_AT_END.exec(text.slice(Math.max(0, outerEnd - WORD_REACH), outerEnd));
  let outer: { value: number; start: number } | undefined;
  if (words) {
    outer = { value: spelledValue(words[1] ?? ""), start: outerEnd - words[0].length };
  } else {
    const read = figureEndingAt(text, outerEnd, outerEnd, context);
    const values = read ? countValues(read.figure) : [];
    if (read && values.length === 1) outer = { value: values[0] ?? Number.NaN, start: read.start };
  }
  if (!outer) return undefined;
  return { start: outer.start, values: [outer.value === innerValue ? innerValue : Number.NaN] };
}

function spelled(window: string, at: number, yearUnit: boolean): Quantity | undefined {
  const found = SPELLED_AT_END.exec(window);
  const words = found?.[1];
  if (!found || words === undefined) return undefined;
  // "a Hundred Days" names something; only a lower-case round number counts.
  if (/^[Aa]n?[ -][A-Z]/.test(words)) return undefined;
  if (yearUnit && spelledYear(words)) return undefined;
  const start = at - found[0].length;
  const rest = window.slice(0, found.index);
  if (/\bbetween\s+$/i.test(rest) && !HALF_AT_END.test(words)) {
    // "three hundred and four hundred" is two numbers to the reader.
    const [near, far, ...more] = spokenNumbers(words);
    if (near && far && more.length === 0) {
      return { start, values: [asCount(far.value), asCount(near.value)] };
    }
  }
  const near = NEAR_OF_RANGE.exec(rest) ?? NEAR_AFTER_BETWEEN.exec(rest);
  const nearValue = near ? spelledValue(near[1] ?? "") : Number.NaN;
  if (near && !Number.isNaN(nearValue)) {
    return {
      start: at - window.length + near.index + near[0].indexOf(near[1] ?? ""),
      values: [spelledValue(words), nearValue],
    };
  }
  return { start, values: [spelledValue(words)] };
}

const SLASH_AT_END = /(?<![\p{Nd}.,'/])(?:(\p{Nd}{1,3})[ -])?(\p{Nd}+)\/(\p{Nd}+)$/u;
const VULGAR_AT_END = /(?<![\p{Nd}.,'])(?:(\p{Nd}{1,3})[ -]?)?([¼-¾⅐-⅞])$/u;
const AND_A_HALF_AT_END = /(?<![\p{Nd}.,'])(\p{Nd}{1,3})[ -]and[ -]a[ -]half$/iu;

/** A fraction the reader doesn't read ("1½", "1/2", "1 1/2", "2 and a half"): halves to twelfths, so "12/31" stays a date. */
function fractional(window: string, at: number): Quantity | undefined {
  const quantityAt = (found: RegExpExecArray, value: number): Quantity => ({
    start: at - window.length + found.index,
    values: [asCount(value)],
  });
  const half = AND_A_HALF_AT_END.exec(window);
  if (half) return quantityAt(half, Number(half[1]) + 0.5);
  const vulgar = VULGAR_AT_END.exec(window);
  if (vulgar) {
    const [numerator = 0, denominator = 1] =
      (vulgar[2] ?? "").normalize("NFKC").match(/\d+/g)?.map(Number) ?? [];
    return quantityAt(vulgar, Number(vulgar[1] ?? 0) + numerator / denominator);
  }
  const slash = SLASH_AT_END.exec(window);
  const numerator = Number(slash?.[2]);
  const denominator = Number(slash?.[3]);
  if (!slash || denominator < 2 || denominator > 12 || numerator < 1 || numerator >= denominator) {
    return undefined;
  }
  return quantityAt(slash, Number(slash[1] ?? 0) + numerator / denominator);
}

function digits(
  text: string,
  at: number,
  matched: string,
  context: FigureContext,
): Quantity | undefined {
  const run = /\p{Nd}+$/u.exec(text.slice(Math.max(0, at - COUNT_REACH), at));
  if (!run) return undefined;
  let found = figureEndingAt(text, at, at, context);
  // Three digits after a plain space may end a number the Document doesn't say it writes that way
  // ("2 000"); read with a space as the separator, they are one number with what comes before.
  if (
    found &&
    /^\p{Nd}{3}$/u.test(found.figure.chars) &&
    /\p{Nd} $/u.test(text.slice(Math.max(0, found.start - 2), found.start))
  ) {
    const grouped = figureEndingAt(text, at, at, {
      ...context,
      separators: { decimal: context.separators?.decimal ?? ".", group: " " },
    });
    if (grouped && grouped.start < found.start) found = grouped;
  }
  const read = found && withRangeStart(text, found, false);
  const start = read?.start ?? at - run[0].length;
  const numberAt = start + Math.max(0, text.slice(start, at).search(/\p{Nd}/u));
  // A number inside a word is no count, read or not: "FY24 year-end".
  if (startsInsideWord(text, numberAt)) return undefined;
  // A year that names a period is a date: "the 2024 year", "Q3 2024 quarter", "a 2019 month-end close".
  if (namesYear(text, at, matched) && YEAR_LIKE.test(text.slice(numberAt, at))) return undefined;
  if (found && read) {
    return {
      start,
      values: read.values,
      decimals: read.values.length === 1 ? found.figure.decimals : undefined,
    };
  }
  // The reader leaves out a number a hyphen glues to a word ("over-60-day", "1-in-200-year"): its
  // digits alone are the count. Any other number it won't read has no value.
  const glued = /[\p{L}-]$/u.test(text.slice(Math.max(0, start - 2), start));
  return { start, values: [glued ? asCount(Number(run[0])) : Number.NaN] };
}

/**
 * A range is two figures, its last number then its first. The first has a unit of its own, so a
 * single count is held to the last number alone and not to the first ("3 days" against "3-5 days"
 * stays not judged), and a range's first number is held to another range's first (#2953).
 */
const unitOf = (unit: string, index: number): string => (index === 0 ? unit : `${unit} (near end)`);

function countFigure(
  text: string,
  start: number,
  end: number,
  value: number,
  unit: string,
  decimals: number,
): Figure {
  return {
    start,
    end,
    chars: text.slice(start, end),
    value,
    scale: 1,
    scaleWord: null,
    unit: { kind: "other", word: unit },
    decimals,
    currency: null,
    approximate: false,
    rangeTo: null,
    footnote: null,
    ambiguous: [],
  };
}

const AND_A_HALF_AFTER = /^[ -]and[ -]a[ -]half\b/i;
const ARTICLE_AT_END = /\b(an?)$/i;

/** "a year and a half": the article is a count of one only when the half follows. */
function article(window: string, at: number): Quantity | undefined {
  const found = ARTICLE_AT_END.exec(window);
  return found ? { start: at - found[0].length, values: [1] } : undefined;
}

function englishCounts(text: string, context: FigureContext): Figure[] {
  const counts: Figure[] = [];
  for (const match of text.matchAll(new RegExp(EN_PERIOD, "gi"))) {
    const unit = match[1]?.toLowerCase().replace(/s$/, "");
    if (!unit) continue;
    const at = match.index;
    const window = text.slice(Math.max(0, at - WORD_REACH), at);
    const halfAfter = AND_A_HALF_AFTER.exec(text.slice(at + match[0].length));
    const found =
      scientific(window, at) ??
      bracketed(text, at, context) ??
      spelled(window, at, namesYear(text, at, match[0])) ??
      fractional(window, at) ??
      digits(text, at, match[0], context) ??
      (halfAfter ? article(window, at) : undefined);
    if (!found) continue;
    const halved = halfAfter !== null && found.values.length === 1;
    const end = at + match[0].length + (halved ? (halfAfter?.[0].length ?? 0) : 0);
    for (const [index, value] of found.values.entries()) {
      const total = halved ? value + 0.5 : value;
      const decimals = halved ? decimalsOf(total) : (found.decimals ?? decimalsOf(total));
      counts.push(countFigure(text, found.start, end, total, unitOf(unit, index), decimals));
    }
  }
  return counts;
}

const CHINESE_UNITS: Readonly<Record<string, string>> = {
  年: "year",
  个月: "month",
  月: "month",
  周岁: "year",
  周年: "year",
  周: "week",
  天: "day",
  日: "day",
  个季度: "quarter",
  季度: "quarter",
  个工作日: "工作日",
  工作日: "工作日",
  个交易日: "交易日",
  交易日: "交易日",
  个营业日: "营业日",
  营业日: "营业日",
};

const DAYS_AFTER = /^(?:(?:以|之)?内|以上|以下|之上|之下)/u;
const DAYS_BEFORE = /(?:满|超过|不少于|不超过|少于|多于|不足|不满|逾|至少|最多)\s*$/u;

/**
 * Whether the text around a number makes the unit after it name a date or a position, not a count:
 * "5/6月" and "5月" are months, "3/4季度" and "第3季度" quarters, "5月30日" a day of a month, "第3个工作日"
 * a position. "30日内" and "超过30日" are thirty days; "连续3季度" counts, and so does anything with 个.
 * 工作日, 交易日 and 营业日 are periods of their own, never calendar days (#2953).
 */
function namesDate(
  unit: string,
  before: string,
  after: string,
  value: number,
  halfMonths: boolean,
): boolean {
  // "这一年", "那一年", "每一年" and "当一年" say which year, not how many: one period behind a
  // demonstrative is no count (#2215).
  if (value === 1 && PERIOD_DEMONSTRATIVE.test(before)) return true;
  const consecutive = /(?:连续|接连|相继)\s*$/u.test(before);
  if (/第\s*$/u.test(before)) return true;
  if (unit === "年" && value >= 1000 && !consecutive) return true;
  const days =
    unit === "日" &&
    (DAYS_AFTER.test(after) || DAYS_BEFORE.test(before)) &&
    !/月份?\s*$/u.test(before);
  if (
    (unit === "月" || unit === "日" || unit === "季度") &&
    !halfMonths &&
    !consecutive &&
    !days &&
    !/个\s*$/u.test(before)
  ) {
    return true;
  }
  return /(?:公元|民国)\s*$/u.test(before);
}

function chineseCounts(text: string, context: FigureContext): Figure[] {
  const counts: Figure[] = [];
  // The reader knows 工作日 as a period and not 交易日 or 营业日: they are as long, so it is handed
  // 工作日 for them and every offset stays.
  const readable = text.replace(/交易日|营业日/gu, "工作日");
  for (const match of text.matchAll(
    /年|个月|月|周岁|周年|周|天|个?工作日|个?交易日|个?营业日|日|个季度|季度/gu,
  )) {
    const unit = CHINESE_UNITS[match[0]];
    if (!unit) continue;
    const unitAt = match.index;
    const unitEnd = unitAt + match[0].length;
    const after = text.slice(unitEnd);
    // "三个半月" is "三个月" and a half: the reader is given "三个月".
    const halfMonths = match[0] === "月" && text.slice(unitAt - 2, unitAt) === "个半";
    const source = halfMonths ? readable.slice(0, unitAt - 1) + readable.slice(unitAt) : readable;
    const readAt = halfMonths ? unitAt - 2 : unitAt;
    const window = source.slice(Math.max(0, readAt - WORD_REACH), readAt);
    let found: Quantity | undefined = bracketed(source, readAt, context);
    if (!found) {
      const fraction = fractional(window, readAt);
      const before = fraction ? text.slice(0, fraction.start) : "";
      const value = fraction?.values[0] ?? Number.NaN;
      if (fraction && namesDate(match[0], before, after, value, halfMonths)) continue;
      found = fraction;
    }
    if (!found) {
      const read = figureEndingAt(source, readAt, halfMonths ? unitAt : unitEnd, context);
      if (!read) continue;
      const before = text.slice(0, read.start);
      if (namesDate(match[0], before, after, read.figure.value, halfMonths)) continue;
      const ends = withRangeStart(text, read, true);
      found = {
        start: ends.start,
        values: ends.values,
        decimals: ends.values.length === 1 ? read.figure.decimals : undefined,
      };
    }
    const trailingHalf =
      !halfMonths && /^半(?!导体|夜|径|岛|场|数|成品)/u.test(text.slice(unitEnd));
    const halved = halfMonths || trailingHalf;
    const end = trailingHalf ? unitEnd + 1 : unitEnd;
    for (const [index, value] of found.values.entries()) {
      const total = halved ? value + 0.5 : value;
      const decimals = halved || found.decimals === undefined ? decimalsOf(total) : found.decimals;
      counts.push(countFigure(text, found.start, end, total, unitOf(unit, index), decimals));
    }
  }
  return counts;
}

export function periodCounts(text: string, context: FigureContext): Figure[] {
  return [...englishCounts(text, context), ...chineseCounts(text, context)];
}
