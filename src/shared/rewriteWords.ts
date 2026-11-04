/**
 * The word rules a rewrite with what the Documents say keeps to (#1554): the core holds a model's
 * rewrite to them, and a sentence's card offers Rewrite only where one could keep to them.
 */

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
/** What follows a surname to address someone, in place of their given name: 王先生, 王博士, 王某. */
const TITLES = new Set([
  ..."先生 女士 小姐 太太 老师 律师 医生 博士 教授 主任".split(" "),
  ..."董工某",
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

/** One figure: a number with its scale (1.5亿 is one), or a run of Chinese numerals. */
export const FIGURES =
  /\p{Nd}+(?:[.,]\p{Nd}+)*\s*[万亿千百]?|[〇零一二两三四五六七八九十百千万亿]{2,}|[〇零二两三四五六七八九十百千万亿]/gu;

/** A numbered clause's own number, which is no figure of it: "4. The Landlord is…". */
const LIST_NUMBER = /^\s*\p{Nd}+[.)]\s+/u;
const withoutListNumber = (text: string): string => text.replace(LIST_NUMBER, "");

/** How many figures a quote gives, its list number left out. */
export const figuresIn = (quote: string): number =>
  withoutListNumber(quote.normalize("NFKC")).match(FIGURES)?.length ?? 0;

/** Where a clause ends: "," ";" or ":" before a space, a sentence's stop, or their Chinese forms. */
const CLAUSE_MARKS = /[,;:](?=\s)|\.(?=\s|$)|[，；：。！？!?]/gu;

/** The words of `text`'s clause after `end`. */
function clauseAfter(text: string, end: number): string {
  for (const mark of text.matchAll(CLAUSE_MARKS)) {
    const place = mark.index ?? 0;
    if (place >= end) return text.slice(end, place);
  }
  return text.slice(end);
}

const sameWords = (one: string, other: string): boolean =>
  tokensOf(one).join(" ") === tokensOf(other).join(" ");

/** Words that say nothing of what a figure is of, so a sentence may put them otherwise than its quote. */
const FUNCTION_WORDS = new Set(
  "a an the of is are was were be been by with to for in on at as and or its this that".split(" "),
);
const FUNCTION_CHARACTERS = new Set([..."的为是与和"]);

/** A word without the "s" of "pays" or "costs", so "pay" in the quote is the same word. */
const stem = (word: string): string =>
  word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

/** The words of `text` that say what a figure is of: Latin words and Chinese characters. */
function contentWords(text: string): Set<string> {
  return new Set(
    tokensOf(text).flatMap((token) => {
      if (/^\p{Script=Han}$/u.test(token)) return FUNCTION_CHARACTERS.has(token) ? [] : [token];
      const word = token.toLowerCase();
      return /^\p{L}{2,}$/u.test(word) && !FUNCTION_WORDS.has(word) ? [stem(word)] : [];
    }),
  );
}

/** Whether every word of `mine` that says what a figure is of is one `quoted` has too. */
function wordsWithin(mine: string, quoted: string): boolean {
  const theirs = contentWords(quoted);
  return [...contentWords(mine)].every((word) => theirs.has(word));
}

/**
 * The words that bound, negate or qualify a figure, or say when it holds: "at most", "not",
 * "expected", "before", 不超过, 预计, 原, 前. The longer Chinese ones come first, so 不超过 is one.
 */
const QUALIFIERS =
  /\b(?:not|no|never|without|least|most|up to|under|over|below|above|more|less|fewer|maximum|minimum|max|min|within|exceed(?:s|ed|ing)?|cap(?:s|ped)?|approximately|approx|about|around|nearly|roughly|estimated|expected|forecast|projected|proposed|budgeted|target(?:s|ed)?|planned|original(?:ly)?|former|previous|prior|last|next|old|new|before|after|until|unless|if|except|only)\b|n['’]t\b|不超过|不少于|不低于|不高于|不多于|超过|低于|高于|至少|至多|最多|最少|最高|最低|最长|最短|以上|以下|以内|大约|约|预计|计划|拟|原|前|后|不|未|非|无|如|若|除/giu;

const qualifiersIn = (text: string): string[] =>
  [
    ...new Set(
      [...text.normalize("NFKC").matchAll(QUALIFIERS)].map(([word]) =>
        /n['’]t$/iu.test(word) ? "not" : word.toLowerCase(),
      ),
    ),
  ].sort();

const sameQualifiers = (one: string, other: string): boolean =>
  qualifiersIn(one).join(" ") === qualifiersIn(other).join(" ");

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

/** Whether the words before a figure say what the quote's words before its figure say of it. */
const saidBeforeAlike = (mine: string, quoted: string): boolean =>
  wordsWithin(mine, quoted) && sameQualifiers(mine, quoted);

/**
 * Whether the figure `length` long at `at` in `text` is of what the quote's figure at `quotedAt`
 * is of, `outside` being the rest of the sentence. Every word before it that says what it is of is
 * one the quote has before its figure, a label or an earlier clause included; the words that bound,
 * negate or qualify it, or say when it holds, are the quote's, on both sides; the words after it to
 * its clause's end are the quote's (its unit); and its way and time words are the quote's. Another
 * thing a word only the quote has names ("Asia revenue" for "revenue") is left to the check again.
 */
export function measuredAsQuoted(
  text: string,
  at: number,
  length: number,
  outside: string,
  quote: string,
  quotedAt: number,
): boolean {
  const quotedDirections = directionsIn(quote);
  const quotedTimes = new Set(quote.match(TIME_CHARACTERS));
  return (
    saidBeforeAlike(text.slice(0, at), quote.slice(0, quotedAt)) &&
    sameWords(clauseAfter(text, at + length), clauseAfter(quote, quotedAt + length)) &&
    directionsIn(text).every((direction) => quotedDirections.includes(direction)) &&
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

/** Where each figure starts in `text`, its list number left out. */
const figureStarts = (text: string): number[] => {
  const skip = LIST_NUMBER.exec(text)?.[0].length ?? 0;
  return [...text.slice(skip).matchAll(FIGURES)].map((figure) => skip + (figure.index ?? 0));
};

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
 * figure is, or the sentence and the quote alike but for a name.
 */
export function mayRewrite(sentence: string, quote: string): boolean {
  const [quotedAt, ...more] = figureStarts(quote);
  const quotedDirections = directionsIn(quote);
  const aFigure =
    quotedAt !== undefined &&
    more.length === 0 &&
    directionsIn(sentence).every((direction) => quotedDirections.includes(direction)) &&
    figureStarts(sentence).some((at) =>
      saidBeforeAlike(sentence.slice(0, at), quote.slice(0, quotedAt)),
    );
  if (aFigure) return true;
  const mine = withoutListNumber(sentence.normalize("NFKC"));
  const theirs = withoutListNumber(quote.normalize("NFKC"));
  const spans = differingSpans(mine, theirs);
  return (
    spans !== null && namedAsQuoted(mine, spans.at, spans.from, spans.to, theirs, spans.quotedAt)
  );
}
