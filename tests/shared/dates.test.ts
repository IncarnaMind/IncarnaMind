import { describe, expect, test } from "vitest";
import {
  type DateOptions,
  formatDate,
  formatDateTime,
  formatDay,
  formatLongDay,
  formatMonth,
  formatShortDate,
  formatTime,
  formatWeekdayDate,
  formatYear,
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
