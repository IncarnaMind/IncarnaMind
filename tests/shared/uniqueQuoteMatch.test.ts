import { expect, test, vi } from "vitest";
import { findQuote, type TextRange } from "../../src/shared/quoteMatch";

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

const FIRST = "The review is ready";
const LAST = "final draft is approved.";
const ELLIPSIS = `${FIRST} … ${LAST}`;

test("filtered uniqueness tries a later last part with the same first part", () => {
  const text = `${FIRST} and the ${LAST} Then the ${LAST}`;
  const start = text.lastIndexOf(LAST);
  const acceptMatch = (ranges: readonly TextRange[]) => ranges.at(-1)?.start === start;
  expect(findQuote(text, ELLIPSIS, { unique: true, acceptMatch })).toEqual([
    { start: 0, end: FIRST.length },
    { start, end: text.length },
  ]);
});

test("filtered uniqueness skips rejected earlier starts", () => {
  const line = `${FIRST} and the ${LAST}`;
  const text = `${line}\n${line}`;
  const start = line.length + 1;
  const acceptMatch = (ranges: readonly TextRange[]) => ranges[0]?.start === start;
  expect(findQuote(text, ELLIPSIS, { unique: true, acceptMatch })).toEqual([
    { start, end: start + FIRST.length },
    { start: text.lastIndexOf(LAST), end: text.length },
  ]);
});

test("filtered uniqueness stops at two accepted paths sharing their first part", () => {
  const text = `${FIRST} and the ${LAST} ${LAST} ${LAST}`;
  const acceptMatch = vi.fn(() => true);
  expect(findQuote(text, ELLIPSIS, { unique: true, acceptMatch })).toBeNull();
  expect(acceptMatch).toHaveBeenCalledTimes(2);
});

test("filtered uniqueness returns no match when every complete path is rejected", () => {
  const text = `${FIRST} and the ${LAST} ${LAST}`;
  const acceptMatch = vi.fn(() => false);
  expect(findQuote(text, ELLIPSIS, { unique: true, acceptMatch })).toBeNull();
  expect(acceptMatch).toHaveBeenCalledTimes(2);
});

test("filtered matching without uniqueness stops at the first accepted path", () => {
  const text = `${FIRST} and the ${LAST} ${LAST}`;
  const acceptMatch = vi.fn(() => true);
  expect(findQuote(text, ELLIPSIS, { acceptMatch })).toEqual([
    { start: 0, end: FIRST.length },
    { start: text.indexOf(LAST), end: text.indexOf(LAST) + LAST.length },
  ]);
  expect(acceptMatch).toHaveBeenCalledTimes(1);
});

test("filtered matches retain original UTF-16 ranges after normalization", () => {
  const text = "📝 The ofﬁce\nis open.";
  const acceptMatch = vi.fn(() => true);
  const ranges = [{ start: 3, end: text.length }];
  expect(findQuote(text, "the office is open.", { unique: true, acceptMatch })).toEqual(ranges);
  expect(acceptMatch).toHaveBeenCalledTimes(1);
  expect(acceptMatch).toHaveBeenCalledWith(ranges);
});

test("filtered matching keeps literal ellipsis precedence and part length thresholds", () => {
  const before = `${FIRST} and the ${LAST}\n`;
  const literal = `${FIRST} ... ${LAST}`;
  const ranges = [{ start: before.length, end: before.length + literal.length }];
  expect(findQuote(before + literal, ELLIPSIS, { unique: true })).toEqual(ranges);
  expect(findQuote(before + literal, ELLIPSIS, { unique: true, acceptMatch: () => true })).toEqual(
    ranges,
  );
  const acceptMatch = vi.fn(() => true);
  expect(findQuote("tiny words and an ending", "tiny … ending", { acceptMatch })).toBeNull();
  expect(acceptMatch).not.toHaveBeenCalled();
});

test("filtered matching retains number boundaries, formatting and lost-ligature readings", () => {
  const text = "14812 £4,812.00";
  const acceptMatch = () => true;
  expect(findQuote(text, "4812", { numbers: true, unique: true, acceptMatch })).toEqual([
    { start: 6, end: text.length },
  ]);
  const lost = "The fnancial report.";
  expect(
    findQuote(lost, "The financial report.", { lostLigatures: true, unique: true, acceptMatch }),
  ).toEqual([{ start: 0, end: lost.length }]);
});
