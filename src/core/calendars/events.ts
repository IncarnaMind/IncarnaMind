/**
 * Calendar events as IncarnaMind keeps them (#190), from each service's own shape: only timed
 * Meetings the User hasn't declined and nobody cancelled, times in UTC, the people on them, the
 * call's address, and a key that matches the same invite in another calendar.
 */
import type { SystemCalendarEvent, SystemCalendarPerson } from "../adapters";
import type { CalendarAttendee } from "../api";
import { isRecord } from "../errors";

export interface ReadEvent {
  /** The service's id of this occurrence, unique in its calendar. */
  externalId: string;
  /** The invite's own id and occurrence: the same event in another calendar has it too. */
  key: string;
  title: string;
  /** ISO 8601, UTC. */
  startsAt: string;
  endsAt: string;
  attendees: CalendarAttendee[];
  joinUrl: string | null;
}

/** More are rarely shown, and a company-wide invite can name thousands. */
const MAX_ATTENDEES = 50;

/** Hosts whose addresses are calls, found in an invite's place or text when it names no call. */
const CALL_HOSTS = [
  /(^|\.)zoom\.us$/,
  /(^|\.)zoom\.com$/,
  /^meet\.google\.com$/,
  /^teams\.microsoft\.com$/,
  /^teams\.live\.com$/,
  /(^|\.)webex\.com$/,
  /^meeting\.tencent\.com$/,
  /^voovmeeting\.com$/,
  /^vc\.feishu\.cn$/,
  /(^|\.)larksuite\.com$/,
  /^meet\.jit\.si$/,
  /^whereby\.com$/,
  /(^|\.)gotomeeting\.com$/,
  /^app\.chime\.aws$/,
];

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** A Note is named for its event, so a title is one line, at most this many characters. */
const MAX_TITLE = 200;

/**
 * An invite's title as one line: line breaks and control characters are spaces, and format
 * characters (a bidirectional override, a zero-width space) go, but for the joiner emoji use.
 */
function titleOf(value: unknown, untitled: string): string {
  if (typeof value !== "string") return untitled;
  const line = value
    .replace(/\p{Cf}/gu, (character) => (character === "\u200d" ? character : ""))
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim();
  return line === "" ? untitled : [...line].slice(0, MAX_TITLE).join("");
}

const utc = (value: string | null): string | null => {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

/** An https address as given, or null: a calendar's link is opened in the User's browser. */
export function httpsUrl(value: unknown): string | null {
  const given = text(value);
  if (!given) return null;
  try {
    const url = new URL(given);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The first address of a call in `texts`, as an invite's place or description gives it. */
export function callIn(...texts: readonly (string | null | undefined)[]): string | null {
  for (const each of texts) {
    for (const match of each?.matchAll(/https:\/\/[^\s<>"')\]]+/g) ?? []) {
      const url = httpsUrl(match[0].replace(/[.,;:!?]+$/, ""));
      if (url && CALL_HOSTS.some((host) => host.test(new URL(url).hostname))) return url;
    }
  }
  return null;
}

function person(name: string | null, email: string | null, self: boolean): CalendarAttendee | null {
  const address = email?.toLowerCase() ?? null;
  const shown = name ?? address;
  return shown ? { name: shown, email: address, self } : null;
}

/** The people on an event, each once, the organizer among them. */
function attendeesOf(people: readonly (CalendarAttendee | null)[]): CalendarAttendee[] {
  const seen = new Set<string>();
  const kept: CalendarAttendee[] = [];
  for (const each of people) {
    if (!each) continue;
    const id = each.email ?? each.name.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(each);
    if (kept.length === MAX_ATTENDEES) break;
  }
  return kept;
}

const keyOf = (uid: string | null, occurrence: string | null, fallback: string) =>
  `${uid ?? fallback}|${utc(occurrence) ?? ""}`;

/** A timed event that ends after it starts; null for anything else. */
function timed(
  externalId: string,
  key: string,
  title: string,
  start: string | null,
  end: string | null,
  attendees: CalendarAttendee[],
  joinUrl: string | null,
): ReadEvent | null {
  const startsAt = utc(start);
  const endsAt = utc(end);
  if (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt)) return null;
  return { externalId, key, title, startsAt, endsAt, attendees, joinUrl };
}

/** Google Calendar's working location, out of office, focus time and birthdays aren't Meetings. */
const GOOGLE_MEETINGS = new Set(["default", "fromGmail"]);

/** An event of Google's events.list (singleEvents), or null when it isn't a Meeting to show. */
export function fromGoogle(item: unknown, untitled: string): ReadEvent | null {
  if (!isRecord(item)) return null;
  const id = text(item.id);
  if (!id || item.status === "cancelled") return null;
  if (typeof item.eventType === "string" && !GOOGLE_MEETINGS.has(item.eventType)) return null;
  const start = isRecord(item.start) ? text(item.start.dateTime) : null;
  const end = isRecord(item.end) ? text(item.end.dateTime) : null;
  const people = (Array.isArray(item.attendees) ? item.attendees : []).filter(
    (each): each is Record<string, unknown> => isRecord(each) && each.resource !== true,
  );
  if (people.some((each) => each.self === true && each.responseStatus === "declined")) return null;
  const organizer = isRecord(item.organizer) ? item.organizer : null;
  const attendees = attendeesOf([
    ...people.map((each) => person(text(each.displayName), text(each.email), each.self === true)),
    organizer &&
      person(text(organizer.displayName), text(organizer.email), organizer.self === true),
  ]);
  const video =
    isRecord(item.conferenceData) && Array.isArray(item.conferenceData.entryPoints)
      ? item.conferenceData.entryPoints.find(
          (point) => isRecord(point) && point.entryPointType === "video",
        )
      : undefined;
  const joinUrl =
    httpsUrl(item.hangoutLink) ??
    (isRecord(video) ? httpsUrl(video.uri) : null) ??
    callIn(text(item.location), text(item.description));
  const original = isRecord(item.originalStartTime)
    ? (text(item.originalStartTime.dateTime) ?? text(item.originalStartTime.date))
    : null;
  return timed(
    id,
    keyOf(text(item.iCalUID), original, `google:${id}`),
    titleOf(item.summary, untitled),
    start,
    end,
    attendees,
    joinUrl,
  );
}

const MICROSOFT_DECLINED = "declined";

/** Graph's times, asked for in UTC, carry no zone of their own: "2026-11-09T09:30:00.0000000". */
const graphUtc = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  const time = text(value.dateTime);
  if (!time) return null;
  return /(?:Z|[+-]\d\d:\d\d)$/.test(time) ? time : `${time}Z`;
};

/** An event of Microsoft Graph's calendarView, or null when it isn't a Meeting to show. */
export function fromMicrosoft(item: unknown, account: string, untitled: string): ReadEvent | null {
  if (!isRecord(item)) return null;
  const id = text(item.id);
  if (!id || item.isCancelled === true || item.isAllDay === true) return null;
  if (isRecord(item.responseStatus) && item.responseStatus.response === MICROSOFT_DECLINED) {
    return null;
  }
  const own = account.toLowerCase();
  const address = (value: unknown) =>
    isRecord(value) && isRecord(value.emailAddress) ? value.emailAddress : null;
  const people = (Array.isArray(item.attendees) ? item.attendees : []).filter(
    (each) => isRecord(each) && each.type !== "resource",
  );
  const organizer = address(item.organizer);
  const attendees = attendeesOf([
    organizer &&
      person(
        text(organizer.name),
        text(organizer.address),
        text(organizer.address)?.toLowerCase() === own,
      ),
    ...people.map((each) => {
      const named = address(each);
      const email = named ? text(named.address) : null;
      return named && person(text(named.name), email, email?.toLowerCase() === own);
    }),
  ]);
  const online = isRecord(item.onlineMeeting) ? httpsUrl(item.onlineMeeting.joinUrl) : null;
  const joinUrl =
    online ??
    httpsUrl(item.onlineMeetingUrl) ??
    callIn(
      isRecord(item.location) ? text(item.location.displayName) : null,
      text(item.bodyPreview),
    );
  return timed(
    id,
    keyOf(text(item.iCalUId), null, `microsoft:${id}`),
    titleOf(item.subject, untitled),
    graphUtc(item.start),
    graphUtc(item.end),
    attendees,
    joinUrl,
  );
}

const macPerson = (each: SystemCalendarPerson | null) =>
  each && person(text(each.name), text(each.email), each.self);

/** An event of the Mac's calendar, or null when it isn't a Meeting to show. */
export function fromMac(event: SystemCalendarEvent, untitled: string): ReadEvent | null {
  if (event.allDay || event.status === "cancelled") return null;
  if (event.attendees.some((each) => each.self && each.status === "declined")) return null;
  const attendees = attendeesOf([...event.attendees.map(macPerson), macPerson(event.organizer)]);
  const externalId = event.occurrence ? `${event.id}|${event.occurrence}` : event.id;
  return timed(
    externalId,
    keyOf(text(event.externalId), event.occurrence, `mac:${event.id}`),
    titleOf(event.title, untitled),
    event.start,
    event.end,
    attendees,
    httpsUrl(event.url) ?? callIn(event.location, event.notes),
  );
}

/** Mail services whose domain names no company. */
const MAIL_SERVICES = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "163.com",
  "126.com",
  "sina.com",
  "foxmail.com",
  "aliyun.com",
]);

/**
 * The companies the people on an event work for, as their addresses name them ("northwind.com"
 * is Northwind): a name the transcriber should know. Mail services name none.
 */
export function companiesOf(attendees: readonly CalendarAttendee[]): string[] {
  const companies = new Set<string>();
  for (const { email } of attendees) {
    const domain = email?.split("@")[1];
    if (!domain || MAIL_SERVICES.has(domain)) continue;
    const parts = domain.split(".");
    // "northwind.co.uk" is Northwind's: the label before the public suffix.
    const label =
      parts.length > 2 && (parts.at(-2)?.length ?? 0) <= 3 ? parts.at(-3) : parts.at(-2);
    if (label && label.length > 1) companies.add(label.charAt(0).toUpperCase() + label.slice(1));
  }
  return [...companies];
}
