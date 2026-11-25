import { afterEach, describe, expect, test, vi } from "vitest";
import { silentLogger } from "../../src/core/activityLog";
import type { SystemCalendarEvent } from "../../src/core/adapters";
import { createFakeSystemCalendar } from "../../src/core/calendars/fakeSystem";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { createMeetingOffers } from "../../src/core/meetings/offers";
import { createFakeCallWatcher } from "../../src/main/calls/fakeWatcher";
import { createFileLoginItem } from "../../src/main/loginItem";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";

const now = Date.parse("2026-10-06T09:00:00Z");
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const start = 120_000;
const lead = 60_000;

function event(id: string, extra: Partial<SystemCalendarEvent> = {}): SystemCalendarEvent {
  return {
    calendarId: "work",
    id,
    externalId: id,
    occurrence: null,
    title: id,
    start: iso(start),
    end: iso(start + 30 * 60_000),
    status: "confirmed",
    allDay: false,
    organizer: null,
    attendees: [
      { name: "Me", email: "me@example.test", self: true, status: "accepted" },
      { name: "Lee", email: "lee@example.test", self: false, status: "accepted" },
    ],
    url: "https://meet.google.com/aaa-bbbb-ccc",
    notes: null,
    location: null,
    ...extra,
  };
}

/** `firstByHand`: a first recording is made by hand, as the offers wait for, instead of set as made. */
async function setup(events: SystemCalendarEvent[], enabled = true, firstByHand = false) {
  const clock = manualClock(iso(0));
  const system = createFakeSystemCalendar({
    access: "allowed",
    calendars: [{ id: "work", title: "Work", source: "Exchange", kind: "exchange" }],
    events,
  });
  const calls = createFakeCallWatcher();
  const dataDir = await createTempDataFolder();
  const open = vi.fn(async (_url: string) => {});
  const reopen = () =>
    startCore(dataDir, {
      now: clock.now,
      audioCapture: createFakeCapture({ now: () => clock.now().getTime() }),
      systemCalendar: system,
      callWatcher: calls,
      browser: { open },
      loginItem: createFileLoginItem(dataDir),
    });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const core = reopen();
  await vi.advanceTimersByTimeAsync(0);
  if (firstByHand) {
    const byHand = await core.createMeeting();
    await core.startMeeting({ meetingId: byHand.id });
    await core.stopMeeting(byHand.id);
    await core.updateSettings({ device: { calendarOffers: enabled } });
  } else {
    await core.updateSettings({
      device: { meetingNoticeAccepted: true, callOffers: true, calendarOffers: enabled },
    });
  }
  const account = await core.connectCalendar("mac");
  const advance = (ms: number) => {
    clock.advance(ms);
    vi.advanceTimersByTime(ms);
  };
  return { core, account, system, advance, clock, calls, open, reopen };
}

afterEach(() => vi.useRealTimers());

describe("Scheduled offers to take notes", () => {
  test("only group events on counted calendars are offered, once, a minute before the start", async () => {
    const group = event("Design review");
    const { core, advance, open, reopen } = await setup([
      event("Focus time", { attendees: group.attendees.slice(0, 1), start: iso(start - 5000) }),
      group,
    ]);
    advance(start - lead - 1);
    expect((await core.getMeetingOffers()).offer).toBeNull();
    advance(1);
    const first = (await core.getMeetingOffers()).offer;
    expect(first).toMatchObject({ kind: "calendar", title: group.title, startsAt: group.start });
    if (!first) throw new Error("Missing reminder.");
    await core.syncCalendars();
    expect((await core.getMeetingOffers()).offer?.id).toBe(first.id);
    await core.declineMeetingOffer({ offerId: first.id, always: true });
    expect((await core.getSettings()).device.calendarOffers).toBe(true);
    expect((await core.getMeetingOffers()).offer).toBeNull();

    core.close();
    const restarted = reopen();
    await restarted.syncCalendars();
    expect((await restarted.getMeetingOffers()).offer).toBeNull();
    advance(lead + 1);
    expect((await restarted.getMeetingOffers()).offer).toBeNull();
    expect(await restarted.listMeetings()).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  test("the calendar switch acts independently of call detection and can enable a reminder still due", async () => {
    const { core, calls, advance } = await setup([event("Workshop")], false);
    await core.updateSettings({ device: { callOffers: false } });
    advance(start - lead + 1000);
    expect((await core.getMeetingOffers()).offer).toBeNull();
    await core.updateSettings({ device: { calendarOffers: true } });
    expect((await core.getMeetingOffers()).offer).toMatchObject({
      kind: "calendar",
      title: "Workshop",
    });
    expect(calls.watching()).toBe(false);
    expect(await core.listMeetings()).toEqual([]);
  });

  test("only a click opens the current invite and records in its existing Note, even just after the start", async () => {
    const group = event("Check-in");
    const { core, advance, open } = await setup([group]);
    const [calendarEvent] = await core.listCalendarEvents({ from: iso(0), to: iso(start + 1) });
    if (!calendarEvent) throw new Error("Missing event.");
    const { mindId } = await core.takeEventNotes(calendarEvent.id);
    const ready = await core.createMeeting({ mindId });
    advance(start - lead);
    const offer = (await core.getMeetingOffers()).offer;
    if (!offer) throw new Error("Missing reminder.");
    advance(lead + 1000);
    expect(open).not.toHaveBeenCalled();
    expect((await core.listMeetings()).every((meeting) => meeting.status === "ready")).toBe(true);
    const meeting = await core.takeMeetingOffer(offer.id);
    expect(meeting).toMatchObject({ status: "recording", id: ready.id, mindId });
    expect(open).toHaveBeenCalledExactlyOnceWith(group.url);
    expect(
      (await core.getLayout("main")).groups.flatMap((g) => g.tabs).map((tab) => tab.item),
    ).toContainEqual({ kind: "mind", mindId });
    expect((await core.getMeetingOffers()).offer).toBeNull();
  });

  test("a meeting already recorded by hand in the invite's Note gets no reminder", async () => {
    const { core, advance, open } = await setup([event("Workshop")]);
    const [invite] = await core.listCalendarEvents({ from: iso(0), to: iso(start + 1) });
    if (!invite) throw new Error("Missing invite.");
    const { mindId } = await core.takeEventNotes(invite.id);
    const ready = await core.createMeeting({ mindId });
    await core.startMeeting({ meetingId: ready.id });
    await core.stopMeeting(ready.id);
    advance(start - lead);
    expect((await core.getMeetingOffers()).offer).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  // protects=with no recording notice to read, a calendar reminder taken after a first recording records at once in the invite's Note and opens its link, refusing nothing and turning nothing else on: no setting changes and the login item stays as it was (#3762); fails_when=the reminder's Take notes is refused for a notice, or turns on keeping running, calls or opening at login
  test("after a first recording, a reminder taken records at once and turns nothing else on", async () => {
    const group = event("Planning");
    const { core, advance, open } = await setup([group], true, true);
    const before = await core.getSettings();
    expect(before.device).toMatchObject({ meetingNoticeAccepted: true, calendarOffers: true });
    const loginBefore = await core.getOpenAtLogin();
    expect(loginBefore.supported).toBe(true);
    advance(start - lead);
    const offer = (await core.getMeetingOffers()).offer;
    if (offer?.kind !== "calendar") throw new Error("Missing reminder.");
    const meeting = await core.takeMeetingOffer(offer.id);
    expect(meeting).toMatchObject({ status: "recording", kind: "meeting" });
    expect(open).toHaveBeenCalledExactlyOnceWith(group.url);
    expect(await core.getSettings()).toEqual(before);
    expect(await core.getOpenAtLogin()).toEqual(loginBefore);
  });

  test("an in-person invitation opens and records without opening a browser", async () => {
    const { core, advance, open } = await setup([event("Workshop", { url: null })]);
    advance(start - lead);
    const offer = (await core.getMeetingOffers()).offer;
    if (!offer) throw new Error("Missing reminder.");
    const meeting = await core.takeMeetingOffer(offer.id);
    expect(meeting.status).toBe("recording");
    expect(open).not.toHaveBeenCalled();
  });

  test("a later copy keeps the same active reminder after the first calendar is uncounted and remembers it across restart", async () => {
    const first = event("Planning", { externalId: "primary-invite" });
    const { core, system, advance, reopen } = await setup([first]);
    advance(start - lead);
    const original = (await core.getMeetingOffers()).offer;
    if (original?.kind !== "calendar") throw new Error("Missing reminder.");
    system.fixture.calendars.push({
      id: "shared",
      title: "Shared",
      source: "Exchange",
      kind: "exchange",
    });
    system.fixture.events.push({
      ...first,
      calendarId: "shared",
      externalId: "primary-invite",
      id: "copy",
    });
    const state = await core.syncCalendars();
    expect(state.accounts[0]?.problem).toBeNull();
    expect(
      state.accounts[0]?.calendars.find((calendar) => calendar.name === "Shared")?.counted,
    ).toBe(true);
    expect((await core.getMeetingOffers()).offer?.id).toBe(original.id);
    const firstCalendar = state.accounts[0]?.calendars.find((calendar) => calendar.name === "Work");
    if (!firstCalendar) throw new Error("Missing calendar.");
    await core.setCalendarCounted({ calendarId: firstCalendar.id, counted: false });
    const [remainingInvite] = await core.listCalendarEvents({ from: iso(0), to: iso(start + 1) });
    expect(remainingInvite?.title).toBe(first.title);
    const replacement = (await core.getMeetingOffers()).offer;
    expect(replacement).toMatchObject({ kind: "calendar", id: original.id, title: first.title });
    if (replacement?.kind !== "calendar") throw new Error("Missing copy.");
    expect(replacement.eventId).not.toBe(original.eventId);
    core.close();
    const restarted = reopen();
    await restarted.syncCalendars();
    expect((await restarted.getMeetingOffers()).offer).toBeNull();
    expect(await restarted.listMeetings()).toEqual([]);
  });

  test("identical titles and times cannot retarget a cancelled invitation's button to another room", async () => {
    const first = event("review-a", { title: "Project review" });
    const other = event("review-b", {
      title: first.title,
      url: "https://meet.google.com/bbb-cccc-ddd",
    });
    const { core, system, advance, open } = await setup([first, other]);
    advance(start - lead);
    const offered = (await core.getMeetingOffers()).offer;
    if (!offered) throw new Error("Missing reminder.");
    await core.syncCalendars();
    expect((await core.getMeetingOffers()).offer?.id).toBe(offered.id);
    system.fixture.events = [{ ...first, status: "cancelled" }, other];
    await core.syncCalendars();
    const remaining = (await core.getMeetingOffers()).offer;
    if (!remaining) throw new Error("Missing other invitation.");
    expect(remaining.id).not.toBe(offered.id);
    await expect(core.takeMeetingOffer(offered.id)).rejects.toThrow();
    expect(await core.listMeetings()).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    await core.takeMeetingOffer(remaining.id);
    expect(open).toHaveBeenCalledExactlyOnceWith(other.url);
  });

  test("a second distinct deadline issues its own reminder and never reoffers the earlier invitation", async () => {
    const { core, advance } = await setup([
      event("First meeting"),
      event("Second meeting", { start: iso(start + 20_000) }),
    ]);
    advance(start - lead);
    const first = (await core.getMeetingOffers()).offer;
    expect(first).toMatchObject({ title: "First meeting" });
    advance(19_999);
    expect((await core.getMeetingOffers()).offer?.id).toBe(first?.id);
    advance(1);
    const second = (await core.getMeetingOffers()).offer;
    expect(second).toMatchObject({ title: "Second meeting" });
    if (!first || !second) throw new Error("Missing reminders.");
    await expect(core.takeMeetingOffer(first.id)).rejects.toThrow();
    await core.declineMeetingOffer({ offerId: second.id, always: false });
    expect((await core.getMeetingOffers()).offer).toBeNull();
  });

  test("invites due at the same instant stay selectable until the first is dismissed", async () => {
    const { core, advance } = await setup([event("First meeting"), event("Second meeting")]);
    advance(start - lead);
    const first = (await core.getMeetingOffers()).offer;
    expect(first).toMatchObject({ title: "First meeting" });
    if (!first) throw new Error("Missing reminder.");
    await core.syncCalendars();
    expect((await core.getMeetingOffers()).offer?.id).toBe(first.id);
    await core.declineMeetingOffer({ offerId: first.id, always: false });
    expect((await core.getMeetingOffers()).offer).toMatchObject({ title: "Second meeting" });
  });

  test("a changed time invalidates the old button and cancelling revokes the replacement", async () => {
    const group = event("Check-in");
    const { core, system, advance, open } = await setup([group]);
    advance(start - lead);
    const original = (await core.getMeetingOffers()).offer;
    if (!original) throw new Error("Missing reminder.");
    system.fixture.events = [{ ...group, start: iso(start + 120_000) }];
    await core.syncCalendars();
    expect((await core.getMeetingOffers()).offer).toBeNull();
    await expect(core.takeMeetingOffer(original.id)).rejects.toThrow();
    advance(120_000);
    const replacement = (await core.getMeetingOffers()).offer;
    expect(replacement).toMatchObject({ kind: "calendar", startsAt: iso(start + 120_000) });
    if (!replacement) throw new Error("Missing rescheduled reminder.");
    expect(replacement.id).not.toBe(original.id);
    system.fixture.events = [{ ...group, status: "cancelled" }];
    await core.syncCalendars();
    await expect(core.takeMeetingOffer(replacement.id)).rejects.toThrow();
    expect((await core.getMeetingOffers()).offer).toBeNull();
    expect(await core.listMeetings()).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  test.each([20_000, 8 * 60_000])(
    "accepting after sleep checks the real time against both the event end and five-minute grace (%i ms meeting)",
    async (length) => {
      const { core, clock, advance, open } = await setup([
        event("Check-in", { end: iso(start + length) }),
      ]);
      advance(start - lead);
      const offer = (await core.getMeetingOffers()).offer;
      if (!offer) throw new Error("Missing reminder.");
      clock.advance(lead + Math.min(length, 5 * 60_000));
      await expect(core.takeMeetingOffer(offer.id)).rejects.toThrow();
      expect(await core.listMeetings()).toEqual([]);
      expect(open).not.toHaveBeenCalled();
    },
  );

  test("an overdue timer after sleep never delivers a reminder for a meeting that has started", async () => {
    const { core, advance, open } = await setup([event("Check-in")]);
    advance(start);
    expect((await core.getMeetingOffers()).offer).toBeNull();
    expect(await core.listMeetings()).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  test("a due event takes precedence over a detected call and disabling reminders restores only the live call", async () => {
    const { core, calls, advance, open } = await setup([event("Check-in")]);
    calls.use(["teams"]);
    const call = (await core.getMeetingOffers()).offer;
    expect(call).toMatchObject({ kind: "call", app: "teams" });
    if (!call) throw new Error("Missing call.");
    advance(start - lead);
    const schedule = (await core.getMeetingOffers()).offer;
    expect(schedule).toMatchObject({ kind: "calendar", title: "Check-in" });
    if (!schedule) throw new Error("Missing reminder.");
    await expect(core.takeMeetingOffer(call.id)).rejects.toThrow();
    await core.updateSettings({ device: { calendarOffers: false } });
    await expect(core.takeMeetingOffer(schedule.id)).rejects.toThrow();
    const live = (await core.getMeetingOffers()).offer;
    expect(live).toMatchObject({ kind: "call", app: "teams" });
    expect(live?.id).not.toBe(call.id);
    await expect(core.takeMeetingOffer(call.id)).rejects.toThrow();
    await core.updateSettings({ device: { calendarOffers: true } });
    expect((await core.getMeetingOffers()).offer?.id).toBe(live?.id);
    expect(await core.listMeetings()).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  test("a stale call notification cannot turn off its app when a calendar reminder is now due", async () => {
    const { core, clock, calls } = await setup([event("Check-in")]);
    calls.use(["zoom"]);
    const call = (await core.getMeetingOffers()).offer;
    if (!call) throw new Error("Missing call.");
    clock.advance(start - lead);
    await core.declineMeetingOffer({ offerId: call.id, always: true });
    expect((await core.getSettings()).device.callOffersOff).toEqual([]);
    expect((await core.getMeetingOffers()).offer).toMatchObject({ kind: "calendar" });
  });

  test("dismissing a calendar reminder reveals a different app still using the microphone", async () => {
    const { core, calls, advance } = await setup([event("Check-in")]);
    calls.use(["zoom"]);
    advance(start - lead);
    const reminder = (await core.getMeetingOffers()).offer;
    if (!reminder) throw new Error("Missing reminder.");
    calls.use(["teams"]);
    await core.declineMeetingOffer({ offerId: reminder.id, always: false });
    expect((await core.getMeetingOffers()).offer).toMatchObject({ kind: "call", app: "teams" });
    expect(await core.listMeetings()).toEqual([]);
  });

  test("revoking system calendar access retracts the reminder and its action", async () => {
    const { core, system, advance, open } = await setup([event("Check-in")]);
    advance(start - lead);
    const offered = (await core.getMeetingOffers()).offer;
    if (!offered) throw new Error("Missing reminder.");
    system.fixture.access = "denied";
    await core.syncCalendars();
    expect((await core.getMeetingOffers()).offer).toBeNull();
    await expect(core.takeMeetingOffer(offered.id)).rejects.toThrow();
    expect(await core.listMeetings()).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  test("uncounting a calendar immediately removes its open offer without reviving an ended call", async () => {
    const { core, account, calls, advance } = await setup([event("Check-in")]);
    advance(start - lead);
    const reminder = (await core.getMeetingOffers()).offer;
    if (!reminder) throw new Error("Missing reminder.");
    calls.use(["zoom"]);
    calls.use([]);
    const calendar = account?.calendars[0];
    if (!calendar) throw new Error("Missing calendar.");
    await core.setCalendarCounted({ calendarId: calendar.id, counted: false });
    expect((await core.getMeetingOffers()).offer).toBeNull();
    await expect(core.takeMeetingOffer(reminder.id)).rejects.toThrow();
  });
});

test("a sleeping calendar has no polling timer and an upcoming group event uses one deadline", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const row = {
    id: "event",
    ids: ["event"],
    occurrenceKey: "event",
    title: "Workshop",
    startsAt: iso(start),
    endsAt: iso(start + 60_000),
    seen: false,
  };
  const rows = vi.fn<() => (typeof row)[]>().mockReturnValue([]);
  const allowed = vi.fn(() => false);
  const busy = vi.fn(() => false);
  const calls = createFakeCallWatcher();
  const offers = createMeetingOffers({
    calendarAllowed: allowed,
    calendarEvents: rows,
    markCalendarReminderSeen: vi.fn(),
    now: () => new Date(now),
    newId: () => "offer",
    watcher: calls,
    watching: () => true,
    allowed: () => true,
    busy,
    live: () => false,
    record: () => "call",
    recordCalendar: () => ({ meetingId: "calendar", joinUrl: null }),
    stop: vi.fn(),
    changed: vi.fn(),
    log: silentLogger,
  });
  offers.refresh();
  expect(calls.watching()).toBe(true);
  expect(rows).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  allowed.mockReturnValue(true);
  offers.refresh();
  expect(vi.getTimerCount()).toBe(0);
  rows.mockReturnValue([row]);
  offers.refresh();
  offers.refresh();
  expect(vi.getTimerCount()).toBe(1);
  busy.mockReturnValue(true);
  offers.refresh();
  expect(vi.getTimerCount()).toBe(0);
  busy.mockReturnValue(false);
  offers.refresh();
  offers.close();
  offers.refresh();
  expect(calls.watching()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
