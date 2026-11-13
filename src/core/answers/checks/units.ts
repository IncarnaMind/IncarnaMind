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
import { INTEGER_WORDS, wholeNumberWords } from "../../../shared/numberWords";
import { documentFigureContext } from "../calculations";

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

const sameValue = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));

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
const CN_CHANGE_BEFORE =
  /(?:上升|上涨|下降|下跌|提高|降低|增加|减少|回落|反弹|攀升|下滑|涨|跌|升|降)了?\s*$/u;

function sharesInWords(text: string): Figure[] {
  return [...text.matchAll(SHARE_IN_WORDS)].flatMap((match) => {
    const [said, whole = "", places = "", unit = ""] = match;
    if (/^points?$/iu.test(unit) && !CHANGE_BEFORE.test(text.slice(0, match.index))) return [];
    const value = wholeNumberWords(whole);
    if (value === null) return [];
    const decimals = places
      .split(" ")
      .slice(2)
      .map((word) => DIGIT_WORDS.indexOf(word.toLowerCase()))
      .join("");
    const [figure] = readFigures(`${value}${decimals ? `.${decimals}` : ""} ${unit}`);
    if (!figure) return [];
    return [{ ...figure, start: match.index, end: match.index + said.length, chars: said }];
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
const writtenShare = (figure: Figure) =>
  figure.value *
  10 ** (/‰/.test(figure.chars) ? 3 : /基点|bps?\b|basis/i.test(figure.chars) ? 4 : 2);

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
  if (equal.some(({ reading }) => reading.unit.kind === figure.unit.kind)) return null;
  const plain = valued(isShare(figure.unit) ? writtenShare(figure) : figure.value).filter(
    ({ number }) => readingsOf(number).every(({ unit }) => unit.kind === "plain"),
  );
  const written = plain.some(
    ({ each }) =>
      writesMeasure(each.cited, measure) || writesMeasure(each.text.document(), measure),
  );
  return written ? null : given(plain);
}

// A unit in brackets is read as its own unit line: "（万千瓦时）" as "单位：万千瓦时"; "（预计）" states none.
const bracketedUnits = (written: string, context: FigureContext): StatedUnit[] =>
  [...written.matchAll(/[(（]([^()（）\n]{1,24})[)）]/gu)].flatMap(([bracket, inner = ""]) =>
    readStatedUnits(`单位：${inner}`, context).map((statement) => ({
      ...statement,
      chars: bracket,
    })),
  );

// A sentence's end in either language; "1.20" holds no end.
const SENTENCE_END = /[。；;！？!?]|\.(?!\d)/u;
// A scale word, not the 千 of 千瓦时 or 千克.
const SCALED = /亿|万|千(?!瓦|克|米)|百万|thousand|million|billion|trillion/iu;

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
      label = bracketedUnits(labelLine, context).slice(-1);
      continue;
    }
    if (readFigures(line, context).length > 0) {
      if (named) break;
      continue;
    }
    label = bracketedUnits(line, context).slice(-1);
    labelLine = line;
    named = true;
  }
  const mine = [
    ...ownLabel.map((statement) => ({ ...statement, own: true, line: ownWords })),
    ...label.map((statement) => ({ ...statement, own: false, line: labelLine })),
  ];
  if (!inTable) return mine;
  const cells: string[] = [];
  for (let at = above.length - 1; at >= 0 && above[at]?.includes("\t"); at--) {
    const cell = above[at]?.split("\t")[column]?.trim();
    if (cell) cells.push(cell);
  }
  return [
    ...mine,
    // A merged heading over columns of two units ("亿美元 / 亿SDR") states neither.
    ...cells
      .filter((cell) => cell.split(/[/／、]/u).filter((part) => SCALED.test(part)).length < 2)
      // A heading cell is read as its own unit line too: "亿SDR" states 亿 though SDR is unread.
      .flatMap((cell) =>
        [
          ...readStatedUnits(cell, context),
          ...readStatedUnits(`单位：${cell}`, context).map((statement) => ({
            ...statement,
            chars: cell,
          })),
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
  /** Whether a dollar or ¥ the Document leaves unsaid is read ("which dollar", "yuan sign"). */
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
    const same: { text: CheckedText | null; start: number; chars: string; unit: FigureUnit }[] =
      bound?.map(({ chars, unit }) => ({ text: null, start: 0, chars, unit })) ??
      read.flatMap(({ text, figures }) =>
        figures.flatMap((each) =>
          readingsOf(each)
            .filter((reading) => sameValue(reading.value, figure.value))
            .map((reading) => ({ text, start: each.start, chars: each.chars, unit: reading.unit })),
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
          }));
      }),
    );
    if (
      !isShare(figure.unit) &&
      sameWritten.length > 0 &&
      sameWritten.every(({ scale }) => scale !== figure.scale) &&
      !bound?.some(({ scale }) => scale === figure.scale)
    ) {
      // A label's "（万千瓦时）" states the scale of energy, not of tonnes nor of money.
      const ofItsMeasure = (statement: StatedUnit) =>
        figure.unit.kind === "currency"
          ? measureOf(statement.unit) === null
          : measureOf(figure.unit) === null ||
            statement.unit.kind !== "other" ||
            measureOf(statement.unit) === measureOf(figure.unit);
      // A plain number with a label of its own takes that label's scale, not a Document line's
      // ("各月收入（万元）" over another heading's numbers).
      const labels = sameWritten.map(({ text, start, context, plain }) =>
        text.gateReads && plain ? labelled(text.cited(), start, context) : [],
      );
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
                (measureOf(figure.unit) !== null &&
                  measureOf(statement.unit) === measureOf(figure.unit))));
      const stated = sameWritten
        .flatMap(({ text, context, start }, at) => {
          const own = labels[at] ?? [];
          if (own.length > 0) return ownFirst(own, ofItsMeasure);
          const cited = text.cited();
          const itsLine = cited
            .slice(cited.lastIndexOf("\n", start - 1) + 1)
            .split("\n")[0]
            ?.trim();
          const bracketed = text.gateReads
            ? text
                .document()
                .split("\n")
                .filter(
                  (line) =>
                    !line.includes("\t") &&
                    line.trim() !== itsLine &&
                    readFigures(line, context).length === 0,
                )
                .flatMap((line) => bracketedUnits(line, context))
                .filter(sameUnit)
            : [];
          return [...readStatedUnits(text.document(), context), ...bracketed];
        })
        .some(
          (statement) =>
            statement.scale === figure.scale &&
            (figure.unit.kind !== "currency" ||
              (statement.unit.kind === "currency" && statement.unit.code === figure.unit.code) ||
              // "Results ($m)" states a dollar figure's scale, and leaves which dollar to the currency rule.
              (isDollar(figure.unit.code) && bareDollarStatement(statement)) ||
              same.some(({ unit }) => unit.kind === "currency")),
        );
      const amount = sameWritten[0]?.chars ?? figure.chars;
      if (!stated)
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
        : measureOf(figure.unit) !== null && measureOf(statement.unit) === measureOf(figure.unit);
    const asWritten = same.some(({ unit }) => JSON.stringify(unit) === JSON.stringify(figure.unit));
    const misread =
      isShare(figure.unit) || bound || asWritten
        ? undefined
        : sameWritten.flatMap(({ text, start, context, chars, scale, plain }) => {
            if (!text.gateReads || !plain || scale !== figure.scale) return [];
            const labels = ownFirst(labelled(text.cited(), start, context), ofItsKind);
            if (labels.length === 0 || labels.some((label) => label.scale === figure.scale))
              return [];
            // A unit line that holds the label ("单位：吨（万吨）") leaves the scale open; one
            // elsewhere in the Document doesn't outrank the label.
            if (
              labels.some((label) =>
                readStatedUnits(label.line, context).some(
                  (each) => ofItsKind(each) && each.scale === figure.scale,
                ),
              )
            )
              return [];
            return labels.map((label) => ({ text, start, label: label.chars, chars }));
          })[0];
    if (misread) {
      const { chars, label } = misread;
      const amount = label.startsWith("（") ? `${chars}${label}` : `${chars} ${label}`;
      return { kind: "scale", figure: figure.chars, amount, matches: matchesOf([misread]) };
    }
    const decided = worked.some(({ start, end }) => start < figure.end && figure.start < end);
    const otherwise = decided ? null : givenOtherwise(figure, read, bound, unsaid);
    if (otherwise) return otherwise;
    if (same.length === 0) continue;
    if (isShare(figure.unit)) {
      if (same.some(({ unit }) => unit.kind === figure.unit.kind)) continue;
      const other = same.find(({ unit }) => isShare(unit));
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
    return { kind: "currency", currency: figure.currency ?? [...codes][0] ?? "", amount, matches };
  }
  return null;
}
