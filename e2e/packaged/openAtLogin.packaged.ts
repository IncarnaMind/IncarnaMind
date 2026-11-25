import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { AUTOSTART_FILE, OPENED_AT_LOGIN } from "../../src/main/loginItem";
import { dismissChatSetup, openSettings } from "../app";
import { launchPackaged } from "./app";

/*
 * The packaged app's first start on its own data folder adds it to the system's login items
 * (#3758), and removing it in Settings or in the system is kept at the next start. Only the app
 * as released, on its own data folder, touches them, so this launch can't take a temporary one: it
 * runs on a CI runner only, and takes the login item and the data folder away when it ends.
 */

test.skip(!process.env.CI, "It adds the app to this computer's login items: CI runners only.");
test.use({ trace: "off" });
test.setTimeout(5 * 60_000);

const args = process.platform === "win32" ? [OPENED_AT_LOGIN] : undefined;

/** Whether the system lists IncarnaMind to open at login: macOS may wait for the User's approval. */
async function listed(app: ElectronApplication, home: string): Promise<boolean> {
  if (process.platform === "linux") {
    return existsSync(join(home, ".config", "autostart", AUTOSTART_FILE));
  }
  return app.evaluate(({ app: electron }, given) => {
    const settings = electron.getLoginItemSettings(given ? { args: given } : undefined);
    return settings.openAtLogin || settings.status === "requires-approval";
  }, args);
}

/** Takes it out where the system keeps it, as the User would in its own settings. */
async function removeFromSystem(app: ElectronApplication, home: string): Promise<void> {
  if (process.platform === "linux") {
    await rm(join(home, ".config", "autostart", AUTOSTART_FILE), { force: true });
    return;
  }
  await app.evaluate(({ app: electron }, given) => {
    electron.setLoginItemSettings({ openAtLogin: false, ...(given && { args: given }) });
  }, args);
}

async function loginSwitch(window: Page) {
  await dismissChatSetup(window);
  const settings = await openSettings(window, "general");
  return settings.getByTestId("open-at-login-switch");
}

test("after a first start the system lists IncarnaMind as a login item, and removing it in Settings or in the system is kept", async () => {
  const home = await mkdtemp(join(tmpdir(), "incarnamind-login-home-"));
  let app = await launchPackaged(home, null, { testHooks: true });
  const dataDir = await app.evaluate(({ app: electron }) => electron.getPath("userData"));
  const startAgain = async () => {
    await app.close();
    app = await launchPackaged(home, null, { testHooks: true });
    return loginSwitch(await app.firstWindow());
  };
  try {
    let open = await loginSwitch(await app.firstWindow());
    await expect(open).toBeChecked();
    expect(await listed(app, home)).toBe(true);

    await test.step("Turned off in Settings, it stays off", async () => {
      await open.click();
      await expect(open).not.toBeChecked();
      await expect.poll(() => listed(app, home)).toBe(false);
      open = await startAgain();
      await expect(open).not.toBeChecked();
      expect(await listed(app, home)).toBe(false);
    });

    await test.step("Removed in the system, it stays off", async () => {
      await open.click();
      await expect(open).toBeChecked();
      await expect.poll(() => listed(app, home)).toBe(true);
      await removeFromSystem(app, home);
      open = await startAgain();
      await expect(open).not.toBeChecked();
      expect(await listed(app, home)).toBe(false);
    });
  } finally {
    // The runner keeps no login item, whatever step failed: a closed app is started to take it away.
    await removeFromSystem(app, home).catch(async () => {
      app = await launchPackaged(home, null);
      await removeFromSystem(app, home);
    });
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
