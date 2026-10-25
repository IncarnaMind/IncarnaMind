import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { FakeCapture } from "../src/core/meetings/fakeCapture";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  startRecording,
} from "./app";

/*
 * The guide beside System Settings (#1105): where recording lacks a permission the User adds by
 * hand, "Open System Settings" also opens a small window beside it that says what to click, notices
 * the grant (here a fake answer: no test can switch a real permission), says what to do next and
 * closes itself; ✕ or Esc closes it; where it can't sit beside System Settings, the steps show in
 * the app's window as text.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const guideOf = (app: ElectronApplication) =>
  app.windows().find((window) => window.url().includes("permissionGuide"));

async function guideWindow(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => guideOf(app) !== undefined).toBe(true);
  const guide = guideOf(app);
  if (!guide) throw new Error("The guide has no window.");
  return guide;
}

const grant = (app: ElectronApplication, source: "microphone" | "system") =>
  app.evaluate((_electron, which) => {
    const scope = globalThis as { incarnamindFakePermission?: Record<string, string> };
    scope.incarnamindFakePermission = { ...scope.incarnamindFakePermission, [which]: "granted" };
  }, source);

const settingsOpened = (app: ElectronApplication) =>
  app.evaluate(() => {
    const fake = (globalThis as { incarnamindFakeAudio?: FakeCapture }).incarnamindFakeAudio;
    return [...(fake?.settingsOpened ?? [])];
  });

async function recordWithSoundDenied(app: ElectronApplication, window: Page) {
  await dismissChatSetup(window);
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  await expect(window.getByTestId("meeting-line-system")).toBeVisible();
  return { app, bar };
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the computer's sound: Open System Settings shows the guide beside it, which notices the grant, says what to do next and closes itself (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, {
      computerSound: "denied",
      permissionGuide: "beside",
    });
    await recordWithSoundDenied(app, window);
    await setLanguage(window, language);

    const open = window.getByTestId("meeting-settings-system");
    await pointAndClick(window, open);
    await expect.poll(() => settingsOpened(app)).toEqual(["system"]);
    const guide = await guideWindow(app);
    const card = guide.getByTestId("permission-guide");
    await expect(card).toHaveAttribute("data-status", "waiting");
    // It shows once its steps are drawn and it has its size: never as a blank box.
    const bounds = () =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((each) =>
          each.webContents.getURL().includes("permissionGuide"),
        );
        return window ? { visible: window.isVisible(), height: window.getBounds().height } : null;
      });
    await expect.poll(async () => (await bounds())?.visible).toBe(true);
    expect((await bounds())?.height).not.toBe(280);
    const words = {
      en: ["Allow the computer’s sound", "Privacy & Security › Screen & System Audio Recording"],
      "zh-CN": ["允许录制电脑声音", "隐私与安全性 › 录屏与系统录音"],
    }[language];
    for (const text of words) await expect(card).toContainText(text);
    await expect(card.getByRole("listitem")).toHaveText(
      language === "en"
        ? ["1Find IncarnaMind in the list.", "2Switch it on."]
        : ["1在列表中找到 IncarnaMind。", "2打开开关。"],
    );
    await expect(card.getByTestId("permission-guide-status")).toHaveText(
      language === "en" ? "Waiting for you…" : "等你操作…",
    );
    // The line where recording lacked the permission stays, and the app's window shows no steps.
    await expect(window.getByTestId("meeting-line-system")).toBeVisible();
    await expect(window.getByTestId("meeting-line-guide")).toHaveCount(0);

    const closed = guide.waitForEvent("close");
    await grant(app, "system");
    await expect(card).toHaveAttribute("data-status", "granted");
    await expect(card.getByTestId("permission-guide-status")).toHaveText(
      language === "en"
        ? "Done. Quit and reopen IncarnaMind, then record again, to record the computer’s sound."
        : "好了。退出并重新打开 IncarnaMind，再重新录制，就能录到电脑声音。",
    );
    await closed;
    expect(guideOf(app)).toBeUndefined();
    await app.close();
  });
}

test("the microphone: the guide names it, ✕ closes it, and so does Esc once it has the focus", async () => {
  const { app, window } = await launchApp(dataDir, {
    microphone: "denied",
    permissionGuide: "beside",
  });
  await dismissChatSetup(window);
  await startRecording(window, await recordMeeting(window), { notice: true });
  await pointAndClick(window, window.getByTestId("meeting-settings-microphone"));
  await expect.poll(() => settingsOpened(app)).toEqual(["microphone"]);

  const guide = await guideWindow(app);
  const card = guide.getByTestId("permission-guide");
  await expect(card).toContainText("Allow the microphone");
  await expect(card).toContainText("Privacy & Security › Microphone");
  const closed = guide.waitForEvent("close");
  // The window closes under the click: Playwright then says the page went away.
  await guide
    .getByTestId("permission-guide-close")
    .click()
    .catch(() => undefined);
  await closed;
  await expect.poll(() => guideOf(app)).toBeUndefined();

  await pointAndClick(window, window.getByTestId("meeting-settings-microphone"));
  const again = await guideWindow(app);
  await expect(again.getByTestId("permission-guide")).toBeVisible();
  const closedAgain = again.waitForEvent("close");
  // The window closes under the key press: Playwright says the page went away.
  await again.keyboard.press("Escape").catch(() => undefined);
  await closedAgain;
  await expect.poll(() => guideOf(app)).toBeUndefined();
  await grant(app, "microphone");
  await app.close();
});

test("where the guide can't sit beside System Settings, the steps show in the window as text, until the grant or Dismiss", async () => {
  const { app, window } = await launchApp(dataDir, {
    computerSound: "denied",
    permissionGuide: "inline",
  });
  await recordWithSoundDenied(app, window);

  await pointAndClick(window, window.getByTestId("meeting-settings-system"));
  await expect.poll(() => settingsOpened(app)).toEqual(["system"]);
  const steps = window.getByTestId("meeting-line-guide");
  await expect(steps).toContainText(
    "In System Settings, open Privacy & Security › Screen & System Audio Recording, find IncarnaMind in the list and switch it on.",
  );
  expect(guideOf(app)).toBeUndefined();
  await expect(window.getByTestId("meeting-line-system")).toBeVisible();

  await grant(app, "system");
  await expect(steps).toContainText("Done. Quit and reopen IncarnaMind");
  // It stays, with the page where it was, until the User dismisses it.
  await pointAndClick(window, window.getByTestId("meeting-line-guide-close"));
  await expect(steps).toHaveCount(0);

  await pointAndClick(window, window.getByTestId("meeting-settings-system"));
  await expect(steps).toContainText("Done. Quit and reopen IncarnaMind");
  await app.close();
});
