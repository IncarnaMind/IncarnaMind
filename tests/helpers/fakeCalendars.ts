/**
 * A local stand-in for Google Calendar and Microsoft 365 (#190): their sign-in (the authorization
 * code flow with PKCE), token refresh and revoke, and the read-only calendar APIs IncarnaMind
 * calls, answering in each service's own shapes from one set of fixtures. Served at the paths
 * `calendarStandIns` names, for the unit tests and the smoke tests alike.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "../../src/core";

export const GOOGLE_CLIENT_ID = "test-google-client";
export const GOOGLE_CLIENT_SECRET = "test-google-secret";
export const MICROSOFT_CLIENT_ID = "test-microsoft-client";

export type FakeResponse = "accepted" | "declined" | "tentative" | "needsAction";

export interface FakePerson {
  name?: string;
  email: string;
  self?: boolean;
  response?: FakeResponse;
}

/** An event as both services hold it: one occurrence, times as ISO 8601. */
export interface FakeEvent {
  id: string;
  /** The invite's iCalendar UID, the same in every calendar that holds it. Defaults to `<id>@fake`. */
  uid?: string;
  title: string;
  start: string;
  end: string;
  /** Held as dates: `start` and `end` are read as their date parts. */
  allDay?: boolean;
  status?: "confirmed" | "tentative" | "cancelled";
  attendees?: FakePerson[];
  organizer?: FakePerson;
  /** Google's Meet link, or Microsoft's Teams link. */
  joinUrl?: string;
  location?: string;
  description?: string;
  /** For one occurrence of a recurring event: when it was meant to start. */
  originalStart?: string;
  /** The zone Google names for its times. Defaults to UTC. */
  timeZone?: string;
}

export interface FakeCalendar {
  id: string;
  name: string;
  /** Google's primary calendar, Microsoft's default one. */
  primary?: boolean;
  /** Google's access role; Microsoft's `canEdit` is owner or writer. Defaults to "owner". */
  access?: "owner" | "writer" | "reader" | "freeBusyReader";
  /** Google's "show in my list". Defaults to true. */
  selected?: boolean;
  events: FakeEvent[];
}

export interface FakeAccount {
  email: string;
  name: string;
  calendars: FakeCalendar[];
}

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
}

export interface FakeService {
  account: FakeAccount;
  /** Seconds each access token is said to last. */
  accessLifetime: number;
  /** Every request to the calendar API, in order. */
  requests: FakeRequest[];
  /** Every token request's form, in order. */
  tokenRequests: URLSearchParams[];
  /** Refresh tokens revoked at disconnect. */
  revoked: string[];
  /** Access tokens the API refuses from now on, as an expired one is refused. */
  expireAccessTokens(): void;
  /** The next refresh is refused for good ("invalid_grant"), as a revoked sign-in is. */
  refuseRefresh: boolean;
  /** The API answers with this status, until set back to null. */
  failing: number | null;
  /** Events and calendars come this many to a page. */
  pageSize: number;
}

export interface FakeCalendarsServer {
  origin: string;
  google: FakeService;
  microsoft: FakeService;
  /** Every connection is cut before it is answered, as when the computer is offline. */
  offline: boolean;
  /** Where the service's page sends the browser back once the User approves, or declines. */
  redirectFor(authorizeUrl: string, decision?: "approve" | "decline"): URL;
  close(): Promise<void>;
}

type ServiceName = "google" | "microsoft";

interface Grant {
  service: ServiceName;
  challenge: string;
  redirectUri: string;
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const token = (prefix: string) => `${prefix}-${randomBytes(12).toString("base64url")}`;

function createService(account: FakeAccount): FakeService & { valid: Set<string> } {
  const valid = new Set<string>();
  return {
    account,
    accessLifetime: 3600,
    requests: [],
    tokenRequests: [],
    revoked: [],
    refuseRefresh: false,
    failing: null,
    pageSize: 250,
    valid,
    expireAccessTokens: () => valid.clear(),
  };
}

const DEFAULT_GOOGLE: FakeAccount = {
  email: "priya@example.com",
  name: "Priya Raman",
  calendars: [],
};
const DEFAULT_MICROSOFT: FakeAccount = {
  email: "priya@contoso.com",
  name: "Priya Raman",
  calendars: [],
};

/** Starts the stand-in on a free port. Call `close` when done. */
export async function createFakeCalendars(
  accounts: { google?: FakeAccount; microsoft?: FakeAccount } = {},
): Promise<FakeCalendarsServer> {
  // A copy, so a test that moves or cancels an event changes no other test's fixture.
  const google = createService(structuredClone(accounts.google ?? DEFAULT_GOOGLE));
  const microsoft = createService(structuredClone(accounts.microsoft ?? DEFAULT_MICROSOFT));
  const services = { google, microsoft };
  const grants = new Map<string, Grant>();
  const refreshTokens = new Map<string, ServiceName>();

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify(body));
  };

  const readForm = (request: IncomingMessage) =>
    new Promise<URLSearchParams>((resolve, reject) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => resolve(new URLSearchParams(body)));
      request.on("error", reject);
    });

  const issue = (name: ServiceName) => {
    const service = services[name];
    const access = token(`${name}-access`);
    const refresh = token(`${name}-refresh`);
    service.valid.add(access);
    refreshTokens.set(refresh, name);
    return { access, refresh };
  };

  const tokenEndpoint = async (
    name: ServiceName,
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    const service = services[name];
    const form = await readForm(request);
    service.tokenRequests.push(form);
    const clientId = name === "google" ? GOOGLE_CLIENT_ID : MICROSOFT_CLIENT_ID;
    if (form.get("client_id") !== clientId) {
      send(response, 401, { error: "invalid_client" });
      return;
    }
    // Google's installed-app client sends its secret; Microsoft's public client has none.
    const secret = form.get("client_secret");
    if (name === "google" ? secret !== GOOGLE_CLIENT_SECRET : secret !== null) {
      send(response, 401, { error: "invalid_client" });
      return;
    }
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const granted = grants.get(code);
      grants.delete(code);
      if (
        !granted ||
        granted.service !== name ||
        granted.redirectUri !== form.get("redirect_uri") ||
        s256(form.get("code_verifier") ?? "") !== granted.challenge
      ) {
        send(response, 400, { error: "invalid_grant" });
        return;
      }
      const { access, refresh } = issue(name);
      send(response, 200, {
        access_token: access,
        refresh_token: refresh,
        expires_in: service.accessLifetime,
        token_type: "Bearer",
        scope:
          name === "google"
            ? "https://www.googleapis.com/auth/calendar.readonly"
            : "Calendars.Read",
      });
      return;
    }
    if (grant === "refresh_token") {
      const refresh = form.get("refresh_token") ?? "";
      if (service.refuseRefresh || refreshTokens.get(refresh) !== name) {
        send(response, 400, {
          error: "invalid_grant",
          error_description: "Token has been revoked.",
        });
        return;
      }
      const access = token(`${name}-access`);
      service.valid.add(access);
      send(response, 200, {
        access_token: access,
        expires_in: service.accessLifetime,
        token_type: "Bearer",
      });
      return;
    }
    send(response, 400, { error: "unsupported_grant_type" });
  };

  const authorized = (name: ServiceName, request: IncomingMessage) => {
    const header = request.headers.authorization ?? "";
    return header.startsWith("Bearer ") && services[name].valid.has(header.slice(7));
  };

  const overlaps = (event: FakeEvent, from: string | undefined, to: string | undefined) =>
    (!from || Date.parse(event.end) > Date.parse(from)) &&
    (!to || Date.parse(event.start) < Date.parse(to));

  const page = <T>(items: readonly T[], size: number, at: string | undefined) => {
    const start = Number(at ?? 0);
    const next = start + size < items.length ? String(start + size) : null;
    return { items: items.slice(start, start + size), next };
  };

  const dateOnly = (iso: string) => iso.slice(0, 10);

  const googlePerson = (person: FakePerson, account: FakeAccount) => ({
    email: person.email,
    ...(person.name && { displayName: person.name }),
    ...((person.self || person.email === account.email) && { self: true }),
    responseStatus: person.response ?? "needsAction",
  });

  const googleEvent = (event: FakeEvent, account: FakeAccount) => ({
    kind: "calendar#event",
    id: event.id,
    iCalUID: event.uid ?? `${event.id}@fake`,
    status: event.status ?? "confirmed",
    summary: event.title,
    start: event.allDay
      ? { date: dateOnly(event.start) }
      : { dateTime: event.start, timeZone: event.timeZone ?? "UTC" },
    end: event.allDay
      ? { date: dateOnly(event.end) }
      : { dateTime: event.end, timeZone: event.timeZone ?? "UTC" },
    ...(event.attendees && {
      attendees: event.attendees.map((person) => googlePerson(person, account)),
    }),
    ...(event.organizer && { organizer: googlePerson(event.organizer, account) }),
    ...(event.joinUrl && {
      hangoutLink: event.joinUrl,
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: event.joinUrl }] },
    }),
    ...(event.location && { location: event.location }),
    ...(event.description && { description: event.description }),
    ...(event.originalStart && {
      recurringEventId: `${event.id.split("_")[0]}`,
      originalStartTime: { dateTime: event.originalStart },
    }),
    eventType: "default",
  });

  const microsoftResponse = (response: FakeResponse | undefined) =>
    response === "accepted"
      ? "accepted"
      : response === "declined"
        ? "declined"
        : response === "tentative"
          ? "tentativelyAccepted"
          : "notResponded";

  // Graph answers in the zone the Prefer header asks for, as "2026-11-09T09:30:00.0000000".
  const graphTime = (iso: string) => `${new Date(iso).toISOString().slice(0, 19)}.0000000`;

  const microsoftEvent = (event: FakeEvent, account: FakeAccount) => {
    const self = event.attendees?.find((person) => person.self || person.email === account.email);
    const organizer = event.organizer ?? { email: account.email, name: account.name };
    const organizing = organizer.self || organizer.email === account.email;
    return {
      id: event.id,
      iCalUId: event.uid ?? `${event.id}@fake`,
      subject: event.title,
      isAllDay: event.allDay === true,
      isCancelled: event.status === "cancelled",
      start: {
        dateTime: graphTime(event.allDay ? `${dateOnly(event.start)}T00:00:00Z` : event.start),
        timeZone: "UTC",
      },
      end: {
        dateTime: graphTime(event.allDay ? `${dateOnly(event.end)}T00:00:00Z` : event.end),
        timeZone: "UTC",
      },
      responseStatus: { response: organizing ? "organizer" : microsoftResponse(self?.response) },
      attendees: (event.attendees ?? []).map((person) => ({
        type: "required",
        status: { response: microsoftResponse(person.response) },
        emailAddress: { name: person.name ?? person.email, address: person.email },
      })),
      organizer: {
        emailAddress: { name: organizer.name ?? organizer.email, address: organizer.email },
      },
      onlineMeeting: event.joinUrl ? { joinUrl: event.joinUrl } : null,
      location: { displayName: event.location ?? "" },
      bodyPreview: event.description ?? "",
      type: event.originalStart ? "occurrence" : "singleInstance",
      ...(event.originalStart && { originalStart: event.originalStart }),
    };
  };

  const googleApi = (url: URL, response: ServerResponse) => {
    const { account, pageSize } = google;
    const query = Object.fromEntries(url.searchParams);
    if (url.pathname === "/google/calendar/v3/users/me/calendarList") {
      const { items, next } = page(account.calendars, pageSize, query.pageToken);
      send(response, 200, {
        items: items.map((calendar) => ({
          id: calendar.primary ? account.email : calendar.id,
          summary: calendar.primary ? account.email : calendar.name,
          ...(calendar.primary && { primary: true }),
          accessRole: calendar.access ?? "owner",
          ...(calendar.selected !== false && { selected: true }),
        })),
        ...(next && { nextPageToken: next }),
      });
      return;
    }
    const events = /^\/google\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (events?.[1]) {
      const id = decodeURIComponent(events[1]);
      const calendar = account.calendars.find(
        (each) => (each.primary ? account.email : each.id) === id,
      );
      if (!calendar) {
        send(response, 404, { error: { code: 404, message: "Not Found" } });
        return;
      }
      const shown = calendar.events.filter(
        (event) =>
          overlaps(event, query.timeMin, query.timeMax) &&
          (query.showDeleted === "true" || event.status !== "cancelled"),
      );
      const { items, next } = page(shown, pageSize, query.pageToken);
      send(response, 200, {
        items: items.map((event) => googleEvent(event, account)),
        ...(next && { nextPageToken: next }),
      });
      return;
    }
    send(response, 404, { error: { code: 404, message: "Not Found" } });
  };

  const microsoftApi = (request: IncomingMessage, url: URL, response: ServerResponse) => {
    const { account, pageSize } = microsoft;
    const query = Object.fromEntries(url.searchParams);
    const nextLink = (next: string | null) =>
      next ? { "@odata.nextLink": `${url.origin}${url.pathname}?${withPage(url, next)}` } : {};
    if (url.pathname === "/microsoft/v1.0/me") {
      send(response, 200, {
        displayName: account.name,
        mail: account.email,
        userPrincipalName: account.email,
      });
      return;
    }
    if (url.pathname === "/microsoft/v1.0/me/calendars") {
      const { items, next } = page(account.calendars, pageSize, query.skip);
      send(response, 200, {
        value: items.map((calendar) => ({
          id: calendar.id,
          name: calendar.name,
          isDefaultCalendar: calendar.primary === true,
          canEdit: (calendar.access ?? "owner") === "owner" || calendar.access === "writer",
          owner: { name: account.name, address: account.email },
        })),
        ...nextLink(next),
      });
      return;
    }
    const view = /^\/microsoft\/v1\.0\/me\/calendars\/([^/]+)\/calendarView$/.exec(url.pathname);
    if (view?.[1]) {
      if (!/outlook\.timezone="UTC"/.test(String(request.headers.prefer ?? ""))) {
        send(response, 400, { error: { code: "ErrorInvalidRequest", message: "Ask for UTC." } });
        return;
      }
      const calendar = account.calendars.find(
        (each) => each.id === decodeURIComponent(view[1] ?? ""),
      );
      if (!calendar) {
        send(response, 404, { error: { code: "ErrorItemNotFound", message: "Not found." } });
        return;
      }
      const shown = calendar.events.filter((event) =>
        overlaps(event, query.startDateTime, query.endDateTime),
      );
      const { items, next } = page(shown, pageSize, query.skip);
      send(response, 200, {
        value: items.map((event) => microsoftEvent(event, account)),
        ...nextLink(next),
      });
      return;
    }
    send(response, 404, { error: { code: "ErrorItemNotFound", message: "Not found." } });
  };

  const withPage = (url: URL, skip: string) => {
    const params = new URLSearchParams(url.searchParams);
    params.set("skip", skip);
    return params.toString();
  };

  let offline = false;
  const server = createServer((request, response) => {
    if (offline) {
      request.socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const name: ServiceName | null = url.pathname.startsWith("/google/")
      ? "google"
      : url.pathname.startsWith("/microsoft/")
        ? "microsoft"
        : null;
    if (!name) {
      send(response, 404, {});
      return;
    }
    const service = services[name];
    const rest = url.pathname.slice(name.length + 1);
    if (rest === "/token" && request.method === "POST") {
      tokenEndpoint(name, request, response).catch((error: unknown) => {
        send(response, 500, { error: String(error) });
      });
      return;
    }
    if (rest === "/revoke" && request.method === "POST") {
      readForm(request)
        .then((form) => {
          service.revoked.push(form.get("token") ?? "");
          send(response, 200, {});
        })
        .catch((error: unknown) => send(response, 500, { error: String(error) }));
      return;
    }
    service.requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.authorization ?? null,
    });
    if (service.failing !== null) {
      send(response, service.failing, {
        error: { code: service.failing, message: "Unavailable." },
      });
      return;
    }
    if (!authorized(name, request)) {
      send(response, 401, { error: { code: 401, message: "Invalid Credentials" } });
      return;
    }
    if (name === "google") googleApi(url, response);
    else microsoftApi(request, url, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    google,
    microsoft,
    get offline() {
      return offline;
    },
    set offline(value) {
      offline = value;
    },
    redirectFor(authorizeUrl, decision = "approve") {
      const url = new URL(authorizeUrl);
      const name: ServiceName = url.pathname.startsWith("/google/") ? "google" : "microsoft";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const back = new URL(redirectUri);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      if (decision === "decline") {
        back.searchParams.set("error", "access_denied");
        return back;
      }
      const code = token(`${name}-code`);
      grants.set(code, {
        service: name,
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri,
      });
      back.searchParams.set("code", code);
      return back;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface FakeCalendarBrowser extends Browser {
  opened: string[];
  /** What the User does on the service's page. */
  behaviour: "approve" | "decline" | "ignore";
  /** Where the browser reaches "localhost": IPv4's loopback, or IPv6's first, as some do. */
  localhost: "127.0.0.1" | "[::1]";
  /** The page the loopback redirect showed, once the browser came back. */
  visits: Promise<number>[];
}

/** A browser in which the User signs in to the stand-in, coming back to IncarnaMind as a real one does. */
export function createFakeCalendarBrowser(fake: FakeCalendarsServer): FakeCalendarBrowser {
  const browser: FakeCalendarBrowser = {
    opened: [],
    behaviour: "approve",
    localhost: "127.0.0.1",
    visits: [],
    async open(url) {
      browser.opened.push(url);
      if (browser.behaviour === "ignore") return;
      const back = fake.redirectFor(url, browser.behaviour);
      // A redirect to "localhost" reaches the loopback server on 127.0.0.1, as the browser does.
      if (back.hostname === "localhost") back.hostname = browser.localhost;
      browser.visits.push(
        new Promise((resolve) => setTimeout(resolve, 5)).then(
          async () => (await fetch(back)).status,
        ),
      );
    },
  };
  return browser;
}
