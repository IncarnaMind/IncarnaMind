import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import type { BackgroundTestHooks } from "../src/main/backgroundHost";
import type { FakeCalls } from "../src/main/calls/fakeWatcher";
import { windowsWatchScript } from "../src/main/calls/windowsScript";
import {
  createDataFolder,
  dismissChatSetup,
  film,
  launchApp,
  motionSettled,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * IncarnaMind in the background and its offers to take notes (#189, #208): Settings › General's
 * switches, the tray icon's menu, closing the window, and an offer when a call app takes the
 * microphone, which records only on Take notes and stops when the call ends. The call watcher is
 * a fake the test drives; nothing reads the computer's microphone.
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

const setUpMeetings = async (window: Page) =>
  (await bridge(window)).evaluate((core) =>
    core.updateSettings({ device: { meetingNoticeAccepted: true, keepRunning: true } }),
  );

const meetingStatuses = async (window: Page) =>
  (await bridge(window)).evaluate(async (core) =>
    (await core.listMeetings()).map((each) => each.status),
  );

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

    // Opening at login goes through the login item, which a test build keeps in its data folder.
    await settings.getByTestId("open-at-login-switch").click();
    await expect(settings.getByTestId("open-at-login-switch")).toBeChecked();
    await expect
      .poll(async () => JSON.parse(await readFile(join(dataDir, "login-item.json"), "utf8")))
      .toEqual({ on: true });

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

  test(`a call app taking the microphone is offered; Take notes records, and the call's end stops it (${language})`, async () => {
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
      const bar = window.getByTestId("meeting-bar");
      await expect(bar).toHaveAttribute("data-status", "recording");
      await expect.poll(() => notifications(app)).toEqual([]);
      await shot(window, `offer-taken-recording-${language}`);

      // Zoom lets go of the microphone: the bar says it will stop, and Stop now stops it.
      await callsUse(app, []);
      const line = window.getByTestId("meeting-line-call-ended");
      await expect(line).toContainText(
        language === "en" ? "Did your meeting end?" : "会议结束了吗？",
      );
      await expect
        .poll(async () => (await notifications(app)).map((each) => each.kind))
        .toEqual(["ending"]);
      await shot(window, `offer-call-ended-${language}`);
      await line.getByTestId("meeting-line-stop-now").click();
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
  await expect.poll(() => trayShown(app)).toBe(false);
  await setUpMeetings(window);
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

// The Windows watcher as the app runs it, on the system's own PowerShell: it answers at once,
// and stops once the process that started it is gone.
test("on Windows, the call watcher's PowerShell says which apps use the microphone, and ends with its parent", async () => {
  test.skip(process.platform !== "win32", "Windows only");
  const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  if (parent.pid === undefined) throw new Error("No parent process.");
  const watcher = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsWatchScript(parent.pid)],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let said = "";
  watcher.stderr.on("data", (data: Buffer) => {
    said += data.toString();
  });
  const first = await new Promise<string>((resolve) =>
    createInterface({ input: watcher.stdout }).once("line", resolve),
  );
  expect(said).toBe("");
  expect(JSON.parse(first)).toEqual({ apps: expect.any(Array) });
  const ended = new Promise<number | null>((resolve) => watcher.on("exit", resolve));
  parent.kill();
  expect(await ended).toBe(0);
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
