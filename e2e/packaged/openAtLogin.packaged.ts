import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { AUTOSTART_FILE, OPENED_AT_LOGIN } from "../../src/main/loginItem";
import { dismissChatSetup, openSettings } from "../app";
import { launchPackaged, packagedLogLines } from "./app";

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

/**
 * Windows finds the app's own data folder in the profile's AppData, and the profile is the
 * temporary home: its AppData is made first, as a real profile has it.
 */
async function profileFolders(home: string): Promise<Record<string, string>> {
  if (process.platform !== "win32") return {};
  const folders = {
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
  };
  for (const folder of Object.values(folders)) await mkdir(folder, { recursive: true });
  return folders;
}

/** Where the app's own data folder may be, for its log when a start fails before it says. */
const ownFolders = (home: string): string[] =>
  [
    join(home, "AppData", "Roaming", "IncarnaMind"),
    join(home, ".config", "IncarnaMind"),
    join(home, "Library", "Application Support", "IncarnaMind"),
    join(homedir(), "Library", "Application Support", "IncarnaMind"),
    process.env.APPDATA && join(process.env.APPDATA, "IncarnaMind"),
  ].filter((folder): folder is string => typeof folder === "string");

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
  const env = await profileFolders(home);
  const launch = () =>
    launchPackaged(home, null, {
      testHooks: true,
      env,
      extraEnv: { ELECTRON_ENABLE_LOGGING: "1" },
    });
  const state: { app: ElectronApplication | null; started: boolean } = {
    app: null,
    started: false,
  };
  const running = (): ElectronApplication => {
    if (!state.app) throw new Error("The app isn't running.");
    return state.app;
  };
  const startAgain = async () => {
    await state.app?.close();
    state.app = null;
    const app = await launch();
    state.app = app;
    state.started = true;
    return loginSwitch(await app.firstWindow());
  };
  try {
    let open = await startAgain();
    await expect(open).toBeChecked();
    expect(await listed(running(), home)).toBe(true);

    await test.step("Turned off in Settings, it stays off", async () => {
      await open.click();
      await expect(open).not.toBeChecked();
      await expect.poll(() => listed(running(), home)).toBe(false);
      open = await startAgain();
      await expect(open).not.toBeChecked();
      expect(await listed(running(), home)).toBe(false);
    });

    await test.step("Removed in the system, it stays off", async () => {
      await open.click();
      await expect(open).toBeChecked();
      await expect.poll(() => listed(running(), home)).toBe(true);
      await removeFromSystem(running(), home);
      open = await startAgain();
      await expect(open).not.toBeChecked();
      expect(await listed(running(), home)).toBe(false);
    });
  } catch (error) {
    const info = test.info();
    for (const [at, folder] of ownFolders(home).entries()) {
      const lines = await packagedLogLines(folder, /./);
      if (lines.length === 0) continue;
      const path = info.outputPath(`app-${at}.log`);
      await mkdir(info.outputDir, { recursive: true });
      await writeFile(path, `${folder}\n${lines.join("\n")}`);
      await info.attach("app-log", { path, contentType: "text/plain" });
    }
    throw error;
  } finally {
    await cleanUp(state, launch, home);
  }
});

/**
 * The runner keeps no login item and no data folder of the app's, whatever step failed: an app
 * that started once and is closed now is started again to take its login item away.
 */
async function cleanUp(
  state: { app: ElectronApplication | null; started: boolean },
  launch: () => Promise<ElectronApplication>,
  home: string,
): Promise<void> {
  let app = state.app;
  const removed = async (running: ElectronApplication) => {
    await removeFromSystem(running, home);
    return true;
  };
  if (app && !(await removed(app).catch(() => false))) app = null;
  if (!app && state.started) {
    app = await launch();
    await removeFromSystem(app, home);
  }
  if (app) {
    const dataDir = await app.evaluate(({ app: electron }) => electron.getPath("userData"));
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  await rm(home, { recursive: true, force: true });
}
