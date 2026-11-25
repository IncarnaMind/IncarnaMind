import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import type { BackgroundTestHooks } from "../src/main/backgroundHost";
import type { FakeCalls } from "../src/main/calls/fakeWatcher";
import {
  createDataFolder,
  dismissChatSetup,
  film,
  launchApp,
  motionSettled,
  openMeetingSheet,
  openSettings,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  startedBefore,
  stopMeeting,
} from "./app";

/*
 * IncarnaMind in the background and its offers to take notes (#189, #208): Settings › General's
 * switches, the tray icon's menu, closing the window, and an offer when a call app takes the
 * microphone, which records only on Take notes. The call watcher is a fake the test drives; nothing reads the computer's microphone.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const launch = () => launchApp(dataDir, { extraEnv: { INCARNAMIND_TEST_CALLS: "1" } });

const bridge = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

const callsUse = (app: ElectronApplication, apps: string[]) =>
  app.evaluate((_electron, given) => {
    const calls = (globalThis as { incarnamindFakeCalls?: FakeCalls }).incarnamindFakeCalls;
    if (!calls) throw new Error("The app isn't watching calls with the fake.");
    calls.use(given);
  }, apps);

type Hooks = BackgroundTestHooks;
const HOOKS = "incarnamindBackground";

const notifications = (app: ElectronApplication) =>
  app.evaluate(
    (_electron, key) =>
      (globalThis as unknown as Record<string, Hooks>)[key]?.notifications() ?? [],
    HOOKS,
  );

const trayShown = (app: ElectronApplication) =>
  app.evaluate(
    (_electron, key) => (globalThis as unknown as Record<string, Hooks>)[key]?.tray().shown,
    HOOKS,
  );

const trayItems = (app: ElectronApplication) =>
  app.evaluate(
    (_electron, key) =>
      (globalThis as unknown as Record<string, Hooks>)[key]
        ?.tray()
        .items.map((item) => item.label ?? "—") ?? [],
    HOOKS,
  );

const clickTray = (app: ElectronApplication, id: string) =>
  app.evaluate(
    (_electron, [key, item]) =>
      (globalThis as unknown as Record<string, Hooks>)[key]?.clickTray(item),
    [HOOKS, id] as const,
  );

const clickNotification = (app: ElectronApplication, kind: "offer" | "ending", action?: number) =>
  app.evaluate(
    (_electron, [key, which, button]) =>
      (globalThis as unknown as Record<string, Hooks>)[key]?.clickNotification(
        which,
        button ?? undefined,
      ),
    [HOOKS, kind, action ?? null] as const,
  );

/** Meetings in use on this device, with the offers and the tray turned on in Settings › General. */
const setUpMeetings = async (window: Page) =>
  (await bridge(window)).evaluate((core) =>
    core.updateSettings({
      device: { meetingNoticeAccepted: true, keepRunning: true, callOffers: true },
    }),
  );

const deviceSettings = async (window: Page) =>
  (await bridge(window)).evaluate(async (core) => (await core.getSettings()).device);

/** What a test build's login item holds: a file in the data folder, never the computer's own; null with none. */
const loginItem = async (dataDir: string): Promise<unknown> => {
  const file = join(dataDir, "login-item.json");
  return existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : null;
};

const meetingStatuses = async (window: Page) =>
  (await bridge(window)).evaluate(async (core) =>
    (await core.listMeetings()).map((each) => each.status),
  );

/** The app's own window, once one is open: not the call help panel a recording opens beside it. */
async function appWindow(app: ElectronApplication): Promise<Page> {
  const own = (page: Page) => !page.isClosed() && page.url().includes("index.html");
  await expect.poll(() => app.windows().some(own)).toBe(true);
  const found = app.windows().find(own);
  if (!found) throw new Error("No window of the app's is open.");
  return found;
}

const WORDS = {
  en: {
    background: "Running in the background",
    openAtLogin: "Open at login",
    calls: "Calls not on your calendar",
    title: "Are you in a call right now?",
    body: "Zoom is using the microphone",
    take: "Take notes",
    dontAsk: "Don’t ask for Zoom",
  },
  "zh-CN": {
    background: "在后台运行",
    openAtLogin: "登录时打开",
    calls: "不在日历上的通话",
    title: "你正在通话吗？",
    body: "Zoom 正在使用麦克风",
    take: "记录会议",
    dontAsk: "不再因 Zoom 询问",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`Settings › General keeps the background switches and the offers' switches, per app (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launch();
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 760);
    await setUpMeetings(window);

    const settings = await openSettings(window, "general");
    await setLanguage(window, language);
    const section = settings.getByTestId("background-settings");
    await expect(section).toContainText(words.background);
    await expect(section).toContainText(words.openAtLogin);
    await expect(settings.getByTestId("keep-running-switch")).toBeChecked();
    // Until a calendar is connected (#190), its offers' switch isn't shown; calls' is.
    await expect(settings.getByTestId("calendar-offers-switch")).toHaveCount(0);
    await expect(settings.getByTestId("call-offers")).toContainText(words.calls);
    await expect(settings.getByTestId("call-offers-switch")).toBeChecked();
    if (process.platform === "win32") {
      await expect(settings.getByTestId("call-offers")).toContainText(
        language === "en" ? "Stop recording when you leave." : "离开通话时请手动停止录制。",
      );
    }

    // Opening at login goes through the login item, which a test build keeps in its data folder:
    // on from the first start (#3758), and each click goes there.
    const openAtLogin = settings.getByTestId("open-at-login-switch");
    await expect(openAtLogin).toBeChecked();
    await openAtLogin.click();
    await expect(openAtLogin).not.toBeChecked();
    await expect.poll(() => loginItem(dataDir)).toEqual({ on: false });
    await openAtLogin.click();
    await expect(openAtLogin).toBeChecked();
    await expect.poll(() => loginItem(dataDir)).toEqual({ on: true });

    // Per app… unfolds a switch for each app: Zoom off, the others still on.
    await settings.getByTestId("call-offers-per-app").click();
    await expect(settings.getByTestId("call-offers-per-app")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(settings.getByTestId("call-offers-app-teams")).toBeChecked();
    await settings.getByTestId("call-offers-app-zoom").click();
    await expect(settings.getByTestId("call-offers-app-zoom")).not.toBeChecked();
    await expect
      .poll(async () =>
        (await bridge(window)).evaluate(
          async (core) => (await core.getSettings()).device.callOffersOff,
        ),
      )
      .toEqual(["zoom"]);
    await settings.getByTestId("call-offers").scrollIntoViewIfNeeded();
    await shot(window, `settings-general-background-${language}`);
    // At the narrowest window, Per app… and the switch stay on the row, beside its words.
    await setWindowSize(app, window, 900, 640);
    const perApp = await settings.getByTestId("call-offers-per-app").boundingBox();
    const callSwitch = await settings.getByTestId("call-offers-switch").boundingBox();
    expect(perApp && callSwitch && perApp.x + perApp.width <= callSwitch.x).toBe(true);
    await settings.getByTestId("call-offers").scrollIntoViewIfNeeded();
    await shot(window, `settings-general-background-${language}-narrow`);

    // An app turned off is never offered; one still on is.
    await callsUse(app, ["zoom"]);
    await callsUse(app, ["zoom", "teams"]);
    await expect
      .poll(async () => (await notifications(app)).map((each) => each.body))
      .toEqual([
        language === "en"
          ? "Microsoft Teams is using the microphone"
          : "Microsoft Teams 正在使用麦克风",
      ]);
    await window.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await app.close();
  });

  test(`Open at login that can't be changed lets IncarnaMind start, and says which file under its switch (${language})`, async () => {
    // A folder where the login item's file should be fails every write to it, on every system.
    const file = join(dataDir, "login-item.json");
    await mkdir(file);
    const { app, window } = await launch();
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 760);
    const settings = await openSettings(window, "general");
    await setLanguage(window, language);
    const openAtLogin = settings.getByTestId("open-at-login-switch");
    await expect(openAtLogin).not.toBeChecked();
    await openAtLogin.click();
    await expect(settings.getByTestId("open-at-login-problem")).toHaveText(
      language === "en"
        ? `Couldn’t change ${file}, which opens IncarnaMind at login. Check its permissions or remove it.`
        : `无法修改 ${file}，登录时由它打开 IncarnaMind。请检查它的权限，或移除它。`,
    );
    await expect(openAtLogin).not.toBeChecked();
    await shot(window, `settings-open-at-login-problem-${language}`);
    await app.close();
  });

  test(`a call app taking the microphone is offered; Take notes records and Stop saves it (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launch();
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 760);
    await setLanguage(window, language);
    await setUpMeetings(window);

    // The offer, taken, then the call's end: filmed in English for the pull request.
    const flow = async () => {
      await callsUse(app, ["zoom"]);
      await expect
        .poll(() => notifications(app))
        .toEqual([
          {
            kind: "offer",
            title: words.title,
            body: words.body,
            actions: [words.take, words.dontAsk],
          },
        ]);
      await expect.poll(() => trayItems(app)).toContain(words.take);
      // An offer records nothing by itself.
      expect(await meetingStatuses(window)).toEqual([]);

      await clickNotification(app, "offer", 0);
      const control = window.getByTestId("meeting-foot");
      await expect(control).toHaveAttribute("data-status", "recording");
      await expect.poll(() => notifications(app)).toEqual([]);
      await shot(window, `offer-taken-recording-${language}`);

      await callsUse(app, []);
      const line = window.getByTestId("meeting-line-call-ended");
      if (process.platform === "win32") {
        await expect(line).toHaveCount(0);
        await expect(control).toHaveAttribute("data-status", "recording");
        expect(await notifications(app)).toEqual([]);
        await shot(window, `offer-manual-stop-${language}`);
        await stopMeeting(window);
      } else {
        await expect(line).toContainText(
          language === "en" ? "Did your meeting end?" : "会议结束了吗？",
        );
        await expect
          .poll(async () => (await notifications(app)).map((each) => each.kind))
          .toEqual(["ending"]);
        await shot(window, `offer-call-ended-${language}`);
        await line.getByTestId("meeting-line-stop-now").click();
      }
      await expect.poll(() => meetingStatuses(window)).toEqual(["stopped"]);
      await expect(line).toHaveCount(0);
    };
    await (language === "en" ? film(window, flow) : flow());
    await app.close();
  });
}

test("ignoring or declining an offer never records, and Don't ask turns that app off", async () => {
  const { app, window } = await launch();
  await dismissChatSetup(window);
  await setUpMeetings(window);

  await callsUse(app, ["teams"]);
  await expect.poll(async () => (await notifications(app)).length).toBe(1);
  await callsUse(app, []);
  // The call ends without a click: the offer goes after the call is over, and nothing recorded.
  await expect.poll(() => notifications(app), { timeout: 20_000 }).toEqual([]);
  expect(await meetingStatuses(window)).toEqual([]);

  await callsUse(app, ["slack"]);
  await expect.poll(async () => (await notifications(app)).length).toBe(1);
  await clickNotification(app, "offer", 1);
  await expect
    .poll(async () =>
      (await bridge(window)).evaluate(
        async (core) => (await core.getSettings()).device.callOffersOff,
      ),
    )
    .toEqual(["slack"]);
  await expect.poll(() => notifications(app)).toEqual([]);
  expect(await meetingStatuses(window)).toEqual([]);
  await app.close();
});

test("with the tray icon on, closing the window keeps IncarnaMind running, and its menu opens the window and quits", async () => {
  const { app, window } = await launch();
  await dismissChatSetup(window);
  // On from a new data folder's first start (#3758).
  await expect.poll(() => trayShown(app)).toBe(true);
  expect(await trayItems(app)).toEqual(
    expect.arrayContaining(["Open IncarnaMind", "Quit IncarnaMind"]),
  );

  const closed = window.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => {
    for (const each of BrowserWindow.getAllWindows()) if (each.isVisible()) each.close();
  });
  await closed;
  // Still running: the main process answers, with no window of the app's open.
  expect(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((each) => each.isVisible()).length,
    ),
  ).toBe(0);

  const reopened = app.waitForEvent("window");
  await clickTray(app, "tray.open");
  const window2 = await reopened;
  await expect(window2.getByTestId("plus-menu")).toBeVisible();

  const exited = new Promise<void>((resolve) => app.process().once("exit", () => resolve()));
  await clickTray(app, "tray.quit");
  await exited;
});

test("once a calendar is connected, Settings › General shows its offers' switch, and turning it off is kept", async () => {
  const { app, window } = await launchApp(dataDir, {
    extraEnv: { INCARNAMIND_TEST_CALLS: "1" },
    systemCalendar: {
      access: "allowed",
      calendars: [{ id: "home", title: "Home", source: "iCloud", kind: "caldav" }],
      events: [],
    },
  });
  await dismissChatSetup(window);
  await setUpMeetings(window);
  const settings = await openSettings(window, "general");
  await expect(settings.getByTestId("call-offers")).toBeVisible();
  await expect(settings.getByTestId("calendar-offers-switch")).toHaveCount(0);

  await (await bridge(window)).evaluate((core) => core.connectCalendar("mac"));
  const calendarSwitch = settings.getByTestId("calendar-offers-switch");
  await expect(calendarSwitch).toBeChecked();
  await calendarSwitch.click();
  await expect(calendarSwitch).not.toBeChecked();
  await expect
    .poll(async () =>
      (await bridge(window)).evaluate(
        async (core) => (await core.getSettings()).device.calendarOffers,
      ),
    )
    .toBe(false);
  await app.close();
});

test("a click on the notification itself records nothing: Home shows the offer, and its Take notes records", async () => {
  const { app, window } = await launch();
  await dismissChatSetup(window);
  await setUpMeetings(window);
  await callsUse(app, ["zoom"]);
  await expect.poll(async () => (await notifications(app)).length).toBe(1);

  await clickNotification(app, "offer");
  const line = window.getByTestId("call-offer-line");
  await expect(line).toContainText("Are you in a call right now? Zoom is using the microphone");
  expect(await meetingStatuses(window)).toEqual([]);
  expect(await notifications(app)).toHaveLength(1);

  await line.getByTestId("call-offer-take").click();
  await expect(window.getByTestId("meeting-foot")).toHaveAttribute("data-status", "recording");
  await expect(line).toHaveCount(0);
  await app.close();
});

test("someone who set up Meetings before this version is asked once on Home, and Turn on turns the offers on", async () => {
  startedBefore(dataDir);
  const { app, window } = await launch();
  await dismissChatSetup(window);
  // Set up before the offers were built: the notice read, and nothing else.
  await (await bridge(window)).evaluate((core) =>
    core.updateSettings({ device: { meetingNoticeAccepted: true } }),
  );
  await window.getByTestId("sidebar-home").click();
  const tip = window.getByTestId("call-offers-tip");
  if (process.platform === "win32") {
    await expect(window.getByTestId("sidebar-home")).toBeVisible();
    await expect(tip).toHaveCount(0);
    expect((await deviceSettings(window)).callOffers).toBe(false);
    await app.close();
    return;
  }
  await expect(tip).toBeVisible();
  expect(await deviceSettings(window)).toMatchObject({ callOffers: false, keepRunning: false });
  await callsUse(app, ["zoom"]);
  expect(await notifications(app)).toEqual([]);

  await tip.getByTestId("call-offers-turn-on").click();
  await expect(tip).toHaveCount(0);
  await expect
    .poll(() => deviceSettings(window))
    .toMatchObject({ callOffers: true, keepRunning: true });
  await expect.poll(() => loginItem(dataDir)).toEqual({ on: true });
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`in a data folder an earlier version started, a first recording starts at once and turns nothing else on; Home then asks once to turn the offers on (${language})`, async () => {
    startedBefore(dataDir);
    const { app, window } = await launch();
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await recordMeeting(window);
    await expect
      .poll(() => deviceSettings(window))
      .toMatchObject({ meetingNoticeAccepted: true, callOffers: false, keepRunning: false });
    expect(await loginItem(dataDir)).toBeNull();
    await stopMeeting(window);
    await window.getByTestId("sidebar-home").click();
    await expect(window.getByTestId("home")).toBeVisible();
    const tip = window.getByTestId("call-offers-tip");
    // Windows can't notice calls yet (#2843): Home asks nothing there.
    if (process.platform === "win32") {
      await expect(tip).toHaveCount(0);
    } else {
      await expect(tip.getByTestId("call-offers-turn-on")).toHaveText(
        language === "en" ? "Turn on" : "开启",
      );
      await expect(tip).toContainText(language === "en" ? "Open at login in the" : "登录时在");
    }
    expect(await deviceSettings(window)).toMatchObject({ callOffers: false, keepRunning: false });
    await app.close();
  });
}

test("in a new data folder, a first recording starts at once and turns nothing else on, and Home has nothing to ask", async () => {
  const { app, window } = await launch();
  await dismissChatSetup(window);
  const before = await deviceSettings(window);
  expect(before).toMatchObject({
    meetingNoticeAccepted: false,
    callOffers: true,
    keepRunning: true,
  });
  await recordMeeting(window);
  await expect
    .poll(() => deviceSettings(window))
    .toMatchObject({
      meetingNoticeAccepted: true,
      callOffers: true,
      keepRunning: true,
      calendarOffers: before.calendarOffers,
    });
  expect(await loginItem(dataDir)).toEqual({ on: true });
  await stopMeeting(window);
  await window.getByTestId("sidebar-home").click();
  await expect(window.getByTestId("home")).toBeVisible();
  await expect(window.getByTestId("call-offers-tip")).toHaveCount(0);
  await app.close();
});

/** Settings › General's three switches, as the User sees them. */
async function backgroundSwitches(window: Page) {
  const settings = await openSettings(window, "general");
  const switches = {
    openAtLogin: settings.getByTestId("open-at-login-switch"),
    keepRunning: settings.getByTestId("keep-running-switch"),
    callOffers: settings.getByTestId("call-offers-switch"),
  };
  await expect(switches.openAtLogin).toBeVisible();
  return { settings, switches };
}

test("a new data folder opens at login, keeps running in the tray and offers calls from its first start; each turned off stays off after a restart", async () => {
  const first = await launch();
  await dismissChatSetup(first.window);
  await setWindowSize(first.app, first.window, 1100, 760);
  const { switches } = await backgroundSwitches(first.window);
  for (const each of Object.values(switches)) await expect(each).toBeChecked();
  expect(await loginItem(dataDir)).toEqual({ on: true });
  await expect.poll(() => trayShown(first.app)).toBe(true);
  // Before any Meeting is recorded, a call is offered.
  await callsUse(first.app, ["zoom"]);
  await expect.poll(async () => (await notifications(first.app)).length).toBe(1);
  await callsUse(first.app, []);

  for (const each of Object.values(switches)) {
    await each.click();
    await expect(each).not.toBeChecked();
  }
  await expect.poll(() => loginItem(dataDir)).toEqual({ on: false });
  await expect.poll(() => trayShown(first.app)).toBe(false);
  await first.app.close();

  const next = await launch();
  await dismissChatSetup(next.window);
  const { switches: again } = await backgroundSwitches(next.window);
  for (const each of Object.values(again)) await expect(each).not.toBeChecked();
  expect(await loginItem(dataDir)).toEqual({ on: false });
  expect(await trayShown(next.app)).toBe(false);
  await callsUse(next.app, ["zoom"]);
  expect(await notifications(next.app)).toEqual([]);
  await next.app.close();
});

test("a data folder an earlier version started keeps its switches off, and its login items untouched", async () => {
  startedBefore(dataDir);
  const { app, window } = await launch();
  await dismissChatSetup(window);
  const { switches } = await backgroundSwitches(window);
  for (const each of Object.values(switches)) await expect(each).not.toBeChecked();
  expect(await loginItem(dataDir)).toBeNull();
  expect(await trayShown(app)).toBe(false);
  await app.close();
});

test("an offer taken before the first recording records the call at once, and the sheet's one line says to tell everyone", async () => {
  const { app, window } = await launch();
  await dismissChatSetup(window);
  await callsUse(app, ["zoom"]);
  await expect.poll(async () => (await notifications(app)).length).toBe(1);
  expect(await meetingStatuses(window)).toEqual([]);

  await clickNotification(app, "offer", 0);
  await expect(window.getByTestId("meeting-foot")).toHaveAttribute("data-status", "recording");
  expect(await meetingStatuses(window)).toEqual(["recording"]);
  await expect.poll(() => notifications(app)).toEqual([]);
  const sheet = await openMeetingSheet(window);
  await expect(sheet.locator(".meeting-sheet-consent")).toHaveText(
    "Tell everyone you’re recording.",
  );
  expect((await deviceSettings(window)).meetingNoticeAccepted).toBe(true);
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`where calls can't be noticed, Calls not on your calendar stays off from the first start and says why (${language})`, async () => {
    const shots = async (app: ElectronApplication, window: Page, name: string) => {
      for (const [width, height] of [
        [1440, 900],
        [900, 640],
      ] as const) {
        await setWindowSize(app, window, width, height);
        await window.getByTestId("call-offers").scrollIntoViewIfNeeded();
        await window.mouse.move(0, 0);
        await shot(window, `${name}-${language}-${width}`);
      }
    };
    const why =
      language === "en"
        ? "Needs PulseAudio’s pactl, which isn’t on this computer."
        : "需要 PulseAudio 的 pactl，这台电脑上没有。";

    const cant = await launchApp(dataDir, {
      extraEnv: { INCARNAMIND_TEST_CALLS: "1", INCARNAMIND_TEST_CALLS_PROBLEM: "no-pactl" },
    });
    await dismissChatSetup(cant.window);
    await setWindowSize(cant.app, cant.window, 1440, 900);
    const settings = await openSettings(cant.window, "general");
    await setLanguage(cant.window, language);
    await expect(settings.getByTestId("call-offers-switch")).not.toBeChecked();
    await expect(settings.getByTestId("call-offers-problem")).toHaveText(why);
    await shots(cant.app, cant.window, "settings-calls-off-cant");
    await cant.app.close();

    // The same row where calls can be noticed, turned off: no reason under it.
    const other = await createDataFolder();
    try {
      const can = await launchApp(other, { extraEnv: { INCARNAMIND_TEST_CALLS: "1" } });
      await dismissChatSetup(can.window);
      await setWindowSize(can.app, can.window, 1440, 900);
      const page = await openSettings(can.window, "general");
      await setLanguage(can.window, language);
      await page.getByTestId("call-offers-switch").click();
      await expect(page.getByTestId("call-offers-switch")).not.toBeChecked();
      await expect(page.getByTestId("call-offers-problem")).toHaveCount(0);
      await shots(can.app, can.window, "settings-calls-off-can");
      await can.app.close();
    } finally {
      await removeDataFolder(other);
    }
  });
}

for (const from of ["notification", "tray"] as const) {
  test(`with the window closed, Take notes in the ${from} before the first recording opens a window recording the call at once`, async () => {
    const { app, window } = await launch();
    await dismissChatSetup(window);
    await expect.poll(() => trayShown(app)).toBe(true);
    const closed = window.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => {
      for (const each of BrowserWindow.getAllWindows()) if (each.isVisible()) each.close();
    });
    await closed;

    await callsUse(app, ["zoom"]);
    await expect.poll(async () => (await notifications(app)).length).toBe(1);
    if (from === "notification") await clickNotification(app, "offer", 0);
    else await clickTray(app, "tray.takeNotes");
    const next = await appWindow(app);
    await expect(next.getByTestId("meeting-foot")).toHaveAttribute("data-status", "recording");
    expect(await meetingStatuses(next)).toEqual(["recording"]);
    await app.close();
  });
}

test("Home's Take notes before the first recording records at once too", async () => {
  const { app, window } = await launch();
  await dismissChatSetup(window);
  await callsUse(app, ["zoom"]);
  await expect.poll(async () => (await notifications(app)).length).toBe(1);
  await clickNotification(app, "offer");
  const line = window.getByTestId("call-offer-line");
  await expect(line).toBeVisible();
  expect(await meetingStatuses(window)).toEqual([]);

  await line.getByTestId("call-offer-take").click();
  await expect(window.getByTestId("meeting-foot")).toHaveAttribute("data-status", "recording");
  expect(await meetingStatuses(window)).toEqual(["recording"]);
  await expect(line).toHaveCount(0);
  await app.close();
});

// protects=Home's line turns both the offers and running in the background on, so it never shows while running in the background is already on, and a switch the User changes in Settings ends it for good; fails_when=the line offers what is already on, or asks again after the User chose in Settings
test("Home never asks to turn the offers on while running in the background is on, nor once the User turned that off in Settings", async () => {
  startedBefore(dataDir);
  const { app, window } = await launch();
  await dismissChatSetup(window);
  // Running in the background on, as an earlier version left it; the offers to take notes off.
  await (await bridge(window)).evaluate((core) =>
    core.updateSettings({ device: { keepRunning: true } }),
  );

  await recordMeeting(window);
  await stopMeeting(window);
  await window.getByTestId("sidebar-home").click();
  await expect(window.getByTestId("home")).toBeVisible();
  // A round trip to the core after Home shows, so a line Home would show has shown.
  await expect
    .poll(() => deviceSettings(window))
    .toMatchObject({ meetingNoticeAccepted: true, callOffers: false, keepRunning: true });
  const tip = window.getByTestId("call-offers-tip");
  await expect(tip).toHaveCount(0);

  // Turned off in Settings, both are off, and the User chose there: Home still asks nothing.
  const settings = await openSettings(window, "general");
  await settings.getByTestId("keep-running-switch").click();
  await expect(settings.getByTestId("keep-running-switch")).not.toBeChecked();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await window.getByTestId("sidebar-home").click();
  await expect(window.getByTestId("home")).toBeVisible();
  await expect
    .poll(() => deviceSettings(window))
    .toMatchObject({ callOffers: false, keepRunning: false });
  await expect(tip).toHaveCount(0);
  await app.close();
});
