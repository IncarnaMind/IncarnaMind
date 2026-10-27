/** A model reads "54,000" in a UK contract as pounds and calls "£54,000" supported (#1332), so a program decides. */
import {
  currenciesOf,
  currenciesOfSign,
  type Figure,
  type FigureContext,
  type FigureUnit,
  namedCurrencies,
  readFigures,
  readingsOf,
  readStatedUnits,
} from "../../../shared/figures";
import { documentFigureContext } from "../calculations";

export type UnitNotStated =
  /** `currency` as the sentence writes it ("£", "英镑"), `amount` as the Document does ("54,000"). */
  | { kind: "currency"; currency: string; amount: string }
  /** A percent where the Document gives percentage points, or points where it gives a percent. */
  | { kind: "unit"; figure: string; amount: string }
  /** The same written number at another scale, with no stated unit or scale to settle it. */
  | { kind: "scale"; figure: string; amount: string };

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
  currenciesOf(figure).length > 0 || isShare(figure.unit) || figure.scaleWord !== null;

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

/**
 * What `claim` gives a figure that its Citations (`citations`, each with its own Document) state
 * without it: a currency on a plain number, which no cited Unit nor any of their Documents names;
 * a percent where they give only percentage points; points where they give only a percent; or
 * another scale of the same written number. Null when it gives none. A figure they don't state,
 * or state with another currency or unit, is the model's to judge.
 */
export function unitNotStated(
  claim: string,
  citations: readonly CheckedText[],
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
    const same = read.flatMap(({ figures }) =>
      figures.flatMap((each) =>
        readingsOf(each)
          .filter((reading) => sameValue(reading.value, figure.value))
          .map((reading) => ({ chars: each.chars, unit: reading.unit })),
      ),
    );
    const sameWritten = read.flatMap(({ figures }) =>
      figures.flatMap((each) => {
        if (each.ambiguous.some(({ kind }) => kind !== "scale")) return [];
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
          .map((reading) => ({ chars: each.chars, scale: reading.scale }));
      }),
    );
    if (
      !isShare(figure.unit) &&
      sameWritten.length > 0 &&
      sameWritten.every(({ scale }) => scale !== figure.scale)
    ) {
      const stated = read.some(({ text, context }) =>
        readStatedUnits(text.document(), context).some(
          (statement) =>
            statement.scale === figure.scale &&
            (statement.unit.kind === "plain" ||
              figure.unit.kind !== "currency" ||
              (statement.unit.kind === "currency" && statement.unit.code === figure.unit.code)),
        ),
      );
      if (!stated) {
        return {
          kind: "scale",
          figure: figure.chars,
          amount: sameWritten[0]?.chars ?? figure.chars,
        };
      }
    }
    if (same.length === 0) continue;
    if (isShare(figure.unit)) {
      if (same.some(({ unit }) => unit.kind === figure.unit.kind)) continue;
      const other = same.find(({ unit }) => isShare(unit));
      if (other) return { kind: "unit", figure: figure.chars, amount: other.chars };
      continue;
    }
    if (same.some(({ unit }) => unit.kind !== "plain")) continue;
    const codes = new Set([...currenciesOf(figure), ...currenciesOfSign(figure)]);
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
    };
  }
  return null;
}
