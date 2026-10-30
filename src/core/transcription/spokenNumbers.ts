/**
 * Numbers in a transcript are written one way (#1508): as digits for figures, percentages, money
 * and dates, so a check of "6.8%" finds the line that says "six point eight percent". An engine
 * writes some numbers as digits and others as words, whichever it heard; this makes them one.
 *
 * A small number is left as the word it is in running speech ("one of the", "two weeks"), unless a
 * unit says it is a figure: a percent, money, a month or a date.
 */

import { figuresOf, INTEGER_WORDS, SCALES, TENS, UNITS } from "../../shared/numberWords";

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

const DIGIT_WORD = "zero|one|two|three|four|five|six|seven|eight|nine";
// "one hundred and twenty-eight thousand", "nine point three", "six percent". A run starts at a
// number, never at a scale word alone ("a few million", "several hundred", "a million reasons").
const RUN = new RegExp(
  `\\b${INTEGER_WORDS}(?: point(?: (?:${DIGIT_WORD}))+(?: (?:${[...SCALES.keys()].join("|")}))?)?(?: (?:percent|percentage|per cent))?(?![A-Za-z-])`,
  "gi",
);

/** A year said as two numbers after a word that leads one in: "in twenty twenty-five", "since nineteen ninety-nine". */
const YEAR = new RegExp(
  `(?<=\\b(?:in|since|by|from|until|of|during|year|before|after|through|and) )\\b(nineteen|twenty)[ -]((?:${[...TENS.keys()].join("|")})(?:[- ](?:${DIGIT_WORD}))?|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|oh[ -](?:${DIGIT_WORD}))(?![A-Za-z-])`,
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
const OF_MONTH = new RegExp(`^ of (?:${MONTHS})\\b`);
const MONTH_THE = new RegExp(`\\b(?:${DATED_MONTHS}) the $`);

function dayOf(match: string): string {
  const lower = word(match);
  const [first = "", second] = lower.split(/[- ]/);
  const value =
    second === undefined
      ? ORDINALS.get(first)
      : (first === "thirty" ? 30 : 20) + (ORDINALS.get(second) ?? 0);
  return value === undefined ? match : `${value}${ordinalSuffix(value)}`;
}

function runToDigits(run: string, after: string): string {
  let text = run;
  let percent = false;
  const percentAt = /(?: (?:percent|percentage|per cent))$/i.exec(text);
  if (percentAt) {
    percent = true;
    text = text.slice(0, percentAt.index);
  }
  const [integer = "", places] = text.split(/ point /i);
  const all = integer.toLowerCase();
  const figures = figuresOf(all.split(/[ -]+/).filter((each) => each !== "and"));
  // Words that make more than one number ("twenty twenty-five") are a year or a list: left as said.
  if (figures.length !== 1) return run;
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
  if (written.some((each) => each === null)) return run;
  return `${written.join(" ")}${percent ? "%" : ""}`;
}

/** English: number words as digits; see the module's note on which. */
function englishNumbers(text: string): string {
  const dated = text
    .replace(/\ba hundred percent\b/gi, "100%")
    .replace(YEAR, (_whole, century: string, rest: string) => yearOf(century, rest))
    .replace(/(\d)(?: per cent| percent)\b(?!-)/gi, "$1%")
    .replace(DAY, (ordinal: string, offset: number, whole: string) =>
      OF_MONTH.test(whole.slice(offset + ordinal.length)) || MONTH_THE.test(whole.slice(0, offset))
        ? dayOf(ordinal)
        : ordinal,
    );
  return dated.replace(RUN, (run: string, offset: number) => {
    // Beside a digit it is part of a figure the engine already wrote.
    const before = dated.slice(0, offset).trimEnd().at(-1) ?? "";
    const after = dated.slice(offset + run.length).trimStart()[0] ?? "";
    if (/\d/.test(before) || /\d/.test(after)) return run;
    return runToDigits(run, dated.slice(offset + run.length, offset + run.length + 24));
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

/**
 * Chinese: a percent ("百分之三十"), a year said digit by digit ("二零二五年"), a month or day
 * ("十一月", "三十日") and an amount before money or a counted noun ("三千二百元", "一百二十八万四千件")
 * are written as digits. Only a numeral written the standard way, with nothing digit beside it:
 * words and idioms with 一, 万 or 千 in them ("万一", "千万不要", "万事如意", "二三十", "唯一") stay.
 */
function chineseNumbers(text: string): string {
  const numeral = `[${ZH_NUMERAL}]+`;
  const decimal = "(?:点[零〇一二三四五六七八九]+)?";
  const pattern = new RegExp(
    `(百分之)?(${numeral})(${decimal})((?:[万亿])?)(月|日|号|年|美元|欧元|英镑|日元|元|块|${ZH_COUNTED.join("|")})?`,
    "gu",
  );
  return text.replace(
    pattern,
    (
      match: string,
      percent: string | undefined,
      whole: string,
      places: string,
      big: string,
      unit: string | undefined,
      offset: number,
    ) => {
      const before = text.slice(0, offset).at(-1) ?? "";
      const after = text.slice(offset + match.length)[0] ?? "";
      // Beside a digit it is part of a figure already written; beside a numeral character it is a word.
      if (/[\d.,]/.test(before) || /\d/.test(after) || [...ZH_NUMERAL].includes(before))
        return match;
      const fraction = places === "" ? "" : `.${zhDigits(places.slice(1))}`;
      if (percent) {
        if (whole === "百" && places === "" && big === "") return `100%${unit ?? ""}`;
        const value = zhStandard(whole);
        return value === null || big !== "" ? match : `${grouped0(value)}${fraction}%${unit ?? ""}`;
      }
      // A year, said digit by digit.
      if (
        unit === "年" &&
        /^[零〇一二三四五六七八九]{4}$/.test(whole) &&
        places === "" &&
        big === ""
      ) {
        return `${zhDigits(whole)}年`;
      }
      // "十八点四万元": the decimal and its 万 or 亿 stay as written, the whole part is digits.
      if (places !== "" || big !== "") {
        const value = zhStandard(whole);
        if (value === null || value >= 10000 || unit === undefined || unit === "年") return match;
        if (!ZH_MONEY.includes(unit) && !ZH_COUNTED.includes(unit)) return match;
        return `${value}${fraction}${big}${unit}`;
      }
      const value = zhStandard(whole);
      if (value === null || unit === undefined) return match;
      if (unit === "月") return value >= 1 && value <= 12 ? `${value}月` : match;
      if (unit === "日" || unit === "号")
        return value >= 1 && value <= 31 ? `${value}${unit}` : match;
      if (unit === "年") return value >= 100 && value <= 2999 ? `${value}年` : match;
      // 块 is also "together" (一块去吃饭, 一块儿) and "a piece" (一块蛋糕): money from two up.
      if (unit === "块" && (value < 2 || after === "儿")) return match;
      const unitful = /[百千万亿]/.test(whole) || value > 10;
      if (ZH_MONEY.includes(unit)) return `${zhShown(whole, value)}${unit}`;
      return unitful ? `${zhShown(whole, value)}${unit}` : match;
    },
  );
}

/** What an engine said, with its numbers written as digits where they are figures. */
export function writtenNumbers(text: string): string {
  return chineseNumbers(englishNumbers(text));
}
