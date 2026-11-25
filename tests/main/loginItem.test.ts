import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  AUTOSTART_FILE,
  autostartEntry,
  createFileLoginItem,
  createSystemLoginItem,
  type LoginItemApp,
  openedAtLogin,
  usesSystemLoginItems,
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

  test("the entry names the program in TryExec, so a desktop skips it once the program is gone", () => {
    expect(autostartEntry("/home/ana/Apps/IncarnaMind 1.0.AppImage").split("\n")).toEqual([
      "[Desktop Entry]",
      "Type=Application",
      "Name=IncarnaMind",
      "TryExec=/home/ana/Apps/IncarnaMind 1.0.AppImage",
      'Exec="/home/ana/Apps/IncarnaMind 1.0.AppImage" --opened-at-login',
      "X-GNOME-Autostart-enabled=true",
      "",
    ]);
    expect(autostartEntry("/opt/a\\b/IncarnaMind")).toContain("TryExec=/opt/a\\\\b/IncarnaMind\n");
  });

  for (const off of ["X-GNOME-Autostart-enabled=false", "Hidden=true"]) {
    test(`Linux reads an entry the desktop turned off (${off}) as off, keeps it off after an update moved the program, and turning it on enables it again`, async () => {
      const configHome = await createTempDataFolder();
      const entry = join(configHome, "autostart", AUTOSTART_FILE);
      const start = (program: string) =>
        createSystemLoginItem({
          platform: "linux",
          app: fakeApp().app,
          program,
          configHome,
          openUrl,
        });
      start("/home/ana/Apps/IncarnaMind-1.0.0.AppImage").set(true);
      // As GNOME's, Cinnamon's or XFCE's startup settings leave it.
      const turnedOff = readFileSync(entry, "utf8").replace(
        "X-GNOME-Autostart-enabled=true",
        off === "Hidden=true" ? "X-GNOME-Autostart-enabled=true\nHidden=true" : off,
      );
      writeFileSync(entry, turnedOff);
      expect(start("/home/ana/Apps/IncarnaMind-1.0.0.AppImage").get().on).toBe(false);

      const updated = start("/home/ana/Apps/IncarnaMind-1.1.0.AppImage");
      expect(updated.get().on).toBe(false);
      const kept = readFileSync(entry, "utf8");
      expect(kept).toContain(off);
      expect(kept).toContain('Exec="/home/ana/Apps/IncarnaMind-1.1.0.AppImage" --opened-at-login');
      expect(kept).toContain("TryExec=/home/ana/Apps/IncarnaMind-1.1.0.AppImage");
      expect(kept).not.toContain("1.0.0");

      expect(updated.set(true).on).toBe(true);
      expect(readFileSync(entry, "utf8")).toBe(
        autostartEntry("/home/ana/Apps/IncarnaMind-1.1.0.AppImage"),
      );
    });
  }

  test("an entry from before TryExec gains it when an update moves the program", async () => {
    const configHome = await createTempDataFolder();
    const entry = join(configHome, "autostart", AUTOSTART_FILE);
    mkdirSync(join(configHome, "autostart"), { recursive: true });
    writeFileSync(
      entry,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=IncarnaMind",
        'Exec="/home/ana/Apps/IncarnaMind-1.0.0.AppImage" --opened-at-login',
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n"),
    );
    const item = createSystemLoginItem({
      platform: "linux",
      app: fakeApp().app,
      program: "/home/ana/Apps/IncarnaMind-1.1.0.AppImage",
      configHome,
      openUrl,
    });
    expect(item.get().on).toBe(true);
    expect(readFileSync(entry, "utf8")).toBe(
      autostartEntry("/home/ana/Apps/IncarnaMind-1.1.0.AppImage"),
    );
  });

  test("a path's quotes, dollars and percent signs are escaped in the entry's Exec line", () => {
    expect(autostartEntry('/opt/a "b" $c/100%/IncarnaMind')).toContain(
      'Exec="/opt/a \\"b\\" \\$c/100%%/IncarnaMind" --opened-at-login',
    );
  });

  test("Linux points an entry that is on at the program running now, after an update moved it", async () => {
    const configHome = await createTempDataFolder();
    const before = createSystemLoginItem({
      platform: "linux",
      app: fakeApp().app,
      program: "/home/ana/Apps/IncarnaMind-1.0.0.AppImage",
      configHome,
      openUrl,
    });
    before.set(true);
    createSystemLoginItem({
      platform: "linux",
      app: fakeApp().app,
      program: "/home/ana/Apps/IncarnaMind-1.1.0.AppImage",
      configHome,
      openUrl,
    });
    expect(readFileSync(join(configHome, "autostart", AUTOSTART_FILE), "utf8")).toContain(
      'Exec="/home/ana/Apps/IncarnaMind-1.1.0.AppImage" --opened-at-login',
    );
  });

  test("Windows reads off once the User disabled the app in Task Manager, and turning it on enables it again", async () => {
    let on = false;
    let approved = true;
    const app: LoginItemApp = {
      getLoginItemSettings: () => ({
        openAtLogin: on,
        executableWillLaunchAtLogin: on && approved,
      }),
      // Electron's default `enabled: true` takes the Task Manager entry's "disabled" away.
      setLoginItemSettings: (settings) => {
        on = settings.openAtLogin;
        approved = true;
      },
    };
    const item = createSystemLoginItem({
      platform: "win32",
      app,
      program: "C:\\Program Files\\IncarnaMind\\IncarnaMind.exe",
      configHome: await createTempDataFolder(),
      openUrl,
    });
    expect(item.set(true).on).toBe(true);
    approved = false;
    expect(item.get().on).toBe(false);
    expect(item.set(true).on).toBe(true);
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

describe("Which copies use the computer's login items (#3758)", () => {
  test("only the app as released, on its own data folder", () => {
    expect(usesSystemLoginItems({ packaged: true, testBuild: false, otherDataFolder: false })).toBe(
      true,
    );
  });

  test("never a development build, a test build packaged or not, or a start on another data folder", () => {
    for (const copy of [
      { packaged: false, testBuild: false, otherDataFolder: false },
      { packaged: false, testBuild: true, otherDataFolder: true },
      { packaged: true, testBuild: true, otherDataFolder: false },
      { packaged: true, testBuild: false, otherDataFolder: true },
    ]) {
      expect(usesSystemLoginItems(copy)).toBe(false);
    }
  });

  test("the others keep the choice in a file in their data folder", async () => {
    const dataDir = await createTempDataFolder();
    const item = createFileLoginItem(dataDir);
    expect(item.get()).toEqual({ supported: true, on: false, needsApproval: false });
    expect(item.set(true).on).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, "login-item.json"), "utf8"))).toEqual({
      on: true,
    });
  });
});
