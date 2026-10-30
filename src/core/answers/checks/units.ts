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
  unsaidDollars,
  writesMeasure,
} from "../../../shared/figures";
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
  const currencyFigures = readFigures(claim, own).filter((figure) =>
    [...currenciesOf(figure), ...currenciesOfSign(figure)].some(isDollar),
  );
  const wanted = new Set(
    currencyFigures
      .flatMap((figure) => [...currenciesOf(figure), ...currenciesOfSign(figure)])
      .filter(isDollar),
  );
  if (wanted.size === 0) return null;
  const values = new Set(currencyFigures.map((figure) => figure.value));
  for (const { text, quote } of sources) {
    const document = text.document();
    const context = documentFigureContext([{ text: document }]);
    const onQuote = readFigures(quote, context);
    const named = namedCurrencies(quote, context, onQuote, true);
    const saysWhich = onQuote.some(
      (figure) =>
        values.has(figure.value) &&
        !bareDollar(figure) &&
        currenciesOf(figure).some((code) => wanted.has(code)),
    );
    if (saysWhich || [...named].some((code) => wanted.has(code))) continue;
    const line = currencyNamingLine(document, context, wanted);
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
  bound?: readonly BoundNumber[],
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
      given(of("yuan sign"), "yuan sign") ??
      given(of("which dollar"), "which dollar") ??
      given(of("differs"))
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
      figures: readFigures(cited, context),
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
        if (each.ambiguous.some(({ kind }) => kind !== "scale")) return [];
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
          }));
      }),
    );
    if (
      !isShare(figure.unit) &&
      sameWritten.length > 0 &&
      sameWritten.every(({ scale }) => scale !== figure.scale) &&
      !bound?.some(({ scale }) => scale === figure.scale)
    ) {
      const stated = sameWritten.some(({ text, context }) =>
        readStatedUnits(text.document(), context).some(
          (statement) =>
            statement.scale === figure.scale &&
            (figure.unit.kind !== "currency" ||
              (statement.unit.kind === "currency" && statement.unit.code === figure.unit.code) ||
              // "Results ($m)" states a dollar figure's scale, and leaves which dollar to the currency rule.
              (isDollar(figure.unit.code) && bareDollarStatement(statement)) ||
              same.some(({ unit }) => unit.kind === "currency")),
        ),
      );
      const amount = sameWritten[0]?.chars ?? figure.chars;
      if (!stated)
        return { kind: "scale", figure: figure.chars, amount, matches: matchesOf(sameWritten) };
      // "Results ($m)" over a cited "Revenue 54" gives the scale and a dollar, not which one.
      const code = figure.unit.kind === "currency" ? figure.unit.code : null;
      if (
        code !== null &&
        isDollar(code) &&
        !bareDollar(figure) &&
        !same.some(({ unit }) => unit.kind === "currency") &&
        !read.some((each) => namesWhich(each, code))
      )
        return { kind: "which dollar", amount, matches: matchesOf(sameWritten) };
    }
    const decided = worked.some(({ start, end }) => start < figure.end && figure.start < end);
    const otherwise = decided ? null : givenOtherwise(figure, read, bound);
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
    if (read.some((each) => plainSays(figure, each, codes) === "which dollar"))
      return { kind: "which dollar", amount, matches };
    return { kind: "currency", currency: figure.currency ?? [...codes][0] ?? "", amount, matches };
  }
  return null;
}
