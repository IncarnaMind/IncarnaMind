/**
 * Numbers in a transcript are written one way (#1508): as digits for figures, percentages, money
 * and dates, so a check of "6.8%" finds the line that says "six point eight percent". An engine
 * writes some numbers as digits and others as words, whichever it heard; this makes them one.
 *
 * A small number is left as the word it is in running speech ("one of the", "two weeks"), unless a
 * unit says it is a figure: a percent, money, a month or a date.
 *
 * A number is written whole or left as said, and a range at both ends or at neither (#1031): when
 * words of the number lie outside what is read here ("a hundred and fifty", "twelve and a half",
 * "twenty to thirty thousand", 两块五), digits for the rest would show another number.
 */

import {
  figuresOf,
  INTEGER_WORDS,
  NUMBER_WORD,
  SCALES,
  TENS,
  UNITS,
} from "../../shared/numberWords";

const ORDINALS: ReadonlyMap<string, number> = new Map([
  ...[
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
    "eighth",
    "ninth",
    "tenth",
    "eleventh",
    "twelfth",
    "thirteenth",
    "fourteenth",
    "fifteenth",
    "sixteenth",
    "seventeenth",
    "eighteenth",
    "nineteenth",
  ].map((word, at): [string, number] => [word, at + 1]),
  ["twentieth", 20],
  ["thirtieth", 30],
]);
const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
// "may" and "march" are verbs too: "May the first of us win", "We may first need to".
const DATED_MONTHS = MONTHS.replace("|March|April|May|", "|April|");
const MONEY = /^(?:dollars?|euros?|pounds?|yuan|cents?|pence|rupees?|yen|bucks)$/;

const word = (token: string) => token.toLowerCase();

const SUFFIX: ReadonlyMap<number, string> = new Map([
  [1, "st"],
  [2, "nd"],
  [3, "rd"],
]);
const ordinalSuffix = (value: number): string =>
  value % 100 >= 11 && value % 100 <= 13 ? "th" : (SUFFIX.get(value % 10) ?? "th");

const grouped = (value: number): string =>
  value >= 1000 ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : String(value);

/** How far beside a number its other words are looked for: longer than any of them. */
const NEAR = 40;

const DIGIT_WORD = "zero|one|two|three|four|five|six|seven|eight|nine";
const SCALE_WORD = [...SCALES.keys()].join("|");
const PERCENT = "percent|percentage|per cent";
const A_HUNDRED_PERCENT = "a hundred percent";
// "one hundred and twenty-eight thousand", "nine point three", "six percent". A run starts at a
// number, never at a scale word alone ("a few million", "several hundred", "a million reasons"),
// but for "a hundred percent".
const RUN = `\\b(?:${INTEGER_WORDS}(?: point(?: (?:${DIGIT_WORD}))+(?: (?:${SCALE_WORD}))?)?(?: (?:${PERCENT}))?|${A_HUNDRED_PERCENT})(?![A-Za-z-])`;
// Numbers joined by these read as one figure, written together or not at all: "fifty to sixty
// percent", "two or three hundred", "between five and ten percent".
const JOINED = "to|or|and";
const EACH_RUN = new RegExp(RUN, "gi");
const RANGE = new RegExp(`${RUN}(?: (?:${JOINED}) ${RUN})*`, "gi");
// Numbers said one after another share a "hundred" or "thousand" across a comma too.
const LIST = new RegExp(`${RUN}(?:(?:,| (?:${JOINED})) ${RUN})*`, "gi");
const PERCENT_END = new RegExp(` (?:${PERCENT})$`, "i");
// A percent ends its number, so what is said after it is a row of its own: "twenty percent and one
// of the reasons", "twenty percent and fifty to sixty thousand users". After "or" or "to" the words
// can't tell a pair ("about five percent to six") from two things unless the numbers after it count
// something named right after them: "fifteen percent or two points higher". "between" and "from"
// lead both ends of a range in: "from fifteen percent to nine", "between about five percent and nine".
const AFTER_PERCENT = new RegExp(`(?<= (?:${PERCENT}))(?:,| (?:${JOINED})) `, "gi");
const COUNTED =
  "points|people|users|customers|clients|members|staff|employees|units|items|products|orders|deals|accounts|sites|stores|plants|cases|days|weeks|months|years|hours|minutes|times";
const COUNTED_NEXT = new RegExp(
  `^${RUN}(?: (?:${JOINED}) ${RUN})* (?:${COUNTED})(?![A-Za-z-])`,
  "i",
);
const LEADS_BOTH_ENDS = /\b(?:between|from)(?: [a-z]+)? $/i;

const TENS_WORD = [...TENS.keys()].join("|");
const TENTHS = [...TENS.keys()].map((each) => each.replace(/y$/, "ieth")).join("|");
const DECADES = [...TENS.keys()].map((each) => each.replace(/y$/, "ies")).join("|");
// Words of the same number, or of the number joined to it, that a run can't take in: "a hundred
// and" fifty, "a thousand" two hundred, "point" five, twelve "and a half", "a hundred to" two
// hundred, the nineteen "nineties", the twelve "thousandth", nineteen "oh five" and "nineteen oh"
// five, twenty "point fifteen", one point one "hundred". After "this", "that", "which" or "some",
// "point" is a moment: "at this point fifteen percent". "a hundred percent" is a run of its own.
const FRACTION = `and (?:a|${DIGIT_WORD}) (?:half|quarters?|thirds?)`;
const MORE_BEFORE = new RegExp(
  `\\b(?:(?:hundred|${SCALE_WORD})(?: (?:${JOINED}))?|(?<!\\b(?:this|that|which|some) )point|${FRACTION} (?:${JOINED})|(?:${NUMBER_WORD}) oh) $`,
  "i",
);
const MORE_AFTER = new RegExp(
  `^ (?:${FRACTION}|(?:${JOINED}) (?!${A_HUNDRED_PERCENT}(?![A-Za-z-]))an? (?:hundred|${SCALE_WORD})|${DECADES}|(?:hundred|${SCALE_WORD})(?:s|ths?)?|oh[ -](?:${DIGIT_WORD})|point (?:${NUMBER_WORD}))\\b`,
  "i",
);
// "twenty third" is the 23rd, "thirty fives" are 35s and "one hundred and first" is the 101st.
const ENDS_IN_TENS = new RegExp(`(?:${TENS_WORD})$`, "i");
const UNIT_AFTER = new RegExp(
  `^ (?:${[...ORDINALS.keys()].slice(0, 9).join("|")}|(?:one|two|three|four|five|seven|eight|nine)s|sixes)(?![A-Za-z-])`,
  "i",
);
const ENDS_IN_SCALE = new RegExp(`(?:hundred|${SCALE_WORD})$`, "i");
const ORDINAL_AFTER = new RegExp(
  `^ (?:and )?(?:(?:${TENS_WORD})[- ])?(?:${[...ORDINALS.keys()].join("|")}|${TENTHS})(?![A-Za-z-])`,
  "i",
);

const YEAR_REST = `(?:${TENS_WORD})(?:[- ](?:${DIGIT_WORD}))?|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|oh[ -](?:${DIGIT_WORD})`;
const YEAR_SAID = `(?:(?:nineteen|twenty)[ -](?:${YEAR_REST})|(?:19|20)\\d\\d)`;
/**
 * A year said as two numbers after a word that leads one in: "in twenty twenty-five", "since
 * nineteen ninety-nine". The far end of two years is led in by the near one: "from twenty nineteen
 * to twenty twenty-one". "and" leads one in unless it follows a number ("for twenty twenty and
 * twenty twenty-one" may be counts), and "between" only before "and" and another year: "between
 * twenty thirty people" is a count.
 */
const YEAR_LEAD = `in|since|by|from|until|of|during|year|before|after|through|(?<!\\b(?:${NUMBER_WORD}) )and`;
const YEAR = new RegExp(
  `(?<=\\b(?:(?:${YEAR_LEAD}) (?:${YEAR_SAID} (?:to|and) )?|between (?:${YEAR_SAID} and |(?=${YEAR_SAID} and ${YEAR_SAID}(?![A-Za-z-])))))\\b(nineteen|twenty)[ -](${YEAR_REST})(?![A-Za-z-])`,
  "gi",
);

function yearOf(century: string, rest: string): string {
  const [head = "", tail] = word(rest).split(/[ -]/);
  const second =
    head === "oh"
      ? (UNITS.get(tail ?? "") ?? 0)
      : (TENS.get(head) ?? UNITS.get(head) ?? 0) + (UNITS.get(tail ?? "") ?? 0);
  return String((word(century) === "nineteen" ? 19 : 20) * 100 + second);
}

const ORDINAL_WORD = `(?:${[...ORDINALS.keys()].join("|")}|twenty[- ](?:${[...ORDINALS.keys()].slice(0, 9).join("|")})|thirty[- ]first)`;
const DAY = new RegExp(`\\b${ORDINAL_WORD}(?![A-Za-z-])`, "gi");
// A range of days is dated at both ends: "the first to the thirtieth of November".
const OF_MONTH = new RegExp(`^(?: to (?:the )?${ORDINAL_WORD})? of (?:${MONTHS})\\b`);
const MONTH_THE = new RegExp(`\\b(?:${DATED_MONTHS}) the (?:${ORDINAL_WORD} to (?:the )?)?$`);

function dayOf(match: string): string {
  const lower = word(match);
  const [first = "", second] = lower.split(/[- ]/);
  const value =
    second === undefined
      ? ORDINALS.get(first)
      : (first === "thirty" ? 30 : 20) + (ORDINALS.get(second) ?? 0);
  return value === undefined ? match : `${value}${ordinalSuffix(value)}`;
}

const wordsOf = (integer: string) =>
  integer
    .toLowerCase()
    .split(/[ -]+/)
    .filter((each) => each !== "and");

/** A run as digits, or null when it stays as said. */
function runToDigits(run: string, after: string): string | null {
  if (word(run) === A_HUNDRED_PERCENT) return "100%";
  let text = run;
  let percent = false;
  const percentAt = PERCENT_END.exec(text);
  if (percentAt) {
    percent = true;
    text = text.slice(0, percentAt.index);
  }
  const [integer = "", places] = text.split(/ point /i);
  const figures = figuresOf(wordsOf(integer));
  // Words that make more than one number ("twenty twenty-five") are a year or a list: left as said.
  if (figures.length !== 1) return null;
  const scaleWord = places?.split(" ").find((each) => SCALES.has(word(each)));
  const decimals =
    places === undefined
      ? ""
      : places
          .split(" ")
          .filter((each) => UNITS.has(word(each)))
          .map((each) => UNITS.get(word(each)) ?? 0)
          .join("");
  const money = MONEY.test(word(/^ +([A-Za-z]+)/.exec(after)?.[1] ?? ""));
  const written = figures.map((figure, at) => {
    const last = at === figures.length - 1;
    const places = last && decimals !== "" ? `.${decimals}` : "";
    const isFigure =
      figure.value >= 10 || places !== "" || figure.scaled || (last && percent) || (last && money);
    if (!isFigure) return null;
    if (last && scaleWord !== undefined) {
      return `${figure.value}${places} ${word(scaleWord)}`;
    }
    if (figure.word !== null) {
      return `${figure.value / (SCALES.get(figure.word) ?? 1)}${places} ${figure.word}`;
    }
    return `${grouped(figure.value)}${places}`;
  });
  // A number said only in words: left as it is, unless every number of the run is a figure.
  if (written.some((each) => each === null)) return null;
  return `${written.join(" ")}${percent ? "%" : ""}`;
}

/** How many digits the one number of `words` has, or null when they aren't one number. */
function digitsOf(words: readonly string[]): number | null {
  const [one, ...more] = figuresOf(words);
  return one !== undefined && more.length === 0 ? String(one.value).length : null;
}

const sizeOf = (each: string) => (each === "hundred" ? 100 : (SCALES.get(each) ?? 1));

interface Sharing {
  /** Of its last number, unless a percent: its digits and its largest "hundred" or scale word. */
  near: { digits: number; top: number } | null;
  /** The "hundred" or "thousand" its first number ends with, and how many digits it multiplies. */
  far: { word: number; digits: number } | null;
  /** Whether it says more than one number: "two hundred and three hundred". */
  several: boolean;
}

/**
 * What tells whether a run shares the "hundred" or "thousand" of the run after it: "twenty to
 * thirty thousand" is as often 20,000 to 30,000 as 20 to 30,000, so numbers said in a row with
 * such a pair stay as said. A near end with a word that large is whole ("two thousand to three
 * thousand"), and so is one longer than what the word multiplies ("eighty to two hundred"). A
 * million stays a word, which reads as said either way.
 */
function sharingOf(run: string): Sharing {
  if (/ point /i.test(run) || word(run) === A_HUNDRED_PERCENT) {
    return { near: null, far: null, several: false };
  }
  const integer = run.replace(PERCENT_END, "");
  const words = wordsOf(integer);
  const numbers = figuresOf(words);
  const first = words.slice(0, numbers[1]?.from);
  const last = words.slice(numbers.at(-1)?.from);
  const end = first.at(-1) ?? "";
  const group = first.slice(0, -1).findLastIndex((each) => SCALES.has(each)) + 1;
  const whole = integer === run ? digitsOf(last) : null;
  const multiplied =
    end === "hundred" || end === "thousand" ? digitsOf(first.slice(group, -1)) : null;
  return {
    near:
      whole === null
        ? null
        : { digits: whole, top: last.reduce((top, each) => Math.max(top, sizeOf(each)), 1) },
    far: multiplied === null ? null : { word: sizeOf(end), digits: multiplied },
    several: numbers.length > 1,
  };
}

/**
 * Whether numbers said in a row stay as said, all of them: one run says two numbers ("one hundred,
 * two hundred and three hundred"), or one may share the next one's "hundred" or "thousand".
 */
function staysAsSaid(row: string): boolean {
  const runs = (row.match(EACH_RUN) ?? []).map(sharingOf);
  return runs.some(({ far, several }, each) => {
    const near = runs[each - 1]?.near ?? null;
    return (
      several || (far !== null && near !== null && near.top < far.word && near.digits <= far.digits)
    );
  });
}

/** The rows of a list of `text` that starts at `at`, with the joiners between them as rows too. */
function rowsOf(text: string, list: string, at: number): string[] {
  if (LEADS_BOTH_ENDS.test(text.slice(Math.max(0, at - NEAR), at))) return [list];
  const rows: string[] = [];
  let from = 0;
  for (const joiner of list.matchAll(AFTER_PERCENT)) {
    const end = joiner.index + joiner[0].length;
    const next = text.slice(at + end, at + end + NEAR);
    if (/^ (?:or|to) $/i.test(joiner[0]) && !COUNTED_NEXT.test(next)) continue;
    rows.push(list.slice(from, joiner.index), joiner[0]);
    from = end;
  }
  rows.push(list.slice(from));
  return rows;
}

/** A range of `text`, which starts at `at`, as digits at every end, or as said. */
function writtenRange(text: string, range: string, at: number): string {
  const before = text.slice(Math.max(0, at - NEAR), at);
  const after = text.slice(at + range.length, at + range.length + NEAR);
  // Beside a digit it is part of a figure the engine already wrote.
  if (/\d\s*$/.test(before) || /^\s*\d/.test(after)) return range;
  if (MORE_BEFORE.test(before) || MORE_AFTER.test(after)) return range;
  if (ENDS_IN_TENS.test(range) && UNIT_AFTER.test(after)) return range;
  if (ENDS_IN_SCALE.test(range) && ORDINAL_AFTER.test(after)) return range;
  const runs = range.match(EACH_RUN) ?? [];
  const written = runs.map((run, each) => runToDigits(run, each === runs.length - 1 ? after : ""));
  if (written.includes(null)) return range;
  let next = 0;
  return range.replace(EACH_RUN, () => written[next++] ?? "");
}

/** English: number words as digits; see the module's note on which. */
function englishNumbers(text: string): string {
  const dated = text
    .replace(YEAR, (_whole, century: string, rest: string) => yearOf(century, rest))
    .replace(/(\d)(?: per cent| percent)\b(?!-)/gi, "$1%")
    .replace(DAY, (ordinal: string, offset: number, whole: string) =>
      OF_MONTH.test(whole.slice(offset + ordinal.length)) || MONTH_THE.test(whole.slice(0, offset))
        ? dayOf(ordinal)
        : ordinal,
    );
  return dated.replace(LIST, (list: string, at: number) => {
    let from = at;
    return rowsOf(dated, list, at)
      .map((row) => {
        const start = from;
        from += row.length;
        return staysAsSaid(row)
          ? row
          : row.replace(RANGE, (range: string, offset: number) =>
              writtenRange(dated, range, start + offset),
            );
      })
      .join("");
  });
}

const ZH_DIGITS: ReadonlyMap<string, number> = new Map([
  ["零", 0],
  ["〇", 0],
  ["一", 1],
  ["二", 2],
  ["两", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
]);
const ZH_DIGIT_CHARS = "一二三四五六七八九";
const ZH_NUMERAL = "零〇一二三四五六七八九两十百千万亿";

/** A Chinese numeral's value: "一百二十八万四千" is 1,284,000. */
function zhValue(text: string): number {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of text) {
    const each = ZH_DIGITS.get(char);
    if (each !== undefined) digit = each;
    else if (char === "十") {
      section += (digit || 1) * 10;
      digit = 0;
    } else if (char === "百") {
      section += digit * 100;
      digit = 0;
    } else if (char === "千") {
      section += digit * 1000;
      digit = 0;
    } else if (char === "万" || char === "亿") {
      total = (total + section + digit) * (char === "万" ? 1e4 : 1e8);
      section = 0;
      digit = 0;
    }
  }
  return total + section + digit;
}

/** The standard way to say a whole number below a trillion, to tell a numeral from a lookalike. */
function zhSaid(value: number): string {
  const digit = (each: number) => ZH_DIGIT_CHARS[each - 1] ?? "";
  const group = (n: number, leading: boolean): string => {
    let out = "";
    let zero = false;
    for (const [at, unit] of [
      [1000, "千"],
      [100, "百"],
      [10, "十"],
      [1, ""],
    ] as const) {
      const each = Math.floor(n / at) % 10;
      if (each === 0) {
        if (out !== "") zero = true;
        continue;
      }
      if (zero) out += "零";
      zero = false;
      out += (each === 1 && unit === "十" && leading && out === "" ? "" : digit(each)) + unit;
    }
    return out;
  };
  const yi = Math.floor(value / 1e8);
  const wan = Math.floor((value % 1e8) / 1e4);
  const rest = value % 1e4;
  let out = yi > 0 ? `${group(yi, true)}亿` : "";
  if (wan > 0) out += `${out !== "" && wan < 1000 ? "零" : ""}${group(wan, out === "")}万`;
  if (rest > 0) out += `${out !== "" && rest < 1000 ? "零" : ""}${group(rest, out === "")}`;
  return out;
}

/** What a numeral is made of, said the same way as the standard one: 两 and 〇 are 二 and 零. */
const plainNumeral = (text: string) => text.replace(/两/g, "二").replace(/〇/g, "零");

/** The value of a numeral written the standard way ("三千二百", not "二三十" or "万一"), else null. */
function zhStandard(text: string): number | null {
  if (text === "" || /^[零〇]+$/.test(text)) return null;
  const value = zhValue(text);
  return value > 0 && value < 1e12 && zhSaid(value) === plainNumeral(text) ? value : null;
}

/** A numeral as digits: "三百万" stays "300万", as written numbers do, and the rest is grouped. */
function zhShown(whole: string, value: number): string {
  const last = whole.at(-1);
  if (last === "万" || last === "亿") {
    const head = whole.slice(0, -1);
    const headValue = zhStandard(head);
    if (headValue !== null && headValue < 10000 && !/[万亿]/.test(head))
      return `${headValue}${last}`;
  }
  return grouped0(value);
}

const grouped0 = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** After which a numeral is money, or a count of something. */
const ZH_MONEY = ["美元", "欧元", "英镑", "日元", "元", "块"];
const ZH_COUNTED = [
  "件",
  "个",
  "人",
  "家",
  "台",
  "吨",
  "份",
  "次",
  "条",
  "天",
  "倍",
  "笔",
  "套",
  "名",
  "岁",
];

function zhDigits(text: string): string {
  return [...text].map((each) => ZH_DIGITS.get(each) ?? 0).join("");
}

const ZH_PLACES = "(?:点[零〇一二三四五六七八九]+)?";
const ZH_UNITS = `月|日|号|年|${ZH_MONEY.join("|")}|${ZH_COUNTED.join("|")}`;
const ZH_ONE = `(?:百分之)?[${ZH_NUMERAL}]+${ZH_PLACES}[万亿]?(?:${ZH_UNITS})?`;
const ZH_JOINED = "到|至|或者|或|、";
const ZH_JOINER = new RegExp(`(${ZH_JOINED})`, "u");
const ZH_RANGE = new RegExp(`${ZH_ONE}(?:(?:${ZH_JOINED})${ZH_ONE})*`, "gu");
const ZH_PARTS = new RegExp(
  `^(百分之)?([${ZH_NUMERAL}]+)(${ZH_PLACES})([万亿]?)(${ZH_UNITS})?$`,
  "u",
);

// A rough number is a number in words: 十几二十个, 二十几到三十个, 十几个到二十个, 一百多到两百个.
const ZH_ROUGH_BEFORE = new RegExp(
  `几(?:(?:${ZH_UNITS})?(?:${ZH_JOINED}))?$|[${ZH_NUMERAL}]多(?:${ZH_UNITS})?(?:${ZH_JOINED})$`,
  "u",
);
// A rough count of days or years runs up to a date, which is no end of a range with it:
// 这几天到二十号, 前几年到二零二五年.
const ZH_ROUGH_STRETCH = new RegExp(`(?:几|[${ZH_NUMERAL}]多)[天年](?:${ZH_JOINED})$`, "u");
const ZH_DATE = new RegExp(`^(?:[${ZH_NUMERAL}]+[月日号]|[零〇一二三四五六七八九]{4}年)`, "u");
// 两块五 is 2.5块, 十块零五 10.05块 and 三元五角 3.5元: a digit after money goes on with the amount,
// unless it counts something itself (五十块一个) or starts the next amount (一百块两百块都行), which
// never starts at 零 or at a digit before another: 两块五五块 is 两块五 and 五块. The amounts said
// before one that goes on stay as said with it: 五块两块五.
const ZH_MONEY_BEFORE = new RegExp(`[${ZH_NUMERAL}](?:${ZH_MONEY.join("|")})$`, "u");
const ZH_ON = `(?:[零〇][一二两三四五六七八九]|[一二两三四五六七八九](?!${ZH_UNITS}|[十百千万亿][${ZH_NUMERAL}]*(?:${ZH_MONEY.join("|")})))`;
const ZH_GOES_ON = new RegExp(`^${ZH_ON}`, "u");
const ZH_AMOUNTS_GO_ON = new RegExp(`^(?:[${ZH_NUMERAL}]+(?:${ZH_MONEY.join("|")}))*${ZH_ON}`, "u");
// 周六日 is the weekend, 下周二十号 may be a Tuesday and 下周二十个人 ten people on a Tuesday. 本周十五号
// names no day of the week, and 一周 or 两个星期 is a length of time.
const ZH_WEEKDAY_BEFORE = new RegExp(`(?<![${ZH_NUMERAL}\\d]个?)(?:周|星期|礼拜)$`, "u");
const ZH_WEEKDAY = /^[一二三四五六]/u;

/** Above ten, or said with 百, 千, 万 or 亿: a count, where a smaller numeral is a word ("三个人"). */
const zhLarge = (whole: string, value: number) => /[百千万亿]/.test(whole) || value > 10;

/** The digits of a numeral that `unit` counts, without the unit, or null when it stays as said. */
function zhFigure(
  percent: boolean,
  whole: string,
  places: string,
  big: string,
  unit: string | undefined,
  after: string,
): string | null {
  const fraction = places === "" ? "" : `.${zhDigits(places.slice(1))}`;
  const value = zhStandard(whole);
  if (percent) {
    if (whole === "百" && places === "" && big === "") return "100%";
    return value === null || big !== "" ? null : `${grouped0(value)}${fraction}%`;
  }
  // A year, said digit by digit.
  if (unit === "年" && /^[零〇一二三四五六七八九]{4}$/.test(whole) && places === "" && big === "")
    return zhDigits(whole);
  // "十八点四万元": the decimal and its 万 or 亿 stay as written, the whole part is digits.
  if (places !== "" || big !== "") {
    if (value === null || value >= 10000 || unit === undefined || unit === "年") return null;
    if (!ZH_MONEY.includes(unit) && !ZH_COUNTED.includes(unit)) return null;
    return `${value}${fraction}${big}`;
  }
  if (value === null || unit === undefined) return null;
  if (unit === "月") return value >= 1 && value <= 12 ? String(value) : null;
  if (unit === "日" || unit === "号") return value >= 1 && value <= 31 ? String(value) : null;
  if (unit === "年") return value >= 100 && value <= 2999 ? String(value) : null;
  // 块 is also "together" (一块去吃饭, 一块儿) and "a piece" (一块蛋糕): money from two up.
  if (unit === "块" && (value < 2 || after === "儿")) return null;
  return ZH_MONEY.includes(unit) || zhLarge(whole, value) ? zhShown(whole, value) : null;
}

/**
 * Chinese: a percent ("百分之三十"), a year said digit by digit ("二零二五年"), a month or day
 * ("十一月", "三十日") and an amount before money or a counted noun ("三千二百元", "一百二十八万四千件")
 * are written as digits. Only a numeral written the standard way, with nothing digit beside it:
 * words and idioms with 一, 万 or 千 in them ("万一", "千万不要", "万事如意", "二三十", "唯一") stay.
 */
function chineseNumbers(text: string): string {
  return text.replace(ZH_RANGE, (range: string, offset: number) => {
    const before = text.slice(Math.max(0, offset - NEAR), offset);
    const after = text.slice(offset + range.length, offset + range.length + NEAR);
    // Beside a digit it is part of a figure already written; beside a numeral character it is a word.
    if (
      /[\d.,]$/.test(before) ||
      /^\d/.test(after) ||
      [...ZH_NUMERAL].includes(before.at(-1) ?? "")
    )
      return range;
    if (ZH_ROUGH_BEFORE.test(before) && !(ZH_ROUGH_STRETCH.test(before) && ZH_DATE.test(range)))
      return range;
    if (ZH_MONEY_BEFORE.test(before) && ZH_GOES_ON.test(range)) return range;
    const parts = range.split(ZH_JOINER);
    const far = ZH_PARTS.exec(parts.at(-1) ?? "")?.[5];
    if (far !== undefined && ZH_MONEY.includes(far) && ZH_AMOUNTS_GO_ON.test(after)) return range;
    const written = parts.map((part, at) => {
      if (at % 2 === 1) return part;
      const [, percent, whole = "", places = "", big = "", unit] = ZH_PARTS.exec(part) ?? [];
      if (
        percent === undefined &&
        at === 0 &&
        ZH_WEEKDAY_BEFORE.test(before) &&
        ZH_WEEKDAY.test(whole)
      )
        return null;
      // The unit after a range counts both its ends, when the near one is a count by itself: a
      // smaller numeral before 到 is often a word (一到十二月就下雪, 礼拜六到二十号).
      const value = zhStandard(whole);
      const lent =
        percent === undefined && value !== null && zhLarge(whole, value) ? far : undefined;
      const digits = zhFigure(
        percent !== undefined,
        whole,
        places,
        big,
        unit ?? lent,
        at === parts.length - 1 ? (after[0] ?? "") : "",
      );
      return digits === null ? null : `${digits}${unit ?? ""}`;
    });
    return written.includes(null) ? range : written.join("");
  });
}

/** What an engine said, with its numbers written as digits where they are figures. */
export function writtenNumbers(text: string): string {
  return chineseNumbers(englishNumbers(text));
}
