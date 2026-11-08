/**
 * A stand-in for the Mac's calendars (#190), for tests and test builds: what it holds, and what
 * the User answers when the system asks for access. Nothing on the computer is read.
 */
import type {
  SystemCalendar,
  SystemCalendarAccess,
  SystemCalendarEvent,
  SystemCalendarInfo,
} from "../adapters";

export interface SystemCalendarFixture {
  access: SystemCalendarAccess;
  /** What the User answers when asked; defaults to "allowed". */
  answer?: SystemCalendarAccess;
  calendars: SystemCalendarInfo[];
  events: SystemCalendarEvent[];
}

export interface FakeSystemCalendar extends SystemCalendar {
  readonly fixture: SystemCalendarFixture;
  /** How many times the system was asked for access, and its settings opened. */
  readonly asked: number;
  readonly settingsOpened: number;
}

export function createFakeSystemCalendar(fixture: SystemCalendarFixture): FakeSystemCalendar {
  let asked = 0;
  let settingsOpened = 0;
  const allowed = () => {
    if (fixture.access !== "allowed") throw new Error("Calendar access isn't allowed.");
  };
  return {
    fixture,
    get asked() {
      return asked;
    },
    get settingsOpened() {
      return settingsOpened;
    },
    access: async () => fixture.access,
    async requestAccess() {
      asked += 1;
      if (fixture.access === "not-asked") fixture.access = fixture.answer ?? "allowed";
      return fixture.access;
    },
    async calendars() {
      allowed();
      return fixture.calendars.map((calendar) => ({ ...calendar }));
    },
    async events({ from, to, calendarIds }) {
      allowed();
      const start = Date.parse(from);
      const end = Date.parse(to);
      return fixture.events
        .filter(
          (event) =>
            calendarIds.includes(event.calendarId) &&
            Date.parse(event.end) > start &&
            Date.parse(event.start) < end,
        )
        .map((event) => structuredClone(event));
    },
    async openSettings() {
      settingsOpened += 1;
    },
  };
}
