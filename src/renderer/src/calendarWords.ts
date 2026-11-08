import type {
  CalendarAccount,
  CalendarAttendee,
  CalendarEvent,
  CalendarProblem,
  CalendarService,
  NoteEvent,
} from "../../core/api";
import type { Language } from "../../core/language";
import {
  type DateOptions,
  daysAfter,
  formatDateTime,
  formatDay,
  formatTime,
} from "../../shared/dates";
import type { MessageKey, MessageParams } from "../../shared/i18n";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** A 12-hour clock or not, and what counts as today: the system's and the clock's unless a test says. */
type Clock = Pick<DateOptions, "twelveHour" | "now">;

/** Home's Coming up shows this many Meetings at most, as the prototype does. */
export const COMING_UP_SHOWN = 4;

/** How long a Meeting that has begun still says it is starting. */
const STARTING_MS = 5 * 60_000;

export const SERVICE_NAMES: Readonly<Record<CalendarService, MessageKey>> = {
  google: "calendars.service.google",
  microsoft: "calendars.service.microsoft",
  mac: "calendars.service.mac",
};

export const CONNECT_LABELS: Readonly<Record<CalendarService, MessageKey>> = {
  google: "calendars.connect.google",
  microsoft: "calendars.connect.microsoft",
  mac: "calendars.connect.mac",
};

/** What a service's sign-in sends, said before the User chooses it (ADR-0022); none for the Mac's own. */
export const SENDS_LINES: Readonly<Partial<Record<CalendarService, MessageKey>>> = {
  google: "calendars.sends.google",
  microsoft: "calendars.sends.microsoft",
};

/** From now to the end of tomorrow, in the computer's time zone: what Coming up reads. */
export function comingUpSpan(now: Date): { from: string; to: string } {
  const dayAfterTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  return { from: now.toISOString(), to: dayAfterTomorrow.toISOString() };
}

/** The Meetings Coming up shows now: today's and tomorrow's that haven't ended, the first first. */
export function comingUpRows(events: readonly CalendarEvent[], now: Date): CalendarEvent[] {
  return events
    .filter(
      (event) => Date.parse(event.endsAt) > now.getTime() && daysAfter(event.startsAt, now) <= 1,
    )
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, COMING_UP_SHOWN);
}

/** "09:30" today, "Tomorrow 09:30" tomorrow. */
export function rowTime(
  event: CalendarEvent,
  now: Date,
  language: Language,
  t: Translate,
  clock: Clock = {},
): string {
  const time = formatTime(event.startsAt, language, { ...clock, now });
  return daysAfter(event.startsAt, now) >= 1 ? t("comingUp.tomorrowAt", { time }) : time;
}

const HAN = /\p{Script=Han}/u;

/** "Dana Kim" is DK and 张伟 is 伟, as the prototype draws them. */
export function initialsOf(name: string): string {
  const shown = name.includes("@") ? (name.split("@")[0] ?? name) : name;
  if (HAN.test(shown)) return [...shown.trim()].at(-1) ?? "";
  return shown
    .split(/[\s._-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0] ?? "")
    .join("")
    .toLocaleUpperCase();
}

/** Dana for Dana Kim; a Chinese name whole; an address by its name part. */
export function shortName(name: string): string {
  const shown = name.includes("@") ? (name.split("@")[0] ?? name) : name;
  if (HAN.test(shown)) return shown.trim();
  return shown.trim().split(/\s+/u)[0] ?? shown;
}

/** The people on the invite other than the User. */
export const othersOn = (attendees: readonly CalendarAttendee[]): CalendarAttendee[] =>
  attendees.filter((attendee) => !attendee.self);

/** "with Dana", "with Dana and Sam", "with Dana, Sam and 2 others"; "" with no one else. */
export function withLine(attendees: readonly CalendarAttendee[], t: Translate): string {
  const names = othersOn(attendees).map((attendee) => shortName(attendee.name));
  const [a, b] = names;
  if (a === undefined) return "";
  if (b === undefined) return t("eventBar.with1", { a });
  if (names.length === 2) return t("eventBar.with2", { a, b });
  return t("eventBar.withN", { a, b, n: names.length - 2, m: names.length });
}

function dayWord(at: string, now: Date, language: Language, t: Translate): string {
  const days = daysAfter(at, now);
  if (days === 0) return t("eventBar.today");
  if (days === 1) return t("eventBar.tomorrow");
  if (days === -1) return t("eventBar.yesterday");
  return formatDay(at, language, { now });
}

/** "Today, 09:30–09:45 · with Dana, Sam and 2 others". */
export function whenLine(
  event: Pick<NoteEvent, "startsAt" | "endsAt" | "attendees">,
  now: Date,
  language: Language,
  t: Translate,
  clock: Clock = {},
): string {
  const when = t("eventBar.when", {
    day: dayWord(event.startsAt, now, language, t),
    start: formatTime(event.startsAt, language, { ...clock, now }),
    end: formatTime(event.endsAt, language, { ...clock, now }),
  });
  const people = withLine(event.attendees, t);
  return people ? `${when} · ${people}` : when;
}

/** "Starts in 12 min" within the hour, "Starting now" for its first minutes, else null. */
export function startsIn(
  event: Pick<NoteEvent, "startsAt" | "endsAt">,
  now: Date,
  t: Translate,
): string | null {
  const start = Date.parse(event.startsAt);
  const minutes = Math.ceil((start - now.getTime()) / 60_000);
  if (minutes > 0 && minutes < 60) return t("eventBar.startsIn", { n: minutes });
  if (
    minutes <= 0 &&
    now.getTime() - start < STARTING_MS &&
    now.getTime() < Date.parse(event.endsAt)
  )
    return t("eventBar.startsNow");
  return null;
}

/** "Your account · 3 of 5 calendars count"; for the Mac's calendar, the count alone. */
export function accountDetail(account: CalendarAccount, t: Translate): string {
  const total = account.calendars.length;
  if (total === 0) return t("calendars.none");
  const counted = account.calendars.filter((calendar) => calendar.counted).length;
  if (account.name === null) {
    return t(total === 1 ? "calendars.counted.mac.one" : "calendars.counted.mac", {
      counted,
      total,
    });
  }
  return t(total === 1 ? "calendars.counted.one" : "calendars.counted", {
    account: account.name,
    counted,
    total,
  });
}

/** What a problem's one action does. */
export type ProblemFix = "sync" | "sign-in" | "allow" | "system-settings" | null;

/** A calendar's problem in the words of its row, and its one action (DESIGN.md, Problems). */
export function problemOf(
  account: CalendarAccount,
  problem: CalendarProblem,
  language: Language,
  t: Translate,
  clock: Clock = {},
): { words: string; fix: ProblemFix } {
  const service = t(SERVICE_NAMES[account.service]);
  switch (problem) {
    case "offline":
      return {
        words: account.syncedAt
          ? t("calendars.problem.offlineSince", {
              service,
              time: formatDateTime(account.syncedAt, language, clock),
            })
          : t("calendars.problem.offline", { service }),
        fix: "sync",
      };
    case "sign-in":
      return { words: t("calendars.problem.signIn", { service }), fix: "sign-in" };
    case "local-mode":
      return { words: t("meetings.route.paused"), fix: null };
    case "not-allowed":
      return { words: t("calendars.problem.notAllowed"), fix: "allow" };
    case "denied":
      return { words: t("calendars.problem.denied"), fix: "system-settings" };
    case "failed":
      return { words: t("calendars.problem.failed", { service }), fix: "sync" };
  }
}

const sameName = (a: string, b: string) =>
  a.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase() ===
  b.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();

/**
 * The invite's people a Transcript's Speaker can be named as: not the User, who is "Me", and not
 * one a Speaker already has, each once.
 */
export function inviteNames(
  attendees: readonly CalendarAttendee[],
  taken: readonly string[],
): string[] {
  const names: string[] = [];
  for (const attendee of othersOn(attendees)) {
    const name = attendee.name.trim();
    if (name === "" || [...taken, ...names].some((each) => sameName(each, name))) continue;
    names.push(name);
  }
  return names;
}
