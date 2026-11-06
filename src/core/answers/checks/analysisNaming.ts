/**
 * Whether a sentence's own words for an Analysis's figure can stand as naming it (#2378). It is a
 * filter on the claim judge's "same", never a judge: it only ever takes Supported away, leaving the
 * figure Not checked. No code reads a name well enough to call it right, so this one reads a closed
 * set of words: the figure's own clause holds every word of its label, and nothing else but the
 * Analysis's own words for its input and columns and words that only link a figure to its name.
 * Any other word, a qualifier, a period, a change, a negation or another group, leaves it unchecked,
 * and so does a sign or symbol, a target, a rate per item, or a scale, currency or percent said
 * around it that its run doesn't back (#2544).
 */
import { AGGREGATE_WORDS } from "../../../shared/analysis";
import {
  CURRENCY_ISO_CODES,
  currencyNamed,
  type FigureUnit,
  isDollar,
  readFigures,
  readStatedUnits,
  scaleExponent,
  unsettledScales,
} from "../../../shared/figures";
import type { CheckFigure } from "../../api";

/** Where the words between two figures part: a comma, colon, semicolon or bracket. */
const BREAK = /[,;:，；：、()（）[\]【】]/u;
const HAN = /\p{Script=Han}/u;
const HAN_RUN = /\p{Script=Han}+/gu;
const TOKEN = /[\p{L}\p{M}\p{N}]+/gu;

/** Short words a label leaves no trace of when a sentence words it otherwise ("Revenue by region"). */
const FUNCTION_WORDS = new Set(["a", "an", "as", "at", "by", "in", "of", "on", "or", "to"]);

/**
 * Verbs that only link a figure to its name. Not "closed" or "placed", which make its rows some of
 * them (#2544); "reach" after a "to" makes it a target (`AFTER_TO`).
 */
const LINKING_VERBS = [
  "is",
  "was",
  "were",
  "are",
  "be",
  "been",
  "came",
  "comes",
  "come",
  "reach",
  "reached",
  "reaches",
  "stood",
  "stands",
  "stand",
  "recorded",
  "records",
  "has",
  "had",
  "have",
  "totalled",
  "totaled",
  "amounted",
  "works",
  "worked",
  "took",
  "brought",
  "logged",
  "closes",
  "equal",
  "equals",
];

/** Words that only link a figure to its name: they say nothing of what it is. */
const LINKING = new Set([
  ...FUNCTION_WORDS,
  ...LINKING_VERBS,
  "s",
  "the",
  "its",
  "their",
  "for",
  "from",
  "with",
  "and",
  "that",
  "this",
  "it",
  "there",
  "out",
  "all",
]);

/** The same in Chinese, longest first, so 而言 goes before 而 could be read alone. */
const HAN_LINKING = [
  "而言",
  "达到",
  "共有",
  "一共",
  "总共",
  "约为",
  "录得",
  "停在",
  "所有",
  "全部",
  "为",
  "是",
  "的",
  "达",
  "共",
  "有",
  "在",
  "就",
  "约",
  "了",
  "其",
  "该",
];

/** "Has to reach", "is to be", "was to have reached": what the figure must be or was to be, never what it is. */
const AFTER_TO = new Set([...LINKING_VERBS, "total", "totals", "amount", "sum"]);

/** Words before an item of the input that make the figure one item's ("a North order's total"), or a rate per item. */
const ONE_ITEM = new Set(["a", "an", "one", "each", "per", "every"]);

/**
 * A sign, a symbol or a unit's mark ("▼", "△" and "±" too): none links a figure to its name, so each
 * is read as a word the Analysis's own words must account for (#2544). "=" says what "equals" does.
 */
const SYMBOL = /[\p{S}%％‰‱٪﹪#＃/／\\]/gu;
const SAYS_EQUALS = /[=＝]/u;
/** What a sign written apart from the figure follows: a linking word or a colon, or nothing at all. */
const LINKED =
  "(?:^|(?<!\\p{L})(?:is|was|were|are|be|been|equals?|came to|amounted to|totalled|totaled|stood at|of)|为|是|达到?|共有?|录得|[:：=＝])\\s*";
/**
 * A dash is punctuation ("Total amount, North – 9,450", an em dash anywhere) until it touches the
 * figure, or follows a linking word: "-9,450" and "is – 9,450" give it a sign, "8,000–9,450"
 * makes it a range's end.
 */
const DASH_BEFORE = new RegExp(`[-‐‑‒–〜﹣－]$|${LINKED}[-‐‑‒–﹣－]\\s+$`, "iu");
const DASH_AFTER = /^[-‐‑‒–〜﹣－]/u;
/**
 * Brackets round the figure after a linking word, or round it alone, are the accounts' minus ("is
 * (9,450)", "为（9,450）"); after its name they only set it apart ("The total amount for North (9,450).").
 */
const ACCOUNTS_MINUS = {
  before: new RegExp(`${LINKED}[(（]\\s*$`, "iu"),
  after: /^\s*[)）]/u,
};

const symbolsIn = (text: string) =>
  [...text.matchAll(SYMBOL)].map(([symbol]) => symbol).filter((each) => !SAYS_EQUALS.test(each));

/** A table's headings that say only that a cell holds a figure: "Metric | Value", "指标 | 结果". */
const HEADING_WORDS = ["value", "result", "figure", "数值", "结果"].map((term) => ({
  term,
  exact: false,
}));

interface Terms {
  /** Lowercased words of three letters or more, and words with a digit ("2026", "q3"). */
  words: string[];
  /** Words of one or two letters, matched whole and in their case ("UK", "B"). */
  exact: string[];
  /** A Han run in two-character words, with a last one alone ("东部", "金额", "合计"). */
  han: string[];
}

function termsOf(label: string): Terms {
  const words: string[] = [];
  const exact: string[] = [];
  for (const [token] of label.replace(HAN_RUN, " ").matchAll(TOKEN)) {
    if (/\p{N}/u.test(token) || [...token].length >= 3) words.push(token.toLowerCase());
    else if (!FUNCTION_WORDS.has(token)) exact.push(token);
  }
  const han = [...label.matchAll(HAN_RUN)].flatMap(([run]) => {
    const characters = [...run];
    const pairs: string[] = [];
    for (let at = 0; at < characters.length; at += 2)
      pairs.push(characters.slice(at, at + 2).join(""));
    return pairs;
  });
  return { words, exact, han };
}

/** A word and its plural name the same: "visit" and "visits", "category" and "categories". */
const plurals = (word: string) => [word, `${word}s`, `${word}es`, word.replace(/y$/u, "ies")];
const sameWord = (word: string, token: string) =>
  plurals(word).includes(token) || plurals(token).includes(word);

/** Whether `token` is `term`: a word with a digit exactly, a short word in its case, any other as a word or its plural. */
function isTerm(token: string, term: string, exact: boolean): boolean {
  if (exact) return token === term;
  const lower = term.toLowerCase();
  return /\p{N}/u.test(lower)
    ? token.toLowerCase() === lower
    : sameWord(lower, token.toLowerCase());
}

const tokensOf = (text: string) =>
  [...text.replace(HAN_RUN, " ").matchAll(TOKEN)].map(([token]) => token);

const allTerms = (terms: Terms) => [
  ...terms.words.map((term) => ({ term, exact: false })),
  ...terms.exact.map((term) => ({ term, exact: true })),
  ...terms.han.map((term) => ({ term, exact: false })),
];

function holds(clause: string, term: string, exact: boolean): boolean {
  if (HAN.test(term)) return clause.includes(term);
  return tokensOf(clause).some((token) => isTerm(token, term, exact));
}

/** Where a figure is in `claim`: from the start of its words to their end. */
interface Place {
  id: string;
  from: number;
  to: number;
}

const blockOf = (figure: CheckFigure) =>
  figure.locator.kind === "text" ? figure.locator.from.blockId : figure.locator.blockId;
const offsetOf = (figure: CheckFigure) =>
  figure.locator.kind === "text" ? figure.locator.from.offset : 0;

/**
 * Where each of the sentence's figures in `target`'s Block is in `claim`, each one's words in turn.
 * A number Check doesn't read that has the same digits can take a figure's place, but then the
 * figure's own digits are left in its clause, which no word accounts for.
 */
function placesOf(claim: string, target: CheckFigure, figures: readonly CheckFigure[]): Place[] {
  const ordered = [...figures, ...(figures.includes(target) ? [] : [target])]
    .filter((each) => blockOf(each) === blockOf(target))
    .sort((a, b) => offsetOf(a) - offsetOf(b));
  const places: Place[] = [];
  let after = 0;
  for (const figure of ordered) {
    const shown = figure.calculated?.figure.shown;
    const words =
      shown !== undefined && claim.indexOf(shown, after) >= 0 ? shown : figure.reading.chars;
    const from = claim.indexOf(words, after);
    if (from < 0) continue;
    places.push({ id: figure.id, from, to: from + words.length });
    after = from + words.length;
  }
  return places;
}

/**
 * `target`'s own clause of `claim`: the sentence before its first figure and after its last, and
 * between two figures up to the first break after the one before, with the figure's own number
 * taken out, so its digits never name it. A qualifier set off by a comma is still the figure's.
 */
function clauseOf(
  claim: string,
  target: CheckFigure,
  figures: readonly CheckFigure[],
): { before: string; after: string } | undefined {
  const places = placesOf(claim, target, figures);
  const index = places.findIndex((place) => place.id === target.id);
  const place = places[index];
  if (!place) return undefined;
  const breakAfter = (from: number, to: number) => {
    for (let at = from; at < to; at++) if (BREAK.test(claim[at] ?? "")) return at;
    return to;
  };
  const before = places[index - 1];
  const next = places[index + 1];
  const cut = before ? breakAfter(before.to, place.from) : 0;
  const from = before ? (cut < place.from ? cut + 1 : before.to) : 0;
  const to = next ? breakAfter(place.to, next.from) : claim.length;
  return { before: claim.slice(from, place.from), after: claim.slice(place.to, to) };
}

/** "Has to reach", "is to be": the clause makes the figure a target, not its value. */
function saysTarget(clause: string): boolean {
  const tokens = tokensOf(clause).map((token) => token.toLowerCase());
  return tokens.some((token, at) => token === "to" && AFTER_TO.has(tokens[at + 1] ?? ""));
}

/**
 * "A North order's total", "each delivery's": the clause makes a total one item's of its input, or
 * a rate per item. A label's own words may stand between ("a" North "order"); any other word ends it.
 */
function saysOneItem(
  clause: string,
  items: readonly string[],
  known: readonly { term: string; exact: boolean }[],
): boolean {
  const tokens = tokensOf(clause);
  const isKnown = (token: string | undefined) =>
    token !== undefined &&
    known.some(({ term, exact }) => !HAN.test(term) && isTerm(token, term, exact));
  return tokens.some((token, at) => {
    if (!ONE_ITEM.has(token.toLowerCase())) return false;
    for (let next = at + 1; next < tokens.length; next++) {
      const word = tokens[next] ?? "";
      // "an order total" and "a sales total" name the total; "an order's total" is one order's.
      if (items.some((item) => isTerm(word, item, false))) return !isKnown(tokens[next + 1]);
      if (!isKnown(word)) return false;
    }
    return false;
  });
}

/** A scale, a currency or a percent a text says its numbers are in; "unsure" for a scale it may mean ("in K", "(000)"). */
type Frame =
  | { kind: "scale"; exponent: number }
  | { kind: "currency"; code: string }
  | { kind: "percent" }
  | { kind: "unsure" };

/** A scale word said of the text: "in thousands", "as millions of litres", "thousands of USD", "(bn)"; never "thousands of customers". */
const SCALE_WORDS = new RegExp(
  `(?<!\\p{L})(?:(?<=(?:\\bin|\\bas|[(（])\\s*)(?:thousands?|millions?|billions?|trillions?|hundreds?|lakhs?|crores?)|(?:thousands?|millions?|billions?|trillions?|lakhs?|crores?)(?!\\s+of\\b(?!\\s+(?:${CURRENCY_ISO_CODES}|dollars?|euros?|pounds?|yuan|yen|rupees?|francs?)\\b))|bn|mn|['’]000s?|000s)(?!\\p{L})`,
  "giu",
);
// 千, 万 and 亿 are a scale before a unit or the end of their words after a bracket, a colon, 以, 为
// or 单位, and before a currency or 为单位 / 计 anywhere; a count's units (人, 户, 家, 笔…) only where
// a line states a unit ("单位为千人", "以万户计"). Never inside a name (万和路, 千户街, 万家路店), as a
// unit's own prefix (千克, 千米, 千瓦时), or in a rough count (数以万计, 上千人, 千家万户).
const HAN_CURRENCY_UNIT = "元|美元|欧元|英镑|日元|港元|港币|人民币|美金|台币";
const HAN_COUNT_UNIT =
  "人次|人|位|名|户|家|笔|单|件|次|个|台|条|项|张|份|辆|间|座|套|箱|批|吨|包|小时";
const HAN_SCALE = "(?:十亿|千万|百万|亿|万|千)";
const NOT_ROUGH = "(?<![上数近逾几成])(?!(?<=数以)(?:十亿|千万|百万|亿|万|千)计)";
const HAN_SCALES = new RegExp(
  [
    `${NOT_ROUGH}(?<=(?:[（(：:为以]|单位)\\s*)${HAN_SCALE}(?=${HAN_CURRENCY_UNIT}|(?:${HAN_COUNT_UNIT})?(?:为单位|计|[）)\\s，。；：、,.;:]|$))`,
    `${NOT_ROUGH}${HAN_SCALE}(?=${HAN_CURRENCY_UNIT}|(?:${HAN_COUNT_UNIT})?(?:为单位|计))`,
  ].join("|"),
  "gu",
);
/** A scale written as its number: "in units of 1,000", "×1,000", "单位：10,000元", "以 1,000 元为单位". */
const NUMBER_SCALES =
  /(?:(?<!\p{L})in units? of|(?<!\p{L})[x×✕]|单位[:：为是]?)\s*(1(?:[,，]?000)+|10[,，]?000|100)(?!\d)|以\s*(1(?:[,，]?000)+|10[,，]?000|100)\s*(?:元|美元)?\s*(?:为单位|计)/giu;
const CURRENCY_SIGNS = /(?:US|HK|NZ|NT|A|C|S)?[$＄]|[€£¥￥₹₩₽₺฿₫₱]/gu;
/**
 * A currency's code said of the text: "in USD", "(GBP)", "Currency: EUR", "Totals, EUR", "USD
 * figures follow."; "a PHP storefront" names none, though a line that starts with one does.
 */
const CURRENCY_CODES = new RegExp(
  `(?<=(?:\\bin|\\bof|[(（:：,，]|单位[:：]?|以|^)\\s*)(?:${CURRENCY_ISO_CODES})(?![A-Za-z])|(?<![A-Za-z])(?:${CURRENCY_ISO_CODES})(?=\\s*(?:[)）.。]|thousands?|millions?|billions?|bn\\b|mn\\b|m\\b|k\\b|['’]?000|$))`,
  "gmu",
);
const HAN_CURRENCIES =
  /新加坡元|瑞士法郎|新台币|人民币|美元|美金|港币|港元|欧元|日元|日币|英镑|澳元|加元|韩元|韩币|卢布|台币|(?<=(?:[十百千万亿以：:（(]|单位[为是]?)\s*)元|元(?=为单位|计|[）)])/gu;
const HAN_CURRENCY_CODES: Readonly<Record<string, string>> = {
  美金: "USD",
  台币: "TWD",
  日币: "JPY",
  韩币: "KRW",
};
const CURRENCY_NAMES =
  /(?<![A-Za-z])((?:US |U\.S\. |Hong Kong |Australian |Canadian |Singapore )?dollars?|euros?|(?:Swiss )?francs?|sterling|yen|yuan|renminbi|rupees?|(?<=\b(?:in|of)\s+)pounds?(?: sterling)?)(?![A-Za-z])/giu;
/** A currency's smaller unit said of the text, "in cents", "以分计": never what an Analysis's figure is in. */
const SUBUNITS =
  /(?<=(?:\bin|[(（])\s*)(?:cents?|pence)(?![A-Za-z])|(?<=(?:以|单位[为是:：]?)\s*)分(?=计|[）)\s，。；：]|$)/gu;
const PERCENT_WORDS =
  /[%％‰٪﹪]|(?<!\p{L})(?:percentage points?|basis points?|bps|(?:in|as|are) (?:a )?(?:percent(?:ages?)?|per ?cent))(?!\p{L})|百分比|百分点/giu;

const unitFrames = (unit: FigureUnit): Frame[] =>
  unit.kind === "currency"
    ? [{ kind: "currency", code: unit.code }]
    : unit.kind === "percent" || unit.kind === "points"
      ? [{ kind: "percent" }]
      : [];

/** A sign's currency; "$" and "¥" alone stay as they are, any dollar and yuan or yen. */
const signCode = (sign: string) =>
  /[$＄]$/u.test(sign)
    ? (currencyNamed(sign) ?? "$")
    : sign === "¥" || sign === "￥"
      ? "¥"
      : (currencyNamed(sign) ?? sign);

/**
 * Every scale, currency and percent `text` says apart from its numbers: "All amounts below are in
 * thousands", "以下金额单位为万元", "(GBP)", "in euros". A number's own ("£8,700", "1.2 million") is
 * the number's, never the text's.
 */
function framesIn(text: string): Frame[] {
  const known = framesRead.get(text);
  if (known) return known;
  const read = readFramesIn(text);
  // A paragraph is read once for all its figures and sentences, not once for each (#2512).
  if (framesRead.size >= FRAMES_KEPT) framesRead.delete(framesRead.keys().next().value ?? "");
  framesRead.set(text, read);
  return read;
}

const FRAMES_KEPT = 64;
const framesRead = new Map<string, Frame[]>();

function readFramesIn(text: string): Frame[] {
  let apart = text;
  for (const figure of readFigures(text))
    apart = `${apart.slice(0, figure.start)}${" ".repeat(figure.end - figure.start)}${apart.slice(figure.end)}`;
  const named = (pattern: RegExp, frame: (word: string) => Frame): Frame[] =>
    [...apart.matchAll(pattern)].map(([whole, word]) => frame(word ?? whole));
  // A currency's name capitalised before another capitalised word is a name's: "Dollar Lane".
  const currencyNames = [...apart.matchAll(CURRENCY_NAMES)].filter(
    (match) =>
      !/^\p{Lu}/u.test(match[0]) || !/^\s+\p{Lu}/u.test(apart.slice(match.index + match[0].length)),
  );
  return [
    ...readStatedUnits(text).flatMap((stated): Frame[] => [
      ...(stated.scale !== 1
        ? [{ kind: "scale" as const, exponent: Math.round(Math.log10(stated.scale)) }]
        : []),
      ...unitFrames(stated.unit),
    ]),
    ...named(SCALE_WORDS, (word) => ({
      kind: "scale",
      exponent: /^hundreds?$/iu.test(word) ? 2 : scaleExponent(word),
    })),
    ...named(HAN_SCALES, (word) => ({ kind: "scale", exponent: scaleExponent(word) })),
    ...[...text.matchAll(NUMBER_SCALES)].map(
      ([, number, after]): Frame => ({
        kind: "scale",
        exponent: (number ?? after ?? "").replace(/[^0]/gu, "").length,
      }),
    ),
    ...named(CURRENCY_SIGNS, (sign) => ({ kind: "currency", code: signCode(sign) })),
    ...named(CURRENCY_CODES, (code) => ({ kind: "currency", code: currencyNamed(code) ?? code })),
    ...named(HAN_CURRENCIES, (word) => ({
      kind: "currency",
      code: HAN_CURRENCY_CODES[word] ?? currencyNamed(word) ?? "CNY",
    })),
    ...currencyNames.map(
      ([word = ""]): Frame => ({
        kind: "currency",
        code: /dollars?$/iu.test(word)
          ? (currencyNamed(word) ?? currencyNamed(`${word}s`) ?? "$")
          : (currencyNamed(word) ?? currencyNamed(`${word}s`) ?? word),
      }),
    ),
    // "Prices end in 99 cents." gives a price; "Fares are in cents." gives the text's unit.
    ...[...text.matchAll(SUBUNITS)].map((): Frame => ({ kind: "unsure" })),
    ...named(PERCENT_WORDS, () => ({ kind: "percent" })),
    ...unsettledScales(text).map((): Frame => ({ kind: "unsure" })),
  ];
}

/** For the lines above a sentence: only those that say one are kept with its check. */
export const statesAFrame = (text: string): boolean => framesIn(text).length > 0;

const sameCurrency = (a: string, b: string) =>
  a === b ||
  (a === "$" && (b === "$" || isDollar(b))) ||
  (b === "$" && isDollar(a)) ||
  (a === "¥" && (b === "CNY" || b === "JPY")) ||
  (b === "¥" && (a === "CNY" || a === "JPY"));

const sameFrame = (a: Frame, b: Frame) =>
  a.kind === "scale"
    ? b.kind === "scale" && a.exponent === b.exponent
    : a.kind === "currency"
      ? b.kind === "currency" && sameCurrency(a.code, b.code)
      : a.kind === "percent" && b.kind === "percent";

/**
 * The scale, currency and percent a figure is in, as its shown number, its unit and the Analysis's
 * own words for it, its input and its columns say (#2544): any other said around it makes it
 * another figure.
 */
function ownFrames(figure: CheckFigure): Frame[] {
  const record = figure.analysisRecord;
  return [
    ...(figure.reading.scale !== 1
      ? [{ kind: "scale" as const, exponent: Math.round(Math.log10(figure.reading.scale)) }]
      : []),
    ...unitFrames(figure.reading.unit),
    ...[record?.label ?? "", ...(record?.vocabulary ?? [])].flatMap(framesIn),
    // The run's unit is a unit by itself: "GBP" says what "(GBP)" does.
    ...(record?.unit ? framesIn(`(${record.unit})`) : []),
  ];
}

const backedBy = (frame: Frame, own: readonly Frame[]) =>
  own.some((each) => sameFrame(frame, each));

/** What of `clause` no label word, word of the Analysis's or linking word accounts for. */
function unaccounted(clause: string, known: readonly { term: string; exact: boolean }[]): string[] {
  const words = tokensOf(clause).filter(
    (token) =>
      !LINKING.has(token.toLowerCase()) &&
      !known.some(({ term, exact }) => !HAN.test(term) && isTerm(token, term, exact)),
  );
  let han = clause.replace(/[^\p{Script=Han}]+/gu, " ");
  const hanKnown = [
    ...known.map(({ term }) => term).filter((term) => HAN.test(term)),
    ...HAN_LINKING,
  ].sort((a, b) => b.length - a.length);
  for (const term of hanKnown) han = han.replaceAll(term, " ");
  return [...words, ...(han.match(HAN_RUN) ?? [])];
}

/**
 * Whether `figure`'s own clause in `claim` can stand as naming it: it holds every word of its label
 * (in a table, its cell's row and column headings count), and no word but those, the Analysis's
 * own words for its input, columns and unit, the words for its way of being worked out, and linking
 * words; a cell's headings are read the same way, so another group's name is never one of them. `figures` are all of the sentence's, so each is placed among them. False also when its
 * clause can't be found.
 *
 * Nor may they hold a sign or symbol the Analysis's words don't, say what it must be ("has to
 * reach"), or make a total one item's ("a North order's total"); and `paragraph` (the sentence's,
 * or a cell's caption and headings), the heading above and the lines above it may say no scale,
 * currency or percent its run doesn't back.
 */
export function namingHolds(
  claim: string,
  figure: CheckFigure,
  figures: readonly CheckFigure[],
  paragraph = claim,
): boolean {
  try {
    return holdsAsNamed(claim, figure, figures, paragraph);
  } catch (error) {
    // The figure reader gave up on a text around it: what it says there is unknown, which never
    // keeps a Supported.
    console.error(
      `Reading the words around Analysis figure ${figure.id} for its check failed:`,
      error,
    );
    return false;
  }
}

function holdsAsNamed(
  claim: string,
  figure: CheckFigure,
  figures: readonly CheckFigure[],
  paragraph: string,
): boolean {
  const record = figure.analysisRecord;
  const label = record?.label ?? figure.calculated?.figure.label ?? "";
  const terms = allTerms(termsOf(label));
  if (terms.length === 0) return false;
  const parts = clauseOf(claim, figure, figures);
  if (parts === undefined) return false;
  const found = `${parts.before} ${parts.after}`;
  const headings = figure.label ?? "";
  const clause = `${found} ${headings}`;
  if (!terms.every(({ term, exact }) => holds(clause, term, exact))) return false;
  const how = record?.of?.how;
  const known = [
    ...terms,
    ...(record?.vocabulary ?? []).flatMap((each) => allTerms(termsOf(each))),
    ...(how ? (AGGREGATE_WORDS[how] ?? []) : []).map((term) => ({ term, exact: false })),
  ];
  // A cell's own words beside its number, a unit such as 次, are its headings' to say.
  const besideItsNumber = [...headings.matchAll(/\p{Script=Han}/gu)].map(([term]) => ({
    term,
    exact: false,
  }));
  const ownSymbols = new Set(symbolsIn([label, ...(record?.vocabulary ?? [])].join(" ")));
  const own = ownFrames(figure);
  const symbolBacked = (symbol: string) =>
    ownSymbols.has(symbol) || framesIn(symbol).some((frame) => backedBy(frame, own));
  const items = [record?.of?.input ?? "", record?.unit ?? ""]
    .flatMap(tokensOf)
    .filter((token) => [...token].length >= 3);
  const totals = how !== "mean" && how !== "min" && how !== "max";
  return (
    unaccounted(found, [...known, ...besideItsNumber]).length === 0 &&
    unaccounted(headings, [...known, ...HEADING_WORDS]).length === 0 &&
    symbolsIn(`${found} ${headings}`).every(symbolBacked) &&
    !DASH_BEFORE.test(parts.before) &&
    !DASH_AFTER.test(parts.after) &&
    !(ACCOUNTS_MINUS.before.test(parts.before) && ACCOUNTS_MINUS.after.test(parts.after)) &&
    !saysTarget(found) &&
    !(totals && saysOneItem(found, items, known)) &&
    [paragraph, record?.heading ?? "", record?.above ?? ""].every((text) =>
      framesIn(text).every((frame) => backedBy(frame, own)),
    )
  );
}
