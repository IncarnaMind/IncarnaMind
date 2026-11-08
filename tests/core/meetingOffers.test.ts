import { afterEach, describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { offerAllowed } from "../../src/core/meetings/offers";
import { createFakeCallWatcher } from "../../src/main/calls/fakeWatcher";
import { createFileLoginItem } from "../../src/main/loginItem";
import { createTempDataFolder, manualClock, nextTurn, startCore } from "../helpers/core";

/*
 * Offers to take notes (#189, #208): the switches in Settings › General, an offer when a call app
 * takes the microphone, only Take notes recording, and the 30-second stop once the call app lets
 * go of it.
 */

async function offersCore({ setUp = true } = {}) {
  const dataDir = await createTempDataFolder();
  const clock = manualClock();
  const calls = createFakeCallWatcher();
  const capture = createFakeCapture({ now: () => clock.now().getTime() });
  const core = startCore(dataDir, { audioCapture: capture, now: clock.now, callWatcher: calls });
  if (setUp) await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  return { core, calls, clock, dataDir };
}

const recorded = async (core: Core) =>
  (await core.listMeetings()).filter((each) => each.status !== "ready");

afterEach(() => {
  vi.useRealTimers();
});

describe("The switches for offers", () => {
  test("are kept, and the offers read them back: calendar meetings, calls, and one app at a time", async () => {
    const { core } = await offersCore();
    expect((await core.getSettings()).device).toMatchObject({
      keepRunning: false,
      calendarOffers: true,
      callOffers: true,
      callOffersOff: [],
    });

    await core.updateSettings({
      device: { calendarOffers: false, callOffersOff: ["zoom"], keepRunning: true },
    });
    const { device } = await core.getSettings();
    expect(device).toMatchObject({
      calendarOffers: false,
      callOffersOff: ["zoom"],
      keepRunning: true,
    });
    expect(offerAllowed(device, { kind: "calendar" })).toBe(false);
    expect(offerAllowed(device, { kind: "call", app: "zoom" })).toBe(false);
    expect(offerAllowed(device, { kind: "call", app: "teams" })).toBe(true);

    await core.updateSettings({ device: { callOffers: false } });
    expect(offerAllowed((await core.getSettings()).device, { kind: "call", app: "teams" })).toBe(
      false,
    );
    await expect(
      core.updateSettings({ device: { callOffersOff: ["not-an-app"] } }),
    ).rejects.toThrow();
  });

  test("offer nothing before Meetings are set up", async () => {
    const { core, calls } = await offersCore({ setUp: false });
    expect(calls.watching()).toBe(false);
    expect(offerAllowed((await core.getSettings()).device, { kind: "call", app: "zoom" })).toBe(
      false,
    );
    await core.updateSettings({ device: { meetingNoticeAccepted: true } });
    expect(calls.watching()).toBe(true);
  });
});

describe("An offer when a call app takes the microphone", () => {
  test("names the app; ignored, it records nothing and goes once the call is over", async () => {
    const { core, calls } = await offersCore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    calls.use(["zoom"]);
    const { offer } = await core.getMeetingOffers();
    expect(offer).toMatchObject({ app: "zoom" });

    // A moment's let-go, a device switch, is the same call: the same offer stays.
    calls.use([]);
    vi.advanceTimersByTime(4000);
    calls.use(["zoom"]);
    expect((await core.getMeetingOffers()).offer?.id).toBe(offer?.id);

    calls.use([]);
    vi.advanceTimersByTime(10_000);
    expect((await core.getMeetingOffers()).offer).toBeNull();
    expect(await core.listMeetings()).toEqual([]);
  });

  test("Not now records nothing and doesn't ask again in the same call; the next call asks", async () => {
    const { core, calls } = await offersCore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    calls.use(["teams"]);
    const first = (await core.getMeetingOffers()).offer;
    if (!first) throw new Error("No offer.");
    await core.declineMeetingOffer({ offerId: first.id, always: false });
    expect((await core.getMeetingOffers()).offer).toBeNull();

    calls.use([]);
    vi.advanceTimersByTime(2000);
    calls.use(["teams"]);
    expect((await core.getMeetingOffers()).offer).toBeNull();

    calls.use([]);
    vi.advanceTimersByTime(10_000);
    calls.use(["teams"]);
    expect((await core.getMeetingOffers()).offer).toMatchObject({ app: "teams" });
    expect(await core.listMeetings()).toEqual([]);
  });

  test("“Don't ask for Slack” turns Slack off in Settings, and other apps still ask", async () => {
    const { core, calls } = await offersCore();
    calls.use(["slack"]);
    const offer = (await core.getMeetingOffers()).offer;
    if (!offer) throw new Error("No offer.");
    await core.declineMeetingOffer({ offerId: offer.id, always: true });
    expect((await core.getSettings()).device.callOffersOff).toEqual(["slack"]);

    calls.use(["slack", "chrome"]);
    expect((await core.getMeetingOffers()).offer).toMatchObject({ app: "chrome" });
    expect(await core.listMeetings()).toEqual([]);
  });

  test("turning call offers off stops watching and takes the offer back", async () => {
    const { core, calls } = await offersCore();
    calls.use(["webex"]);
    expect((await core.getMeetingOffers()).offer).not.toBeNull();
    await core.updateSettings({ device: { callOffers: false } });
    expect(calls.watching()).toBe(false);
    expect((await core.getMeetingOffers()).offer).toBeNull();
  });

  test("an app turned off in Settings is never offered", async () => {
    const { core, calls } = await offersCore();
    await core.updateSettings({ device: { callOffersOff: ["zoom"] } });
    calls.use(["zoom"]);
    expect((await core.getMeetingOffers()).offer).toBeNull();
  });

  test("says when this computer can't tell, and clears it when call offers are off", async () => {
    const { core, calls } = await offersCore();
    calls.fail("no-pactl");
    expect((await core.getMeetingOffers()).problem).toBe("no-pactl");
    await core.updateSettings({ device: { callOffers: false } });
    expect((await core.getMeetingOffers()).problem).toBeNull();
  });
});

describe("Take notes", () => {
  test("records the call in a new Note opened in the main window, and nothing is offered while it records", async () => {
    const { core, calls } = await offersCore();
    calls.use(["zoom"]);
    const offer = (await core.getMeetingOffers()).offer;
    if (!offer) throw new Error("No offer.");
    const meeting = await core.takeMeetingOffer(offer.id);
    expect(meeting.status).toBe("recording");
    const layout = await core.getLayout("main");
    expect(layout.groups.flatMap((group) => group.tabs).map((tab) => tab.item)).toContainEqual({
      kind: "mind",
      mindId: meeting.mindId,
    });
    expect((await core.getMeetingOffers()).offer).toBeNull();

    calls.use(["zoom", "slack"]);
    expect((await core.getMeetingOffers()).offer).toBeNull();
    await expect(core.takeMeetingOffer(offer.id)).rejects.toThrow("That call has ended.");
  });

  test("stops 30 seconds after the call app lets go of the microphone, saying so first", async () => {
    const { core, calls } = await offersCore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    calls.use(["zoom"]);
    const offer = (await core.getMeetingOffers()).offer;
    if (!offer) throw new Error("No offer.");
    const meeting = await core.takeMeetingOffer(offer.id);

    calls.use([]);
    const { ending } = await core.getMeetingOffers();
    expect(ending).toEqual({
      meetingId: meeting.id,
      app: "zoom",
      stopsAt: "2026-10-06T09:00:30.000Z",
    });
    vi.advanceTimersByTime(29_000);
    expect((await recorded(core))[0]?.status).toBe("recording");
    vi.advanceTimersByTime(1000);
    await nextTurn();
    expect((await recorded(core))[0]?.status).toBe("stopped");
    expect((await core.getMeetingOffers()).ending).toBeNull();
  });

  test("Keep recording, or the app taking the microphone back, keeps it recording", async () => {
    const { core, calls } = await offersCore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    calls.use(["teams"]);
    const offer = (await core.getMeetingOffers()).offer;
    if (!offer) throw new Error("No offer.");
    const meeting = await core.takeMeetingOffer(offer.id);

    calls.use([]);
    await core.keepRecordingAfterCall(meeting.id);
    expect((await core.getMeetingOffers()).ending).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect((await recorded(core))[0]?.status).toBe("recording");

    calls.use(["teams"]);
    calls.use([]);
    expect((await core.getMeetingOffers()).ending?.meetingId).toBe(meeting.id);
    vi.advanceTimersByTime(20_000);
    calls.use(["teams"]);
    expect((await core.getMeetingOffers()).ending).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect((await recorded(core))[0]?.status).toBe("recording");
  });

  test("a Meeting the User started by hand never stops when a call app lets go", async () => {
    const { core, calls } = await offersCore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    calls.use(["zoom"]);
    expect((await core.getMeetingOffers()).offer).toBeNull();
    calls.use([]);
    vi.advanceTimersByTime(60_000);
    expect((await core.getMeetingOffers()).ending).toBeNull();
    expect((await recorded(core))[0]?.status).toBe("recording");
  });
});

describe("Opening at login", () => {
  test("registers and unregisters through the host's login item", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { loginItem: createFileLoginItem(dataDir) });
    expect(await core.getOpenAtLogin()).toEqual({
      supported: true,
      on: false,
      needsApproval: false,
    });
    expect(await core.setOpenAtLogin(true)).toMatchObject({ on: true });
    expect(await core.getOpenAtLogin()).toMatchObject({ on: true });
    expect(await core.setOpenAtLogin(false)).toMatchObject({ on: false });
  });

  test("isn't offered by a copy that can't", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    expect(await core.getOpenAtLogin()).toEqual({
      supported: false,
      on: false,
      needsApproval: false,
    });
    await expect(core.setOpenAtLogin(true)).rejects.toThrow("can’t open at login");
  });
});
