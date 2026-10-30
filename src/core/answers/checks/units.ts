/** A model reads "54,000" in a UK contract as pounds and calls "£54,000" supported (#1332), so a program decides. */
import {
  currenciesOf,
  currenciesOfSign,
  type Figure,
  type FigureContext,
  type FigureUnit,
  measureOf,
  namedCurrencies,
  type Reading,
  readFigures,
  readingsOf,
  readStatedUnits,
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
  const given = (found: Valued): UnitNotStated | null => {
    const [first] = found;
    if (!first) return null;
    return {
      kind: "unit",
      figure: figure.chars,
      amount: givenAs(first.number, first.reading),
      matches: matchesOf(
        found.map(({ each, number }) => ({ text: each.text, start: number.start })),
      ),
    };
  };
  const equal = valued(figure.value);
  if (figure.unit.kind === "currency") {
    const codes = new Set([...currenciesOf(figure), ...currenciesOfSign(figure)]);
    const named = (each: Read, code: string) => {
      each.named ??= namedCurrencies(each.cited, each.context, each.figures);
      if (each.named.has(code)) return true;
      each.inDocument ??= namedCurrencies(each.text.document(), each.context, null);
      return each.inDocument.has(code);
    };
    const inCurrency = equal.filter(({ reading }) => reading.unit.kind === "currency");
    const agrees = equal.some(({ each, number, reading }) =>
      reading.unit.kind === "currency"
        ? codes.has(reading.unit.code) ||
          currenciesOfSign(number).some((code) => codes.has(code) && named(each, code))
        : reading.unit.kind === "plain" && [...codes].some((code) => named(each, code)),
    );
    return agrees ? null : given(inCurrency);
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
              same.some(({ unit }) => unit.kind === "currency")),
        ),
      );
      if (!stated) {
        return {
          kind: "scale",
          figure: figure.chars,
          amount: sameWritten[0]?.chars ?? figure.chars,
          matches: matchesOf(sameWritten),
        };
      }
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
    const names = (each: Set<string>) => [...codes].some((code) => each.has(code));
    const inCited = read.some((each) => {
      each.named ??= namedCurrencies(each.cited, each.context, each.figures);
      return names(each.named);
    });
    if (inCited) continue;
    const inDocument = read.some((each) => {
      each.inDocument ??= namedCurrencies(each.text.document(), each.context, null);
      return names(each.inDocument);
    });
    if (inDocument) continue;
    return {
      kind: "currency",
      currency: figure.currency ?? [...codes][0] ?? "",
      amount: same[0]?.chars ?? figure.chars,
      matches: matchesOf(same),
    };
  }
  return null;
}
