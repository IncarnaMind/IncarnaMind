import type { Language } from "../../core/language";
import { formatShortDate, formatTime } from "../../shared/dates";
import type { MessageKey, MessageParams } from "../../shared/i18n";

const DAY = 24 * 60 * 60 * 1000;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** When something happened: "Today, 10:42", "Yesterday", or the date, in the interface language. */
export function dayOf(
  at: Date,
  now: Date,
  language: Language,
  say: (key: MessageKey, params?: MessageParams) => string,
): string {
  const days = Math.round((startOfDay(now).getTime() - startOfDay(at).getTime()) / DAY);
  if (days <= 0) return say("date.today", { time: formatTime(at, language) });
  if (days === 1) return say("date.yesterday");
  return formatShortDate(at, language, { now });
}

const MINUTE = 60 * 1000;

export function timeAgo(
  at: Date,
  now: Date,
  language: Language,
  say: (key: MessageKey, params?: MessageParams) => string,
): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / MINUTE);
  if (minutes < 1) return say("date.justNow");
  if (minutes < 60) return say("date.minutesAgo", { count: minutes });
  const days = Math.round((startOfDay(now).getTime() - startOfDay(at).getTime()) / DAY);
  if (days <= 0) return say("date.hoursAgo", { count: Math.round(minutes / 60) });
  if (days === 1) return say("date.yesterday.ago");
  return formatShortDate(at, language, { now });
}
