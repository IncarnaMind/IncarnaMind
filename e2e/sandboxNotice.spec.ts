/**
 * When the app runs without Chromium's sandbox (--no-sandbox or ELECTRON_DISABLE_SANDBOX), the
 * sidebar's status row says so, with How to fix and a dismiss that keeps it away, and Settings ›
 * Privacy says so as long as it is true (#1179). Started normally, nothing says it.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  closeSettings,
  createDataFolder,
  interceptOpenExternal,
  launchApp,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  urlsOpened,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const status = (window: Page) => window.getByTestId("sidebar-status").getByTestId("no-sandbox");

for (const way of ["switch", "environment"] as const) {
  test(`started with ${way === "switch" ? "--no-sandbox" : "ELECTRON_DISABLE_SANDBOX"}: the status row says so in English and Chinese, a dismissed line stays away, and Privacy still says it`, async () => {
    const first = await launchApp(dataDir, { sandboxNotice: way });
    await setWindowSize(first.app, first.window, 1280, 800);
    await expect(status(first.window).getByTestId("status-label")).toHaveText(
      "Running without the app’s sandbox",
    );
    await expect(status(first.window).getByTestId("no-sandbox-fix")).toHaveText("How to fix");
    await setLanguage(first.window, "zh-CN");
    await expect(status(first.window).getByTestId("status-label")).toHaveText(
      "应用正在没有沙盒的情况下运行",
    );
    await expect(status(first.window).getByTestId("no-sandbox-fix")).toHaveText("如何解决");
    await setLanguage(first.window, "en");

    await status(first.window).getByRole("button", { name: "Dismiss" }).focus();
    await first.window.keyboard.press("Enter");
    await expect(status(first.window)).toHaveCount(0);
    const settings = await openSettings(first.window, "privacy");
    await expect(settings.getByTestId("privacy-no-sandbox")).toContainText(
      "Running without the app’s sandbox",
    );
    await first.app.close();

    const second = await launchApp(dataDir, { sandboxNotice: way });
    await setWindowSize(second.app, second.window, 1280, 800);
    await expect(second.window.getByTestId("sidebar")).toBeVisible();
    await expect(status(second.window)).toHaveCount(0);
    const again = await openSettings(second.window, "privacy");
    await expect(again.getByTestId("privacy-no-sandbox")).toBeVisible();
    await second.app.close();
  });
}

test("How to fix opens the page that says how, from the keyboard, in the status row and in Privacy", async () => {
  const { app, window } = await launchApp(dataDir, { sandboxNotice: "switch" });
  await setWindowSize(app, window, 1280, 800);
  await interceptOpenExternal(app);
  const page = "https://github.com/IncarnaMind/IncarnaMind/blob/main/docs/linux-sandbox.md";

  await status(window).getByTestId("no-sandbox-fix").focus();
  await window.keyboard.press("Enter");
  await expect.poll(() => urlsOpened(app)).toEqual([page]);

  const settings = await openSettings(window, "privacy");
  await settings.getByTestId("privacy-no-sandbox-fix").focus();
  await window.keyboard.press("Enter");
  await expect.poll(() => urlsOpened(app)).toEqual([page, page]);
  await closeSettings(window);
  await app.close();
});

test("started normally, nothing says the sandbox is off, in the status row or in Privacy", async () => {
  const { app, window } = await launchApp(dataDir, { sandboxNotice: "on" });
  await setWindowSize(app, window, 1280, 800);
  await expect(window.getByTestId("sidebar")).toBeVisible();
  await expect(status(window)).toHaveCount(0);
  const settings = await openSettings(window, "privacy");
  await expect(settings.getByTestId("privacy-settings")).toBeVisible();
  await expect(settings.getByTestId("privacy-no-sandbox")).toHaveCount(0);
  await app.close();
});
