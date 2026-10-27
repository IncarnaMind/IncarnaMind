import { expect, test } from "vitest";
import { agreesAtShownPrecision } from "../../src/core/answers/checks/calculated";
import { figureFooting } from "../../src/shared/figureFooting";
import type { Figure } from "../../src/shared/figures";
import { readFigures } from "../../src/shared/figures";

function reading(shown: string): Figure {
  const figure = readFigures(shown, {
    language: shown === "三分之一" ? "zh-CN" : "en",
    midLine: true,
  })[0];
  if (!figure) throw new Error(`No figure in ${shown}.`);
  return figure;
}

test.each([
  ["1.01", 1.005, true],
  ["1.00", 1.005, false],
  ["-1.01", -1.005, true],
  ["-1.00", -1.005, false],
  ["1000000000000", 1000000000001, false],
  ["£1.2m", 1_249_999, true],
  ["£1.2m", 1_250_000, false],
  ["1.2亿元", 124_999_999, true],
  ["1.2亿元", 125_000_000, false],
  ["8.1%", 0.08149, true],
  ["8.1%", 0.0815, false],
  ["about 130", 130.4, true],
  ["about 130", 131, false],
  ["三分之一", 1 / 3, true],
  ["三分之一", 0.3333, false],
] as const)(
  "%s compares with source %s at its own shown precision: %s",
  (shown, value, expected) => {
    const stated = reading(shown);
    expect(
      agreesAtShownPrecision(stated, { value, unit: stated.unit, inputs: [], formula: "" }),
    ).toBe(expected);
  },
);

test("an old reading without its precision cannot establish rounding", () => {
  const stated = reading("1.2");
  delete stated.precision;
  expect(
    agreesAtShownPrecision(stated, { value: 1.24, unit: stated.unit, inputs: [], formula: "" }),
  ).toBeNull();
});

test("a currency mismatch is not settled by equal values", () => {
  expect(
    agreesAtShownPrecision(reading("£12"), {
      value: 12,
      unit: { kind: "currency", code: "USD" },
      inputs: [],
      formula: "",
    }),
  ).toBeNull();
});

test("a covenant limit never rounds an excess down or treats negative leverage as compliance", () => {
  const stated = reading("3.25x");
  const source = (value: number) => ({ value, unit: stated.unit, inputs: [], formula: "" });
  expect(agreesAtShownPrecision(stated, source(3.25), { relation: "at most" })).toBe(true);
  expect(agreesAtShownPrecision(stated, source(3.250001), { relation: "at most" })).toBe(false);
  expect(agreesAtShownPrecision(stated, source(-1), { relation: "at most" })).toBeNull();
});

test("source agreement and footing use the same decimal rounding at a half place", () => {
  expect(
    figureFooting([
      { id: "detail", label: "Revenue", figure: reading("1.005") },
      { id: "total", label: "Total", figure: reading("1.01") },
    ])[0]?.agrees,
  ).toBe(true);
});
