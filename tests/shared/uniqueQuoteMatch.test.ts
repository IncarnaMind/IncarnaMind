import { expect, test } from "vitest";
import { findQuote } from "../../src/shared/quoteMatch";

for (const [text, quote] of [
  ["same row\nsame row", "same row"],
  ["控制砝码 0.100\n控制砝码 0.100", "控制砝码 0.100"],
  ["aaaa", "aa"],
  [
    "The current period recorded net revenue, and operating costs were lower than before. Operating costs were lower than before.",
    "The current period recorded net revenue ... operating costs were lower than before",
  ],
] as const) {
  test(`uniqueness detects every place for ${quote}`, () => {
    expect(findQuote(text, quote)).not.toBeNull();
    expect(findQuote(text, quote, { unique: true })).toBeNull();
  });
}
test("unique matching preserves normalization and number boundaries", () => {
  expect(findQuote("The ofﬁce is open.", "the office is open", { unique: true })).not.toBeNull();
  expect(
    findQuote("Costs 100\nCosts 1,100", "100", { numbers: true, unique: true }),
  ).not.toBeNull();
  expect(findQuote("Costs 100\nCosts 100.00", "100", { numbers: true, unique: true })).toBeNull();
});
