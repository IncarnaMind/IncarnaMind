/**
 * Reading Google Calendar and Microsoft 365 (#190): the account's calendars and a window of
 * their events, read only, with the User's sign-in. Every request passes the send gate first,
 * so Local mode and a flow turned off in Settings › Privacy stop it (ADR-0022).
 */
import type { CalendarServiceConfig } from "../adapters";
import { isRecord } from "../errors";
import type { OAuthCredentials } from "../oauthAccount";
import { fromGoogle, fromMicrosoft, type ReadEvent } from "./events";

/** A calendar as the service lists it. */
export interface RemoteCalendar {
  externalId: string;
  name: string;
  /** The User's own: it counts by default. */
  own: boolean;
}

export interface CalendarClient {
  /** The account's address, and its calendars. */
  calendars(): Promise<{ account: string; calendars: RemoteCalendar[] }>;
  /** The Meetings of one calendar that overlap `from` to `to` (ISO 8601). */
  events(calendar: string, from: string, to: string): Promise<ReadEvent[]>;
}

/** A request to a calendar service failed: `status` is null when it couldn't be reached at all. */
export class CalendarRequestError extends Error {
  override name = "CalendarRequestError";
  constructor(
    readonly status: number | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const REQUEST_TIMEOUT_MS = 20_000;
/** A window of a few days fits on a page or two; more is a calendar gone wrong. */
const MAX_PAGES = 20;

interface ApiOptions {
  config: CalendarServiceConfig;
  credentials: OAuthCredentials;
  /** Throws when nothing may be sent now (Local mode, the flow turned off). */
  check(): void;
  fetch: typeof fetch;
}

function createApi({ config, credentials, check, fetch }: ApiOptions) {
  const apiOrigin = new URL(config.apiBaseUrl).origin;
  const send = async (url: URL, accessToken: string, headers: Record<string, string>) => {
    check();
    try {
      return await fetch(url, {
        headers: { ...headers, authorization: `Bearer ${accessToken}`, accept: "application/json" },
        // A redirect would carry the token to another address.
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CalendarRequestError(null, `${url.host} couldn't be reached.`, { cause: error });
    }
  };
  return {
    /** The JSON at `url`, with the sign-in's token, refreshed once if the service refuses it. */
    async get(url: URL, headers: Record<string, string> = {}): Promise<unknown> {
      if (
        url.origin !== apiOrigin &&
        url.origin !== new URL(config.accountUrl ?? apiOrigin).origin
      ) {
        throw new CalendarRequestError(0, `Refusing to send the sign-in to ${url.host}.`);
      }
      let { accessToken } = await credentials.access();
      let response = await send(url, accessToken, headers);
      if (response.status === 401) {
        await response.body?.cancel();
        ({ accessToken } = await credentials.access({ rejected: accessToken }));
        response = await send(url, accessToken, headers);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CalendarRequestError(
          response.status,
          `${url.host} answered ${response.status} for ${url.pathname}.`,
        );
      }
      try {
        return await response.json();
      } catch (error) {
        throw new CalendarRequestError(0, `${url.host} sent something that isn't JSON.`, {
          cause: error,
        });
      }
    },
  };
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const items = (body: unknown, key: string): unknown[] =>
  isRecord(body) && Array.isArray(body[key]) ? body[key] : [];

/** Google's calendars that hold no Meetings of the User's: holidays, and contacts' birthdays. */
const GOOGLE_NOT_MEETINGS = /#(holiday|contacts)@group\.v\.calendar\.google\.com$/;

export function googleCalendar(options: ApiOptions & { untitled: () => string }): CalendarClient {
  const api = createApi(options);
  const base = options.config.apiBaseUrl.replace(/\/$/, "");
  return {
    async calendars() {
      const calendars: RemoteCalendar[] = [];
      let account: string | null = null;
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = new URL(`${base}/users/me/calendarList`);
        url.searchParams.set("maxResults", "250");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const body = await api.get(url);
        for (const item of items(body, "items")) {
          if (!isRecord(item)) continue;
          const id = text(item.id);
          if (!id || item.deleted === true) continue;
          if (item.primary === true) account = id;
          const role = item.accessRole;
          calendars.push({
            externalId: id,
            name: text(item.summaryOverride) ?? text(item.summary) ?? id,
            own:
              item.primary === true ||
              ((role === "owner" || role === "writer") &&
                item.selected === true &&
                !GOOGLE_NOT_MEETINGS.test(id)),
          });
        }
        pageToken = isRecord(body) ? text(body.nextPageToken) : null;
        if (!pageToken) break;
      }
      if (!account) throw new CalendarRequestError(0, "Google listed no primary calendar.");
      return { account, calendars };
    },

    async events(calendar, from, to) {
      const events: ReadEvent[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = new URL(`${base}/calendars/${encodeURIComponent(calendar)}/events`);
        url.searchParams.set("timeMin", from);
        url.searchParams.set("timeMax", to);
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        url.searchParams.set("showDeleted", "false");
        url.searchParams.set("maxResults", "250");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const body = await api.get(url);
        for (const item of items(body, "items")) {
          const event = fromGoogle(item, options.untitled());
          if (event) events.push(event);
        }
        pageToken = isRecord(body) ? text(body.nextPageToken) : null;
        if (!pageToken) break;
      }
      return events;
    },
  };
}

const GRAPH_EVENT_FIELDS = [
  "id",
  "iCalUId",
  "subject",
  "start",
  "end",
  "isAllDay",
  "isCancelled",
  "responseStatus",
  "attendees",
  "organizer",
  "onlineMeeting",
  "onlineMeetingUrl",
  "location",
  "bodyPreview",
].join(",");

export function microsoftCalendar(
  options: ApiOptions & { untitled: () => string },
): CalendarClient {
  const api = createApi(options);
  const base = options.config.apiBaseUrl.replace(/\/$/, "");
  /** Every page of a Graph collection, following its next links on the API's own host. */
  const all = async (first: URL, headers: Record<string, string> = {}) => {
    const found: unknown[] = [];
    let url: URL | null = first;
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      const body = await api.get(url, headers);
      found.push(...items(body, "value"));
      const next = isRecord(body) ? text(body["@odata.nextLink"]) : null;
      url = next ? new URL(next) : null;
    }
    return found;
  };
  let account: string | null = null;
  return {
    async calendars() {
      const me = await api.get(new URL(options.config.accountUrl ?? `${base}/me`));
      account = isRecord(me) ? (text(me.mail) ?? text(me.userPrincipalName)) : null;
      if (!account) throw new CalendarRequestError(0, "Microsoft named no account.");
      const url = new URL(`${base}/me/calendars`);
      url.searchParams.set("$select", "id,name,isDefaultCalendar,canEdit");
      url.searchParams.set("$top", "100");
      const calendars: RemoteCalendar[] = [];
      for (const item of await all(url)) {
        if (!isRecord(item)) continue;
        const id = text(item.id);
        if (!id) continue;
        calendars.push({
          externalId: id,
          name: text(item.name) ?? id,
          own: item.isDefaultCalendar === true || item.canEdit === true,
        });
      }
      return { account, calendars };
    },

    async events(calendar, from, to) {
      const url = new URL(`${base}/me/calendars/${encodeURIComponent(calendar)}/calendarView`);
      url.searchParams.set("startDateTime", from);
      url.searchParams.set("endDateTime", to);
      url.searchParams.set("$select", GRAPH_EVENT_FIELDS);
      url.searchParams.set("$top", "100");
      const found = await all(url, { prefer: 'outlook.timezone="UTC"' });
      const own = account ?? "";
      return found
        .map((item) => fromMicrosoft(item, own, options.untitled()))
        .filter((event): event is ReadEvent => event !== null);
    },
  };
}
