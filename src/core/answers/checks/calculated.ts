/**
 * A figure a sentence states that no Passage does, worked out from numbers
 * the Passages state (#707): which number of the sentence the model named as
 * that figure, and whether it agrees with the figure IncarnaMind calculated
 * (ADR-0021), to the sentence's own rounding. A program decides, not the
 * model: a wrong derived number is what an analyst fears most.
 */
import { citedCases } from "../../../shared/caseCitations";
import {
  type Figure,
  type FigureContext,
  type FigureUnit,
  figureContextOf,
  readFigures,
} from "../../../shared/figures";
import type { ResultUnit } from "../../../shared/formula";
import type { CalculatedFigure, LimitRelation } from "../../api";
import { documentFigureContext } from "../calculations";

export function figuresInClaim(text: string, context: FigureContext): Figure[] {
  const references = citedCases(text).map((reference, index, citations) => {
    const next = citations[index + 1];
    const suffix = text.slice(reference.to, next?.from);
    const closed = /^[\s.,;!?…)\]}，。；！？]*$/u.test(
      next ? suffix.replace(/\b(?:and(?:\/or)?|or)\b|[&与及和或]/giu, "") : suffix,
    );
    return { from: reference.from, to: closed ? reference.to : reference.citeTo };
  });
  return readFigures(text, context).filter(
    (figure) =>
      !references.some((reference) => figure.start >= reference.from && figure.end <= reference.to),
  );
}

/**
 * Whether `sentence` states a figure in its own way of writing numbers or in English or Chinese
 * ones: `calculate` settles only a figure the sentence states (`statedFigure`), so a check of a
 * sentence with none isn't offered it, nor its instructions (#1634).
 */
export function statesAFigure(sentence: string): boolean {
  return [
    documentFigureContext([{ text: sentence }]),
    figureContextOf(sentence, "en"),
    figureContextOf(sentence, "zh-CN"),
  ].some((context) => figuresInClaim(sentence, context).length > 0);
}

/**
 * The number of `sentence` that `stated` names ("1.1x" in "Net debt to
 * EBITDA fell to 1.1x"), as the sentence writes it; null when the sentence
 * has no such number, or it can be read more than one way. A sentence too
 * short to tell its language by writes its numbers as `document` does, the
 * Document its figure was worked out from.
 */
export function statedFigure(
  sentence: string,
  stated: string,
  document: FigureContext,
): Figure | null {
  const own = documentFigureContext([{ text: sentence }]);
  const context = own.language ? own : { ...document, header: null };
  const [named] = readFigures(stated, context);
  if (!named) return null;
  return (
    figuresInClaim(sentence, context).find(
      (figure) =>
        figure.ambiguous.length === 0 &&
        figure.value === named.value &&
        (named.unit.kind === "plain" || sameUnit(figure.unit, named.unit)),
    ) ?? null
  );
}

const sameUnit = (a: FigureUnit, b: FigureUnit): boolean =>
  a.kind === b.kind &&
  (a.kind !== "currency" || (b.kind === "currency" && a.code === b.code)) &&
  (a.kind !== "other" || (b.kind === "other" && a.word === b.word));

/** Whether a sentence's number and a result measure the same kind of thing, so they can be compared. */
function comparable(stated: FigureUnit, result: ResultUnit): boolean {
  switch (stated.kind) {
    case "percent":
      return result.kind === "percent" || result.kind === "ratio";
    case "points":
      return result.kind === "points";
    case "times":
      return result.kind === "times" || result.kind === "ratio" || result.kind === "plain";
    case "currency":
      return (result.kind === "currency" && result.code === stated.code) || result.kind === "plain";
    case "other":
      return (result.kind === "other" && result.word === stated.word) || result.kind === "plain";
    // A bare number isn't a ratio's: "42" could be 0.42 or 42%, so it is compared only with an amount.
    case "plain":
      return result.kind === "plain" || result.kind === "currency" || result.kind === "other";
  }
}

/**
 * How far a number may be from the value it was rounded from: half its last
 * place as written ("1.1x", 0.05; "25%", half a percent; "£131.9m", £50,000).
 * One written as approximate is looser: "about £130m" was rounded to its last
 * digit that isn't a zero, and "about 1.3x" is a place either way more.
 */
function tolerance(stated: Figure): number {
  const place =
    (stated.unit.kind === "percent" || stated.unit.kind === "points" ? 0.01 : 1) * stated.scale;
  let step = place * 10 ** -stated.decimals;
  let more = 0;
  if (stated.approximate && stated.decimals > 0) more = step;
  else if (stated.approximate) {
    let written = Math.round(Math.abs(stated.value) / place);
    while (written >= 10 && written % 10 === 0) {
      written /= 10;
      step *= 10;
    }
  }
  return step / 2 + more + 1e-9 * Math.max(1, Math.abs(stated.value));
}

const BRACKETED = /^[^\d]*[(（]/;

/** Whether `formula` only multiplies or divides its inputs: no sum, difference or function. */
function onlyScales(formula: string, names: readonly string[]): boolean {
  const own = new Set(names.map((name) => name.toLowerCase()));
  const rest = formula.replace(/[\p{L}_][\p{L}\p{N}_.]*/gu, (word) =>
    own.has(word.toLowerCase()) ? "" : word,
  );
  return /^[\d.\s*/()]*$/.test(rest);
}

// A minus that comes only from inputs the model marked as a cost or deduction printed in
// brackets ("Finance costs (41.2)"), in a formula that only multiplies or divides, for a sentence
// whose own number has none, is the cost's presentation: its size is meant (#1908). Brackets on a
// loss are its sign, and one added or taken off in a sum keeps its sign (#978).
function bracketsOnly(
  stated: Figure,
  figure: Pick<CalculatedFigure, "value" | "inputs" | "formula">,
  costs: ReadonlySet<string>,
): boolean {
  const negatives = figure.inputs.filter((input) => input.number.value < 0);
  return (
    typeof figure.value === "number" &&
    figure.value < 0 &&
    stated.value > 0 &&
    !/[-−(（]/.test(stated.chars) &&
    negatives.length > 0 &&
    negatives.every((input) => BRACKETED.test(input.number.chars) && costs.has(input.name)) &&
    onlyScales(
      figure.formula,
      figure.inputs.map((input) => input.name),
    )
  );
}

/**
 * Whether the sentence's number agrees with the figure worked out for it, to
 * the sentence's rounding: a range agrees when the figure is in it, and a
 * limit (`relation`) when the figure stays within it. Null when they measure
 * different things, or the figure is a yes or no.
 */
export function agreesWith(
  stated: Figure,
  figure: Pick<CalculatedFigure, "value" | "unit" | "inputs" | "formula">,
  { relation, costs = new Set() }: { relation?: LimitRelation; costs?: ReadonlySet<string> } = {},
): boolean | null {
  if (typeof figure.value === "boolean" || !comparable(stated.unit, figure.unit)) return null;
  const value = bracketsOnly(stated, figure, costs) ? -figure.value : figure.value;
  // A figure of the other sign isn't inside a limit the sentence writes as positive: a loss-making
  // EBITDA gives a negative leverage. The model's verdict stands instead.
  if (relation === "at most" && value < 0 && stated.value > 0 && !/[-−(（]/.test(stated.chars))
    return null;
  // A limit is exact: "at least 5x" isn't met by 4.6x, though 4.6 rounds to 5.
  const within = relation ? 1e-9 * Math.max(1, Math.abs(stated.value)) : tolerance(stated);
  const low = Math.min(stated.value, stated.rangeTo ?? stated.value) - within;
  const high = Math.max(stated.value, stated.rangeTo ?? stated.value) + within;
  if (relation === "at most") return value <= high;
  if (relation === "at least") return value >= low;
  return value >= low && value <= high;
}
