import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  AUTOSTART_FILE,
  autostartEntry,
  createSystemLoginItem,
  type LoginItemApp,
  openedAtLogin,
} from "../../src/main/loginItem";
import { createTempDataFolder } from "../helpers/core";

/** Electron's login items, as a fake that keeps what it was told. */
function fakeApp(status = "enabled") {
  const calls: { openAtLogin: boolean; args?: string[] }[] = [];
  let on = false;
  const app: LoginItemApp = {
    getLoginItemSettings: () => ({ openAtLogin: on, wasOpenedAtLogin: false, status }),
    setLoginItemSettings: (settings) => {
      calls.push(settings);
      on = settings.openAtLogin;
    },
  };
  return { app, calls };
}

const openUrl = async () => undefined;

describe("Opening at login", () => {
  test("macOS registers and unregisters through the system's login items", async () => {
    const { app, calls } = fakeApp();
    const item = createSystemLoginItem({
      platform: "darwin",
      app,
      program: "/Applications/IncarnaMind.app/Contents/MacOS/IncarnaMind",
      configHome: await createTempDataFolder(),
      openUrl,
    });
    expect(item.get()).toEqual({ supported: true, on: false, needsApproval: false });
    expect(item.set(true)).toEqual({ supported: true, on: true, needsApproval: false });
    expect(item.set(false).on).toBe(false);
    expect(calls).toEqual([{ openAtLogin: true }, { openAtLogin: false }]);
  });

  test("macOS says when System Settings waits for the User's approval", async () => {
    const opened: string[] = [];
    const item = createSystemLoginItem({
      platform: "darwin",
      app: fakeApp("requires-approval").app,
      program: "/Applications/IncarnaMind.app/Contents/MacOS/IncarnaMind",
      configHome: await createTempDataFolder(),
      openUrl: async (url) => {
        opened.push(url);
      },
    });
    expect(item.set(true)).toMatchObject({ on: true, needsApproval: true });
    await item.openSettings();
    expect(opened).toEqual(["x-apple.systempreferences:com.apple.LoginItems-Settings.extension"]);
  });

  test("Windows opens it with the argument that says it was opened at login", async () => {
    const { app, calls } = fakeApp();
    const item = createSystemLoginItem({
      platform: "win32",
      app,
      program: "C:\\Program Files\\IncarnaMind\\IncarnaMind.exe",
      configHome: await createTempDataFolder(),
      openUrl,
    });
    item.set(true);
    expect(calls).toEqual([{ openAtLogin: true, args: ["--opened-at-login"] }]);
    expect(openedAtLogin("win32", ["IncarnaMind.exe", "--opened-at-login"], null)).toBe(true);
    expect(openedAtLogin("win32", ["IncarnaMind.exe"], null)).toBe(false);
  });

  test("Linux writes an autostart entry for the AppImage, and removes it", async () => {
    const configHome = await createTempDataFolder();
    const { app, calls } = fakeApp();
    const item = createSystemLoginItem({
      platform: "linux",
      app,
      program: "/home/ana/Apps/IncarnaMind 1.0.AppImage",
      configHome,
      openUrl,
    });
    const entry = join(configHome, "autostart", AUTOSTART_FILE);
    expect(item.set(true)).toEqual({ supported: true, on: true, needsApproval: false });
    expect(readFileSync(entry, "utf8")).toContain(
      'Exec="/home/ana/Apps/IncarnaMind 1.0.AppImage" --opened-at-login',
    );
    expect(item.set(false).on).toBe(false);
    expect(existsSync(entry)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a path's quotes and dollars are escaped in the entry's Exec line", () => {
    expect(autostartEntry('/opt/a "b" $c/IncarnaMind')).toContain(
      'Exec="/opt/a \\"b\\" \\$c/IncarnaMind" --opened-at-login',
    );
  });

  test("macOS says itself that it opened the app at login", () => {
    const app: LoginItemApp = {
      getLoginItemSettings: () => ({ openAtLogin: true, wasOpenedAtLogin: true }),
      setLoginItemSettings: () => undefined,
    };
    expect(openedAtLogin("darwin", ["IncarnaMind"], app)).toBe(true);
    expect(openedAtLogin("darwin", ["IncarnaMind"], null)).toBe(false);
  });
});
