import { expect, test } from "vitest";
import { agreesAtShownPrecision } from "../../src/core/answers/printedNumbers";
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
  ["about 130", 131, true],
  ["about 130", 136, false],
  ["三分之一", 1 / 3, true],
  ["三分之一", 0.3333, false],
] as const)(
  "%s compares with source %s at its own shown precision: %s",
  (shown, value, expected) => {
    const stated = reading(shown);
    expect(agreesAtShownPrecision(stated, { value, unit: stated.unit })).toBe(expected);
  },
);

test("an exact fraction equals a worked-out value as a formula's = compares them", () => {
  const stated = readFigures("十分之三", { language: "zh-CN" })[0];
  if (!stated) throw new Error("No figure in 十分之三.");
  expect(stated.precision).toBeNull();
  expect(
    agreesAtShownPrecision(stated, {
      value: 0.1 + 0.2,
      unit: stated.unit,
    }),
  ).toBe(true);
  expect(agreesAtShownPrecision(stated, { value: 0.31, unit: stated.unit })).toBe(false);
});

test("an old reading without its precision cannot establish rounding", () => {
  const stated = reading("1.2");
  delete stated.precision;
  expect(agreesAtShownPrecision(stated, { value: 1.24, unit: stated.unit })).toBeNull();
});

test("a currency mismatch is not settled by equal values", () => {
  expect(
    agreesAtShownPrecision(reading("£12"), {
      value: 12,
      unit: { kind: "currency", code: "USD" },
    }),
  ).toBeNull();
});

test("source agreement and footing use the same decimal rounding at a half place", () => {
  expect(
    figureFooting([
      { id: "detail", label: "Revenue", figure: reading("1.005") },
      { id: "total", label: "Total", figure: reading("1.01") },
    ])[0]?.agrees,
  ).toBe(true);
});
