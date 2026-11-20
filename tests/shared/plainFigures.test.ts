/**
 * What the plain calculator (#3393) confirms by digits alone: that a figure a text writes carries
 * the result, rounded as it is written.
 */
import { describe, expect, test } from "vitest";
import { shownCarries } from "../../src/shared/plainFigures";

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
  ] as const)("%s for %s: %s", (written, result, carries) => {
    expect(shownCarries(written, result)).toBe(carries);
  });
});
