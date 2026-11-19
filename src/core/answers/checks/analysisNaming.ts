import {
  CURRENCY_ISO_CODES,
  currencyNamed,
  type FigureUnit,
  readFigures,
  readStatedUnits,
  scaleExponent,
  unsettledScales,
} from "../../../shared/figures";

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
