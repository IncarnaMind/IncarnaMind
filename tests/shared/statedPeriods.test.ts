import { expect, test } from "vitest";
import { readStatedPeriods } from "../../src/shared/statedPeriods";

const march = { start: "2024-03-01", end: "2024-03-31", precision: "month" };
const april = { start: "2024-04-01", end: "2024-04-30", precision: "month" };
const marchDay = { start: "2024-03-01", end: "2024-03-01", precision: "day" };
const aprilDay = { start: "2024-04-01", end: "2024-04-01", precision: "day" };
const quarter = { start: "2024-01-01", end: "2024-03-31", precision: "quarter" };
const year = { start: "2024-01-01", end: "2024-12-31", precision: "year" };

test.each([
  { text: "As of March 2024, the rate was 5%.", expected: [march] },
  { text: "截至2024年3月，利率为5%。", expected: [march] },
  { text: "As of April 2024, the rate was 5%.", expected: [april] },
  { text: "截至2024年4月，利率为5%。", expected: [april] },
  { text: "The rate was 5% on 1 March2024.", expected: [marchDay] },
  { text: "The rate was 5% on 1 April2024.", expected: [aprilDay] },
  { text: "The rate was 5% on March 1, 2024.", expected: [marchDay] },
  { text: "2024年3月1日，利率为5%。", expected: [marchDay] },
  { text: "2024年4月1日，利率为5%。", expected: [aprilDay] },
  { text: "The rate was 5% on 2024-03-01.", expected: [marchDay] },
  { text: "The statement covers 2024-03.", expected: [march] },
  { text: "In Q1 2024, the rate was 5%.", expected: [quarter] },
  { text: "2024年第一季度，利率为5%。", expected: [quarter] },
  { text: "In 2024, the rate was 5%.", expected: [year] },
  { text: "2024年，利率为5%。", expected: [year] },
  { text: "2024", expected: [year] },
  { text: "2024–2025", expected: [{ start: "2024-01-01", end: "2025-12-31", precision: "year" }] },
  {
    text: "For the fiscal year 1 July 2024 to 30 June 2025, the rate was 5%.",
    expected: [{ start: "2024-07-01", end: "2025-06-30", precision: "day" }],
  },
  {
    text: "在2024年7月1日至2025年6月30日的财年，利率为5%。",
    expected: [{ start: "2024-07-01", end: "2025-06-30", precision: "day" }],
  },
  {
    text: "For the period 1–30 September 2025, the rate was 5%.",
    expected: [{ start: "2025-09-01", end: "2025-09-30", precision: "day" }],
  },
  {
    text: "在2025年9月1日至30日期间，利率为5%。",
    expected: [{ start: "2025-09-01", end: "2025-09-30", precision: "day" }],
  },
  {
    text: "For the fiscal year ended 30 June 2025, the rate was 5%.",
    expected: [{ start: "2025-06-30", end: "2025-06-30", precision: "day" }],
  },
  { text: "March 2024: 5%. April 2024: 4%.", expected: [march, april] },
  { text: "2024年3月为5%，2024年4月为4%。", expected: [march, april] },
  { text: "March 2024: 5%. March 2024: 5%.", expected: [march] },
  {
    text: "From March 2024 to April 2024, the rate was 5%.",
    expected: [{ start: "2024-03-01", end: "2024-04-30", precision: "month" }],
  },
  { text: "The rate is 5%.", expected: [] },
  { text: "The rate was 5% in FY2025.", expected: [] },
  { text: "The date was 2023-02-29.", expected: [] },
  { text: "2026年2月30日，利率为5%。", expected: [] },
  { text: "The rate was 5% on 31 April 2024.", expected: [] },
  { text: "The value was 12024.", expected: [] },
  { text: "The company has 2024 stores.", expected: [] },
])("extracts only explicit complete periods from $text", ({ text, expected }) => {
  expect(readStatedPeriods(text)).toEqual(expected);
});
