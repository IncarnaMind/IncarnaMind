/**
 * Google Calendar's and Microsoft 365's addresses and read-only scopes (#190). The client IDs
 * aren't here: they come from the build (#209), and a copy built without them offers neither.
 */
import type { CalendarServiceConfig } from "../adapters";

export type CalendarServiceAddresses = Omit<CalendarServiceConfig, "clientId" | "clientSecret">;

/** Read-only access to the User's calendars and their events, and nothing else. */
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export const GOOGLE_CALENDAR: CalendarServiceAddresses = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  apiBaseUrl: "https://www.googleapis.com/calendar/v3",
};

/** Read-only calendars, the account's name (User.Read), and a refresh token (offline_access). */
export const MICROSOFT_CALENDAR_SCOPE = "offline_access User.Read Calendars.Read";

export const MICROSOFT_CALENDAR: CalendarServiceAddresses = {
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  apiBaseUrl: "https://graph.microsoft.com/v1.0",
  accountUrl: "https://graph.microsoft.com/v1.0/me",
};

/**
 * The addresses of a local stand-in for both services, at `origin`, as the tests' fake serves
 * them (tests/helpers/fakeCalendars.ts).
 */
export function calendarStandIns(origin: string): {
  google: CalendarServiceAddresses;
  microsoft: CalendarServiceAddresses;
} {
  return {
    google: {
      authorizeUrl: `${origin}/google/authorize`,
      tokenUrl: `${origin}/google/token`,
      revokeUrl: `${origin}/google/revoke`,
      apiBaseUrl: `${origin}/google/calendar/v3`,
    },
    microsoft: {
      authorizeUrl: `${origin}/microsoft/authorize`,
      tokenUrl: `${origin}/microsoft/token`,
      apiBaseUrl: `${origin}/microsoft/v1.0`,
      accountUrl: `${origin}/microsoft/v1.0/me`,
    },
  };
}
