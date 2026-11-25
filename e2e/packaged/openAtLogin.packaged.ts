import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { AUTOSTART_FILE, OPENED_AT_LOGIN } from "../../src/main/loginItem";
import { dismissChatSetup, openSettings } from "../app";
import { launchPackaged, packagedLogLines } from "./app";

/*
 * The packaged app's first start on its own data folder adds it to the system's login items
 * (#3758), and removing it in Settings or in the system is kept at the next start. Only the app
 * as released, on its own data folder, touches them, so this check can't use a data folder of
 * its own: it changes the computer's login items, and on macOS its data folder is in the real
 * Library. It runs only where a workflow says the runner is thrown away after the job, refuses to
 * start where the app's data folder or login item is there already, and takes away only what it
 * made.
 */

const THROWAWAY = "INCARNAMIND_LOGIN_ITEMS_ON_THROWAWAY_RUNNER";
test.skip(
  process.env[THROWAWAY] !== "1",
  `It changes this computer's login items: only on a runner whose workflow sets ${THROWAWAY}=1.`,
);
test.use({ trace: "off" });
test.setTimeout(6 * 60_000);

const args = process.platform === "win32" ? [OPENED_AT_LOGIN] : undefined;
/** Electron names the Run value after the app's AppUserModelID: "electron.app." and the product name. */
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "electron.app.IncarnaMind";

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

/** Whether the Run value Electron writes is in the registry, read there rather than through the app. */
const inRegistry = (): boolean => {
  try {
    execFileSync("reg", ["query", RUN_KEY, "/v", RUN_VALUE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Whether the system lists IncarnaMind to open at login: macOS may wait for the User's approval. */
async function listed(app: ElectronApplication, home: string): Promise<boolean> {
  if (process.platform === "linux") {
    return existsSync(join(home, ".config", "autostart", AUTOSTART_FILE));
  }
  return app.evaluate(({ app: electron }, given) => {
    const settings = electron.getLoginItemSettings(given ? { args: given } : undefined);
    return (
      settings.openAtLogin ||
      settings.executableWillLaunchAtLogin === true ||
      settings.status === "enabled" ||
      settings.status === "requires-approval"
    );
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

/**
 * Before the first start: where the app's own data folder would be, and whether the system lists
 * the app already, as a start on a data folder of the check's own sees them, which leaves the
 * login items alone.
 */
async function beforeFirstStart(home: string, env: Record<string, string>) {
  const data = await mkdtemp(join(tmpdir(), "incarnamind-login-preflight-"));
  const app = await launchPackaged(home, data, { testHooks: true, env });
  try {
    const { appData, name } = await app.evaluate(({ app: electron }) => ({
      appData: electron.getPath("appData"),
      name: electron.getName(),
    }));
    return { ownFolder: join(appData, name), listed: await listed(app, home) };
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
}

async function loginSwitch(window: Page) {
  await dismissChatSetup(window);
  const settings = await openSettings(window, "general");
  return settings.getByTestId("open-at-login-switch");
}

interface Made {
  app: ElectronApplication | null;
  /** The app's own data folder, once this check knows it wasn't there before. */
  folder: string | null;
  /** Whether this check started the app on its own data folder, which adds the login item. */
  started: boolean;
}

test("after a first start the system lists IncarnaMind as a login item, and removing it in Settings or in the system is kept", async () => {
  const home = await mkdtemp(join(tmpdir(), "incarnamind-login-home-"));
  const env = await profileFolders(home);
  const made: Made = { app: null, folder: null, started: false };
  const launch = () =>
    launchPackaged(home, null, {
      testHooks: true,
      env,
      extraEnv: { ELECTRON_ENABLE_LOGGING: "1" },
    });
  const running = (): ElectronApplication => {
    if (!made.app) throw new Error("The app isn't running.");
    return made.app;
  };
  const startAgain = async () => {
    await made.app?.close();
    made.app = null;
    made.started = true;
    const app = await launch();
    made.app = app;
    return loginSwitch(await app.firstWindow());
  };
  let ownFolder: string | null = null;
  try {
    const before = await beforeFirstStart(home, env);
    ownFolder = before.ownFolder;
    expect(existsSync(before.ownFolder), `${before.ownFolder} is there already`).toBe(false);
    expect(before.listed, "the system lists IncarnaMind already").toBe(false);
    if (process.platform === "win32") expect(inRegistry()).toBe(false);
    // Not there before this check: whatever is there at its end, it made.
    made.folder = before.ownFolder;

    let open = await startAgain();
    const dataDir = await running().evaluate(({ app: electron }) => electron.getPath("userData"));
    expect(dataDir).toBe(before.ownFolder);
    await expect(open).toBeChecked();
    expect(await listed(running(), home)).toBe(true);
    // The value the uninstaller takes out (build/installer.nsh) is the one Electron wrote.
    if (process.platform === "win32") expect(inRegistry()).toBe(true);

    await test.step("Turned off in Settings, it stays off at two starts", async () => {
      await open.click();
      await expect(open).not.toBeChecked();
      await expect.poll(() => listed(running(), home)).toBe(false);
      for (const restart of [1, 2]) {
        open = await startAgain();
        await expect(open, `start ${restart}`).not.toBeChecked();
        expect(await listed(running(), home)).toBe(false);
      }
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
    if (ownFolder) {
      const lines = await packagedLogLines(ownFolder, /./);
      if (lines.length > 0) {
        const info = test.info();
        const path = info.outputPath("app.log");
        await mkdir(info.outputDir, { recursive: true });
        await writeFile(path, lines.join("\n"));
        await info.attach("app-log", { path, contentType: "text/plain" });
      }
    }
    throw error;
  } finally {
    await cleanUp(made, launch, home);
  }
});

/**
 * Takes away only what this check made, whatever step failed: the login item, once it started the
 * app on its own data folder (none was listed before), and that folder, once it knew it made it.
 * An app that is closed by then is started again to take its login item away.
 */
async function cleanUp(
  made: Made,
  launch: () => Promise<ElectronApplication>,
  home: string,
): Promise<void> {
  let app = made.app;
  if (made.started) {
    const removed = async (running: ElectronApplication) => {
      await removeFromSystem(running, home);
      return true;
    };
    if (app && !(await removed(app).catch(() => false))) app = null;
    if (!app) {
      app = await launch();
      await removeFromSystem(app, home);
    }
  }
  await app?.close();
  if (made.folder) await rm(made.folder, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}
