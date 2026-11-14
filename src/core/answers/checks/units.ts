/** A model reads "54,000" in a UK contract as pounds and calls "£54,000" supported (#1332), so a program decides. */
import {
  bareDollar,
  bareDollarStatement,
  currenciesOf,
  currenciesOfSign,
  currencyNamingLine,
  type Figure,
  type FigureContext,
  type FigureUnit,
  isDollar,
  measureOf,
  namedCurrencies,
  type Reading,
  readFigures,
  readingsOf,
  readStatedUnits,
  type StatedUnit,
  unsaidDollars,
  writesMeasure,
} from "../../../shared/figures";
import { INTEGER_WORDS, NUMBER_WORD, SCALES, wholeNumberWords } from "../../../shared/numberWords";
import type { TextRange } from "../../../shared/quoteMatch";
import { documentFigureContext, mayLeaveOut } from "../calculations";
import {
  type CellNames,
  cellNames,
  isRow,
  ownNames,
  possibleLabels,
  saysName,
  tableAt,
} from "./figureMeasures";

export type UnitNotStated =
  /** `currency` as the sentence writes it ("£", "英镑"), `amount` as the Document does ("54,000"). */
  (
    | { kind: "currency"; currency: string; amount: string }
    /**
     * A percent where the Document gives percentage points, or points where it gives a percent; an
     * amount of the same value in another currency; or a unit on a number the Document gives plain.
     */
    | { kind: "unit"; figure: string; amount: string }
    /** The same written number at another scale, with no stated unit or scale to settle it. */
    | { kind: "scale"; figure: string; amount: string }
    /** A named dollar where the Document gives a bare "$" and never says which (#2226). */
    | { kind: "which dollar"; amount: string }
    /** Another currency for a "¥" in Chinese text, where it means 人民币 (#2226). */
    | { kind: "yuan sign"; amount: string }
  ) & { matches: readonly { text: CheckedText; start: number }[] };

/** A Citation's text, read only when it is needed. */
export interface CheckedText {
  /** The Units it points to, or its quote. */
  cited(): string;
  /** Its Document's whole text. */
  document(): string;
  /**
   * Whether it is read as the unit gate reads the cited Units (#2997): a share as people say it
   * ("six percentage points", "20点"), and a unit its label or column heading states. The
   * calculation gate reads only the quote and leaves a figure it finds otherwise to that gate, so
   * it reads neither: another line of the Units may state what the quote doesn't.
   */
  gateReads?: boolean;
}

export const sameValue = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));

const isShare = (unit: FigureUnit) => unit.kind === "percent" || unit.kind === "points";

const hasUnit = (figure: Figure) =>
  currenciesOf(figure).length > 0 ||
  isShare(figure.unit) ||
  measureOf(figure.unit) !== null ||
  figure.scaleWord !== null;

// A count or a measure ("14号2室", "3楼") is never an amount written at another scale (#2189).
const isAmount = (unit: FigureUnit) => unit.kind === "plain" || unit.kind === "currency";

const DIGIT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
// "six percentage points" is read only before a share's own unit, so a number said in running
// speech stays a word; a Transcript keeps such a number as said (#2997).
const SHARE_IN_WORDS = new RegExp(
  `\\b(${INTEGER_WORDS})((?: point(?: (?:${DIGIT_WORDS.join("|")}))+)?) (percent|per cent|percentage points?|basis points?|points?)\\b`,
  "gi",
);
// Bare points are a share only as a change ("rose six points"), never as a count ("three points
// to cover", "he raised three points") (#2997).
const CHANGE_BEFORE =
  /\b(?:rise|rises|rising|risen|rose|fall|falls|falling|fallen|fell|up|down|by|gain|gains|gained|lose|loses|lost|drop|drops|dropped|climb|climbs|climbed|increase|increases|increased|decrease|decreases|decreased)(?: by| of)? $/iu;
// A number said in words is read whole or not at all: "a hundred and five percentage points" is
// no 5, and the "point" of "two point five" is no unit (#2997).
const DECIMAL_WORD = `${DIGIT_WORDS.join("|")}|oh`;
const REST_BEFORE = new RegExp(
  `(?:\\b(?:hundred|${[...SCALES.keys()].join("|")})(?:[ -]and)?[ -]|(?:\\d|\\b(?:${NUMBER_WORD}|oh)) point(?: (?:${DECIMAL_WORD}))* )$`,
  "iu",
);
const REST_AFTER = new RegExp(`^ (?:\\d|(?:${NUMBER_WORD}|oh)\\b)`, "iu");
/** Longer than any words read beside a number. */
const NEAR = 24;
const CN_CHANGE_BEFORE =
  /(?:上升|上涨|下降|下跌|提高|降低|增加|减少|回落|反弹|攀升|下滑|涨|跌|升|降)了?\s*$/u;

function sharesInWords(text: string): Figure[] {
  return [...text.matchAll(SHARE_IN_WORDS)].flatMap((match) => {
    const [said, whole = "", places = "", unit = ""] = match;
    const end = match.index + said.length;
    const before = text.slice(Math.max(0, match.index - NEAR), match.index);
    if (REST_BEFORE.test(before)) return [];
    if (/^points?$/iu.test(unit)) {
      if (!CHANGE_BEFORE.test(before)) return [];
      if (/^point$/iu.test(unit) && REST_AFTER.test(text.slice(end, end + NEAR))) return [];
    }
    const value = wholeNumberWords(whole);
    if (value === null) return [];
    const decimals = places
      .split(" ")
      .slice(2)
      .map((word) => DIGIT_WORDS.indexOf(word.toLowerCase()))
      .join("");
    const [figure] = readFigures(`${value}${decimals ? `.${decimals}` : ""} ${unit}`);
    if (!figure) return [];
    return [{ ...figure, start: match.index, end, chars: said }];
  });
}

/**
 * A plain number before 点 after a rise or fall may be an index's points, which a percent isn't:
 * "指数上涨了20点" gives 20点 against "20%". Elsewhere 点 counts ("提出了3点意见") or tells the
 * time; a time ("下午3点", "3点半") and a decimal in words ("三点五") are read whole already (#2997).
 */
function withPointsAfter(text: string) {
  return (figure: Figure): Figure => {
    if (
      figure.unit.kind !== "plain" ||
      !/^点(?![\d０-９〇零一二两三四五六七八九十])/u.test(text.slice(figure.end)) ||
      !CN_CHANGE_BEFORE.test(text.slice(0, figure.start))
    )
      return figure;
    const [points] = readFigures(`${figure.value} percentage points`);
    if (!points) return figure;
    return {
      ...figure,
      end: figure.end + 1,
      chars: `${figure.chars}点`,
      ambiguous: [...figure.ambiguous, { kind: "points", readings: [figure, points] }],
    };
  };
}

// Separators may stay unsettled: read with the cited text's context, the same digits read the same.
function figuresToCheck(claim: string, context: FigureContext): Figure[] {
  return readFigures(claim, context).filter(
    (figure) =>
      hasUnit(figure) &&
      figure.ambiguous.every((each) => each.kind === "currency" || each.kind === "separator"),
  );
}

interface Read {
  text: CheckedText;
  cited: string;
  context: FigureContext;
  figures: Figure[];
  named: Set<string> | null;
  inDocument: Set<string> | null;
  which: Set<string> | null;
  whichInDocument: Set<string> | null;
  language: string | null;
}

const namedInCited = (each: Read) =>
  (each.named ??= namedCurrencies(each.cited, each.context, each.figures));

const namedInDocument = (each: Read) =>
  (each.inDocument ??= namedCurrencies(each.text.document(), each.context, null));

const named = (each: Read, code: string) =>
  namedInCited(each).has(code) || namedInDocument(each).has(code);

function namesWhich(each: Read, code: string): boolean {
  each.which ??= namedCurrencies(each.cited, each.context, each.figures, true);
  if (each.which.has(code)) return true;
  each.whichInDocument ??= namedCurrencies(each.text.document(), each.context, null, true);
  return each.whichInDocument.has(code);
}

const onNamedDollar = (each: Read, code: string) =>
  each.figures.some((other) =>
    readingsOf(other).some(
      (reading) =>
        reading.unit.kind === "currency" &&
        reading.unit.code === code &&
        unsaidDollars(other, reading, each.cited, each.context) === null,
    ),
  );

/**
 * What a cited plain number says of `figure`'s currencies, `codes`: "agrees" where its cited text
 * or Document names one, and "which dollar" where they write a dollar only by a bare "$" or
 * "dollars" and `figure` names which. A plain number takes a dollar only where its Document says
 * which (#2226).
 */
function plainSays(
  figure: Figure,
  each: Read,
  codes: ReadonlySet<string>,
): "agrees" | "which dollar" | null {
  const bare = bareDollar(figure);
  const says = (code: string) =>
    !isDollar(code) || bare || namesWhich(each, code) || onNamedDollar(each, code);
  if ([...codes].some((code) => named(each, code) && says(code))) return "agrees";
  if (bare || ![...codes].some(isDollar)) return null;
  const said = [...namedInCited(each), ...namedInDocument(each)];
  return said.some((code) => !says(code)) ? "which dollar" : null;
}

/** A Citation's Document, and the quote its card shows (#2226). */
export interface DollarClauseSource {
  text: CheckedText;
  quote: string;
}

/** A line of a cited Document's own that says which dollar a sentence names (#2226). */
export interface DollarClause {
  text: CheckedText;
  /** The line, as its Document writes it. */
  line: string;
}

// "All amounts are in US dollars.", "Currency: AUD", "单位：人民币", "所有金额均以美元计。"
const DOCUMENT_WIDE =
  /(?:\b(?:amounts?|figures?|sums?|values?|prices?)\s+(?:are|is)\s+(?:in|stated|expressed|shown|denominated|payable)\b|\b(?:all|every|any)\s+(?:amounts?|figures?|sums?|values?|prices?)\b|\b(?:amounts?|figures?|sums?|values?|prices?)\s+in\b|\bcurrenc(?:y|ies)\b|(?:单位|币种)\s*[:：]|(?:所有|全部|各项)?金额|(?:所有|全部|各项)?价款)/i;
// "“$” means Australian dollars.", "本合同中“$”指澳元。"
const DEFINED =
  /\b(?:means|is defined as|shall mean|refers to|denotes)\b|["”]\s*(?:指|是指|系指|定义为|指的是)/i;
const subjectSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
// Joining words and measures too general to name what a clause is about: "The rent is paid each year." speaks of the rent, not the year.
const SUBJECT_STOPWORDS = new Set(
  [
    "the and for are was were is in on at by with of to from as per a an this that these those its their his her our your all any each every such no not or if then than be been being has have had do does did will would shall should may might must can could year years month months day days period periods amount amounts total totals sum sums figure figures value values price prices currency currencies money rate rates document documents stated shown expressed paid payable payment payments made under same other which who what when",
    "每年 每月 每日 金额 总额 合计 总计 单位 币种 合同 本文 所有 全部 支付 付款 约定 规定 相关 以上 以下 其他 以及 根据 按照 进行 可以 应当",
  ]
    .join(" ")
    .split(" "),
);

/** The words of `text` a clause shares when it speaks of the same subject, currency names and joining words left out. */
function subjectWords(text: string, context: FigureContext): Set<string> {
  const words = new Set<string>();
  for (const { segment, isWordLike } of subjectSegmenter.segment(text.normalize("NFKC"))) {
    if (!isWordLike) continue;
    const word = segment.toLowerCase();
    if (word.length < 2 || SUBJECT_STOPWORDS.has(word) || /\p{N}/u.test(word)) continue;
    if (namedCurrencies(word, context, null).size > 0) continue;
    words.add(word);
  }
  return words;
}

/** Whether `line` states the Document's own currency, rather than another payment's. */
const documentWide = (line: string, context: FigureContext): boolean =>
  readStatedUnits(line, context).some(({ unit }) => unit.kind === "currency") ||
  DOCUMENT_WIDE.test(line) ||
  DEFINED.test(line);

/**
 * The line of a cited Document that says which dollar a bare "$" or "dollars" in `claim` is, in
 * words, a code, a heading, a unit line or a definition, when the quote its card shows doesn't
 * name that dollar itself (#2226). Null when the quote says it, or no Document does.
 */
export function dollarClause(
  claim: string,
  sources: readonly DollarClauseSource[],
): DollarClause | null {
  const own = documentFigureContext([{ text: claim }]);
  const pairs = readFigures(claim, own).flatMap((figure) =>
    [...new Set([...currenciesOf(figure), ...currenciesOfSign(figure)])]
      .filter(isDollar)
      .map((code) => ({ code, value: figure.value })),
  );
  if (pairs.length === 0) return null;
  for (const { text, quote } of sources) {
    const document = text.document();
    const context = documentFigureContext([{ text: quote || document.slice(0, 20_000) }]);
    const onQuote = readFigures(quote, context);
    const named = namedCurrencies(quote, context, onQuote, true);
    const beside = onQuote.filter((figure) => !bareDollar(figure));
    // The quote settles a dollar only for its own figure: another figure's "US$5,000" says nothing of a bare "$54,000".
    const wanted = new Set(
      pairs
        .filter(
          ({ code, value }) =>
            !named.has(code) &&
            !beside.some(
              (figure) => sameValue(figure.value, value) && currenciesOf(figure).includes(code),
            ),
        )
        .map(({ code }) => code),
    );
    if (wanted.size === 0) continue;
    const mine = subjectWords(claim, context);
    const line = currencyNamingLine(
      document,
      context,
      wanted,
      (each) =>
        documentWide(each, context) ||
        [...subjectWords(each, context)].some((word) => mine.has(word)),
    );
    if (line !== null) return { text, line };
  }
  return null;
}

function matchesOf(found: readonly { text: CheckedText | null; start: number }[]) {
  const read = found.flatMap(({ text, start }) => (text === null ? [] : [{ text, start }]));
  return read.filter(
    (each, at) =>
      !read
        .slice(0, at)
        .some((earlier) => earlier.text === each.text && earlier.start === each.start),
  );
}

// "12%" is the plain 12 a table cell shows, "5‰" 5 and "50 bps" 50.
const sharePlaces = (chars: string) =>
  /‰/.test(chars) ? 3 : /基点|bps?\b|basis/i.test(chars) ? 4 : 2;
export const writtenShare = (figure: Figure) => figure.value * 10 ** sharePlaces(figure.chars);

function givenAs(number: Figure, reading: Reading): string {
  if (
    reading.scale === number.scale &&
    JSON.stringify(reading.unit) === JSON.stringify(number.unit)
  )
    return number.chars;
  const unit = reading.unit.kind === "currency" ? reading.unit.code : null;
  return `${number.chars} (${[unit, reading.scaleWord].filter(Boolean).join(" ")})`;
}

/**
 * The figure's unit, when its Citations give a number of its value otherwise: an amount in another
 * currency, or a plain number for a figure in a measure (tonnes, a percent) of which neither the
 * cited text nor its Document writes any unit. Null when they give it the figure's unit, or when it
 * can't be told: a sign that may stand for the figure's currency, which its Document names, agrees,
 * and so does a plain number where the Document names that currency; two units of one measure
 * ("tonnes", "t"), a count ("54家") and money against a count are the model's to judge.
 */
function givenOtherwise(
  figure: Figure,
  after: string,
  read: readonly Read[],
  bound: readonly BoundNumber[] | undefined,
  unsaid: boolean,
): UnitNotStated | null {
  const valued = (value: number) =>
    read.flatMap((each) =>
      each.figures
        .filter((number) => !bound || bound.some(({ chars }) => chars === number.chars))
        .flatMap((number) =>
          readingsOf(number)
            .filter((reading) => sameValue(reading.value, value))
            .map((reading) => ({ each, number, reading })),
        ),
    );
  type Valued = ReturnType<typeof valued>;
  const given = (found: Valued, kind: "unit" | "which dollar" | "yuan sign" = "unit") => {
    const [first] = found;
    if (!first) return null;
    // A bare "$" heading's reading is in no named dollar: "54,000 ($)", never "54,000 (USD)".
    const unsaid = kind === "which dollar" && first.number.currency === null;
    const amount = unsaid
      ? `${first.number.chars} ($${first.reading.scaleWord ?? ""})`
      : givenAs(first.number, first.reading);
    const matches = matchesOf(
      found.map(({ each, number }) => ({ text: each.text, start: number.start })),
    );
    const problem: UnitNotStated =
      kind === "unit" ? { kind, figure: figure.chars, amount, matches } : { kind, amount, matches };
    return problem;
  };
  const equal = valued(figure.value);
  if (figure.unit.kind === "currency") {
    const codes = new Set([...currenciesOf(figure), ...currenciesOfSign(figure)]);
    const judged = equal.map((found) => {
      const { each, number, reading } = found;
      if (reading.unit.kind === "plain")
        return { found, as: plainSays(figure, each, codes) === "agrees" ? "agrees" : "plain" };
      if (reading.unit.kind !== "currency") return { found, as: "other" };
      const dollars = unsaidDollars(number, reading, each.cited, each.context);
      if (dollars) {
        const said = dollars.filter((code) => namesWhich(each, code));
        if (said.length > 0)
          return { found, as: said.some((code) => codes.has(code)) ? "agrees" : "differs" };
        if (bareDollar(figure)) return { found, as: "agrees" };
        return { found, as: dollars.some((code) => codes.has(code)) ? "which dollar" : "differs" };
      }
      // "¥" is 人民币 in a Chinese Document and the yen in a Japanese one, whatever one line reads as.
      const yen = codes.has("JPY");
      if (
        currenciesOfSign(number).includes("JPY") &&
        yen !== codes.has("CNY") &&
        !namesWhich(each, yen ? "JPY" : "CNY")
      ) {
        each.language ??= documentFigureContext([{ text: each.text.document() }]).language ?? "";
        if (each.language.startsWith("ja")) return { found, as: yen ? "agrees" : "differs" };
        if (each.language.startsWith("zh")) return { found, as: yen ? "yuan sign" : "agrees" };
      }
      if (codes.has(reading.unit.code)) return { found, as: "agrees" };
      if (currenciesOfSign(number).some((code) => codes.has(code) && named(each, code)))
        return { found, as: "agrees" };
      return { found, as: "differs" };
    });
    if (judged.some(({ as }) => as === "agrees")) return null;
    const of = (as: string) => judged.filter((each) => each.as === as).map(({ found }) => found);
    return (
      (unsaid
        ? (given(of("yuan sign"), "yuan sign") ?? given(of("which dollar"), "which dollar"))
        : null) ?? given(of("differs"))
    );
  }
  const measure = measureOf(figure.unit);
  if (measure === null) return null;
  if (equal.some(({ reading }) => reading.unit.kind === figure.unit.kind)) {
    // A number that writes another unit at itself states it: one unit at two scales ("1500瓦" isn't
    // "1500千瓦") or a unit of another measure ("31瓦" isn't "31吨"). A count beside a measure is the
    // model's; a unit a heading lends a number isn't written at it; and a plain number of its value
    // may be the one the sentence reads.
    const another = (unit: FigureUnit) =>
      ofOneUnit(unit, figure.unit)
        ? atOneScale({ scale: 1, unit }, { scale: 1, unit: figure.unit }) === false
        : measureInFull(unit) !== null && measureInFull(unit) !== measureInFull(figure.unit);
    const apart = equal.every(
      ({ number, reading }) =>
        JSON.stringify(reading.unit) === JSON.stringify(number.unit) &&
        reading.unit.kind === figure.unit.kind &&
        another(reading.unit),
    );
    return apart ? given(equal) : null;
  }
  const plain = valued(isShare(figure.unit) ? writtenShare(figure) : figure.value).filter(
    ({ number }) => readingsOf(number).every(({ unit }) => unit.kind === "plain"),
  );
  const written = plain.some(
    ({ each }) =>
      writesMeasure(each.cited, measure, figure.unit) ||
      writesMeasure(each.text.document(), measure, figure.unit),
  );
  if (written) return null;
  // A label that reaches one of them names the unit: under a column headed "瓦" a 31 is 31瓦. With
  // none, a line that heads its rows may say it: "本报告产量以瓦计。" over its table.
  const labelNamesIt = plain.some(({ each, number }) => {
    const labels = labelsOf(each.text, number.start, each.context);
    if (labels.length > 0)
      return labels.some(
        (label) => ofOneUnit(label.unit, figure.unit) && atOneScale(label, figure) === true,
      );
    if (each.text.gateReads !== true) return false;
    return headingUnits(each.cited, number.start, each.context).some((statement) =>
      namesFigure(statement, figure, after),
    );
  });
  if (labelNamesIt) return null;
  if (unsaid) return given(plain);
  // A plain number whose Document states no unit for it, nor ever writes the measure, states none:
  // the Answer's reading leaves it to the model (#2997). A label over one of two numbers written
  // the same may label another figure, so labels state another unit only where each has one.
  // A share's rival ("Change (pp)" beside a percent) is stated otherwise.
  if (
    plain.every(({ each, number }) =>
      anotherUnitStatedFor(each.text, number.start, each.context, measure),
    )
  )
    return given(plain);
  const rival =
    figure.unit.kind === "percent" ? "points" : figure.unit.kind === "points" ? "percent" : null;
  return given(
    plain.filter(
      ({ each }) =>
        rival !== null &&
        (writesMeasure(each.cited, rival) || writesMeasure(each.text.document(), rival)),
    ),
  );
}

// A scale a unit spells before another unit of its measure: 千克 is 克 a thousand times over, and
// kt is t. A squared or cubed unit scales by its power, so only these measures are read so.
const SPELLED_SCALES: readonly (readonly [string, number])[] = [
  ["千", 1e3],
  ["兆", 1e6],
  ["吉", 1e9],
  ["kilo", 1e3],
  ["mega", 1e6],
  ["giga", 1e9],
  ["k", 1e3],
  ["M", 1e6],
  ["G", 1e9],
  ["T", 1e12],
];
const SPELLING_MEASURES = new Set(["mass", "length", "power", "energy"]);
// The same unit in another word: 公斤 is 千克, 公里 is 千米, and a 度 of electricity is a 千瓦时.
const IN_OTHER_WORDS = new Map<string, readonly [times: number, base: string]>([
  ["公斤", [1e3, "克"]],
  ["公里", [1e3, "米"]],
  ["度", [1e3, "瓦时"]],
]);

/**
 * A reading with the scale its unit spells taken out of the unit: "31千克" is 克 at a thousand, and
 * so is "31公斤".
 */
function inFull({ scale, unit }: Pick<Reading, "scale" | "unit">): {
  scale: number;
  unit: FigureUnit;
} {
  if (unit.kind !== "other") return { scale, unit };
  const named = IN_OTHER_WORDS.get(unit.word);
  if (named) return { scale: scale * named[0], unit: { kind: "other", word: named[1] } };
  const measure = measureOf(unit);
  if (measure === null || !SPELLING_MEASURES.has(measure)) return { scale, unit };
  for (const [spelled, times] of SPELLED_SCALES) {
    if (!unit.word.startsWith(spelled)) continue;
    const base: FigureUnit = { kind: "other", word: unit.word.slice(spelled.length) };
    if (measureOf(base) === measure) return { scale: scale * times, unit: base };
  }
  return { scale, unit };
}

/** What a unit measures, whatever word names it: 度 measures energy, as 千瓦时 does. */
const measureInFull = (unit: FigureUnit) => measureOf(inFull({ scale: 1, unit }).unit);

// Units of these measures spell their scale, so one that spells none is at scale one: a 31 under
// "（瓦）" is 31瓦, never 31千瓦. A bare "（度）" may be degrees.
const spellsItsScale = (unit: FigureUnit) => SPELLING_MEASURES.has(measureOf(unit) ?? "");

// One base unit, as English and Chinese write it.
const BASE_UNITS = [
  "t|tonnes?|吨",
  "g|grams?|克",
  "m|met(?:re|er)s?|米",
  "W|watts?|瓦",
  "Wh|watt[- ]hours?|瓦时",
].map((words) => new RegExp(`^(?:${words})$`, "u"));

const oneUnit = (a: string, b: string) =>
  a === b || BASE_UNITS.some((unit) => unit.test(a) && unit.test(b));

/**
 * Whether two readings are at one scale. In one unit, each is read in full: "31千克" is at the
 * scale of a label's "（千克）" and "31 kt" at that of "(thousand tonnes)", and "31克" at neither.
 * In two units of a measure their scale words are compared, where both units spell the same scale
 * or none ("吨" and "tons"). Null where it can't be told without converting one unit into another
 * ("吨" under "（千克）", "miles" under "(km)"), which isn't attempted.
 */
function atOneScale(
  a: Pick<Reading, "scale" | "unit">,
  b: Pick<Reading, "scale" | "unit">,
): boolean | null {
  const [one, other] = [inFull(a), inFull(b)];
  if (one.unit.kind !== "other" || other.unit.kind !== "other") return a.scale === b.scale;
  if (oneUnit(one.unit.word, other.unit.word)) return sameValue(one.scale, other.scale);
  return sameValue(one.scale * b.scale, other.scale * a.scale) ? a.scale === b.scale : null;
}

/** Whether two units are one unit in full, whatever scale each spells: 千瓦 and W, 公斤 and g. */
function ofOneUnit(a: FigureUnit, b: FigureUnit): boolean {
  const [one, other] = [inFull({ scale: 1, unit: a }).unit, inFull({ scale: 1, unit: b }).unit];
  return one.kind === "other" && other.kind === "other" && oneUnit(one.word, other.word);
}

/**
 * What a piece of a heading states, read as a sentence writes it after a number ("万千瓦时" as in
 * "1万千瓦时"), so the same characters are the same scale and unit in a label and in a sentence:
 * "千克" is a unit, and "万吨/年" is 万 of 吨 (#2997). A piece no sentence writes so ("人民币万元",
 * "USD millions") is read as its own unit line ("单位：人民币万元"). A unit with no scale word
 * states its scale where a unit line would, and where units of its measure spell their scale
 * ("瓦" beside "千瓦"): then it is at scale one. A bare unit word that goes on
 * with more of a word ("人口", "吨位", "人口普查") is another word and states nothing; a piece with
 * a scale word states its unit, whatever follows ("万吨标准煤", "亿元人民币"), and a scale word
 * before a unit the reader doesn't know ("亿SDR") still states its scale.
 */
function asUnitLine(piece: string, context: FigureContext): StatedUnit[] {
  const line = `单位：${piece}`;
  const stated = readStatedUnits(line, context).filter(
    (statement) =>
      statement.unit.kind === "plain" ||
      statement.scaleWord !== null ||
      !/^\p{L}/u.test(line.slice(statement.end)),
  );
  const written = piece.trim();
  if (!/^[\p{L}%％‰]/u.test(written)) return stated;
  const after = `1${/^[A-Za-z]/.test(written) ? " " : ""}${written}`;
  const [said] = readFigures(after, { ...context, header: null, headerRead: null });
  if (said?.start !== 0 || !sameValue(said.value, said.scale)) return stated;
  const scaled = said.scaleWord !== null;
  if (!scaled && (said.unit.kind === "plain" || /^\s*\p{L}/u.test(after.slice(said.end))))
    return stated;
  if (!scaled && stated.length === 0 && !spellsItsScale(said.unit)) return stated;
  const { scale, scaleWord, unit } = said;
  const except = stated.find((statement) => statement.except)?.except;
  return [
    {
      start: 0,
      end: piece.length,
      chars: piece,
      scale,
      scaleWord,
      unit,
      ...(except && { except }),
    },
  ];
}

const statesScale = (piece: string, context: FigureContext) =>
  asUnitLine(piece, context).some((statement) => statement.scaleWord !== null);

// A unit in brackets states what its words do: "（万千瓦时）" as "万千瓦时"; "（预计）" states none,
// and neither does a bracket of two units ("（万吨/亿吨）"), where a rate has one ("（万吨/年）").
const bracketedUnits = (written: string, context: FigureContext): StatedUnit[] =>
  [...written.matchAll(/[(（]([^()（）\n]{1,24})[)）]/gu)].flatMap(([bracket, inner = ""]) =>
    inner.split(/[/／、]/u).filter((piece) => statesScale(piece, context)).length > 1
      ? []
      : asUnitLine(inner, context).map((statement) => ({ ...statement, chars: bracket })),
  );

// A heading whose brackets state two units ("各月产量（万吨）/（亿吨）", "产量（万吨）及同比（%）")
// doesn't say which of them a number under it is in.
const namesTwoUnits = (units: readonly StatedUnit[]) =>
  new Set(units.map(({ scale, unit }) => JSON.stringify([scale, unit]))).size > 1;

// A sentence's end in either language; "1.20" holds no end.
const SENTENCE_END = /[。；;！？!?]|\.(?!\d)/u;

/**
 * What the label and headings of the plain number at `start` state of its unit (#2997): the last
 * unit in brackets before it in its own sentence (in a table, its own cell); else the heading it
 * stands under ("各月充电量（万千瓦时）" over "7月: 118" and "8月: 126"); and, in a table of
 * tab-separated rows, each cell above it in its own column, as far as the table goes ("亿美元" over
 * each month's figure).
 *
 * Out of a table, the rows above it are passed over up to a blank line or a heading: a line with no
 * value of its own ("2024年各月充电量（万千瓦时）": a year isn't one) whose last bracket states a
 * unit. A row that gives a value is never a heading, whatever its brackets ("7月: 118（预计）"). A
 * line of words with no unit ("充电量") may sit under the heading, but rows above it belong to
 * another heading. In a table the cells above are its column's; heading lines count only just
 * above it.
 */
function labelled(text: string, start: number, context: FigureContext): Label[] {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const end = text.indexOf("\n", start);
  const inTable = text.slice(from, end < 0 ? undefined : end).includes("\t");
  const before = text.slice(from, start);
  const column = before.split("\t").length - 1;
  const own = inTable ? (before.split("\t").at(-1) ?? "") : before;
  const ownWords = own.split(SENTENCE_END).at(-1) ?? "";
  const ownLabel = bracketedUnits(ownWords, context).slice(-1);
  let label: StatedUnit[] = [];
  let labelLine = "";
  const above = text.slice(0, Math.max(0, from - 1)).split("\n");
  let named = false;
  for (let at = above.length - 1; ownLabel.length === 0 && label.length === 0 && at >= 0; at--) {
    const line = above[at] ?? "";
    if (line.trim() === "") break;
    if (inTable) {
      if (/\p{N}/u.test(line)) break;
      // A heading row of cells states only its own column's unit.
      labelLine = line.includes("\t") ? (line.split("\t")[column] ?? "") : line;
      const units = bracketedUnits(labelLine, context);
      if (namesTwoUnits(units)) break;
      label = units.slice(-1);
      continue;
    }
    if (readFigures(line, context).length > 0) {
      if (named) break;
      continue;
    }
    const units = bracketedUnits(line, context);
    if (namesTwoUnits(units)) break;
    label = units.slice(-1);
    labelLine = line;
    named = true;
  }
  const mine = [
    ...ownLabel.map((statement) => ({ ...statement, own: true, line: ownWords })),
    ...label.map((statement) => ({ ...statement, own: false, line: labelLine })),
  ];
  if (!inTable) return mine;
  const scaled = (part: string) =>
    statesScale(part, context) ||
    bracketedUnits(part, context).some((statement) => statement.scaleWord !== null);
  const cells: string[] = [];
  for (let at = above.length - 1; at >= 0 && above[at]?.includes("\t"); at--) {
    const cell = above[at]?.split("\t")[column]?.trim();
    // A cell of digits alone states no unit, and a long table's column is mostly such cells.
    if (cell && !/^[\d.,，\s+\-−()（）]*$/u.test(cell)) cells.push(cell);
  }
  return [
    ...mine,
    // A merged heading over columns of two units ("亿美元 / 亿SDR") states neither.
    ...cells
      .filter((cell) => cell.split(/[/／、]/u).filter(scaled).length < 2)
      // A heading cell is read as its own unit line too: "亿SDR" states 亿 though SDR is unread.
      .flatMap((cell) =>
        [
          ...readStatedUnits(cell, context),
          ...asUnitLine(cell, context).map((statement) => ({ ...statement, chars: cell })),
          ...bracketedUnits(cell, context),
        ].map((statement) => ({ ...statement, own: false, line: cell })),
      ),
  ];
}

/**
 * A unit a number's label or heading states; `own` when its own cell or sentence states it, with
 * the words (`line`) that hold it.
 */
type Label = StatedUnit & { own: boolean; line: string };

/** The labels `keep` takes, a number's own first: its cell's "（万元）" outranks its column's "亿元". */
function ownFirst(labels: readonly Label[], keep: (label: Label) => boolean): Label[] {
  const kept = labels.filter(keep);
  const own = kept.filter((label) => label.own);
  return own.length > 0 ? own : kept;
}

/**
 * The units in brackets on the Document's lines of words ("表7 各厂产量（万吨）" over its table, a
 * heading on another page): one on a line that gives a value, the number's own or a table's row,
 * labels another series (#2997).
 */
function wordLineUnits(text: CheckedText, start: number, context: FigureContext): StatedUnit[] {
  const cited = text.cited();
  const itsLine = cited
    .slice(cited.lastIndexOf("\n", start - 1) + 1)
    .split("\n")[0]
    ?.trim();
  return text
    .document()
    .split("\n")
    .filter((line) => !line.includes("\t") && line.trim() !== itsLine)
    .flatMap((line) => {
      const units = bracketedUnits(line, context);
      if (units.length === 0 || readFigures(line, context).length > 0) return [];
      // One unit at two scales on a line ("各月产量（万吨）/（亿吨）") leaves its scale unsaid.
      return units.filter(
        ({ scale, unit }) =>
          !units.some(
            (other) => other.scale !== scale && JSON.stringify(other.unit) === JSON.stringify(unit),
          ),
      );
    });
}

// A unit line's unit is read as a label's is, as a sentence writes it after a number: "单位：千克"
// is 千克, never 克 at a thousand, and "Unit: kW" is kW.
const UNIT_LINE = /^\s*(?:(?:计量|金额|货币|数量)?单位|units?)\s*[:：]\s*(\S.*?)\s*$/iu;
// "库存以吨计。", "本报告产量以瓦计。": prose that says what its Document's figures are counted in,
// as "以千元列示" says it of money; "所以" begins no such clause, and "以克计划" goes on as a word.
const UNIT_SAID =
  /(?<!所)以[ \u00a0]?([^\s以计，,。；;：:()（）]{1,8}?)[ \u00a0]?(?:列示|计|为单位|為單位)(?!\p{Script=Han})/gu;

/**
 * Whether one bracket of `words` names two units, as "（亿元，%）" does, so it gives a number
 * neither: it may still state another scale for either.
 */
const bracketNamesTwo = (words: string, context: FigureContext) =>
  [...words.matchAll(/[(（]([^()（）\n]{1,24})[)）]/gu)].some(
    ([, inner = ""]) =>
      inner.split(/[，,、；;]/u).filter((piece) => asUnitLine(piece, context).length > 0).length >
      1,
  );

/**
 * What a line of words states of its figures' units: a unit line's unit ("单位：千克"), or the
 * units its words state, in brackets or a clause of prose; none where it names two.
 */
function unitsOnLine(line: string, context: FigureContext): StatedUnit[] {
  const piece = UNIT_LINE.exec(line)?.[1];
  if (piece !== undefined) return bracketNamesTwo(piece, context) ? [] : asUnitLine(piece, context);
  if (bracketNamesTwo(line, context)) return [];
  const units = [
    ...readStatedUnits(line, context),
    ...bracketedUnits(line, context),
    ...[...line.matchAll(UNIT_SAID)].flatMap(([, said = ""]) => asUnitLine(said, context)),
  ];
  return namesTwoUnits(units) ? [] : units;
}

/**
 * Whether a statement's own exception leaves out the number at `start` ("in millions, except per
 * share data" over an "Earnings per share" row), by the names its table gives it, a cell that may
 * be its label among them, or its line's words before it, as the calculation rule reads the clause
 * (#2997).
 */
function leavesOut(
  statement: StatedUnit,
  text: string,
  start: number,
  table = tableAt(text, start),
): boolean {
  if (statement.except === undefined) return false;
  const names = table
    ? [...possibleLabels(table), ...ownNames(table)]
    : [text.slice(text.lastIndexOf("\n", start - 1) + 1, start)];
  return names.some((name) => mayLeaveOut(statement, name));
}

/**
 * What the lines that head the rows of the number at `start` state of its unit: the lines giving
 * no value directly above its own table (its rows and heading rows, `tableAt`), or above the lines
 * of a list that give a value, up to a blank line or a row that gives a value, which is another
 * table's (#2997). A line that heads other rows, or stands apart from them, states nothing here.
 */
function headingUnits(
  text: string,
  start: number,
  context: FigureContext,
  table = tableAt(text, start),
): StatedUnit[] {
  const lines = text.split("\n");
  const givesValue = (line: string) => readFigures(line, context).length > 0;
  let at = table ? table.head - 1 : text.slice(0, start).split("\n").length - 2;
  if (!table)
    while (
      at >= 0 &&
      lines[at]?.trim() !== "" &&
      !isRow(lines[at] ?? "") &&
      givesValue(lines[at] ?? "")
    )
      at--;
  const units: StatedUnit[] = [];
  for (; at >= 0; at--) {
    const line = lines[at] ?? "";
    if (line.trim() === "" || isRow(line) || givesValue(line)) break;
    units.push(...unitsOnLine(line, context));
  }
  return units.filter((statement) => !leavesOut(statement, text, start, table));
}

// A rate after a unit: "万吨/年" is 万吨 a year, and "barrels per day" barrels a day.
const RATE = /(?:[/／][ \u00a0]*([^\s/／，,。；;:：.()（）]+)|\bper[ \u00a0]+(\p{L}+))/u;
const rateIn = (words: string) => {
  const found = RATE.exec(words);
  return (found?.[1] ?? found?.[2] ?? "").toLowerCase();
};

/** Whether a statement is of `figure`'s kind of unit: a scale, or a unit of its measure or currency. */
function ofKind(statement: StatedUnit, figure: Figure): boolean {
  const { unit } = statement;
  if (unit.kind === "plain" || figure.unit.kind === "plain") return true;
  if (isShare(figure.unit)) return isShare(unit);
  if (figure.unit.kind !== "other") return unit.kind === figure.unit.kind;
  const measure = measureInFull(figure.unit);
  return (
    unit.kind === "other" &&
    (ofOneUnit(unit, figure.unit) || (measure !== null && measureInFull(unit) === measure))
  );
}

/**
 * Whether a statement gives a plain number `figure` (followed in its sentence by `after`): its unit
 * at its scale, with a share in the same notation (a "（%）" never gives "31‰") and the same rate
 * ("（万吨/年）" never gives "31万吨/日" nor a bare "31万吨", which a reader takes both for 31万吨).
 */
function namesFigure(statement: StatedUnit, figure: Figure, after: string): boolean {
  if (atOneScale(statement, figure) !== true) return false;
  if (rateIn(statement.chars) !== rateIn(/^[ \u00a0]*(?:[/／]|per\b)/u.test(after) ? after : ""))
    return false;
  if (figure.unit.kind === "plain") return true;
  if (figure.unit.kind === "other") return ofOneUnit(statement.unit, figure.unit);
  if (isShare(figure.unit))
    return (
      statement.unit.kind === figure.unit.kind &&
      sharePlaces(statement.chars) === sharePlaces(figure.chars)
    );
  return isSameUnit(statement.unit, figure.unit);
}

/**
 * Whether the labels that reach the cited number at `start` (its own, the heading over its rows,
 * its column's cell) state a unit for it and none of `measure`: under a column headed "吨" a 31 is
 * 31吨, and a label that gives only a scale ("（万）") names no unit. A bracket for another measure
 * on a line of words elsewhere states nothing for it: the gate can't tell which table a caption
 * heads (#2997).
 */
function anotherUnitStatedFor(
  text: CheckedText,
  start: number,
  context: FigureContext,
  measure: string,
): boolean {
  const labels = labelsOf(text, start, context);
  return (
    labels.length > 0 &&
    labels.every(({ unit }) => unit.kind !== "plain" && measureInFull(unit) !== measure)
  );
}

/** The labels that reach the cited number at `start`, where the gate reads labels. */
const labelsOf = (text: CheckedText, start: number, context: FigureContext): Label[] =>
  text.gateReads === true ? labelled(text.cited(), start, context) : [];

/** A figure's number as it is written: its scale word left off, a share in its own notation. */
export const writtenOf = (figure: Figure) =>
  isShare(figure.unit) ? writtenShare(figure) : figure.value / figure.scale;

/** Whether two units are one, whatever word writes it: W, watts and 瓦; kW, kilowatts and 千瓦; t, tonnes and 吨. */
export const isSameUnit = (a: FigureUnit, b: FigureUnit): boolean =>
  (a.kind === b.kind &&
    (a.kind !== "currency" || (b.kind === "currency" && a.code === b.code)) &&
    (a.kind !== "other" || (b.kind === "other" && a.word === b.word))) ||
  (ofOneUnit(a, b) && atOneScale({ scale: 1, unit: a }, { scale: 1, unit: b }) === true);

/**
 * Whether `sentence` means another number of `table` than its own (#2997): by row or by column, it
 * says another number's name, one the number's own names don't hold, and none of the number's own.
 * A name the sentence gives another of its figures (`numbers`, as written), which that cell holds,
 * is spoken for: "Seventeen deals worth £830k" says Deals for its 17.
 */
function meansAnotherCell(
  table: NonNullable<ReturnType<typeof tableAt>>,
  sentence: string,
  numbers: readonly number[],
  context: FigureContext,
): boolean {
  const names = cellNames(table);
  if (!names) return false;
  // A cell's unit is no part of its name: "人数（人）" is 人数.
  const nameOf = (cell: string) =>
    bracketedUnits(cell, context).reduce((rest, { chars }) => rest.replace(chars, " "), cell);
  const says = (cell: string) => saysName(sentence, nameOf(cell));
  const spokenFor = (cell: string) =>
    readFigures(cell, context).some((each) =>
      numbers.some((number) => sameValue(writtenOf(each), number)),
    );
  const elsewhere = ({ own, others }: CellNames) =>
    !own.some(says) &&
    others(says).some(
      ({ name, cell }) => !own.some((mine) => saysName(mine, nameOf(name))) && !spokenFor(cell),
    );
  return elsewhere(names.columns) || elsewhere(names.rows);
}

/**
 * Whether the Document states `figure` of `sentence` at each plain number of its written value that
 * `ranges` of `text` (where a quote stands) hold, as the gate reads what gives a number its unit
 * (#2997): the labels that reach it, its own first, each of the figure's kind giving it; or, where
 * none does, every unit the lines heading its rows state (`headingUnits`). Such a number of a table
 * is no number of the figure when the sentence means another of its table (`numbers`: every number
 * the sentence writes, as written); at least one number must be the figure's. A 31 under "（吨）"
 * states 31吨; one under "（万吨）" doesn't, nor does one beside a twin 31 under "（万吨）" or
 * "同比（%）", nor one under a heading block of two units, nor the 31 of a 人数 column under
 * "表3 各厂情况（千克）" for "二厂产量为31千克。".
 */
export function statesFigure(
  figure: Figure,
  sentence: { text: string; numbers: readonly number[] },
  text: string,
  ranges: readonly TextRange[],
  context: FigureContext,
): boolean {
  const after = sentence.text.slice(figure.end);
  const written = writtenOf(figure);
  const numbers = ranges.flatMap(({ start, end }) => {
    const from = text.lastIndexOf("\n", start - 1) + 1;
    const to = text.indexOf("\n", end);
    return readFigures(text.slice(from, to < 0 ? undefined : to), context).flatMap((each) =>
      from + each.start >= start &&
      from + each.end <= end &&
      each.unit.kind === "plain" &&
      each.currency === null &&
      each.scaleWord === null &&
      sameValue(each.value, written)
        ? [from + each.start]
        : [],
    );
  });
  const kind = (statement: StatedUnit) => ofKind(statement, figure);
  const gives = (statement: StatedUnit) => namesFigure(statement, figure, after);
  const others = () => sentence.numbers.filter((number) => !sameValue(number, written));
  const readings = numbers.map((start): "stated" | "unstated" | "elsewhere" => {
    // A table's labels are its own: a heading cell of a table glued above heads other rows.
    const table = tableAt(text, start);
    const from = table
      ? table.lines.slice(0, table.head).reduce((sum, line) => sum + line.length + 1, 0)
      : 0;
    const labels = labelled(text.slice(from), start - from, context);
    if (labels.length > 0) {
      const own = ownFirst(labels, kind);
      return own.length > 0 &&
        own.every(
          (label) =>
            !leavesOut(label, text, start, table) &&
            gives(label) &&
            !bracketNamesTwo(label.line, context),
        )
        ? "stated"
        : "unstated";
    }
    const heading = headingUnits(text, start, context, table);
    if (heading.length === 0 || !heading.every(gives)) return "unstated";
    return table && meansAnotherCell(table, sentence.text, others(), context)
      ? "elsewhere"
      : "stated";
  });
  return readings.includes("stated") && !readings.includes("unstated");
}

/** A number a figure was compared with: as its quote writes it, in its unit and scale. */
export interface BoundNumber {
  chars: string;
  unit: FigureUnit;
  scale: number;
}

/**
 * What `claim` gives a figure that its Citations (`citations`, each with its own Document) state
 * without it: a currency on a plain number, which no cited Unit nor any of their Documents names;
 * a percent where they give only percentage points; points where they give only a percent;
 * another scale of the same written number; another currency for the same amount; or a unit on a
 * number they give plain and never write the unit of (#1452). Null when it gives none. A figure
 * they don't state is the model's to judge, unless `bound` names the numbers it was compared
 * with: then their units and scales are what the Citations give it, equal or not. A figure in
 * `worked` came out of a calculation: no cited amount of its value is its source, so only its
 * currency on a plain number and its scale are checked.
 */
export function unitNotStated(
  claim: string,
  citations: readonly CheckedText[],
  bound?: readonly BoundNumber[],
  worked: readonly Pick<Figure, "start" | "end">[] = [],
  /**
   * Whether a finding resting on what the Document leaves unsaid is read: which dollar a bare "$"
   * is, the yuan sign, and a unit, currency or scale it states nowhere for the figure. The Answer's
   * reading leaves those to the model (#2997, #3030).
   */
  unsaid = true,
): UnitNotStated | null {
  const own = documentFigureContext([{ text: claim }]);
  if (citations.length === 0 || !readFigures(claim, own).some(hasUnit)) return null;
  const read: Read[] = citations.map((text) => {
    const cited = text.cited();
    const context = documentFigureContext([{ text: cited }]);
    return {
      text,
      cited,
      context,
      figures: text.gateReads
        ? [...readFigures(cited, context).map(withPointsAfter(cited)), ...sharesInWords(cited)]
        : readFigures(cited, context),
      named: null,
      inDocument: null,
      which: null,
      whichInDocument: null,
      language: null,
    };
  });
  const [first] = read;
  for (const figure of figuresToCheck(claim, own.language || !first ? own : first.context)) {
    // Numbers `bound` names were compared with, not read from one Citation: they match no text.
    const same: {
      text: CheckedText | null;
      start: number;
      chars: string;
      unit: FigureUnit;
      /** A reading of "3 points" or "3个点" as percentage points, which may count things instead. */
      loose?: boolean;
    }[] =
      bound?.map(({ chars, unit }) => ({ text: null, start: 0, chars, unit })) ??
      read.flatMap(({ text, figures }) =>
        figures.flatMap((each) =>
          readingsOf(each)
            .filter((reading) => sameValue(reading.value, figure.value))
            .map((reading) => ({
              text,
              start: each.start,
              chars: each.chars,
              unit: reading.unit,
              loose: reading.unit.kind === "points" && each.unit.kind !== "points",
            })),
        ),
      );
    const sameWritten = read.flatMap(({ text, context, figures }) =>
      figures.flatMap((each) => {
        // Read as its context reads it, "1,200" is the same written number as the sentence's
        // "$1,200" (#2997); the calculation gate leaves it unsettled.
        const settled = (kind: string) =>
          kind === "scale" || (text.gateReads === true && kind === "separator");
        if (each.ambiguous.some(({ kind }) => !settled(kind))) return [];
        if (!isAmount(each.unit)) return [];
        if (bound && !bound.some(({ chars }) => chars === each.chars)) return [];
        const readings = [
          each,
          ...each.ambiguous
            .filter(({ kind }) => kind === "scale")
            .flatMap(({ readings }) => readings),
        ];
        return readings
          .filter((reading) =>
            sameValue(reading.value / reading.scale, figure.value / figure.scale),
          )
          .map((reading) => ({
            text,
            start: each.start,
            context,
            chars: each.chars,
            scale: reading.scale,
            // Only a number with no sign, unit word or scale of its own takes its label's.
            plain: each.unit.kind === "plain" && each.currency === null && each.scaleWord === null,
            // Its own sign or scale word, or a header's scale for its kind of figure, says what
            // scale the Document gives it: a "（亿元）" row heading is no scale for tonnes.
            says:
              each.currency !== null ||
              each.scaleWord !== null ||
              (reading.scale !== each.scale &&
                (reading.unit.kind === "plain" || reading.unit.kind === figure.unit.kind)),
          }));
      }),
    );
    if (
      !isShare(figure.unit) &&
      sameWritten.length > 0 &&
      sameWritten.every(({ scale }) => scale !== figure.scale) &&
      !bound?.some(({ scale }) => scale === figure.scale)
    ) {
      // A label's "（万千瓦时）" states the scale of energy, not of tonnes nor of money, and one's
      // "（万元）" that of money, not of tonnes. A figure with a scale and no unit takes any label's.
      const ofItsMeasure = (statement: StatedUnit) =>
        figure.unit.kind === "currency"
          ? measureInFull(statement.unit) === null
          : figure.unit.kind === "plain" ||
            statement.unit.kind === "plain" ||
            (statement.unit.kind === "other" &&
              measureInFull(statement.unit) === measureInFull(figure.unit));
      const reached = sameWritten.map(({ text, start, context }) =>
        text.gateReads ? labelled(text.cited(), start, context) : [],
      );
      // A plain number with a label of its own takes that label's scale, not a Document line's
      // ("各月收入（万元）" over another heading's numbers).
      const labels = reached.map((found, at) => (sameWritten[at]?.plain ? found : []));
      const headings = labels.flat();
      // A unit in brackets on a line of words in the Document ("表7 各厂产量（万吨）" over its
      // table) states the scale as a unit line does, for that unit only: "（万千瓦时）" never opens
      // tonnes. One on a line that gives a value, its own or a table's row, labels another series.
      const sameUnit = (statement: StatedUnit) =>
        figure.unit.kind === "currency"
          ? statement.unit.kind === "currency"
          : figure.unit.kind !== "other" ||
            (statement.unit.kind === "other" &&
              (statement.unit.word === figure.unit.word ||
                (measureInFull(figure.unit) !== null &&
                  measureInFull(statement.unit) === measureInFull(figure.unit))));
      const statements = sameWritten.flatMap(({ text, context, start }, at) => {
        const own = labels[at] ?? [];
        if (own.length > 0) return ownFirst(own, ofItsMeasure);
        const bracketed = text.gateReads
          ? wordLineUnits(text, start, context).filter(sameUnit)
          : [];
        return [...readStatedUnits(text.document(), context), ...bracketed];
      });
      const stated = statements.some(
        (statement) =>
          atOneScale(statement, figure) === true &&
          (figure.unit.kind !== "currency" ||
            (statement.unit.kind === "currency" && statement.unit.code === figure.unit.code) ||
            // "Results ($m)" states a dollar figure's scale, and leaves which dollar to the currency rule.
            (isDollar(figure.unit.code) && bareDollarStatement(statement)) ||
            same.some(({ unit }) => unit.kind === "currency")),
      );
      // The Document states otherwise when the number writes its own sign or scale, a label for
      // the figure's kind of unit gives it another scale, or a line states a scale, its currency,
      // or its own unit or measure at another. A label of another measure, or a share's, may
      // label another figure ("同比（%）" beside the column the sentence reads): it states
      // otherwise only where each number written the same has such a label and no other.
      const forItsUnit = (statement: StatedUnit) =>
        (statement.unit.kind === "plain" ||
          (figure.unit.kind === "currency"
            ? statement.unit.kind === "currency"
            : figure.unit.kind === "other" && sameUnit(statement))) &&
        atOneScale(statement, figure) !== null;
      const labelsIt = (label: StatedUnit) =>
        label.unit.kind === "plain" || (!isShare(label.unit) && sameUnit(label));
      const statedOtherwise =
        sameWritten.some(
          ({ says }, at) =>
            says ||
            reached[at]?.some((label) => labelsIt(label) && atOneScale(label, figure) === false),
        ) ||
        reached.every((found) => found.length > 0 && !found.some(labelsIt)) ||
        statements.some(forItsUnit);
      const amount = sameWritten[0]?.chars ?? figure.chars;
      if (!stated && (unsaid || statedOtherwise))
        return { kind: "scale", figure: figure.chars, amount, matches: matchesOf(sameWritten) };
      // "Results ($m)" over a cited "Revenue 54" gives the scale and a dollar, not which one; a
      // column headed "亿美元" names it.
      const code = figure.unit.kind === "currency" ? figure.unit.code : null;
      if (
        unsaid &&
        code !== null &&
        isDollar(code) &&
        !bareDollar(figure) &&
        !same.some(({ unit }) => unit.kind === "currency") &&
        !read.some((each) => namesWhich(each, code)) &&
        !headings.some(
          (statement) =>
            statement.unit.kind === "currency" &&
            statement.unit.code === code &&
            !bareDollarStatement(statement),
        )
      )
        return { kind: "which dollar", amount, matches: matchesOf(sameWritten) };
    }
    // A number's own label fixes its scale: a plain "126" labelled "（万千瓦时）" is 126万千瓦时, never
    // 126千瓦时, unless a quote gives the figure as the sentence writes it.
    const ofItsKind = (statement: StatedUnit) =>
      figure.unit.kind === "currency"
        ? statement.unit.kind === "currency" && statement.unit.code === figure.unit.code
        : measureInFull(figure.unit) !== null &&
          measureInFull(statement.unit) === measureInFull(figure.unit);
    const asWritten = same.some(({ unit }) => JSON.stringify(unit) === JSON.stringify(figure.unit));
    const ownLabels =
      isShare(figure.unit) || bound || asWritten
        ? []
        : sameWritten.flatMap(({ text, start, context, chars, scale, plain }) => {
            if (!text.gateReads || !plain || scale !== figure.scale) return [];
            const reached = labelled(text.cited(), start, context);
            const labels = ownFirst(reached, ofItsKind);
            // A unit line that holds the label ("单位：吨（万吨）") leaves the scale open; one
            // elsewhere in the Document doesn't outrank the label.
            const gives = labels.some(
              (label) =>
                atOneScale(label, figure) === true ||
                readStatedUnits(label.line, context).some(
                  (each) => ofItsKind(each) && atOneScale(each, figure) === true,
                ),
            );
            // No label reaches it and no unit line is the Document's: its unit is stated nowhere.
            const bare =
              reached.length === 0 && readStatedUnits(text.document(), context).length === 0;
            return [{ text, start, chars, labels, gives, bare }];
          });
    // Of two numbers written the same the gate can't tell which the sentence reads: where one's
    // label gives the sentence's scale ("库存（吨）" beside "产量（万吨）"), or the Document states
    // no unit for one ("库存" beside "产量（万吨）"), no label is against it.
    const misread = ownLabels.some(({ gives, bare }) => gives || bare)
      ? undefined
      : ownLabels.flatMap(({ text, start, chars, labels }) =>
          labels
            .filter((label) => atOneScale(label, figure) === false)
            .map((label) => ({ text, start, label: label.chars, chars })),
        )[0];
    if (misread) {
      const { chars, label } = misread;
      const amount = label.startsWith("（") ? `${chars}${label}` : `${chars} ${label}`;
      return { kind: "scale", figure: figure.chars, amount, matches: matchesOf([misread]) };
    }
    const decided = worked.some(({ start, end }) => start < figure.end && figure.start < end);
    const otherwise = decided
      ? null
      : givenOtherwise(figure, claim.slice(figure.end), read, bound, unsaid);
    if (otherwise) return otherwise;
    if (same.length === 0) continue;
    if (isShare(figure.unit)) {
      if (same.some(({ unit }) => unit.kind === figure.unit.kind)) continue;
      // Loose points state a share only after a rise or fall; "He raised 3 points" counts them.
      const changed = (text: CheckedText | null, start: number) => {
        const before = text?.cited().slice(0, start) ?? "";
        return CHANGE_BEFORE.test(before) || CN_CHANGE_BEFORE.test(before);
      };
      const other = same.find(
        ({ unit, loose, text, start }) =>
          isShare(unit) && (unsaid || !loose || changed(text, start)),
      );
      if (other)
        return {
          kind: "unit",
          figure: figure.chars,
          amount: other.chars,
          matches: matchesOf(same.filter(({ unit }) => isShare(unit))),
        };
      continue;
    }
    if (same.some(({ unit }) => unit.kind !== "plain")) continue;
    const codes = new Set([...currenciesOf(figure), ...currenciesOfSign(figure)]);
    if (codes.size === 0) continue;
    if (read.some((each) => plainSays(figure, each, codes) === "agrees")) continue;
    const amount = same[0]?.chars ?? figure.chars;
    const matches = matchesOf(same);
    if (read.some((each) => plainSays(figure, each, codes) === "which dollar")) {
      if (!unsaid) continue;
      return { kind: "which dollar", amount, matches };
    }
    // Only where the Document names another currency does it state one for a plain number.
    if (
      !unsaid &&
      !read.some((each) => [...namedInCited(each), ...namedInDocument(each)].length > 0)
    )
      continue;
    return { kind: "currency", currency: figure.currency ?? [...codes][0] ?? "", amount, matches };
  }
  return null;
}
