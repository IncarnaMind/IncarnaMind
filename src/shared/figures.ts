/**
 * Figures: what each number in a text is. The Citation check, a calculation
 * and the check of an Answer's figures all read numbers here, so a figure
 * means the same thing to each of them.
 *
 * A number in a quote is more than its digits: "1.2亿" is 120,000,000,
 * "(1,250)" is negative, "25%" is 0.25, and "2.3个百分点" is a difference of
 * percents, not a percent. A sum built on a wrong reading looks exactly like
 * a right one, so whatever the text alone can't settle is returned as a
 * question, with each way the figure could be read, and never decided here:
 *
 * - "1,234" where neither the Document's language nor its other numbers say
 *   whether a comma groups thousands or marks decimals;
 * - "¥", which is yuan or yen;
 * - a figure with no scale of its own under a header that states one
 *   ("单位：万元", "in millions");
 * - "△1,250", which some reports use for a decrease and others for a change;
 * - "(250)" or "(12.5%)", a minus in accounts and an aside in prose, and "12,500.00 DR",
 *   a debit that may or may not be a minus (#978);
 * - "2–3%", a range, which can't be one input without choosing an end;
 * - "3 points", which may be percentage points or an index's points.
 *
 * Years, dates, quarters and periods ("2025年", "Q3", "30 June", "三年") are
 * not figures unless asked for: they say when, not how much, and the check of
 * an Answer's figures must not take them for its numbers. Nor are ordinals,
 * list numbers and references ("第3", "1.", "Note 12", "IFRS 16"), and nor is
 * a lone Chinese numeral that is a word ("一个", "十分"), which would make
 * most Chinese sentences full of figures.
 *
 * Values come from the digits as written, as a spreadsheet reads "41.2%"
 * (0.412, not 41.2 ÷ 100) and "1.1亿" (110000000, not 1.1 × 1e8, which is
 * 110000000.00000001), so a figure gives the same double as a workbook.
 *
 * Pure, with no Node or DOM imports: the core, the renderer and a later
 * phone build share it.
 */
import { graphemeBoundary } from "./graphemes";
import { SIMPLIFIED } from "./hanVariants";
import { INVISIBLE, normaliseWithOffsets } from "./text";

/** What a figure measures. */
export type FigureUnit =
  | { kind: "plain" }
  /** A share: "25%" is 0.25. */
  | { kind: "percent" }
  /** A difference of percents: "2.3 percentage points" and "230 bps" are both 0.023. */
  | { kind: "points" }
  /** A multiple: "2.5倍", "2.5x". */
  | { kind: "times" }
  /** An amount of money, by its ISO 4217 code. */
  | { kind: "currency"; code: string }
  /** Anything else counted or measured, by its word as written: "吨", "km", "users". */
  | { kind: "other"; word: string };

/** One way to read a figure: its value, and what it measures. */
export interface Reading {
  /** With its scale applied: 120000000 for "1.2亿", 0.25 for "25%", -1250 for "(1,250)". */
  value: number;
  /** What its scale word multiplies by: 1e8 for "亿", 1e6 for "million"; 1 with none. */
  scale: number;
  /** The scale word as written ("亿", "million", "bn"), kept for showing a result in the same scale. */
  scaleWord: string | null;
  unit: FigureUnit;
  /**
   * Digits written after the decimal mark ("$1,231.0 million" has 1), which
   * the value can't keep: 1231.0 and 1231 are the same double. A result
   * worked out from the figure is shown with as many.
   */
  decimals: number;
  /** Last shown place in base units; null for exact fractions, undefined for legacy or unrepresentable precision. */
  precision?: number | null;
  /**
   * For a reading a stated unit gives (a "scale" ambiguity's): where that unit is stated, in the
   * text read, in its header (a table's caption or heading), or in both (#2512).
   */
  statedIn?: "text" | "header" | "both";
}

/**
 * What the text alone doesn't settle:
 * - "separator": whether "," or "." groups thousands or marks decimals, or
 *   a figure whose decimal mark isn't the one the Document uses;
 * - "currency": "¥", yuan or yen;
 * - "scale": no scale of its own, under a header that states one;
 * - "sign": "△1,250", a whole number or a percent in brackets, "(250)", or "12,500.00 DR";
 * - "range": "2–3%", two values;
 * - "points": "3 points", percentage points or an index's.
 */
export type AmbiguityKind = "separator" | "currency" | "scale" | "sign" | "range" | "points";

/** Something about a figure the text doesn't settle, with every way it could be read. */
export interface Ambiguity {
  kind: AmbiguityKind;
  readings: Reading[];
}

/** A number read from a text. */
export interface Figure extends Reading {
  /** UTF-16 offsets into the text read; `end` is exclusive. */
  start: number;
  end: number;
  /**
   * The characters as written, with the sign, brackets, currency, scale, unit
   * and footnote mark that belong to it ("(1,250)", "$1.2bn", "1.2亿元¹"): what
   * a Citation shows, and what the check finds again.
   */
  chars: string;
  /** Its own currency as written, apart from the number: "£", "US$", "英镑", "GBP". */
  currency: string | null;
  /** Written as approximate or as a bound: "约", "c.", "about", "~", "近", "逾", "超过", "左右". */
  approximate: boolean;
  /** The other end of a range ("2–3%": 0.03); `value` is the first. */
  rangeTo: number | null;
  /** A footnote mark taken off the figure: "¹", "(a)", "*". */
  footnote: string | null;
  /**
   * What couldn't be decided from the text. When it isn't empty, `value` is
   * only the first reading listed, and isn't to be used until one is chosen.
   */
  ambiguous: Ambiguity[];
}

/** How a Document writes its numbers: "1,234.5" has decimal "." and group ",". */
export interface Separators {
  decimal: "." | ",";
  group: "," | "." | " " | "'";
}

/** What a text's figures are read with, beyond the text itself. */
export interface FigureContext {
  /** The Document's language, as a BCP 47 tag ("en", "zh-CN", "de-CH"): it says how numbers are written. */
  language?: string | null;
  /** The separators the Document's other numbers use (see `figureContextOf`). */
  separators?: Separators | null;
  /**
   * What "¥" stands for in the Document, when its text says: "unsure" when the text names the
   * other currency too ("日元" in Chinese text), so the number is refused rather than guessed.
   */
  yen?: "CNY" | "JPY" | "unsure" | null;
  /** A table header or caption that applies to the text: the scale or currency it states. */
  header?: string | null;
  /** `header` read once with this context, so each cell of a table reads it no more (#2523). */
  headerRead?: HeaderRead | null;
  /** Read years, dates, quarters and periods as plain figures too. */
  dates?: boolean;
  /**
   * The Document is accounts (see `figureContextOf`), so a whole number in
   * brackets in one of its table rows or statement lines is negative. Left
   * out, it is worked out from the text read.
   */
  accounts?: boolean;
  /**
   * The Document says amounts in brackets are negative ("Amounts in brackets are negative"), so a
   * bracket after an amount is never read as giving that amount again. Left out, it is worked out
   * from the text read.
   */
  negativeBrackets?: boolean;
  /**
   * The text starts inside a line of its Document, as a quote from the middle of one does: a
   * number at its start is neither a list's nor a heading's (#1969).
   */
  midLine?: boolean;
  /**
   * The Document's text on either side of the text read, when that is a quote from it. A sign word
   * there ("The reserve turned negative in May." before "At year end it stood at …") keeps the
   * minus of a bracket that gives an amount again.
   */
  around?: { before: string; after: string } | null;
}

/** A scale or unit stated apart from the figures it applies to: "单位：万元", "(in millions)". */
export interface StatedUnit {
  start: number;
  end: number;
  chars: string;
  scale: number;
  scaleWord: string | null;
  unit: FigureUnit;
  /**
   * Which figures its scale leaves out, as the line goes on to say: "(in millions, except per share
   * data)", "（除每股数据外）"; with "shares", "except share and per share data" leaves share counts
   * out too; "noted", "except where noted", leaves out figures it doesn't name.
   */
  except?: "per-share" | "shares" | "noted";
  /**
   * A currency its line names that the reader can't place, as written ("in thousands of Japanese
   * yen"). Its scale is a plain one, which only a figure's own sign may give a currency; to a row
   * head's currency it is another one (#2365).
   */
  unplacedCurrency?: string;
}

// The text as the reader reads it ------------------------------------------

let steps = 0;

/**
 * How many steps the figure reader has taken in this process: each place in a text it moves to,
 * each character it lexes, each group of digits it reads and each character of a line it scans. A
 * test bounds the reader's work by them (#2510).
 */
export const figureReadingSteps = (): number => steps;

/** Counts steps of reading figures that happen beside the reader, as a Note's sentences are read (#2512). */
export const countFigureSteps = (count: number): void => {
  steps += count;
};

/** A footnote mark or a circled number, which NFKC would otherwise turn into a digit beside the figure. */
export const FOOTNOTE_MARK_CHAR = "\ue000";
/** A no-break or thin space: nobody puts one between two separate numbers, so it always groups. */
const NBSP = "\u00a0";

const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/;
/** Circled numbers and letters ("①", "ⓐ"): NFKC would write each as a digit or a letter. */
const CIRCLED_CHARS = "\\u2460-\\u24ff\\u2776-\\u2793";
const SUPERSCRIPT_CHARS = `\\u00b2\\u00b3\\u00b9\\u2070-\\u207f${CIRCLED_CHARS}`;
const SUPERSCRIPT = new RegExp(`^[${SUPERSCRIPT_CHARS}]$`, "u");
const SPACE_LIKE = /^[\u00a0\u2007\u2009\u202f]$/;
const FULL_WIDTH_DIGIT = /^[\uff10-\uff19]$/;
const LATIN_LETTER = /^[A-Za-z]$/;
/** A length that "²" or "³" raises to a power ("m²", "km³"): there they are digits, not footnote marks. */
const POWER_AFTER = /(?<![A-Za-z])(?:m|km|cm|mm|ft)$/;

/** Whether `text` at `start`–`end` is a superscript read as a footnote mark, not a digit ("1,240.50¹", not "m²"). */
const isFootnoteMark = (text: string, start: number, end: number): boolean =>
  SUPERSCRIPT.test(text.slice(start, end)) &&
  !POWER_AFTER.test(text.slice(Math.max(0, start - 3), start));

/** A footnote's mark after a figure: a superscript digit ("¹") or a circled mark ("①"). */
const MARK_AFTER_FIGURE = new RegExp(`^[¹²³⁰⁴-⁹${CIRCLED_CHARS}]$`, "u");
/** What a figure ends in: a digit, a closing bracket, or a percent of either width. */
const ENDS_FIGURE = /[\p{Nd})）%％]$/u;

/**
 * Whether `text` at `start`–`end` is a footnote's mark directly after a
 * figure ("1,240.50¹", "1,240.50①"): not a power or a unit's sign elsewhere
 * ("x²", "Ca²⁺", "2ⁿᵈ", "see note¹").
 */
export const isFootnoteAfterFigure = (text: string, start: number, end: number): boolean =>
  MARK_AFTER_FIGURE.test(text.slice(start, end)) &&
  ENDS_FIGURE.test(text.slice(Math.max(0, start - 1), start));

/** `text` with each footnote's mark read as `FOOTNOTE_MARK_CHAR`, which NFKC keeps apart from the figure ("1,240.50¹"). */
export const markedFootnotes = (text: string): string =>
  text.replace(/./gu, (char, at: number) =>
    isFootnoteAfterFigure(text, at, at + char.length) ? FOOTNOTE_MARK_CHAR : char,
  );

interface Prepared {
  /** The normalised text (./text, ADR-0009), one character per character read. */
  s: string;
  /** Where each character of `s` came from in the original text. */
  from: number[];
  to: number[];
  /**
   * Characters of `s` that start a line, or follow a space, in the original
   * text, where the normaliser removed the line break or the space beside a
   * Chinese character: a list's "1." and a heading's "1 引言" are told by them.
   */
  lineStarts: ReadonlySet<number>;
  spaced: ReadonlySet<number>;
  /** Characters of `s` that follow a tab in the original text, which the normaliser removes beside a Chinese character. */
  tabbed: ReadonlySet<number>;
  breaks: readonly number[];
  lines: Map<number, Line>;
}

/**
 * The shared normaliser's text (full-width digits are digits, "−" is "-"),
 * with what it would lose for reading numbers put back: which whitespace
 * is a single space (it may group thousands) and which is a tab or a line
 * (it separates cells and lines), a superscript footnote mark as a mark
 * rather than a digit ("12.3¹" isn't 12.31), and "。", "、" and "，" as
 * the punctuation they are, so "增长3。5月" doesn't become 3.5.
 * Traditional characters read as simplified ones ("億" as "亿").
 */
function prepare(text: string, midLine = false): Prepared {
  const { units } = normaliseWithOffsets(text);
  let s = "";
  const from: number[] = [];
  const to: number[] = [];
  const lineStarts = new Set<number>(midLine ? [] : [0]);
  const spaced = new Set<number>();
  const tabbed = new Set<number>();
  const breaks: number[] = [];
  let previousEnd = 0;
  for (const unit of units) {
    if (unit.removed) continue;
    const gap = text.slice(previousEnd, unit.start);
    // "is ＄54,000": the space normalising drops before a full-width sign still sets it apart.
    if (/[^\S\n]/.test(gap) && CURRENCY_SIGN.test(unit.char) && s !== "" && !/\s$/.test(s)) {
      s += " ";
      from.push(previousEnd);
      to.push(unit.start);
    }
    if (LINE_BREAK.test(gap)) lineStarts.add(s.length);
    if (/\s/.test(gap)) spaced.add(s.length);
    if (gap.includes("\t")) tabbed.add(s.length);
    previousEnd = unit.end;
    const original = text.slice(unit.start, unit.end);
    let char = unit.char;
    if (char === " ") {
      if (LINE_BREAK.test(original)) char = "\n";
      else if (original === " ") char = " ";
      else char = SPACE_LIKE.test(original) ? NBSP : "\t";
    } else if (isFootnoteMark(text, unit.start, unit.end)) {
      char = FOOTNOTE_MARK_CHAR;
    } else if (original === "。" || original === "｡") {
      char = "。";
    } else if (original === "、" || original === "､") {
      char = "、";
    } else if (original === "，") {
      const fullWidth =
        FULL_WIDTH_DIGIT.test(text.charAt(unit.start - 1)) &&
        FULL_WIDTH_DIGIT.test(text.charAt(unit.end));
      char = fullWidth ? "," : "，";
    } else {
      char = SIMPLIFIED.get(char) ?? char;
    }
    if (char === "\n") {
      lineStarts.add(s.length + 1);
      breaks.push(s.length);
    }
    s += char;
    from.push(unit.start);
    to.push(unit.end);
  }
  return { s, from, to, lineStarts, spaced, tabbed, breaks, lines: new Map() };
}

function countBefore(positions: readonly number[], at: number): number {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((positions[middle] as number) < at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Where the line that `at` ends or is in starts: just after the last line break before `at`. */
function lineStart({ breaks }: Prepared, at: number): number {
  const before = countBefore(breaks, at);
  return before === 0 ? 0 : (breaks[before - 1] as number) + 1;
}

/** Where the line goes on to from `at`: the first line break at `at` or after it, or the text's end. */
function lineEnd({ s, breaks }: Prepared, at: number): number {
  return breaks[countBefore(breaks, at)] ?? s.length;
}

const isDigit = (char: string | undefined): boolean =>
  char !== undefined && char >= "0" && char <= "9";
const isLatin = (char: string | undefined): boolean =>
  char !== undefined && LATIN_LETTER.test(char);
const isAlnum = (char: string | undefined): boolean => isDigit(char) || isLatin(char);

/** A match of a sticky pattern at `at`, or null. */
function matchAt(pattern: RegExp, s: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(s);
}

// Thousands, shared with the Citation check ---------------------------------

/**
 * Whether a separator at `at` sits where thousands are grouped: after one to
 * three digits that aren't a number's decimals, and before exactly three
 * digits. Reading and matching share it, so the Citation check and a
 * calculation see the same groups.
 */
function separatesThousands(char: (at: number) => string | undefined, at: number): boolean {
  const digit = (index: number) => isDigit(char(index));
  if (!digit(at + 1) || !digit(at + 2) || !digit(at + 3) || digit(at + 4)) return false;
  let start = at;
  while (start > 0 && digit(start - 1)) start--;
  return at - start >= 1 && at - start <= 3 && char(start - 1) !== ".";
}

const GROUP_SEPARATORS: ReadonlySet<string> = new Set([",", " ", "'"]);
const CURRENCY_SIGN = /^\p{Sc}$/u;

/**
 * The characters that only format the numbers in `chars`, for the Citation
 * check to match a quote of a sheet's rows or a slide's chart however its
 * figures are written (ADR-0011), while their digits, decimals and sign must
 * agree. Each changed position maps to "" (dropped) or "-" (an accounting
 * negative's bracket, so "(4,812)" reads "-4812"):
 *
 * - thousands separators (see `separatesThousands`): a space only where
 *   `spaceSeparates` says, since a tab between cells must never join them;
 * - a currency sign next to a number;
 * - the brackets of an accounting negative, when what they hold is plainly a
 *   formatted number ("(4,812)", "(12.5)"), not a year or a list's "(2)";
 * - zeros that end decimals, and the point when nothing is left after it.
 *
 * The quote and the text are both read this way, so a dropped character
 * never decides a match by itself; what it doesn't read (scales, Chinese
 * numerals, percents) is matched as written.
 */
export function numberFormatting(
  chars: readonly string[],
  spaceSeparates: (at: number) => boolean,
): Map<number, "" | "-"> {
  const edits = new Map<number, "" | "-">();
  const live = () => chars.map((_, at) => at).filter((at) => edits.get(at) !== "");
  const charOf = (at: number | undefined) =>
    at === undefined ? undefined : edits.get(at) === "-" ? "-" : chars[at];
  const digitAt = (at: number | undefined) => isDigit(charOf(at));

  let list = live();
  list.forEach((at, index) => {
    const char = chars[at] as string;
    if (!GROUP_SEPARATORS.has(char)) return;
    if (char === " " && !spaceSeparates(at)) return;
    if (separatesThousands((offset) => charOf(list[offset]), index)) edits.set(at, "");
  });

  list = live();
  list.forEach((at, index) => {
    if (!CURRENCY_SIGN.test(chars[at] as string)) return;
    const next = charOf(list[index + 1]);
    if (
      digitAt(list[index - 1]) ||
      isDigit(next) ||
      ((next === "(" || next === "-") && digitAt(list[index + 2]))
    ) {
      edits.set(at, "");
    }
  });

  list = live();
  list.forEach((at, index) => {
    if (charOf(at) !== "(") return;
    let end = index + 1;
    while (digitAt(list[end]) || charOf(list[end]) === ".") end++;
    const close = list[end];
    if (close === undefined || charOf(close) !== ")" || end === index + 1) return;
    if (!digitAt(list[index + 1])) return;
    let formatted = false;
    for (let inside = at + 1; inside < close; inside++) {
      if (edits.get(inside) === "" || chars[inside] === ".") formatted = true;
    }
    if (!formatted) return;
    edits.set(at, "-");
    edits.set(close, "");
  });

  list = live();
  list.forEach((at, index) => {
    if (charOf(at) !== "." || !digitAt(list[index - 1]) || !digitAt(list[index + 1])) return;
    let end = index + 1;
    while (digitAt(list[end])) end++;
    let last = end - 1;
    while (last > index && charOf(list[last]) === "0") {
      edits.set(list[last] as number, "");
      last--;
    }
    if (last === index) edits.set(at, "");
  });
  return edits;
}

// How a Document writes numbers ----------------------------------------------

/** A language's separators, as Intl formats 1,234,567.5 in it; null for a language it doesn't know. */
function languageSeparators(language: string): Separators | null {
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(language);
  } catch {
    // Not a language tag at all ("English"): the language says nothing.
    return null;
  }
  // An unknown language falls back to the computer's own, which says nothing about the Document.
  const asked = language.split(/[-_]/)[0]?.toLowerCase();
  if (format.resolvedOptions().locale.split("-")[0]?.toLowerCase() !== asked) return null;
  const parts = format.formatToParts(1234567.5);
  const decimal = parts.find((part) => part.type === "decimal")?.value;
  const group = parts.find((part) => part.type === "group")?.value ?? "";
  if (decimal !== "." && decimal !== ",") return null;
  if (group === "," || group === ".") return { decimal, group };
  if (/^[\s\u00a0\u202f]$/.test(group)) return { decimal, group: " " };
  if (group === "'" || group === "’") return { decimal, group: "'" };
  return null;
}

/**
 * The headings whose column keeps its digits as written: an identifier or a
 * period. A year, an account number or a clause number grouped ("2,026")
 * would stop reading as one (#2102).
 */
export const RAW_COLUMN_HEADERS: readonly string[] = [
  "ID",
  "code",
  "No.",
  "number",
  "Year",
  "FY",
  "Period",
  "Quarter",
  "Fiscal year",
  "Financial year",
  "Reporting period",
  "编号",
  "代码",
  "序号",
  "年",
  "年份",
  "年度",
  "期间",
  "季度",
  "财年",
  "会计年度",
  "报告期",
];

// One bracket after a heading's own words: "Year (FY)", "年份（财年）".
const HEADER_BRACKET = /\s*[（(][^（()）]*[）)]$/;

const RAW_HEADINGS: ReadonlySet<string> = new Set(
  RAW_COLUMN_HEADERS.map((header) => header.toLowerCase()),
);

/**
 * Whether a column keeps its cells' digits raw, decided by its heading alone
 * and never by a cell's size: "Year (FY)", "年份（财年）", "Reporting period"
 * and "ID" do, while "Yearly revenue", "Revenue per year (£)" and "FY 2024"
 * don't. Other headings are amounts, whose numbers the interface writes.
 */
export function rawColumn(header: string): boolean {
  const trimmed = header.trim();
  return RAW_HEADINGS.has(trimmed.replace(HEADER_BRACKET, "").trim().toLowerCase());
}

/**
 * A string that groups as a written number: digits that a person would group
 * with the language's separator. A leading zero ("02139", a postcode), an
 * exponent ("1e3") and anything else written stays exactly as it is (#2105).
 */
const GROUPABLE_NUMBER = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Where a language puts its group separator, taken from the same formatter `figureText` uses. */
function groupSeparator(language: string): string {
  return (
    groupedFormat(language, 0)
      .formatToParts(1000)
      .find((part) => part.type === "group")?.value ?? ""
  );
}

/**
 * A numeric string as text: the language's group separator in its integer
 * digits, its fraction exactly as written. Nothing is turned into a number,
 * so "9007199254740993" and "1234.50" keep every digit they were written with.
 */
function groupedNumberText(language: string, text: string): string {
  const sign = text.startsWith("-") || text.startsWith("+") ? text.slice(0, 1) : "";
  const body = text.slice(sign.length);
  const point = body.indexOf(".");
  const integer = point < 0 ? body : body.slice(0, point);
  const fraction = point < 0 ? "" : body.slice(point);
  if (integer.length <= 3) return text;
  const separator = groupSeparator(language);
  let grouped = "";
  for (const [index, digit] of [...integer].entries()) {
    if (index > 0 && (integer.length - index) % 3 === 0) grouped += separator;
    grouped += digit;
  }
  return `${sign}${grouped}${fraction}`;
}

/** The precision an Analysis has always rounded a non-integer to, kept so grouping never changes it. */
function roundedText(value: number): string {
  if (Number.isInteger(value) || !Number.isFinite(value)) return String(value);
  const whole = Math.floor(Math.log10(Math.abs(value))) + 1;
  return String(Number(value.toPrecision(Math.max(4, whole + 2))));
}

const GROUPED_FORMATS = new Map<string, Intl.NumberFormat>();

function groupedFormat(language: string, places: number): Intl.NumberFormat {
  const key = `${language}\u0000${places}`;
  const found = GROUPED_FORMATS.get(key);
  if (found) return found;
  const options: Intl.NumberFormatOptions = {
    useGrouping: "always",
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  };
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(language, options);
  } catch {
    // Not a language tag at all ("English"): there is no language to write by.
    format = new Intl.NumberFormat("en", options);
  }
  GROUPED_FORMATS.set(key, format);
  return format;
}

/**
 * A number as the interface writes it: an Analysis's own precision first, then
 * the language's separators, with every number of 1,000 and over grouped
 * (#2102). A number JavaScript writes exponentially keeps that form, since
 * grouping it would add digits it never had.
 */
export function figureText(language: string, value: number): string {
  const rounded = roundedText(value);
  if (/e/i.test(rounded)) return rounded;
  const point = rounded.indexOf(".");
  const places = point === -1 ? 0 : rounded.length - point - 1;
  return groupedFormat(language, places).format(Number(rounded));
}

/**
 * A cell of an Analysis table as it reads: a string that is a plain number is
 * grouped as text, so its digits are never read as a number; a string that is
 * anything else ("7,509,964", "n/a", "12.5%", "02139", "1e3") stays exactly
 * as it is. A column `rawColumn` names keeps its digits raw, however large a
 * cell is.
 */
export function figureCellText(
  language: string,
  cell: string | number | boolean | null,
  raw: boolean,
): string {
  if (cell === null) return "";
  if (typeof cell === "number") return raw ? String(cell) : figureText(language, cell);
  if (typeof cell !== "string") return String(cell);
  const trimmed = cell.trim();
  return !raw && GROUPABLE_NUMBER.test(trimmed) ? groupedNumberText(language, trimmed) : cell;
}

/**
 * A single figure result as the interface writes it: a label a `rawColumn`
 * heading names keeps its digits raw, as the same value in that column does
 * (#2105).
 */
export function figureResultText(language: string, value: number, label: string): string {
  return rawColumn(label) ? String(value) : figureText(language, value);
}

/** Numbers whose separators can only be read one way, and the convention each shows. */
const EVIDENCE: readonly [RegExp, Separators][] = [
  [/(?<![\d.,'])\d{1,3}(?:,\d{3})+\.\d+(?![\d.,])/g, { decimal: ".", group: "," }],
  [/(?<![\d.,'])\d{1,3}(?:,\d{3}){2,}(?![\d.,])/g, { decimal: ".", group: "," }],
  [/(?<![\d.,'])\d{1,3}(?:'\d{3})+(?:\.\d+)?(?![\d.,'])/g, { decimal: ".", group: "'" }],
  [/(?<![\d.,'])\d{1,3}(?:\.\d{3})+,\d+(?![\d.,])/g, { decimal: ",", group: "." }],
  [/(?<![\d.,'])\d{1,3}(?:\.\d{3}){2,}(?![\d.,])/g, { decimal: ",", group: "." }],
  [
    /(?<![\d.,']|\d[ \u00a0])\d{1,3}(?:[ \u00a0]\d{3})+,\d+(?![\d.,])/g,
    { decimal: ",", group: " " },
  ],
];

/** Below this share of a Document's telling numbers, the other convention is taken for stray text. */
const MAX_STRAY_SHARE = 0.1;

/** How often each convention's telling numbers appear in a text, by decimal and group. */
type Evidence = Readonly<Record<string, number>>;

const keyOf = (separators: Separators) => `${separators.decimal}${separators.group}`;

/** Each convention once, by its key, in `EVIDENCE`'s order: a tie goes to the earlier. */
const CONVENTIONS = new Map(EVIDENCE.map(([, separators]) => [keyOf(separators), separators]));

function evidenceIn(s: string): Evidence {
  const counts: Record<string, number> = {};
  for (const [pattern, separators] of EVIDENCE) {
    const found = s.match(pattern)?.length ?? 0;
    if (found > 0) counts[keyOf(separators)] = (counts[keyOf(separators)] ?? 0) + found;
  }
  return counts;
}

/** The separators a text's own numbers show, when they agree; null when they don't or none tells. */
function separatorsFrom(evidence: Evidence): Separators | null {
  const byDecimal = (decimal: string) =>
    [...CONVENTIONS.values()]
      .filter((separators) => separators.decimal === decimal)
      .map((separators) => ({ separators, count: evidence[keyOf(separators)] ?? 0 }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count);
  const point = byDecimal(".");
  const comma = byDecimal(",");
  const total = (entries: { count: number }[]) => entries.reduce((sum, e) => sum + e.count, 0);
  const points = total(point);
  const commas = total(comma);
  if (points + commas === 0) return null;
  if (commas / (points + commas) <= MAX_STRAY_SHARE) return point[0]?.separators ?? null;
  if (points / (points + commas) <= MAX_STRAY_SHARE) return comma[0]?.separators ?? null;
  return null;
}

const CNY_WORDS = /人民币|RMB|Rmb|CNY|[Rr]enminbi|\byuan\b/;
const JPY_WORDS = /日元|円|JPY|\byen\b/;

/** The languages a Document may be in, as their BCP 47 tags, by the name `detectLanguage` gives them. */
const LANGUAGE_TAGS: Readonly<Record<string, string>> = {
  English: "en",
  Chinese: "zh",
  Japanese: "ja",
  Korean: "ko",
  French: "fr",
  German: "de",
  Spanish: "es",
  Italian: "it",
  Portuguese: "pt",
  Dutch: "nl",
};

/** A text's language as the figure reader takes it, from the name `detectLanguage` gives it (src/core/documents/textLanguage). */
export function figureLanguageTag(name: string | null): string | null {
  return name === null ? null : (LANGUAGE_TAGS[name] ?? null);
}

/**
 * What a Document's own text settles for reading its figures: the
 * separators its numbers use, and what its "¥" stands for when only yuan
 * or only yen are named in it. Read the whole Document, not one Passage:
 * a Passage alone may hold no number that tells.
 */
export function figureContextOf(text: string, language?: string | null): FigureContext {
  return figureContextOfFacts([figureFactsOf(text, language ?? null)], language ?? null);
}

/**
 * What one part of a Document tells of how the whole writes its figures. The parts' facts add
 * up to the whole's, as their lines do: a telling number, a currency's name or a statement
 * never runs across a line break.
 */
export interface FigureFacts {
  evidence: Evidence;
  cny: boolean;
  jpy: boolean;
  accounts: boolean;
  negativeBrackets: boolean;
}

export function figureFactsOf(text: string, language: string | null): FigureFacts {
  const prepared = prepare(text);
  const { s } = prepared;
  return {
    evidence: evidenceIn(s),
    cny: CNY_WORDS.test(s),
    jpy: JPY_WORDS.test(s),
    accounts: writesAccounts(s, statementsIn(prepared, text, settle({ language }))),
    negativeBrackets: SAYS_BRACKETS_NEGATIVE.test(s),
  };
}

/** `figureContextOf` the text its parts make, one a line, from each part's facts. */
export function figureContextOfFacts(
  parts: readonly FigureFacts[],
  language: string | null,
): FigureContext {
  const evidence: Record<string, number> = {};
  for (const part of parts) {
    for (const [key, count] of Object.entries(part.evidence)) {
      evidence[key] = (evidence[key] ?? 0) + count;
    }
  }
  const cny = parts.some((part) => part.cny);
  const jpy = parts.some((part) => part.jpy);
  const tag = language ? tagOf(language) : null;
  // A Chinese text that names the yen leaves "¥" open, as a Japanese text naming yuan does.
  const disputed = (tag?.language === "zh" && jpy) || (tag?.language === "ja" && cny);
  const byLanguage = settle({ language }).yen;
  const [only] = byLanguage;
  const settled = byLanguage.length === 1 && (only === "CNY" || only === "JPY") ? only : null;
  return {
    language,
    separators: separatorsFrom(evidence),
    yen: disputed ? "unsure" : (settled ?? (cny && !jpy ? "CNY" : jpy && !cny ? "JPY" : null)),
    accounts: parts.some((part) => part.accounts),
    negativeBrackets: parts.some((part) => part.negativeBrackets),
  };
}

const BRACKETED_AMOUNT =
  /\(\s*(?:\p{Sc}|[A-Z]{3} ?)?\s*(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2})\s*\)/u;

const writesAccounts = (s: string, statements: readonly Statement[]): boolean =>
  BRACKETED_AMOUNT.test(s) ||
  statements.some((each) => each.exponent > 0 || each.unit.kind === "currency");

/** The language, script and region of a BCP 47 tag. */
function tagOf(language: string): {
  language: string;
  script: string | null;
  region: string | null;
} {
  const parts = language.split(/[-_]/);
  return {
    language: parts[0]?.toLowerCase() ?? "",
    script: parts.find((part, index) => index > 0 && /^[A-Za-z]{4}$/.test(part)) ?? null,
    region:
      parts.find((part, index) => index > 0 && /^[A-Za-z]{2}$/.test(part))?.toUpperCase() ?? null,
  };
}

/** Regions with their own dollar, written "$" in their own Documents. */
const DOLLARS: Readonly<Record<string, string>> = {
  AU: "AUD",
  CA: "CAD",
  NZ: "NZD",
  SG: "SGD",
  HK: "HKD",
  TW: "TWD",
};

/** Regions whose own Documents write "元" for their own currency. */
const YUAN: Readonly<Record<string, string>> = { TW: "TWD", HK: "HKD", MO: "MOP" };

/** What the context settles, once per text. */
interface Settled {
  /** The decimal mark, or null when the language and the Document's numbers don't say, or disagree. */
  decimal: "." | "," | null;
  /** Whether a plain space groups thousands. */
  spaceGroups: boolean;
  dollar: string;
  yuan: string;
  yen: string[];
  dates: boolean;
  chinese: boolean;
  accounts: boolean;
  negativeBrackets: boolean;
  /** A header of periods ("2025 2024", "本期 上期", "２０２５ ２０２４") applies to the text read, or stands above it on the page. */
  periodColumns: boolean;
  /** A stated unit or scale applies to the text read, in the text or in its header ("单位：万元"). */
  statedAmount: boolean;
  /** The page above a quote runs on past the 400 characters read with no blank line in them. */
  pageCut: boolean;
  /** Up to 400 characters of the Document before and after the text read, in NFKC, dashes as "-". */
  before: string;
  after: string;
}

/**
 * A year or a period that heads a column of figures: "2025", "FY2024", "2024年度", 本期, 上年, "prior
 * year". A Chinese character may stand right beside it, as the text read drops the space there.
 */
const PERIOD =
  /(?<![A-Za-z\d])(?:FY ?)?(?:19|20)\d{2}(?:年度?(?![A-Za-z])|(?![\p{L}\d]))|本期|上期|本年度?|上年度?|期末|期初|年初|年末|(?:current|prior|previous|this|last) (?:year|period)/giu;

/** Whether a line of `text` heads columns of periods: two periods and at most three other words, as in "2025 2024", "项目 本期 上期" or "Item 31 December 2025 31 December 2024". */
function headsPeriods(text: string): boolean {
  return text.split("\n").some((line) => {
    const periods = line.match(PERIOD)?.length ?? 0;
    return periods >= 2 && (line.replace(PERIOD, " ").match(/\p{L}+/gu)?.length ?? 0) <= 3;
  });
}

/** Where the first line of `prepared` that heads columns of periods ends, or Infinity. */
const periodHeaderEnds = new WeakMap<Prepared, number>();
function periodHeaderEnd(prepared: Prepared): number {
  let end = periodHeaderEnds.get(prepared);
  if (end === undefined) {
    end = Number.POSITIVE_INFINITY;
    const { s, lineStarts } = prepared;
    // A line break beside a Chinese character is gone from the text read; lineStarts keeps it.
    const starts = new Set([0, ...lineStarts]);
    for (let at = s.indexOf("\n"); at >= 0; at = s.indexOf("\n", at + 1)) starts.add(at + 1);
    const sorted = [...starts].sort((a, b) => a - b);
    for (const [index, start] of sorted.entries()) {
      const stop = sorted[index + 1] ?? s.length;
      if (headsPeriods(s.slice(start, stop))) {
        end = stop;
        break;
      }
    }
    periodHeaderEnds.set(prepared, end);
  }
  return end;
}

/**
 * Whether the page above a quote runs on past the 400 characters the reader looks at with no blank
 * line in them, so that the start of the amount's paragraph is out of sight. A short or numbered line
 * may carry a sentence on ("and was reported as", "as set out in cl." then "3. It was …"), so only a
 * blank line counts.
 */
function pageCut(before: string): boolean {
  if (before.length <= 400) return false;
  // The first piece may start mid-line and the last is the quote's own line: only those between count.
  const lines = before.slice(-400).split("\n").slice(1, -1);
  return !lines.some((line) => line.trim() === "");
}

/** The dashes the text read writes as "-" (./text), so the Document's text around it is read alike. */
const DASHES = /[\u2010-\u2015\u2212]/g;

function settle(context: FigureContext): Settled {
  const byLanguage = context.language ? languageSeparators(context.language) : null;
  const byText = context.separators ?? null;
  const agree = !byLanguage || !byText || byLanguage.decimal === byText.decimal;
  const separators = agree ? (byText ?? byLanguage) : null;
  const tag = context.language ? tagOf(context.language) : null;
  const region = tag?.region ?? "";
  // "¥" is yuan in mainland Chinese, yen in Japanese; elsewhere the Document's own words must say.
  const traditional = tag?.script === "Hant" || YUAN[region] !== undefined;
  let yen = ["CNY", "JPY"];
  if (context.yen === "CNY" || context.yen === "JPY") yen = [context.yen];
  else if (!context.yen && tag?.language === "zh" && !traditional) yen = ["CNY"];
  else if (!context.yen && tag?.language === "ja") yen = ["JPY"];
  return {
    decimal: separators?.decimal ?? null,
    spaceGroups: separators?.group === " ",
    dollar: DOLLARS[region] ?? "USD",
    yuan: YUAN[region] ?? "CNY",
    yen,
    dates: context.dates === true,
    chinese: tag?.language === "zh",
    accounts: context.accounts === true,
    negativeBrackets: context.negativeBrackets === true,
    pageCut: pageCut(context.around?.before ?? ""),
    periodColumns:
      context.headerRead?.periodColumns ??
      headsPeriods(`${context.header ?? ""}\n${context.around?.before ?? ""}`.normalize("NFKC")),
    statedAmount: false,
    before: (context.around?.before ?? "").slice(-400).normalize("NFKC").replace(DASHES, "-"),
    after: (context.around?.after ?? "").slice(0, 400).normalize("NFKC").replace(DASHES, "-"),
  };
}

// Words around a number -------------------------------------------------------

/** Chinese scale words after a number, longest first, with their power of ten. */
const CN_SCALES: Readonly<Record<string, number>> = {
  万亿: 12,
  千亿: 11,
  百亿: 10,
  十亿: 9,
  千万: 7,
  百万: 6,
  十万: 5,
  亿: 8,
  万: 4,
  千: 3,
  // Taiwan's statements write 仟 for 千: "新台幣仟元".
  仟: 3,
  百: 2,
};
const CN_SCALE_AFTER = /万亿|千亿|百亿|十亿|千万|百万|十万|亿|万|千(?![克米瓦帕焦卡])|仟|百(?!分)/y;

const EN_SCALES: Readonly<Record<string, number>> = {
  trillion: 12,
  tn: 12,
  trn: 12,
  billion: 9,
  bn: 9,
  bln: 9,
  b: 9,
  million: 6,
  mn: 6,
  mln: 6,
  mm: 6,
  m: 6,
  thousand: 3,
  k: 3,
  lakh: 5,
  crore: 7,
  // German reports: "1,2 Mio. €", "3,4 Mrd. €", "250 Tsd. €".
  "mio.": 6,
  mio: 6,
  "mrd.": 9,
  mrd: 9,
  "tsd.": 3,
  tsd: 3,
};
/** Scale words, with a space before the longer ones. Single letters only attached: "5 m" is often metres. */
const EN_SCALE_AFTER =
  /(?:[ \n]?(?:[Tt]rillion|[Bb]illion|[Mm]illion|[Tt]housand|[Ll]akh|[Cc]rore)s?|[ \u00a0]?(?:Mio|Mrd|Tsd)(?:\.|(?![A-Za-z]))|(?: ?(?:tn|trn|bn|Bn|BN|mn|Mn|MN|MM)|[kKmMbB])(?![A-Za-z0-9])|mm(?![A-Za-z0-9]))/y;

export const CURRENCY_ISO_CODES =
  "USD|CNY|RMB|Rmb|HKD|EUR|GBP|JPY|AUD|CAD|SGD|TWD|CHF|INR|KRW|NZD|MOP|BRL|RUB|SEK|NOK|DKK|ZAR|MXN|THB|MYR|IDR|PHP|VND|TRY|SAR|AED";

const CURRENCY_CODES: Readonly<Record<string, string>> = {
  US$: "USD",
  "U.S.$": "USD",
  HK$: "HKD",
  AU$: "AUD",
  A$: "AUD",
  CA$: "CAD",
  C$: "CAD",
  NZ$: "NZD",
  SG$: "SGD",
  S$: "SGD",
  NT$: "TWD",
  R$: "BRL",
  MX$: "MXN",
  "CN¥": "CNY",
  "JP¥": "JPY",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  "₩": "KRW",
  "₽": "RUB",
  "₺": "TRY",
  "฿": "THB",
  "₫": "VND",
  "₱": "PHP",
  RMB: "CNY",
  Rmb: "CNY",
  Rs: "INR",
  "Rs.": "INR",
  人民币: "CNY",
  美元: "USD",
  港币: "HKD",
  港元: "HKD",
  欧元: "EUR",
  日元: "JPY",
  円: "JPY",
  英镑: "GBP",
  新台币: "TWD",
  澳门元: "MOP",
  澳门币: "MOP",
  澳元: "AUD",
  加元: "CAD",
  韩元: "KRW",
  卢布: "RUB",
  新加坡元: "SGD",
  瑞士法郎: "CHF",
  "US dollars": "USD",
  "U.S. dollars": "USD",
  "US dollar": "USD",
  "Hong Kong dollars": "HKD",
  "HK dollars": "HKD",
  "Australian dollars": "AUD",
  "Canadian dollars": "CAD",
  "Singapore dollars": "SGD",
  euro: "EUR",
  euros: "EUR",
  yuan: "CNY",
  renminbi: "CNY",
  Renminbi: "CNY",
  yen: "JPY",
  sterling: "GBP",
  pounds: "GBP",
  "pounds sterling": "GBP",
  rupees: "INR",
  "Indian rupees": "INR",
  "United States dollars": "USD",
  "Swiss francs": "CHF",
};

// Every Chinese name the table gives a currency, longest first: "新台币54,000元" is in TWD (#1452).
const HAN_CURRENCIES = Object.keys(CURRENCY_CODES)
  .filter((word) => /^\p{Script=Han}{2,}$/u.test(word))
  .sort((a, b) => b.length - a.length)
  .join("|");
// "US $54m" is US$54m. "CA" and "NT" are also a US state and an Australian territory ("CA $54m"),
// and a lone letter an article ("A $54,000 fee"), so those take the "$" only joined.
const CURRENCY_TOKEN = new RegExp(
  `(?:(?<![A-Za-z])(?:(?:US|U\\.S\\.|HK|AU|NZ|SG|MX)[ \\u00a0]?|CA|NT|A|C|S|R)?\\$|CN¥|JP¥|[¥€£₹₩₽₺฿₫₱]|(?<![A-Za-z])(?:${CURRENCY_ISO_CODES}|Rs\\.?)|${HAN_CURRENCIES})`,
);
/** Currency signs before a number, and codes and names before it, with a space allowed. */
const CURRENCY_BEFORE = new RegExp(`${CURRENCY_TOKEN.source}[ \\u00a0]?$`);

// Contracts write "in Pounds Sterling" and "ALL AMOUNTS ARE IN US DOLLARS".
const NAMED_CODES = new Map(
  Object.entries(CURRENCY_CODES)
    .filter(([word]) => /^[a-z]/.test(word) || /^[A-Za-z.]+(?: [A-Za-z]+)+$/.test(word))
    .map(([word, code]) => [word.toLowerCase(), code]),
);

/** The currency a word after an amount names: "pounds" is GBP, "欧元" EUR; null for any other word. */
export function currencyNamed(word: string): string | null {
  return CURRENCY_CODES[word] ?? NAMED_CODES.get(word.toLowerCase()) ?? null;
}

const CN_CURRENCY_AFTER =
  /(?:新加坡元|瑞士法郎|新台币|澳门元|澳门币|人民币|美元|港元|港币|欧元|日元|英镑|澳元|加元|韩元|卢布|元|圆|円)(?:人民币)?/y;
const EN_CURRENCY_AFTER =
  / ?(?:U\.S\. dollars|US dollars?|Hong Kong dollars|HK dollars|Australian dollars|Canadian dollars|Singapore dollars|dollars|euros?|yuan|[Rr]enminbi|RMB|Rmb|yen|pounds sterling|sterling|rupees|USD|CNY|HKD|EUR|GBP|JPY|AUD|CAD|SGD|TWD|CHF|INR|KRW|NZD|MOP)(?![A-Za-z])/y;

/** A currency sign after the number, as many European Documents write it ("1.234 €"), unless it starts the next one. */
const SIGN_AFTER = / ?[€£¥$](?![A-Za-z0-9])(?! ?\d)/y;

const LEDGER_AFTER = / ?(?:CR|DR|Cr|Dr)(?![A-Za-z0-9])(?!\.? \p{Lu}\p{Ll})/uy;

const CURRENCY_ANYWHERE = new RegExp(
  [CURRENCY_TOKEN, CN_CURRENCY_AFTER, EN_CURRENCY_AFTER].map((each) => each.source).join("|"),
  "g",
);
const AMOUNT_ENDS = /[\d%亿万千]$|(?:\d|\b)(?:million|billion|trillion|thousand|bn|mn|[mkb])$/i;
// Longer than any end AMOUNT_ENDS matches (a digit and "thousand" is 9), with the character before
// it: tested on this many last characters, a long line's lead reads as it does whole.
const AMOUNT_END_REACH = 16;

// Longer than any currency word CURRENCY_ANYWHERE matches ("Australian dollars" with its space is
// 19) and the letter after it: a match that starts further back than this from where a line is cut
// is the same in the cut line as in the whole line.
const CURRENCY_REACH = 32;
const CURRENCY_AGAIN = new RegExp(CURRENCY_ANYWHERE.source, "g");

/**
 * The currencies the last currency word on `at`'s line before it names, when the words before
 * `at` end in an amount or in that word; null otherwise.
 */
function amountBefore(prepared: Prepared, at: number, settled: Settled): string[] | null {
  const { s } = prepared;
  const end = lineEnd(prepared, at);
  const line = lineEnding(prepared, end);
  let cut = at;
  while (cut > line.start && /\s/.test(s[cut - 1] as string)) cut--;
  const lead = s.slice(line.start, cut);
  if (!line.currencies) {
    const found = [...s.slice(line.start, end).matchAll(CURRENCY_ANYWHERE)];
    line.currencies = {
      starts: found.map((match) => match.index),
      words: found.map((match) => match[0]),
    };
    steps += end - line.start;
  }
  const { starts, words } = line.currencies;
  const same = countBefore(starts, lead.length - CURRENCY_REACH + 1);
  let last = same > 0 ? { at: starts[same - 1] as number, word: words[same - 1] as string } : null;
  // Only the last few characters before the cut can read otherwise, so only they are read again.
  const tail = CURRENCY_AGAIN;
  tail.lastIndex = Math.max(
    last ? last.at + last.word.length : 0,
    lead.length - CURRENCY_REACH + 1,
    0,
  );
  steps += lead.length - tail.lastIndex + 1;
  for (let match = tail.exec(lead); match; match = tail.exec(lead))
    last = { at: match.index, word: match[0] };
  if (
    !last ||
    !(AMOUNT_ENDS.test(lead.slice(-AMOUNT_END_REACH)) || last.at + last.word.length === lead.length)
  )
    return null;
  return currencyCodes(last.word, settled);
}

/**
 * One thing a row of amounts holds besides its figures: a space, a bracket, a sign, a currency, a
 * scale. At most one of them can start at any place, so the line is read once, from its end.
 */
const AMOUNT_PART =
  /[\s|.,;()（）%‰+\-–—−\d万亿千元圆\ue000]|\p{Sc}|(?:CR|DR|Cr|Dr)(?![A-Za-z])|(?:thousand|million|billion|trillion|tn|bn|mn|[kKmMbB])(?![A-Za-z])/uy;
const LABEL_START = /^(?:\p{Lu}|\p{Script=Han})/u;
const PROSE_START =
  /^(?:The|A|An|This|That|These|Those|Our|Its|Their|It|We|They|In|On|At|For|Of|To|By|With|As|If|When|While) /;
const LABEL_REFERENCE =
  /(?:(?<![A-Za-z])(?:[Pp]aragraphs?|[Pp]ara|[Ss]ections?|[Nn]otes?|[Pp]ages?|[Pp]art|[Cc]lause|[Aa]rticle)|第|[条款项章节页])$/;

const COUNT_LABEL =
  /(?:(?<![A-Za-z])(?:head ?count|employees?|staff|FTEs?|people)|人数|员工|人员|职工)$/i;

/** "Payments to employees", "Revenue per employee": the people are who the money is for, not what is counted. */
const MONEY_FOR_PEOPLE =
  /\b(?:of|to|for|from|per|by|with|among|between|towards?|against|owed|paid)\b|[给向每付欠借对为]/i;

/**
 * What the reader finds of a line once, however many figures the line holds, so a long line of
 * them costs no more than its length (#2510).
 */
interface Line {
  start: number;
  delimited?: boolean;
  /** Whether only amounts follow each place of the line to its end, from the line's start. */
  amountsOnly?: Uint8Array;
  /** Where a digit, a bracket or a currency sign first comes in the line, as a label stops. */
  labelEnd?: number;
  /** Where a digit, a "(" or a currency sign first comes in the line, as a count's label stops. */
  countLabelEnd?: number;
  /** Where each currency word CURRENCY_ANYWHERE finds in it starts, and the word. */
  currencies?: { starts: number[]; words: string[] };
  /** Where its brackets open and close, in order. */
  brackets?: { opens: number[]; closes: number[] };
  /** Whether its label, as long as it was read, makes the line prose. */
  prose: Map<number, boolean>;
}

function lineEnding(prepared: Prepared, end: number): Line {
  const known = prepared.lines.get(end);
  if (known) return known;
  const line: Line = { start: lineStart(prepared, end), prose: new Map() };
  prepared.lines.set(end, line);
  return line;
}

function firstIn(s: string, pattern: RegExp, from: number, to: number): number {
  steps += to - from;
  const found = pattern.exec(s.slice(from, to));
  return found ? from + found.index : to;
}

function amountsOnlyFrom(prepared: Prepared, to: number, end: number): boolean {
  const { s } = prepared;
  const line = lineEnding(prepared, end);
  if (!line.amountsOnly) {
    const amountsOnly = new Uint8Array(end - line.start + 1);
    amountsOnly[end - line.start] = 1;
    for (let at = end - 1; at >= line.start; at--) {
      AMOUNT_PART.lastIndex = at;
      const part = AMOUNT_PART.exec(s);
      const next = part && at + part[0].length <= end ? at + part[0].length : null;
      amountsOnly[at - line.start] = next === null ? 0 : (amountsOnly[next - line.start] as number);
    }
    steps += end - line.start;
    line.amountsOnly = amountsOnly;
  }
  return line.amountsOnly[to - line.start] === 1;
}

function namesCount(prepared: Prepared, at: number): boolean {
  const { s } = prepared;
  const end = lineEnd(prepared, at);
  const line = lineEnding(prepared, end);
  line.countLabelEnd ??= firstIn(s, /[\d(\p{Sc}]/u, line.start, end);
  const lead = s.slice(line.start, at);
  const label = s.slice(line.start, Math.min(at, line.countLabelEnd));
  return [label, lead].some((words) => {
    const end = words.slice(-100).replace(/[\s|]+$/, "");
    return COUNT_LABEL.test(end) && !MONEY_FOR_PEOPLE.test(end.replace(/\bnumbers? of\b/gi, ""));
  });
}

function delimitedBetween(prepared: Prepared, start: number, end: number): boolean {
  const { s, tabbed } = prepared;
  steps += end - start;
  let delimited = /[\t|]/.test(s.slice(start, end));
  for (let at = start + 1; !delimited && at <= end; at++) delimited = tabbed.has(at);
  return delimited;
}

function proseLabel(prepared: Prepared, start: number, end: number): boolean {
  const label = prepared.s.slice(start, end).replace(/^[\s|]+|[\s|]+$/g, "");
  steps += end - start;
  return (
    label === "" ||
    label.length > 60 ||
    !LABEL_START.test(label) ||
    PROSE_START.test(label) ||
    /[,，;；。]|\. /.test(label) ||
    LABEL_REFERENCE.test(label)
  );
}

function rowOf(prepared: Prepared, from: number, to: number): "table" | "statement" | null {
  const { s, tabbed } = prepared;
  steps++;
  const start = lineStart(prepared, from);
  const end = lineEnd(prepared, to);
  if (!amountsOnlyFrom(prepared, to, end)) return null;
  let cell = from;
  while (s[cell - 1] === " " && cell - 1 >= start) cell--;
  const startsCell =
    cell === start || s[cell - 1] === "\t" || s[cell - 1] === "|" || tabbed.has(cell);
  // A bracket that starts on an earlier line than it ends is read over all its lines, apart from
  // the line kept.
  const kept = lineEnding(prepared, end);
  const line: Line = kept.start === start ? kept : { start, prose: new Map() };
  line.delimited ??= delimitedBetween(prepared, start, end);
  if (startsCell && line.delimited) return "table";
  line.labelEnd ??= firstIn(s, /[\d(（\p{Sc}]/u, start, end);
  const labelEnd = Math.min(from, line.labelEnd);
  let prose = line.prose.get(labelEnd);
  if (prose === undefined) {
    prose = proseLabel(prepared, start, labelEnd);
    line.prose.set(labelEnd, prose);
  }
  return prose ? null : "statement";
}

/** Percentage points and basis points, checked before percent: "% points" isn't a percent. */
const POINTS_AFTER =
  /个百分点|百分点|个基点|基点|[ \n]?(?:percentage[ \n]points?|% ?points?|% ?pts|ppts?|pps?|p\.p\.|bps|bp|basis[ \n]points?)(?![A-Za-z])/y;
const PERCENT_AFTER = / ?(?:%|‰)|[ \n]?(?:per[ \n]cent|percent|pcts?)(?![A-Za-z])/y;
const TIMES_AFTER = /倍|[xX×](?![A-Za-z0-9])| times(?![A-Za-z])/y;
/** 成 as tenths ("三成" is 30%), but not where it starts a word ("3成本", "一成不变"). */
const TENTHS_AFTER =
  /成(?!本|为|功|长|交|立|员|果|熟|就|品|绩|效|都|型|分|批|套|年|人|色|全|形|事|名|不变)/y;
/** Points that may be percentage points or an index's or a score's. */
const LOOSE_POINTS_AFTER = /个点| (?:points?|pts?)(?![A-Za-z])/y;

/** Measures that make a lone Chinese numeral a quantity: "三吨" is 3 tonnes, while "三个" is "a few". */
const CN_MEASURES =
  "平方公里 平方米 立方米 千瓦时 兆瓦时 千克 公斤 公里 千米 千瓦 兆瓦 吉瓦 公顷 盎司 平米 吨 克 米 升 亩 桶".split(
    " ",
  );
/** Counting words: a figure's unit after a numeral of two characters or more ("十二家"), not after one. */
const CN_COUNTS =
  "人次 岁 度 户 人 名 家 个 辆 台 套 件 只 头 股 手 张 份 项 座 所 架 艘 部 位 款 条 片 块 箱 次 例 床 间 栋 单元 室 层 楼 章".split(
    " ",
  );
const CN_MEASURE_AFTER = new RegExp(CN_MEASURES.join("|"), "y");
// "所" counts schools ("3所学校"), but "表3所示" is "as table 3 shows".
const CN_COUNT_AFTER = new RegExp(CN_COUNTS.join("|").replace("所", "所(?![示述列载有以在])"), "y");
const EN_UNIT_AFTER =
  /[ \n]?(?:users?|customers?|clients?|subscribers?|members?|employees?|staff|people|persons?|patients?|students?|visitors?|households?|homes?|stores?|outlets?|branches|branch|restaurants?|vehicles?|cars?|units?|shares?|tonnes?|tons?|kt|Mt|kg|mg|lbs?|ounces?|oz|barrels?|bbl|boe|bcf|tcf|km\/h|km2|km|m2|m3|sq ft|square (?:feet|foot|metres?|meters?)|(?:kilo|centi|milli)?(?:metres?|meters?)|miles?|feet|foot|inches|mph|acres?|hectares?|(?:mega|kilo|giga)watt[- ]hours?|(?:mega|kilo|giga)watts?|MWh|GWh|kWh|TWh|MW|GW|kW|mAh|litres?|liters?|MtCO2e|ktCO2e|tCO2e|tCO2|°C|°F| t)(?![A-Za-z0-9])/y;

/** Written before a figure that is approximate or a bound; outside its characters. */
const APPROXIMATE_BEFORE =
  /(?:(?<![A-Za-z])(?:[Aa]bout|[Aa]pproximately|[Aa]pprox\.?|[Aa]round|[Rr]oughly|[Nn]early|[Aa]lmost|[Cc]lose to|[Ss]ome|[Cc]irca|[Cc]a?\.|[Oo]ver|[Mm]ore than|[Ll]ess than|[Ff]ewer than|[Uu]nder|[Uu]p to|[Aa]t least|[Aa]t most|[Ii]n excess of|[Uu]pwards of|[Jj]ust over|[Jj]ust under|[Bb]elow|[Aa]bove) ?|[~≈] ?|约为|约合|大约|大概|约|将近|接近|近|逾|超过|不超过|超|不到|不足|至少|最多)$/;
const APPROXIMATE_AFTER =
  /左右|上下|以上|以下|以内|有余|\+(?![\d])| or so(?![A-Za-z])|-odd(?![A-Za-z])/y;

/** A footnote mark stuck to a figure: "¹", "*", "†", "(a)", "[1]", "(1)". */
const FOOTNOTE_AFTER = new RegExp(
  `${FOOTNOTE_MARK_CHAR}+|\\*+(?![\\d])|[†‡]|\\([a-z]\\)|\\[(?:\\d{1,3}|[a-z])\\]|\\(\\d{1,2}\\)(?![\\d.,])`,
  "y",
);

/** Words before a number that make it a reference, an ordinal, a name or a vague count ("数十亿"), not a figure. */
const REFERENCE_BEFORE =
  /(?:(?<![A-Za-z])(?:p|pp|pages?|[Nn]otes?|[Ss]ections?|[Ss]ec|[Tt]ables?|[Ff]igures?|[Ff]ig|[Cc]hapters?|[Cc]h|[Ii]tems?|[Aa]rticles?|[Aa]rt|[Ee]xhibits?|[Aa]ppendix|[Ss]chedules?|IFRS|IAS|ISO|ASC|ASU|[Ll]evel|[Tt]ier|[Ss]cope|[Pp]hase|[Ss]tage|[Vv]ersion|[Ss]tep|[Rr]ule|[Pp]art|[Nn]o|[Nn]os|[Vv]ol|[Vv]olume|[Ii]ssue|[Cc]lause|[Pp]aragraph|[Pp]ara|[Ll]ine|[Rr]ow|[Cc]olumn|[Ss]lides?|S&P|FTSE|Russell|Nikkei|Fortune|Nasdaq|CSI|Top|[Bb]ullet)\.? ?|#|№|第|附注|沪深|中证|上证|深证|代码[:：]?|数|几|若干)$/;
/** "表3", "图1", "注2": references, unless a measure follows, as in "代表3名" (represents 3). */
const LOOSE_REFERENCE_BEFORE = /[表图注]$/;

// Dates, periods and statements ----------------------------------------------

const CN_NUMERAL_CHARS = "〇零一二三四五六七八九十两";
// A numeral matches from its first character only, so the date patterns read a long run of
// numerals once, not again from each of its characters (#2510).
const CNN = `(?<![${CN_NUMERAL_CHARS}])[${CN_NUMERAL_CHARS}]+`;
const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";

const NUMBER = "(?<!\\d)\\d+(?:\\.\\d+)?";
const YEARS = new RegExp(
  `(?:(?:${NUMBER}|${CNN}) ?[-~至到] ?)?(?:${NUMBER}|${CNN})年(?:度|代|底|初|末|中)?`,
  "g",
);
const PERIODS = new RegExp(
  `(?:(?:${NUMBER}|${CNN}) ?[-~至到] ?)?(?:${NUMBER}|${CNN}) ?(?:个月|个季度|季度|个?星期|周|天|小时|分钟|秒钟?|个工作日|工作日)`,
  "g",
);

/** When something happened, not how much: not figures unless asked for. */
const DATES: readonly RegExp[] = [
  /(?<![\d.])\d{4} ?[-/.] ?\d{1,2} ?[-/.] ?\d{1,2}(?![\d])/g,
  /(?<![\d.,])\d{1,2}[-/.]\d{1,2}[-/.](?:\d{4}|\d{2})(?![\d.])/g,
  /(?<![\d.,])(?:19|20)\d{2} ?[-/~至到] ?(?:(?:19|20)\d{2}|\d{1,2})(?![\d.,%])/g,
  /(?<![\d.,])\d{1,4}\/\d{1,4}(?![\d.,])/g,
  YEARS,
  new RegExp(
    `(?:\\d{1,2}|${CNN}) ?(?:[-~至到] ?(?:\\d{1,2}|${CNN}) ?)?月(?:份)?(?:(?:\\d{1,2}|${CNN})[日号])?`,
    "g",
  ),
  new RegExp(`(?:\\d{1,2}|${CNN})[日号](?![元圆])`, "g"),
  PERIODS,
  /(?:\d|[一二三四]) ?(?:[-~至到] ?(?:\d|[一二三四]) ?)?季度/g,
  // "7点30分", "11点至12点半", "凌晨5点"; "17点目标" (17 goals) has no time word.
  /(?<![\d.,])\d{1,2}[点时](?:\d{1,2}分|半|整|钟|前|后|之前|以后|左右|至|到|-)/g,
  new RegExp(
    `${CNN}点(?:${CNN}分|半|整|钟)|(?:早上|上午|中午|下午|晚上|凌晨|傍晚|次日|当日|每天|每日)(?:\\d{1,2}|${CNN})[点时]`,
    "g",
  ),
  /(?<![\w.])(?:\d+(?:\.\d+)? ?(?:-|~| to ) ?)?\d+(?:\.\d+)?[ -]?(?:years?|yrs?|months?|mos?|weeks?|wks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|quarters?)(?![A-Za-z])/gi,
  new RegExp(`${MONTH} \\d{1,2}(?:st|nd|rd|th)?(?:,? (?:19|20)\\d{2})?(?![\\d])`, "g"),
  new RegExp(`(?<![\\d.,])\\d{1,2}(?:st|nd|rd|th)? (?:of )?${MONTH}(?:,? (?:19|20)\\d{2})?`, "g"),
  new RegExp(`${MONTH}[ -]'?(?:\\d{4}|\\d{2})(?![\\d])`, "g"),
  /(?<![A-Za-z])(?:FY|CY|H[12]|Q[1-4]|[1-4]Q|[12]H) ?'?\d{2,4}(?![\d])/g,
  /(?<![A-Za-z])(?:Q[1-4]|H[12]|[1-4]Q|[12]H)(?![A-Za-z0-9])/g,
  /(?<![\w'])'\d{2}(?![\d])/g,
  /(?<![\d.:])\d{1,2}:\d{2}(?::\d{2})?(?![\d])(?: ?[ap]\.?m\.?)?/gi,
  /(?<![\d.])\d{1,2} ?[ap]\.?m\.?(?![a-z])/gi,
];

interface Span {
  from: number;
  to: number;
}

const FROM_RUN_STARTS = new Map(
  [YEARS, PERIODS].map((pattern) => [pattern, new RegExp(pattern.source, "y")]),
);

/** Where dates and periods are, in positions of the prepared text. */
function datesIn(s: string): Span[] {
  const spans: Span[] = [];
  for (const pattern of DATES) {
    const sticky = FROM_RUN_STARTS.get(pattern);
    if (sticky) for (const span of fromRunStarts(s, sticky)) spans.push(span);
    else
      for (const match of s.matchAll(pattern))
        spans.push({ from: match.index, to: match.index + match[0].length });
  }
  return spans;
}

const runKind = (char: string | undefined) =>
  isDigit(char)
    ? "digit"
    : char !== undefined && CN_NUMERAL_CHARS.includes(char)
      ? "numeral"
      : null;

/**
 * Where a pattern that opens with a number matches, tried from the first character of each run of
 * digits or of Chinese numerals only, so a long run is read once, not again from each of its
 * characters (#2510).
 */
function fromRunStarts(s: string, sticky: RegExp): Span[] {
  const spans: Span[] = [];
  for (let at = 0; at < s.length; ) {
    const kind = runKind(s[at]);
    if (kind === null) {
      at++;
      continue;
    }
    let end = at + 1;
    while (runKind(s[end]) === kind) end++;
    steps += end - at;
    sticky.lastIndex = at;
    const match = sticky.exec(s);
    if (match) {
      spans.push({ from: at, to: at + match[0].length });
      at += match[0].length;
    } else at = end;
  }
  return spans;
}

/** A stated unit in positions of the prepared text, its words as written. */
interface Statement extends Span {
  exponent: number;
  scaleWord: string | null;
  unit: FigureUnit;
  unplacedCurrency?: string;
}

/** A `header` read once, for a table's many cells to share (#2523). */
export interface HeaderRead {
  readonly statements: readonly HeaderStatement[];
  /** Whether a line of the header heads columns of periods (`headsPeriods`). */
  readonly periodColumns: boolean;
}

export type HeaderStatement = Statement;

/**
 * What a header (`FigureContext.header`) states, read with `context` once: the stated units its
 * text gives, and whether it heads columns of periods. Each cell of a table then reads it with
 * `headerRead` instead of reading the header again (#2523).
 */
export function readHeader(text: string, context: FigureContext = {}): HeaderRead {
  const ofHeader = { ...context, header: null, headerRead: null };
  const settled = settle({ ...context, header: text, headerRead: null });
  return {
    statements: headerStatements(text, ofHeader, settled),
    periodColumns: settled.periodColumns,
  };
}

const CN_UNIT_WORDS = `${HAN_CURRENCIES}|元`;
const CN_MEASURE_WORDS =
  "平方公里|平方米|立方米|公里|公顷|千瓦时|兆瓦时|千瓦|兆瓦|桶|盎司|千克|公斤|标准箱|吨";
const CN_PER_TIME = "(?:[/／][日天月年])";
const CN_STATED_SCALES = "十亿|亿|千万|百万|万|千|仟";
// Outside a heading, "十亿元" is a figure: 十 is a numeral.
const CN_SCALES_AFTER_WORDS = "亿|千万|百万|万|千|仟";
// "伍拾肆万捌仟元" is a figure in financial capitals, not a statement of 仟元; a "万元户" is a
// well-off household.
const BEFORE_CN_SCALE = `${CN_NUMERAL_CHARS}零壹贰叁肆伍陆柒捌玖拾佰\\d.,百千仟万亿`;
const STATED_CURRENCY =
  "US\\$|HK\\$|A\\$|C\\$|S\\$|NT\\$|\\$|€|£|¥|₹|Rs\\.?|USD|RMB|CNY|HKD|EUR|GBP|JPY|AUD|CAD|SGD|TWD|CHF|INR";
// Where a statement written in a short token ("$m", "'000s") ends: the end of its line, cell or
// bracket, or the start of an exception that leaves part of it out ("£m except the notes").
// "USD B Acc" is a share class, "USD M&A" a business and "1,000s of users" a count.
const ENDS_STATEMENT =
  "(?=[ \\u00a0]*(?:$|[\\n\\t)）|,;:]|\\.(?!\\d)|(?:except|unless|save|other[ \\u00a0]+than)\\b))";
const WORD_CURRENCIES =
  "U\\.S\\. dollars|US dollars|Hong Kong dollars|HK dollars|Australian dollars|Canadian dollars|Singapore dollars|dollars|euros?|yuan|[Rr]enminbi|yen|pounds sterling|pounds|sterling";
// A scale heads a measure or a currency: "million tonnes", "million US dollars".
const STATED_UNIT_WORDS =
  "(?:tonnes?|tons?|barrels?|boe|ounces?|oz|shares?|units?|(?:square|cubic)[ \\u00a0](?:metres?|meters?|feet|foot)|sq\\.?[ \\u00a0]?(?:m|ft)|litres?|liters?|gallons?|dollars?|US[ \\u00a0]dollars?|U\\.S\\.[ \\u00a0]dollars?|Hong[ \\u00a0]Kong[ \\u00a0]dollars?|HK[ \\u00a0]dollars?|euros?|pounds?(?:[ \\u00a0]sterling)?|sterling|yuan|[Rr]enminbi|yen)";
const PER_TIME = "(?:[ \\u00a0]per[ \\u00a0][A-Za-z]+|[ \\u00a0]?/[ \\u00a0]?[A-Za-z]+)";
// What "in thousands of …" counts when it names no currency: "tonnes", "barrels of oil equivalent".
const COUNTED_WORDS = `[A-Za-z][A-Za-z²³-]*(?:[ \\u00a0][A-Za-z][A-Za-z²³-]*){0,5}${PER_TIME}?`;
// A currency's unit: "of New Taiwan dollars" and "of Brazilian reais" name money though the reader
// doesn't know the name before it (#2365).
const CURRENCY_NOUNS =
  "dollars?|euros?|yen|yuan|renminbi|won|pesos?|reais|reals|kronor|kroner|krona|krone|kronur|rupees?|rupiah|ringgits?|baht|liras?|lire|rand|riyals?|rials?|dirhams?|dinars?|shekels?|zlotys?|francs?|rubles?|roubles?|pounds?|dong|naira|cedis?|shillings?|taka|tenge|hryvnias?|forints?|korunas?|lei|leva|kunas?|soles|bolivianos?|colones|quetzales|lempiras?|patacas?";
// A country's name before a currency's unit is capitalized ("Korean won", "New Taiwan dollars");
// "contracts won" and "units and dollars" count something.
const NAMED_MONEY = /^(?:\p{Lu}\S*[ \u00a0]+){0,3}\S+$/u;
const STATEMENTS: readonly RegExp[] = [
  new RegExp(
    `(?:金额|货币|数量)?单位[:：]?(?<before>${HAN_CURRENCIES})?(?<scale>万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千|仟|百)?(?<unit>${CN_UNIT_WORDS}|吨|股|人次|人|户|家|个|%|辆|台|套)?`,
    "dg",
  ),
  // "单位：万平方米", "单位：万桶/日": a scale of any measure the line above doesn't name, so it is
  // read as that measure's and never as a plain scale an amount could take (#2365). A PDF joins
  // a CJK line to the next ("单位：万平方米收入"), so the common measures are known by name, and any
  // other only where its word ends.
  new RegExp(
    `(?:金额|货币|数量)?单位[:：](?<scale>万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千|仟|百)(?<unit>(?:(?:${CN_MEASURE_WORDS})${CN_PER_TIME}?|(?!${CN_UNIT_WORDS}|[万亿千仟百十])[\\u4e00-\\u9fff]{1,4}${CN_PER_TIME}?(?![\\u4e00-\\u9fff])))`,
    "dg",
  ),
  new RegExp(`币种[:：]?(?<before>${HAN_CURRENCIES})`, "dg"),
  new RegExp(
    `[(（](?<before>${HAN_CURRENCIES}|RMB|USD|HK\\$)?(?<scale>${CN_STATED_SCALES})?(?<unit>${CN_UNIT_WORDS}|股|%)[)）]`,
    "dg",
  ),
  // A column head's "金额（万）" or "（港币百万）"; "3（万）" is a figure.
  new RegExp(`(?<!\\d)[(（](?<before>${HAN_CURRENCIES})?(?<scale>${CN_STATED_SCALES})[)）]`, "dg"),
  // A column head's "（人民币，百万）": a comma stands between its currency and scale.
  new RegExp(
    `(?<!\\d)[(（][ \\u00a0]*(?<before>${HAN_CURRENCIES})[，,;；、][ \\u00a0]*(?<scale>${CN_STATED_SCALES})(?<unit>${CN_UNIT_WORDS})?[ \\u00a0]*[)）]`,
    "dgu",
  ),
  // A bracket that states a unit with its scale: "（以千元列示）", "（港币千元）",
  // "（以港幣仟元列示）". A shop or household name ("（千元店业绩）", "（万元户调查）") is not one.
  new RegExp(
    `[(（][ \\u00a0]*(?:以[ \\u00a0]*)?(?<before>${HAN_CURRENCIES})?[ \\u00a0]*(?<scale>${CN_STATED_SCALES})(?<unit>元)[ \\u00a0]*(?:列示|计|为|為)?[ \\u00a0]*[)）]`,
    "dgu",
  ),
  // A bracket whose unit is prefixed: "（单位：千元）", "（金额单位：人民币千元）".
  new RegExp(
    `[(（][ \\u00a0]*(?:金额|金額|货币|貨幣|数量|數量)?[ \\u00a0]*(?:单位|單位)[ \\u00a0]*[:：][ \\u00a0]*(?<before>${HAN_CURRENCIES})?[ \\u00a0]*(?<scale>${CN_STATED_SCALES})[ \\u00a0]*(?<unit>元)?[ \\u00a0]*[)）]`,
    "dgu",
  ),
  // "以千元列示", "以港币千元计": a scale and 元 the line says its figures are shown in; "所以千元"
  // is not a statement.
  new RegExp(
    `(?<!所)以(?<before>${HAN_CURRENCIES})?(?<scale>${CN_STATED_SCALES})(?<unit>元)(?:列示|计|为单位)?(?![\\p{Script=Han}])`,
    "dgu",
  ),
  new RegExp(
    `(?<![${BEFORE_CN_SCALE}])(?<before>${HAN_CURRENCIES}|RMB)?(?<scale>${CN_SCALES_AFTER_WORDS})(?<unit>${CN_UNIT_WORDS})(?![户\\p{Script=Han}])`,
    "dgu",
  ),
  // "港币百万" with no 元 after it; "人民币千万不要" goes on in a sentence.
  new RegExp(
    `(?<![${BEFORE_CN_SCALE}])(?<before>${HAN_CURRENCIES})(?<scale>${CN_SCALES_AFTER_WORDS})(?=$|[\\s)）|,，;；。:：]|计|列)`,
    "dg",
  ),
  // "in thousands of US dollars" states a currency; "of Japanese yen" money in the currency its
  // name or the figure's own sign gives; any other "of" a measure ("in thousands of tonnes", "In
  // millions of barrels"), which is never a plain scale an amount could take (#2365).
  new RegExp(
    `(?<![A-Za-z])in (?<scale>thousands|millions|billions)(?: of (?:(?<cur>U\\.?S\\.? dollars|US dollars|Hong Kong dollars|HK dollars|dollars|euros|[Rr]enminbi|RMB|yuan|pounds sterling|pounds|yen)(?![A-Za-z])|(?<money>(?:[A-Za-z][A-Za-z.'-]*[ \\u00a0]){0,3}(?:${CURRENCY_NOUNS}))${ENDS_STATEMENT}|(?<unit>${COUNTED_WORDS})${ENDS_STATEMENT}))?(?![A-Za-z])`,
    "dgi",
  ),
  new RegExp(
    `(?<![\\dA-Za-z.,])(?<cur>${STATED_CURRENCY})[ \\u00a0]?(?:in )?(?<scale>'?000(?:'?s)?|thousands?|millions?|billions?|lakhs?|crores?|Mio\\.?|Mrd\\.?|Tsd\\.?)(?![A-Za-z0-9])(?![ \\u00a0]?[\\d(-])(?![.,]\\d)`,
    "dg",
  ),
  new RegExp(
    `(?<![\\dA-Za-z.,])(?<cur>${STATED_CURRENCY})(?<scale>MM|mm|mn|Mn|MN|bn|Bn|BN|m|M|k|K|b|B)${ENDS_STATEMENT}`,
    "dg",
  ),
  // Apart from its currency, a capital letter alone is as often a share class ("USD B", "Fund (EUR
  // M)") as a scale: it is left unsettled.
  new RegExp(
    `(?<![\\dA-Za-z.,])(?<cur>${STATED_CURRENCY})[ \\u00a0](?:in )?(?<scale>MM|mm|mn|Mn|MN|bn|Bn|BN|m|k|b)${ENDS_STATEMENT}`,
    "dg",
  ),
  // German reports' "TEUR", "T€", "kEUR", "k€", "MEUR" and "Mio. €"; "1,2 M€" is a figure, and
  // "Series M USD" a name.
  /(?<![A-Za-z])(?<![\d.,][ \u00a0]?)(?<scale>Mio\.|Mrd\.|Tsd\.)[ \u00a0]?(?<cur>EUR|€|CHF|USD|GBP|£|\$)(?![A-Za-z0-9])(?![ \u00a0]?[\d(-])/dg,
  /(?<![\dA-Za-z.,])(?<![\d.,][ \u00a0])(?<scale>k|K|M)(?<cur>EUR|€|CHF|USD|GBP|£|\$)(?![A-Za-z0-9])(?![ \u00a0]?[\d(-])/dg,
  // "TUSD" is as often a token's name as thousands of dollars: it is left unsettled.
  /(?<![\dA-Za-z.,])(?<scale>T)(?<cur>EUR|€|CHF)(?![A-Za-z0-9])(?![ \u00a0]?[\d(-])/dg,
  // "'000" and "000s" heading a column or ending "Figures in"; "Vintage 000s" and "Thousands of
  // 000s of users" go on as words. A bare "(000)" or "in 000" is left unsettled ("Call (000)").
  new RegExp(
    `(?:(?<=(?:^|[\\n\\t(（|])[ \\u00a0]*)|(?<=(?<![A-Za-z])in[ \\u00a0]))(?<scale>'000(?:'?s)?|000'?s)${ENDS_STATEMENT}`,
    "dg",
  ),
  /[(（][ \u00a0]?in[ \u00a0](?<scale>000)[ \u00a0]?[)）]/dg,
  /[(（][ \u00a0]?(?<scale>'?000(?:'?s)?)[ \u00a0]omitted[ \u00a0]?[)）]/dg,
  /(?<![\dA-Za-z.,'])(?<scale>'?000(?:'?s)?)[ \u00a0]omitted(?![A-Za-z])/dg,
  /[(（][ \u00a0]?(?<cur>US\$|HK\$|A\$|C\$|S\$|NT\$|\$|€|£|¥|USD|RMB|CNY|HKD|EUR|GBP|JPY|AUD|CAD|SGD|TWD|CHF)[ \u00a0]?[)）]/dg,
  // A bracket's currency with the scale its tail states: "(in dollars, in thousands)",
  // "(in HK$, figures in millions)", "(in £, '000)". A clause naming anything else
  // ("options in thousands") or a second scale leaves the bracket unread (#2365).
  new RegExp(
    `[(（][ \\u00a0]*(?:in[ \\u00a0]+)?(?<cur>${STATED_CURRENCY}|${WORD_CURRENCIES})[ \\u00a0]*[,;，；、][ \\u00a0]*(?:in[ \\u00a0]+)?(?:(?:all[ \\u00a0]+)?(?:amounts?|figures?|sums?|values?)[ \\u00a0]+(?:are[ \\u00a0]+)?in[ \\u00a0]+)?(?<scale>'?000(?:'?s)?|000s|thousands?|millions?|billions?|trillions?|Mio\\.?|Mrd\\.?|Tsd\\.?)(?![A-Za-z0-9])[ \\u00a0]*[)）]`,
    "dgi",
  ),
  /[(（][ \u00a0]?in[ \u00a0]+(?<cur>US\$|HK\$|A\$|C\$|S\$|NT\$|\$|€|£|¥|USD|RMB|CNY|HKD|EUR|GBP|JPY|AUD|CAD|SGD|TWD|CHF)[^()（）\n]{0,40}[)）]/dg,
  /[(（][ \u00a0]?(?<cur>U\.S\. dollars|US dollars|Hong Kong dollars|HK dollars|Australian dollars|Canadian dollars|Singapore dollars|dollars|euros?|yuan|[Rr]enminbi|yen|pounds sterling|pounds|sterling)[ \u00a0]?[)）]/dgi,
  /[(（][ \u00a0]?in[ \u00a0]+(?<cur>U\.S\. dollars|US dollars|Hong Kong dollars|HK dollars|Australian dollars|Canadian dollars|Singapore dollars|dollars|euros?|yuan|[Rr]enminbi|yen|pounds sterling|pounds|sterling)[^()（）\n]{0,40}[)）]/dgi,
  // A heading's "Unit: million tonnes", "(thousand tonnes)" or a row's "thousand tonnes" cell; in a
  // sentence, "78 million tonnes" is a figure and "a million people" states nothing.
  new RegExp(
    `(?<=(?:^|[\\n\\t(（|]|\\bunits?[ \\u00a0]?[:：])[ \\u00a0]*)(?<scale>thousands?|millions?|billions?)(?:[ \\u00a0]of)?[ \\u00a0](?<unit>${STATED_UNIT_WORDS}${PER_TIME}?)(?=[ \\u00a0]*(?:$|[\\n\\t)）|]))`,
    "dgi",
  ),
  // A scale word alone states one only in a bracket, a cell or after "Unit:": a line of its own may
  // be a wrapped "£19.8⏎million".
  /(?<=(?:[\t(（|]|\bunits?[ \u00a0]?[:：])[ \u00a0]*)(?<scale>thousands?|millions?|billions?)(?=[ \u00a0]*(?:$|[\n\t)）|]))/dgi,
  /[(（]%[)）]|(?<![A-Za-z])in (?:%|per cent|percent)(?![A-Za-z])/dg,
  // A row head's "Loans (bn)"; a bracketed "(m)" may be metres and is left alone.
  /[(（][ \u00a0]?(?<scale>[Bb]n|[Bb]ln|[Mm]n|[Mm]ln)[ \u00a0]?[)）]/dg,
];

/** The power of ten a scale word multiplies by: 8 for "亿", 6 for "million" or "m"; 0 for a word that isn't one. */
export function scaleExponent(word: string): number {
  const lower = word.toLowerCase().replace(/['’]/g, "").replace(/s$/, "");
  if (CN_SCALES[word] !== undefined) return CN_SCALES[word];
  if (lower === "000") return 3;
  return EN_SCALES[lower] ?? 0;
}

/** The unit a currency or unit word names, with the context's "$", "元" and "¥". */
function currencyCodes(word: string, settled: Settled): string[] {
  const trimmed = word.trim().replace(/(?<=\S)[ \u00a0](?=\$$)/, "");
  if (trimmed === "$" || trimmed.toLowerCase() === "dollars") return [settled.dollar];
  if (trimmed === "元" || trimmed === "圆") return [settled.yuan];
  if (trimmed === "¥") return settled.yen;
  const code = CURRENCY_CODES[trimmed] ?? NAMED_CODES.get(trimmed.toLowerCase());
  if (code) return [code];
  return /^[A-Z]{3}$/.test(trimmed) ? [trimmed] : [];
}

/** The bracket `from`–`to` sits in, with its opening position and content; null when it is on no one line. */
function bracketAround(
  prepared: Prepared,
  from: number,
  to: number,
): { at: number; content: string } | null {
  const end = lineEnd(prepared, from);
  if (to > end) return null;
  const line = lineEnding(prepared, end);
  if (!line.brackets) {
    const opens: number[] = [];
    const closes: number[] = [];
    for (let at = line.start; at < end; at++) {
      const char = prepared.s[at];
      if (char === "(" || char === "（") opens.push(at);
      else if (char === ")" || char === "）") closes.push(at);
    }
    steps += end - line.start;
    line.brackets = { opens, closes };
  }
  steps++;
  const { opens, closes } = line.brackets;
  const open = opens[countBefore(opens, from + 1) - 1];
  const close = closes[countBefore(closes, to - 1)];
  return open === undefined || close === undefined
    ? null
    : { at: open, content: prepared.s.slice(open + 1, close) };
}

/** The currencies a bracket names, as codes: "(in £ and $ thousands)" names two. */
function bracketCurrencies(content: string, settled: Settled): Set<string> {
  const codes = new Set<string>();
  const normal = content.normalize("NFKC");
  for (const match of normal.matchAll(CURRENCY_ANYWHERE)) {
    // "仟元", "万元": 元 after a scale names the scale's unit, not a second currency.
    if (/^[元圆]$/.test(match[0]) && /(?:千|仟|万|亿|百)$/.test(normal.slice(0, match.index)))
      continue;
    for (const code of currencyCodes(match[0], settled)) codes.add(code);
  }
  return codes;
}

// A bracket states a currency alone unless its own tail states a scale before an exception;
// "(in $, except share counts in thousands)" states dollars, and "(in £, thousands)" both (#2365).
const BRACKET_EXCEPTION =
  /\b(?:except|unless|save|other[ \u00a0]+than|excluding)\b|除[^()（）\n]{0,12}外/i;
// The clause itself, to the next comma or bracket: "except share counts in thousands".
const EXCEPTION_CLAUSE =
  /\b(?:except|unless|save|other[ \u00a0]+than|excluding)\b[^,;()（）\n]*|除[^，,。;；()（）\n]{0,20}外/gi;
const BRACKET_SCALE =
  /'?000(?:'?s)?|\b(?:thousands?|millions?|billions?|trillions?|lakhs?|crores?|mn|bn|mln|bln|MM|Mio|Mrd|Tsd)\b|\b[kKmMbB]\b/i;

/** Whether `at` in a bracket's content lies in the bracket's own exception clause. */
function insideException(content: string, at: number): boolean {
  for (const clause of content.matchAll(EXCEPTION_CLAUSE)) {
    const from = clause.index ?? 0;
    if (from <= at && at < from + clause[0].length) return true;
  }
  return false;
}

function scaleBeforeException(bracket: string): boolean {
  const scale = bracket.search(BRACKET_SCALE);
  const exception = bracket.search(BRACKET_EXCEPTION);
  return scale >= 0 && (exception < 0 || scale < exception);
}

function statementsIn(prepared: Prepared, text: string, settled: Settled): Statement[] {
  const { s } = prepared;
  const written = (at: [number, number] | undefined) =>
    at ? text.slice(prepared.from[at[0]], prepared.to[at[1] - 1]) : null;
  const found: Statement[] = [];
  for (const pattern of STATEMENTS) {
    for (const match of s.matchAll(pattern)) {
      const groups = match.groups ?? {};
      const at = match.indices?.groups ?? {};
      const scale = groups.scale ?? null;
      // "单位：港币千元" is in Hong Kong dollars: 元 only names the yuan when nothing comes before it.
      const generic = groups.unit !== undefined && /^[元圆]$/.test(groups.unit) && groups.before;
      const words =
        (generic ? groups.before : groups.unit) ??
        groups.before ??
        groups.cur ??
        groups.money ??
        null;
      let unit: FigureUnit = { kind: "plain" };
      let unplacedCurrency: string | null = null;
      if (match[0].includes("%") || /per ?cent/i.test(match[0])) unit = { kind: "percent" };
      else if (words) {
        const codes = currencyCodes(words, settled);
        const code = codes.length === 1 ? codes[0] : undefined;
        if (code) unit = { kind: "currency", code };
        // A name the reader can't place gives no code: never one the line and the figure don't state.
        else if (words === groups.money && NAMED_MONEY.test(words))
          unplacedCurrency = written(at.money) ?? words;
        else if (!/[$¥]/.test(words))
          unit = {
            kind: "other",
            word: written(at.unit ?? at.before ?? at.cur ?? at.money) ?? words,
          };
      }
      if (!scale && unit.kind === "plain") continue;
      // A bracket naming two currencies states neither for its amounts (#2365).
      const bracket = bracketAround(prepared, match.index, match.index + match[0].length);
      if (bracket !== null && bracketCurrencies(bracket.content, settled).size > 1) continue;
      // A scale written inside a bracket's exception clause states only what the clause excepts.
      if (
        bracket !== null &&
        scale !== null &&
        insideException(bracket.content, match.index - bracket.at - 1)
      )
        continue;
      if (
        scale === null &&
        unit.kind === "currency" &&
        bracket !== null &&
        scaleBeforeException(bracket.content)
      )
        continue;
      found.push({
        from: match.index,
        to: match.index + match[0].length,
        // "TEUR" is German for thousands of euros; a figure's own "T" is never read as a scale.
        exponent: scale === "T" ? 3 : scale ? scaleExponent(scale) : 0,
        scaleWord: written(at.scale),
        unit,
        ...(unplacedCurrency !== null && { unplacedCurrency }),
      });
    }
  }
  // "单位：万元" is one statement, though its "万元" alone would be one too. Those kept don't
  // overlap and come in order, so only the last can overlap the next.
  const kept: Statement[] = [];
  steps += found.length;
  for (const statement of found.sort((a, b) => a.from - b.from || b.to - a.to)) {
    const last = kept.at(-1);
    if (!last || last.to <= statement.from) kept.push(statement);
  }
  return kept;
}

const BEFORE_COUNTED_SCALE = /^\s*[(（]?\s*(?:(?:units?|单位)\s*[:：]\s*)?$/i;
const AFTER_COUNTED_SCALE = /^\s*[)）]?\s*$/;

// "100million USD" states a scale only as the whole header; in a sentence it is a figure.
function countedScales(text: string, prepared: Prepared, context: FigureContext): Statement[] {
  return readFigures(text, { ...context, header: null }).flatMap((figure) => {
    const count = figure.scale === 1 ? 0 : figure.value / figure.scale;
    const power = Math.round(Math.log10(count));
    if (power < 1 || 10 ** power !== count || figure.scaleWord === null) return [];
    const from = prepared.from.indexOf(figure.start);
    const to = prepared.to.lastIndexOf(figure.end) + 1;
    if (from < 0 || to <= 0) return [];
    if (!BEFORE_COUNTED_SCALE.test(prepared.s.slice(0, from))) return [];
    if (!AFTER_COUNTED_SCALE.test(prepared.s.slice(to))) return [];
    return [
      {
        from,
        to,
        exponent: Math.round(Math.log10(figure.scale)) + power,
        scaleWord: `${count}${figure.scaleWord}`,
        unit: figure.unit,
      },
    ];
  });
}

function headerStatements(text: string, context: FigureContext, settled: Settled): Statement[] {
  const prepared = prepare(text);
  return [...statementsIn(prepared, text, settled), ...countedScales(text, prepared, context)];
}

/**
 * Every scale or unit stated apart from the figures in `text`: what a header's "单位：万元" says.
 * With `asHeader`, the line is one the model gave as a header, so "100million USD" counts too.
 */
export function readStatedUnits(
  text: string,
  context: FigureContext = {},
  asHeader = false,
): StatedUnit[] {
  const prepared = prepare(text);
  const settled = settle(context);
  const statements = asHeader
    ? headerStatements(text, context, settled)
    : statementsIn(prepared, text, settled);
  return statedUnitsOf(prepared, text, statements);
}

// A line states a scale for the whole Document only when its whole text is an opening, an
// optional scope from a closed list, an optional verb, one unit and an optional conventional
// exception. Any other word between the opening and the unit names a part, so the line is not the
// Document's (#2365).
const EN_WHOLE_SUBJECT =
  "(?:(?:throughout|across)\\s+(?:this|the)\\s+(?:document|report)\\s+)?" +
  "(?:all\\s+(?:of\\s+the\\s+)?(?:amounts?|figures?|sums?|values?|numbers?)" +
  "|every\\s+(?:amount|figure|sum|value|number)" +
  "|(?:amounts?|figures?|sums?|values?|numbers?)\\s+(?:throughout|across)\\s+(?:this|the)\\s+(?:document|report|(?:consolidated\\s+)?financial\\s+statements?))";
const EN_WHOLE_SCOPE = [
  "(?:this|these|the)\\s+(?:consolidated\\s+)?financial\\s+statements?",
  "(?:this|the)\\s+(?:document|(?:annual\\s+)?report|annual\\s+report\\s+and\\s+accounts)",
  "(?:the\\s+)?group(?:['’]s\\s+(?:consolidated\\s+)?financial\\s+statements)?",
  "(?:the\\s+)?(?:financial\\s+|fiscal\\s+)?(?:year|period)\\s+ended\\s+(?:\\d{1,2}\\s+\\p{L}+\\s+\\d{4}|\\p{L}+\\s+\\d{4}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{4}|\\d{4}年\\d{1,2}月\\d{1,2}日|\\d{4}年|\\d{4})",
  "(?:US\\s+|U\\.S\\.\\s+|Hong\\s+Kong\\s+|HK\\s+|Australian\\s+|Canadian\\s+|Singapore\\s+)?dollars?",
  "pounds?(?:\\s+sterling)?|euros?|yuan|[Rr]enminbi|sterling|yen",
  "(?:USD|GBP|EUR|HKD|CNY|RMB|JPY|AUD|CAD|SGD|TWD|CHF|INR)",
  "(?:US|HK|A|C|S|NT)?\\$|€|£|¥|₹",
  "['’]?0{3}s?|thousands?|millions?|billions?|trillions?|lakhs?|crores?",
  "%",
].join("|");
const EN_WHOLE_BEFORE = new RegExp(
  "^\\s*" +
    EN_WHOLE_SUBJECT +
    "(?:\\s+(?:in|for|of|on|throughout)\\s+(?:" +
    EN_WHOLE_SCOPE +
    ")(?![A-Za-z0-9]))*" +
    "(?:\\s+(?:are|is|were|was|will|shall|should|must|may|can)\\b(?:\\s+(?:stated|shown|expressed|presented|given|set|quoted|reported|disclosed|prepared))?)?" +
    "(?:\\s+(?:in|of|for|at))?" +
    "(?:\\s*[(（])?\\s*$",
  "iu",
);
const EN_WHOLE_AFTER =
  /^\s*[.;,]?\s*(?:unless\s+(?:otherwise\s+)?(?:stated|noted|indicated|shown)|except\s+(?:where|as|if|unless)\s+(?:otherwise\s+)?(?:stated|noted|indicated|shown|disclosed)(?:\s+in\s+the\s+(?:notes?|financial\s+statements?))?|except\s+per[-\s]share\s+(?:data|amounts?))?[.;]?\s*$/i;
// A line may open with one of the conventional exceptions only; never any other clause.
const WHOLE_OPENING =
  /^\s*(?:unless\s+(?:otherwise\s+)?(?:stated|noted|indicated)|except\s+(?:where|as)\s+(?:otherwise\s+)?(?:stated|noted|indicated|shown)|除(?:另有|特别)(?:说明|注明)外)\s*[,，;；]?\s*/i;
const ZH_WHOLE_BEFORE =
  /^\s*(?:本文件|本报告|本報告|本招股(?:说明书|說明書)?|全文|(?:合并|合併)?财务报表|財務報表)?(?:中|内|內)?(?:所有|全部|一切)?(?:金额|金額|货币|貨幣)?(?:单位|單位)?(?:均|一律|都)?(?:以|为|為)?\s*(?:[(（])?\s*$/;
const ZH_WHOLE_SUBJECT = /所有|全部|一切|本文件|本报告|本報告|本招股|全文|财务报表|財務報表/;
const ZH_WHOLE_AFTER =
  /^\s*[)）]?\s*(?:列示|表示)?\s*(?:[。.]|(?:[，,;；]\s*(?:但|惟)?(?:附注|註釋|注释|财务报表)?(?:另有)?(?:说明|注明|指明|列明)者?除外))?\s*$/;

function wholeDocumentLine(line: string): boolean {
  const hadOpening = WHOLE_OPENING.test(line);
  const main = hadOpening ? line.replace(WHOLE_OPENING, "") : line;
  const statement = readStatedUnits(main).at(-1);
  if (!statement) return false;
  const before = main.slice(0, statement.start);
  const after = main.slice(statement.end);
  if (EN_WHOLE_BEFORE.test(before) && EN_WHOLE_AFTER.test(after)) return true;
  return (
    (hadOpening || ZH_WHOLE_SUBJECT.test(before)) &&
    ZH_WHOLE_BEFORE.test(before) &&
    ZH_WHOLE_AFTER.test(after)
  );
}

/**
 * Whether a scale line says, in its own words, that it holds for the whole Document ("All amounts
 * in £'000", "Figures throughout this document are in millions", "所有金额单位：千元",
 * "除另有说明外…"), rather than naming a note, section or table whose scale it is. Only such a
 * line may state the scale of a figure outside its own section (#2365).
 */
export function statesForWholeDocument(text: string): boolean {
  const line = text
    .normalize("NFKC")
    .replace(/\p{Script=Han}/gu, (char) => SIMPLIFIED.get(char) ?? char);
  return wholeDocumentLine(line);
}

// What may stand before a bare scale in its own clause: nothing, a framing word ("All amounts",
// "Figures are expressed"), a currency's name ("Dollars in thousands") or "Unit:".
const AMOUNT_FRAME_BEFORE = new RegExp(
  `^\\s*(?:(?:all|the)\\s+)*(?:(?:amounts?|figures?|sums?|values?|numbers?|totals?|${WORD_CURRENCIES})\\s+)?(?:(?:are|is|were|was)\\s+)?(?:(?:expressed|stated|shown|presented|reported|given)\\s+)?(?:units?\\s?[:：]\\s*)?$|^\\s*(?:所有|全部|一切)?(?:金额|金額|货币|貨幣)?(?:均|一律|都)?(?:以|为|為)?\\s*$`,
  "iu",
);

// The clauses a line that states amounts' scale may hold beside it: a declaration of their
// currency, a note on their audit, presentation, exceptions or rounding, or a period (#2365).
const CURRENCY_CLAUSE = `(?:(?:币种|幣種|货币|貨幣|货币单位|貨幣單位|报告货币|记账本位币|currency|reporting\\s+currency)\\s*[:：]?\\s*)?(?:in\\s+)?(?:${STATED_CURRENCY}|${WORD_CURRENCIES}|${HAN_CURRENCIES}|元)`;
const NOTE_CLAUSE =
  "(?:un)?audited|(?:as\\s+)?(?:restated|re-?presented|reclassified)|(?:un)?reviewed|未经审计|未經審計|经审计|經審計|已审计|未经审阅|(?:经|已)?重述|审计类型\\s*[:：]\\s*(?:未经审计|经审计|已审计|审计)|(?:except|excluding|other\\s+than|save)\\b.*|除.{0,16}外|.{0,16}除外|unless\\s+otherwise\\s+(?:stated|noted|indicated|specified|disclosed)|.*\\bround(?:ed|ing)\\b.*|四舍五入";
const CN_PERIOD_CLAUSE = "\\d{4}年(?:\\d{1,2}(?:[—\\-~至]\\d{1,2})?月(?:\\d{1,2}日)?)?(?:度|末)?";
const BESIDE_AMOUNT_SCALE = new RegExp(
  `^(?:${CURRENCY_CLAUSE}|${NOTE_CLAUSE}|${CN_PERIOD_CLAUSE}|[\\d.,%\\s-]+)$`,
  "iu",
);
// A PDF joins the next line to a CJK one: a clause it starts ("币种：人民币营业收入…") ends there.
const BESIDE_AMOUNT_SCALE_JOINED = new RegExp(
  `^(?:${CURRENCY_CLAUSE}|${NOTE_CLAUSE}|${CN_PERIOD_CLAUSE})(?=\\p{Script=Han})`,
  "iu",
);
const PERIOD_WORDS =
  /(?:(?:19|20)\d{2}|\b\d{1,2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4]|h[12]|fy|three|six|nine|twelve|months?|weeks?|years?|quarters?|periods?|half|ended|ending|as|at|of|for|the|fiscal|financial)\b\.?|[\s,–-])/giu;
const CLAUSE_SEPARATOR =
  /[,，;；、()（）[\]【】]|\s{2,}|(?<=[\p{Script=Han}：:）)])\s|\s(?=[\p{Script=Han}（(])/u;

/** Where the bracket open around `at` on its line starts, or null when none is. */
function openBracketBefore(text: string, from: number, at: number): number | null {
  let depth = 0;
  for (let index = at - 1; index >= from; index--) {
    const char = text[index];
    if (char === ")" || char === "）") depth++;
    else if (char === "(" || char === "（") {
      if (depth === 0) return index;
      depth--;
    }
  }
  return null;
}

/**
 * Whether `statement`, read from `text`, states the scale of amounts of money. Its line is read
 * as clauses, within its cell, and within its bracket when it is in one: the scale's own clause
 * holds the scale with its currency ("US$ thousands", "单位：万元"), or a bare scale with only a
 * framing word ("(in thousands)", "单位：千", "All amounts in thousands"); every other clause
 * declares the currency ("币种：人民币"), notes the figures' audit, presentation, exceptions or
 * rounding ("unaudited", "as restated", "除每股数据外"), names a period, or is another statement of
 * amounts' scale. Any other clause, whatever its words (a measure in any spelling, a rate, one the
 * reader doesn't read, or the next line a PDF joins to a CJK one), means the line states no scale
 * of amounts (#2365).
 */
export function statesAmountScale(text: string, statement: StatedUnit): boolean {
  return amountScaleIn(text, statement, true);
}

function amountScaleIn(text: string, statement: StatedUnit, withOthers: boolean): boolean {
  const { unit, chars } = statement;
  if (unit.kind !== "plain" && unit.kind !== "currency") return false;
  const simplified = chars.replace(/\p{Script=Han}/gu, (char) => SIMPLIFIED.get(char) ?? char);
  if (/^数量单位/.test(simplified)) return false;
  if (/^[(（]/.test(chars) && /[)）]$/.test(chars)) return true;
  const lineFrom = text.lastIndexOf("\n", statement.start - 1) + 1;
  const lineBreak = text.indexOf("\n", statement.end);
  const lineTo = lineBreak < 0 ? text.length : lineBreak;
  const cellFrom = Math.max(
    lineFrom,
    text.lastIndexOf("\t", statement.start - 1) + 1,
    text.lastIndexOf("|", statement.start - 1) + 1,
  );
  const cellBreak = text.slice(statement.end, lineTo).search(/[\t|]/);
  const cellTo = cellBreak < 0 ? lineTo : statement.end + cellBreak;
  const open = openBracketBefore(text, cellFrom, statement.start);
  const closeAt = open === null ? -1 : text.slice(statement.end, cellTo).search(/[)）]/);
  const scopeFrom = open === null ? cellFrom : open + 1;
  const scopeTo = closeAt < 0 ? cellTo : statement.end + closeAt;
  const after = text.slice(statement.end, scopeTo);
  // What follows a Han currency word with no space is the next line, which a PDF joined to it.
  if (
    unit.kind === "currency" &&
    open === null &&
    /\p{Script=Han}$/u.test(chars) &&
    /^\p{Script=Han}/u.test(after) &&
    !after.startsWith("每")
  )
    return true;
  // Another statement of amounts' scale is read from the clause alone, so a page a PDF joined
  // into one line isn't read again for each of its statements.
  const isOther = (clause: string, at: number): boolean =>
    readStatedUnits(clause).some((found) => {
      const other = { ...found, start: found.start + at, end: found.end + at };
      if (other.start === statement.start && other.end === statement.end) return false;
      // Judged one level deep: the other statement's own neighbours include this one.
      return withOthers
        ? amountScaleIn(text, other, false)
        : other.unit.kind === "plain" || other.unit.kind === "currency";
    });
  const besideOk = (part: string, at: number): boolean => {
    const separators = part.matchAll(new RegExp(CLAUSE_SEPARATOR.source, "gu"));
    let from = 0;
    for (;;) {
      const match = separators.next().value ?? null;
      const to = match ? match.index : part.length;
      const raw = part.slice(from, to);
      const start = at + from + (raw.length - raw.trimStart().length);
      const clause = raw.trim();
      if (clause !== "" && !BESIDE_AMOUNT_SCALE.test(clause) && !isPeriod(clause)) {
        if (BESIDE_AMOUNT_SCALE_JOINED.test(clause)) return true;
        if (!isOther(clause, start)) return false;
      }
      if (!match) return true;
      from = match.index + match[0].length;
    }
  };
  if (!besideOk(after, statement.end)) return false;
  if (/^(?:金额|货币)?单位|^以/.test(simplified)) return true;
  const before = text.slice(scopeFrom, statement.start);
  const parts = before.split(new RegExp(CLAUSE_SEPARATOR.source, "gu"));
  const own = parts.at(-1) ?? "";
  if (unit.kind === "plain" && !AMOUNT_FRAME_BEFORE.test(own)) return false;
  return besideOk(before.slice(0, before.length - own.length), scopeFrom);
}

/** Whether `clause` names a period: "Three months ended March 31", "2024 2023", "Q3 2024". */
function isPeriod(clause: string): boolean {
  if (!/(?:19|20)\d{2}|\b(?:ended|ending)\b/i.test(clause)) return false;
  return clause.replace(PERIOD_WORDS, "") === "";
}
function statedUnitsOf(prepared: Prepared, text: string, statements: Statement[]): StatedUnit[] {
  return statements.map((statement) => {
    const start = prepared.from[statement.from] as number;
    const end = prepared.to[statement.to - 1] as number;
    const except = statement.exponent === 0 ? null : exceptionOf(text, start, end);
    return {
      start,
      end,
      chars: text.slice(start, end),
      scale: 10 ** statement.exponent,
      scaleWord: statement.scaleWord,
      unit: statement.unit,
      ...(except && { except }),
      ...(statement.unplacedCurrency !== undefined && {
        unplacedCurrency: statement.unplacedCurrency,
      }),
    };
  });
}

const EXCEPT_AFTER =
  /^[^\n]{0,24}?except(?:[ \u00a0]for)?[ \u00a0](?<shares>(?:shares?|share counts?)[ \u00a0]and[ \u00a0])?per[- \u00a0]share/i;
const EXCEPT_NEAR = /除(?<shares>股数及|股份数及|股数和)?每股[^外\n]{0,6}外|每股[^除\n]{0,6}除外/;
const EXCEPT_NOTED =
  /^[^\n]{0,24}?(?:except[ \u00a0](?:where|as|when|if)|unless)[ \u00a0](?:otherwise[ \u00a0])?(?:noted|stated|indicated|shown|disclosed)|除(?:另有|特别)(?:说明|注明|列明|指明)外|另有(?:说明|注明)(?:者)?除外/i;

/** What a scale statement at `start`–`end` of `text` leaves out, as its line says: per-share figures, and share counts too. */
function exceptionOf(text: string, start: number, end: number): StatedUnit["except"] | null {
  const after = EXCEPT_AFTER.exec(text.slice(end, end + 80));
  const near = EXCEPT_NEAR.exec(text.slice(Math.max(0, start - 16), end + 16));
  const found = after ?? near;
  if (found) return found.groups?.shares ? "shares" : "per-share";
  const noted =
    EXCEPT_NOTED.exec(text.slice(end, end + 80)) ??
    EXCEPT_NOTED.exec(text.slice(Math.max(0, start - 16), end + 16));
  return noted ? "noted" : null;
}

/** A currency a line states on its own first figure, as written, as a code, and where that figure is. */
export interface StatedCurrency {
  chars: string;
  code: string;
  /** Where the figure starts in the line. */
  at: number;
}

/**
 * The currency a line writes on its own first figure ("Sale price £385,000.00"), as written and
 * as a code, when no other figure on the line writes another; null when none does, when the
 * reader leaves it two ways ("¥" outside a Chinese Document), or when the line writes two.
 * A first figure of 0 is a scale written with a currency ("All figures in £000"), not an amount.
 */
export function currencyOnItsFigure(
  text: string,
  context: FigureContext = {},
): StatedCurrency | null {
  const figures = readFigures(text, { ...context, header: null });
  const [first] = figures;
  if (first?.unit.kind !== "currency" || first.currency === null) return null;
  if (first.value === 0) return null;
  const codes = new Set(figures.flatMap(currenciesOf));
  return codes.size === 1
    ? { chars: first.currency, code: first.unit.code, at: first.start }
    : null;
}

// A currency a scale is written with: a sign, an ISO code or a Han currency word.
const CURRENCY_ANY = `(?:${CURRENCY_ISO_CODES}|CN¥|JP¥|US\\$|HK\\$|A\\$|C\\$|S\\$|NT\\$|\\$|[¥€£₹₩₽₺฿₫₱]|${HAN_CURRENCIES})`;
// The scale tokens a Document writes next to a currency when it scales its amounts.
const SCALE_NEAR_CURRENCY =
  "(?:Mio|Mrd|Tsd|thousands?|millions?|MM|mn|bn|k|K|m|M|B|T|['’]?0{3}s?|千|仟|万|萬|百万|百萬|亿|億)";
const CURRENCY_SCALE = new RegExp(
  `${CURRENCY_ANY}[ \\u00a0]?${SCALE_NEAR_CURRENCY}(?![A-Za-z])|(?<![A-Za-z])${SCALE_NEAR_CURRENCY}\\.?[ \\u00a0]?${CURRENCY_ANY}`,
  "i",
);

/**
 * A currency written next to a scale token ("£'000", "€ Mio.", "TEUR", "港幣百萬"), in either
 * order; null when none is. A Document that writes one, in a title, a column head or a running
 * header, scales its amounts somewhere, so a currency read from one line can't apply (#1001).
 */
export function currencyScaleMarker(text: string): string | null {
  return CURRENCY_SCALE.exec(prepare(text).s)?.[0] ?? null;
}

// "in MM" may be millions, millimetres or months, "in K" thousands or kelvin, "in M" millions or
// metres; "(K)" and "(M)" are a contract's clauses, and "(mm)" millimetres.
const UNSURE_SCALE =
  /(?<![A-Za-z])in[ \u00a0](?:MM|K|M)(?![A-Za-z0-9&.'-])|[(]MM[)]|(?<![A-Za-z])in[ \u00a0]000(?![\dA-Za-z.,'])|[(]000[)](?![ \u00a0-]?\d)/dg;
const SCALE_TOKEN =
  "(?:Mio|Mrd|Tsd|[Tt]housands?|[Mm]illions?|[Bb]illions?|MM|mm|mn|Mn|bn|Bn|BN|k|K|m|M|b|B|T|'?000s?|千|仟|万|百万|亿)";
const CURRENCY_SIGN_OR_CODE = `(?:${CURRENCY_ISO_CODES}|CN¥|JP¥|US\\$|HK\\$|A\\$|C\\$|S\\$|NT\\$)`;
const CURRENCY_WORD = `(?:(?<![A-Za-z])${CURRENCY_SIGN_OR_CODE}|\\$|[¥€£₹₩₽₺฿₫₱]|${HAN_CURRENCIES})`;
// Joined to the scale before it, as in "TUSD".
const CURRENCY_JOINED = `(?:${CURRENCY_SIGN_OR_CODE}|\\$|[¥€£₹₩₽₺฿₫₱]|${HAN_CURRENCIES})`;
const CURRENCY_NEXT_TO_SCALE = new RegExp(
  `${CURRENCY_WORD}[ \\u00a0]?${SCALE_TOKEN}(?![A-Za-z0-9\\u4e00-\\u9fff&])(?![ \\u00a0][A-Za-z&])|(?<![A-Za-z])${SCALE_TOKEN}\\.?${CURRENCY_JOINED}(?![A-Za-z])|(?<![A-Za-z][ \\u00a0])(?<![A-Za-z])${SCALE_TOKEN}\\.?[ \\u00a0]${CURRENCY_WORD}(?![A-Za-z])`,
  "dg",
);
const BEFORE_NUMBER = new RegExp(
  `(?:\\d[.,' \\u00a0]?|[${CN_NUMERAL_CHARS}零壹贰叁肆伍陆柒捌玖拾佰])$`,
);

/**
 * The scale forms `text` writes that `readStatedUnits` can't settle, as written, in order: "in
 * MM", which may be millions or millimetres, or a currency next to a scale token it doesn't know
 * ("$T"). A number under one can't be calculated without guessing its scale (#2365).
 */
export function unsettledScales(text: string, context: FigureContext = {}): string[] {
  const prepared = prepare(text);
  return unsettledIn(prepared, text, statementsIn(prepared, text, settle(context)));
}

function unsettledIn(prepared: Prepared, text: string, settled: readonly Statement[]): string[] {
  const { s } = prepared;
  const found: { from: number; chars: string }[] = [];
  for (const pattern of [UNSURE_SCALE, CURRENCY_NEXT_TO_SCALE]) {
    for (const match of s.matchAll(pattern)) {
      const from = match.index;
      const to = from + match[0].length;
      if (settled.some((each) => each.from < to && from < each.to)) continue;
      if (BEFORE_NUMBER.test(s.slice(Math.max(0, from - 2), from))) continue;
      if (/^[ \u00a0]?\d/.test(s.slice(to, to + 2))) continue;
      found.push({ from, chars: text.slice(prepared.from[from], prepared.to[to - 1]) });
    }
  }
  return found.sort((a, b) => a.from - b.from).map((each) => each.chars);
}

/** Every currency written next to a scale and every statement of a scale in Chinese holds one. */
const SCALE_HAN: ReadonlySet<string> = (() => {
  const chars = new Set(["千", "仟", "万", "萬", "百", "亿", "億"]);
  for (const word of HAN_CURRENCIES.split("|")) chars.add(word.slice(-1));
  for (const [traditional, simplified] of SIMPLIFIED) {
    if (chars.has(simplified)) chars.add(traditional);
  }
  return chars;
})();

/**
 * What a currency next to a scale or a statement of a scale holds in the text before it is
 * normalised, with the whitespace and the line-break hyphen the normaliser may take out around
 * it. A form `CURRENCY_SCALE` or `STATEMENTS` learns adds what each of its matches holds here,
 * or a page stating only that form is never read for it.
 */
const SCALE_HINT = [
  `[${[...SCALE_HAN].join("")}\\u2e80-\\u2eff]`,
  "[-\\u2010-\\u2015\\u2212]\\s*[\\n\\r\\v\\f\\u2028\\u2029]",
  `${CURRENCY_ANY}\\s*(?:in\\s+)?${SCALE_NEAR_CURRENCY}(?![A-Za-z])`,
  `(?<![A-Za-z])${SCALE_NEAR_CURRENCY}\\.?\\s*${CURRENCY_ANY}`,
  "illion|housand",
  // #2365's forms: zeros ("'000", "000s", "(000 omitted)", "in 000"), a row head's "(bn)", lakhs and
  // crores, and the forms that read two ways ("in MM", "in K", "(MM)").
  "[`']000|000'?s(?![A-Za-z])|000\\s+omitted|in\\s+(?:000|MM|K|M)(?![A-Za-z0-9])",
  "[(\uff08]\\s*(?:bn|bln|mn|mln|MM|000)\\s*[)\uff09]",
  "lakh|crore",
  // Every currency a statement is read with, so "Rs. 000" or "Rs m" is read too.
  `(?<![A-Za-z])(?:${STATED_CURRENCY})\\s*(?:in\\s+)?${SCALE_NEAR_CURRENCY}(?![A-Za-z])`,
].join("|");
const SCALE_HINT_IN = new RegExp(SCALE_HINT, "i");
// Where the normaliser reads a character as the same character, a hint is found in the text as
// written; anywhere else, only once the line is roughly normalised.
const HINT_OR_UNPLAIN = new RegExp(
  `(?<unplain>[^\\t\\n\\v\\f\\r\\x20-\\x5f\\x61-\\x7e])|${SCALE_HINT}`,
  "gi",
);
const INVISIBLE_CHARS = new RegExp(`[${[...INVISIBLE].join("")}]`, "g");
const QUOTE_CHARS = /[‘’‚‛′`]/g;

// The reader makes "ⁿ" or "ⓐ" a footnote mark, which NFKC makes a letter: a line holding one is
// read, since a letter beside "m USD" hides the scale the mark leaves standing.
const FOOTNOTE_MARK = new RegExp(`[${SUPERSCRIPT_CHARS}]`, "u");

const roughlyNormalised = (text: string): string =>
  text.normalize("NFKC").replace(INVISIBLE_CHARS, "").replace(QUOTE_CHARS, "'");

const isLineBreak = (code: number): boolean =>
  (code >= 0x0a && code <= 0x0d) || code === 0x2028 || code === 0x2029;
const isPrintableAscii = (code: number): boolean => code >= 0x21 && code <= 0x7e;
const SPACE = /\s/;
const MARK_CHAR = /\p{M}/u;

interface Run {
  start: number;
  end: number;
}

function spaceRun(text: string, at: number): Run {
  let start = at;
  while (start > 0 && SPACE.test(text.charAt(start - 1))) start--;
  let end = at;
  while (end < text.length && SPACE.test(text.charAt(end))) end++;
  return { start, end };
}

/**
 * Whether the normaliser makes `run` one line break whatever comes before or after it: it holds a
 * line break, between two plain ASCII characters that keep it (not a hyphen, which may join the
 * lines, nor one a mark follows). No statement crosses a line break, so the text on each side
 * reads alone exactly as it does in the whole.
 */
function cuts(text: string, run: Run): boolean {
  if (run.start === 0 || run.end >= text.length) return false;
  const before = text.charCodeAt(run.start - 1);
  if (!isPrintableAscii(before) || before === 0x2d) return false;
  if (!isPrintableAscii(text.charCodeAt(run.end))) return false;
  if (MARK_CHAR.test(text.charAt(run.end + 1))) return false;
  for (let at = run.start; at < run.end; at++) {
    if (isLineBreak(text.charCodeAt(at))) return true;
  }
  return false;
}

/** The line around `at` between two runs that cut; empty, at the run's end, when `at` is in one. */
function lineAround(text: string, at: number): Run {
  if (SPACE.test(text.charAt(at))) {
    const run = spaceRun(text, at);
    if (cuts(text, run)) return { start: run.end, end: run.end };
  }
  let start = 0;
  for (let index = at - 1; index >= 0; index--) {
    if (!isLineBreak(text.charCodeAt(index))) continue;
    const run = spaceRun(text, index);
    if (cuts(text, run)) {
      start = run.end;
      break;
    }
    index = run.start;
  }
  let end = text.length;
  for (let index = at; index < text.length; index++) {
    if (!isLineBreak(text.charCodeAt(index))) continue;
    const run = spaceRun(text, index);
    if (cuts(text, run)) {
      end = run.start;
      break;
    }
    index = run.end - 1;
  }
  return { start, end };
}

/** The lines of `text` that may state a scale, in order; the others can't. */
function* linesHintingScales(text: string): Generator<string> {
  let at = 0;
  while (at < text.length) {
    HINT_OR_UNPLAIN.lastIndex = at;
    const hint = HINT_OR_UNPLAIN.exec(text);
    if (!hint) return;
    const line = lineAround(text, hint.index);
    at = line.end;
    if (line.start === line.end) continue;
    const written = text.slice(line.start, line.end);
    if (
      hint.groups?.unplain === undefined ||
      FOOTNOTE_MARK.test(written) ||
      SCALE_HINT_IN.test(roughlyNormalised(written))
    ) {
      yield written;
    }
  }
}

/**
 * The scale a page states, for its scale marker: what `statedScale` gives, else the first form
 * that reads more than one way (`unsettledScales`); null when it states neither. Each line that
 * may state a scale is normalised once for both.
 */
export function pageScale(text: string, context: FigureContext = {}): string | null {
  const settled = settle(context);
  let stated: string | null = null;
  let unsettled: string | null = null;
  for (const line of linesHintingScales(text)) {
    const prepared = prepare(line);
    const marker = CURRENCY_SCALE.exec(prepared.s)?.[0];
    if (marker !== undefined) return marker;
    const statements = statementsIn(prepared, line, settled);
    stated ??=
      statedUnitsOf(prepared, line, statements).find((each) => each.scale !== 1)?.chars ?? null;
    unsettled ??= unsettledIn(prepared, line, statements)[0] ?? null;
  }
  return stated ?? unsettled;
}

/**
 * The scale `text` states, as written: the first currency next to a scale token
 * (`currencyScaleMarker`), else the first statement with a scale (`readStatedUnits`); null when
 * it states none. Only the lines that may state one are normalised, so a long page that states
 * none is read in one pass of a regular expression.
 */
export function statedScale(text: string, context: FigureContext = {}): string | null {
  const settled = settle(context);
  let stated: string | null = null;
  for (const line of linesHintingScales(text)) {
    const prepared = prepare(line);
    const marker = CURRENCY_SCALE.exec(prepared.s)?.[0];
    if (marker !== undefined) return marker;
    stated ??=
      statedUnitsOf(prepared, line, statementsIn(prepared, line, settled)).find(
        (each) => each.scale !== 1,
      )?.chars ?? null;
  }
  return stated;
}

// Numerals -------------------------------------------------------------------

/** A number as its digits and where the point falls, so scaling stays exact until the end. */
interface Digits {
  digits: string;
  /** How many of `digits` come before the decimal point. */
  point: number;
}

const decimalsOf = (number: Digits): number => Math.max(0, number.digits.length - number.point);

function precisionOf(number: Digits, exponent: number): number | undefined {
  const precision = 10 ** (exponent - decimalsOf(number));
  return Number.isFinite(precision) && precision > 0 ? precision : undefined;
}

/** The double nearest to the digits × 10^exponent, as a spreadsheet reads the same number written out. */
function decimalValue(number: Digits, exponent: number, negative: boolean): number {
  if (!/[1-9]/.test(number.digits)) return 0;
  return Number(`${negative ? "-" : ""}0.${number.digits}e${number.point + exponent}`);
}

/** A number found in the text, before the words around it are read. */
interface Core extends Span {
  number: Digits;
  /** Another reading of its separators that the context doesn't rule out. */
  otherReading: Digits | null;
  /** Its decimal mark isn't the one the Document uses. */
  foreignDecimal: boolean;
  /** Written with a group separator or a decimal point: a formatted amount, not a list's "(2)". */
  formatted: boolean;
  /** A Chinese numeral, which takes no scale word after it but its own. */
  chinese: boolean;
  /** One Chinese character, which is a figure only with a measure ("三成", "两倍"). */
  single: boolean;
  /** Written in financial capitals ("壹佰贰拾"), which may go on with 元, 角 and 分. */
  capitals: boolean;
  /** The scale inside a Chinese numeral: "三十五万" is 35 × 10^4. */
  exponent: number;
  scaleWord: string | null;
  scaleAt: Span | null;
  /** "百分之二十五", "千分之五": a percent, with its power of ten. */
  percent: number | null;
  /** "三分之一": a fraction, read as its quotient. */
  fraction: number | null;
}

const core = (span: Span, number: Digits, fields: Partial<Core> = {}): Core => ({
  ...span,
  number,
  otherReading: null,
  foreignDecimal: false,
  formatted: false,
  chinese: false,
  single: false,
  capitals: false,
  exponent: 0,
  scaleWord: null,
  scaleAt: null,
  percent: null,
  fraction: null,
  ...fields,
});

const integer = (digits: string): Digits => ({ digits, point: digits.length });

/** Digits and the separators between them, as written, before deciding what the separators are. */
interface Lexeme {
  groups: string[];
  separators: string[];
  /** Where each group starts. */
  at: number[];
}

function lexArabic(s: string, start: number, settled: Settled): Lexeme {
  const digitsEnd = (from: number) => {
    let end = from;
    while (isDigit(s[end])) end++;
    return end;
  };
  let end = digitsEnd(start);
  const lexeme: Lexeme = { groups: [s.slice(start, end)], separators: [], at: [start] };
  for (;;) {
    const separator = s[end];
    if (separator === undefined || !",.' \u00a0".includes(separator) || !isDigit(s[end + 1])) break;
    // A plain space groups only where the Document's numbers group with spaces: elsewhere "12 345"
    // is two cells, and the next is lexed from its own start.
    if (separator === " " && !settled.spaceGroups) break;
    const groupEnd = digitsEnd(end + 1);
    lexeme.separators.push(separator === NBSP ? " " : separator);
    lexeme.groups.push(s.slice(end + 1, groupEnd));
    lexeme.at.push(end + 1);
    end = groupEnd;
  }
  steps += end - start;
  return lexeme;
}

/**
 * Whether groups of digits are thousands: "1,234,567", or Indian lakhs and
 * crores, "12,34,567", which can only be read one way, so ask nothing.
 */
function grouped(groups: readonly string[], separator: string): boolean {
  const [first = "", ...rest] = groups;
  if (first.length > 3 || first.startsWith("0")) return false;
  if (rest.every((group) => group.length === 3)) return true;
  return (
    separator === "," &&
    first.length <= 2 &&
    rest.length >= 2 &&
    rest.slice(0, -1).every((group) => group.length === 2) &&
    rest.at(-1)?.length === 3
  );
}

const eachAlone = (groups: readonly string[], at: readonly number[]): Core[] =>
  groups.map((group, index) => {
    const from = at[index] as number;
    return core({ from, to: from + group.length }, integer(group));
  });

/** From each index, how many in a row `holds` is true for; one more entry, 0, past the end. */
function runsFrom(length: number, holds: (index: number) => boolean): number[] {
  const runs = new Array<number>(length + 1).fill(0);
  for (let index = length - 1; index >= 0; index--)
    runs[index] = holds(index) ? (runs[index + 1] as number) + 1 : 0;
  return runs;
}

/**
 * Reads the separators of a run of digits. A separator is decided by the number itself where it
 * can be ("1,234.5", "1.234.567"), then by the context; where neither decides, both readings are
 * kept. Separators of mixed kinds that aren't one number read as the longest start that is one,
 * then the rest the same way, in one pass over run lengths worked out once, so a garbled run costs
 * no more than its length (#2510).
 */
function readGroups(s: string, lexeme: Lexeme, settled: Settled): Core[] {
  const { groups, separators, at } = lexeme;
  const count = separators.length;
  const repeats = runsFrom(count, (index) => separators[index] === separators[index + 1]);
  const threes = runsFrom(groups.length, (index) => groups[index]?.length === 3);
  const twos = runsFrom(groups.length, (index) => groups[index]?.length === 2);
  steps += groups.length;
  const same = (from: number) => (repeats[from] as number) + 1;
  /** `grouped` over the `last` + 1 groups from `from`, with `separator` between them. */
  const groupedFrom = (from: number, last: number, separator: string) => {
    const first = groups[from] as string;
    if (first.length > 3 || first.startsWith("0")) return false;
    if (last <= (threes[from + 1] as number)) return true;
    return (
      separator === "," &&
      first.length <= 2 &&
      last >= 2 &&
      last - 1 <= (twos[from + 1] as number) &&
      groups[from + last]?.length === 3
    );
  };
  /** Whether the separators from `from` to the end are mixed: neither one kind nor two that settle each other. */
  const mixedFrom = (from: number) => {
    const left = count - from;
    if (left === 0 || same(from) >= left) return false;
    const last = separators[count - 1];
    return !(
      same(from) === left - 1 &&
      (last === "," || last === ".") &&
      groupedFrom(from, left - 1, separators[from] as string)
    );
  };
  /** How many separators the longest start from `from` that is one number spans; 0 when none is. */
  const longestFrom = (from: number) => {
    const run = same(from);
    const separator = separators[from] as string;
    const next = separators[from + run];
    if (
      from + run + 1 < count &&
      (next === "," || next === ".") &&
      groupedFrom(from, run, separator)
    )
      return run + 1;
    let longest = separator === "," || separator === "." ? 1 : 0;
    const first = groups[from] as string;
    if (first.length <= 3 && !first.startsWith("0")) {
      longest = Math.max(longest, Math.min(threes[from + 1] as number, run));
      const lakhs = (twos[from + 1] as number) + 1;
      if (lakhs <= run && groupedFrom(from, lakhs, separator)) longest = Math.max(longest, lakhs);
    }
    return longest;
  };
  const numberFrom = (from: number, last: number) =>
    readNumber(
      s,
      groups.slice(from, from + last + 1),
      separators.slice(from, from + last),
      at.slice(from, from + last + 1),
      settled,
    );
  const cores: Core[] = [];
  let from = 0;
  while (mixedFrom(from)) {
    const longest = longestFrom(from);
    if (longest === 0) return [...cores, ...eachAlone(groups.slice(from), at.slice(from))];
    cores.push(...numberFrom(from, longest));
    from += longest + 1;
  }
  return [...cores, ...numberFrom(from, count - from)];
}

/** Groups of digits with one kind of separator between them, or two kinds that settle each other. */
function readNumber(
  s: string,
  groups: readonly string[],
  separators: readonly string[],
  at: readonly number[],
  settled: Settled,
): Core[] {
  const first = groups[0] as string;
  const end = (index: number) => (at[index] as number) + (groups[index] as string).length;
  const span = (last: number): Span => ({ from: at[0] as number, to: end(last) });
  const all = groups.join("");
  steps += groups.length;
  if (separators.length === 0) return [core(span(0), integer(first))];

  const last = separators.at(-1) as string;
  const earlier = separators.slice(0, -1);
  // Two kinds of separator settle themselves: "1,234.5", "1.234,5", "1 234,5".
  if (
    earlier.length > 0 &&
    (last === "," || last === ".") &&
    earlier.every((each) => each === earlier[0] && each !== last)
  ) {
    if (grouped(groups.slice(0, -1), earlier[0] as string)) {
      return [
        core(
          span(groups.length - 1),
          { digits: all, point: all.length - (groups.at(-1) as string).length },
          {
            formatted: true,
          },
        ),
      ];
    }
  }
  if (separators.every((each) => each === separators[0])) {
    const separator = separators[0] as string;
    if (separators.length === 1 && (separator === "," || separator === ".")) {
      const decimal: Digits = { digits: all, point: first.length };
      const groupable =
        first[0] !== "0" && separatesThousands((offset) => s[offset], (at[1] as number) - 1);
      const grouped = groupable ? integer(all) : null;
      if (grouped) {
        if (settled.decimal === null) {
          // Both readings, English and Chinese first: "1,234" as 1234, "1.234" as 1.234.
          const [reading, other] = separator === "," ? [grouped, decimal] : [decimal, grouped];
          return [core(span(1), reading, { otherReading: other, formatted: true })];
        }
        return [
          core(span(1), settled.decimal === separator ? decimal : grouped, { formatted: true }),
        ];
      }
      return [
        core(span(1), decimal, {
          formatted: true,
          foreignDecimal: settled.decimal !== null && settled.decimal !== separator,
        }),
      ];
    }
    if (grouped(groups, separator))
      return [core(span(groups.length - 1), integer(all), { formatted: true })];
    // "1.2.3": a version, a section or an address, not one number nor several.
    if (separator === ".") return [];
    // "1,2,3", or numbers that only look grouped: each stands alone.
    return eachAlone(groups, at);
  }
  throw new Error("Separators of mixed kinds reached the reading of one number.");
}

/** Chinese digits and their financial capitals; 〇 and 零 are zero, 两 is two, 参 is 參 simplified. */
const CN_DIGITS: Readonly<Record<string, number>> = Object.fromEntries([
  ...[..."〇一二三四五六七八九"].map((char, value) => [char, value]),
  ...[..."零壹贰叁肆伍陆柒捌玖"].map((char, value) => [char, value]),
  ["两", 2],
  ["参", 3],
]);
const CN_PLACES: Readonly<Record<string, number>> = {
  ...Object.fromEntries([..."十百千"].map((char, index) => [char, 10 ** (index + 1)])),
  ...Object.fromEntries([..."拾佰仟"].map((char, index) => [char, 10 ** (index + 1)])),
};
const CAPITALS = /[壹贰叁肆伍陆柒捌玖拾佰仟]/;

const isCnDigit = (char: string | undefined) => char !== undefined && CN_DIGITS[char] !== undefined;
const isCnNumeral = (char: string | undefined) =>
  char !== undefined &&
  (isCnDigit(char) || CN_PLACES[char] !== undefined || char === "万" || char === "亿");

/** A number below 10,000 in Chinese numerals ("三千五百二十"), or null when it isn't one. */
function cnSection(run: string): number | null {
  if (run === "") return null;
  let total = 0;
  let digit: number | null = null;
  let place = 0;
  let zero = false;
  for (const [index, char] of [...run].entries()) {
    const value = CN_DIGITS[char];
    const unit = CN_PLACES[char];
    if (value !== undefined) {
      // Two digits in a row aren't one number: "一二" is "one or two".
      if (digit !== null) return null;
      if (value === 0) zero = true;
      else digit = value;
    } else if (unit !== undefined) {
      if (place !== 0 && unit >= place) return null;
      if (digit === null) {
        // "十二" is 12 and "一千零十" is 1,010; "百" alone isn't a number.
        if (unit !== 10 || (index !== 0 && !zero)) return null;
        digit = 1;
      }
      total += digit * unit;
      place = unit;
      digit = null;
      zero = false;
    } else {
      return null;
    }
  }
  if (digit !== null) {
    // "一千五" is 1,500: a last digit straight after a place stands for the place below it.
    const abbreviated = !zero && place >= 100 && CN_PLACES[[...run].at(-2) ?? ""] !== undefined;
    total += abbreviated ? digit * (place / 10) : digit;
  }
  return total;
}

/** What follows 万 or 亿 in a numeral: "五" in "一万五" is 5,000; "零五" is 5. */
function cnRest(rest: string, big: number, below: (run: string) => number | null): number | null {
  if (rest === "") return 0;
  const digit = CN_DIGITS[rest];
  if ([...rest].length === 1 && digit !== undefined && digit !== 0) return (digit * big) / 10;
  return below(rest.replace(/^[零〇]/, ""));
}

function cnBelowYi(run: string): number | null {
  const at = run.indexOf("万");
  if (at < 0) return cnSection(run);
  const high = cnSection(run.slice(0, at));
  if (!high) return null;
  const low = cnRest(run.slice(at + 1), 1e4, cnSection);
  return low === null ? null : high * 1e4 + low;
}

/** A whole number in Chinese numerals, or null when the run isn't one ("万一", "一二", "千万"). */
function cnInteger(run: string): number | null {
  if ([...run].length >= 2 && [...run].every(isCnDigit) && /[〇零]/.test(run)) {
    return Number([...run].map((char) => CN_DIGITS[char]).join(""));
  }
  const at = run.indexOf("亿");
  if (at < 0) return cnBelowYi(run);
  const high = cnBelowYi(run.slice(0, at));
  if (!high) return null;
  const rest = run.slice(at + 1);
  if (rest.includes("亿")) return null;
  const low = cnRest(rest, 1e8, cnBelowYi);
  return low === null ? null : high * 1e8 + low;
}

/** Whether the 半 at `at` ends the figure: a Han word after it ("两千半导体") keeps it that word's own. */
function halfEnds(s: string, at: number): boolean {
  return (
    !/\p{Script=Han}/u.test(s[at + 1] ?? "") ||
    matchAt(CN_CURRENCY_AFTER, s, at + 1) !== null ||
    matchAt(APPROXIMATE_AFTER, s, at + 1) !== null
  );
}

/** A Chinese numeral starting at `start`, read with the scale it ends in, or null. */
function lexChinese(s: string, start: number): Core | null {
  let end = start;
  while (isCnNumeral(s[end]) || (s[end] === "点" && isCnDigit(s[end + 1]) && end > start)) end++;
  const run = s.slice(start, end);
  const point = run.indexOf("点");
  const span = { from: start, to: end };
  const capitals = CAPITALS.test(run);
  const digit = CN_DIGITS[run[0] ?? ""];
  const place = run[1] ?? "";
  // "两万半" is 25,000, but "两千半导体" is 2,000 semiconductors; a longer numeral ("十二万半",
  // "一万二千半") takes half of its last place, never the value the 半 would be dropped from (#2215).
  if (s[end] === "半" && halfEnds(s, end)) {
    const halfSpan = { from: start, to: end + 1 };
    if (run.length === 2 && digit) {
      const exponent = place === "万" || place === "亿" ? CN_SCALES[place] : undefined;
      if (exponent !== undefined) {
        return core(
          halfSpan,
          { digits: `${digit}5`, point: 1 },
          {
            chinese: true,
            capitals,
            exponent,
            scaleWord: place,
            scaleAt: { from: end - 1, to: end },
          },
        );
      }
      const unit = CN_PLACES[place];
      if (unit !== undefined && unit >= 100) {
        return core(halfSpan, integer(String(digit * unit + unit / 2)), {
          chinese: true,
          capitals,
        });
      }
    }
    const last = run.at(-1) ?? "";
    const halfPlace = last === "万" ? 1e4 : last === "亿" ? 1e8 : CN_PLACES[last];
    const value = cnInteger(run);
    if (halfPlace !== undefined && value !== null) {
      return core(halfSpan, integer(String(value + halfPlace / 2)), { chinese: true, capitals });
    }
  }
  if (point >= 0) {
    const whole = cnInteger(run.slice(0, point));
    const after = run.slice(point + 1);
    const fraction = after.match(/^[〇零一二三四五六七八九两]+/)?.[0] ?? "";
    const scale = after.slice(fraction.length);
    if (whole === null || (scale !== "" && CN_SCALES[scale] === undefined)) return null;
    const head = String(whole);
    const digits = head + [...fraction].map((char) => CN_DIGITS[char]).join("");
    return core(
      span,
      { digits, point: head.length },
      {
        chinese: true,
        capitals,
        exponent: scale ? (CN_SCALES[scale] as number) : 0,
        scaleWord: scale || null,
        scaleAt: scale ? { from: end - scale.length, to: end } : null,
      },
    );
  }
  // "三十五万" is 35 万: the last 万 or 亿 is its scale when nothing larger comes before it.
  const tail = run.match(/(?:万亿|亿|万)$/)?.[0];
  if (tail) {
    const mantissa = run.slice(0, -tail.length);
    const value = cnInteger(mantissa);
    if (value && !/[万亿]/.test(mantissa)) {
      return core(span, integer(String(value)), {
        chinese: true,
        capitals,
        exponent: CN_SCALES[tail] as number,
        scaleWord: tail,
        scaleAt: { from: end - tail.length, to: end },
      });
    }
  }
  const value = cnInteger(run);
  if (value === null) return null;
  return core(span, integer(String(value)), {
    chinese: true,
    capitals,
    single: [...run].length === 1,
  });
}

// Reading one figure ---------------------------------------------------------

/** A figure being read, in positions of the prepared text. */
interface Draft extends Span {
  core: Core;
  negative: boolean;
  /** "△1,250", or a whole number in brackets: the sign is a question. */
  signUnsure: boolean;
  /** A count of people in brackets: no sign, and no unit a header states, applies to it. */
  count: boolean;
  exponent: number;
  scaleWord: string | null;
  /** Where the scale word is, to give it as written. */
  scaleAt: Span | null;
  /** The power of ten a percent, per mille, basis point or 成 divides by. */
  unitExponent: number;
  unit: FigureUnit;
  /** Where another unit's word is, to give it as written. */
  unitAt: Span | null;
  /** Codes the currency may be, when more than one ("¥"). */
  currencies: string[];
  currencyAt: Span | null;
  loosePoints: string | null;
  /** "pct" in a Chinese Document: a percent, or percentage points. */
  percentOrPoints: boolean;
  approximate: boolean;
  footnote: Span | null;
  rangeTo: Draft | null;
}

/** Whether a figure can start at `at`: a digit or a Chinese numeral that doesn't continue something else. */
function coreAt(s: string, at: number, settled: Settled): Core[] | null {
  const char = s[at];
  if (isDigit(char)) {
    const before = s[at - 1];
    if (isDigit(before)) return null;
    // "FY2025", "A1", "COVID-19": a number that is part of a name.
    if (isLatin(before) && !CURRENCY_BEFORE.test(s.slice(Math.max(0, at - 6), at))) return null;
    if ((before === "-" && isLatin(s[at - 2])) || before === "_") return null;
    if ((before === "," || before === "." || before === "'") && isDigit(s[at - 2])) return null;
    const cores = readGroups(s, lexArabic(s, at, settled), settled);
    // ".5": a decimal written without its leading zero.
    const first = cores[0];
    if (
      first &&
      before === "." &&
      !isAlnum(s[at - 2]) &&
      first.number.point === first.number.digits.length
    ) {
      cores[0] = {
        ...first,
        from: at - 1,
        number: { digits: first.number.digits, point: 0 },
        formatted: true,
      };
    }
    return cores;
  }
  if (char === undefined) return null;
  const percent = s.slice(at, at + 3).match(/^([百千万])分之/);
  if (percent) {
    const exponent = percent[1] === "百" ? -2 : percent[1] === "千" ? -3 : -4;
    const after = at + 3;
    let inner: Core | null = null;
    if (isDigit(s[after])) inner = readGroups(s, lexArabic(s, after, settled), settled)[0] ?? null;
    else if (s.startsWith("百", after) && !isCnNumeral(s[after + 1])) {
      inner = core({ from: after, to: after + 1 }, integer("100"), { chinese: true });
    } else if (isCnNumeral(s[after])) inner = lexChinese(s, after);
    if (!inner) return null;
    return [{ ...inner, from: at, percent: exponent, single: false }];
  }
  if (!isCnDigit(char) && char !== "十" && char !== "拾") return null;
  if (isCnNumeral(s[at - 1]) || s[at - 1] === "点") return null;
  const found = lexChinese(s, at);
  if (!found) return null;
  // "三分之一": a fraction.
  if (s.startsWith("分之", found.to)) {
    const numerator = lexChinese(s, found.to + 2);
    const denominator = decimalValue(found.number, found.exponent, false);
    if (!numerator || denominator === 0) return null;
    return [
      {
        ...numerator,
        from: found.from,
        fraction: decimalValue(numerator.number, numerator.exponent, false) / denominator,
        single: false,
        exponent: 0,
        scaleWord: null,
        scaleAt: null,
      },
    ];
  }
  return [found];
}

// "a" as in "a hundred thousand".
const EN_NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ["a", 1],
  ...(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen " +
    "fifteen sixteen seventeen eighteen nineteen"
  )
    .split(" ")
    .map((word, value) => [word, value] as const),
  ..."twenty thirty forty fifty sixty seventy eighty ninety"
    .split(" ")
    .map((word, index) => [word, (index + 2) * 10] as const),
]);
const EN_WORD_SCALES: ReadonlyMap<string, number> = new Map([
  ["thousand", 1e3],
  ["million", 1e6],
  ["billion", 1e9],
  ["trillion", 1e12],
]);
const isNumberWord = (word: string) =>
  EN_NUMBER_WORDS.has(word) || EN_WORD_SCALES.has(word) || word === "hundred" || word === "and";

/**
 * The amount English words end `text` with, the currencies they name and where they start:
 * "Seventy-Five Thousand Dollars" is 75,000 in dollars, "a hundred thousand" 100,000, and "Twelve
 * Thousand and 50/100 Dollars" 12,000.50. Null when no number word ends it.
 */
function amountInWords(
  text: string,
  settled: Settled,
): { value: number; codes: string[]; start: number } | null {
  const words = [...text.matchAll(/[^\s,-]+/g)].map((match) => ({
    word: match[0],
    lower: match[0].toLowerCase(),
    at: match.index,
  }));
  const takeCents = () => {
    const digits = /^(\d{2})\/100$/.exec(words.at(-1)?.word ?? "")?.[1];
    if (digits === undefined) return undefined;
    words.pop();
    if (words.at(-1)?.lower === "and") words.pop();
    return digits;
  };
  let cents = takeCents();
  let codes: string[] = [];
  for (const size of isNumberWord(words.at(-1)?.lower ?? "") ? [] : [3, 2, 1]) {
    if (words.length <= size) continue;
    const phrase = words.slice(-size).map((each) => each.word);
    codes = currencyCodes(phrase.join(" "), settled);
    if (codes.length > 0) {
      words.splice(-size);
      break;
    }
  }
  cents ??= takeCents();
  let start = words.length;
  while (start > 0 && isNumberWord(words[start - 1]?.lower ?? "")) start--;
  let total = 0;
  let group = 0;
  let counted = false;
  for (const { lower } of words.slice(start)) {
    const unit = EN_NUMBER_WORDS.get(lower);
    const scale = EN_WORD_SCALES.get(lower);
    if (unit !== undefined) {
      group += unit;
      counted = true;
    } else if (lower === "hundred") group *= 100;
    else if (scale !== undefined) {
      total += group * scale;
      group = 0;
    }
  }
  const first = words[start];
  return counted && first
    ? { value: Number(`${total + group}.${cents ?? 0}`), codes, start: first.at }
    : null;
}

/**
 * Words right before an amount that may give it a sign the reader doesn't read as one: "less", "a
 * deficit of", "decreased by", "亏损", "减少", "扣除"; or a minus or a △ written on it.
 */
const SIGN_BEFORE =
  /(?:(?<![A-Za-z])(?:less|deficits?|loss(?:es)?|decreas(?:e|es|ed))(?: (?:of|by))?|亏损|赤字|减少|下降|损失|扣除|减去|扣减|抵扣|减除)[ \u00a0]*[为了]?$|-[ \u00a0]*$|[△▲▽▼][ \u00a0]*$/i;

/**
 * A word that says or may say an amount is below zero, or is taken off, in the text around it:
 * "minus", "negative", "loss", "deficit", "less", "deducted", "overdrawn", "OD", "in the red",
 * "below zero", "in debit", "-ve", "(−)", 负, 亏, 损失, 透支, 赤字, 逆差, 缺口, 红字, 小于零. A loss's
 * size ("The loss was …") keeps the minus too, as main reads it. Not a "negative pledge", "less
 * than", 负责, 负担, 负债, 负面, 自负, 幸亏 or 多亏.
 */
const NEGATIVE_WORD =
  /(?<![A-Za-z])(?:minus|negative(?! pledge)|overdrawn|overdrafts?|in(?:to)? the red|loss(?:es)?|deficits?|less(?! than)|deduct(?:s|ed|ing|ions?)?|(?:below|under|less than) zero|in debit|-ve|od|(?:shown|printed) in red|under ?water)(?![A-Za-z])|(?<!自)负(?![责担债面])|(?<![幸多])亏|损失|透支|赤字|逆差|缺口|[小低]于零|红字|\(-\)/i;

/** A line that subtracts what follows: "Less: deposit paid …", "减：已付定金 …", a "Less" cell or heading. */
const DEDUCTION_LINE = /^[\s|]*(?:less|deduct|减)[ \u00a0]*(?:[:：-]|\t|\||$)/im;

/** The Document says amounts in brackets are negative: "Amounts in brackets are negative", "括号内数字为负数". */
const SAYS_BRACKETS_NEGATIVE =
  /(?<![A-Za-z])(?:brackets?|parenthes[ie]s)(?![A-Za-z])[^.\n]{0,60}(?<![A-Za-z])negative(?![A-Za-z])|(?<![A-Za-z])negative(?![A-Za-z])[^.\n]{0,60}(?<![A-Za-z])(?:brackets?|parenthes[ie]s)(?![A-Za-z])|括号[^。\n]{0,20}(?:负数|为负(?![责担]))|负数[^。\n]{0,20}括号/i;

/**
 * Whether a figure in brackets gives again the amount written right before it, in figures:
 * "人民币九万八千元（¥98,000）", "USD 1.2 million ($1,200,000)", "Seventy-Five Thousand Dollars
 * ($75,000.00)"; and the one currency the two agree on, which settles a bare "$" or "¥" in the
 * bracket. Null when it doesn't. Only an amount in words or with a scale word is given again so:
 * two cells of a statement line write one form twice, as an elimination's "3,600 (3,600)" does,
 * and a tab or a line between them parts two cells. Where the words may give the amount a sign, or
 * the Document says brackets are negative, the bracket is read as before.
 */
function restates(
  prepared: Prepared,
  before: Draft | undefined,
  floor: number,
  bracket: number,
  inner: Draft,
  settled: Settled,
): { currency: string | null } | null {
  const { s } = prepared;
  if (settled.negativeBrackets) return null;
  const value = readingOf({ ...inner, negative: false }).value;
  // No further back than one amount's words reach, so a long line costs no more.
  const near = Math.max(0, bracket - 160);
  const line = near + s.slice(near, bracket).lastIndexOf("\n") + 1;
  // Under a header of periods a bracket may be another year's figure, as main reads it (#2341).
  if (settled.periodColumns || periodHeaderEnd(prepared) <= bracket) return null;
  // "人民币九万八千元整（¥98,000.00）": 整 closes an amount in words.
  const gap = /整?[ \u00a0]*$/.exec(s.slice(Math.max(floor, line), bracket))?.[0].length ?? 0;
  const end = bracket - gap;
  for (let at = end; at <= bracket; at++)
    if (prepared.tabbed.has(at) || prepared.lineStarts.has(at)) return null;
  const signed = (from: number) => {
    // A sign word can be lines or sentences before or after the amount it gives a sign to ("The
    // balance was negative. It was …", "… ($62,000.00), turned negative"), and a stop can't tell a
    // sentence's end from an abbreviation's ("St. Louis", "acct. A12"), so all the text within 400
    // characters counts, the Document's around a quote too. Words that start further into the text
    // read, or a quote whose page runs further back with no blank line or heading in sight, keep the
    // bracket's minus: the reader can't see where the amount's part of the page starts (#2578).
    if (from > 400 || settled.pageCut) return true;
    const after = s.slice(inner.to, inner.to + 400) + settled.after;
    const window = settled.before + s.slice(0, from);
    if (NEGATIVE_WORD.test(window) || NEGATIVE_WORD.test(after) || DEDUCTION_LINE.test(window))
      return true;
    const start = s.lastIndexOf("\n", from - 1) + 1;
    // "减", a tab, "已付定金": the tab beside a Chinese character is gone from the text read.
    const label = /^[\s|]*减/.exec(s.slice(start, from))?.[0].length;
    return (
      SIGN_BEFORE.test(window.slice(-24)) ||
      (label !== undefined && prepared.tabbed.has(start + label))
    );
  };
  // A bare "$" is whichever dollar the words name: "Australian Dollars ($98,000)".
  const sign = inner.currencyAt ? s.slice(inner.currencyAt.from, inner.currencyAt.to) : "";
  const codes = [...inner.currencies, ...(SIGN_CURRENCIES[sign] ?? [])];
  const agreed = (named: readonly string[]) => {
    const both = named.filter((code) => codes.includes(code));
    return { currency: both.length === 1 ? (both[0] ?? null) : null };
  };
  if (before && before.to === end) {
    if (!before.core.chinese && before.scaleWord === null) return null;
    if (before.signUnsure) return null;
    const unitsAgree =
      before.unit.kind === "plain" ||
      inner.unit.kind === "plain" ||
      (before.unit.kind === "currency" && inner.unit.kind === "currency"
        ? before.currencies.some((code) => codes.includes(code))
        : JSON.stringify(before.unit) === JSON.stringify(inner.unit));
    return unitsAgree && readingOf(before).value === value && !signed(before.from)
      ? agreed(before.currencies)
      : null;
  }
  // Back to the line's or the cell's start, not to the last figure: "and 50/100" may have been
  // read as a date.
  const from = line + s.slice(line, end).lastIndexOf("\t") + 1;
  const words = amountInWords(s.slice(from, end), settled);
  return words !== null &&
    words.value === value &&
    (words.codes.length === 0 ||
      inner.currencies.length === 0 ||
      words.codes.some((code) => codes.includes(code))) &&
    !signed(from + words.start)
    ? agreed(words.codes)
    : null;
}

/**
 * Whether `run` is an 18-character Chinese resident ID number (居民身份证): 17 digits and a digit
 * or X, where an ID carries its birth date. Read by its structure alone, so no list of the words
 * before it ("身份证号") has to grow (#2215).
 */
function isResidentId(run: string): boolean {
  const match = /^\d{6}(\d{4})(\d{2})(\d{2})\d{3}[\dXx]$/.exec(run);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1800 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** An 11-digit mainland mobile number: 1, then 3–9, then nine digits. */
const MOBILE_NUMBER = /^1[3-9]\d{9}$/;

/** Reads the words around a number into a figure; null when it isn't one (a year, a reference, a word). */
function readAround(
  prepared: Prepared,
  found: Core,
  floor: number,
  settled: Settled,
  before?: Draft,
): Draft | null {
  const { s } = prepared;
  const draft: Draft = {
    from: found.from,
    to: found.to,
    core: found,
    negative: false,
    signUnsure: false,
    count: false,
    exponent: found.exponent,
    scaleWord: found.scaleWord,
    scaleAt: found.scaleAt,
    unitExponent: found.percent ?? 0,
    unit: found.percent !== null ? { kind: "percent" } : { kind: "plain" },
    unitAt: null,
    currencies: [],
    currencyAt: null,
    loosePoints: null,
    percentOrPoints: false,
    approximate: false,
    footnote: null,
    rangeTo: null,
  };

  let left = found.from;
  let signed = false;
  const takeSign = () => {
    const sign = s[left - 1];
    if (signed || left - 1 < floor || (sign !== "-" && sign !== "+")) return;
    if (isAlnum(s[left - 2]) || s[left - 2] === "-") return;
    draft.negative = sign === "-";
    signed = true;
    left--;
  };
  const currencyBefore = (at: number) => {
    const match = CURRENCY_BEFORE.exec(s.slice(floor, at));
    if (!match) return null;
    const from = floor + match.index;
    return { from, to: from + match[0].trimEnd().length, codes: currencyCodes(match[0], settled) };
  };
  takeSign();
  const currency = currencyBefore(left);
  if (currency) {
    draft.currencies = currency.codes;
    draft.currencyAt = currency;
    left = currency.from;
  }
  takeSign();
  if (!signed && s[left - 1] === "负" && left - 1 >= floor) {
    draft.negative = true;
    signed = true;
    left--;
  }
  // "零下18度": below zero.
  if (!signed && s.slice(left - 2, left) === "零下" && left - 2 >= floor) {
    draft.negative = true;
    signed = true;
    left -= 2;
  }
  const marker = s.slice(floor, left).match(/[△▲▽▼] ?$/);
  if (!signed && marker) {
    draft.signUnsure = true;
    left -= marker[0].length;
  }
  if (REFERENCE_BEFORE.test(s.slice(Math.max(floor, left - 24), left))) return null;
  const looseReference = LOOSE_REFERENCE_BEFORE.test(s.slice(floor, left));
  // A list's number: "1." or "1)" or "1、" at the start of a line.
  let indent = left;
  while (s[indent - 1] === " " || s[indent - 1] === "\t") indent--;
  const lineStart = s[indent - 1] === "\n" || prepared.lineStarts.has(indent);
  const mark = s[found.to];
  const afterMark = s[found.to + 1];
  const listMark =
    mark === "、"
      ? !isDigit(afterMark)
      : (mark === "." || mark === ")") &&
        (afterMark === undefined ||
          " \t\n".includes(afterMark) ||
          prepared.spaced.has(found.to + 1));
  if (lineStart && listMark && !found.formatted && found.to - found.from <= 2) return null;
  let open = left;
  while (s[open - 1] === " " && open - 1 >= floor) open--;
  const bracket = s[open - 1] === "(" && open - 1 >= floor ? open - 1 : null;

  // A route's or a line's name, not a figure: "1路", "2号线".
  if (/^(?:路|号线)/.test(s.slice(found.to, found.to + 2)) && !found.formatted) return null;

  let right = found.to;
  const takeLedger = (): boolean => {
    const word = matchAt(LEDGER_AFTER, s, right);
    if (!word || (!word[0].startsWith(" ") && !found.formatted)) return false;
    right += word[0].length;
    return true;
  };
  /** Takes what `pattern` matches at the right, and where it is, without the space before it. */
  const take = (pattern: RegExp) => {
    const match = matchAt(pattern, s, right);
    if (!match) return null;
    const lead = match[0].length - match[0].trimStart().length;
    const at = { from: right + lead, to: right + match[0].length };
    right = at.to;
    return { word: match[0].trim(), at, match };
  };
  if (take(/[多余](?!额)/y)) draft.approximate = true;
  if (draft.exponent === 0 && found.percent === null && found.fraction === null) {
    const before = right;
    const scale =
      found.chinese && !draft.approximate ? null : (take(CN_SCALE_AFTER) ?? take(EN_SCALE_AFTER));
    // "mm" is millions only beside a currency; "5mm" is millimetres.
    if (scale?.word === "mm" && draft.currencies.length === 0) right = before;
    else if (scale) {
      draft.scaleWord = scale.word;
      draft.scaleAt = scale.at;
      draft.exponent = scaleExponent(scale.word);
      // "2万5千", "2亿5000万", "2万三千": the lower places go on with the same amount, at its scale.
      let place =
        found.number.point === found.number.digits.length && !found.otherReading
          ? CN_SCALES[scale.word]
          : undefined;
      let value = decimalValue(found.number, draft.exponent, false);
      let joined = false;
      while (place !== undefined) {
        const at = right;
        const digits = take(/\d{1,4}(?![\d.,])/y);
        const lower = digits ? take(CN_SCALE_AFTER) : null;
        const exponent = lower ? CN_SCALES[lower.word] : undefined;
        const chinese = digits ? null : lexChinese(s, right);
        // A lone numeral is a word or a count ("2万五" could start a date), so it joins only with its place.
        const chineseValue =
          chinese && !chinese.single ? decimalValue(chinese.number, chinese.exponent, false) : null;
        const lowerValue = digits
          ? exponent === undefined
            ? null
            : Number(digits.word) * 10 ** exponent
          : chineseValue;
        // A lower place at or above the place already read would be another number, not part of this one.
        if (lowerValue === null || lowerValue >= 10 ** place) {
          right = at;
          break;
        }
        if (digits) {
          value += lowerValue;
          place = exponent;
        } else if (chinese !== null) {
          value += lowerValue;
          place = chinese.exponent;
          right = chinese.to;
        }
        joined = true;
      }
      if (joined) {
        const [whole = "", fraction = ""] = String(value / 10 ** draft.exponent).split(".");
        draft.core = { ...draft.core, number: { digits: whole + fraction, point: whole.length } };
      }
      // "2万半", "1万2千半": 半 after a mixed amount takes half of the last place read (#2215).
      const halfPlace = place ?? (CN_SCALES[scale.word] === undefined ? undefined : draft.exponent);
      if (halfPlace !== undefined && halfPlace > 0 && s[right] === "半" && halfEnds(s, right)) {
        value += 10 ** halfPlace / 2;
        right++;
        const [whole = "", fraction = ""] = String(value / 10 ** draft.exponent).split(".");
        draft.core = { ...draft.core, number: { digits: whole + fraction, point: whole.length } };
      }
    }
  }
  const currencyAfter =
    found.percent === null
      ? (take(CN_CURRENCY_AFTER) ?? take(EN_CURRENCY_AFTER) ?? take(SIGN_AFTER))
      : null;
  if (currencyAfter) {
    const codes = currencyCodes(currencyAfter.word.replace(/(.)人民币$/, "$1"), settled);
    // "新台币54,000元" is in TWD: 元 after one named currency is that currency's unit.
    const unitOfNamed = /^[元圆]$/.test(currencyAfter.word) && draft.currencies.length === 1;
    // "¥3,500元" and "$54,000 AUD": the word after settles the sign before.
    if (!unitOfNamed) {
      const sign = draft.currencyAt ? s.slice(draft.currencyAt.from, draft.currencyAt.to) : "";
      const mayBe = [...draft.currencies, ...(SIGN_CURRENCIES[sign.normalize("NFKC")] ?? [])];
      const settles = draft.currencies.length === 0 || codes.every((code) => mayBe.includes(code));
      draft.currencies = settles ? codes : [...new Set([...draft.currencies, ...codes])];
    }
    draft.currencyAt ??= currencyAfter.at;
    if (found.capitals) {
      const jiao = take(/([壹贰叁肆伍陆柒捌玖])角/y);
      const fen = take(/([壹贰叁肆伍陆柒捌玖])分/y);
      if (jiao || fen) {
        const cents = `${CN_DIGITS[jiao?.match[1] ?? ""] ?? 0}${CN_DIGITS[fen?.match[1] ?? ""] ?? 0}`;
        draft.core = {
          ...found,
          number: { digits: found.number.digits + cents, point: found.number.point },
        };
      }
      take(/[整正]/y);
    }
  } else if (found.percent === null && found.fraction === null) {
    const points = take(POINTS_AFTER);
    const percent = points ? null : take(PERCENT_AFTER);
    const times = points || percent ? null : take(TIMES_AFTER);
    const tenths = points || percent || times ? null : take(TENTHS_AFTER);
    const loose = points || percent || times || tenths ? null : take(LOOSE_POINTS_AFTER);
    if (points) {
      draft.unit = { kind: "points" };
      draft.unitExponent = /基点|bp|basis/.test(points.word) ? -4 : -2;
    } else if (percent) {
      draft.unit = { kind: "percent" };
      draft.unitExponent = percent.word === "‰" ? -3 : -2;
      // Chinese brokers write "+2.1pct" for percentage points.
      if (/^pcts?$/i.test(percent.word) && settled.chinese) draft.percentOrPoints = true;
    } else if (times) draft.unit = { kind: "times" };
    else if (tenths) {
      draft.unit = { kind: "percent" };
      draft.unitExponent = -1;
    } else if (loose) {
      draft.loosePoints = loose.word;
      draft.unit = { kind: "other", word: loose.word };
      draft.unitAt = loose.at;
    } else {
      const unit =
        take(CN_MEASURE_AFTER) ??
        (found.single ? null : take(CN_COUNT_AFTER)) ??
        take(EN_UNIT_AFTER);
      if (unit) {
        draft.unit = { kind: "other", word: unit.word };
        draft.unitAt = unit.at;
      }
    }
  }
  if (draft.currencies.length > 0)
    draft.unit = { kind: "currency", code: draft.currencies[0] as string };
  // A mobile or ID number written bare identifies someone; only a currency, a scale or another
  // unit makes those digits an amount ("人民币13800138000元", a cell under "单位：万元"), whatever
  // word comes before (#2215).
  const idTail = draft.unit.kind === "times" && /^[Xx]$/.test(s.slice(found.to, found.to + 1));
  if (
    !settled.statedAmount &&
    !found.formatted &&
    found.number.point === found.number.digits.length &&
    draft.currencies.length === 0 &&
    draft.scaleWord === null &&
    (draft.unit.kind === "plain" || idTail)
  ) {
    const run = s.slice(found.from, found.to + (idTail ? 1 : 0));
    if (MOBILE_NUMBER.test(run) || isResidentId(run)) return null;
  }
  if (take(APPROXIMATE_AFTER)) draft.approximate = true;
  let ledger = takeLedger();

  // A name, not a figure: "5G", "3D", "2025E", "1st", "600519.SH".
  if (isLatin(s[right]) && (right === found.to || isAlnum(s[right - 1]))) return null;
  if (s[right] === "." && /^[A-Z]{2}(?![A-Za-z])/.test(s.slice(right + 1, right + 4))) return null;
  if ((s[right] === "-" && isLatin(s[right + 1])) || s[right] === "_") return null;

  const bare =
    draft.scaleWord === null &&
    (draft.unit.kind === "plain" || (draft.unit.kind === "currency" && !currencyAfter));
  const whole = found.number.point === found.number.digits.length && !found.formatted;
  if (looseReference && bare && whole && draft.unit.kind === "plain") return null;
  // A heading's number at the start of a line: "1 Introduction", "2.1 Methods", "1 引言". One
  // joined to the next number ("88.0 和 91.5") is a figure: no heading reads so (#1969).
  const after = s[right] === " " ? right + 1 : prepared.spaced.has(right) ? right : null;
  const followed = after === null ? undefined : s[after];
  const joined = after !== null && /^[和与及或至到] ?\d/.test(s.slice(after, after + 3));
  if (
    lineStart &&
    draft.unit.kind === "plain" &&
    draft.scaleWord === null &&
    !signed &&
    /^\d{1,2}(?:\.\d{1,2})?$/.test(s.slice(found.from, found.to)) &&
    followed !== undefined &&
    /^[A-Z\p{Script=Han}]$/u.test(followed) &&
    !joined
  ) {
    return null;
  }
  const yearLike =
    whole &&
    found.percent === null &&
    found.number.digits.length === 4 &&
    Number(found.number.digits) >= 1900 &&
    Number(found.number.digits) <= 2099 &&
    (!found.chinese || /[〇零]/.test(s.slice(found.from, found.to)));
  if (
    yearLike &&
    draft.unit.kind === "plain" &&
    bare &&
    !signed &&
    !draft.signUnsure &&
    !settled.dates
  )
    return null;

  draft.from = left;
  let close = right;
  while (s[close] === " ") close++;
  // "（+2.1pct）": a sign written inside brackets makes them an aside, not an accounting negative.
  if (bracket !== null && s[close] === ")" && !signed) {
    const outer = draft.currencies.length === 0 ? currencyBefore(bracket) : null;
    const count = draft.unit.kind === "plain" && outer === null && namesCount(prepared, bracket);
    const reference =
      !count &&
      (REFERENCE_BEFORE.test(s.slice(Math.max(floor, bracket - 24), bracket)) ||
        LABEL_REFERENCE.test(s.slice(floor, bracket).trimEnd()));
    // "section 1159(10)", "s.12(3)": a sub-reference, never an amount.
    const glued =
      !outer &&
      !prepared.spaced.has(bracket) &&
      (isAlnum(s[bracket - 1]) || s[bracket - 1] === ")");
    // In running text brackets are an aside; only a table's cell or a statement line makes one a minus.
    const row = glued || reference ? null : rowOf(prepared, outer?.from ?? bracket, close + 1);
    // Brackets that give the amount before them again are neither a minus nor a question, and
    // make no figure of a "thirty (30) days" that has none.
    const aside = restates(prepared, before, floor, bracket, draft, settled);
    // "Australian Dollars ($98,000)": the bracket's "$" is the dollar its words name.
    const restate = () => {
      if (!aside?.currency) return;
      draft.currencies = [aside.currency];
      draft.unit = { kind: "currency", code: aside.currency };
    };
    const negate = () => {
      if (aside) return restate();
      draft.negative = true;
      if (outer) {
        draft.currencies = outer.codes;
        draft.currencyAt = outer;
        draft.unit = { kind: "currency", code: outer.codes[0] as string };
      }
      draft.from = outer?.from ?? bracket;
      right = close + 1;
      // "£(12.3)m": the scale may follow the brackets.
      const scale = draft.scaleWord === null ? take(EN_SCALE_AFTER) : null;
      if (scale && scale.word !== "mm") {
        draft.scaleWord = scale.word;
        draft.scaleAt = scale.at;
        draft.exponent = scaleExponent(scale.word);
      }
      ledger = ledger || takeLedger();
    };
    const enclose = () => {
      draft.from = bracket;
      right = close + 1;
    };
    const question = () => {
      if (aside) return restate();
      draft.signUnsure = true;
      enclose();
    };
    draft.count = count;
    const currencySigned = outer !== null || currency !== null;
    if (bare && found.formatted) {
      // "(1,250)" and "($1,250)" are accounting negatives, unless they count people.
      if (count) enclose();
      else negate();
    } else if (bare && whole) {
      // "(2)" is a list's or a note's; "(250)" may be negative or an aside, and is a minus in a row of accounts.
      if (reference) return null;
      const marked = draft.currencies.length > 0 || outer !== null;
      const small = found.number.digits.length <= 2;
      if (small && !(marked && row)) return null;
      if (count) enclose();
      else if (row && (marked || settled.accounts)) negate();
      else question();
    } else if (draft.unit.kind === "percent" && draft.scaleWord === null) {
      question();
    } else if (count) {
      enclose();
    } else if (
      row === "table"
        ? draft.unit.kind === "plain" || draft.unit.kind === "currency"
        : row === "statement" && currencySigned && settled.accounts
    ) {
      // "(US$170 million)" after an amount in another currency restates it; in a cell of its own, or in accounts beside a statement's label ("Impairment (£1.2m)"), it is a minus.
      const codes = outer?.codes ?? draft.currencies;
      const before =
        codes.length > 0 ? amountBefore(prepared, outer?.from ?? bracket, settled) : null;
      if (!before?.length || before.some((code) => codes.includes(code))) negate();
    }
  }
  if (ledger && !draft.negative) draft.signUnsure = true;
  const footnote = matchAt(FOOTNOTE_AFTER, s, right);
  if (footnote) {
    draft.footnote = { from: right, to: right + footnote[0].length };
    right += footnote[0].length;
  }
  draft.to = right;
  if (APPROXIMATE_BEFORE.test(s.slice(floor, draft.from))) draft.approximate = true;
  return draft;
}

/** A single Chinese numeral is a figure only with a measure that makes it one. */
function measured(draft: Draft): boolean {
  if (!draft.core.single) return true;
  if (draft.unit.kind !== "plain" && draft.unit.kind !== "other") return true;
  return draft.unit.kind === "other" && CN_MEASURES.includes(draft.unit.word);
}

const RANGE = / ?(?:-|~|〜) ?|至|到| to /y;
/** Words that make "to" a change, not a range: "increased by 1,234 to 5,678", "从10%到15%". */
const CHANGE_BEFORE =
  /(?:(?<![A-Za-z])(?:from|by|rose|risen|rises|rising|increased|increases|grew|grown|grows|fell|fallen|falls|decreased|declined|dropped|climbed|jumped|cut|reduced|raised|improved|widened|narrowed|went|moved|changed|up|down) |从|由)$/i;

// Asked of each range, so it is answered by binary search, not by looking through every span (#2510).
const reaches = new WeakMap<readonly Span[], { starts: number[]; reach: number[] }>();

/** Whether one of `blocked`, sorted by where each starts, holds `at`. */
function covers(blocked: readonly Span[], at: number): boolean {
  let known = reaches.get(blocked);
  if (!known) {
    const reach: number[] = [];
    for (const span of blocked) reach.push(Math.max(reach.at(-1) ?? 0, span.to));
    known = { starts: blocked.map((span) => span.from), reach };
    reaches.set(blocked, known);
    steps += blocked.length;
  }
  steps++;
  const before = countBefore(known.starts, at + 1);
  return before > 0 && (known.reach[before - 1] as number) > at;
}

/** The other end of a range after `left` ("2–3%", "1.2亿至1.5亿", "$1.2–1.5bn"), merged into it; null if none. */
function rangeAfter(
  prepared: Prepared,
  left: Draft,
  settled: Settled,
  blocked: readonly Span[],
): Draft | null {
  const { s } = prepared;
  const connector = matchAt(RANGE, s, left.to);
  if (!connector) return null;
  const text = connector[0];
  // "1,234 -1,100" is two cells, the second negative; a range's dash has the same space on both sides.
  if (text.includes("-") && text.startsWith(" ") !== text.endsWith(" ")) return null;
  if (left.footnote) return null;
  const word = text.trim();
  const before = s.slice(Math.max(0, left.from - 12), left.from);
  if ((word === "to" || word === "到") && CHANGE_BEFORE.test(before)) return null;
  const start = left.to + text.length;
  let at = start;
  while (at < s.length && at - start < 4 && !isDigit(s[at]) && !isCnDigit(s[at]) && s[at] !== "十")
    at++;
  if (covers(blocked, at)) return null;
  const found = coreAt(s, at, settled)?.[0];
  if (!found) return null;
  const right = readAround(prepared, found, start, settled);
  if (!right || right.from !== start) return null;
  const sameUnit =
    left.unit.kind === "plain" ||
    right.unit.kind === "plain" ||
    JSON.stringify(left.unit) === JSON.stringify(right.unit);
  if (!sameUnit) return null;
  // Each end takes what only the other states: "2–3%", "$1.2–1.5bn", "1.2-1.5亿".
  const merged: Draft = { ...left };
  const other: Draft = { ...right };
  for (const [to, from] of [
    [merged, right],
    [other, left],
  ] as const) {
    if (to.unit.kind === "plain" && from.unit.kind !== "plain") {
      to.unit = from.unit;
      to.unitAt = from.unitAt;
      to.unitExponent = from.unitExponent;
      to.currencies = from.currencies;
      to.currencyAt = from.currencyAt;
      to.loosePoints = from.loosePoints;
    }
    if (to.scaleWord === null && from.scaleWord !== null && to.core.percent === null) {
      to.exponent = from.exponent;
      to.scaleWord = from.scaleWord;
      to.scaleAt = from.scaleAt;
    }
  }
  // A range runs upwards; "1,234 - 1,100" is two cells of a table with a dash between them.
  if (readingOf(other).value <= readingOf(merged).value) return null;
  merged.to = right.to;
  merged.footnote = right.footnote;
  merged.approximate = left.approximate || right.approximate;
  merged.rangeTo = other;
  return merged;
}

// Turning drafts into figures ------------------------------------------------

/** The original characters of a span of the prepared text. */
type Written = (span: Span) => string;

function readingOf(draft: Draft, written?: Written, number: Digits = draft.core.number): Reading {
  const { fraction } = draft.core;
  const value =
    fraction !== null
      ? draft.negative
        ? -fraction
        : fraction
      : decimalValue(number, draft.exponent + draft.unitExponent, draft.negative);
  const unit =
    draft.unit.kind === "other" && draft.unitAt && written
      ? { kind: "other" as const, word: written(draft.unitAt) }
      : draft.unit;
  return {
    value,
    scale: 10 ** draft.exponent,
    scaleWord: draft.scaleAt && written ? written(draft.scaleAt) : draft.scaleWord,
    unit,
    decimals: fraction !== null ? 0 : decimalsOf(number),
    precision: fraction !== null ? null : precisionOf(number, draft.exponent + draft.unitExponent),
  };
}

/**
 * Stated units that read a figure alike, kept once: a report states 单位：万元 over each table,
 * and each figure has the one reading they all give (#2512).
 */
function distinctStatements(statements: readonly Statement[]): Statement[] {
  const seen = new Set<string>();
  return statements.filter(({ exponent, scaleWord, unit }) => {
    const key = JSON.stringify([exponent, scaleWord, unit]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const readingKey = ({ value, scale, scaleWord, unit, decimals, precision }: Reading) =>
  JSON.stringify([value, scale, scaleWord, unit, decimals, String(precision)]);

/** The readings a header's stated unit gives a figure that has no scale or unit of its own. */
function statedReadings(draft: Draft, statements: readonly Statement[]): Reading[] {
  if (
    draft.count ||
    draft.scaleWord !== null ||
    draft.core.percent !== null ||
    draft.core.fraction !== null
  )
    return [];
  if (draft.unit.kind !== "plain" && draft.unit.kind !== "currency") return [];
  const readings: Reading[] = [];
  steps += statements.length;
  for (const statement of statements) {
    // A numeral in words writes the whole amount: "一万二" under "单位：万元" is still 12,000 (#2189).
    if (draft.core.chinese && statement.exponent !== 0) continue;
    let unit: FigureUnit = draft.unit;
    let unitExponent = 0;
    if (statement.unit.kind === "percent") {
      if (draft.unit.kind !== "plain") continue;
      unit = statement.unit;
      unitExponent = -2;
    } else if (statement.unit.kind === "currency") {
      if (draft.unit.kind === "currency" && draft.unit.code !== statement.unit.code) continue;
      unit = statement.unit;
    } else if (statement.unit.kind === "other") {
      if (draft.unit.kind !== "plain") continue;
      unit = statement.unit;
    }
    readings.push({
      value: decimalValue(draft.core.number, statement.exponent + unitExponent, draft.negative),
      scale: 10 ** statement.exponent,
      scaleWord: statement.scaleWord,
      unit,
      decimals: decimalsOf(draft.core.number),
      precision: precisionOf(draft.core.number, statement.exponent + unitExponent),
    });
  }
  return readings;
}

function finish(
  draft: Draft,
  prepared: Prepared,
  text: string,
  statements: readonly Statement[],
  header: readonly Statement[],
): Figure {
  const written: Written = (span) => text.slice(prepared.from[span.from], prepared.to[span.to - 1]);
  const start = prepared.from[draft.from] as number;
  const end = prepared.to[draft.to - 1] as number;
  const base = readingOf(draft, written);
  const ambiguous: Ambiguity[] = [];
  const { core: found } = draft;
  if (found.otherReading) {
    const other = readingOf(draft, written, found.otherReading);
    ambiguous.push({ kind: "separator", readings: [base, other] });
  } else if (found.foreignDecimal) {
    ambiguous.push({ kind: "separator", readings: [base] });
  }
  if (draft.currencies.length > 1) {
    ambiguous.push({
      kind: "currency",
      readings: draft.currencies.map((code) => ({ ...base, unit: { kind: "currency", code } })),
    });
  }
  // Units stated twice, in the text and in its header too, give one reading that names both; one
  // that reads the figure as it is written leaves nothing to choose.
  const stated = new Map<string, Reading>();
  const add = (statedIn: "text" | "header") => (reading: Reading) => {
    const key = readingKey(reading);
    if (key === readingKey(base)) return;
    const known = stated.get(key);
    if (!known) stated.set(key, { ...reading, statedIn });
    else if (known.statedIn !== statedIn) known.statedIn = "both";
  };
  statedReadings(draft, statements).forEach(add("text"));
  statedReadings(draft, header).forEach(add("header"));
  if (stated.size > 0) ambiguous.push({ kind: "scale", readings: [base, ...stated.values()] });
  if (draft.signUnsure) {
    const positive = readingOf({ ...draft, negative: false }, written);
    ambiguous.push({
      kind: "sign",
      readings: [positive, readingOf({ ...draft, negative: true }, written)],
    });
  }
  if (draft.loosePoints !== null || draft.percentOrPoints) {
    const points = readingOf({ ...draft, unit: { kind: "points" }, unitExponent: -2 }, written);
    ambiguous.push({ kind: "points", readings: [base, points] });
  }
  let rangeTo: number | null = null;
  if (draft.rangeTo) {
    const other = readingOf(draft.rangeTo, written);
    rangeTo = other.value;
    ambiguous.push({ kind: "range", readings: [base, other] });
  }
  return {
    ...base,
    start,
    end,
    chars: text.slice(start, end),
    currency: draft.currencyAt ? written(draft.currencyAt) : null,
    approximate: draft.approximate,
    rangeTo,
    footnote: draft.footnote ? written(draft.footnote) : null,
    ambiguous,
  };
}

/** The numbers inside a date, read as plain figures when dates are asked for. */
function dateFigures(s: string, span: Span): Draft[] {
  const drafts: Draft[] = [];
  const numbers = new RegExp(`\\d+(?:\\.\\d+)?|${CNN}`, "g");
  for (const match of s.slice(span.from, span.to).matchAll(numbers)) {
    const from = span.from + match.index;
    const to = from + match[0].length;
    const written = match[0];
    let number: Digits | null = null;
    if (isDigit(written[0])) {
      const [whole = "", decimals = ""] = written.split(".");
      number = { digits: whole + decimals, point: whole.length };
    } else {
      const value = cnInteger(written);
      if (value !== null) number = integer(String(value));
    }
    if (!number) continue;
    drafts.push({
      from,
      to,
      core: core({ from, to }, number),
      negative: false,
      signUnsure: false,
      count: false,
      exponent: 0,
      scaleWord: null,
      scaleAt: null,
      unitExponent: 0,
      unit: { kind: "plain" },
      unitAt: null,
      currencies: [],
      currencyAt: null,
      loosePoints: null,
      percentOrPoints: false,
      approximate: false,
      footnote: null,
      rangeTo: null,
    });
  }
  return drafts;
}

/** The reader couldn't read a text: which figures it holds is unknown, which is never none (#2510). */
export class FiguresNotRead extends Error {
  readonly #text: string;

  constructor(text: string, cause: unknown) {
    super("The figures in a text couldn't be read.", { cause });
    this.name = "FiguresNotRead";
    this.#text = text;
  }

  /** The text it couldn't read, off the error's own fields so that a log of it shows none of a Document's words. */
  get text(): string {
    return this.#text;
  }
}

/**
 * Every figure in `text`, in order. `context` says what the text alone
 * can't: the Document's language and separators, what its "¥" is, and a
 * header whose stated scale applies. Throws `FiguresNotRead` when the text
 * can't be read.
 */
export function readFigures(text: string, context: FigureContext = {}): Figure[] {
  try {
    return figuresIn(text, context);
  } catch (error) {
    throw new FiguresNotRead(text, error);
  }
}

function figuresIn(text: string, context: FigureContext): Figure[] {
  const prepared = prepare(text, context.midLine);
  const { s } = prepared;
  const plain = settle(context);
  const statements = statementsIn(prepared, text, plain);
  const header =
    context.headerRead?.statements ??
    (context.header ? headerStatements(context.header, context, plain) : []);
  const settled = {
    ...plain,
    statedAmount: [...statements, ...header].some(
      (statement) => statement.exponent !== 0 || statement.unit.kind !== "percent",
    ),
    accounts: context.accounts ?? writesAccounts(s, [...statements, ...header]),
    negativeBrackets: context.negativeBrackets ?? SAYS_BRACKETS_NEGATIVE.test(s),
  };
  const dateSpans = datesIn(s);
  const blocked = [...statements, ...dateSpans].sort((a, b) => a.from - b.from);
  const dates = new Set(dateSpans);
  const drafts: Draft[] = [];
  let floor = 0;
  let at = 0;
  // `at` only moves on, so a span that ends at it or before is never looked at again.
  let open = 0;
  const blockedAt = () => {
    while ((blocked[open]?.to ?? Number.POSITIVE_INFINITY) <= at) {
      open++;
      steps++;
    }
    const span = blocked[open];
    return span && span.from <= at ? span : undefined;
  };
  while (at < s.length) {
    steps++;
    const span = blockedAt();
    if (span) {
      if (context.dates && dates.has(span) && span.from >= floor) {
        drafts.push(...dateFigures(s, span));
      }
      // Nothing after a stated unit or a date reaches back into it: "币种：人民币\n1,234.56".
      floor = Math.max(floor, span.to);
      at = Math.max(at + 1, span.to);
      continue;
    }
    const cores = coreAt(s, at, settled);
    if (!cores) {
      at++;
      continue;
    }
    if (cores.length === 0) {
      at = lexEnd(s, at);
      continue;
    }
    let next = at + 1;
    for (const found of cores) {
      const draft = readAround(prepared, found, floor, settled, drafts.at(-1));
      next = Math.max(next, found.to);
      if (!draft) {
        // The other end of a reference's or a year's range isn't a figure either: "pp. 3–5".
        const connector = matchAt(RANGE, s, found.to);
        if (connector && isDigit(s[found.to + connector[0].length]))
          next = lexEnd(s, found.to + connector[0].length);
        continue;
      }
      const figure = rangeAfter(prepared, draft, settled, blocked) ?? draft;
      if (!measured(figure)) continue;
      drafts.push(figure);
      floor = figure.to;
      next = Math.max(next, figure.to);
    }
    at = next;
  }
  const stated = distinctStatements(statements);
  const headed = distinctStatements(header);
  return drafts.map((draft) => finish(draft, prepared, text, stated, headed));
}

/** Each way a figure can be read: as written, and each reading of what isn't settled. */
export const readingsOf = (figure: Figure): Reading[] => [
  figure,
  ...figure.ambiguous.flatMap((each) => each.readings),
];

/** The currencies a figure may be in: its own, or each that its "¥" may be. */
export function currenciesOf(figure: Figure): string[] {
  return [
    ...new Set(
      readingsOf(figure).flatMap(({ unit }) => (unit.kind === "currency" ? [unit.code] : [])),
    ),
  ];
}

// A Document that says its amounts are in Canadian dollars writes them "$54,000".
const ANY_DOLLAR = ["USD", ...new Set(Object.values(DOLLARS))];
const SIGN_CURRENCIES: Readonly<Record<string, readonly string[]>> = {
  $: ANY_DOLLAR,
  dollar: ANY_DOLLAR,
  dollars: ANY_DOLLAR,
  元: ["CNY", ...Object.values(YUAN)],
  圆: ["CNY", ...Object.values(YUAN)],
  "¥": ["CNY", "JPY"],
};

// "￥" and "＄" are what Chinese input methods type for "¥" and "$" (#2226).
const signOf = (figure: Figure) => figure.currency?.normalize("NFKC").trim() ?? null;

/** Every currency a figure's own sign stands for in some Document: "$" or "dollars" for any dollar, "元" for yuan, or Hong Kong, Taiwan or Macau dollars. */
export const currenciesOfSign = (figure: Figure): readonly string[] => {
  const sign = signOf(figure);
  // "$54,000 AUD" is in the dollar it names, not in any dollar.
  if (sign !== null && BARE_DOLLAR.test(sign) && !bareDollar(figure)) return [];
  return (sign !== null && (SIGN_CURRENCIES[sign] ?? SIGN_CURRENCIES[sign.toLowerCase()])) || [];
};

const longestFirst = (words: readonly string[]) => [...words].sort((a, b) => b.length - a.length);
const CURRENCY_NAMES = new RegExp(
  `(?<![A-Za-z])(?:${longestFirst([...NAMED_CODES.keys(), "dollars"])
    .map((word) => word.replaceAll(".", "\\."))
    .join("|")})(?![A-Za-z])`,
  "gi",
);
const CURRENCY_WORDS = new RegExp(
  `(?<![A-Za-z])(?:${CURRENCY_ISO_CODES})(?![A-Za-z])|${longestFirst(
    Object.keys(CURRENCY_CODES).filter((word) => /^\p{Script=Han}{2,}$/u.test(word)),
  ).join("|")}`,
  "gu",
);
const CURRENCY_HEADING = new RegExp(`[(（](${CURRENCY_TOKEN.source})[)）]`, "g");
const CURRENCY_IN = new RegExp(`(?<![A-Za-z])in (${CURRENCY_TOKEN.source})(?! ?\\d)`, "g");
const NUMBER_CHAR = new RegExp(`[\\d\uff10-\uff19${CN_NUMERAL_CHARS}百千万亿]`);

// Reading a 2 MB Document's stated units takes over a second; only these lines can state a currency.
const UNIT_LINE =
  /单位|币种|[(（][^)）\n]{0,12}[元币镑][)）]|[亿万千百]元|\bin (?:thousands|millions|billions)\b|'000|\b000s\b|(?:[$€£¥]|\b[A-Z]{3}) ?(?:in )?(?:m|bn|mn|k|thousands?|millions?|billions?)\b/i;
const unitLinesOf = (text: string) =>
  text
    .split("\n")
    .filter((line) => UNIT_LINE.test(line))
    .join("\n");

function besideNumber(text: string, from: number, to: number): boolean {
  const before = text
    .slice(Math.max(0, from - 2), from)
    .replace(/[ \u00a0]$/, "")
    .at(-1);
  const after = text.slice(to, to + 2).replace(/^[ \u00a0]/, "")[0];
  return [before, after].some((char) => char !== undefined && NUMBER_CHAR.test(char));
}

/**
 * What standard units measure, as Documents write them in English and Chinese. A count ("employees",
 * "家", "岁") is no measure: what a Document counts is its own business, not a unit it must state.
 * A symbol is one letter or one character, which a word can hide; the rest are words.
 */
const MEASURES: Readonly<Record<string, { symbols: string; words: string }>> = {
  mass: {
    symbols: "t|g|吨|克",
    words:
      "tonnes?|tons?|kt|Mt|kg|kilograms?|grams?|mg|lbs?|ounces?|oz|k?t-?CO2e?|MtCO2e|千克|公斤|吨钢",
  },
  length: {
    symbols: "m|米",
    words:
      "km|kilomet(?:re|er)s?|met(?:re|er)s?|cm|centimet(?:re|er)s?|mm|millimet(?:re|er)s?|miles?|ft|feet|foot|inch(?:es)?|公里|千米|厘米|毫米",
  },
  area: {
    symbols: "亩",
    words:
      "m2|m²|㎡|km2|km²|sq\\.? ?ft|sq\\.? ?m|square (?:feet|foot|met(?:re|er)s?|kilomet(?:re|er)s?)|acres?|hectares?|ha|平方公里|平方米|平米|公顷",
  },
  volume: {
    symbols: "l|升|桶",
    words: "m3|m³|cubic met(?:re|er)s?|lit(?:re|er)s?|barrels?|bbl|立方米",
  },
  power: { symbols: "", words: "kW|MW|GW|(?:kilo|mega|giga)watts?|千瓦|兆瓦|吉瓦" },
  energy: { symbols: "", words: "kWh|MWh|GWh|TWh|(?:kilo|mega|giga)watt[- ]hours?|千瓦时|兆瓦时" },
};

// A symbol states its measure only where it is a unit, never as a letter or a character inside a word ("don't", e.g., T-shirt, 克服, 单位：克林工厂, 27m3).
const HAN = "[\\u3400-\\u9fff\\uf900-\\ufaff]";
const WHOLE_NAME = `(?!${HAN})`;
// A rate after a bare figure may go on with a particle ("540/吨的货物", "540/吨左右", "540/吨钢") but not a word ("2026/克林工厂").
const NAME_END = `(?:(?!${HAN})|(?=的|计|以|左右|、|和|与|及|或|钢))`;
// The words a symbol begins ("每升高", "每克拉", "美元/升级"), which a free name after 每 or a currency must not run into; a figure's own unit stays free ("50升到油箱", "3米其余").
const WORD_START: Readonly<Record<string, string>> = {
  克: "服|隆|制|拉",
  升: "高|级|值|至(?![0-9])|温|降|迁",
  米: "其林|兰|饭|粒",
};
const wordStart = (symbol: string) => {
  const words = WORD_START[symbol];
  return words ? `(?!${words})` : "";
};
// A Latin symbol stands alone, or is attached to a figure: a letter, apostrophe, dot or hyphen joins it to a word ("e.g.", "T-shirt"), a digit after it makes a product ("27m3"), and a Han scale or text beside it doesn't ("10万t", "60,000t左右").
const latinSymbol = (symbol: string) =>
  [
    `[0-9百千万亿][ \\u00a0\\-]?${symbol}(?![A-Za-z\\p{N}])(?![.\\-]\\p{L})`,
    `(?<![\\p{L}'’ʼ.\\-])${symbol}(?![\\p{L}\\p{N}])(?![.\\-]\\p{L})`,
  ].join("|");
// NFKC reads fullwidth digits as these; 百千万亿 scale a figure ("5.4万吨", "五万四千吨").
const HAN_AFTER_FIGURE = `[0-9百千万亿][ \\u00a0]?`;
const HAN_AFTER_RATE = `[0-9百千万亿][ \\u00a0]?[/⁄][ \\u00a0]?`;
// A price's currency before the slash leaves the unit free: "元/吨和运费", "美元/吨"; 元 at the end of 单元 is no currency.
const PRICE_CURRENCY = `(?:${CURRENCY_TOKEN.source}|(?<![单多公纪])元|(?<![汤团])圆|円)`;
const HAN_AFTER_CURRENCY = `${PRICE_CURRENCY}\\s*[/⁄][ \\u00a0]?`;
const HAN_AFTER_SLASH = `[/⁄][ \\u00a0]?`;
const HAN_AFTER_NUMERAL = `[〇零一二三四五六七八九十两][ \\u00a0]?`;
const HAN_AFTER_LABEL = `(?:单位\\s*(?:[:：]|为|是))\\s*`;
const HAN_AFTER_EACH = `每[ \\u00a0]?`;
// After a bare slash, a lone numeral or a label, a Han symbol must end its name there; a digit, 每 or a currency's slash leaves it free unless a word begins there ("54,000吨的货物", "每吨成本", "元/吨和运费").
const hanSymbol = (symbol: string) =>
  [
    `${HAN_AFTER_FIGURE}${symbol}`,
    `${HAN_AFTER_RATE}${symbol}${NAME_END}`,
    `${HAN_AFTER_CURRENCY}${symbol}${wordStart(symbol)}`,
    `${HAN_AFTER_SLASH}${symbol}${WHOLE_NAME}`,
    `${HAN_AFTER_NUMERAL}${symbol}${WHOLE_NAME}`,
    `${HAN_AFTER_LABEL}${symbol}${WHOLE_NAME}`,
    `${HAN_AFTER_EACH}${symbol}${wordStart(symbol)}`,
    `[(（]\\s*(?:[^)）\\n]{0,8}[/⁄][ \\u00a0]*)?${symbol}${WHOLE_NAME}[^)）\\n]{0,10}[)）]`,
  ].join("|");

const measureRule = ({ symbols, words }: { symbols: string; words: string }) => {
  const word = `(?<![A-Za-z])(?:${words})(?![A-Za-z])`;
  const singles = symbols.split("|").filter(Boolean);
  const latin = singles.filter((symbol) => /^[A-Za-z]$/.test(symbol)).map(latinSymbol);
  const han = singles.filter((symbol) => !/^[A-Za-z]$/.test(symbol)).map(hanSymbol);
  return new RegExp([word, ...latin, ...han].join("|"), "iu");
};

// The sign counts after letters ("YoY%", "Chgpp"); a word only where no letter runs into it ("apps").
const WRITES: Readonly<Record<string, RegExp>> = {
  percent: /[%‰]|(?<![A-Za-z])(?:per[ \n]?cent|percent|pcts?)(?![A-Za-z])|百分之|百分比/i,
  points:
    /个百分点|百分点|个基点|基点|个点|(?:pp|bp)(?![A-Za-z])|(?<![A-Za-z])(?:percentage[ \n]points?|points?|pts?|ppts?|pps|bps|basis[ \n]points?|p\.p\.)(?![A-Za-z])/i,
  ...Object.fromEntries(
    Object.entries(MEASURES).map(([name, units]) => [name, measureRule(units)]),
  ),
};

/** What `unit` measures: "percent", "points", or a standard unit's kind ("mass", "area"); null for a count. */
export function measureOf(unit: FigureUnit): string | null {
  if (unit.kind === "percent" || unit.kind === "points") return unit.kind;
  if (unit.kind !== "other") return null;
  const found = Object.entries(MEASURES).find(([, { symbols, words }]) =>
    new RegExp(`^(?:${[symbols, words].filter(Boolean).join("|")})$`, "i").test(unit.word),
  );
  return found?.[0] ?? null;
}

/**
 * Whether `text` writes any unit of `measure`: a word ("tonnes"), a Latin symbol that stands alone
 * ("54,000 t", "540 €/t", "(t, 2024)"), or, in Chinese, a symbol that names the unit after a figure,
 * a slash, a lone numeral or a unit line ("54,000吨", "元/吨", "一吨", "单位：吨"). Converting one
 * unit into another isn't attempted.
 */
export function writesMeasure(text: string, measure: string): boolean {
  return WRITES[measure]?.test(text.normalize("NFKC")) ?? false;
}

// A bare "$" or "dollars" says a dollar, not which one, in every language (#2226).
const BARE_DOLLAR = /^(?:\$|dollars?)$/i;
const NAMES_A_DOLLAR = new RegExp(
  `${longestFirst(
    Object.entries(CURRENCY_CODES)
      .filter(([, code]) => ANY_DOLLAR.includes(code))
      .map(([word]) => word),
  )
    .map((word) => word.replace(/[$.]/g, "\\$&"))
    .join("|")}|(?<![A-Za-z])(?:${ANY_DOLLAR.join("|")})(?![A-Za-z])`,
  "i",
);

/** Whether a figure's dollar is only its bare "$" or "dollars": "$54,000", not "$54,000 AUD". */
export const bareDollar = (figure: Figure): boolean =>
  BARE_DOLLAR.test(signOf(figure) ?? "") && !NAMES_A_DOLLAR.test(figure.chars.normalize("NFKC"));

export const isDollar = (code: string): boolean => ANY_DOLLAR.includes(code);

/** Whether `statement` gives a dollar by a bare "$" or "dollars": "Amount ($)", "($m)", "金额（$）". */
export function bareDollarStatement(statement: StatedUnit): boolean {
  if (statement.unit.kind !== "currency" || !ANY_DOLLAR.includes(statement.unit.code)) return false;
  const chars = statement.chars.normalize("NFKC");
  return (
    /(?<![A-Za-z])\$|(?<![A-Za-z])dollars?(?![A-Za-z])/i.test(chars) && !NAMES_A_DOLLAR.test(chars)
  );
}

/**
 * Every dollar `reading` of `figure` may be when nothing says which: by its own bare "$", or by a
 * bare "$" in the heading or unit line of `text` it is read under. Null when it is in a named one.
 */
export function unsaidDollars(
  figure: Figure,
  reading: Reading,
  text: string,
  context: FigureContext,
): readonly string[] | null {
  if (reading.unit.kind !== "currency" || !ANY_DOLLAR.includes(reading.unit.code)) return null;
  if (figure.currency !== null) return bareDollar(figure) ? ANY_DOLLAR : null;
  const { code } = reading.unit;
  const stated = readStatedUnits(text, context).filter(
    ({ unit }) => unit.kind === "currency" && unit.code === code,
  );
  return stated.length > 0 && stated.every(bareDollarStatement) ? ANY_DOLLAR : null;
}

/**
 * The currencies `text` names, by ISO 4217 code: in words ("paid in Pounds Sterling", "币种：人民币"),
 * in a unit it states ("单位：元", "Salary (£)", "in £'000", "All figures are in £") and on
 * `figures`, its figures as read. With no figures given (null), the currency on its figures counts
 * only when they all carry the same one: a Document that mixes "HK$" and "$" says nothing of a
 * plain "54,000". With `which`, only a currency it names by which counts: a bare "$" or "dollars"
 * names none, "Australian dollars", "AUD" and "A$" do.
 */
export function namedCurrencies(
  written: string,
  context: FigureContext,
  figures: readonly Figure[] | null,
  which = false,
): Set<string> {
  const text = normaliseCurrencies(written);
  const settled = settle(context);
  const named = new Set<string>();
  const add = (codes: readonly string[]) => {
    for (const code of codes) named.add(code);
  };
  for (const { code } of currencyMentions(text, context, settled, which, figures === null))
    add([code]);
  // Another figure's "HK$10m" says nothing of which dollar a bare "$54m" is.
  if (which) return named;
  if (figures) {
    for (const figure of figures) add(currenciesOf(figure));
    return named;
  }
  const onFigures = new Map<string, string[]>();
  for (const match of text.matchAll(CURRENCY_ANYWHERE)) {
    if (!besideNumber(text, match.index, match.index + match[0].length)) continue;
    const codes = currencyCodesOf(match[0], settled, which);
    if (codes.length > 0) onFigures.set(codes.join(), codes);
  }
  const [only] = onFigures.values();
  if (onFigures.size === 1 && only) add(only);
  return named;
}

// "以港幣支付" names the Hong Kong dollar as "以港币支付" does, and "（＄）" as "($)".
const normaliseCurrencies = (written: string) =>
  written.normalize("NFKC").replace(/\p{Script=Han}/gu, (char) => SIMPLIFIED.get(char) ?? char);

const currencyCodesOf = (word: string, settled: Settled, which: boolean) =>
  which && BARE_DOLLAR.test(word.trim()) ? [] : currencyCodes(word, settled);

interface CurrencyMention {
  code: string;
  /** Where in the normalised text it stands; -1 for one a unit line states. */
  at: number;
}

/** Every place `text` names a currency: its words or code in body text, a heading, "in …", or a unit line. */
function currencyMentions(
  text: string,
  context: FigureContext,
  settled: Settled,
  which: boolean,
  unitLinesOnly: boolean,
): CurrencyMention[] {
  const found: CurrencyMention[] = [];
  const add = (codes: readonly string[], at: number) => {
    for (const code of codes) found.push({ code, at });
  };
  for (const pattern of [CURRENCY_NAMES, CURRENCY_WORDS]) {
    for (const match of text.matchAll(pattern)) {
      if (!besideNumber(text, match.index, match.index + match[0].length))
        add(currencyCodesOf(match[0], settled, which), match.index);
    }
  }
  for (const pattern of [CURRENCY_HEADING, CURRENCY_IN]) {
    for (const match of text.matchAll(pattern))
      add(currencyCodesOf(match[1] ?? "", settled, which), match.index);
  }
  for (const stated of readStatedUnits(unitLinesOnly ? unitLinesOf(text) : text, context)) {
    if (stated.unit.kind === "currency" && !(which && bareDollarStatement(stated)))
      add([stated.unit.code], -1);
  }
  return found;
}

/** The most characters of a Document line the card shows, a window around the words that name the currency (#2226). */
const CURRENCY_LINE_CHARS_AT_MOST = 120;
/** The most naming lines looked in, so a Document that names a currency on every line stays fast (#2226). */
const MOST_CLAUSE_LINES = 200;

const clauseWindow = (line: string, at: number, chars: number): string => {
  if (line.length <= chars) return line.trim();
  const room = chars - 2;
  const from = Math.max(0, Math.min(at - Math.floor(room / 2), line.length - room));
  const start = graphemeBoundary(line, from);
  const end = graphemeBoundary(line, Math.min(line.length, start + room));
  return `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`;
};

/** `at`'s line among starts sorted by position, the last start at or before it. */
const lineAt = (starts: readonly number[], at: number): number => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] as number) <= at) low = mid;
    else high = mid - 1;
  }
  return low;
};

/** The original line's offset for a position in its normalised words ("™" grows to "TM", "½" to "1⁄2"). */
const originalOffset = (line: string, at: number): number => {
  let seen = 0;
  let offset = 0;
  for (const char of line) {
    if (seen >= at) break;
    seen += normaliseCurrencies(char).length;
    offset += char.length;
  }
  return offset;
};

/**
 * The earliest line of `written` that names which currency one of `codes` is, by the same words,
 * codes, headings, unit lines and definitions `namedCurrencies` reads when asked `which`, and that
 * `accept` takes when it is given: at most `CURRENCY_LINE_CHARS_AT_MOST` characters around those
 * words; null when no line does (#2226).
 */
export function currencyNamingLine(
  written: string,
  context: FigureContext,
  codes: ReadonlySet<string>,
  accept?: (line: string) => boolean,
): string | null {
  const text = normaliseCurrencies(written);
  const settled = settle(context);
  const lines = written.split(LINE_BREAK);
  const starts: number[] = [];
  let start = 0;
  for (const line of text.split(LINE_BREAK)) {
    starts.push(start);
    start += line.length + 1;
  }
  const unitLines = new Map<string, number>();
  const unitLineFor = (code: string): number => {
    const known = unitLines.get(code);
    if (known !== undefined) return known;
    const found = lines.findIndex(
      (line) =>
        UNIT_LINE.test(line) &&
        readStatedUnits(line, context).some(
          (stated) => stated.unit.kind === "currency" && stated.unit.code === code,
        ),
    );
    unitLines.set(code, found);
    return found;
  };
  const candidates = new Map<number, number>();
  for (const { code, at } of currencyMentions(text, context, settled, true, true)) {
    if (!codes.has(code)) continue;
    const index = at < 0 ? unitLineFor(code) : lineAt(starts, at);
    if (index < 0) continue;
    const within = at < 0 ? 0 : at - (starts[index] as number);
    const known = candidates.get(index);
    if (known === undefined || within < known) candidates.set(index, within);
  }
  for (const index of [...candidates.keys()].sort((a, b) => a - b).slice(0, MOST_CLAUSE_LINES)) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || (accept && !accept(line))) continue;
    const within = originalOffset(line, candidates.get(index) ?? 0);
    return clauseWindow(line, within, CURRENCY_LINE_CHARS_AT_MOST);
  }
  return null;
}

/** The end of a run of digits and separators that isn't a number, so none of it is read. */
function lexEnd(s: string, at: number): number {
  let end = at;
  while (isDigit(s[end]) || ((s[end] === "." || s[end] === ",") && isDigit(s[end + 1]))) end++;
  return end;
}
