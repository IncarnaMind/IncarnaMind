import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { SystemCalendarEvent, SystemCalendarPerson } from "../src/core/adapters";
import type { DeviceSettings, Settings } from "../src/core/api";
import type { SystemCalendarFixture } from "../src/core/calendars/fakeSystem";
import {
  callsUseMicrophone,
  clickTrayItem,
  coreOf,
  createDataFolder,
  launchApp,
  offerNotifications,
  openMeetingSheet,
  pointAndClick,
  pressOfferNotification,
  type RunningApp,
  removeDataFolder,
  syncCalendarEvents,
  trayItemIds,
} from "./app";

/*
 * Every way an offer to take notes starts a recording (#3762): taking it records at once, with no
 * dialog first, and turns no setting on. An offer shows only on a device that has recorded before,
 * so each case marks that and turns its offers on as Settings › General does, on a fresh data
 * folder with no Meeting yet. The call watcher and the calendar are fakes the test drives.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const settingsNow = async (window: Page): Promise<Settings> =>
  (await coreOf(window)).evaluate((core) => core.getSettings());

const updateDevice = async (window: Page, device: Partial<DeviceSettings>) =>
  (await coreOf(window)).evaluate((core, given) => core.updateSettings({ device: given }), device);

/**
 * Every setting but that this device has recorded, which a first recording sets, and how often
 * each one-line tip has shown, which a tip counts as it shows (over the meeting's control, on
 * Home) so that it never shows a third time: nothing the User turns on or off.
 */
const asideFromRecording = (settings: Settings) => ({
  ...settings,
  device: { ...settings.device, meetingNoticeAccepted: null, tips: null },
});

/** Whether IncarnaMind opens at login, as a test build keeps it in its data folder. */
const loginItem = (): unknown => {
  const file = join(dataDir, "login-item.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
};

const meetingStatuses = async (window: Page) =>
  (await coreOf(window)).evaluate(async (core) =>
    (await core.listMeetings()).map((each) => each.status),
  );

/** The app's windows but the call help panel, which every recording opens as Settings › Meetings has it. */
const windowsBesidePanel = ({ app }: RunningApp) =>
  app
    .windows()
    .map((page) => page.url())
    .filter((url) => !url.includes("meetingPanel.html"));

/** Zoom takes the microphone, on a device whose call offers are on: its offer is shown. */
async function callOffered(): Promise<RunningApp> {
  const running = await launchApp(dataDir, { extraEnv: { INCARNAMIND_TEST_CALLS: "1" } });
  await updateDevice(running.window, {
    meetingNoticeAccepted: true,
    keepRunning: true,
    callOffers: true,
  });
  await callsUseMicrophone(running.app, ["zoom"]);
  await expect
    .poll(async () => (await offerNotifications(running.app)).map((each) => each.body))
    .toEqual(["Zoom is using the microphone"]);
  return running;
}

const self: SystemCalendarPerson = {
  name: "Pat",
  email: "pat@example.test",
  self: true,
  status: "accepted",
};
const guest: SystemCalendarPerson = {
  name: "Sam",
  email: "sam@example.test",
  self: false,
  status: "accepted",
};
const CALENDAR: SystemCalendarFixture = {
  access: "allowed",
  calendars: [{ id: "fixture", title: "Fixture", source: "On this Mac", kind: "local" }],
  events: [],
};
const EVENT_TITLE = "Release rehearsal";

const rehearsal = (start: number): SystemCalendarEvent => ({
  id: "rehearsal",
  calendarId: "fixture",
  externalId: "rehearsal@example.test",
  occurrence: null,
  title: EVENT_TITLE,
  start: new Date(start).toISOString(),
  end: new Date(start + 120_000).toISOString(),
  allDay: false,
  status: "confirmed",
  attendees: [self, guest],
  organizer: self,
  url: "https://meet.google.com/abc-defg-two",
  location: null,
  notes: null,
});

/** A meeting on the Mac's calendar starts in a minute, with its offers on: its reminder is shown. */
async function reminderShown(): Promise<RunningApp> {
  const running = await launchApp(dataDir, { systemCalendar: CALENDAR });
  await (await coreOf(running.window)).evaluate((core) => core.connectCalendar("mac"));
  await updateDevice(running.window, { meetingNoticeAccepted: true, calendarOffers: true });
  await syncCalendarEvents(running.app, running.window, [rehearsal(Date.now() + 55_000)]);
  await expect
    .poll(async () => (await offerNotifications(running.app)).map((each) => each.title), {
      timeout: 20_000,
    })
    .toEqual([`${EVENT_TITLE} starts in 1 minute`]);
  return running;
}

/** Home's line for the offer, and its Take notes. */
async function takeOnHome(window: Page, line: string, take: string): Promise<void> {
  await pointAndClick(window, window.getByTestId("sidebar-home"));
  const offer = window.getByTestId(line);
  await expect(offer).toBeVisible();
  await pointAndClick(window, offer.getByTestId(take));
}

const WAYS: {
  name: string;
  offered(): Promise<RunningApp>;
  take(running: RunningApp): Promise<void>;
}[] = [
  {
    name: "a call's notification",
    offered: callOffered,
    take: ({ app }) => pressOfferNotification(app, "offer", 0),
  },
  {
    name: "the tray's menu, for a call",
    offered: callOffered,
    async take({ app }) {
      await expect.poll(() => trayItemIds(app)).toContain("tray.takeNotes");
      await clickTrayItem(app, "tray.takeNotes");
    },
  },
  {
    name: "Home's offer line, for a call",
    offered: callOffered,
    take: ({ window }) => takeOnHome(window, "call-offer-line", "call-offer-take"),
  },
  {
    name: "a calendar reminder's notification",
    offered: reminderShown,
    take: ({ app }) => pressOfferNotification(app, "offer", 0),
  },
  {
    name: "Home's offer line, for a calendar reminder",
    offered: reminderShown,
    take: ({ window }) => takeOnHome(window, "calendar-offer-line", "calendar-offer-take"),
  },
];

for (const way of WAYS) {
  test(`Take notes from ${way.name} records at once, with no dialog first, and turns no setting on`, async () => {
    const running = await way.offered();
    const { window } = running;
    expect(await meetingStatuses(window)).toEqual([]);
    const before = await settingsNow(window);
    const loginBefore = loginItem();
    const windows = windowsBesidePanel(running);

    await way.take(running);
    await expect(window.getByTestId("meeting-foot")).toHaveAttribute("data-status", "recording");
    expect(await meetingStatuses(window)).toEqual(["recording"]);
    await expect(window.getByTestId("meeting-notice")).toHaveCount(0);
    await expect(window.getByTestId("meeting-start")).toHaveCount(0);
    await expect(
      window.locator('dialog[open], [role="dialog"]:visible, [role="alertdialog"]:visible'),
    ).toHaveCount(0);
    expect(windowsBesidePanel(running)).toEqual(windows);

    // The sheet says the one thing to do.
    const sheet = await openMeetingSheet(window);
    const said = sheet.locator(".meeting-sheet-consent");
    await expect(said).toHaveCount(1);
    await expect(said).toHaveText("Tell everyone you’re recording.");

    expect(asideFromRecording(await settingsNow(window))).toEqual(asideFromRecording(before));
    expect(loginItem()).toEqual(loginBefore);
  });
}
