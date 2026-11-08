/**
 * Calendars (#190): the User's Google Calendar, Microsoft 365 and the Mac's own Calendar, read
 * so Meetings coming up can be shown and a Note started for one. Events are kept only on this
 * computer, for yesterday to the day after tomorrow, and read again every few minutes while the
 * app runs and when the computer wakes, backing off while a service can't be reached.
 *
 * Google and Microsoft are read with the User's sign-in (tokens only in the secret store) and
 * only while the calendars flow to them is allowed: connecting allows it (ADR-0022), Local mode
 * stops it, and background work never asks. The Mac's calendar is read on this computer, and the
 * system is asked for access only when the User connects it.
 */
import { randomUUID } from "node:crypto";
import { translate } from "../../shared/i18n";
import type {
  Browser,
  CalendarServiceConfig,
  Logger,
  SystemCalendar,
  SystemCalendarEvent,
} from "../adapters";
import type {
  CalendarAccount,
  CalendarAttendee,
  CalendarEvent,
  CalendarProblem,
  CalendarService,
  CalendarsState,
  ExternalService,
  ListCalendarEventsInput,
  NoteEvent,
} from "../api";
import type { Consent } from "../consent";
import {
  ConsentDeclinedError,
  ConsentNeededError,
  ConsentRevokedError,
  InvalidInputError,
  isRecord,
  LocalModeError,
  NotFoundError,
  TranslatableError,
} from "../errors";
import type { Language } from "../language";
import { OAuthFlowError, OAuthTokenError, refreshOAuthTokens } from "../oauth";
import {
  createOAuthAccount,
  isSignInUnreadable,
  type OAuthAccountRecord,
  parseAccountRecord,
  revokeRefreshToken,
} from "../oauthAccount";
import type { Secrets } from "../secrets";
import { createSendGate } from "../sendGate";
import type { Database } from "../storage";
import { GOOGLE_CALENDAR_SCOPE, MICROSOFT_CALENDAR_SCOPE } from "./endpoints";
import { fromMac, type ReadEvent } from "./events";
import {
  type CalendarClient,
  CalendarRequestError,
  googleCalendar,
  microsoftCalendar,
  type RemoteCalendar,
} from "./remote";

type RemoteService = Exclude<CalendarService, "mac">;

/** The names the services go by in Settings › Privacy and in what the core says. */
const SERVICE_NAMES: Record<CalendarService, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft 365",
  mac: "Calendar",
};

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = [60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 16 * 60_000, 30 * 60_000];

/** Its sign-in ended: the User signs in again. */
class CalendarSignInError extends Error {
  override name = "CalendarSignInError";
}

/** The Mac's calendar access is refused, or held back by its administrator. */
class CalendarAccessError extends Error {
  override name = "CalendarAccessError";
}

interface AccountRow {
  id: string;
  service: CalendarService;
  name: string | null;
  synced_at: string | null;
  problem: string | null;
}

interface CalendarRow {
  id: string;
  account_id: string;
  external_id: string;
  name: string;
  source: string | null;
  counted: number;
}

interface EventRow {
  id: string;
  calendar_id: string;
  external_id: string;
  event_key: string;
  title: string;
  starts_at: string;
  ends_at: string;
  attendees: string;
  join_url: string | null;
}

interface SourceCalendar {
  externalId: string;
  name: string;
  source: string | null;
  own: boolean;
}

const PROBLEMS: readonly CalendarProblem[] = [
  "offline",
  "sign-in",
  "local-mode",
  "not-allowed",
  "denied",
  "failed",
];
const isProblem = (value: unknown): value is CalendarProblem =>
  PROBLEMS.some((problem) => problem === value);

const isRemote = (service: CalendarService): service is RemoteService => service !== "mac";

/** The Mac's subscribed and birthday calendars aren't the User's Meetings. */
const MAC_OWN_KINDS = new Set(["local", "caldav", "exchange", "other"]);

function parseAttendees(json: string): CalendarAttendee[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.flatMap((each): CalendarAttendee[] =>
      isRecord(each) && typeof each.name === "string"
        ? [
            {
              name: each.name,
              email: typeof each.email === "string" ? each.email : null,
              self: each.self === true,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

/** The Note's copy of its event, as `calendar_event_notes.event` keeps it. */
function parseSnapshot(json: string): Omit<NoteEvent, "eventId"> | null {
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value)) return null;
    const { title, startsAt, endsAt, joinUrl } = value;
    if (typeof title !== "string" || typeof startsAt !== "string" || typeof endsAt !== "string") {
      return null;
    }
    return {
      title,
      startsAt,
      endsAt,
      attendees: parseAttendees(JSON.stringify(value.attendees ?? [])),
      joinUrl: typeof joinUrl === "string" ? joinUrl : null,
    };
  } catch {
    return null;
  }
}

const snapshotOf = (row: EventRow): string =>
  JSON.stringify({
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    attendees: parseAttendees(row.attendees),
    joinUrl: row.join_url,
  });

export interface CalendarsOptions {
  db: Database;
  /** ISO 8601, for rows. */
  now(): string;
  /** Milliseconds since the epoch, for the sync window and sign-in tokens. */
  clock(): number;
  secrets: Secrets;
  consent: Consent;
  localOnly(): boolean;
  browser: Browser;
  services: { google?: CalendarServiceConfig; microsoft?: CalendarServiceConfig };
  system: SystemCalendar | undefined;
  fetch: typeof fetch;
  intervalMs?: number;
  retryMs?: readonly number[];
  language(): Language;
  /** Makes a Note named `title` for an event, and returns its id. */
  createNote(title: string): string;
  /** Whether the Note is there, not deleted. */
  noteLive(mindId: string): boolean;
  changed(state: CalendarsState): void;
  eventsChanged(): void;
  log: Logger;
}

export type Calendars = ReturnType<typeof createCalendars>;

export function createCalendars(options: CalendarsOptions) {
  const { db, consent, secrets, system, log } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const retryMs = options.retryMs?.length ? options.retryMs : DEFAULT_RETRY_MS;
  const gate = createSendGate(consent, options.localOnly);
  const untitled = () => translate(options.language(), "calendar.noTitle");

  const externalOf = (service: RemoteService, config: CalendarServiceConfig): ExternalService => ({
    id: new URL(config.apiBaseUrl).origin,
    name: SERVICE_NAMES[service],
  });

  const offered = (): CalendarService[] => [
    ...(options.services.google ? (["google"] as const) : []),
    ...(options.services.microsoft ? (["microsoft"] as const) : []),
    ...(system ? (["mac"] as const) : []),
  ];

  const liveAccounts = () =>
    db.all<AccountRow>(
      `SELECT id, service, name, synced_at, problem FROM calendar_accounts
       ORDER BY created_at, rowid`,
    );
  const accountRow = (id: string) =>
    db.get<AccountRow>(
      "SELECT id, service, name, synced_at, problem FROM calendar_accounts WHERE id = ?",
      [id],
    );

  consent.registry.register({
    id: "calendars",
    sends: ["calendar-request"],
    background: true,
    async services() {
      const services = new Map<string, ExternalService>();
      for (const row of liveAccounts()) {
        const config = isRemote(row.service) ? options.services[row.service] : undefined;
        if (isRemote(row.service) && config) {
          const service = externalOf(row.service, config);
          services.set(service.id, service);
        }
      }
      return [...services.values()];
    },
  });

  // ---------------------------------------------------------------------------
  // Sign-ins, one per Google or Microsoft account, each in the secret store under its own name.

  const secretName = (accountId: string) => `calendar.${accountId}`;
  const signIns = new Map<string, ReturnType<typeof signInFor>>();

  function signInFor(accountId: string, service: RemoteService, config: CalendarServiceConfig) {
    const scope = service === "google" ? GOOGLE_CALENDAR_SCOPE : MICROSOFT_CALENDAR_SCOPE;
    const { revokeUrl } = config;
    return createOAuthAccount<OAuthAccountRecord>({
      secretName: secretName(accountId),
      provider: SERVICE_NAMES[service],
      secrets,
      parse: parseAccountRecord,
      browser: options.browser,
      pages: () => {
        const language = options.language();
        const values = { service: SERVICE_NAMES[service] };
        return {
          success: {
            title: translate(language, "calendar.page.success.title", values),
            body: translate(language, "calendar.page.success.body"),
          },
          failure: {
            title: translate(language, "calendar.page.failure.title", values),
            body: translate(language, "calendar.page.failure.body"),
          },
        };
      },
      now: options.clock,
      renew: (_stored, refreshToken, signal) =>
        refreshOAuthTokens({
          tokenUrl: config.tokenUrl,
          clientId: config.clientId,
          refreshToken,
          ...(service === "microsoft" && { scope }),
          ...(config.clientSecret && { params: { client_secret: config.clientSecret } }),
          signal,
          fetch: options.fetch,
        }),
      ...(revokeUrl && {
        revoke: (_stored: OAuthAccountRecord, refreshToken: string) =>
          revokeRefreshToken({
            revokeUrl,
            clientId: config.clientId,
            refreshToken,
            provider: SERVICE_NAMES[service],
            fetch: options.fetch,
          }),
      }),
      signInRequired: (reason) => new CalendarSignInError(`The ${service} sign-in ${reason}.`),
      onChange: () => undefined,
      fetch: options.fetch,
    });
  }

  const signInOf = (row: AccountRow) => {
    if (!isRemote(row.service)) return null;
    const config = options.services[row.service];
    if (!config) return null;
    let account = signIns.get(row.id);
    if (!account) {
      account = signInFor(row.id, row.service, config);
      signIns.set(row.id, account);
    }
    return account;
  };

  const clientFor = (row: AccountRow): CalendarClient | null => {
    if (!isRemote(row.service)) return null;
    const config = options.services[row.service];
    const signIn = signInOf(row);
    if (!config || !signIn) return null;
    const external = externalOf(row.service, config);
    const api = {
      config,
      credentials: signIn.credentials,
      check: () => gate.check("calendars", external),
      fetch: options.fetch,
      untitled,
    };
    return row.service === "google" ? googleCalendar(api) : microsoftCalendar(api);
  };

  let signingIn: { service: RemoteService; cancel(): Promise<void> } | null = null;

  // ---------------------------------------------------------------------------
  // State.

  const calendarsOf = (accountId: string) =>
    db.all<CalendarRow>(
      `SELECT id, account_id, external_id, name, source, counted FROM calendars
       WHERE account_id = ? ORDER BY counted DESC, name COLLATE NOCASE`,
      [accountId],
    );

  const problemOf = (row: AccountRow): CalendarProblem | null => {
    if (isRemote(row.service) && options.localOnly()) return "local-mode";
    return isProblem(row.problem) ? row.problem : null;
  };

  const consentServiceOf = (row: AccountRow): string | null => {
    const config = isRemote(row.service) ? options.services[row.service] : undefined;
    return isRemote(row.service) && config ? externalOf(row.service, config).id : null;
  };

  const toAccount = (row: AccountRow): CalendarAccount => ({
    id: row.id,
    service: row.service,
    name: row.name,
    calendars: calendarsOf(row.id).map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      counted: calendar.counted === 1,
      group: calendar.source,
    })),
    syncedAt: row.synced_at,
    problem: problemOf(row),
    consentServiceId: consentServiceOf(row),
  });

  const state = (): CalendarsState => ({
    services: offered(),
    accounts: liveAccounts().map(toAccount),
    signingIn: signingIn?.service ?? null,
  });

  const emit = () => options.changed(state());

  const setProblem = (accountId: string, problem: CalendarProblem | null, synced = false) => {
    const at = options.now();
    db.run(
      `UPDATE calendar_accounts SET problem = ?, updated_at = ?${synced ? ", synced_at = ?" : ""}
       WHERE id = ?`,
      synced ? [problem, at, at, accountId] : [problem, at, accountId],
    );
  };

  // ---------------------------------------------------------------------------
  // What is kept.

  /** Yesterday to the end of the day after tomorrow, in this computer's days. */
  const window = () => {
    const now = new Date(options.clock());
    const day = (offset: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).toISOString();
    return { from: day(-1), to: day(3) };
  };

  /**
   * Deletes the events `where` picks; how many there were. Rows go for good, not to a tombstone:
   * they are this device's copy of what the service holds, and a copy kept past its days would
   * keep people's names and addresses.
   */
  const deleteEvents = (where: string, params: readonly (string | number)[]): number => {
    const count =
      db.get<{ count: number }>(
        `SELECT count(*) AS count FROM calendar_events WHERE ${where}`,
        params,
      )?.count ?? 0;
    if (count > 0) db.run(`DELETE FROM calendar_events WHERE ${where}`, params);
    return count;
  };

  /** Keeps the account's calendars as listed; true when a counted one came or went. */
  const keepCalendars = (accountId: string, listed: readonly SourceCalendar[]): boolean => {
    const at = options.now();
    let changed = false;
    db.transaction(() => {
      const existing = new Map(calendarsOf(accountId).map((row) => [row.external_id, row]));
      for (const calendar of listed) {
        const row = existing.get(calendar.externalId);
        existing.delete(calendar.externalId);
        if (!row) {
          db.run(
            `INSERT INTO calendars
               (id, account_id, external_id, name, source, counted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              accountId,
              calendar.externalId,
              calendar.name,
              calendar.source,
              calendar.own ? 1 : 0,
              at,
              at,
            ],
          );
          if (calendar.own) changed = true;
        } else if (row.name !== calendar.name || row.source !== calendar.source) {
          db.run("UPDATE calendars SET name = ?, source = ?, updated_at = ? WHERE id = ?", [
            calendar.name,
            calendar.source,
            at,
            row.id,
          ]);
        }
      }
      for (const gone of existing.values()) {
        if (deleteEvents("calendar_id = ?", [gone.id]) > 0) changed = true;
        db.run("DELETE FROM calendars WHERE id = ?", [gone.id]);
      }
    });
    return changed;
  };

  /** Keeps a calendar's events in the window as read; true when any changed. */
  const keepEvents = (calendarId: string, read: readonly ReadEvent[]): boolean => {
    const at = options.now();
    let changed = false;
    db.transaction(() => {
      const existing = new Map(
        db
          .all<EventRow>(
            `SELECT id, calendar_id, external_id, event_key, title, starts_at, ends_at, attendees,
               join_url FROM calendar_events WHERE calendar_id = ?`,
            [calendarId],
          )
          .map((row) => [row.external_id, row]),
      );
      const touched: EventRow[] = [];
      for (const event of read) {
        const row = existing.get(event.externalId);
        existing.delete(event.externalId);
        const next = {
          event_key: event.key,
          title: event.title,
          starts_at: event.startsAt,
          ends_at: event.endsAt,
          attendees: JSON.stringify(event.attendees),
          join_url: event.joinUrl,
        };
        if (!row) {
          const id = randomUUID();
          db.run(
            `INSERT INTO calendar_events (id, calendar_id, external_id, event_key, title, starts_at,
               ends_at, attendees, join_url, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              calendarId,
              event.externalId,
              next.event_key,
              next.title,
              next.starts_at,
              next.ends_at,
              next.attendees,
              next.join_url,
              at,
              at,
            ],
          );
          changed = true;
          touched.push({ id, calendar_id: calendarId, external_id: event.externalId, ...next });
          continue;
        }
        const same =
          row.event_key === next.event_key &&
          row.title === next.title &&
          row.starts_at === next.starts_at &&
          row.ends_at === next.ends_at &&
          row.attendees === next.attendees &&
          row.join_url === next.join_url;
        if (same) continue;
        db.run(
          `UPDATE calendar_events SET event_key = ?, title = ?, starts_at = ?, ends_at = ?,
             attendees = ?, join_url = ?, updated_at = ? WHERE id = ?`,
          [
            next.event_key,
            next.title,
            next.starts_at,
            next.ends_at,
            next.attendees,
            next.join_url,
            at,
            row.id,
          ],
        );
        changed = true;
        touched.push({ ...row, ...next });
      }
      // Gone from the calendar in the window read: cancelled, deleted, declined or moved away.
      for (const gone of existing.values()) {
        db.run("DELETE FROM calendar_events WHERE id = ?", [gone.id]);
        changed = true;
      }
      // A Note made for a moved event keeps its new time, here and on another device.
      for (const row of touched) {
        db.run(
          `UPDATE calendar_event_notes SET event = ?, updated_at = ?
           WHERE event_key = ? AND deleted_at IS NULL AND event <> ?`,
          [snapshotOf(row), at, row.event_key, snapshotOf(row)],
        );
      }
    });
    return changed;
  };

  // ---------------------------------------------------------------------------
  // Reading.

  async function readRemote(row: AccountRow, client: CalendarClient) {
    const { account, calendars } = await client.calendars();
    if (account !== row.name) {
      db.run("UPDATE calendar_accounts SET name = ?, updated_at = ? WHERE id = ?", [
        account,
        options.now(),
        row.id,
      ]);
    }
    let changed = keepCalendars(
      row.id,
      calendars.map((calendar: RemoteCalendar) => ({ ...calendar, source: null })),
    );
    const { from, to } = window();
    for (const calendar of calendarsOf(row.id)) {
      if (calendar.counted !== 1) continue;
      const events = await client.events(calendar.external_id, from, to);
      if (keepEvents(calendar.id, events)) changed = true;
    }
    return changed;
  }

  async function readMac(row: AccountRow, mac: SystemCalendar) {
    const access = await mac.access();
    if (access !== "allowed") throw new CalendarAccessError(`Calendar access is ${access}.`);
    const listed = await mac.calendars();
    let changed = keepCalendars(
      row.id,
      listed.map((calendar) => ({
        externalId: calendar.id,
        name: calendar.title,
        source: calendar.source,
        own: MAC_OWN_KINDS.has(calendar.kind),
      })),
    );
    const counted = calendarsOf(row.id).filter((calendar) => calendar.counted === 1);
    if (counted.length === 0) return changed;
    const { from, to } = window();
    const events = await mac.events({
      from,
      to,
      calendarIds: counted.map((calendar) => calendar.external_id),
    });
    const byCalendar = new Map<string, SystemCalendarEvent[]>();
    for (const event of events) {
      byCalendar.set(event.calendarId, [...(byCalendar.get(event.calendarId) ?? []), event]);
    }
    for (const calendar of counted) {
      const read = (byCalendar.get(calendar.external_id) ?? [])
        .map((event) => fromMac(event, untitled()))
        .filter((event): event is ReadEvent => event !== null);
      if (keepEvents(calendar.id, read)) changed = true;
    }
    return changed;
  }

  const problemFor = (error: unknown): CalendarProblem => {
    if (error instanceof LocalModeError) return "local-mode";
    if (
      error instanceof ConsentNeededError ||
      error instanceof ConsentRevokedError ||
      error instanceof ConsentDeclinedError
    ) {
      return "not-allowed";
    }
    if (error instanceof CalendarSignInError || isSignInUnreadable(error)) return "sign-in";
    if (error instanceof CalendarAccessError) return "denied";
    if (error instanceof CalendarRequestError) {
      if (error.status === null || error.status === 429 || error.status >= 500) return "offline";
      return error.status === 401 ? "sign-in" : "failed";
    }
    if (error instanceof OAuthTokenError) {
      return error.status === null || error.status >= 500 ? "offline" : "sign-in";
    }
    // A refresh's request that never reached the service rejects as fetch does.
    if (error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError")) {
      return "offline";
    }
    return "failed";
  };

  // ---------------------------------------------------------------------------
  // When to read.

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const retries = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>();
  const running = new Map<string, Promise<void>>();

  const clearRetry = (accountId: string) => {
    const retry = retries.get(accountId);
    if (retry) clearTimeout(retry.timer);
    retries.delete(accountId);
  };

  const backOff = (accountId: string) => {
    const attempt = (retries.get(accountId)?.attempt ?? 0) + 1;
    clearRetry(accountId);
    const wait = retryMs[Math.min(attempt, retryMs.length) - 1] ?? DEFAULT_INTERVAL_MS;
    // The attempt stays counted until a read succeeds, so the next failure waits longer.
    const retry = setTimeout(() => void read(accountId), wait);
    retry.unref?.();
    retries.set(accountId, { attempt, timer: retry });
  };

  /** Reads one account now; one read at a time each. */
  const read = (accountId: string): Promise<void> => {
    const already = running.get(accountId);
    if (already) return already;
    const run = (async () => {
      const row = accountRow(accountId);
      if (!row || closed) return;
      let changed = false;
      try {
        if (isRemote(row.service)) {
          if (options.localOnly()) throw new LocalModeError();
          const client = clientFor(row);
          if (!client) return;
          changed = await readRemote(row, client);
        } else {
          if (!system) return;
          changed = await readMac(row, system);
        }
        if (!accountRow(accountId)) return;
        clearRetry(accountId);
        setProblem(accountId, null, true);
      } catch (error) {
        if (!accountRow(accountId)) return;
        const problem = problemFor(error);
        setProblem(accountId, problem);
        log.warn("calendars.readFailed", {
          service: row.service,
          problem,
          status: error instanceof CalendarRequestError ? (error.status ?? undefined) : undefined,
          error: error instanceof Error ? error.name : "unknown",
        });
        if (problem === "offline" || problem === "failed") backOff(accountId);
        else clearRetry(accountId);
      }
      // Events a day old go, whichever account read them.
      if (deleteEvents("ends_at <= ?", [window().from]) > 0) changed = true;
      emit();
      if (changed) options.eventsChanged();
    })();
    running.set(accountId, run);
    const done = () => {
      if (running.get(accountId) === run) running.delete(accountId);
    };
    run.then(done, done);
    return run;
  };

  /** Reads every account; `due` only those not waiting out a failure. */
  const readAll = async (due: boolean) => {
    await Promise.all(
      liveAccounts()
        .filter((row) => !due || !retries.has(row.id))
        .map((row) => {
          if (!due) clearRetry(row.id);
          return read(row.id);
        }),
    );
  };

  const schedule = (ms: number) => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      readAll(true)
        .catch((error: unknown) => log.error("calendars.readAllFailed", { error: String(error) }))
        .finally(() => schedule(intervalMs));
    }, ms);
    timer.unref?.();
  };

  // ---------------------------------------------------------------------------
  // Events and their Notes.

  /** The Note made for an event's key, newest first, while it is there. */
  const noteFor = (keys: readonly string[]): string | null => {
    const rows = db.all<{ mind_id: string }>(
      `SELECT mind_id FROM calendar_event_notes
       WHERE event_key IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL
       ORDER BY created_at DESC, rowid DESC`,
      [JSON.stringify(keys)],
    );
    return rows.find((row) => options.noteLive(row.mind_id))?.mind_id ?? null;
  };

  const countedEvents = (from: string, to: string) =>
    db.all<EventRow & { service: CalendarService }>(
      `SELECT e.id, e.calendar_id, e.external_id, e.event_key, e.title, e.starts_at, e.ends_at,
         e.attendees, e.join_url, a.service
       FROM calendar_events e
       JOIN calendars c ON c.id = e.calendar_id AND c.counted = 1
       JOIN calendar_accounts a ON a.id = c.account_id
       WHERE e.ends_at > ? AND e.starts_at < ?
       ORDER BY e.starts_at, e.ends_at, a.created_at, e.rowid`,
      [from, to],
    );

  /**
   * Each Meeting once: the copies of one invite in several calendars, matched by its key or by
   * its title and times, shown as the copy with a call's link and the most people, with every
   * copy's key and id, so its Note is found from any of them.
   */
  const once = <T extends EventRow>(rows: readonly T[]) => {
    const groups: { shown: T; members: T[] }[] = [];
    const twins = (a: T, b: T) =>
      a.event_key === b.event_key ||
      (a.title === b.title && a.starts_at === b.starts_at && a.ends_at === b.ends_at);
    const weight = (row: T) => (row.join_url ? 2 : 0) + parseAttendees(row.attendees).length / 1000;
    for (const row of rows) {
      const group = groups.find((each) => each.members.some((member) => twins(member, row)));
      if (!group) {
        groups.push({ shown: row, members: [row] });
        continue;
      }
      group.members.push(row);
      if (weight(row) > weight(group.shown)) group.shown = row;
    }
    return groups.map(({ shown, members }) => ({
      shown,
      keys: [...new Set(members.map((member) => member.event_key))],
      ids: members.map((member) => member.id),
    }));
  };

  /** The Meeting an event is a copy of, as Coming up shows it. */
  const groupOf = (event: EventRow) =>
    once(countedEvents(event.starts_at, event.ends_at)).find((group) =>
      group.ids.includes(event.id),
    );

  const parseWindow = (input: unknown): ListCalendarEventsInput => {
    if (!isRecord(input) || typeof input.from !== "string" || typeof input.to !== "string") {
      throw new InvalidInputError({ key: "error.calendar.badRequest" });
    }
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      throw new InvalidInputError({ key: "error.calendar.badRequest" });
    }
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  };

  const serviceOf = (input: unknown): CalendarService => {
    if (input === "google" || input === "microsoft" || input === "mac") return input;
    throw new InvalidInputError({ key: "error.calendar.badRequest" });
  };

  const notOffered = (service: CalendarService) =>
    new InvalidInputError({
      key: "error.calendar.notOffered",
      values: { service: SERVICE_NAMES[service] },
    });

  const insertAccount = (service: CalendarService, name: string | null) => {
    const id = randomUUID();
    const at = options.now();
    db.run(
      `INSERT INTO calendar_accounts (id, service, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, service, name, at, at],
    );
    return id;
  };

  /** Forgets an account on this device, its calendars and events with it. */
  const forget = (accountId: string) => {
    db.transaction(() => {
      deleteEvents("calendar_id IN (SELECT id FROM calendars WHERE account_id = ?)", [accountId]);
      db.run("DELETE FROM calendars WHERE account_id = ?", [accountId]);
      db.run("DELETE FROM calendar_accounts WHERE id = ?", [accountId]);
    });
    clearRetry(accountId);
  };

  async function connectRemote(service: RemoteService): Promise<CalendarAccount | null> {
    const config = options.services[service];
    if (!config) throw notOffered(service);
    if (options.localOnly()) {
      throw new TranslatableError({
        key: "error.calendar.localMode",
        values: { service: SERVICE_NAMES[service] },
      });
    }
    await signingIn?.cancel();
    const pendingId = randomUUID();
    const signIn = signInFor(pendingId, service, config);
    signingIn = { service, cancel: signIn.cancelSignIn };
    emit();
    try {
      await signIn.signIn(async (flows) => {
        const tokens = await flows.browser({
          authorizeUrl: config.authorizeUrl,
          tokenUrl: config.tokenUrl,
          clientId: config.clientId,
          scope: service === "google" ? GOOGLE_CALENDAR_SCOPE : MICROSOFT_CALENDAR_SCOPE,
          // Google's desktop clients take any loopback port; Microsoft's public clients are
          // registered as http://localhost, whose port it ignores.
          redirect:
            service === "google"
              ? { kind: "loopback", port: 0, path: "/" }
              : { kind: "loopback", port: 0, path: "", host: "localhost" },
          // Google gives a refresh token only when asked for offline access and consent.
          authorizeParams:
            service === "google"
              ? { access_type: "offline", prompt: "consent" }
              : { prompt: "select_account" },
          ...(config.clientSecret && { tokenParams: { client_secret: config.clientSecret } }),
        });
        await signIn.commit({ tokens: signIn.storedTokens(tokens, null), ended: null });
      });
    } catch (error) {
      await secrets
        .delete(secretName(pendingId))
        .catch((cleanup: unknown) =>
          log.warn("calendars.signInCleanupFailed", { service, error: String(cleanup) }),
        );
      if (error instanceof OAuthFlowError && error.reason === "cancelled") return null;
      log.warn("calendars.signInFailed", {
        service,
        error: error instanceof Error ? error.name : "unknown",
        reason: error instanceof OAuthFlowError ? error.reason : undefined,
      });
      throw new TranslatableError(
        { key: "error.calendar.signIn", values: { service: SERVICE_NAMES[service] } },
        { cause: error },
      );
    } finally {
      if (signingIn?.cancel === signIn.cancelSignIn) signingIn = null;
      emit();
    }
    // The User chose the service where its line said what goes to it: that is the consent.
    consent.choose(["calendars"], externalOf(service, config));

    // Who signed in: the same account signing in again keeps its calendars and choices.
    const pendingRow: AccountRow = {
      id: pendingId,
      service,
      name: null,
      synced_at: null,
      problem: null,
    };
    signIns.set(pendingId, signIn);
    let name: string | null = null;
    try {
      name = (await clientFor(pendingRow)?.calendars())?.account ?? null;
    } catch (error) {
      log.warn("calendars.accountUnread", { service, error: String(error) });
    }
    const same = liveAccounts().find((row) => row.service === service && row.name === name);
    let accountId: string = pendingId;
    if (same && name !== null) {
      const record = await secrets.get(secretName(pendingId));
      if (record) await secrets.set(secretName(same.id), record);
      await secrets.delete(secretName(pendingId));
      signIns.delete(pendingId);
      signIns.delete(same.id);
      accountId = same.id;
    } else {
      db.run(
        `INSERT INTO calendar_accounts (id, service, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [pendingId, service, name, options.now(), options.now()],
      );
    }
    clearRetry(accountId);
    await read(accountId);
    const row = accountRow(accountId);
    if (!row) throw new NotFoundError({ key: "error.calendar.accountGone" });
    return toAccount(row);
  }

  async function connectMac(): Promise<CalendarAccount> {
    if (!system) throw notOffered("mac");
    const existing = liveAccounts().find((row) => row.service === "mac");
    const accountId = existing?.id ?? insertAccount("mac", null);
    let access = await system.access();
    // The only place the system is asked: the User chose the Mac's calendar.
    if (access === "not-asked") access = await system.requestAccess();
    if (access !== "allowed") {
      setProblem(accountId, "denied");
      emit();
    } else {
      clearRetry(accountId);
      await read(accountId);
    }
    const row = accountRow(accountId);
    if (!row) throw new NotFoundError({ key: "error.calendar.accountGone" });
    return toAccount(row);
  }

  return {
    state,
    /** Starts reading: now, then every few minutes. */
    start: () => schedule(0),

    /** The computer woke: read everything now, failures' waits forgotten. */
    awake: () => {
      if (!closed) void readAll(false);
    },

    /** Local mode changed: its line shows or goes, and turning it off reads at once. */
    localModeChanged: () => {
      emit();
      if (!options.localOnly() && !closed) void readAll(false);
    },

    async connect(input: unknown): Promise<CalendarAccount | null> {
      const service = serviceOf(input);
      if (!offered().includes(service)) throw notOffered(service);
      return service === "mac" ? connectMac() : connectRemote(service);
    },

    async cancelSignIn(): Promise<void> {
      await signingIn?.cancel();
    },

    async disconnect(accountId: unknown): Promise<CalendarsState> {
      if (typeof accountId !== "string") throw new InvalidInputError({ key: "error.calendar.badRequest" });
      const row = accountRow(accountId);
      if (!row) throw new NotFoundError({ key: "error.calendar.accountGone" });
      const signIn = signInOf(row);
      if (signIn) {
        // In Local mode nothing is sent, so the session isn't ended at the service: the token is
        // forgotten here, and the User can end it in their account there.
        if (!options.localOnly()) await signIn.signOut();
        await secrets.delete(secretName(row.id));
        signIns.delete(row.id);
      }
      forget(row.id);
      emit();
      options.eventsChanged();
      return state();
    },

    async setCounted(input: unknown): Promise<CalendarsState> {
      if (
        !isRecord(input) ||
        typeof input.calendarId !== "string" ||
        typeof input.counted !== "boolean"
      ) {
        throw new InvalidInputError({ key: "error.calendar.badRequest" });
      }
      const { calendarId, counted } = input;
      const row = db.get<{ account_id: string }>(
        "SELECT account_id FROM calendars WHERE id = ?",
        [calendarId],
      );
      if (!row) throw new NotFoundError({ key: "error.calendar.calendarGone" });
      db.run("UPDATE calendars SET counted = ?, updated_at = ? WHERE id = ?", [
        counted ? 1 : 0,
        options.now(),
        calendarId,
      ]);
      // A calendar that doesn't count isn't read, and nothing of it is kept.
      if (!counted && deleteEvents("calendar_id = ?", [calendarId]) > 0) {
        options.eventsChanged();
      }
      emit();
      if (counted) {
        clearRetry(row.account_id);
        void read(row.account_id);
      }
      return state();
    },

    async syncNow(): Promise<CalendarsState> {
      await readAll(false);
      return state();
    },

    list(input: unknown): CalendarEvent[] {
      const { from, to } = parseWindow(input);
      return once(countedEvents(from, to)).map(({ shown, keys }) => ({
        id: shown.id,
        title: shown.title,
        startsAt: shown.starts_at,
        endsAt: shown.ends_at,
        attendees: parseAttendees(shown.attendees),
        joinUrl: shown.join_url,
        service: shown.service,
        mindId: noteFor(keys),
      }));
    },

    takeNotes(eventId: unknown): { mindId: string; created: boolean } {
      if (typeof eventId !== "string") throw new InvalidInputError({ key: "error.calendar.badRequest" });
      const event = db.get<EventRow>(
        `SELECT e.id, e.calendar_id, e.external_id, e.event_key, e.title, e.starts_at, e.ends_at,
           e.attendees, e.join_url
         FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ?`,
        [eventId],
      );
      if (!event) throw new NotFoundError({ key: "error.calendar.eventGone" });
      // Any copy of the invite opens the same Note, whichever copy Coming up showed.
      const group = groupOf(event);
      const existing = noteFor(group?.keys ?? [event.event_key]);
      if (existing) return { mindId: existing, created: false };
      const mindId = options.createNote(event.title);
      const at = options.now();
      db.run(
        `INSERT INTO calendar_event_notes (id, mind_id, event_key, event, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), mindId, event.event_key, snapshotOf(event), at, at],
      );
      options.eventsChanged();
      return { mindId, created: true };
    },

    noteEvent(mindId: unknown): NoteEvent | null {
      if (typeof mindId !== "string") throw new InvalidInputError({ key: "error.calendar.badRequest" });
      const link = db.get<{ event_key: string; event: string }>(
        `SELECT event_key, event FROM calendar_event_notes WHERE mind_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, rowid DESC`,
        [mindId],
      );
      if (!link) return null;
      const copy = db.get<EventRow>(
        `SELECT e.id, e.calendar_id, e.external_id, e.event_key, e.title, e.starts_at,
           e.ends_at, e.attendees, e.join_url
         FROM calendar_events e
         JOIN calendars c ON c.id = e.calendar_id AND c.counted = 1
         WHERE e.event_key = ? ORDER BY e.rowid`,
        [link.event_key],
      );
      const live = copy && groupOf(copy)?.shown;
      if (live) {
        return {
          eventId: live.id,
          title: live.title,
          startsAt: live.starts_at,
          endsAt: live.ends_at,
          attendees: parseAttendees(live.attendees),
          joinUrl: live.join_url,
        };
      }
      const kept = parseSnapshot(link.event);
      return kept && { eventId: null, ...kept };
    },

    /** The people on the event a Note was made for, for the transcriber and for naming Speakers. */
    attendeesOf(mindId: string): CalendarAttendee[] {
      const link = db.get<{ event: string }>(
        `SELECT event FROM calendar_event_notes WHERE mind_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, rowid DESC`,
        [mindId],
      );
      return link ? (parseSnapshot(link.event)?.attendees ?? []) : [];
    },

    async openSettings(): Promise<void> {
      if (!system) throw notOffered("mac");
      await system.openSettings();
    },

    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const id of [...retries.keys()]) clearRetry(id);
      void signingIn?.cancel();
    },
  };
}
