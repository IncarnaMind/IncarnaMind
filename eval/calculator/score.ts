/**
 * How a case of the calculator set (./cases.ts) is scored on each path, from what a run kept. A
 * value is right within half a percent of the expected one, by size (a change's direction is in
 * its words); an amount in a currency's minor unit ("6,656,000 pence") is that amount. A unit is
 * read from the words the User sees right around the figure, with the app's figure reader, the
 * same way for every arm, as one of three: the expected one (money in the expected currency
 * carrying none of the inputs' quantity words, a percent, percentage points, or for a count a
 * bare number or one of the case's words); bare (a number with no unit where one is expected);
 * or another.
 */
import type { Language } from "../../src/core/language";
import { type FigureUnit, readFigures } from "../../src/shared/figures";
import type { CalculatorCase, ExpectedUnit } from "./cases";

export const TOLERANCE = 0.005;

/**
 * Within half a percent, or within half the last place a figure is shown to when that place keeps
 * two significant figures: "0.20" for 20.1%.
 */
export const matches = (value: number, expected: number, precision?: number | null): boolean => {
  const size = Math.abs(expected);
  const shown = precision && precision <= 0.05 * size ? precision / 2 + 1e-12 * size : 0;
  return Math.abs(Math.abs(value) - size) <= Math.max(TOLERANCE * size, shown);
};

export interface Read {
  chars: string;
  start: number;
  end: number;
  value: number;
  unit: FigureUnit;
  precision: number | null;
}

export function readingsOf(text: string, language: Language): Read[] {
  return readFigures(text, { language }).map((each) => ({
    chars: each.chars,
    start: each.start,
    end: each.end,
    value: each.value,
    unit: each.unit,
    precision: each.precision ?? null,
  }));
}

/** A figure's own characters and the one word right after it: "66,560 litres", not "(3,750 sacks". */
const withWordAfter = (text: string, read: Pick<Read, "start" | "end">): string =>
  text.slice(read.start, read.end) +
  (/^[\s\u00a0]*[\p{L}%]+/u.exec(text.slice(read.end))?.[0] ?? "");

export type UnitShown = "right" | "bare" | "other";

/** What `unit`, read from `around` (the figure as shown and what follows it), is against the case's. */
export function unitShown(
  unit: FigureUnit,
  around: string,
  expected: ExpectedUnit,
  quantityWords: readonly string[] = [],
): UnitShown {
  const lower = around.toLowerCase();
  const carriesQuantity = quantityWords.some((word) => lower.includes(word.toLowerCase()));
  switch (expected.kind) {
    case "currency":
      if (unit.kind === "currency" && unit.code === expected.code && !carriesQuantity)
        return "right";
      return unit.kind === "plain" && !carriesQuantity ? "bare" : "other";
    case "percent":
      return unit.kind === "percent" ? "right" : unit.kind === "plain" ? "bare" : "other";
    case "points":
      return unit.kind === "points" ? "right" : unit.kind === "plain" ? "bare" : "other";
    case "count":
      return unit.kind === "plain" ||
        (unit.kind === "other" &&
          expected.words.some((word) => unit.word.toLowerCase().startsWith(word.toLowerCase())))
        ? "right"
        : "other";
  }
}

const unitName = (unit: FigureUnit): string =>
  unit.kind === "currency" ? unit.code : unit.kind === "other" ? `other:${unit.word}` : unit.kind;

/** The value the wrong sentence states where it differs from the right one. */
export function wrongValueOf(each: CalculatorCase): number | null {
  const right = new Set(readingsOf(each.right, each.language).map((read) => read.chars));
  return (
    readingsOf(each.wrong.sentence, each.language).find((read) => !right.has(read.chars))?.value ??
    null
  );
}

/** A figure the User reads, and whether its value and unit are the case's. */
export interface Scored {
  chars: string | null;
  value: number | null;
  unit: string | null;
  valueRight: boolean;
  unitShown: UnitShown | null;
}

const NONE: Scored = { chars: null, value: null, unit: null, valueRight: false, unitShown: null };

// A currency's minor unit right after an amount: "6,656,000 pence" is £66,560.
const MINOR_AFTER = /^\s*(?:pence\b|p\b|cents?\b|¢|港仙|美分|便士)/i;

const RANK: Record<UnitShown, number> = { right: 0, bare: 1, other: 2 };

/** The case's figure among the numbers of `text` (within a span of it), read as the User reads it. */
export function figureIn(
  each: CalculatorCase,
  text: string,
  within?: { start: number; end: number },
): Scored {
  const reads = readingsOf(text, each.language).filter(
    (read) => !within || (read.end > within.start && read.start < within.end),
  );
  const shownOf = (read: Read) =>
    unitShown(read.unit, withWordAfter(text, read), each.expected.unit, each.quantityWords);
  // A value written more than once ("75,600,000 HK$, i.e. 7,560万港元") reads as its best.
  const [found] = reads
    .filter((read) => matches(read.value, each.expected.value, read.precision))
    .map((read) => ({ read, shown: shownOf(read) }))
    .sort((a, b) => RANK[a.shown] - RANK[b.shown]);
  if (found)
    return {
      chars: found.read.chars,
      value: found.read.value,
      unit: unitName(found.read.unit),
      valueRight: true,
      unitShown: found.shown,
    };
  const minor =
    each.expected.unit.kind === "currency"
      ? reads.find(
          (read) =>
            matches(read.value, each.expected.value * 100) &&
            MINOR_AFTER.test(text.slice(read.end)),
        )
      : undefined;
  if (!minor) return NONE;
  const words = withWordAfter(text, minor);
  return {
    chars: words,
    value: minor.value / 100,
    unit: "minor unit",
    valueRight: true,
    unitShown: (each.quantityWords ?? []).some((word) =>
      words.toLowerCase().includes(word.toLowerCase()),
    )
      ? "other"
      : "right",
  };
}

/** Whether a figure shown as worked out is this case's value in another unit, or a known wrong value. */
export function wrongWorkedOut(
  each: CalculatorCase,
  scored: Scored,
  value: unknown,
): string | null {
  if (scored.valueRight) return scored.unitShown === "other" ? `unit: ${scored.chars}` : null;
  if (typeof value !== "number") return null;
  const trap = each.traps.find((trap) => matches(value, trap.value));
  if (trap) return trap.why;
  const wrong = wrongValueOf(each);
  return wrong !== null && matches(value, wrong) ? "the wrong sentence's" : null;
}

/** A calculated figure as the User reads it in an Answer: its shown words, where they stand. */
export interface ShownFigure {
  value: number | boolean | string;
  shown: string;
  /** Where its shown words stand in the Answer's text. */
  start: number;
  end: number;
}

export interface Outcome {
  /** The figure the User reads: the calculator's where it gave one, otherwise one written. */
  figure: Scored;
  /** It came from the calculator. */
  calculated: boolean;
  /** Figures shown as worked out that are wrong: this case's value in another unit, or a known wrong value. */
  wrongWorkedOut: string[];
}

export function scoreAnswer(
  each: CalculatorCase,
  text: string,
  figures: readonly ShownFigure[],
): Outcome {
  const scored = figures.map((shown) => ({ shown, at: figureIn(each, text, shown) }));
  const calculated = scored.find(({ at }) => at.valueRight)?.at;
  return {
    figure: calculated ?? figureIn(each, text),
    calculated: calculated !== undefined,
    wrongWorkedOut: scored.flatMap(({ shown, at }) => {
      const wrong = wrongWorkedOut(each, at, shown.value);
      return wrong ? [`${wrong}: ${shown.shown}`] : [];
    }),
  };
}

/** The figures a check's `calculate` gave its model ("Recorded [=1] = £66,560 (…)."). */
export function toolResults(results: readonly string[]): string[] {
  return results.flatMap((text) =>
    [...text.matchAll(/Recorded \[=\d+\] = (.+?) \(/g)].flatMap((found) =>
      found[1] ? [found[1]] : [],
    ),
  );
}

/**
 * A check's figure: the calculator's result where it gave the case's value (its first result,
 * scored wrong, where none did), otherwise the first of `lines` (its line of working, what it
 * says) that gives the value.
 */
export function scoreCheck(
  each: CalculatorCase,
  results: readonly string[],
  lines: readonly (string | null | undefined)[],
): Outcome {
  const fromTool = results.map((shown) => ({
    shown,
    at: figureIn(each, shown),
    value: readingsOf(shown, each.language)[0]?.value,
  }));
  const right = fromTool.find(({ at }) => at.valueRight);
  const wrongs = fromTool.flatMap(({ shown, at, value }) => {
    const wrong = wrongWorkedOut(each, at, value);
    return wrong ? [`${wrong}: ${shown}`] : [];
  });
  if (right) return { figure: right.at, calculated: true, wrongWorkedOut: wrongs };
  const [first] = fromTool;
  if (first)
    return {
      figure: {
        chars: first.shown,
        value: first.value ?? null,
        unit: null,
        valueRight: false,
        unitShown: null,
      },
      calculated: true,
      wrongWorkedOut: wrongs,
    };
  for (const line of lines) {
    if (!line) continue;
    const scored = figureIn(each, line);
    if (scored.valueRight) return { figure: scored, calculated: false, wrongWorkedOut: [] };
  }
  return { figure: NONE, calculated: false, wrongWorkedOut: [] };
}
