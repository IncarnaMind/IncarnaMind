import { createServer } from "node:net";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type { CalendarsState, Core, CoreAdapters } from "../../src/core";
import { calendarStandIns } from "../../src/core/calendars/endpoints";
import {
  createFakeSystemCalendar,
  type FakeSystemCalendar,
  type SystemCalendarFixture,
} from "../../src/core/calendars/fakeSystem";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import {
  createFakeCalendarBrowser,
  createFakeCalendars,
  type FakeAccount,
  type FakeCalendarBrowser,
  type FakeCalendarsServer,
  type FakeEvent,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  MICROSOFT_CLIENT_ID,
} from "../helpers/fakeCalendars";

/** Monday 9 November 2026, 08:00 UTC. */
const NOW = "2026-11-09T08:00:00.000Z";

const standup: FakeEvent = {
  id: "standup",
  title: "Standup",
  start: "2026-11-09T09:30:00Z",
  end: "2026-11-09T09:45:00Z",
  attendees: [
    { email: "priya@example.com", self: true, response: "accepted" },
    { name: "Dana Kim", email: "dana@northwind.com", response: "accepted" },
    { name: "Sam Okafor", email: "sam@northwind.com" },
  ],
  organizer: { name: "Dana Kim", email: "dana@northwind.com" },
  joinUrl: "https://meet.google.com/abc-defg-hij",
};

function googleAccount(events: FakeEvent[] = [standup]): FakeAccount {
  return {
    email: "priya@example.com",
    name: "Priya Raman",
    calendars: [
      { id: "primary", name: "Priya", primary: true, events },
      {
        id: "en.uk#holiday@group.v.calendar.google.com",
        name: "Holidays in the UK",
        access: "reader",
        events: [],
      },
    ],
  };
}

interface Setup {
  core: Core;
  dataDir: string;
  fake: FakeCalendarsServer;
  browser: FakeCalendarBrowser;
  system: FakeSystemCalendar;
  clock: ReturnType<typeof manualClock>;
}

async function setUp(
  options: {
    google?: FakeAccount;
    microsoft?: FakeAccount;
    mac?: SystemCalendarFixture;
    adapters?: Partial<CoreAdapters>;
    dataDir?: string;
    fake?: FakeCalendarsServer;
  } = {},
): Promise<Setup> {
  const fake =
    options.fake ??
    (await createFakeCalendars({
      ...(options.google && { google: options.google }),
      ...(options.microsoft && { microsoft: options.microsoft }),
    }));
  if (!options.fake) onTestFinished(() => fake.close());
  const browser = createFakeCalendarBrowser(fake);
  const system = createFakeSystemCalendar(
    options.mac ?? { access: "not-asked", calendars: [], events: [] },
  );
  const clock = manualClock(NOW);
  const stand = calendarStandIns(fake.origin);
  const dataDir = options.dataDir ?? (await createTempDataFolder());
  const core = startCore(dataDir, {
    now: clock.now,
    browser,
    systemCalendar: system,
    calendarServices: {
      google: { ...stand.google, clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
      microsoft: { ...stand.microsoft, clientId: MICROSOFT_CLIENT_ID },
    },
    ...options.adapters,
  });
  return { core, dataDir, fake, browser, system, clock };
}

const DAY = { from: "2026-11-09T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z" };

const titles = async (core: Core, window = DAY) =>
  (await core.listCalendarEvents(window)).map((event) => event.title);

const accountOf = (state: CalendarsState, service: string) =>
  state.accounts.find((account) => account.service === service);

describe("Calendars: Google and Microsoft (#190)", () => {
  test("connecting Google signs in in the browser with PKCE and the installed-app secret, allows the flow, and reads the day's Meetings", async () => {
    const { core, fake, browser } = await setUp({
      google: googleAccount([
        standup,
        {
          id: "offsite",
          title: "Team offsite",
          start: "2026-11-10T00:00:00Z",
          end: "2026-11-11T00:00:00Z",
          allDay: true,
        },
        {
          id: "declined",
          title: "Vendor pitch",
          start: "2026-11-09T11:00:00Z",
          end: "2026-11-09T12:00:00Z",
          attendees: [{ email: "priya@example.com", self: true, response: "declined" }],
        },
        {
          id: "cancelled",
          title: "Old sync",
          start: "2026-11-09T13:00:00Z",
          end: "2026-11-09T13:30:00Z",
          status: "cancelled",
        },
      ]),
    });

    const account = await core.connectCalendar("google");

    const [authorize] = browser.opened;
    const params = new URL(authorize ?? "").searchParams;
    expect(params.get("scope")).toBe("https://www.googleapis.com/auth/calendar.readonly");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const exchange = fake.google.tokenRequests[0];
    expect(exchange?.get("client_secret")).toBe(GOOGLE_CLIENT_SECRET);
    expect(exchange?.get("code_verifier")).toBeTruthy();
    expect(await browser.visits[0]).toBe(200);

    expect(account).toMatchObject({ service: "google", name: "priya@example.com", problem: null });
    expect(account?.calendars).toEqual([
      expect.objectContaining({ name: "priya@example.com", counted: true }),
      expect.objectContaining({ name: "Holidays in the UK", counted: false }),
    ]);
    const events = await core.listCalendarEvents(DAY);
    expect(events).toEqual([
      {
        id: expect.any(String),
        title: "Standup",
        startsAt: "2026-11-09T09:30:00.000Z",
        endsAt: "2026-11-09T09:45:00.000Z",
        attendees: [
          { name: "priya@example.com", email: "priya@example.com", self: true },
          { name: "Dana Kim", email: "dana@northwind.com", self: false },
          { name: "Sam Okafor", email: "sam@northwind.com", self: false },
        ],
        joinUrl: "https://meet.google.com/abc-defg-hij",
        service: "google",
        mindId: null,
      },
    ]);
    // The holidays calendar doesn't count, so it isn't read.
    expect(fake.google.requests.some((each) => each.path.includes("holiday"))).toBe(false);

    const flows = await core.listDataFlows();
    expect(flows).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({
          id: "calendars",
          service: { id: new URL(fake.origin).origin, name: "Google Calendar" },
        }),
        consent: "accepted",
      }),
    );
  });

  test("Microsoft signs in through http://localhost with no client secret, and reads in UTC", async () => {
    const { core, fake, browser } = await setUp({
      microsoft: {
        email: "priya@contoso.com",
        name: "Priya Raman",
        calendars: [
          {
            id: "cal-1",
            name: "Calendar",
            primary: true,
            events: [
              {
                id: "review",
                title: "Quarterly review",
                start: "2026-11-09T14:00:00+01:00",
                end: "2026-11-09T15:00:00+01:00",
                attendees: [
                  { name: "Lena Ortiz", email: "lena@contoso.com", response: "accepted" },
                ],
                joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting",
              },
              {
                id: "holiday",
                title: "Public holiday",
                start: "2026-11-10T00:00:00Z",
                end: "2026-11-11T00:00:00Z",
                allDay: true,
              },
              {
                id: "called-off",
                title: "Planning",
                start: "2026-11-09T10:00:00Z",
                end: "2026-11-09T10:30:00Z",
                status: "cancelled",
              },
              {
                id: "said-no",
                title: "Webinar",
                start: "2026-11-09T16:00:00Z",
                end: "2026-11-09T17:00:00Z",
                organizer: { email: "events@fabrikam.com" },
                attendees: [{ email: "priya@contoso.com", response: "declined" }],
              },
            ],
          },
        ],
      },
    });

    const account = await core.connectCalendar("microsoft");

    const params = new URL(browser.opened[0] ?? "").searchParams;
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+$/);
    expect(params.get("scope")).toBe("offline_access User.Read Calendars.Read");
    expect(fake.microsoft.tokenRequests[0]?.has("client_secret")).toBe(false);
    expect(account).toMatchObject({ service: "microsoft", name: "priya@contoso.com" });
    const [review, ...rest] = await core.listCalendarEvents(DAY);
    expect(rest).toEqual([]);
    expect(review).toMatchObject({
      title: "Quarterly review",
      startsAt: "2026-11-09T13:00:00.000Z",
      endsAt: "2026-11-09T14:00:00.000Z",
      joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting",
    });
    expect(review?.attendees.map((each) => each.name)).toEqual(["Priya Raman", "Lena Ortiz"]);
  });

  test("an access token the service refuses is refreshed; a refresh refused for good asks to sign in again, keeping what was read", async () => {
    const { core, fake } = await setUp({ google: googleAccount() });
    await core.connectCalendar("google");

    fake.google.expireAccessTokens();
    const refreshed = await core.syncCalendars();
    expect(accountOf(refreshed, "google")?.problem).toBeNull();
    expect(fake.google.tokenRequests.map((form) => form.get("grant_type"))).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(fake.google.tokenRequests[1]?.get("client_secret")).toBe(GOOGLE_CLIENT_SECRET);

    fake.google.expireAccessTokens();
    fake.google.refuseRefresh = true;
    const ended = await core.syncCalendars();
    expect(accountOf(ended, "google")?.problem).toBe("sign-in");
    expect(await titles(core)).toEqual(["Standup"]);
  });

  test("events come a page at a time, and every page is read", async () => {
    const meetings = ["One", "Two", "Three"].map((title, index) => ({
      id: title.toLowerCase(),
      title,
      start: `2026-11-09T1${index}:00:00Z`,
      end: `2026-11-09T1${index}:30:00Z`,
    }));
    const { core, fake } = await setUp({ google: googleAccount(meetings) });
    fake.google.pageSize = 1;
    await core.connectCalendar("google");
    expect(await titles(core)).toEqual(["One", "Two", "Three"]);
  });

  test("a moved Meeting keeps its id and its Note follows it; a cancelled one goes, and its Note stays", async () => {
    const { core, fake } = await setUp({ google: googleAccount() });
    await core.connectCalendar("google");
    const [event] = await core.listCalendarEvents(DAY);
    const taken = await core.takeEventNotes(event?.id ?? "");
    expect(taken.created).toBe(true);
    expect(await core.takeEventNotes(event?.id ?? "")).toEqual({
      mindId: taken.mindId,
      created: false,
    });
    expect((await core.listMinds()).find((mind) => mind.id === taken.mindId)?.title).toBe(
      "Standup",
    );

    const held = fake.google.account.calendars[0]?.events[0];
    if (!held) throw new Error("The fixture has no event.");
    held.start = "2026-11-09T10:00:00Z";
    held.end = "2026-11-09T10:15:00Z";
    await core.syncCalendars();
    const [moved] = await core.listCalendarEvents(DAY);
    expect(moved).toMatchObject({
      id: event?.id,
      startsAt: "2026-11-09T10:00:00.000Z",
      mindId: taken.mindId,
    });
    expect(await core.getNoteEvent(taken.mindId)).toMatchObject({
      eventId: event?.id,
      startsAt: "2026-11-09T10:00:00.000Z",
    });

    held.status = "cancelled";
    await core.syncCalendars();
    expect(await core.listCalendarEvents(DAY)).toEqual([]);
    expect(await core.getNoteEvent(taken.mindId)).toMatchObject({
      eventId: null,
      title: "Standup",
      startsAt: "2026-11-09T10:00:00.000Z",
      joinUrl: "https://meet.google.com/abc-defg-hij",
    });
    expect((await core.listMinds()).some((mind) => mind.id === taken.mindId)).toBe(true);
  });

  test("times are kept in UTC across time zones and the night the clocks go back", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    onTestFinished(() => {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    });
    const { core, clock } = await setUp({
      google: googleAccount([
        // 1 November 2026: New York's clocks go back at 02:00, so 01:30 comes twice.
        {
          id: "first",
          title: "Before the change",
          start: "2026-11-01T01:30:00-04:00",
          end: "2026-11-01T01:45:00-04:00",
          timeZone: "America/New_York",
        },
        {
          id: "second",
          title: "After the change",
          start: "2026-11-01T01:30:00-05:00",
          end: "2026-11-01T01:45:00-05:00",
          timeZone: "America/New_York",
        },
        {
          id: "shanghai",
          title: "Shanghai call",
          start: "2026-11-01T20:00:00+08:00",
          end: "2026-11-01T21:00:00+08:00",
          timeZone: "Asia/Shanghai",
        },
      ]),
    });
    clock.advance(Date.parse("2026-11-01T12:00:00Z") - Date.parse(NOW));
    await core.connectCalendar("google");
    const events = await core.listCalendarEvents({
      from: "2026-11-01T04:00:00Z",
      to: "2026-11-02T05:00:00Z",
    });
    expect(events.map((event) => [event.title, event.startsAt])).toEqual([
      ["Before the change", "2026-11-01T05:30:00.000Z"],
      ["After the change", "2026-11-01T06:30:00.000Z"],
      ["Shanghai call", "2026-11-01T12:00:00.000Z"],
    ]);
  });

  test("a calendar the User stops counting isn't read, and nothing of it is kept; counted again, it is read again", async () => {
    const { core, fake } = await setUp({ google: googleAccount() });
    const account = await core.connectCalendar("google");
    const primary = account?.calendars.find((calendar) => calendar.counted);
    if (!primary) throw new Error("No calendar counts.");

    const changed = vi.fn();
    core.on("calendarEvents.changed", changed);
    const state = await core.setCalendarCounted({ calendarId: primary.id, counted: false });
    expect(accountOf(state, "google")?.calendars.every((each) => !each.counted)).toBe(true);
    expect(await titles(core)).toEqual([]);
    expect(changed).toHaveBeenCalled();
    const requests = fake.google.requests.length;
    await core.syncCalendars();
    expect(fake.google.requests.slice(requests).some((each) => each.path.endsWith("/events"))).toBe(
      false,
    );

    await core.setCalendarCounted({ calendarId: primary.id, counted: true });
    await vi.waitFor(async () => expect(await titles(core)).toEqual(["Standup"]));
  });

  test("disconnecting forgets the sign-in and the events, ends Google's session, and leaves the Notes", async () => {
    const { core, fake } = await setUp({ google: googleAccount() });
    const account = await core.connectCalendar("google");
    const [event] = await core.listCalendarEvents(DAY);
    const { mindId } = await core.takeEventNotes(event?.id ?? "");

    const state = await core.disconnectCalendar(account?.id ?? "");
    expect(state.accounts).toEqual([]);
    expect(fake.google.revoked).toHaveLength(1);
    expect(await core.listCalendarEvents(DAY)).toEqual([]);
    expect((await core.listMinds()).some((mind) => mind.id === mindId)).toBe(true);
    expect(await core.getNoteEvent(mindId)).toMatchObject({ eventId: null, title: "Standup" });
  });

  test("connecting the same account again keeps its calendars and choices", async () => {
    const { core } = await setUp({ google: googleAccount() });
    const first = await core.connectCalendar("google");
    const again = await core.connectCalendar("google");
    expect(again?.id).toBe(first?.id);
    expect((await core.getCalendars()).accounts).toHaveLength(1);
  });

  test("a sign-in the User cancels connects nothing; one they decline says so", async () => {
    const { core, browser } = await setUp({ google: googleAccount() });
    browser.behaviour = "ignore";
    const waiting = core.connectCalendar("google");
    await vi.waitFor(async () => expect((await core.getCalendars()).signingIn).toBe("google"));
    await core.cancelCalendarSignIn();
    expect(await waiting).toBeNull();

    browser.behaviour = "decline";
    await expect(core.connectCalendar("google")).rejects.toThrow(
      "Couldn’t connect Google Calendar",
    );
    expect((await core.getCalendars()).accounts).toEqual([]);
  });
});

describe("Calendars: consent, Local mode and being offline (#190)", () => {
  test("background reading never asks: with the flow turned off nothing is sent, not even a renewal, and the row says so", async () => {
    const { core, fake, clock } = await setUp({ google: googleAccount() });
    await core.connectCalendar("google");
    const asked = vi.fn();
    core.on("consent.requested", asked);
    await core.revokeConsent("calendars", new URL(fake.origin).origin);
    const requests = fake.google.requests.length;
    const tokenRequests = fake.google.tokenRequests.length;
    // Three hours on, the access token has expired: a read would renew it first.
    clock.advance(3 * 60 * 60_000);

    const state = await core.syncCalendars();
    expect(accountOf(state, "google")?.problem).toBe("not-allowed");
    expect(fake.google.requests.length).toBe(requests);
    expect(fake.google.tokenRequests.length).toBe(tokenRequests);
    expect(asked).not.toHaveBeenCalled();
    expect(await titles(core)).toEqual(["Standup"]);

    await core.allowDataFlow("calendars", new URL(fake.origin).origin);
    expect(accountOf(await core.syncCalendars(), "google")?.problem).toBeNull();
    // Allowed again, the same read renews the sign-in first.
    expect(fake.google.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
  });

  test("Local mode stops Google and Microsoft and keeps the Mac's calendar", async () => {
    const mac: SystemCalendarFixture = {
      access: "allowed",
      calendars: [{ id: "home", title: "Home", source: "iCloud", kind: "caldav" }],
      events: [],
    };
    const { core, fake, system } = await setUp({ google: googleAccount(), mac });
    await core.connectCalendar("google");
    await core.connectCalendar("mac");
    await core.setLocalOnly(true);
    const requests = fake.google.requests.length;
    system.fixture.events.push({
      calendarId: "home",
      id: "dentist",
      externalId: "dentist@icloud",
      occurrence: null,
      title: "Dentist",
      start: "2026-11-09T15:00:00Z",
      end: "2026-11-09T15:30:00Z",
      allDay: false,
      status: "confirmed",
      attendees: [],
      organizer: null,
      url: null,
      location: null,
      notes: null,
    });

    const state = await core.syncCalendars();
    expect(accountOf(state, "google")?.problem).toBe("local-mode");
    expect(accountOf(state, "mac")?.problem).toBeNull();
    expect(fake.google.requests.length).toBe(requests);
    expect(await titles(core)).toEqual(["Standup", "Dentist"]);
    await expect(core.connectCalendar("microsoft")).rejects.toThrow(
      "Keep everything on this computer",
    );

    await core.setLocalOnly(false);
    await vi.waitFor(async () =>
      expect(accountOf(await core.getCalendars(), "google")?.problem).toBeNull(),
    );
  });

  test("offline, the events read stay and the row says so; it tries again by itself after a wait", async () => {
    const { core, fake } = await setUp({
      google: googleAccount(),
      adapters: { calendarSync: { retryMs: [50] } },
    });
    await core.connectCalendar("google");
    fake.offline = true;
    const state = await core.syncCalendars();
    expect(accountOf(state, "google")?.problem).toBe("offline");
    expect(await titles(core)).toEqual(["Standup"]);

    fake.offline = false;
    await vi.waitFor(async () =>
      expect(accountOf(await core.getCalendars(), "google")?.problem).toBeNull(),
    );
  });

  test("a service that keeps failing is asked less and less often", async () => {
    const { core, fake } = await setUp({
      google: googleAccount(),
      adapters: { calendarSync: { retryMs: [40, 400] } },
    });
    await core.connectCalendar("google");
    fake.google.failing = 503;
    await core.syncCalendars();
    const failed = () => fake.google.requests.filter((each) => each.path.endsWith("calendarList"));
    const before = failed().length;
    await vi.waitFor(() => expect(failed().length).toBe(before + 1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(failed().length).toBe(before + 1);
    expect(accountOf(await core.getCalendars(), "google")?.problem).toBe("offline");
  });
});

describe("Calendars: the Mac's own calendar (#190)", () => {
  const mac = (fixture: Partial<SystemCalendarFixture> = {}): SystemCalendarFixture => ({
    access: "allowed",
    calendars: [
      { id: "work", title: "Work", source: "Exchange", kind: "exchange" },
      { id: "feishu", title: "飞书日历", source: "CalDAV", kind: "caldav" },
      { id: "birthdays", title: "Birthdays", source: "Other", kind: "birthday" },
      { id: "holidays", title: "UK Holidays", source: "Subscribed", kind: "subscription" },
    ],
    events: [
      {
        calendarId: "work",
        id: "ev-1",
        externalId: "board@contoso",
        occurrence: null,
        title: "Board meeting",
        start: "2026-11-10T09:00:00Z",
        end: "2026-11-10T11:00:00Z",
        allDay: false,
        status: "confirmed",
        attendees: [
          { name: "Me", email: "priya@contoso.com", self: true, status: "accepted" },
          { name: "Tom Berg", email: "tom@contoso.com", self: false, status: "accepted" },
        ],
        organizer: { name: "Tom Berg", email: "tom@contoso.com", self: false, status: "accepted" },
        url: null,
        location: "Room 4 · https://contoso.zoom.us/j/123456789",
        notes: null,
      },
      {
        calendarId: "feishu",
        id: "ev-2",
        externalId: "weekly@feishu",
        occurrence: "2026-11-09T06:00:00Z",
        title: "周会",
        start: "2026-11-09T06:00:00Z",
        end: "2026-11-09T07:00:00Z",
        allDay: false,
        status: "confirmed",
        attendees: [],
        organizer: null,
        url: "https://vc.feishu.cn/j/123456789",
        location: null,
        notes: null,
      },
    ],
    ...fixture,
  });

  test("the system is asked for access only when the User connects it; refused, the account stays to say how to allow it", async () => {
    const { core, system } = await setUp({ mac: mac({ access: "not-asked", answer: "denied" }) });
    expect(system.asked).toBe(0);

    const account = await core.connectCalendar("mac");
    expect(system.asked).toBe(1);
    expect(account).toMatchObject({ service: "mac", problem: "denied", calendars: [] });

    // Background reads never ask again.
    await core.syncCalendars();
    expect(system.asked).toBe(1);
    await core.openCalendarSettings();
    expect(system.settingsOpened).toBe(1);

    // Allowed in System Settings: the next read finds the calendars.
    system.fixture.access = "allowed";
    const state = await core.syncCalendars();
    expect(accountOf(state, "mac")?.problem).toBeNull();
    expect(system.asked).toBe(1);
  });

  test("its own calendars count, subscribed and birthday ones don't, and a call's link is found in the place", async () => {
    const { core } = await setUp({ mac: mac() });
    const account = await core.connectCalendar("mac");
    expect(
      account?.calendars.map((calendar) => [calendar.name, calendar.group, calendar.counted]),
    ).toEqual([
      ["Work", "Exchange", true],
      ["飞书日历", "CalDAV", true],
      ["Birthdays", "Other", false],
      ["UK Holidays", "Subscribed", false],
    ]);
    const events = await core.listCalendarEvents(DAY);
    expect(events.map((event) => [event.title, event.joinUrl])).toEqual([
      ["周会", "https://vc.feishu.cn/j/123456789"],
      ["Board meeting", "https://contoso.zoom.us/j/123456789"],
    ]);
  });

  test("a Mac calendar connected before is read at the next start without asking", async () => {
    const dataDir = await createTempDataFolder();
    const fake = await createFakeCalendars();
    onTestFinished(() => fake.close());
    const first = await setUp({ dataDir, fake, mac: mac() });
    await first.core.connectCalendar("mac");
    first.core.close();

    const second = await setUp({ dataDir, fake, mac: mac() });
    await vi.waitFor(async () =>
      expect(await titles(second.core)).toEqual(["周会", "Board meeting"]),
    );
    expect(second.system.asked).toBe(0);
  });

  test("the same invite in two calendars shows once, the one with the call's link", async () => {
    const { core } = await setUp({
      google: googleAccount([
        {
          id: "board-g",
          uid: "board@contoso",
          title: "Board meeting",
          start: "2026-11-10T09:00:00Z",
          end: "2026-11-10T11:00:00Z",
        },
        {
          id: "lunch-g",
          title: "Lunch with Ana",
          start: "2026-11-09T12:00:00Z",
          end: "2026-11-09T13:00:00Z",
          joinUrl: "https://meet.google.com/lun-chwi-tha",
        },
      ]),
      mac: mac({
        events: [
          ...mac().events,
          {
            calendarId: "work",
            id: "ev-3",
            externalId: "another-uid",
            occurrence: null,
            title: "Lunch with Ana",
            start: "2026-11-09T12:00:00Z",
            end: "2026-11-09T13:00:00Z",
            allDay: false,
            status: "confirmed",
            attendees: [],
            organizer: null,
            url: null,
            location: null,
            notes: null,
          },
        ],
      }),
    });
    await core.connectCalendar("google");
    await core.connectCalendar("mac");
    const events = await core.listCalendarEvents(DAY);
    expect(events.map((event) => [event.title, event.service, event.joinUrl])).toEqual([
      ["周会", "mac", "https://vc.feishu.cn/j/123456789"],
      ["Lunch with Ana", "google", "https://meet.google.com/lun-chwi-tha"],
      ["Board meeting", "mac", "https://contoso.zoom.us/j/123456789"],
    ]);
  });
});

describe("Calendars: what is kept, and for how long (#190)", () => {
  const eventRows = (dataDir: string) =>
    queryDatabase<{ title: string; attendees: string }>(
      dataDir,
      "SELECT title, attendees FROM calendar_events",
    );

  test("an event that ends before yesterday is deleted, not kept as a deleted row", async () => {
    const { core, dataDir, clock } = await setUp({ google: googleAccount() });
    await core.connectCalendar("google");
    expect(eventRows(dataDir).map((row) => row.title)).toEqual(["Standup"]);

    clock.advance(3 * 24 * 60 * 60_000);
    await core.syncCalendars();
    expect(eventRows(dataDir)).toEqual([]);
  });

  test("disconnecting deletes the account's calendars and events outright", async () => {
    const { core, dataDir } = await setUp({ google: googleAccount() });
    const account = await core.connectCalendar("google");
    await core.disconnectCalendar(account?.id ?? "");
    expect(eventRows(dataDir)).toEqual([]);
    expect(queryDatabase(dataDir, "SELECT id FROM calendars")).toEqual([]);
    expect(queryDatabase(dataDir, "SELECT id FROM calendar_accounts")).toEqual([]);
  });

  test("disconnecting in Local mode sends nothing: the sign-in is forgotten here", async () => {
    const { core, fake } = await setUp({ google: googleAccount() });
    const account = await core.connectCalendar("google");
    await core.setLocalOnly(true);
    await core.disconnectCalendar(account?.id ?? "");
    expect(fake.google.revoked).toEqual([]);
    expect((await core.getCalendars()).accounts).toEqual([]);
  });

  test("deleting the Note permanently deletes the event's details it kept", async () => {
    const { core, dataDir } = await setUp({ google: googleAccount() });
    await core.connectCalendar("google");
    const [event] = await core.listCalendarEvents(DAY);
    const { mindId } = await core.takeEventNotes(event?.id ?? "");
    await core.deleteMind(mindId);
    await core.deletePermanently([{ kind: "mind", id: mindId }]);
    const kept = queryDatabase<{ event: string; deleted_at: string | null }>(
      dataDir,
      "SELECT event, deleted_at FROM calendar_event_notes WHERE mind_id = ?",
      [mindId],
    );
    expect(kept).toEqual([{ event: "{}", deleted_at: expect.any(String) }]);
    expect(JSON.stringify(kept)).not.toContain("dana@northwind.com");
  });

  test("an invite's title names its Note as one line of at most 200 characters", async () => {
    const { core } = await setUp({
      google: googleAccount([
        {
          ...standup,
          title: `Quarterly\nreview\u202e with\tNorthwind ${"x".repeat(300)}`,
        },
      ]),
    });
    await core.connectCalendar("google");
    const [event] = await core.listCalendarEvents(DAY);
    const { mindId } = await core.takeEventNotes(event?.id ?? "");
    const title = (await core.listMinds()).find((mind) => mind.id === mindId)?.title ?? "";
    expect(title.startsWith("Quarterly review with Northwind x")).toBe(true);
    expect([...title]).toHaveLength(200);
  });

  test("Take notes on either copy of one invite opens the same Note", async () => {
    const lunch = {
      title: "Lunch with Ana",
      start: "2026-11-09T12:00:00Z",
      end: "2026-11-09T13:00:00Z",
    };
    const { core } = await setUp({
      google: googleAccount([{ id: "lunch-g", ...lunch, joinUrl: "https://meet.google.com/lun" }]),
      mac: {
        access: "allowed",
        calendars: [{ id: "work", title: "Work", source: "Exchange", kind: "exchange" }],
        events: [
          {
            calendarId: "work",
            id: "lunch-m",
            externalId: "another-uid",
            occurrence: null,
            ...lunch,
            allDay: false,
            status: "confirmed",
            attendees: [],
            organizer: null,
            url: null,
            location: null,
            notes: null,
          },
        ],
      },
    });
    await core.connectCalendar("mac");
    const [macCopy] = await core.listCalendarEvents(DAY);
    const first = await core.takeEventNotes(macCopy?.id ?? "");

    await core.connectCalendar("google");
    const [shown] = await core.listCalendarEvents(DAY);
    expect(shown).toMatchObject({ service: "google", mindId: first.mindId });
    expect(await core.takeEventNotes(shown?.id ?? "")).toEqual({
      mindId: first.mindId,
      created: false,
    });
    expect(await core.getNoteEvent(first.mindId)).toMatchObject({
      eventId: shown?.id,
      joinUrl: "https://meet.google.com/lun",
    });
  });
});

/** Whether this computer can listen on IPv6's loopback. */
const hasIpv6Loopback = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

test.skipIf(!hasIpv6Loopback)(
  "Microsoft's sign-in comes back when the browser reaches localhost over IPv6",
  async () => {
    const { core, browser } = await setUp({
      microsoft: { email: "priya@contoso.com", name: "Priya Raman", calendars: [] },
    });
    browser.localhost = "[::1]";
    const account = await core.connectCalendar("microsoft");
    expect(await browser.visits[0]).toBe(200);
    expect(account).toMatchObject({ service: "microsoft", name: "priya@contoso.com" });
  },
);
