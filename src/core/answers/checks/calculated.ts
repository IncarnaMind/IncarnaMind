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
  readFigures,
} from "../../../shared/figures";
import {
  evaluateFormula,
  type FormulaInput,
  type ResultUnit,
  sameNumber,
  showResult,
} from "../../../shared/formula";
import { INTEGER_WORDS, wholeNumberWords } from "../../../shared/numberWords";
import type { CalculatedFigure, LimitRelation } from "../../api";
import { documentFigureContext } from "../calculations";

function printedFigures(text: string, context: FigureContext): Figure[] {
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

export function figuresInClaim(text: string, context: FigureContext): Figure[] {
  const counts = periodCounts(text, context);
  return [
    ...printedFigures(text, context).filter(
      (figure) => !counts.some((count) => figure.start < count.end && figure.end > count.start),
    ),
    ...counts,
  ].sort((a, b) => a.start - b.start);
}

/**
 * Whether a text before a single period makes it say which one, not how many: "这一年", "那一年",
 * "每一年", "同一年", "另一年", "哪一年" and "当一年" are this, that, every, the same, another,
 * which and a year. A 当 that ends a word ("应当") is no prefix; 前 and 后 stay out because
 * "前后一年" counts a year or so (#2215).
 */
const PERIOD_DEMONSTRATIVE = /(?:[这那每同另哪]|(?<!\p{Script=Han})当)\s*$/u;

const EN_PERIOD =
  "(?:[ -]+(?:consecutive|successive))?[ -]+(years?|months?|weeks?|days?|quarters?)\\b";

const COUNT_REACH = 40;

/** The figure that ends at `at`, read as any number is from the characters before `through`, which may take in the period word after it. */
function figureEndingAt(
  text: string,
  at: number,
  through: number,
  context: FigureContext,
): { figure: Figure; start: number } | undefined {
  const from = Math.max(0, at - COUNT_REACH);
  const local = text.slice(from, through);
  const figure = readFigures(local, {
    ...context,
    dates: true,
    midLine: true,
    header: null,
  }).findLast(
    (each) => each.end === at - from || (each.start < at - from && each.end === local.length),
  );
  return figure && { figure, start: from + figure.start };
}

const asCount = (value: number | null): number =>
  value !== null && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : Number.NaN;

/**
 * A count's value as the figure reader read it: a comma or a point it can't place is taken as the
 * first way it lists, a range as its far end. NaN when it can't be a count, which no Passage
 * states, so a sentence with one is left not judged, never passed (#2943).
 */
function countValue(figure: Figure): number {
  const kinds = figure.ambiguous.map(({ kind }) => kind);
  if (kinds.some((kind) => kind !== "separator" && kind !== "range")) return Number.NaN;
  return asCount(kinds.includes("range") ? figure.rangeTo : figure.value);
}

export function periodCounts(text: string, context: FigureContext): Figure[] {
  const counts: Figure[] = [];
  const count = (
    start: number,
    end: number,
    value: number,
    unit: string,
    decimals = 0,
  ): Figure => ({
    start,
    end,
    chars: text.slice(start, end),
    value,
    scale: 1,
    scaleWord: null,
    unit: { kind: "other", word: unit },
    decimals,
    currency: null,
    approximate: false,
    rangeTo: null,
    footnote: null,
    ambiguous: [],
  });
  const spelled = new RegExp(`\\b(${INTEGER_WORDS})${EN_PERIOD}`, "gi");
  for (const match of text.matchAll(spelled)) {
    const unit = match[2]?.toLowerCase().replace(/s$/, "");
    if (!unit) continue;
    const value = asCount(wholeNumberWords(match[1] ?? ""));
    counts.push(count(match.index, match.index + match[0].length, value, unit));
  }
  for (const match of text.matchAll(new RegExp(EN_PERIOD, "gi"))) {
    const unit = match[1]?.toLowerCase().replace(/s$/, "");
    const before = text.slice(Math.max(0, match.index - COUNT_REACH), match.index);
    const digits = /\p{Nd}+$/u.exec(before);
    if (!unit || !digits) continue;
    const found = figureEndingAt(text, match.index, match.index, context);
    if (found && found.figure.unit.kind !== "plain") continue;
    // The reader leaves out a number a hyphen glues to a word ("over-60-day", "1-in-200-year"): its
    // digits alone are the count. Any other number it won't read has no value.
    const glued = !found && /[\p{L}-]$/u.test(before.slice(0, digits.index));
    let value = Number.NaN;
    if (found) value = countValue(found.figure);
    else if (glued) value = asCount(Number(digits[0]));
    const start = found?.start ?? match.index - digits[0].length;
    counts.push(count(start, match.index + match[0].length, value, unit, found?.figure.decimals));
  }
  const units: Readonly<Record<string, string>> = {
    年: "year",
    个月: "month",
    月: "month",
    周: "week",
    天: "day",
    日: "day",
    季度: "quarter",
  };
  for (const match of text.matchAll(/年|个月|月|周|天|日|季度/gu)) {
    const unitAt = match.index;
    const found = figureEndingAt(text, unitAt, unitAt + match[0].length, context);
    if (!found) continue;
    const { figure, start } = found;
    const before = text.slice(0, start);
    // "这一年", "那一年", "每一年" and "当一年" say which year, not how many: one period behind a
    // demonstrative is no count (#2215).
    if (figure.value === 1 && PERIOD_DEMONSTRATIVE.test(before)) continue;
    const consecutive = /(?:连续|接连|相继)\s*$/u.test(before);
    if (/第\s*$/u.test(before)) continue;
    if (match[0] === "年" && figure.value >= 1000 && !consecutive) continue;
    if (
      (match[0] === "月" || match[0] === "日" || match[0] === "季度") &&
      !consecutive &&
      !/个\s*$/u.test(before)
    )
      continue;
    if (/(?:公元|民国)\s*$/u.test(before)) continue;
    const unit = units[match[0]];
    if (unit) {
      const end = unitAt + match[0].length;
      counts.push(count(start, end, countValue(figure), unit, figure.decimals));
    }
  }
  return counts;
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
  if (!named) return namedCount(sentence, stated, context);
  return (
    printedFigures(sentence, context).find(
      (figure) =>
        figure.ambiguous.length === 0 &&
        figure.value === named.value &&
        (named.unit.kind === "plain" || sameUnit(figure.unit, named.unit)),
    ) ?? namedCount(sentence, stated, context)
  );
}

function namedCount(sentence: string, stated: string, context: FigureContext): Figure | null {
  const start = sentence.indexOf(stated);
  if (start < 0 || sentence.indexOf(stated, start + stated.length) >= 0) return null;
  const period = periodCounts(sentence, context).find(
    (figure) =>
      figure.start === start && figure.end >= start + stated.length && !Number.isNaN(figure.value),
  );
  if (period) return period;
  const value = wholeNumberWords(stated);
  if (value !== null) {
    return {
      start,
      end: start + stated.length,
      chars: stated,
      value,
      scale: 1,
      scaleWord: null,
      unit: { kind: "plain" },
      decimals: 0,
      currency: null,
      approximate: false,
      rangeTo: null,
      footnote: null,
      ambiguous: [],
    };
  }
  const figures = readFigures(stated, { ...context, dates: true, midLine: true, header: null });
  const figure = figures.length === 1 ? figures[0] : undefined;
  if (
    !figure ||
    figure.ambiguous.length > 0 ||
    !Number.isFinite(figure.value) ||
    !Number.isInteger(figure.value) ||
    figure.value < 0
  )
    return null;
  // A period that says which one ("在这一年里") is no quantity, and the date read would make a
  // plain 1 of it to match an unrelated unit (#2215).
  if (figure.value === 1 && PERIOD_DEMONSTRATIVE.test(sentence.slice(0, start))) return null;
  if (
    figure.start !== 0 ||
    readFigures(stated, { ...context, dates: false, midLine: true, header: null }).length !== 0
  )
    return null;
  return { ...figure, start: start + figure.start, end: start + figure.end };
}

const sameUnit = (a: FigureUnit, b: FigureUnit): boolean =>
  a.kind === b.kind &&
  (a.kind !== "currency" || (b.kind === "currency" && a.code === b.code)) &&
  (a.kind !== "other" || (b.kind === "other" && a.word === b.word));

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

const BRACKETED = /^[^\d]*[(（]/;

const NAME = /[\p{L}_][\p{L}\p{N}_.]*/gu;

/** Whether `formula` only multiplies or divides its inputs: no sum, difference or function. */
function onlyScales(formula: string, names: readonly string[]): boolean {
  const own = new Set(names.map((name) => name.toLowerCase()));
  const rest = formula.replace(NAME, (word) => (own.has(word.toLowerCase()) ? "" : word));
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
 * The figure a sentence's number is compared with, as its card shows it. When its only minus
 * comes from costs printed in brackets (`bracketsOnly`), each of them is taken at its size,
 * ABS(name), and the formula worked out again: the formula, value and shown figure are then the
 * ones compared, and each input keeps the sign and characters its quote writes (#1908). Null when
 * that can't be worked out, so the number isn't compared.
 */
export function comparedFigure(
  stated: Figure,
  figure: CalculatedFigure,
  costs: ReadonlySet<string>,
): CalculatedFigure | null {
  if (!bracketsOnly(stated, figure, costs)) return figure;
  const sized = new Set(
    figure.inputs
      .filter((input) => input.number.value < 0)
      .map((input) => input.name.toLowerCase()),
  );
  const formula = figure.formula.replace(NAME, (word) =>
    sized.has(word.toLowerCase()) ? `ABS(${word})` : word,
  );
  const result = evaluateFormula(
    formula,
    figure.inputs.map((input) => ({ name: input.name, ...input.number })),
    figure.engine,
  );
  if (!result.ok || typeof result.value !== "number") return null;
  const shown = showResult(result, figure.show);
  if (!shown.ok) return null;
  return {
    ...figure,
    formula,
    value: result.value,
    unit: result.unit,
    shown: shown.shown,
    literals: result.literals,
  };
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
