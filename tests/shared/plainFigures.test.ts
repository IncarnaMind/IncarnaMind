/**
 * What the plain calculator (#3393) confirms by digits alone: that a figure a text writes carries
 * the result, rounded as it is written.
 */
import { describe, expect, test } from "vitest";
import { locate, shownCarries, workingAddsUp, workPlain } from "../../src/shared/plainFigures";

describe("A written figure carries its result by its digits", () => {
  test.each([
    ["£16,380", 16_380.4, true],
    ["20.4%", 0.20438, true],
    ["$70 thousand", 70_000, true],
    ["4,560万元", 45_600_000, true],
    ["10.0", 9.96, true],
    ["£16,830", 16_380, false],
    ["1", 8.5, false],
    ["9", 8.5, true],
    ["20.0%", 0.204, false],
    ["10.0", 9.6, false],
    ["1.00", 0.9996, true],
    ["1,000", 999.6, true],
    ["$70,000", 70_412, true],
  ] as const)("%s for %s: %s", (written, result, carries) => {
    expect(shownCarries(written, result)).toBe(carries);
  });
});

describe("A number stands in its quote only as a whole number of it", () => {
  test("a number written as part of a longer one is not in the quote", () => {
    expect(locate(12, "Revenue: 12,345", "12")).toBeNull();
    expect(locate(12_345, "Revenue: 12,345", "12")).toMatchObject({ chars: "12,345" });
  });

  test("the number the model names chooses between two with the same digits", () => {
    expect(locate(120, "Revenue 120.5, then 120", "120")).toMatchObject({
      chars: "120",
      start: 20,
    });
  });
});

describe("A comparison's shown text says its result", () => {
  const inputs = [
    { name: "a", value: 1, quote: "A was 1 and B was 2." },
    { name: "b", value: 2, quote: "A was 1 and B was 2." },
  ];
  test("yes or no as the result is, and nothing else", () => {
    expect(workPlain({ inputs, formula: "a > b", shown: "No" })).toMatchObject({ value: false });
    expect(workPlain({ inputs, formula: "a > b", shown: "Yes" })).toEqual({
      problems: [
        'the formula gives no, and shown "Yes" doesn\'t say so: write yes or no, as the result is',
      ],
    });
  });
});

describe("A check's line of working adds up over its quotes' numbers", () => {
  const quotes = [
    "Revenue was 48,250 in 2025 and 44,100 in 2024 (in thousands of euros).",
    "The rate fell from 4.1% in 2024 to 2.9% in 2025.",
  ];
  test.each([
    ["48,250 − 44,100 = 4,150", true],
    ["2025 revenue 48,250 − 2024 revenue 44,100 = 4,150, as the sentence says", true],
    ["(48,250 − 44,100) ÷ 1000 = 4.15 million euros", true],
    ["4.1% − 2.9% = 1.2 percentage points", true],
    ["48,250 / 44,100 − 1 = 9.4%", true],
    ["48,250 − 44,100 = 4,510", false],
    ["48,520 − 44,100 = 4,420", false],
    ["48,250 − 44,100 =", false],
    ["the 2024 figure comes before the 2025 one", null],
    ["48,250 is the larger", null],
  ] as const)("%s: %s", (line, adds) => {
    expect(workingAddsUp(line, quotes)).toBe(adds);
  });
});
