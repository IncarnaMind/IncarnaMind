/**
 * Whether a figure a sentence states that no Passage does agrees with the figure IncarnaMind
 * calculated from numbers the Passages state (#707, ADR-0021), to the sentence's own rounding. A
 * program decides, not the model: a wrong derived number is what an analyst fears most.
 */
import type { Figure, FigureUnit } from "../../../shared/figures";
import {
  evaluateFormula,
  type FormulaInput,
  type ResultUnit,
  sameNumber,
} from "../../../shared/formula";
import type { CalculatedFigure, LimitRelation } from "../../api";

/** Whether a sentence's number and a result measure the same kind of thing, so they can be compared. */
function comparable(
  stated: FigureUnit,
  result: ResultUnit,
  inputs: CalculatedFigure["inputs"],
): boolean {
  switch (stated.kind) {
    case "percent":
      return result.kind === "percent" || result.kind === "ratio";
    case "points":
      return result.kind === "points";
    case "times":
      return result.kind === "times" || result.kind === "ratio" || result.kind === "plain";
    case "currency":
      return (
        (result.kind === "currency" && result.code === stated.code) ||
        (result.kind === "plain" && inputs.every((input) => input.number.unit.kind === "plain"))
      );
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

/**
 * Whether the sentence's number agrees with the figure worked out for it, to
 * the sentence's rounding: a range agrees when the figure is in it, and a
 * limit (`relation`) when the figure stays within it. Null when they measure
 * different things, or the figure is a yes or no.
 */
function comparisonValue(
  stated: Figure,
  figure: Pick<CalculatedFigure, "value" | "unit" | "inputs" | "formula">,
  { relation }: { relation?: LimitRelation } = {},
): number | null {
  if (typeof figure.value !== "number" || !comparable(stated.unit, figure.unit, figure.inputs))
    return null;
  const { value } = figure;
  // A figure of the other sign isn't inside a limit the sentence writes as positive: a loss-making
  // EBITDA gives a negative leverage. The model's verdict stands instead.
  if (relation === "at most" && value < 0 && stated.value > 0 && !/[-−(（]/.test(stated.chars))
    return null;
  return value;
}

export function agreesWith(
  stated: Figure,
  figure: Pick<CalculatedFigure, "value" | "unit" | "inputs" | "formula">,
  options: { relation?: LimitRelation } = {},
): boolean | null {
  const value = comparisonValue(stated, figure, options);
  if (value === null) return null;
  const { relation } = options;
  // A limit is exact: "at least 5x" isn't met by 4.6x, though 4.6 rounds to 5.
  const within = relation ? 1e-9 * Math.max(1, Math.abs(stated.value)) : tolerance(stated);
  const low = Math.min(stated.value, stated.rangeTo ?? stated.value) - within;
  const high = Math.max(stated.value, stated.rangeTo ?? stated.value) + within;
  if (relation === "at most") return value <= high;
  if (relation === "at least") return value >= low;
  return value >= low && value <= high;
}

export function agreesAtShownPrecision(
  stated: Figure,
  figure: Pick<CalculatedFigure, "value" | "unit" | "inputs" | "formula">,
  { relation }: { relation?: LimitRelation } = {},
): boolean | null {
  // "about £130m" is rounded to its last significant figure, looser than its shown places.
  if (stated.approximate) return agreesWith(stated, figure, { relation });
  const value = comparisonValue(stated, figure, { relation });
  if (value === null || !Number.isFinite(value)) return null;
  if (relation === "at most") return value <= stated.value;
  if (relation === "at least") return value >= stated.value;
  if (stated.rangeTo !== null)
    return (
      value >= Math.min(stated.value, stated.rangeTo) &&
      value <= Math.max(stated.value, stated.rangeTo)
    );
  if (stated.precision === null) return sameNumber(value, stated.value);
  if (stated.precision === undefined || !Number.isFinite(stated.precision) || stated.precision <= 0)
    return null;
  const places = -Math.round(Math.log10(stated.precision));
  if (10 ** -places !== stated.precision) return null;
  const input = (name: string, value: number): FormulaInput => ({
    name,
    value,
    scale: 1,
    scaleWord: null,
    unit: { kind: "plain" },
    decimals: 0,
    approximate: false,
  });
  const result = evaluateFormula("ROUND(source, places) = ROUND(stated, places)", [
    input("source", value),
    input("stated", stated.value),
    input("places", places),
  ]);
  return result.ok && typeof result.value === "boolean" ? result.value : null;
}
