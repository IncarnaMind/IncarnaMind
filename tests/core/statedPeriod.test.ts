import { expect, test } from "vitest";
import { inCurrentPeriodWindow } from "../../src/core/answers/checks/statedPeriod";

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
