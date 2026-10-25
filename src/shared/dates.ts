import type { Language } from "../core/language";

/** An ISO 8601 string, a Date, or milliseconds since 1970. */
export type Moment = Date | string | number;

export interface DateOptions {
  /** What counts as today and as this year. The clock's when left out. */
  now?: Date;
  /** The zone to show the moment in. The computer's when left out. */
  timeZone?: string;
  /** A 12-hour clock. What the system asks for when left out. */
  twelveHour?: boolean;
}

/*
 * One style per language for every date the interface shows. English follows
 * en-GB; the year is left out when it is this year, except in Date. A moment
 * that isn't a date gives "". Exports keep the date rules of their citation style.
 *
 *   Day            12 October          10月12日
 *   Long day       Monday 12 October   10月12日 星期一
 *   Date           12 Oct 2026         2026年10月12日
 *   Date and time  12 Oct 2026, 15:20  2026年10月12日 15:20
 *   Time           15:20               15:20
 */

const LOCALES: Record<Language, string> = { en: "en-GB", "zh-CN": "zh-CN" };
const BETWEEN_DAY_AND_TIME: Record<Language, string> = { en: ", ", "zh-CN": " " };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, found);
  }
  return found;
}

/** Whether a locale writes its clock in 12 hours: "en-US" does, "en-GB" and "zh-CN" don't. */
export function usesTwelveHour(locale?: string): boolean {
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h11" || cycle === "h12";
}

const toDate = (moment: Moment): Date => (moment instanceof Date ? moment : new Date(moment));

function calendarOf(date: Date, timeZone: string | undefined): string {
  return formatterFor("en-GB", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone,
  }).format(date);
}

const yearOf = (date: Date, timeZone: string | undefined): string =>
  formatterFor("en-GB", { year: "numeric", timeZone }).format(date);

function format(
  moment: Moment,
  language: Language,
  options: DateOptions,
  shape: Intl.DateTimeFormatOptions,
  yearUnlessThisYear = false,
): string {
  const date = toDate(moment);
  if (Number.isNaN(date.getTime())) return "";
  const { timeZone } = options;
  const withYear =
    yearUnlessThisYear && yearOf(date, timeZone) !== yearOf(options.now ?? new Date(), timeZone);
  return formatterFor(LOCALES[language], {
    ...shape,
    ...(withYear ? { year: "numeric" } : {}),
    timeZone,
  }).format(date);
}

/** "12 October", "10月12日". */
export function formatDay(moment: Moment, language: Language, options: DateOptions = {}): string {
  return format(moment, language, options, { day: "numeric", month: "long" });
}

/** "12 Oct 2026", "2026年10月12日": always with the year. */
export function formatDate(moment: Moment, language: Language, options: DateOptions = {}): string {
  return format(moment, language, options, { day: "numeric", month: "short", year: "numeric" });
}

/** A date in a column: "12 Oct", "10月12日" this year, else as Date. */
export function formatShortDate(
  moment: Moment,
  language: Language,
  options: DateOptions = {},
): string {
  return format(moment, language, options, { day: "numeric", month: "short" }, true);
}

/** A day with its weekday: "Friday 9 Oct", "10月9日星期五"; with the year when it isn't this one. */
export function formatWeekdayDate(
  moment: Moment,
  language: Language,
  options: DateOptions = {},
): string {
  return format(
    moment,
    language,
    options,
    { weekday: "long", day: "numeric", month: "short" },
    true,
  );
}

/** "Monday 12 October", "10月12日 星期一": a day named in full; with the year when it isn't this one. */
export function formatLongDay(
  moment: Moment,
  language: Language,
  options: DateOptions = {},
): string {
  const date = toDate(moment);
  if (Number.isNaN(date.getTime())) return "";
  const day = format(date, language, options, { day: "numeric", month: "long" }, true);
  const weekday = format(date, language, options, { weekday: "long" });
  return language === "zh-CN" ? `${day} ${weekday}` : `${weekday} ${day}`;
}

/** "October 2026", "2026年10月": a date known to the month. */
export function formatMonth(moment: Moment, language: Language, options: DateOptions = {}): string {
  return format(moment, language, options, { month: "long", year: "numeric" });
}

/** "2026", "2026年": a date known to the year. */
export function formatYear(moment: Moment, language: Language, options: DateOptions = {}): string {
  return format(moment, language, options, { year: "numeric" });
}

/** "15:20", or "3:20 pm" ("下午3:20") when the system asks for a 12-hour clock. */
export function formatTime(moment: Moment, language: Language, options: DateOptions = {}): string {
  const twelveHour = options.twelveHour ?? usesTwelveHour();
  return format(moment, language, options, {
    hour: twelveHour ? "numeric" : "2-digit",
    minute: "2-digit",
    hourCycle: twelveHour ? "h12" : "h23",
  });
}

/** "12 Oct 2026, 15:20", "2026年10月12日 15:20", whenever it was: for a record of when something was. */
export function formatFullDateTime(
  moment: Moment,
  language: Language,
  options: DateOptions = {},
): string {
  const date = toDate(moment);
  if (Number.isNaN(date.getTime())) return "";
  return `${formatDate(date, language, options)}${BETWEEN_DAY_AND_TIME[language]}${formatTime(date, language, options)}`;
}

/** "12 Oct 2026, 15:20"; "12 Oct, 15:20" this year; the time alone today. */
export function formatDateTime(
  moment: Moment,
  language: Language,
  options: DateOptions = {},
): string {
  const date = toDate(moment);
  if (Number.isNaN(date.getTime())) return "";
  const now = options.now ?? new Date();
  const time = formatTime(date, language, options);
  if (calendarOf(date, options.timeZone) === calendarOf(now, options.timeZone)) return time;
  const day = formatShortDate(date, language, { ...options, now });
  return `${day}${BETWEEN_DAY_AND_TIME[language]}${time}`;
}

export function partOfDay(now: Date): "morning" | "afternoon" | "evening" {
  const hour = now.getHours();
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}
