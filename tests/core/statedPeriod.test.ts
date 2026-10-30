import { expect, test } from "vitest";
import {
  inCurrentPeriodWindow,
  periodInEvidence,
} from "../../src/core/answers/checks/statedPeriod";
import type { ClaimFacetPeriod } from "../../src/core/api";

const march2023: ClaimFacetPeriod = { start: "2023-03-01", end: "2023-03-31", precision: "month" };
const september2025: ClaimFacetPeriod = {
  start: "2025-09-01",
  end: "2025-09-30",
  precision: "month",
};
const march2026: ClaimFacetPeriod = { start: "2026-03-01", end: "2026-03-31", precision: "month" };
const october2026: ClaimFacetPeriod = { start: "2026-10-01", end: "2026-10-29", precision: "day" };

test.each([
  { period: march2023, quote: "As of March 2023, the base rate was 5%." },
  { period: march2023, quote: "截至2023年3月，基准利率为5%。" },
  { period: september2025, quote: "For the period 1–30 September 2025, the base rate was 5%." },
  { period: september2025, quote: "在2025年9月1日至30日期间，基准利率为5%。" },
  { period: march2026, quote: "For the period 1–31 March 2026, the base rate was 5%." },
  { period: march2026, quote: "在2026年3月1日至31日期间，基准利率为5%。" },
  {
    period: october2026,
    quote:
      "From 1 October 2026, the base rate is 3%. This replaces the 5% rate and remains in force as of 29 October 2026.",
  },
  {
    period: october2026,
    quote:
      "自2026年10月1日起，基准利率为3%，取代此前5%的利率。截至2026年10月29日，该利率仍然有效。",
  },
])("the declared period is bound to its own checked quote: $quote", ({ period, quote }) => {
  expect(periodInEvidence(period, [quote])).toBe(true);
});

test.each([
  { period: march2023, quotes: ["The base rate is 5%."] },
  { period: march2023, quotes: ["基准利率为5%。"] },
  { period: march2023, quotes: ["As of March 2026, the base rate was 5%."] },
  { period: march2026, quotes: ["截至2023年3月，基准利率为5%。"] },
  { period: march2026, quotes: ["The base rate was 5% on 1 March 2026."] },
  { period: march2026, quotes: ["The base rate was 5% on 1. March 2026."] },
  { period: march2026, quotes: ["2026年3月1日，基准利率为5%。"] },
  {
    period: october2026,
    quotes: [
      "From 1 October 2026, the base rate is 3%.",
      "It remains in force as of 29 October 2026.",
    ],
  },
  {
    period: october2026,
    quotes: ["自2026年10月1日起，基准利率为3%。", "截至2026年10月29日，该利率仍然有效。"],
  },
])("no borrowed or more precise quote proves $period: $quotes", ({ period, quotes }) => {
  expect(periodInEvidence(period, quotes)).toBe(false);
});

const day: ClaimFacetPeriod = { start: "2024-02-29", end: "2024-02-29", precision: "day" };
const quarter: ClaimFacetPeriod = { start: "2026-01-01", end: "2026-03-31", precision: "quarter" };
const year: ClaimFacetPeriod = { start: "2025-01-01", end: "2025-12-31", precision: "year" };
const fiscal: ClaimFacetPeriod = { start: "2024-07-01", end: "2025-06-30", precision: "year" };

test.each([
  { period: day, quote: "The rate was 5% on 29 February 2024." },
  { period: day, quote: "The rate was 5% on February 29, 2024." },
  { period: day, quote: "The rate was 5% on 2024-02-29." },
  { period: day, quote: "2024年2月29日，利率为5%。" },
  { period: quarter, quote: "In Q1 2026, the rate was 5%." },
  { period: quarter, quote: "In 2026 Q1, the rate was 5%." },
  { period: quarter, quote: "2026年第一季度，利率为5%。" },
  { period: year, quote: "In 2025, the rate was 5%." },
  { period: year, quote: "2025年，利率为5%。" },
  { period: fiscal, quote: "For the fiscal year 1 July 2024 to 30 June 2025, the rate was 5%." },
  { period: fiscal, quote: "在2024年7月1日至2025年6月30日的财年，利率为5%。" },
  {
    period: { start: "2025-06-30", end: "2025-06-30", precision: "day" },
    quote: "For the fiscal year ended 30 June 2025, the rate was 5%.",
  },
  {
    period: { start: "2025-06-30", end: "2025-06-30", precision: "day" },
    quote: "截至2025年6月30日的财年，利率为5%。",
  },
])("exact declared calendar lexemes bind without a file date: $quote", ({ period, quote }) => {
  expect(periodInEvidence(period, [quote])).toBe(true);
});

test.each([
  { period: day, quote: "The rate was 5% on 28 February 2024." },
  { period: quarter, quote: "In Q2 2026, the rate was 5%." },
  { period: quarter, quote: "2026年第二季度，利率为5%。" },
  { period: year, quote: "The rate was 5% in March 2025." },
  { period: year, quote: "The rate was 5% on March 2, 2025." },
  { period: year, quote: "2025年3月，利率为5%。" },
  { period: year, quote: "2025年一季度，利率为5%。" },
  { period: year, quote: "The rate was 5% on 2025-03-02." },
  { period: year, quote: "The recorded value was 12025." },
  { period: year, quote: "The recorded value was 20250." },
  { period: year, quote: "The rate was 5% for FY 2025." },
  { period: fiscal, quote: "The rate was 5% in FY2025." },
  { period: fiscal, quote: "The rate was 5% for the fiscal year ended 30 June 2025." },
  { period: fiscal, quote: "截至2025年6月30日的财年，利率为5%。" },
  { period: { ...march2026, precision: "day" }, quote: "For March 2026, the rate was 5%." },
  { period: { ...quarter, end: "2026-03-30" }, quote: "In Q1 2026, the rate was 5%." },
])("the quote cannot invent precision, boundaries or fiscal start: $quote", ({ period, quote }) => {
  expect(periodInEvidence(period, [quote])).toBe(false);
});

test.each([
  null,
  {},
  { start: "2026-02-30", end: "2026-03-01", precision: "day" },
  { start: "2026-03-31", end: "2026-03-01", precision: "day" },
  { start: "2026-03-01", end: "2026-03-31", precision: "week" },
  { start: "2026-3-01", end: "2026-03-31", precision: "month" },
])("malformed declared metadata %j never acquires quote proof", (period) => {
  expect(periodInEvidence(period, ["For March 2026, the rate was 5%."])).toBe(false);
});

test("no own checked quote means no proof even if a neighboring row has the date", () => {
  expect(periodInEvidence(march2026, [])).toBe(false);
  expect(periodInEvidence(march2026, ["The company has 5 stores."])).toBe(false);
  expect(periodInEvidence(march2026, ["公司有5家门店。"])).toBe(false);
});

test.each([
  ["2026-01-01", "2026-12-31", "2026-10-29T12:00:00Z", true],
  ["2026-10-01", "2026-10-29", "2026-10-29T23:59:59Z", true],
  ["2025-10-01", "2025-10-29", "2026-10-29T00:00:00Z", true],
  ["2025-10-01", "2025-10-29", "2026-10-29T23:59:59Z", true],
  ["2025-10-01", "2025-10-28", "2026-10-29T00:00:00Z", false],
  ["2027-01-01", "2027-12-31", "2026-10-29T12:00:00Z", false],
  ["2024-02-01", "2024-02-29", "2025-02-28T23:59:59Z", true],
  ["2024-02-01", "2024-02-29", "2025-03-01T00:00:00Z", false],
  ["2023-02-01", "2023-02-28", "2024-02-28T23:59:59Z", true],
  ["2023-02-01", "2023-02-28", "2024-02-29T00:00:00Z", false],
  ["2023-03-01", "2023-03-31", "2026-10-29T12:00:00Z", false],
  ["2024-07-01", "2025-06-30", "2026-06-30T12:00:00Z", true],
  ["2024-07-01", "2025-06-30", "2026-07-01T00:00:00Z", false],
] as const)("period %s to %s at %s has current-time window %s", (start, end, at, expected) => {
  const checkedAt = new Date(at);
  const original = checkedAt.toISOString();
  expect(inCurrentPeriodWindow({ start, end }, checkedAt)).toBe(expected);
  expect(checkedAt.toISOString()).toBe(original);
});

test.each([
  ["2026-02-30", "2026-03-01"],
  ["2026-02-01", "2026-02-29"],
  ["2026-13-01", "2026-12-31"],
  ["2026-10-30", "2026-10-29"],
  ["2026-1-01", "2026-10-29"],
  ["2026-01-01", "2026-10-29T00:00:00Z"],
  ["", "2026-10-29"],
] as const)("an invalid period %s to %s is outside the window", (start, end) => {
  expect(inCurrentPeriodWindow({ start, end }, new Date("2026-10-29T12:00:00Z"))).toBe(false);
});

test("an invalid injected Check date cannot establish a current period", () => {
  expect(
    inCurrentPeriodWindow({ start: "2026-01-01", end: "2026-12-31" }, new Date("invalid")),
  ).toBe(false);
});
