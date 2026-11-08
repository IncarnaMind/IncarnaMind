/**
 * The Mac's own calendars (#190) through IncarnaMind's calendar helper (native/calendar-helper),
 * which reads EventKit read-only and answers one line of JSON. Only `requestAccess` runs the
 * command that may show the system's prompt; every other answer is read without asking.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, shell } from "electron";
import type {
  Logger,
  SystemCalendar,
  SystemCalendarAccess,
  SystemCalendarEvent,
  SystemCalendarInfo,
  SystemCalendarPerson,
} from "../core/adapters";
import type { EngineModule } from "../core/engineModules";
import { isRecord, TranslatableError } from "../core/errors";

/** The helper reads a few days of events in well under a second; a hung one is given up on. */
const ANSWER_LIMIT_MS = 10_000;
/**
 * The system's prompt waits for the User; one left this long is taken as unanswered, as a
 * browser sign-in is after five minutes.
 */
const REQUEST_LIMIT_MS = 5 * 60_000;
/** A month of a busy calendar, notes included, fits many times over. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** The helper's exit code when the Mac's calendar access isn't allowed: nothing was read. */
const NOT_ALLOWED_EXIT = 3;

const SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars";

export interface HelperOutput {
  /** The exit code; null when the helper was stopped (it took too long) or didn't start. */
  code: number | null;
  stdout: string;
}

/** Runs the helper with `args`, giving up after `limitMs` when there is one. */
export type HelperRun = (args: readonly string[], limitMs: number | null) => Promise<HelperOutput>;

/**
 * The Mac's calendar access isn't allowed now, so the helper read nothing: the core asks
 * `access()` again and says so on the calendar's row.
 */
export class SystemCalendarNotAllowedError extends Error {
  override name = "SystemCalendarNotAllowedError";
  readonly code = "not-allowed";
  constructor() {
    super("IncarnaMind isn't allowed to read the Mac's calendars.");
  }
}

const ACCESS = new Set<string>(["allowed", "denied", "restricted", "not-asked"]);
const KINDS = new Set<string>(["local", "caldav", "exchange", "subscription", "birthday", "other"]);
const STATUSES = new Set<string>(["confirmed", "tentative", "cancelled", "none"]);
const RESPONSES = new Set<string>(["accepted", "declined", "tentative", "pending", "unknown"]);

class MalformedAnswer extends Error {
  override name = "MalformedAnswer";
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new MalformedAnswer(`${field} isn't text`);
  return value;
};
const textOrNull = (value: unknown, field: string): string | null =>
  value === null || value === undefined ? null : text(value, field);
const oneOf = <T extends string>(set: Set<string>, value: unknown, field: string): T => {
  if (typeof value !== "string" || !set.has(value)) {
    throw new MalformedAnswer(`${field} is ${JSON.stringify(value)}`);
  }
  return value as T;
};
const time = (value: unknown, field: string): string => {
  const at = text(value, field);
  if (Number.isNaN(Date.parse(at))) throw new MalformedAnswer(`${field} isn't a time`);
  return at;
};
const list = (value: unknown, field: string): unknown[] => {
  if (!Array.isArray(value)) throw new MalformedAnswer(`${field} isn't a list`);
  return value;
};
const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new MalformedAnswer(`${field} isn't an object`);
  return value;
};

export function parseAccess(answer: unknown): SystemCalendarAccess {
  return oneOf<SystemCalendarAccess>(ACCESS, record(answer, "the answer").access, "access");
}

export function parseCalendars(answer: unknown): SystemCalendarInfo[] {
  return list(record(answer, "the answer").calendars, "calendars").map((each) => {
    const calendar = record(each, "a calendar");
    return {
      id: text(calendar.id, "a calendar's id"),
      title: text(calendar.title, "a calendar's title"),
      source: text(calendar.source, "a calendar's source"),
      kind: oneOf<SystemCalendarInfo["kind"]>(KINDS, calendar.kind, "a calendar's kind"),
    };
  });
}

function parsePerson(value: unknown): SystemCalendarPerson {
  const person = record(value, "a person");
  if (typeof person.self !== "boolean")
    throw new MalformedAnswer("a person's self isn't true or false");
  return {
    name: textOrNull(person.name, "a person's name"),
    email: textOrNull(person.email, "a person's email"),
    self: person.self,
    status: oneOf<SystemCalendarPerson["status"]>(RESPONSES, person.status, "a person's status"),
  };
}

export function parseEvents(answer: unknown): SystemCalendarEvent[] {
  return list(record(answer, "the answer").events, "events").map((each) => {
    const event = record(each, "an event");
    if (typeof event.allDay !== "boolean") throw new MalformedAnswer("allDay isn't true or false");
    const occurrence = event.occurrence ?? null;
    return {
      calendarId: text(event.calendarId, "an event's calendarId"),
      id: text(event.id, "an event's id"),
      externalId: textOrNull(event.externalId, "an event's externalId"),
      occurrence: occurrence === null ? null : time(occurrence, "an event's occurrence"),
      title: text(event.title, "an event's title"),
      start: time(event.start, "an event's start"),
      end: time(event.end, "an event's end"),
      allDay: event.allDay,
      status: oneOf<SystemCalendarEvent["status"]>(STATUSES, event.status, "an event's status"),
      attendees: list(event.attendees, "an event's attendees").map(parsePerson),
      organizer: event.organizer === null ? null : parsePerson(event.organizer),
      url: textOrNull(event.url, "an event's url"),
      location: textOrNull(event.location, "an event's location"),
      notes: textOrNull(event.notes, "an event's notes"),
    };
  });
}

/** A `SystemCalendar` on the helper that `run` starts. */
export function createHelperCalendar(options: {
  run: HelperRun;
  openSettings(): Promise<void>;
  log: Logger;
}): SystemCalendar {
  const { run, log } = options;
  const ask = async <T>(
    command: string,
    args: readonly string[],
    limitMs: number | null,
    parse: (answer: unknown) => T,
  ): Promise<T> => {
    const { code, stdout } = await run([command, ...args], limitMs);
    if (code === NOT_ALLOWED_EXIT) throw new SystemCalendarNotAllowedError();
    if (code === null && command === "request") {
      log.warn("systemCalendar.requestUnanswered", { limitMs: limitMs ?? "none" });
      throw new TranslatableError({ key: "error.calendar.askUnanswered" });
    }
    let answer: unknown;
    try {
      answer = JSON.parse(stdout);
    } catch {
      answer = undefined;
    }
    if (code !== 0) {
      const said = isRecord(answer) && typeof answer.error === "string" ? answer.error : null;
      log.warn("systemCalendar.failed", { command, code: code ?? "stopped", said });
      throw new Error(
        `The Mac's calendar couldn't be read (${command}): ${said ?? (code === null ? "the helper didn't answer in time" : `exit code ${code}`)}.`,
      );
    }
    try {
      return parse(answer);
    } catch (error) {
      // What it printed may hold the User's events, so only its size is logged.
      log.warn("systemCalendar.malformed", {
        command,
        reason: error instanceof Error ? error.message : String(error),
        bytes: stdout.length,
      });
      throw new Error(
        `The Mac's calendar helper answered something IncarnaMind can't read (${command}).`,
        {
          cause: error,
        },
      );
    }
  };
  return {
    access: () => ask("access", [], ANSWER_LIMIT_MS, parseAccess),
    requestAccess: () => ask("request", [], REQUEST_LIMIT_MS, parseAccess),
    calendars: () => ask("calendars", [], ANSWER_LIMIT_MS, parseCalendars),
    events: ({ from, to, calendarIds }) =>
      calendarIds.length === 0
        ? Promise.resolve([])
        : ask(
            "events",
            ["--from", from, "--to", to, ...calendarIds.flatMap((id) => ["--calendar", id])],
            ANSWER_LIMIT_MS,
            parseEvents,
          ),
    openSettings: options.openSettings,
  };
}

/** Starts the helper at `path`: its exit code and what it printed, or why it didn't start. */
export function helperRunner(path: string): HelperRun {
  return (args, limitMs) =>
    new Promise((resolve, reject) => {
      execFile(
        path,
        [...args],
        {
          encoding: "utf8",
          maxBuffer: MAX_OUTPUT_BYTES,
          ...(limitMs !== null && { timeout: limitMs }),
        },
        (error, stdout) => {
          if (!error) {
            resolve({ code: 0, stdout });
            return;
          }
          if (typeof error.code === "number") {
            resolve({ code: error.code, stdout });
            return;
          }
          if (error.killed) {
            resolve({ code: null, stdout });
            return;
          }
          reject(error);
        },
      );
    });
}

/**
 * Where the helper is: in the packaged app's resources, where the packager builds it
 * (scripts/afterPack.mjs), else where `npm run calendar-helper` builds it for development.
 */
export function calendarHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "calendar-helper")
    : join(app.getAppPath(), "native", "calendar-helper", ".build", "calendar-helper");
}

/**
 * The packaged app's engine check of the helper (#1239): it starts and answers `access`, which
 * never shows the system's prompt or reads a calendar.
 */
export function calendarHelperCheck(log: Logger): EngineModule<SystemCalendarAccess> {
  return {
    name: "the calendar helper",
    load: () =>
      createHelperCalendar({
        run: helperRunner(calendarHelperPath()),
        openSettings: () => shell.openExternal(SETTINGS_URL),
        log,
      }).access(),
  };
}

/** The Mac's calendars, on macOS with the helper there; none elsewhere. */
export function createSystemCalendar(log: Logger): SystemCalendar | undefined {
  if (process.platform !== "darwin") return undefined;
  const path = calendarHelperPath();
  if (!existsSync(path)) {
    log.warn("systemCalendar.noHelper", { packaged: app.isPackaged });
    return undefined;
  }
  return createHelperCalendar({
    run: helperRunner(path),
    openSettings: () => shell.openExternal(SETTINGS_URL),
    log,
  });
}
