import { expect, type Page, test } from "@playwright/test";
import type { SystemCalendarFixture } from "../src/core/calendars/fakeSystem";
import { translate } from "../src/shared/i18n";
import type { MessageKey, MessageParams } from "../src/shared/i18n/types";
import { createFakeCalendars, type FakeCalendarsServer } from "../tests/helpers/fakeCalendars";
import {
  acceptPlainTextKeys,
  createDataFolder,
  interceptOpenExternal,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  urlsOpened,
} from "./app";

const MEET = "https://meet.google.com/abc-defg-hij";

let dataDir: string;
let fake: FakeCalendarsServer;

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
/** Tomorrow at this hour, on this computer's clock. */
const tomorrowAt = (hour: number) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour).toISOString();
};

test.beforeEach(async () => {
  dataDir = await createDataFolder();
  fake = await createFakeCalendars({
    google: {
      email: "priya@example.com",
      name: "Priya Raman",
      calendars: [
        {
          id: "work",
          name: "Work",
          primary: true,
          events: [
            {
              id: "standup",
              title: "Standup",
              start: minutesFromNow(20),
              end: minutesFromNow(35),
              joinUrl: MEET,
              attendees: [
                { email: "priya@example.com", name: "Priya Raman", response: "accepted" },
                { email: "dana@northwind.example", name: "Dana Kim", response: "accepted" },
                { email: "sam@northwind.example", name: "Sam Okafor" },
                { email: "lena@northwind.example", name: "Lena Ortiz" },
                { email: "wei@northwind.example", name: "张伟" },
              ],
            },
            {
              id: "renewal",
              title: "Aldermoor renewal call",
              start: tomorrowAt(14),
              end: tomorrowAt(15),
              attendees: [
                { email: "priya@example.com", name: "Priya Raman", response: "accepted" },
                { email: "ana@aldermoor.example", name: "Ana Costa" },
              ],
            },
          ],
        },
      ],
    },
  });
});

test.afterEach(async () => {
  await fake.close();
  await removeDataFolder(dataDir);
});

/** The Mac's own calendar, not asked yet: the User allows it when they connect it. */
const macCalendar = (): SystemCalendarFixture => ({
  access: "not-asked",
  answer: "allowed",
  calendars: [{ id: "home", title: "Home", source: "iCloud", kind: "caldav" }],
  events: [
    {
      calendarId: "home",
      id: "review",
      externalId: "review@icloud",
      occurrence: null,
      title: "Design review",
      start: tomorrowAt(10),
      end: tomorrowAt(11),
      allDay: false,
      status: "confirmed",
      attendees: [],
      organizer: null,
      url: null,
      location: null,
      notes: null,
    },
  ],
});

async function screenshot(window: Page, name: string): Promise<void> {
  // A line fading in mid-picture would show two lines over each other.
  await window.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  await window.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`connecting Google and the Mac's calendar fills Coming up, and Take notes opens the Meeting's Note with when it is, who is in it and Join and record (${language}, 1,440 and 900 px)`, async () => {
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    const { app, window } = await launchApp(dataDir, {
      calendars: fake.origin,
      systemCalendar: macCalendar(),
    });
    try {
      await interceptOpenExternal(app);
      await setWindowSize(app, window, 1440, 760);
      await setLanguage(window, language);

      await window
        .getByTestId("sidebar-footer")
        .getByRole("button", { name: t("sidebar.settings") })
        .click();
      const settings = await showSettingsPage(window, "meetings");
      const calendars = settings.getByTestId("calendar-settings");
      await expect(calendars).toContainText(t("calendars.title"));
      const google = calendars.locator(
        '[data-testid="calendar-connect-row"][data-service="google"]',
      );
      // What the sign-in sends is on screen before the choice, which is the consent (ADR-0022).
      await expect(google.getByTestId("calendar-sends")).toContainText(t("calendars.sends.google"));
      await screenshot(window, `calendars-settings-${language}-1440`);

      // Linux with no keyring: the sign-in is kept only once the User accepts plain text.
      await acceptPlainTextKeys(window, calendars);
      await google.getByTestId("calendar-connect").click();
      await expect(calendars.getByTestId("calendar-signing-in")).toHaveText(
        new RegExp(t("calendars.signingIn")),
      );
      await expect.poll(() => urlsOpened(app)).toHaveLength(1);
      const [authorize] = await urlsOpened(app);
      const back = fake.redirectFor(authorize ?? "");
      back.hostname = "127.0.0.1";
      expect((await fetch(back)).status).toBe(200);
      const connected = calendars.locator(
        '[data-testid="calendar-account"][data-service="google"]',
      );
      await expect(connected.getByTestId("calendar-account-detail")).toHaveText(
        t("calendars.counted.one", { account: "priya@example.com", counted: 1, total: 1 }),
      );

      const mac = calendars.locator('[data-testid="calendar-connect-row"][data-service="mac"]');
      await mac.getByTestId("calendar-connect").click();
      await expect(
        calendars.locator('[data-testid="calendar-account"][data-service="mac"]'),
      ).toContainText(t("calendars.counted.mac.one", { counted: 1, total: 1 }));
      await screenshot(window, `calendars-settings-connected-${language}-1440`);
      await window.keyboard.press("Escape");
      await expect(settings).toBeHidden();

      await window.getByTestId("sidebar-home").click();
      const comingUp = window.getByTestId("home-coming-up");
      const rows = comingUp.getByTestId("home-meeting");
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0).getByTestId("home-meeting-title")).toHaveText("Standup");
      await expect(rows.nth(1).getByTestId("home-meeting-title")).toHaveText("Design review");
      await expect(rows.nth(2).getByTestId("home-meeting-title")).toHaveText(
        "Aldermoor renewal call",
      );
      await expect(rows.nth(2).getByTestId("home-meeting-time")).toContainText(
        t("comingUp.tomorrowAt", { time: "" }).trim(),
      );
      await expect(rows.nth(0).getByTestId("home-meeting-people")).toContainText("DK");
      await screenshot(window, `calendars-home-${language}-1440`);
      await setWindowSize(app, window, 900, 760);
      // The title gives way at a narrow window; Take notes stays whole and in the row.
      const take = rows.nth(0).getByTestId("home-take-notes");
      await expect(take).toHaveText(t("comingUp.takeNotes"));
      const row = await rows.nth(0).boundingBox();
      const button = await take.boundingBox();
      expect((button?.x ?? 0) + (button?.width ?? 0)).toBeLessThanOrEqual(
        (row?.x ?? 0) + (row?.width ?? 0) + 1,
      );
      await screenshot(window, `calendars-home-${language}-900`);

      await take.click();
      const bar = window.locator('[data-testid="event-bar"]:visible');
      await expect(bar).toBeVisible();
      await expect(window.locator('[data-testid="mind-tab"][aria-selected="true"]')).toContainText(
        "Standup",
      );
      await expect(bar.getByTestId("event-bar-when")).toContainText(t("eventBar.today"));
      await expect(bar.getByTestId("event-bar-when")).toContainText(
        t("eventBar.withN", { a: "Dana", b: "Sam", n: 2, m: 4 }),
      );
      await expect(bar.getByTestId("event-bar-soon")).toHaveText(
        new RegExp(t("eventBar.startsIn", { n: "\\d+" })),
      );
      await expect(bar.getByTestId("event-bar-record")).toHaveText(t("eventBar.join"));
      // The page stays the User's: nothing of the event is written into it.
      await expect(window.locator('[data-testid="mind-pane"]:visible')).not.toContainText(
        "Dana Kim",
      );
      await screenshot(window, `calendars-note-${language}-900`);
      await setWindowSize(app, window, 1440, 760);
      await screenshot(window, `calendars-note-${language}-1440`);

      await bar.getByTestId("event-bar-record").click();
      await expect.poll(() => urlsOpened(app)).toContain(MEET);
      // The Meeting takes over from the event's bar.
      await expect(window.locator('[data-testid="event-bar"]:visible')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}
