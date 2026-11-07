/**
 * The word rules a rewrite with what the Documents say keeps to (#1554): the core holds a model's
 * rewrite to them, and a sentence's card offers Rewrite only where one could keep to them.
 */

import { isPeriod } from "./periods";

/** A word of the old or new words: a number, a Chinese character, a Latin word, or one other character. */
const TOKENS = /\p{Nd}+(?:[.,]\p{Nd}+)*|\p{Script=Han}|[^\s\p{Nd}\p{Script=Han}\p{P}\p{S}]+|\S/gu;
const tokensOf = (text: string): string[] => text.normalize("NFKC").match(TOKENS) ?? [];

/** The old and new words' tokens that differ, once those they share at each end are set aside. */
export function differing(from: string, to: string): [string[], string[]] {
  const old = tokensOf(from);
  const next = tokensOf(to);
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  return [old.slice(start, old.length - end), next.slice(start, next.length - end)];
}

/** What a figure is written with: its numbers, Chinese numerals and dates, a sign of currency or percent. */
const FIGURE_PART =
  /^(?:\p{Nd}+(?:[.,]\p{Nd}+)*|[〇零一二两三四五六七八九十百千万亿年月日号$€£¥%‰\-–/:.,])$/u;
const NUMERAL = /\p{Nd}|[〇零一二两三四五六七八九十百千万亿]/u;

export const isFigure = (tokens: readonly string[]): boolean =>
  tokens.some((token) => NUMERAL.test(token)) && tokens.every((token) => FIGURE_PART.test(token));

const CONNECTORS = new Set(["of", "and", "the", "de", "du", "van", "von", "der", "la", "le"]);
/** The words in capitals a company's name may end in; any other is a word, such as UNLESS. */
const COMPANY_SUFFIXES = new Set([
  "LLC",
  "LLP",
  "LP",
  "PLC",
  "LTD",
  "INC",
  "AG",
  "SA",
  "NV",
  "BV",
  "GMBH",
  "KG",
  "PTE",
  "PTY",
  "CO",
]);
const CAPITALISED = /^\p{Lu}[\p{L}\p{M}]*$/u;
const capitalised = (word: string): boolean =>
  CAPITALISED.test(word) &&
  (word.length === 1 || word !== word.toUpperCase() || COMPANY_SUFFIXES.has(word));

/** A name of at most 8 capitalised words: "Sampleford Commercial Property Investments Limited". */
function isName(words: string): boolean {
  const tokens = tokensOf(words);
  const first = tokens[0];
  const last = tokens.findLast((token) => token !== ".");
  const named = tokens.filter(capitalised).length;
  return (
    first !== undefined &&
    last !== undefined &&
    capitalised(first) &&
    capitalised(last) &&
    named <= 8 &&
    tokens.every((token) => capitalised(token) || CONNECTORS.has(token) || /^[.&'’-]$/u.test(token))
  );
}

/**
 * Surnames that rarely begin another word in an agreement, so two or three characters starting
 * with one are a person's name. A name with any other surname, a compound surname, four or more
 * characters, or a character of the words below is refused: 王丙但须经董事会批准, 董事, 经理, 王总,
 * 王丙等, 王府.
 */
const SURNAMES = new Set([
  ..."王李张刘陈杨赵黄吴孙胡郭林罗郑梁谢韩冯邓曹彭肖袁潘蒋蔡魏吕沈姚卢崔谭汪廖邹熊邱薛侯郝龚邵",
]);
const NEVER_IN_NAMES = new Set([
  ..."不未非无但须应可得经如若除及和或与的之由向对在于将已会事长理员人方部司公期内外前后上下等总府",
]);
/** What follows a surname to address someone, in place of their given name: 王先生, 王博士, 王某某. */
const TITLES = new Set([
  ..."先生 女士 小姐 太太 阿姨 老师 律师 医生 博士 教授 主任 师傅 同学 某某".split(" "),
  ..."董工某姐哥叔伯老律",
]);

function isChineseName(words: string): boolean {
  const characters = [...words.normalize("NFKC")];
  const [surname] = characters;
  return (
    surname !== undefined &&
    characters.length >= 2 &&
    characters.length <= 3 &&
    SURNAMES.has(surname) &&
    !TITLES.has(characters.slice(1).join("")) &&
    characters.every((each) => /^\p{Script=Han}$/u.test(each) && !NEVER_IN_NAMES.has(each))
  );
}

/** Written numbers: digits with their separators, or Chinese numerals but a lone 一, a part of many words. */
export const NUMBERS =
  /\p{Nd}+(?:[.,]\p{Nd}+)*|[〇零一二两三四五六七八九十百千万亿]{2,}|[〇零二两三四五六七八九十百千万亿]/gu;

/** One figure: a number with its scale (1.5亿 is one), or a run of Chinese numerals. */
export const FIGURES =
  /\p{Nd}+(?:[.,]\p{Nd}+)*\s*[万亿千百]?|[〇零一二两三四五六七八九十百千万亿]{2,}|[〇零二两三四五六七八九十百千万亿]/gu;

/** A numbered clause's own number, which is no figure of it: "4. The Landlord is…". */
const LIST_NUMBER = /^\s*\p{Nd}+[.)]\s+/u;
const withoutListNumber = (text: string): string => text.replace(LIST_NUMBER, "");

export const figuresIn = (quote: string): number =>
  withoutListNumber(quote.normalize("NFKC")).match(FIGURES)?.length ?? 0;

/** Where a clause ends: "," ";" or ":" before a space, a sentence's stop, or their Chinese forms. */
const CLAUSE_MARKS = /[,;:](?=\s)|\.(?=\s|$)|[，；：。！？!?]/gu;

function clauseAfter(text: string, end: number): string {
  for (const mark of text.matchAll(CLAUSE_MARKS)) {
    const place = mark.index ?? 0;
    if (place >= end) return text.slice(end, place);
  }
  return text.slice(end);
}

const sameWords = (one: string, other: string): boolean =>
  tokensOf(one).join(" ") === tokensOf(other).join(" ");

/**
 * Words that say nothing of what a figure is of, so a sentence may put them otherwise than its
 * quote. The words that tie a figure to its sentence ("by", "to", "in", "on", "at") are not among
 * them, so a word between a tie and its figure can't hide it ("in constant 2025 dollars").
 */
const FUNCTION_WORDS = new Set(
  "a an the of is are was were be been with for as and or its this that".split(" "),
);
const FUNCTION_CHARACTERS = new Set([..."的是与和"]);
/**
 * 为 where it says no "to": in 作为, 认为, 因为, 成为 and 以为, in 为了, and as "for" before 公司
 * or 客户. Anywhere else it is compared, since after a change verb it says "to" (增加为2000万元
 * is a level, 增加1000万元 a change), and no list of those verbs is whole.
 */
const NOT_TO = /(?<=[作认因成以])为|为(?=了|公司|客户)/gu;
/** Words either side may say where the other doesn't, without changing what a figure is of. */
const ADDABLE = new Set([..."shall must each every any all".split(" "), ..."应当须本每位"]);

/** A word without the "s" of "pays" or "costs", so "pay" in the quote is the same word. */
const stem = (word: string): string =>
  word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

/** A day, a week, a month or a year that an amount is given per. */
export type Rate = "day" | "week" | "month" | "year";
const RATE_WORDS: Record<string, Rate> = {
  day: "day",
  night: "day",
  daily: "day",
  nightly: "day",
  week: "week",
  weekly: "week",
  month: "month",
  monthly: "month",
  year: "year",
  annum: "year",
  yearly: "year",
  annual: "year",
  annually: "year",
  天: "day",
  日: "day",
  晚: "day",
  周: "week",
  星期: "week",
  月: "month",
  月度: "month",
  年: "year",
  年度: "year",
};
const RATES =
  /\b(?:per|a|an|each|every)\s+(day|night|week|month|year|annum)\b|\b(daily|nightly|weekly|monthly|yearly|annual|annually)\b|每个?(天|日|晚|周|星期|月|年)|(月度|年度)/giu;

export const ratesIn = (text: string): Set<Rate> =>
  new Set(
    [...text.matchAll(RATES)].flatMap((match) => {
      const word = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").toLowerCase();
      const rate = RATE_WORDS[word];
      return rate ? [rate] : [];
    }),
  );

/**
 * "By" and a verb of giving notice just before a figure, which say what "with" says: "by giving 90
 * days' notice" is "with 90 days' notice". Only these verbs, as a word after "by" is as often
 * whose figure it is ("by Marketing", "by financing").
 */
const BY_GIVING_NOTICE = /\b[Bb]y\s+(?:giving|sending|serving)\s*$/u;

/**
 * The words before a figure that say what it is of, in their order, each as often as it is said
 * (the Tenant again is not the Landlord again): Latin words by their stems, a lone capital too
 * (Party A is not Party B), and Chinese characters one by one.
 * Left out are the words either side may add, "by" with a verb of giving notice just before the
 * figure (`BY_GIVING_NOTICE`), and a rate word ("annual") whose period both sides name.
 */
function figureWords(text: string, periods: ReadonlySet<Rate>): string[] {
  const words: string[] = [];
  for (const token of tokensOf(text.replace(BY_GIVING_NOTICE, "").replace(NOT_TO, ""))) {
    const word = /^\p{Lu}$/u.test(token) ? token : token.toLowerCase();
    if (/^\p{Script=Han}$/u.test(token)) {
      if (!FUNCTION_CHARACTERS.has(token) && !ADDABLE.has(token)) words.push(token);
      continue;
    }
    const rate = RATE_WORDS[word];
    if (
      !/^(?:\p{L}{2,}|\p{Lu})$/u.test(word) ||
      FUNCTION_WORDS.has(word) ||
      ADDABLE.has(word) ||
      (rate !== undefined && periods.has(rate))
    )
      continue;
    words.push(stem(word));
  }
  return words;
}

/** The words just before a figure that say it is a change, a level, a time or a price. */
const TIES = new Set("by to in on at".split(" "));
/**
 * The word just before a figure that ties it to the sentence: a change ("rose by 8%") or a level
 * ("rose to 12%"), a time ("paid in 2025") or a price ("set at 500"); null for none.
 */
const tieBefore = (text: string): string | null => {
  const word = tokensOf(text)
    .findLast((token) => /^\p{L}+$/u.test(token))
    ?.toLowerCase();
  return word !== undefined && TIES.has(word) ? word : null;
};

/** Which way a figure goes, or what it is: a rise or a fall, a loss or a profit. */
const DIRECTIONS: readonly [string, RegExp][] = [
  [
    "up",
    /\b(?:rose|rise[ns]?|rising|increas\w*|grew|grow\w*|gain\w*|up)\b|增长|上升|增加|提高|上涨/iu,
  ],
  ["down", /\b(?:fell|fall\w*|decreas\w*|declin\w*|drop\w*|down)\b|下降|减少|降低|下跌|下滑/iu],
  ["loss", /\bloss\w*|亏损/iu],
  ["profit", /\bprofit\w*|盈利|利润/iu],
];
const directionsIn = (text: string): string[] =>
  DIRECTIONS.flatMap(([direction, words]) => (words.test(text) ? [direction] : []));

/** The characters a Chinese sentence says a time or a rate with: 年租金, 按月, 每晚. */
const TIME_CHARACTERS = /[年月周日天晚]/gu;

/** What comes just before a Chinese name: 负责人为李乙, 由李乙, 王丙和李乙. */
const BEFORE_A_NAME = /(?:^|[为是由与和及给向、，：:])\s*$/u;
/** The word before an English name; one in capitals after "The" (the Deposit) is a defined term. */
const BEFORE_AN_ENGLISH_NAME = /\b(?:is|by|to|from|with|of|and|named|between)\s+$/iu;

const sameSet = (one: readonly string[], other: readonly string[]): boolean =>
  [...new Set(one)].sort().join(" ") === [...new Set(other)].sort().join(" ");

/**
 * Whether the words before a figure, from the sentence's start, say what the quote's words
 * before its figure say: the same words in the same order on either side, but those either side
 * may add, so a narrower thing, a bound, a hedge, a condition or another party only one says, or
 * the parties the other way round, keep the sentence; and the word that ties the figure to the
 * sentence is the same ("paid 500" is not "paid in 2025").
 */
function saidBeforeAlike(mine: string, quoted: string, periods: ReadonlySet<Rate>): boolean {
  return (
    figureWords(mine, periods).join(" ") === figureWords(quoted, periods).join(" ") &&
    tieBefore(mine) === tieBefore(quoted)
  );
}

/** The periods both `text` and `quote` name, which a rate word on either side may say again. */
const periodsOfBoth = (text: string, quote: string): Set<Rate> => {
  const quoted = ratesIn(quote);
  return new Set([...ratesIn(text)].filter((rate) => quoted.has(rate)));
};

/**
 * Whether the figure `length` long at `at` in `text` is of what the quote's figure at `quotedAt`
 * is of, `outside` being the rest of the sentence: said alike before it (`saidBeforeAlike`), with
 * the quote's words after it to its clause's end (its unit), the same rises, falls, losses or
 * profits on both sides, and only time words the quote has.
 */
export function measuredAsQuoted(
  text: string,
  at: number,
  length: number,
  outside: string,
  quote: string,
  quotedAt: number,
): boolean {
  const quotedTimes = new Set(quote.match(TIME_CHARACTERS));
  return (
    saidBeforeAlike(text.slice(0, at), quote.slice(0, quotedAt), periodsOfBoth(text, quote)) &&
    sameWords(clauseAfter(text, at + length), clauseAfter(quote, quotedAt + length)) &&
    sameSet(directionsIn(text), directionsIn(quote)) &&
    (outside.match(TIME_CHARACTERS) ?? []).every((each) => quotedTimes.has(each))
  );
}

/**
 * Whether `from` at `at` in `sentence` and `to` at `quotedAt` in the quote are names, after a word
 * that leads to one, in a sentence and a quote alike but for them, list numbers aside: so the quote
 * names the same party, by a label or an earlier clause too, and doesn't name the old one.
 */
export function namedAsQuoted(
  sentence: string,
  at: number,
  from: string,
  to: string,
  quote: string,
  quotedAt: number,
): boolean {
  const before = sentence.slice(0, at);
  const named =
    (isName(from) && isName(to) && BEFORE_AN_ENGLISH_NAME.test(before)) ||
    (isChineseName(from) && isChineseName(to) && BEFORE_A_NAME.test(before));
  return (
    named &&
    !quote.includes(from) &&
    sameWords(withoutListNumber(before), withoutListNumber(quote.slice(0, quotedAt))) &&
    sameWords(sentence.slice(at + from.length), quote.slice(quotedAt + to.length))
  );
}

/**
 * Where each figure is in `text`, its list number left out, and whether it is a named period
 * ("2026"), which a correction always keeps, so no rewrite changes it.
 */
const figuresAt = (text: string): { at: number; end: number; period: boolean }[] => {
  const skip = LIST_NUMBER.exec(text)?.[0].length ?? 0;
  return [...text.slice(skip).matchAll(FIGURES)].map((figure) => {
    const at = skip + (figure.index ?? 0);
    const written = figure[0].trimEnd();
    return { at, end: at + written.length, period: isPeriod(written) };
  });
};

/** A currency before a figure: the mark of an amount whose digits may look like a year. */
const AMOUNT_BEFORE = /(?:[$€£¥₹₩₽]|\b(?:usd|eur|gbp|cny|rmb|jpy|hkd|aud|cad|sgd|chf))\s*$/iu;
/** The units a year-shaped figure is measured in, after it: "2025 square feet", "2021 kg". */
const UNITS = new Set(
  [
    "square sq feet foot ft inch inches yard yards yd mile miles metre metres meter meters m km cm mm",
    "kilometre kilometres kilometer kilometers m2 km2 ft2 m3 sqm sqft acre acres hectare hectares ha",
    "kg g gram grams kilogram kilograms lb lbs pound pounds ton tons tonne tonnes t oz ounce ounces",
    "l litre litres liter liters ml gallon gallons kwh kw mw mwh gb mb tb",
    "people persons person staff employees workers users customers members units items pieces copies",
    "shares seats rooms beds cars vehicles households homes students patients visitors guests",
    "words pages hours minutes seconds days weeks nights times points percent",
    "dollars dollar euros euro yen yuan pounds cents",
  ]
    .join(" ")
    .split(" "),
);
/** What "per" is followed by in a rate, besides a unit or a period: "per person", "per head". */
const PER_WHAT = new Set("person head guest unit item hour minute seat room".split(" "));
/** The dimension a length's unit is told with: "2025 m long", "2025 in wide". */
const DIMENSIONS = new Set("long wide high tall deep thick across".split(" "));
/** What a rate is per: "per day", "per kg", "per head", "per square foot". */
const RATED = new Set([
  ...UNITS,
  ...Object.keys(RATE_WORDS).filter((word) => /^\p{Script=Latin}+$/u.test(word)),
  ...PER_WHAT,
]);
const HAN_UNITS = [
  ..."平方米 平方公里 平米 公里 千米 厘米 毫米 公顷 公斤 千克 毫升 小时 分钟 美元 欧元 英镑 日元 港元 人民币 人次".split(
    " ",
  ),
  ..."元人名位个件台辆套间户家张份本次项株头只条米亩克吨斤升秒天页字股座床席块瓶箱袋包",
];

/**
 * Whether the rest of the sentence after a figure, to its stop, is the figure's unit and nothing
 * else: units, then a rate and a dimension ("square feet", "kg per day", "per head", "m long"),
 * or "in" before a dimension ("in wide"), or a Chinese unit (元, 平方米). Anything else ("in
 * person", "per head office instructions", "in long, difficult talks", 2024 家庭调查) is prose.
 */
function measuredBy(after: string): boolean {
  const stop = after.search(/[.!?。！？](?=\s|$)/u);
  const rest = stop < 0 ? after : after.slice(0, stop);
  const han = /^\s*(\p{Script=Han}+)/u.exec(rest)?.[1];
  if (han !== undefined) return HAN_UNITS.includes(han);
  const words = rest.toLowerCase().match(/[^\s\p{P}]+/gu) ?? [];
  if (words[0] === "in") return words.length === 2 && DIMENSIONS.has(words[1] ?? "");
  let at = 0;
  while (UNITS.has(words[at] ?? "")) at++;
  if (words[at] === "per") {
    at++;
    while (RATED.has(words[at] ?? "")) at++;
  } else if (at === 0) return false;
  if (DIMENSIONS.has(words[at] ?? "")) at++;
  return at === words.length;
}

/**
 * Whether the line's one figure is a period, which no rewrite writes for another figure: a figure
 * that reads as a year ("2025", full-width digits too) is one unless it carries a measure's mark,
 * a currency before it, or its unit and nothing else after it to its sentence's stop ("$2025",
 * "2025 square feet.", "2025 per day.", "2025 in long.", 2020 人。). Anything else after it, or
 * nothing, keeps it a period, so no word turns a year into an amount.
 */
export function givesAPeriod(quote: string): boolean {
  const text = quote.normalize("NFKC");
  const [figure] = figuresAt(text);
  if (!figure?.period || AMOUNT_BEFORE.test(text.slice(0, figure.at))) return false;
  return !measuredBy(text.slice(figure.end));
}

/** The numbers `text` writes outside `at` to `end`, which a rewrite there leaves as they are. */
const numbersOutside = (text: string, at: number, end: number): string[] =>
  [...text.matchAll(NUMBERS)]
    .filter((number) => (number.index ?? 0) + number[0].length <= at || (number.index ?? 0) >= end)
    .map((number) => number[0].normalize("NFKC"));

/** The token spans `text` and `other` differ in, once those they share at each end are set aside. */
function differingSpans(
  text: string,
  other: string,
): { at: number; from: string; quotedAt: number; to: string } | null {
  const spans = (value: string) =>
    [...value.matchAll(TOKENS)].map((token) => ({
      word: token[0],
      start: token.index ?? 0,
      end: (token.index ?? 0) + token[0].length,
    }));
  const mine = spans(text);
  const theirs = spans(other);
  let start = 0;
  while (start < mine.length && start < theirs.length && mine[start]?.word === theirs[start]?.word)
    start++;
  let end = 0;
  while (
    end < mine.length - start &&
    end < theirs.length - start &&
    mine[mine.length - 1 - end]?.word === theirs[theirs.length - 1 - end]?.word
  )
    end++;
  const [first, last] = [mine[start], mine[mine.length - 1 - end]];
  const [quotedFirst, quotedLast] = [theirs[start], theirs[theirs.length - 1 - end]];
  const empty = start > mine.length - 1 - end || start > theirs.length - 1 - end;
  if (!first || !last || !quotedFirst || !quotedLast || empty) return null;
  return {
    at: first.start,
    from: text.slice(first.start, last.end),
    quotedAt: quotedFirst.start,
    to: other.slice(quotedFirst.start, quotedLast.end),
  };
}

/**
 * Whether a rewrite of `sentence` to what `quote` says could keep to these rules, as far as they
 * can be told before the model names the words: a figure of the sentence said as the quote's one
 * figure is, with the same words after it and only numbers the quote writes besides, or the
 * sentence and the quote alike but for a name.
 */
export function mayRewrite(sentence: string, quote: string): boolean {
  const [quoted, ...more] = figuresAt(quote);
  const periods = periodsOfBoth(sentence, quote);
  const written = new Set((quote.match(NUMBERS) ?? []).map((number) => number.normalize("NFKC")));
  const aFigure =
    quoted !== undefined &&
    more.length === 0 &&
    !givesAPeriod(quote) &&
    sameSet(directionsIn(sentence), directionsIn(quote)) &&
    figuresAt(sentence).some(
      ({ at, end, period }) =>
        !period &&
        saidBeforeAlike(sentence.slice(0, at), quote.slice(0, quoted.at), periods) &&
        sameWords(clauseAfter(sentence, end), clauseAfter(quote, quoted.end)) &&
        numbersOutside(sentence, at, end).every((number) => written.has(number)),
    );
  if (aFigure) return true;
  const mine = withoutListNumber(sentence.normalize("NFKC"));
  const theirs = withoutListNumber(quote.normalize("NFKC"));
  const spans = differingSpans(mine, theirs);
  return (
    spans !== null && namedAsQuoted(mine, spans.at, spans.from, spans.to, theirs, spans.quotedAt)
  );
}
