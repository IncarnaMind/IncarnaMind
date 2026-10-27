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
import { SIMPLIFIED } from "./hanVariants";
import { normaliseWithOffsets } from "./text";

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
  /** What "¥" stands for in the Document, when its text says. */
  yen?: "CNY" | "JPY" | null;
  /** A table header or caption that applies to the text: the scale or currency it states. */
  header?: string | null;
  /** Read years, dates, quarters and periods as plain figures too. */
  dates?: boolean;
  /**
   * The Document is accounts (see `figureContextOf`), so a whole number in
   * brackets in one of its table rows or statement lines is negative. Left
   * out, it is worked out from the text read.
   */
  accounts?: boolean;
  /**
   * The text starts inside a line of its Document, as a quote from the middle of one does: a
   * number at its start is neither a list's nor a heading's (#1969).
   */
  midLine?: boolean;
}

/** A scale or unit stated apart from the figures it applies to: "单位：万元", "(in millions)". */
export interface StatedUnit {
  start: number;
  end: number;
  chars: string;
  scale: number;
  scaleWord: string | null;
  unit: FigureUnit;
}

// The text as the reader reads it ------------------------------------------

/** A footnote mark or a circled number, which NFKC would otherwise turn into a digit beside the figure. */
const MARK = "\ue000";
/** A no-break or thin space: nobody puts one between two separate numbers, so it always groups. */
const NBSP = "\u00a0";

const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/;
const SUPERSCRIPT = /^[\u00b2\u00b3\u00b9\u2070-\u207f\u2460-\u24ff\u2776-\u2793]$/u;
const SPACE_LIKE = /^[\u00a0\u2007\u2009\u202f]$/;
const FULL_WIDTH_DIGIT = /^[\uff10-\uff19]$/;
const LATIN_LETTER = /^[A-Za-z]$/;
/** A length that "²" or "³" raises to a power ("m²", "km³"): there they are digits, not footnote marks. */
const POWER_AFTER = /(?<![A-Za-z])(?:m|km|cm|mm|ft)$/;

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
  let previousEnd = 0;
  for (const unit of units) {
    if (unit.removed) continue;
    const gap = text.slice(previousEnd, unit.start);
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
    } else if (
      SUPERSCRIPT.test(original) &&
      !POWER_AFTER.test(text.slice(Math.max(0, unit.start - 3), unit.start))
    ) {
      char = MARK;
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
    if (char === "\n") lineStarts.add(s.length + 1);
    s += char;
    from.push(unit.start);
    to.push(unit.end);
  }
  return { s, from, to, lineStarts, spaced, tabbed };
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

/** The separators a text's own numbers show, when they agree; null when they don't or none tells. */
function separatorsIn(s: string): Separators | null {
  const counts = new Map<string, { separators: Separators; count: number }>();
  for (const [pattern, separators] of EVIDENCE) {
    const found = s.match(pattern)?.length ?? 0;
    if (found === 0) continue;
    const key = `${separators.decimal}${separators.group}`;
    const known = counts.get(key);
    counts.set(key, { separators, count: (known?.count ?? 0) + found });
  }
  const byDecimal = (decimal: string) =>
    [...counts.values()]
      .filter((entry) => entry.separators.decimal === decimal)
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
  const prepared = prepare(text);
  const { s } = prepared;
  const cny = CNY_WORDS.test(s);
  const jpy = JPY_WORDS.test(s);
  return {
    language: language ?? null,
    separators: separatorsIn(s),
    yen: cny && !jpy ? "CNY" : jpy && !cny ? "JPY" : null,
    accounts: writesAccounts(s, statementsIn(prepared, text, settle({ language }))),
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
}

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
  if (context.yen) yen = [context.yen];
  else if (tag?.language === "zh" && !traditional) yen = ["CNY"];
  else if (tag?.language === "ja") yen = ["JPY"];
  return {
    decimal: separators?.decimal ?? null,
    spaceGroups: separators?.group === " ",
    dollar: DOLLARS[region] ?? "USD",
    yuan: YUAN[region] ?? "CNY",
    yen,
    dates: context.dates === true,
    chinese: tag?.language === "zh",
    accounts: context.accounts === true,
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
  百: 2,
};
const CN_SCALE_AFTER = /万亿|千亿|百亿|十亿|千万|百万|十万|亿|万|千(?![克米瓦帕焦卡])|百(?!分)/y;

const EN_SCALES: Readonly<Record<string, number>> = {
  trillion: 12,
  tn: 12,
  trn: 12,
  billion: 9,
  bn: 9,
  b: 9,
  million: 6,
  mn: 6,
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

const CURRENCY_ISO_CODES =
  "USD|CNY|RMB|Rmb|HKD|EUR|GBP|JPY|AUD|CAD|SGD|TWD|CHF|INR|KRW|NZD|MOP|BRL|RUB|SEK|NOK|DKK|ZAR|MXN|THB|MYR|IDR|PHP|VND|TRY|SAR|AED";
const CURRENCY_TOKEN = new RegExp(
  `(?:(?<![A-Za-z])(?:US|HK|AU|CA|NZ|SG|NT|MX|A|C|S|R)?\\$|CN¥|JP¥|[¥€£₹₩₽₺฿₫₱]|(?<![A-Za-z])(?:${CURRENCY_ISO_CODES}|Rs\\.?)|人民币|美元|港币|港元|欧元|日元|英镑)`,
);
/** Currency signs before a number, and codes and names before it, with a space allowed. */
const CURRENCY_BEFORE = new RegExp(`${CURRENCY_TOKEN.source}[ \\u00a0]?$`);

const CURRENCY_CODES: Readonly<Record<string, string>> = {
  US$: "USD",
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

// Contracts write "in Pounds Sterling" and "ALL AMOUNTS ARE IN US DOLLARS".
const NAMED_CODES = new Map(
  Object.entries(CURRENCY_CODES)
    .filter(([word]) => /^[a-z]/.test(word) || /^[A-Za-z.]+(?: [A-Za-z]+)+$/.test(word))
    .map(([word, code]) => [word.toLowerCase(), code]),
);

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

function amountBefore(s: string, at: number, settled: Settled): string[] | null {
  const line = s.slice(s.lastIndexOf("\n", at - 1) + 1, at).trimEnd();
  const last = [...line.matchAll(CURRENCY_ANYWHERE)].at(-1);
  if (!last || !(AMOUNT_ENDS.test(line) || last.index + last[0].length === line.length))
    return null;
  return currencyCodes(last[0], settled);
}

const AMOUNTS_ONLY =
  /^(?:[\s|.,;()（）%‰+\-–—−\d万亿千元圆\ue000]|\p{Sc}|(?:CR|DR|Cr|Dr)(?![A-Za-z])|(?:thousand|million|billion|trillion|tn|bn|mn|[kKmMbB])(?![A-Za-z]))*$/u;
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

function namesCount(prepared: Prepared, at: number): boolean {
  const { s } = prepared;
  const lead = s.slice(s.lastIndexOf("\n", at - 1) + 1, at);
  const label = /^[^\d(\p{Sc}]*/u.exec(lead)?.[0] ?? "";
  return [label, lead].some((words) => {
    const end = words.slice(-100).replace(/[\s|]+$/, "");
    return COUNT_LABEL.test(end) && !MONEY_FOR_PEOPLE.test(end.replace(/\bnumbers? of\b/gi, ""));
  });
}

function rowOf(prepared: Prepared, from: number, to: number): "table" | "statement" | null {
  const { s, tabbed } = prepared;
  const start = s.lastIndexOf("\n", from - 1) + 1;
  const stop = s.indexOf("\n", to);
  const end = stop < 0 ? s.length : stop;
  if (!AMOUNTS_ONLY.test(s.slice(to, end))) return null;
  let cell = from;
  while (s[cell - 1] === " " && cell - 1 >= start) cell--;
  const startsCell =
    cell === start || s[cell - 1] === "\t" || s[cell - 1] === "|" || tabbed.has(cell);
  let delimited = /[\t|]/.test(s.slice(start, end));
  for (let at = start + 1; !delimited && at <= end; at++) delimited = tabbed.has(at);
  if (startsCell && delimited) return "table";
  const lead = s.slice(start, from);
  const label = (/^[^\d(（\p{Sc}]*/u.exec(lead)?.[0] ?? "").replace(/^[\s|]+|[\s|]+$/g, "");
  const prose =
    label === "" ||
    label.length > 60 ||
    !LABEL_START.test(label) ||
    PROSE_START.test(label) ||
    /[,，;；。]|\. /.test(label) ||
    LABEL_REFERENCE.test(label);
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
  "人次 岁 度 户 人 名 家 个 辆 台 套 件 只 头 股 手 张 份 项 座 所 架 艘 部 位 款 条 片 块 箱 次 例 床 间 栋".split(
    " ",
  );
const CN_MEASURE_AFTER = new RegExp(CN_MEASURES.join("|"), "y");
// "所" counts schools ("3所学校"), but "表3所示" is "as table 3 shows".
const CN_COUNT_AFTER = new RegExp(CN_COUNTS.join("|").replace("所", "所(?![示述列载有以在])"), "y");
const EN_UNIT_AFTER =
  /[ \n]?(?:users?|customers?|clients?|subscribers?|members?|employees?|staff|people|persons?|patients?|students?|visitors?|households?|homes?|stores?|outlets?|branches|branch|restaurants?|vehicles?|cars?|units?|shares?|tonnes?|tons?|kt|Mt|kg|mg|lbs?|ounces?|oz|barrels?|bbl|boe|bcf|tcf|km\/h|km2|km|m2|m3|sq ft|square (?:feet|foot|metres?|meters?)|(?:kilo|centi|milli)?(?:metres?|meters?)|miles?|feet|foot|inches|mph|acres?|hectares?|(?:mega|kilo|giga)watt[- ]hours?|(?:mega|kilo|giga)watts?|MWh|GWh|kWh|TWh|MW|GW|kW|mAh|litres?|liters?|MtCO2e|ktCO2e|tCO2e|tCO2|°C|°F)(?![A-Za-z0-9])/y;

/** Written before a figure that is approximate or a bound; outside its characters. */
const APPROXIMATE_BEFORE =
  /(?:(?<![A-Za-z])(?:[Aa]bout|[Aa]pproximately|[Aa]pprox\.?|[Aa]round|[Rr]oughly|[Nn]early|[Aa]lmost|[Cc]lose to|[Ss]ome|[Cc]irca|[Cc]a?\.|[Oo]ver|[Mm]ore than|[Ll]ess than|[Ff]ewer than|[Uu]nder|[Uu]p to|[Aa]t least|[Aa]t most|[Ii]n excess of|[Uu]pwards of|[Jj]ust over|[Jj]ust under|[Bb]elow|[Aa]bove) ?|[~≈] ?|约为|约合|大约|大概|约|将近|接近|近|逾|超过|不超过|超|不到|不足|至少|最多)$/;
const APPROXIMATE_AFTER =
  /左右|上下|以上|以下|以内|有余|\+(?![\d])| or so(?![A-Za-z])|-odd(?![A-Za-z])/y;

/** A footnote mark stuck to a figure: "¹", "*", "†", "(a)", "[1]", "(1)". */
const FOOTNOTE_AFTER = new RegExp(
  `${MARK}+|\\*+(?![\\d])|[†‡]|\\([a-z]\\)|\\[(?:\\d{1,3}|[a-z])\\]|\\(\\d{1,2}\\)(?![\\d.,])`,
  "y",
);

/** Words before a number that make it a reference, an ordinal, a name or a vague count ("数十亿"), not a figure. */
const REFERENCE_BEFORE =
  /(?:(?<![A-Za-z])(?:p|pp|pages?|[Nn]otes?|[Ss]ections?|[Ss]ec|[Tt]ables?|[Ff]igures?|[Ff]ig|[Cc]hapters?|[Cc]h|[Ii]tems?|[Aa]rticles?|[Aa]rt|[Ee]xhibits?|[Aa]ppendix|[Ss]chedules?|IFRS|IAS|ISO|ASC|ASU|[Ll]evel|[Tt]ier|[Ss]cope|[Pp]hase|[Ss]tage|[Vv]ersion|[Ss]tep|[Rr]ule|[Pp]art|[Nn]o|[Nn]os|[Vv]ol|[Vv]olume|[Ii]ssue|[Cc]lause|[Pp]aragraph|[Pp]ara|[Ll]ine|[Rr]ow|[Cc]olumn|[Ss]lides?|S&P|FTSE|Russell|Nikkei|Fortune|Nasdaq|CSI|Top|[Bb]ullet)\.? ?|#|№|第|附注|沪深|中证|上证|深证|代码[:：]?|数|几|若干)$/;
/** "表3", "图1", "注2": references, unless a measure follows, as in "代表3名" (represents 3). */
const LOOSE_REFERENCE_BEFORE = /[表图注]$/;

// Dates, periods and statements ----------------------------------------------

const CN_NUMERAL_CHARS = "〇零一二三四五六七八九十两";
const CNN = `[${CN_NUMERAL_CHARS}]+`;
const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";

/** When something happened, not how much: not figures unless asked for. */
const DATES: readonly RegExp[] = [
  /(?<![\d.])\d{4} ?[-/.] ?\d{1,2} ?[-/.] ?\d{1,2}(?![\d])/g,
  /(?<![\d.,])\d{1,2}[-/.]\d{1,2}[-/.](?:\d{4}|\d{2})(?![\d.])/g,
  /(?<![\d.,])(?:19|20)\d{2} ?[-/~至到] ?(?:(?:19|20)\d{2}|\d{1,2})(?![\d.,%])/g,
  /(?<![\d.,])\d{1,4}\/\d{1,4}(?![\d.,])/g,
  new RegExp(
    `(?:(?:\\d+(?:\\.\\d+)?|${CNN}) ?[-~至到] ?)?(?:\\d+(?:\\.\\d+)?|${CNN})年(?:度|代|底|初|末|中)?`,
    "g",
  ),
  new RegExp(
    `(?:\\d{1,2}|${CNN}) ?(?:[-~至到] ?(?:\\d{1,2}|${CNN}) ?)?月(?:份)?(?:(?:\\d{1,2}|${CNN})[日号])?`,
    "g",
  ),
  new RegExp(`(?:\\d{1,2}|${CNN})[日号](?![元圆])`, "g"),
  new RegExp(
    `(?:(?:\\d+(?:\\.\\d+)?|${CNN}) ?[-~至到] ?)?(?:\\d+(?:\\.\\d+)?|${CNN}) ?(?:个月|个季度|季度|个?星期|周|天|小时|分钟|秒钟?|个工作日|工作日)`,
    "g",
  ),
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

/** Where dates and periods are, in positions of the prepared text. */
function datesIn(s: string): Span[] {
  const spans: Span[] = [];
  for (const pattern of DATES) {
    for (const match of s.matchAll(pattern)) {
      spans.push({ from: match.index, to: match.index + match[0].length });
    }
  }
  return spans;
}

/** A stated unit in positions of the prepared text, its words as written. */
interface Statement extends Span {
  exponent: number;
  scaleWord: string | null;
  unit: FigureUnit;
}

const CN_UNIT_WORDS = "新加坡元|新台币|人民币|美元|港元|港币|欧元|日元|英镑|澳元|加元|元";
const STATEMENTS: readonly RegExp[] = [
  new RegExp(
    `(?:金额|货币|数量)?单位[:：]?(?<before>人民币|美元|港元|港币|欧元|日元|英镑)?(?<scale>万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千|百)?(?<unit>${CN_UNIT_WORDS}|吨|股|人次|人|户|家|个|%|辆|台|套)?`,
    "dg",
  ),
  /币种[:：]?(?<before>人民币|美元|港元|港币|欧元|日元|英镑)/dg,
  new RegExp(
    `[(（](?<before>人民币|RMB|美元|USD|港元|港币|HK\\$)?(?<scale>十亿|亿|千万|百万|万|千)?(?<unit>${CN_UNIT_WORDS}|股|%)[)）]`,
    "dg",
  ),
  new RegExp(
    `(?<![${CN_NUMERAL_CHARS}\\d.,百千万亿])(?<before>人民币|RMB)?(?<scale>亿|千万|百万|万|千)(?<unit>${CN_UNIT_WORDS})`,
    "dg",
  ),
  /(?<![A-Za-z])in (?<scale>thousands|millions|billions)(?: of (?<cur>U\.?S\.? dollars|US dollars|Hong Kong dollars|HK dollars|dollars|euros|[Rr]enminbi|RMB|yuan|pounds sterling|pounds|yen))?(?![A-Za-z])/dgi,
  /(?<![\dA-Za-z.,])(?<cur>US\$|HK\$|A\$|C\$|S\$|NT\$|\$|€|£|¥|USD|RMB|CNY|HKD|EUR|GBP|JPY|AUD|CAD|SGD|TWD|CHF)[ \u00a0]?(?:in )?(?<scale>'000s?|000s|thousands?|millions?|billions?|mn|bn|m|k)(?![A-Za-z0-9])(?![ \u00a0]?[\d(-])/dg,
  /[(（]%[)）]|(?<![A-Za-z])in (?:%|per cent|percent)(?![A-Za-z])/dg,
];

/** The power of ten a scale word multiplies by: 8 for "亿", 6 for "million" or "m"; 0 for a word that isn't one. */
export function scaleExponent(word: string): number {
  const lower = word.toLowerCase().replace(/s$/, "");
  if (CN_SCALES[word] !== undefined) return CN_SCALES[word];
  if (lower === "'000" || lower === "000") return 3;
  return EN_SCALES[lower] ?? 0;
}

/** The unit a currency or unit word names, with the context's "$", "元" and "¥". */
function currencyCodes(word: string, settled: Settled): string[] {
  const trimmed = word.trim();
  if (trimmed === "$" || trimmed.toLowerCase() === "dollars") return [settled.dollar];
  if (trimmed === "元" || trimmed === "圆") return [settled.yuan];
  if (trimmed === "¥") return settled.yen;
  const code = CURRENCY_CODES[trimmed] ?? NAMED_CODES.get(trimmed.toLowerCase());
  if (code) return [code];
  return /^[A-Z]{3}$/.test(trimmed) ? [trimmed] : [];
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
      const words = groups.unit ?? groups.before ?? groups.cur ?? null;
      let unit: FigureUnit = { kind: "plain" };
      if (match[0].includes("%") || /per ?cent/i.test(match[0])) unit = { kind: "percent" };
      else if (words) {
        const codes = currencyCodes(words, settled);
        const code = codes.length === 1 ? codes[0] : undefined;
        if (code) unit = { kind: "currency", code };
        else if (!/[$¥]/.test(words))
          unit = { kind: "other", word: written(at.unit ?? at.before ?? at.cur) ?? words };
      }
      if (!scale && unit.kind === "plain") continue;
      found.push({
        from: match.index,
        to: match.index + match[0].length,
        exponent: scale ? scaleExponent(scale) : 0,
        scaleWord: written(at.scale),
        unit,
      });
    }
  }
  // "单位：万元" is one statement, though its "万元" alone would be one too.
  const kept: Statement[] = [];
  for (const statement of found.sort((a, b) => a.from - b.from || b.to - a.to)) {
    if (!kept.some((other) => statement.from < other.to && other.from < statement.to))
      kept.push(statement);
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
  return statements.map((statement) => {
    const start = prepared.from[statement.from] as number;
    const end = prepared.to[statement.to - 1] as number;
    return {
      start,
      end,
      chars: text.slice(start, end),
      scale: 10 ** statement.exponent,
      scaleWord: statement.scaleWord,
      unit: statement.unit,
    };
  });
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

function lexArabic(s: string, start: number): Lexeme {
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
    const groupEnd = digitsEnd(end + 1);
    lexeme.separators.push(separator === NBSP ? " " : separator);
    lexeme.groups.push(s.slice(end + 1, groupEnd));
    lexeme.at.push(end + 1);
    end = groupEnd;
  }
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

/**
 * Reads the separators of a run of digits. A separator is decided by the
 * number itself where it can be ("1,234.5", "1.234.567"), then by the
 * context; where neither decides, both readings are kept.
 */
function readLexeme(s: string, lexeme: Lexeme, settled: Settled): Core[] {
  const { groups, at } = lexeme;
  // A plain space groups only where the Document's numbers group with spaces: elsewhere "12 345" is two cells.
  const cut = lexeme.separators.findIndex(
    (separator, index) =>
      separator === " " && !settled.spaceGroups && s[(at[index + 1] as number) - 1] !== NBSP,
  );
  const count = cut < 0 ? lexeme.separators.length : cut;
  return readGroups(s, groups.slice(0, count + 1), lexeme.separators.slice(0, count), at, settled);
}

function readGroups(
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
    return groups.map((group, index) =>
      core({ from: at[index] as number, to: end(index) }, integer(group)),
    );
  }
  // Mixed and not one number: the longest start that is one, then the rest.
  for (let count = separators.length - 1; count >= 1; count--) {
    const head = readGroups(s, groups.slice(0, count + 1), separators.slice(0, count), at, settled);
    if (head.length === 1 && head[0]?.to === end(count)) {
      return [
        ...head,
        ...readGroups(
          s,
          groups.slice(count + 1),
          separators.slice(count + 1),
          at.slice(count + 1),
          settled,
        ),
      ];
    }
  }
  return groups.map((group, index) =>
    core({ from: at[index] as number, to: end(index) }, integer(group)),
  );
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

/** A Chinese numeral starting at `start`, read with the scale it ends in, or null. */
function lexChinese(s: string, start: number): Core | null {
  let end = start;
  while (isCnNumeral(s[end]) || (s[end] === "点" && isCnDigit(s[end + 1]) && end > start)) end++;
  const run = s.slice(start, end);
  const point = run.indexOf("点");
  const span = { from: start, to: end };
  const capitals = CAPITALS.test(run);
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
    const cores = readLexeme(s, lexArabic(s, at), settled);
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
    if (isDigit(s[after])) inner = readLexeme(s, lexArabic(s, after), settled)[0] ?? null;
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

/** Reads the words around a number into a figure; null when it isn't one (a year, a reference, a word). */
function readAround(
  prepared: Prepared,
  found: Core,
  floor: number,
  settled: Settled,
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
    }
  }
  const currencyAfter =
    found.percent === null
      ? (take(CN_CURRENCY_AFTER) ?? take(EN_CURRENCY_AFTER) ?? take(SIGN_AFTER))
      : null;
  if (currencyAfter) {
    const codes = currencyCodes(currencyAfter.word.replace(/(.)人民币$/, "$1"), settled);
    // "¥3,500元": the word after settles the sign before.
    if (draft.currencies.length === 0 || codes.every((code) => draft.currencies.includes(code)))
      draft.currencies = codes;
    else draft.currencies = [...new Set([...draft.currencies, ...codes])];
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
    const negate = () => {
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
      const before = codes.length > 0 ? amountBefore(s, outer?.from ?? bracket, settled) : null;
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
  if (blocked.some((span) => span.from <= at && at < span.to)) return null;
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
  for (const statement of statements) {
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
  const stated = statedReadings(draft, statements);
  if (stated.length > 0) ambiguous.push({ kind: "scale", readings: [base, ...stated] });
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

/**
 * Every figure in `text`, in order. `context` says what the text alone
 * can't: the Document's language and separators, what its "¥" is, and a
 * header whose stated scale applies.
 */
export function readFigures(text: string, context: FigureContext = {}): Figure[] {
  const prepared = prepare(text, context.midLine);
  const { s } = prepared;
  const plain = settle(context);
  const statements = statementsIn(prepared, text, plain);
  const header = context.header ? headerStatements(context.header, context, plain) : [];
  const settled = {
    ...plain,
    accounts: context.accounts ?? writesAccounts(s, [...statements, ...header]),
  };
  const dateSpans = datesIn(s);
  const blocked = [...statements, ...dateSpans].sort((a, b) => a.from - b.from);
  const dates = new Set(dateSpans);
  const drafts: Draft[] = [];
  let floor = 0;
  let at = 0;
  while (at < s.length) {
    const span = blocked.find((each) => each.from <= at && at < each.to);
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
      const draft = readAround(prepared, found, floor, settled);
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
  return drafts.map((draft) => finish(draft, prepared, text, [...statements, ...header]));
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

/** Every currency a figure's own sign stands for in some Document: "$" or "dollars" for any dollar, "元" for yuan, or Hong Kong, Taiwan or Macau dollars. */
export const currenciesOfSign = (figure: Figure): readonly string[] =>
  (figure.currency !== null &&
    (SIGN_CURRENCIES[figure.currency] ?? SIGN_CURRENCIES[figure.currency.toLowerCase()])) ||
  [];

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
 * The currencies `text` names, by ISO 4217 code: in words ("paid in Pounds Sterling", "币种：人民币"),
 * in a unit it states ("单位：元", "Salary (£)", "in £'000", "All figures are in £") and on
 * `figures`, its figures as read. With no figures given (null), the currency on its figures counts
 * only when they all carry the same one: a Document that mixes "HK$" and "$" says nothing of a
 * plain "54,000".
 */
export function namedCurrencies(
  text: string,
  context: FigureContext,
  figures: readonly Figure[] | null,
): Set<string> {
  const settled = settle(context);
  const named = new Set<string>();
  const add = (codes: readonly string[]) => {
    for (const code of codes) named.add(code);
  };
  for (const pattern of [CURRENCY_NAMES, CURRENCY_WORDS]) {
    for (const match of text.matchAll(pattern)) {
      if (!besideNumber(text, match.index, match.index + match[0].length))
        add(currencyCodes(match[0], settled));
    }
  }
  for (const pattern of [CURRENCY_HEADING, CURRENCY_IN]) {
    for (const match of text.matchAll(pattern)) add(currencyCodes(match[1] ?? "", settled));
  }
  for (const stated of readStatedUnits(figures ? text : unitLinesOf(text), context)) {
    if (stated.unit.kind === "currency") add([stated.unit.code]);
  }
  if (figures) {
    for (const figure of figures) add(currenciesOf(figure));
    return named;
  }
  const onFigures = new Map<string, string[]>();
  for (const match of text.matchAll(CURRENCY_ANYWHERE)) {
    if (!besideNumber(text, match.index, match.index + match[0].length)) continue;
    const codes = currencyCodes(match[0], settled);
    if (codes.length > 0) onFigures.set(codes.join(), codes);
  }
  const [only] = onFigures.values();
  if (onFigures.size === 1 && only) add(only);
  return named;
}

/** The end of a run of digits and separators that isn't a number, so none of it is read. */
function lexEnd(s: string, at: number): number {
  let end = at;
  while (isDigit(s[end]) || ((s[end] === "." || s[end] === ",") && isDigit(s[end + 1]))) end++;
  return end;
}
