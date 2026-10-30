import { describe, expect, test } from "vitest";
import type { ClaimFacetPeriod } from "../../src/core/api";
import {
  type DateOptions,
  formatClaimFacetPeriod,
  formatDate,
  formatDateTime,
  formatDay,
  formatLongDay,
  formatMonth,
  formatShortDate,
  formatTime,
  formatWeekdayDate,
  formatYear,
  readCalendarDate,
  readClaimFacetPeriod,
  usesTwelveHour,
} from "../../src/shared/dates";

/*
 * The one date style of the interface: the table of the issue, in both
 * languages, with the clock, the time zone and the hour cycle given rather
 * than read from this computer.
 */

const AT = "2026-10-12T15:20:00Z";
const NOW = new Date("2026-10-13T09:00:00Z");
const UTC: DateOptions = { timeZone: "UTC", now: NOW, twelveHour: false };

describe("stated facet periods", () => {
  test.each([
    { start: "2024-02-29", end: "2024-02-29", precision: "day" },
    { start: "2026-03-01", end: "2026-03-31", precision: "month" },
    { start: "2026-01-01", end: "2026-03-31", precision: "quarter" },
    { start: "2025-01-01", end: "2025-12-31", precision: "year" },
    { start: "2024-07-01", end: "2025-06-30", precision: "year" },
  ])("decodes exact calendar boundaries without rewriting $start / $end", (period) => {
    expect(readClaimFacetPeriod(period)).toEqual(period);
    expect(readClaimFacetPeriod(period)).not.toBe(period);
  });

  test.each(
    [
      null,
      [],
      "2026",
      {},
      { start: "2026-03-01", precision: "month" },
      { start: "2026-03-01", end: "2026-03-31" },
      { start: "2026-03-01", end: "2026-03-31", precision: "week" },
      { start: "2026-3-01", end: "2026-03-31", precision: "month" },
      { start: "2026-02-29", end: "2026-03-31", precision: "day" },
      { start: "2026-03-31", end: "2026-03-01", precision: "day" },
      { start: "2026-03-01T00:00:00Z", end: "2026-03-31", precision: "month" },
      { start: 2026, end: "2026-03-31", precision: "month" },
      { start: "2026-03-01", end: "2026-13-01", precision: "month" },
      { start: "2026-03-01", end: "2026-03-31", precision: "month", fileDate: "2026-03-31" },
    ].map((period) => ({ period })),
  )("rejects invalid supplied period $period", ({ period }) => {
    expect(readClaimFacetPeriod(period)).toBeNull();
  });

  test("calendar dates require an exact ISO day and reject Date normalization", () => {
    expect(readCalendarDate("2024-02-29")?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    for (const invalid of ["2025-02-29", "2026-04-31", "2026-1-01", "2026-01-01Z", null, 0])
      expect(readCalendarDate(invalid)).toBeNull();
  });

  const displays: { period: ClaimFacetPeriod; en: string; zh: string }[] = [
    {
      period: { start: "2026-03-02", end: "2026-03-02", precision: "day" },
      en: "2 Mar 2026",
      zh: "2026年3月2日",
    },
    {
      period: { start: "2026-03-01", end: "2026-03-31", precision: "month" },
      en: "March 2026",
      zh: "2026年3月",
    },
    {
      period: { start: "2026-01-01", end: "2026-03-31", precision: "quarter" },
      en: "January 2026–March 2026",
      zh: "2026年1月–2026年3月",
    },
    {
      period: { start: "2025-01-01", end: "2025-12-31", precision: "year" },
      en: "2025",
      zh: "2025年",
    },
    {
      period: { start: "2024-07-01", end: "2025-06-30", precision: "year" },
      en: "1 Jul 2024–30 Jun 2025",
      zh: "2024年7月1日–2025年6月30日",
    },
  ];
  test.each(displays)(
    "renders $period in both languages without a host-zone date shift",
    ({ period, en, zh }) => {
      const options = { ...UTC, timeZone: "America/Los_Angeles" };
      expect(formatClaimFacetPeriod(period, "en", options)).toBe(en);
      expect(formatClaimFacetPeriod(period, "zh-CN", options)).toBe(zh);
      expect(formatClaimFacetPeriod(period, "en")).toBe(en);
    },
  );

  test("invalid period output is empty rather than an invented display", () => {
    const invalid: ClaimFacetPeriod = { start: "2026-02-30", end: "2026-03-01", precision: "day" };
    expect(formatClaimFacetPeriod(invalid, "en", UTC)).toBe("");
    expect(formatClaimFacetPeriod(invalid, "zh-CN", UTC)).toBe("");
  });
});

describe("the table", () => {
  test("Day, Date, Date and time and Time in English", () => {
    expect(formatDay(AT, "en", UTC)).toBe("12 October");
    expect(formatDate(AT, "en", UTC)).toBe("12 Oct 2026");
    expect(formatDateTime("2025-10-12T15:20:00Z", "en", UTC)).toBe("12 Oct 2025, 15:20");
    expect(formatDateTime(AT, "en", UTC)).toBe("12 Oct, 15:20");
    expect(formatTime(AT, "en", UTC)).toBe("15:20");
  });

  test("and in Chinese", () => {
    expect(formatDay(AT, "zh-CN", UTC)).toBe("10月12日");
    expect(formatDate(AT, "zh-CN", UTC)).toBe("2026年10月12日");
    expect(formatDateTime("2025-10-12T15:20:00Z", "zh-CN", UTC)).toBe("2025年10月12日 15:20");
    expect(formatDateTime(AT, "zh-CN", UTC)).toBe("10月12日 15:20");
    expect(formatTime(AT, "zh-CN", UTC)).toBe("15:20");
  });

  test("a time today shows the time alone", () => {
    expect(formatDateTime("2026-10-13T03:20:00Z", "en", UTC)).toBe("03:20");
    expect(formatDateTime("2026-10-13T03:20:00Z", "zh-CN", UTC)).toBe("03:20");
  });

  test("a date in a column leaves out this year, and Date never does", () => {
    expect(formatShortDate(AT, "en", UTC)).toBe("12 Oct");
    expect(formatShortDate("2025-03-04T10:00:00Z", "en", UTC)).toBe("4 Mar 2025");
    expect(formatShortDate(AT, "zh-CN", UTC)).toBe("10月12日");
    expect(formatShortDate("2025-03-04T10:00:00Z", "zh-CN", UTC)).toBe("2025年3月4日");
    expect(formatDate("2026-01-02T10:00:00Z", "en", UTC)).toBe("2 Jan 2026");
  });

  test("a day with its weekday, and the year when it isn't this one", () => {
    expect(formatWeekdayDate("2026-10-09T10:42:00Z", "en", UTC)).toBe("Friday 9 Oct");
    expect(formatWeekdayDate("2026-10-09T10:42:00Z", "zh-CN", UTC)).toBe("10月9日星期五");
    expect(formatWeekdayDate("2025-12-31T09:05:00Z", "en", UTC)).toBe("Wednesday, 31 Dec 2025");
  });

  test("Long day: the weekday and the day in full, as Home's header shows today", () => {
    expect(formatLongDay("2026-10-19T09:30:00Z", "en", UTC)).toBe("Monday 19 October");
    expect(formatLongDay("2026-10-19T09:30:00Z", "zh-CN", UTC)).toBe("10月19日 星期一");
    expect(formatLongDay("2025-12-31T09:05:00Z", "en", UTC)).toBe("Wednesday 31 December 2025");
    expect(formatLongDay("2025-12-31T09:05:00Z", "zh-CN", UTC)).toBe("2025年12月31日 星期三");
    expect(formatLongDay("not a date", "en", UTC)).toBe("");
  });

  test("a date known to the month or to the year", () => {
    expect(formatMonth("2019-03-01T00:00:00Z", "en", UTC)).toBe("March 2019");
    expect(formatMonth("2019-03-01T00:00:00Z", "zh-CN", UTC)).toBe("2019年3月");
    expect(formatYear("2019-01-01T00:00:00Z", "en", UTC)).toBe("2019");
    expect(formatYear("2019-01-01T00:00:00Z", "zh-CN", UTC)).toBe("2019年");
  });

  test("English keeps en-GB's own abbreviation of September", () => {
    expect(formatDate("2026-09-03T10:00:00Z", "en", UTC)).toBe("3 Sept 2026");
    expect(formatDate("2026-09-03T10:00:00Z", "zh-CN", UTC)).toBe("2026年9月3日");
  });

  test("takes a Date, an ISO string or milliseconds, and gives nothing for a moment that isn't one", () => {
    const expected = "12 Oct 2026";
    expect(formatDate(new Date(AT), "en", UTC)).toBe(expected);
    expect(formatDate(Date.parse(AT), "en", UTC)).toBe(expected);
    for (const format of [
      formatDay,
      formatDate,
      formatShortDate,
      formatWeekdayDate,
      formatMonth,
      formatYear,
      formatTime,
      formatDateTime,
    ]) {
      expect(format("not a date", "en", UTC)).toBe("");
      expect(format(Number.NaN, "zh-CN", UTC)).toBe("");
    }
  });
});

describe("the clock", () => {
  test("is 24 hours, with midnight as 00:00, and 12 hours when the system asks", () => {
    const midnight = "2026-01-01T00:00:00Z";
    const morning = "2026-01-01T09:05:00Z";
    const noon = "2026-01-01T12:05:00Z";
    expect(formatTime(midnight, "en", UTC)).toBe("00:00");
    expect(formatTime(morning, "en", UTC)).toBe("09:05");
    const twelve = { ...UTC, twelveHour: true };
    expect(formatTime(midnight, "en", twelve)).toBe("12:00 am");
    expect(formatTime(morning, "en", twelve)).toBe("9:05 am");
    expect(formatTime(noon, "en", twelve)).toBe("12:05 pm");
    expect(formatTime(AT, "en", twelve)).toBe("3:20 pm");
    expect(formatTime(AT, "zh-CN", twelve)).toBe("下午3:20");
    expect(formatDateTime(AT, "en", twelve)).toBe("12 Oct, 3:20 pm");
    expect(formatDateTime(AT, "zh-CN", twelve)).toBe("10月12日 下午3:20");
  });

  test("follows the system's locale when it isn't given", () => {
    expect(usesTwelveHour("en-US")).toBe(true);
    expect(usesTwelveHour("en-GB")).toBe(false);
    expect(usesTwelveHour("zh-CN")).toBe(false);
    expect(usesTwelveHour("en-GB-u-hc-h12")).toBe(true);
    expect(usesTwelveHour("en-US-u-hc-h23")).toBe(false);
    const { twelveHour: _, ...system } = UTC;
    const wanted = usesTwelveHour();
    expect(formatTime(AT, "en", system)).toBe(formatTime(AT, "en", { ...UTC, twelveHour: wanted }));
  });
});

describe("midnight and New Year", () => {
  test("a moment a minute into today is today, and one a minute before it is yesterday", () => {
    const now = new Date("2026-10-12T12:00:00Z");
    const options = { ...UTC, now };
    expect(formatDateTime("2026-10-12T00:01:00Z", "en", options)).toBe("00:01");
    expect(formatDateTime("2026-10-11T23:59:00Z", "en", options)).toBe("11 Oct, 23:59");
  });

  test("a moment before New Year shows its year, and the same moment in a zone already past it doesn't", () => {
    const now = new Date("2026-01-01T00:05:00Z");
    const before = "2025-12-31T23:50:00Z";
    expect(formatDateTime(before, "en", { ...UTC, now })).toBe("31 Dec 2025, 23:50");
    expect(formatDateTime(before, "zh-CN", { ...UTC, now })).toBe("2025年12月31日 23:50");
    const shanghai = { ...UTC, now, timeZone: "Asia/Shanghai" };
    expect(formatDateTime(before, "en", shanghai)).toBe("07:50");
    expect(formatShortDate(before, "en", shanghai)).toBe("1 Jan");
    expect(formatShortDate(before, "en", { ...UTC, now })).toBe("31 Dec 2025");
  });

  test("the zone decides the day", () => {
    expect(formatDay(AT, "en", { ...UTC, timeZone: "Asia/Shanghai" })).toBe("12 October");
    expect(formatDay("2026-10-12T20:00:00Z", "en", { ...UTC, timeZone: "Asia/Shanghai" })).toBe(
      "13 October",
    );
    expect(
      formatDay("2026-10-12T03:00:00Z", "en", { ...UTC, timeZone: "America/Los_Angeles" }),
    ).toBe("11 October");
  });
});
