import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { SystemCalendarEvent, SystemCalendarPerson } from "../src/core/adapters";
import type { FakeSystemCalendar, SystemCalendarFixture } from "../src/core/calendars/fakeSystem";
import { translate } from "../src/shared/i18n";
import {
  clickNotification,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  notificationsShown,
  opensRecorded,
  pointAndClick,
  recordNotifications,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  urlsOpened,
} from "./app";

const labels = {
  en: {
    solo: "Individual preparation",
    target: "Release rehearsal",
    dismiss: "Materials review",
    ignore: "Production check",
    take: "Take notes",
    notNow: "Not now",
    reminder: (title: string) => `${title} starts in 1 minute`,
  },
  "zh-CN": {
    solo: "个人准备",
    target: "发布演练",
    dismiss: "材料评审",
    ignore: "生产检查",
    take: "记录会议",
    notNow: "暂不",
    reminder: (title: string) => `“${title}”将在 1 分钟后开始`,
  },
} as const;

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

function event(
  id: string,
  title: string,
  start: number,
  last: string,
  attendees: SystemCalendarPerson[] = [self, guest],
): SystemCalendarEvent {
  return {
    id,
    calendarId: "fixture",
    externalId: `${id}@example.test`,
    occurrence: null,
    title,
    start: new Date(start).toISOString(),
    end: new Date(start + 120_000).toISOString(),
    allDay: false,
    status: "confirmed",
    attendees,
    organizer: self,
    url: `https://meet.google.com/abc-defg-${last}`,
    location: null,
    notes: null,
  };
}

const calendar: SystemCalendarFixture = {
  access: "not-asked",
  answer: "allowed",
  calendars: [{ id: "fixture", title: "Fixture", source: "On this Mac", kind: "local" }],
  events: [],
};

async function syncCalendarEvents(
  app: ElectronApplication,
  window: Page,
  events: SystemCalendarEvent[],
) {
  await app.evaluate((_electron, upcoming) => {
    const fake = (globalThis as { incarnamindFakeCalendar?: FakeSystemCalendar })
      .incarnamindFakeCalendar;
    if (!fake) throw new Error("The app has no fake calendar.");
    fake.fixture.events = upcoming;
  }, events);
  await (await coreOf(window)).evaluate((core) => core.syncCalendars());
}

const reminders = async (app: ElectronApplication) =>
  (await notificationsShown(app)).map(({ title }) => title);

const shownNotification = async (app: ElectronApplication, copy: string) => {
  await expect.poll(() => reminders(app), { timeout: 20_000 }).toContain(copy);
  return (await reminders(app)).indexOf(copy);
};

const takeNotesFromNotification = (app: ElectronApplication, index: number) =>
  app.evaluate((_electron, at) => {
    const held = (globalThis as { notificationsHeld?: Electron.Notification[] }).notificationsHeld;
    const notification = held?.[at];
    if (!notification) throw new Error("The expected notification is absent.");
    notification.emit("action", {}, 0);
  }, index);

const meetings = async (window: Page) =>
  (await coreOf(window)).evaluate((core) => core.listMeetings());

async function openCalendar(window: Page, language: keyof typeof labels) {
  await window
    .getByTestId("sidebar-footer")
    .getByRole("button", { name: translate(language, "sidebar.settings") })
    .click();
  const settings = await showSettingsPage(window, "meetings");
  const section = settings.getByTestId("calendar-settings");
  const mac = section.locator('[data-testid="calendar-connect-row"][data-service="mac"]');
  await mac.getByTestId("calendar-connect").click();
  await expect(
    section.locator('[data-testid="calendar-account"][data-service="mac"]'),
  ).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await window.getByTestId("sidebar-home").click();
}

async function allowMeetingOffers(window: Page) {
  await (await coreOf(window)).evaluate((core) =>
    core.updateSettings({ device: { meetingNoticeAccepted: true, calendarOffers: true } }),
  );
}

for (const language of ["en", "zh-CN"] as const) {
  test(`calendar reminder waits for consent and opens and records only the chosen event (${language})`, async () => {
    const dataDir = await createDataFolder();
    const words = labels[language];
    try {
      const { app, window } = await launchApp(dataDir, { systemCalendar: calendar });
      await recordNotifications(app);
      await expect.poll(() => opensRecorded(app)).toBe(true);
      await dismissChatSetup(window);
      await setWindowSize(app, window, language === "en" ? 1280 : 900, 760);
      await setLanguage(window, language);

      expect(await reminders(app)).toEqual([]);
      await openCalendar(window, language);
      const now = Date.now();
      const solo = event("solo", words.solo, now + 40_000, "one", [self]);
      const target = event("target", words.target, now + 55_000, "two");
      await syncCalendarEvents(app, window, [solo, target]);
      await expect(window.getByTestId("home-coming-up")).toContainText(target.title);
      expect(await reminders(app)).toEqual([]);
      expect(await meetings(window)).toEqual([]);
      const card = window.getByTestId("calendar-offer-line");
      await expect(card).toHaveCount(0);
      await motionSettled(window);
      await window.screenshot({
        path: test.info().outputPath(`calendar-before-reminder-${language}.png`),
      });
      await allowMeetingOffers(window);

      const index = await shownNotification(app, words.reminder(target.title));
      expect(await reminders(app)).toHaveLength(1);
      expect(await urlsOpened(app)).toEqual([]);
      expect(await meetings(window)).toEqual([]);

      await newMind(window, { title: true });
      await expect(window.getByTestId("sidebar-home")).not.toHaveAttribute("aria-current", "page");
      await clickNotification(app, index);
      await expect(window.getByTestId("sidebar-home")).toHaveAttribute("aria-current", "page");
      await expect(card).toBeVisible();
      await expect(card).toContainText(target.title);
      await expect(card.getByTestId("calendar-offer-take")).toHaveText(words.take);
      expect(await meetings(window)).toEqual([]);
      expect(await urlsOpened(app)).toEqual([]);
      await motionSettled(window);
      await window.screenshot({
        path: test.info().outputPath(`calendar-reminder-${language}.png`),
      });

      if (language === "en") {
        await takeNotesFromNotification(app, index);
      } else {
        await pointAndClick(window, card.getByTestId("calendar-offer-take"));
      }
      await expect(window.getByTestId("meeting-bar")).toHaveAttribute("data-status", "recording");
      await expect(window.locator('[data-testid="mind-tab"][aria-selected="true"]')).toContainText(
        target.title,
      );
      await expect.poll(() => urlsOpened(app)).toEqual([target.url]);
      const started = await meetings(window);
      expect(started).toHaveLength(1);
      const [active] = started;
      if (!active) throw new Error("The chosen meeting was not recorded.");
      expect(active.status).toBe("recording");
      const noteEvent = await (await coreOf(window)).evaluate(
        (core, mindId) => core.getNoteEvent(mindId),
        active.mindId,
      );
      expect(noteEvent).toMatchObject({ title: target.title, joinUrl: target.url });
      await expect(card).toHaveCount(0);
    } finally {
      await removeDataFolder(dataDir);
    }
  });

  test(`dismissing a calendar reminder and ignoring the next one never records (${language})`, async () => {
    const dataDir = await createDataFolder();
    const words = labels[language];
    try {
      const { app, window } = await launchApp(dataDir, { systemCalendar: calendar });
      await recordNotifications(app);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await openCalendar(window, language);
      await allowMeetingOffers(window);
      const dismissed = event("dismissed", words.dismiss, Date.now() + 55_000, "dsm");
      await syncCalendarEvents(app, window, [dismissed]);
      const index = await shownNotification(app, words.reminder(dismissed.title));

      await app.evaluate((_electron, at) => {
        const held = (globalThis as { notificationsHeld?: Electron.Notification[] })
          .notificationsHeld;
        const notification = held?.[at];
        if (!notification) throw new Error("The expected notification is absent.");
        notification.emit("close");
      }, index);
      expect(await meetings(window)).toEqual([]);
      expect(await urlsOpened(app)).toEqual([]);

      const card = window.getByTestId("calendar-offer-line");
      await expect(card).toContainText(dismissed.title);
      const decline = card.getByTestId("calendar-offer-not-now");
      await expect(decline).toHaveText(words.notNow);
      await pointAndClick(window, decline);
      await expect(card).toHaveCount(0);

      const ignored = event("ignored", words.ignore, Date.now() + 55_000, "ign");
      await syncCalendarEvents(app, window, [dismissed, ignored]);
      await shownNotification(app, words.reminder(ignored.title));
      await expect(card).toContainText(ignored.title);
      expect(await meetings(window)).toEqual([]);
      expect(await urlsOpened(app)).toEqual([]);
      expect(await reminders(app)).toEqual([
        words.reminder(dismissed.title),
        words.reminder(ignored.title),
      ]);
    } finally {
      await removeDataFolder(dataDir);
    }
  });
}

test("Take notes from a calendar notification keeps recording if the browser cannot open", async () => {
  const dataDir = await createDataFolder();
  try {
    const { app, window } = await launchApp(dataDir, { systemCalendar: calendar });
    await recordNotifications(app);
    await expect.poll(() => opensRecorded(app)).toBe(true);
    await app.evaluate(({ shell }) => {
      shell.openExternal = async () => {
        throw new Error("The test browser could not open this link.");
      };
    });
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    await openCalendar(window, "en");
    await allowMeetingOffers(window);
    const target = event("target", "Release rehearsal", Date.now() + 55_000, "two");
    await syncCalendarEvents(app, window, [target]);
    await takeNotesFromNotification(
      app,
      await shownNotification(app, labels.en.reminder(target.title)),
    );

    await expect(window.getByTestId("meeting-bar")).toHaveAttribute("data-status", "recording");
    await expect(window.getByTestId("error-notice-message")).toContainText(
      "Recording, but the meeting link didn’t open: open it from your calendar.",
    );
    expect(await meetings(window)).toMatchObject([{ status: "recording" }]);
  } finally {
    await removeDataFolder(dataDir);
  }
});
