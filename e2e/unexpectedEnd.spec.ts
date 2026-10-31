import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import type { FilesBridge } from "../src/shared/bridge";
import {
  createDataFolder,
  dismissChatSetup,
  forceQuit,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
} from "./app";

/*
 * How the app ends (#2309): the log says what asked it to quit (its menu, a signal, something
 * outside) and how a window's page crashed. A page that crashed loads again and says so; after a
 * run that ended without quitting, the next start says IncarnaMind closed unexpectedly, and what
 * was kept. A quit says nothing at the next start.
 */

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const logOf = () => readFile(join(dataDir, "logs", "incarnamind.log"), "utf8");
/** The log from its last start on. */
const lastRunOf = async () => (await logOf()).split(/^(?=.* app\.start )/m).at(-1) ?? "";

/** The bridge's answer, then a frame: by then the window has drawn what it took at its start. */
const takenAgain = (window: Page) =>
  window.evaluate(async () => {
    const files = (globalThis as unknown as { incarnamindFiles: FilesBridge }).incarnamindFiles;
    const ended = await files.takeUnexpectedEnd();
    await new Promise(requestAnimationFrame);
    return ended;
  });

const appWindowProcess = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((each) =>
      each.webContents.getURL().includes("window=main"),
    );
    if (!main) throw new Error("The app's window isn't there.");
    return main.webContents.getOSProcessId();
  });

/** Chooses Quit in the app's menu, or with its keys, and waits until the app has closed. */
async function quitFromMenu(app: ElectronApplication, byKeys: boolean): Promise<void> {
  const closed = new Promise<void>((resolve) => app.once("close", () => resolve()));
  await app.evaluate(({ Menu }, triggeredByAccelerator) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("app.quit");
    if (!item) throw new Error("The menu has no Quit.");
    item.click({ triggeredByAccelerator });
  }, byKeys);
  await closed;
}

test("a window whose page crashes loads it again, says so once, and the log names the crash", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  await nameMind(window, "Kept through the crash");
  const notice = window.getByTestId("unexpected-end");
  await expect(window.getByTestId("plus-menu")).toBeVisible();
  await expect(notice).toHaveCount(0);

  process.kill(await appWindowProcess(app), "SIGKILL");

  await expect(notice.locator("p")).toHaveText(
    "This window stopped unexpectedly and reopened. Everything was kept.",
  );
  await expect(window.getByTestId("sidebar")).toContainText("Kept through the crash");
  await screenshot(window, "window-reopened-en");
  const log = await logOf();
  expect(log).toMatch(/ ERROR window\.crashed page=index\.html reason=killed exitCode=-?\d+\n/);
  expect(log).toMatch(/ INFO {2}window\.reopened reason=killed\n/);
  expect(log).not.toContain("window.notReopened");

  await window.getByTestId("unsaved-lost-dismiss").click();
  await expect(notice).toHaveCount(0);
  await expect(window.getByTestId("sidebar")).toContainText("Kept through the crash");
  expect(await takenAgain(window)).toBeNull();

  await quitFromMenu(app, false);
  expect(await lastRunOf()).toMatch(
    / INFO {2}app\.quitAsked by=menu\n.* INFO {2}app\.quit\n.* INFO {2}app\.exited pid=\d+ code=0\n/s,
  );
});

test("after a run is killed the next start says IncarnaMind closed, in Chinese; a quit says nothing", async () => {
  const first = await launchApp(dataDir);
  await dismissChatSetup(first.window);
  await (
    await first.window.evaluateHandle(
      () => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind,
    )
  ).evaluate((core) => core.updateSettings({ user: { language: "zh-CN" } }));
  await newMind(first.window);
  await nameMind(first.window, "关闭前的笔记");
  await forceQuit(first.app);

  const second = await launchApp(dataDir);
  const notice = second.window.getByTestId("unexpected-end");
  await expect(notice.locator("p")).toHaveText("IncarnaMind 意外关闭，关闭前的内容都已保留。");
  await expect(second.window.getByTestId("sidebar")).toContainText("关闭前的笔记");
  await screenshot(second.window, "closed-unexpectedly-zh");
  expect(await lastRunOf()).toMatch(
    / WARN {2}app\.lastRunEndedUnexpectedly pid=\d+ startedAt=\S+\n/,
  );
  expect(await takenAgain(second.window)).toBeNull();

  // A signal asks the app to quit, as `kill` does: it quits as asked, and says which.
  const closed = new Promise<void>((resolve) => second.app.once("close", () => resolve()));
  const pid = second.app.process().pid;
  if (pid === undefined) throw new Error("The app has no process.");
  process.kill(pid, "SIGTERM");
  await closed;
  expect(await lastRunOf()).toMatch(
    new RegExp(
      ` INFO {2}app\\.quitAsked by=signal signal=SIGTERM\\n.* INFO {2}app\\.quit\\n.* INFO {2}app\\.exited pid=${pid} code=0\\n`,
      "s",
    ),
  );

  const third = await launchApp(dataDir);
  await expect(third.window.getByTestId("sidebar")).toContainText("关闭前的笔记");
  expect(await takenAgain(third.window)).toBeNull();
  await expect(third.window.getByTestId("unexpected-end")).toHaveCount(0);
  expect(await lastRunOf()).not.toContain("app.lastRunEndedUnexpectedly");

  // Its keys quit it too, and anything outside the app (here, the test's own close) is named so.
  await quitFromMenu(third.app, true);
  expect(await lastRunOf()).toMatch(/ INFO {2}app\.quitAsked by=shortcut\n/);
  const fourth = await launchApp(dataDir);
  await fourth.app.close();
  expect(await lastRunOf()).toMatch(/ INFO {2}app\.quitAsked by=outside\n.* INFO {2}app\.quit\n/s);
});
