/**
 * The records of a reply that names its Passages in its markers (#2526): call help on a listed
 * model is offered no `cite`, and each marker holds the number of the Passage it rests on, "[^3]"
 * for P3 ("[^P3]" is read the same). IncarnaMind picks each quote, and call help runs no claim
 * check, so the green mark the Citation check gives a quote is the User's only verdict on it: the
 * picker may take a Citation away on weak evidence, never give one. A run of markers is recorded
 * only when the quotes taken for it hold its clause; otherwise its markers go, and the clause shows
 * uncited rather than found.
 *
 * - A run of markers vouches for the words from the markers before it; one opening a sentence,
 *   after the full stop, for the sentence before, as `markedSentence` reads it. Words are matched
 *   with their endings folded, and CJK by each two neighbouring characters, so Chinese and mixed
 *   text need no spaces. A marker may rest on a sibling Passage of the same Document.
 * - Figures keep their kind: "$9" is no "9 years", "50%" no "50 drivers", "0:30" no "30",
 *   "12 months" no "12 weeks", "$52k" no "$52", "-30" no "30"; "two", 两 and "one week" are
 *   numbers. Every figure of the clause is in a quote, but a year of the Document's name, and a
 *   figure the call said that stands beside one of its kind a quote holds or meets the quote's bound
 *   ("At 250 sensors" for "From 200 sensors").
 * - A name any Passage given gives a row (a table row's first cell, a line's lead before its colon,
 *   a capitalised word past a sentence's start), which the claim says and doesn't deny, is in a
 *   quote whenever a quote names another: "Team is $52" gets nothing from "Enterprise plan: $52".
 * - Words of the Document's name and headings are no evidence, and a heading is never quoted: a
 *   "#" line, a table's header row, a line wholly in bold, or a short line with no closing
 *   punctuation that starts a block (with no figure, unless it stands alone).
 * - The first quote holds the most of the claim's figures, then of its words, and at least two of
 *   them; up to `MAX_QUOTES` in all, a further line is quoted when it adds two of them, a figure
 *   beside one of its words, or a word no other line holds; never a line whose figures are all
 *   other than the claim's.
 * - A Passage whose line most like the claim says its opposite gives it nothing, and no line saying
 *   its opposite is quoted ("doesn't include" against "is included", 不含 against 含), the
 *   negations being those ./unmarkedQuotes counts; a reply's own "No," negates nothing.
 * - A claim quotes no transcript line of another side than the one it names first: "they", "the
 *   customer", 对方 or 客户 for "Them"; "I" or "we" for "Me".
 * - A marker an earlier reply recorded is read as naming its Passage anew, under a marker of its
 *   own; a marker no rule reads (in a table row of the reply, or naming no Passage given) goes.
 *
 * A calculation's input that names a Passage the same way ("citation": 3 for P3) quotes its
 * sentence holding the number.
 */
import { answerSentences, MARKER } from "../../shared/answerSentences";
import { sentenceSpans } from "../../shared/sentences";
import type { CitationRecordInput } from "./engine";
import { likeness, wordsOf } from "./markerPlacement";
import { negates, passageSentences } from "./unmarkedQuotes";

/** The most quotes one marker gets from its Passage. */
const MAX_QUOTES = 3;

/** The least of a claim a first quote holds, in words and figures; a CJK character is half a word. */
const MIN_HELD = 2;

/** The most words a short line with no closing punctuation has, to be a heading. */
const MAX_TITLE_WORDS = 8;

/** The least share of a line's own words its claim holds, for one word only it holds to quote it. */
const MIN_LINE_SHARE = 1 / 3;

/** A reply's own answer before its claim, "No," or "不，": no negation of what follows. */
const ANSWER = /^[^\p{L}\p{N}]*([\p{L}\p{N}'’ ]+?)\s*[,，:：;；.。!！—–]/u;
/** The words of a reply's own answer: "No,", "Not quite,", "不，", "不是，", "Sorry, no,". */
const ANSWER_WORDS =
  /^(?:\s|no|not|nope|yes|quite|really|exactly|sorry|unfortunately|afraid|i'm|i’m|不|没|是|有|对|行|好|能|抱歉|恐怕)+$/iu;

/** A marker as a model may write it: "[^3]", or the Passage's id, "[^P3]". */
const NAMED = /\[\^[Pp]?(\d{1,4})\]/g;
/** A calculated figure's marker, "[=1]": its digits are no figure of the claim. */
const FIGURE_MARKER = /\[=\d{1,4}\]/g;
const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const CJK = new RegExp(`[${CJK_CLASS}]`, "u");
const CJK_RUN = new RegExp(`[${CJK_CLASS}]+`, "gu");
/** A word in order: a CJK character, or a run of other letters, digits and apostrophes. */
const TOKEN = new RegExp(`[${CJK_CLASS}]|(?:(?![${CJK_CLASS}])[\\p{L}\\p{N}'’])+`, "gu");
/** Where a negation's reach ends. */
const CLAUSE_END = /[.,;:!?。，；：！？、()（）—–\n]/u;
/** A transcript line's time and speaker, "[0:04 Them] ". */
const CUE = /^\[\d{1,2}(?::\d{2}){1,2}\b[^\]]*\]\s*/u;
/** The side a transcript line's mark names: the User ("Me") or the other side ("Them"). */
const SIDE = /^\[\d{1,2}(?::\d{2}){1,2}\s+(Me|Them)\]/u;
/** Words a claim says the other side by: "they asked", 对方说. The first such word, ours or theirs, is its subject. */
const THEIRS = /\b(?:they|them|their|theirs|the customer|the client)\b|他们|对方|客户/iu;
/** Words a claim says the User's side by: "I'll send", "we connect", 我们. */
const OURS = /\b(?:i|i'm|i'll|me|my|we|we're|we'll|our|us)\b|我/iu;
const LIST_MARK = /^(?:[-*•]|\d+[.)])\s+/u;
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}/u;
const CLOSING = /[.!?。！？:：;；,，]["'”’)\]）」』]*$/u;
const BOLD = /^(\*\*|__)(.+)\1$/u;

/**
 * A figure as written: a call's time, an amount after its currency sign, or a number. What follows
 * a number is read by `kindAfter`.
 */
const FIGURE =
  /(\d{1,2}:\d{2}(?::\d{2})?)(?!\d)|([$€£¥￥])\s?(\d+(?:[.,]\d+)*)|(\d+(?:[.,]\d+)*)/gu;
const CURRENCY: Record<string, string> = {
  "￥": "¥",
  dollar: "$",
  dollars: "$",
  usd: "$",
  euro: "€",
  euros: "€",
  eur: "€",
  pound: "£",
  pounds: "£",
  gbp: "£",
  yuan: "¥",
  rmb: "¥",
  元: "¥",
  块: "¥",
};
const SCALE: Record<string, string> = {
  k: "k",
  thousand: "k",
  千: "k",
  m: "m",
  million: "m",
  bn: "bn",
  billion: "bn",
  万: "万",
  亿: "亿",
};
const UNIT: Record<string, string> = {
  second: "second",
  sec: "second",
  秒: "second",
  minute: "minute",
  min: "minute",
  分钟: "minute",
  分: "minute",
  hour: "hour",
  hr: "hour",
  小时: "hour",
  day: "day",
  天: "day",
  日: "day",
  工作日: "day",
  week: "week",
  周: "week",
  星期: "week",
  month: "month",
  月: "month",
  year: "year",
  年: "year",
};
/** What may follow a number: a scale, then a percent sign, a currency's name or a unit of time. */
const AFTER =
  /^(?:\s?(k|m|bn|thousand|million|billion|千|万|亿)(?![a-z]))?(?:\s?(%|％|percent\b|per cent\b)|\s?(dollars?|usd|euros?|eur|pounds?|gbp|yuan|rmb)\b|\s?(元|块)|[\s-]?(?:business |working )?(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b|\s?个?(秒|分钟|分|小时|天|日|工作日|周|星期|月|年))?/iu;

/**
 * A number's kind from what follows it: "$52k" is not "$52", "12 months" not "12 weeks", "50%"
 * not "50". A unit of time is kept after "@", so a claim's "30 days" is held by "30 days" or a bare
 * "30", but never by "30 minutes".
 */
function withKind(digits: string, sign: string, before: string, after: string): string {
  const [, scale, percent, currencyWord, currencyCharacter, unit, cjkUnit] =
    AFTER.exec(after) ?? [];
  const negative = /(?:^|[\s(（:：])[-−]$|(?:minus|零下)\s*$/iu.test(before) ? "-" : "";
  const currency =
    sign !== ""
      ? (CURRENCY[sign] ?? sign)
      : (CURRENCY[(currencyWord ?? currencyCharacter ?? "").toLowerCase()] ?? "");
  const scaled = scale ? (SCALE[scale.toLowerCase()] ?? "") : "";
  const time = unit
    ? UNIT[
        unit
          .toLowerCase()
          .replace(/s$/u, "")
          .replace(/^hrs?$/u, "hr")
          .replace(/^secs?$/u, "sec")
          .replace(/^mins?$/u, "min")
      ]
    : cjkUnit
      ? UNIT[cjkUnit]
      : undefined;
  return `${negative}${currency}${digits}${scaled}${percent ? "%" : ""}${time ? `@${time}` : ""}`;
}

/** A line's "every minute" or 每分钟: one of the unit, as a claim's "one-minute" says it. */
const EVERY_UNIT =
  /\bevery (second|minute|hour|day|week|month|year)\b|每(秒|分钟|小时|天|周|月|年)/giu;

/** Whether `figures` hold `figure`: itself, or for a figure with a unit of time, its bare number. */
const holdsFigure = (figures: ReadonlySet<string>, figure: string) =>
  figures.has(figure) || (figure.includes("@") && figures.has(figure.replace(/@.*$/u, "")));

/** A figure's kind: "$#", "#%", "#@day", "#". */
const kindOf = (figure: string) => figure.replace(/[\d.,:]+/u, "#");

const NUMBER_WORDS: Record<string, number> = {
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
const NUMBER_WORD = Object.keys(NUMBER_WORDS).join("|");
const WORDED_NUMBER = new RegExp(
  `\\b(?:${NUMBER_WORD})(?:[\\s-]+(?:and[\\s-]+)?(?:${NUMBER_WORD}))*\\b`,
  "giu",
);
/** A number in Chinese numerals, and the measure word after it that makes it one. */
const CHINESE_FIGURE =
  /([零〇一二两三四五六七八九十百千万]+)(?=[个次年月天日周小分秒元块名位条项台张人家倍折成岁米])/gu;
const CHINESE_DIGITS: Record<string, number> = {
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
const CHINESE_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
/** After a negation, a CJK character that carries no meaning of its own: 没有, 不是, 不在. */
const CJK_AFTER_NEGATION = new Set([..."有是在会能要用必"]);
/** The pieces of "doesn't" and its kin, which `negates` reads whole. */
const CONTRACTED = new Set(
  "aren couldn didn doesn don hadn hasn haven isn mustn needn shouldn wasn weren won wouldn".split(
    " ",
  ),
);

/** Each word's value in a run of number words: "two hundred and fifty" is 250. */
function wordedValue(run: string): number {
  let total = 0;
  let current = 0;
  for (const [word] of run.toLowerCase().matchAll(/[a-z]+/g)) {
    const value = NUMBER_WORDS[word];
    if (value === undefined) continue;
    if (value === 100) current = (current || 1) * 100;
    else if (value === 1000) {
      total += (current || 1) * 1000;
      current = 0;
    } else current += value;
  }
  return total + current;
}

function chineseValue(run: string): number {
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

/**
 * The figures a text gives, each with its kind: "$1,200" as "$1200", "50%", "-30", a time "0:30",
 * "two weeks" as "2@week". `alone`: false leaves out a lone "one" or 一 with no unit after it,
 * which a reply says for "the one" or 每一; a line's are read, and its "every minute" too, so a
 * claim's "1 business day" is held by "one business day" and "one-minute" by "every minute".
 */
function figuresOf(text: string, alone = true): string[] {
  const plain = text.replace(MARKER, " ").replace(FIGURE_MARKER, " ");
  const figures: string[] = [];
  const add = (at: number, length: number, digits: string, sign = "") => {
    const before = plain.slice(Math.max(0, at - 8), at);
    const after = plain.slice(at + length, at + length + 24);
    const figure = withKind(digits, sign, before, after);
    if (!alone && digits === "1" && !figure.includes("@") && !/^\d/.test(plain.slice(at))) return;
    figures.push(figure);
  };
  for (const found of plain.matchAll(FIGURE)) {
    const [whole, time, sign, signed, number] = found;
    if (time) figures.push(time);
    else {
      const digits = (signed ?? number ?? "").replace(/,(?=\d{3}(?!\d))/g, "");
      add(found.index, whole.length, digits, sign ?? "");
    }
  }
  for (const found of plain.matchAll(WORDED_NUMBER)) {
    add(found.index, found[0].length, String(wordedValue(found[0])));
  }
  for (const found of plain.matchAll(CHINESE_FIGURE)) {
    const run = found[1] ?? "";
    add(found.index, run.length, String(chineseValue(run)));
  }
  if (alone) {
    for (const found of plain.matchAll(EVERY_UNIT)) {
      const unit = UNIT[(found[1] ?? found[2] ?? "").toLowerCase()];
      if (unit) figures.push(`1@${unit}`);
    }
  }
  return figures;
}

/** Words before a figure that make it a least ("from 200 sensors", 200 个起) or a most. */
const LEAST_BEFORE = /(?:from|over|above|more than|at least|starting at)\s+[$€£¥]?\s*$/u;
const MOST_BEFORE = /(?:up to|under|below|less than|at most|within|no more than)\s+[$€£¥]?\s*$/u;
const LEAST_AFTER =
  /^\s?[^\d，。；,.;]{0,6}?(?:起|以上)|^\+|^\s(?:and|or) (?:later|more|above|up)\b/u;
const MOST_AFTER =
  /^\s?[^\d，。；,.;]{0,6}?(?:以内|以下|之内)|^\s(?:or|and) (?:less|fewer|below|earlier)\b/u;

/**
 * Whether `said` meets the bound the line sets with `figure`: at least it for "from 200", at most
 * it for "up to 40". A figure that sets no bound is met by nothing.
 */
function meetsBound(said: string, figure: string, line: string): boolean {
  const value = Number.parseFloat(digitsOf(said));
  const bound = Number.parseFloat(digitsOf(figure));
  const digits = digitsOf(figure);
  const at = line.indexOf(digits);
  if (at < 0 || Number.isNaN(value) || Number.isNaN(bound)) return false;
  const before = line.slice(0, at);
  const after = line.slice(at + digits.length);
  if (LEAST_BEFORE.test(before) || LEAST_AFTER.test(after)) return value >= bound;
  if (MOST_BEFORE.test(before) || MOST_AFTER.test(after)) return value <= bound;
  return false;
}

/** A figure's digits without its kind: "250" of "¥250". */
const digitsOf = (figure: string) => figure.replace(/[^\d.:]/gu, "");

/** A word as quotes are matched on: "includes", "included" and "include" alike. */
function folded(word: string): string {
  if (word.length <= 3 || CJK.test(word)) return word;
  let stem = word.replace(/['’]s$/u, "");
  if (stem.length > 4 && stem.endsWith("ies")) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length > 3 && stem.endsWith("s") && !stem.endsWith("ss")) stem = stem.slice(0, -1);
  if (stem.length > 5 && stem.endsWith("ing")) stem = stem.slice(0, -3);
  else if (stem.length > 5 && stem.endsWith("ly")) stem = stem.slice(0, -2);
  else if (stem.length > 4 && stem.endsWith("ed")) stem = stem.slice(0, -2);
  if (stem.length > 3 && stem.endsWith("e")) stem = stem.slice(0, -1);
  return stem;
}

/** The words a text is matched on: no figure, number word, negation or lone Latin letter. */
const wordSet = (text: string): Set<string> =>
  new Set(
    [...wordsOf(text)]
      .filter(
        (word) =>
          CJK.test(word) ||
          (word.length > 1 &&
            !/^\d/.test(word) &&
            NUMBER_WORDS[word] === undefined &&
            !negates(word) &&
            !CONTRACTED.has(word)),
      )
      .map(folded),
  );

/** A word said with a negation before it, and the words around it that tell what is negated. */
interface Negated {
  /** The word, folded, or the CJK character. */
  term: string;
  /** The terms its negation covers: the word, or the two CJK characters of 减免 in 不减免. */
  span: string[];
  /** In English, the next word after the term: "not included on Basic". */
  after?: string;
  /**
   * In English, the word before the negation, "phones won't run it"; in Chinese, the two
   * characters before it, 基础版不含.
   */
  before?: string;
  /** The other words of its clause: a side holding every one says the clause again. */
  clause: string[];
}

/** Whether a word after a negation is the one it negates: no stop word, and no 有 in 没有. */
const meaningful = (token: string) =>
  CJK.test(token) ? !CJK_AFTER_NEGATION.has(token) && !negates(token) : wordSet(token).size > 0;

/** The words a text says with a negation just before them, in the same clause. */
function negatedOf(text: string): Negated[] {
  const negated: Negated[] = [];
  for (const clause of text.replace(MARKER, " ").toLowerCase().split(CLAUSE_END)) {
    const tokens = [...clause.matchAll(TOKEN)].map((found) => found[0]);
    for (const [at, token] of tokens.entries()) {
      if (!negates(token)) continue;
      const index = tokens.findIndex((each, after) => after > at && meaningful(each));
      const found = tokens[index];
      if (index < 0 || found === undefined) continue;
      const cjk = CJK.test(found);
      const term = cjk ? found : folded(found);
      const following = tokens[index + 1];
      const rest = tokens
        .filter((each, other) => (other < at || other >= index) && !negates(each))
        .map((each) => (CJK.test(each) ? each : ` ${each} `))
        .join("");
      const others = [...wordSet(rest)].filter((word) => !word.includes(term));
      if (cjk) {
        const before = tokens.slice(Math.max(0, at - 2), at).filter((each) => CJK.test(each));
        const span = following && CJK.test(following) ? [term, following] : [term];
        negated.push({
          term,
          span,
          ...(before.length > 0 && { before: before.join("") }),
          clause: others,
        });
      } else {
        const latin = (each: string) => !CJK.test(each) && meaningful(each);
        const before = tokens.slice(0, at).filter(latin).at(-1);
        const after = tokens.find((each, later) => later > index && latin(each));
        negated.push({
          term,
          span: [term],
          ...(after !== undefined && { after: folded(after) }),
          ...(before !== undefined && { before: folded(before) }),
          clause: others,
        });
      }
    }
  }
  return negated;
}

/** A sentence as a quote of it is written: no list mark, heading mark or "[0:04 Them]" lead. */
const asQuoted = (sentence: string) =>
  sentence
    .replace(/^(?:[-*•]|\d+[.)]|#+)\s+/u, "")
    .replace(/^\[[^\]]*\]\s*/u, "")
    .trim();

/** What a claim or a line says, as it is matched. */
interface Said {
  words: Set<string>;
  /** Its text, lower-case, for finding a CJK character in it. */
  lower: string;
  negated: Negated[];
  /** The negated terms it also says without a negation: "we can't fix it, but prices are fixed". */
  affirmed: Set<string>;
  /** The words of its lead before a colon, which name what all of it is about: "Team plan: …". */
  lead: Set<string>;
}

/** The negated terms of `text` that it also says elsewhere without a negation. */
function affirmedOf(text: string, negated: readonly Negated[]): Set<string> {
  const lower = text.toLowerCase();
  const affirmed = new Set<string>();
  for (const { term } of negated) {
    const said = CJK.test(term)
      ? lower.split(term).length - 1
      : [...lower.matchAll(TOKEN)].filter((found) => folded(found[0]) === term).length;
    if (said > negated.filter((each) => each.term === term).length) affirmed.add(term);
  }
  return affirmed;
}

interface Claim extends Said {
  /** The sentence without its markers. */
  text: string;
  /** The side of the call it says said or does it, when it names only one. */
  side?: "Me" | "Them";
  /** Its Latin words, as matched. */
  latin: string[];
  /** Its runs of CJK characters. */
  cjk: string[];
  figures: string[];
}

function claimOf(sentence: string): Claim {
  const text = sentence.replace(MARKER, " ").replace(FIGURE_MARKER, " ").trim();
  const words = wordSet(text);
  const answer = ANSWER.exec(text);
  const lead = answer?.[1] ?? "";
  const own = answer && ANSWER_WORDS.test(lead) ? answer[0] : "";
  const claimed = text.slice(own.length);
  const negated = negatedOf(claimed);
  const theirs = THEIRS.exec(text)?.index ?? Number.POSITIVE_INFINITY;
  const ours = OURS.exec(text)?.index ?? Number.POSITIVE_INFINITY;
  return {
    ...(theirs !== ours && { side: theirs < ours ? "Them" : "Me" }),
    text,
    words,
    lower: text.toLowerCase(),
    negated,
    affirmed: affirmedOf(claimed, negated),
    lead: new Set(),
    latin: [...words].filter((word) => !CJK.test(word)),
    cjk: text.match(CJK_RUN) ?? [],
    figures: figuresOf(text, false),
  };
}

/** Whether `side` holds `term`, a folded word or CJK characters. */
const holdsTerm = (side: Said, term: string) =>
  CJK.test(term) ? side.lower.includes(term) : side.words.has(term);

/**
 * Whether one side says with a negation what the other says without one, of the same thing: the
 * other names nothing the negated clause doesn't ("Team can't include live traffic" against "Live
 * traffic is included on Enterprise only" is no opposite), holds the negated word, not negated,
 * and the word that tells what is negated (the word after it; the
 * word before the negation when none follows, or when it is one of the Passage's `names`, as in
 * "Team can't include live traffic"; in Chinese the two characters before it); or it holds
 * every other word of the negated clause ("Not quite, single sign-on is in the Team plan"
 * against "…is not included in the Team plan") and negates none of them.
 */
function contradicts(a: Said, b: Said, names: ReadonlySet<string>): boolean {
  const turned = (one: Said, other: Said) =>
    one.negated.some(({ term, after, before, clause }) => {
      if (
        other.negated.some((each) => each.span.includes(term) || clause.includes(each.term)) ||
        (clause.length > 0 &&
          [...other.words].some(
            (word) =>
              names.has(word) && word !== term && !clause.includes(word) && !one.lead.has(word),
          ))
      ) {
        return false;
      }
      const context = [
        ...(after !== undefined ? [after] : []),
        ...(before !== undefined && (after === undefined || CJK.test(before) || names.has(before))
          ? [before]
          : []),
      ];
      return (
        (!one.affirmed.has(term) &&
          holdsTerm(other, term) &&
          context.every((word) => holdsTerm(other, word))) ||
        (clause.length >= MIN_HELD && clause.every((word) => holdsTerm(other, word)))
      );
    });
  return turned(a, b) || turned(b, a);
}

/**
 * How much of a claim's words `has` holds: a Latin word is one, and a CJK character in a held pair
 * half of one, so "企业版" held whole counts as a word and a half.
 */
function amount(claim: Claim, has: (word: string) => boolean): number {
  let held = 0;
  for (const word of claim.latin) if (has(word)) held += 1;
  for (const run of claim.cjk) {
    const characters = [...run];
    const covered = new Set<number>();
    if (characters.length === 1 && has(run)) covered.add(0);
    for (let at = 0; at + 1 < characters.length; at++) {
      if (has(`${characters[at]}${characters[at + 1]}`)) covered.add(at).add(at + 1);
    }
    held += covered.size / 2;
  }
  return held;
}

/** A sentence of a Passage a quote may be. */
interface Line extends Said {
  quote: string;
  /** Its figures, a transcript line's time among them. */
  figures: Set<string>;
  /** Its figures but "one" and a lone 一, which say "a" as often as a number: 一分钟内. */
  counted: Set<string>;
  /** Who said it, for a transcript line marked "Me" or "Them". */
  side?: "Me" | "Them";
  at: number;
}

/** A Passage as the picker reads it. */
interface Read {
  lines: Line[];
  /** The words of its Document's name and of its headings. */
  topic: Set<string>;
  /** The figures of its Document's name and of its headings: "2026" of "Service levels 2026". */
  topicFigures: Set<string>;
  /**
   * The names it gives things: a table row's first cell, the lead of a line before its colon
   * ("Team plan: $29", 团队版：190 元), and a word in capitals past a sentence's start
   * ("included on Standard and Premium", "SAP").
   */
  labels: Set<string>;
}

/** A line's lead before its colon, "Team plan" of "Team plan: $29 per driver a month". */
const LEAD = /^([^:：|]{1,40}?)\s*(?::\s|：)/u;
/** The most words a line's lead has, to be the name of what the line is about. */
const MAX_LEAD_WORDS = 3;

/** The names a row of a Passage gives, as `Read.labels` says. */
function labelsOf(row: string): string[] {
  const plain = asQuoted(row.replace(CUE, ""));
  const names: string[] = [];
  if (plain.startsWith("|")) {
    const first = plain.split("|")[1] ?? "";
    names.push(...wordSet(first));
  }
  const lead = LEAD.exec(plain)?.[1];
  if (lead !== undefined && wordCount(lead) <= MAX_LEAD_WORDS) {
    const words = [...wordSet(lead)];
    names.push(...(CJK.test(lead) ? words : words.slice(0, 1)));
  }
  for (const span of sentenceSpans(plain)) {
    const words = [...plain.slice(span.from, span.to).matchAll(/[\p{L}][\p{L}\p{N}'’]*/gu)].map(
      (found) => found[0],
    );
    for (const [at, word] of words.entries()) {
      const capital = /^\p{Lu}/u.test(word) && !CJK.test(word);
      const upper = word.length > 1 && word === word.toUpperCase() && /\p{Lu}/u.test(word);
      if ((capital && at > 0) || upper) names.push(...wordSet(word));
    }
  }
  return names;
}

const rowAt = (rows: readonly string[], index: number) => rows[index]?.trim() ?? "";

/** About how many words a text has: a CJK character is half of one. */
const wordCount = (text: string) =>
  (text.replace(CJK_RUN, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0) +
  (text.match(CJK_RUN)?.join("").length ?? 0) / 2;

/** Whether a row of a Passage is a heading, which states nothing to quote. */
function isHeading(rows: readonly string[], index: number): boolean {
  const row = rowAt(rows, index);
  if (/^#+\s/u.test(row) || TABLE_SEPARATOR.test(row)) return true;
  if (row.startsWith("|")) return TABLE_SEPARATOR.test(rowAt(rows, index + 1));
  const bold = BOLD.exec(row)?.[2];
  if (bold !== undefined) return wordCount(bold) <= MAX_TITLE_WORDS && !/[.!?。！？]$/u.test(bold);
  if (CUE.test(row) || LIST_MARK.test(row) || CLOSING.test(row)) return false;
  if (wordCount(row) > MAX_TITLE_WORDS || rowAt(rows, index - 1) !== "") return false;
  return rowAt(rows, index + 1) === "" || figuresOf(row).length === 0;
}

/** A Passage's sentences a quote may be, headings left out, and its topic. */
function readOf(passage: { text: string; name?: string }): Read {
  const rows = passage.text.split("\n");
  const lines: Line[] = [];
  const topic = wordSet(passage.name ?? "");
  const topicFigures = new Set(
    figuresOf(passage.name ?? "").filter((figure) => /^\d{4}$/u.test(figure)),
  );
  const labels = new Set<string>();
  for (const [index, raw] of rows.entries()) {
    const row = raw.trim();
    if (row === "") continue;
    if (isHeading(rows, index)) {
      for (const word of wordSet(row)) topic.add(word);
      for (const figure of figuresOf(row)) if (/^\d{4}$/u.test(figure)) topicFigures.add(figure);
      continue;
    }
    for (const label of labelsOf(row)) labels.add(label);
    const mark = SIDE.exec(row)?.[1];
    const side = mark === "Me" || mark === "Them" ? mark : undefined;
    for (const span of sentenceSpans(row)) {
      const sentence = row.slice(span.from, span.to).trim();
      const quote = asQuoted(sentence);
      if (quote === "") continue;
      lines.push({
        ...(side && { side }),
        quote,
        words: wordSet(quote),
        lower: quote.toLowerCase(),
        negated: negatedOf(quote),
        affirmed: affirmedOf(quote, negatedOf(quote)),
        lead: wordSet(LEAD.exec(quote)?.[1] ?? ""),
        figures: new Set(figuresOf(sentence)),
        counted: new Set(figuresOf(sentence, false)),
        at: lines.length,
      });
    }
  }
  return { lines, topic, topicFigures, labels };
}

/** A marker in a reply, by offset. */
interface Mark {
  at: number;
  length: number;
  number: number;
}

/**
 * Each run of markers in `text` with the claim it vouches for: its sentence from the run of
 * markers before it, and to the sentence's end after the last; for markers opening a sentence,
 * after the full stop, the sentence before, as `markedSentence` reads it. A marker vouches for
 * the words before it, not for a clause another marker covers.
 */
function claimsOf(text: string): { text: string; marks: Mark[] }[] {
  const claims: { text: string; marks: Mark[] }[] = [];
  const sentences = answerSentences(text);
  for (const [index, sentence] of sentences.entries()) {
    const slice = text.slice(sentence.start, sentence.end);
    const runs: { from: number; to: number; marks: Mark[] }[] = [];
    for (const found of slice.matchAll(MARKER)) {
      const mark = {
        at: sentence.start + found.index,
        length: found[0].length,
        number: Number(found[1]),
      };
      const last = runs.at(-1);
      if (last && slice.slice(last.to, found.index).trim() === "") {
        last.marks.push(mark);
        last.to = found.index + found[0].length;
      } else runs.push({ from: found.index, to: found.index + found[0].length, marks: [mark] });
    }
    for (const [at, run] of runs.entries()) {
      const before = sentences[index - 1];
      const opening = at === 0 && slice.slice(0, run.from).trim() === "";
      let claimed = slice.slice(runs[at - 1]?.to ?? 0, run.from);
      if (at === runs.length - 1) claimed += ` ${slice.slice(run.to)}`;
      if (opening && before && wordsOf(before.text).size > 0) claimed = before.text;
      claims.push({ text: claimed, marks: run.marks });
    }
  }
  return claims;
}

/**
 * The records for the markers of `text` that name a Passage the model was given (`passages`), and
 * the text with a marker of its own for each further quote, or for a quote under a number already
 * `recorded`, and without the markers of sentences their quotes don't hold. A marker naming no
 * Passage is left as it is.
 */
export function markedPassages(
  text: string,
  passages: readonly { id: string; text: string; name?: string }[],
  found: (passage: string, quote: string) => boolean,
  recorded: (marker: number) => boolean,
): { text: string; records: CitationRecordInput[] } {
  const named = text.replace(NAMED, (_, number: string) => `[^${number}]`);
  const shown = new Map(passages.map((passage) => [passage.id.toUpperCase(), passage]));
  const reads = new Map<string, Read>();
  const readFor = (passage: { id: string; text: string; name?: string }) => {
    const read = reads.get(passage.id) ?? readOf(passage);
    reads.set(passage.id, read);
    return read;
  };
  // A row's name is known from any Passage given: a reply citing the wrong one ("Team is $52" on a
  // Passage of Enterprise's lines) names a row its quote doesn't.
  const names = new Set(passages.flatMap((passage) => [...readFor(passage).labels]));
  // A figure the call said is matched by its digits: "250" said, "250 元" in the reply.
  const said = new Set(
    passages.flatMap((passage) =>
      passage.text
        .split("\n")
        .filter((row) => CUE.test(row.trim()))
        .flatMap((row) => figuresOf(asQuoted(row.trim())).map(digitsOf)),
    ),
  );
  let next = Math.max(0, ...[...named.matchAll(MARKER)].map((each) => Number(each[1]))) + 1;
  const fresh = () => {
    while (recorded(next)) next++;
    return next++;
  };
  /** The marker each quote was recorded under: the Passage's own number first. */
  const markerOf = new Map<string, number>();
  const records: CitationRecordInput[] = [];
  const rewritten: { at: number; length: number; markers: number[] }[] = [];

  const claims = claimsOf(named);
  // A marker no rule reads (in a table's row of the reply) would show whatever record holds its
  // number, from another sentence or an earlier reply: it goes.
  const read = new Set(claims.flatMap(({ marks }) => marks.map((mark) => mark.at)));
  for (const found of named.matchAll(MARKER)) {
    if (read.has(found.index)) continue;
    const space = /\s$/u.test(named.slice(0, found.index)) ? 1 : 0;
    rewritten.push({ at: found.index - space, length: found[0].length + space, markers: [] });
  }
  for (const { text: part, marks } of claims) {
    const claim = claimOf(part);
    const picked = marks.flatMap((mark) => {
      const passage = shown.get(`P${mark.number}`);
      if (!passage) {
        const space = /\s$/u.test(named.slice(0, mark.at)) ? 1 : 0;
        rewritten.push({ at: mark.at - space, length: mark.length + space, markers: [] });
        return [];
      }
      // A long Document comes as several Passages, a transcript's windows overlapping: a marker
      // naming one of them may rest on a line its neighbour holds.
      const siblings = passages.filter(
        (other) => other !== passage && !!passage.name && other.name === passage.name,
      );
      for (const candidate of [passage, ...siblings]) {
        const read = readFor(candidate);
        const quotes = quotesFor(candidate.id, read, claim, said, names, found);
        if (quotes.length > 0 || candidate === siblings.at(-1)) {
          return [{ ...mark, passage: candidate, read, quotes }];
        }
      }
      const read = readFor(passage);
      return [{ ...mark, passage, read, quotes: [] }];
    });
    const quotes = picked.flatMap((mark) => mark.quotes);
    const held = new Set(quotes.flatMap((line) => [...line.figures]));
    const missing = claim.figures.filter(
      (figure) =>
        !holdsFigure(held, figure) && !picked.some((mark) => mark.read.topicFigures.has(figure)),
    );
    const claimed = new Set(claim.figures);
    /** The quotes' figures the claim doesn't give, with the line each is in. */
    const others = quotes.flatMap((line) =>
      [...line.counted]
        .filter(
          (figure) => !holdsFigure(claimed, figure) && !claimed.has(figure.replace(/@.*$/u, "")),
        )
        .map((figure) => ({ figure, line })),
    );
    // A figure the call said may stand beside one of its kind a quote holds ("your Android 10 phones
    // won't run it: it needs Android 11"), but not in place of the quote's own: "15% off" said for a
    // line's "10% off" is the line misread, unless the line's figure is a bound the said one meets
    // ("At 250 sensors" for "From 200 sensors").
    const heldKinds = new Set(
      claim.figures.filter((figure) => holdsFigure(held, figure)).map(kindOf),
    );
    const standsBeside = (figure: string) =>
      said.has(digitsOf(figure)) &&
      (heldKinds.has(kindOf(figure)) ||
        others.every(
          (other) =>
            kindOf(other.figure) !== kindOf(figure) ||
            meetsBound(figure, other.figure, other.line.lower),
        ));
    const figuresStated =
      missing.length === 0 ||
      (missing.every(standsBeside) && claim.figures.some((figure) => holdsFigure(held, figure)));
    // "Team is $52" quoted from "Enterprise plan: $52" holds every figure and most words: a name
    // the claim gives and no quote holds, beside a name the quotes give and the claim doesn't, is
    // one row's fact said of another. A quote naming nothing ("A faulty device is replaced") may
    // stand for a named thing ("rugged tablets").
    const isName = (word: string) =>
      names.has(word) && !picked.some((mark) => mark.read.topic.has(word));
    // A quote for a clause the claim negates ("I can't add live traffic to Team" from "Live traffic
    // is included on Enterprise only") names the row the claim denies it of: that is no other row.
    const naming = quotes.filter(
      (line) =>
        !claim.negated.some(
          ({ clause }) => clause.filter((word) => line.words.has(word)).length >= MIN_HELD,
        ),
    );
    // A name the claim says is absent ("I don't see NetSuite on our list") no quote need hold.
    const denied = new Set(claim.negated.flatMap(({ term, clause }) => [term, ...clause]));
    const namesStated =
      [...claim.words].every(
        (word) => !isName(word) || denied.has(word) || quotes.some((line) => line.words.has(word)),
      ) ||
      naming.every((line) =>
        [...line.words].every((word) => !isName(word) || claim.words.has(word)),
      );
    const stated = figuresStated && namesStated;
    for (const mark of picked) {
      const markers = (stated ? mark.quotes : []).map((line) => {
        const key = `${mark.passage.id}\n${line.quote}`;
        const taken = markerOf.get(key);
        if (taken !== undefined) return taken;
        const marker =
          recorded(mark.number) || [...markerOf.values()].includes(mark.number)
            ? fresh()
            : mark.number;
        markerOf.set(key, marker);
        records.push({ marker, passage: mark.passage.id, quote: line.quote });
        return marker;
      });
      if (markers.length === 0) {
        const space = /\s$/u.test(named.slice(0, mark.at)) ? 1 : 0;
        rewritten.push({ at: mark.at - space, length: mark.length + space, markers });
      } else if (markers.length > 1 || markers[0] !== mark.number) {
        rewritten.push({ at: mark.at, length: mark.length, markers });
      }
    }
  }
  let marked = named;
  for (const { at, length, markers } of rewritten.sort((a, b) => b.at - a.at)) {
    const written = markers.map((marker) => `[^${marker}]`).join("");
    marked = `${marked.slice(0, at)}${written}${marked.slice(at + length)}`;
  }
  return { text: marked, records };
}

/**
 * The lines of a Passage its claim rests on, each one the Citation check finds there, and none
 * when a line says the claim's opposite: first the one holding the most of the claim's figures,
 * then of its words; then each that adds two of them, a figure of the claim beside one of its
 * words, or a word only it holds of a line mostly about the claim.
 */
function quotesFor(
  passage: string,
  { lines, topic }: Read,
  claim: Claim,
  said: ReadonlySet<string>,
  names: ReadonlySet<string>,
  found: (passage: string, quote: string) => boolean,
): Line[] {
  const evidence = (line: Line) => (word: string) => line.words.has(word) && !topic.has(word);
  const quotes: Line[] = [];
  const holds = (word: string) => quotes.some((line) => evidence(line)(word));
  /** Of the claim's figures, those the call didn't say: one the call said, in a line, is chance. */
  const own = claim.figures.filter((figure) => !said.has(digitsOf(figure)));
  const figuresIn = (taken: readonly Line[], figures = own) =>
    new Set(figures.filter((figure) => taken.some((line) => holdsFigure(line.figures, figure))))
      .size;
  /** Whether the claim holds a word only this line holds, and at least `MIN_LINE_SHARE` of its words. */
  const onlyHere = (line: Line) => {
    const own = [...line.words].filter((word) => !topic.has(word));
    return (
      own.filter((word) => claim.words.has(word)).length >= own.length * MIN_LINE_SHARE &&
      own.some(
        (word) =>
          claim.words.has(word) &&
          !holds(word) &&
          lines.every((other) => other === line || !other.words.has(word)),
      )
    );
  };
  /** A line giving figures, none of them the claim's, is about other ones: "$8 from 200 sensors" for "$9". */
  const aboutOtherFigures = (line: Line) =>
    claim.figures.length > 0 &&
    line.counted.size > 0 &&
    claim.figures.every((figure) => !holdsFigure(line.counted, figure));
  // A Passage whose line most like the claim says its opposite quotes nothing for it: its other
  // lines, each sharing a few of its words, would make it look stated. Another line saying the
  // opposite is never quoted.
  const turned = new Set(lines.filter((line) => contradicts(claim, line, names)));
  // "They will start with 100 sensors" is no quote of the User's own "Most teams start with 100".
  const saidBy = (line: Line) => !claim.side || !line.side || line.side === claim.side;
  const likest = lines.reduce<Line | undefined>(
    (best, line) =>
      best === undefined ||
      likeness(claim.words, line.words).score > likeness(claim.words, best.words).score
        ? line
        : best,
    undefined,
  );
  if (likest !== undefined && turned.has(likest)) return [];
  while (quotes.length < MAX_QUOTES) {
    const first = quotes.length === 0;
    const counting = first ? claim.figures : own;
    const next = lines
      .filter((line) => !quotes.includes(line) && !turned.has(line) && saidBy(line))
      .map((line) => {
        const has = evidence(line);
        const either = (word: string) => holds(word) || has(word);
        const figures = figuresIn([...quotes, line], counting) - figuresIn(quotes, counting);
        return {
          line,
          figures,
          gain: amount(claim, either) - amount(claim, holds) + figures,
          words: amount(claim, has),
          score: likeness(claim.words, line.words).score,
        };
      })
      .filter((each) =>
        first
          ? each.gain >= MIN_HELD
          : !aboutOtherFigures(each.line) &&
            (each.gain >= MIN_HELD || (each.figures > 0 && each.words > 0) || onlyHere(each.line)),
      )
      .sort(
        (a, b) =>
          b.figures - a.figures ||
          b.gain - a.gain ||
          b.words - a.words ||
          b.score - a.score ||
          a.line.at - b.line.at,
      )
      .find((each) => found(passage, each.line.quote));
    if (!next) break;
    quotes.push(next.line);
  }
  return quotes;
}

const fieldsOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * `calculate`'s figures with each input that names a Passage by its number as a marker ("citation"
 * 3 for P3, with no record 3) given that Passage and its first sentence holding the input's number
 * as its quote instead; every other input as it was.
 */
export function namedInputs(
  figures: readonly unknown[],
  passages: readonly { id: string; text: string }[],
  recorded: (marker: number) => boolean,
): unknown[] {
  const shown = new Map(passages.map((passage) => [passage.id.toUpperCase(), passage]));
  const named = (value: unknown): unknown => {
    const input = fieldsOf(value);
    const citation = input.citation;
    if (typeof citation !== "number" || recorded(citation) || input.passage !== undefined) {
      return value;
    }
    const passage = shown.get(`P${citation}`);
    const digits = /\d[\d,.]*\d|\d/.exec(String(input.number ?? input.value ?? ""))?.[0];
    if (!passage || !digits) return value;
    const holds = new RegExp(`(?<![\\d.,])${digits.replace(/[.,]/g, "\\$&")}(?!\\d)`);
    const quote = passageSentences(passage.text)
      .map(asQuoted)
      .find((sentence) => holds.test(sentence));
    if (!quote) return value;
    const { citation: _, ...rest } = input;
    return { ...rest, passage: passage.id, quote };
  };
  return figures.map((value) => {
    const figure = fieldsOf(value);
    return Array.isArray(figure.inputs) ? { ...figure, inputs: figure.inputs.map(named) } : value;
  });
}
