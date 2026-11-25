/**
 * Opening IncarnaMind at login (#189), through the system: Electron's login items on macOS and
 * Windows, and an autostart entry on Linux (the XDG Autostart specification), which Electron has
 * no API for. Opened that way, IncarnaMind starts with the `OPENED_AT_LOGIN` argument (macOS says
 * so itself), so it can start without its window.
 *
 * A development or test build never touches the computer's login items: it keeps the choice in
 * a file in its data folder (`createFileLoginItem`), which the smoke tests read. So does the app
 * started on another data folder, since the system opens it at login on its own.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LoginItem } from "../core";
import type { OpenAtLogin } from "../core/api";
import { TranslatableError } from "../core/errors";
import type { FileLogger } from "./log";

export const OPENED_AT_LOGIN = "--opened-at-login";

/** Electron's `app`, as far as login items go. */
export interface LoginItemApp {
  getLoginItemSettings(options?: { args?: string[] }): {
    openAtLogin: boolean;
    wasOpenedAtLogin?: boolean;
    status?: string;
    /**
     * Windows: false once the User disabled the app in Task Manager's startup list. Always false
     * on other systems.
     */
    executableWillLaunchAtLogin?: boolean;
  };
  setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void;
}

export interface SystemLoginItemOptions {
  platform: NodeJS.Platform;
  app: LoginItemApp;
  /** The program a login opens: the AppImage on Linux when there is one, else the executable. */
  program: string;
  /** The folder of the User's own configuration on Linux ($XDG_CONFIG_HOME, else ~/.config). */
  configHome: string;
  openUrl(url: string): Promise<void>;
  log: Pick<FileLogger, "exception">;
}

/** Why Open at login couldn't be changed, for the line under its switch. */
const notChanged = (path: string, cause: unknown) =>
  new TranslatableError({ key: "error.openAtLogin.notWritten", values: { path } }, { cause });

const LOGIN_ITEMS_SETTINGS = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

/** The autostart entry's file name: the app's id, so a second entry never appears beside it. */
export const AUTOSTART_FILE = "com.incarnamind.app.desktop";

/**
 * A path in a desktop entry's Exec line, quoted as the Desktop Entry specification says, its "%"
 * doubled so no launcher reads it as a field code.
 */
const execQuoted = (path: string) =>
  `"${path.replace(/(["`$\\])/g, "\\$1").replaceAll("%", "%%")}"`;

const execLine = (program: string) => `Exec=${execQuoted(program)} ${OPENED_AT_LOGIN}`;
/** A string value in a desktop entry: its backslashes doubled, as the specification says. */
const tryExecLine = (program: string) => `TryExec=${program.replaceAll("\\", "\\\\")}`;

export function autostartEntry(program: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=IncarnaMind",
    // A desktop skips the entry once the program is gone, after an uninstall.
    tryExecLine(program),
    execLine(program),
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/**
 * Whether the desktop's own startup settings turned the entry off: GNOME's, Cinnamon's and
 * XFCE's write one of these into it rather than remove it.
 */
const turnedOff = (entry: string) =>
  /^X-GNOME-Autostart-enabled=false\s*$/m.test(entry) || /^Hidden=true\s*$/m.test(entry);

/** The entry naming `program` to run, with every other line as it was, off included. */
function pointedAt(entry: string, program: string): string {
  if (!/^Exec=/m.test(entry)) return entry;
  const exec = entry.replace(/^Exec=.*$/m, () => execLine(program));
  return /^TryExec=/m.test(exec)
    ? exec.replace(/^TryExec=.*$/m, () => tryExecLine(program))
    : exec.replace(/^Exec=/m, () => `${tryExecLine(program)}\nExec=`);
}

export function createSystemLoginItem(options: SystemLoginItemOptions): LoginItem {
  const { platform, app, log } = options;
  const autostart = join(options.configHome, "autostart", AUTOSTART_FILE);
  const args = platform === "win32" ? [OPENED_AT_LOGIN] : undefined;
  // The log keeps no absolute path, so it names the entry inside the configuration folder.
  const failed = (step: "read" | "refresh" | "turnOn" | "turnOff", error: unknown) =>
    log.exception(
      "loginItem.autostartFailed",
      error,
      { step, file: `autostart/${AUTOSTART_FILE}` },
      step === "turnOn" || step === "turnOff" ? "error" : "warn",
    );
  /** The entry's text; null when there is none, or none this account can read. */
  const entry = (): string | null => {
    if (!existsSync(autostart)) return null;
    try {
      return readFileSync(autostart, "utf8");
    } catch (error) {
      failed("read", error);
      return null;
    }
  };
  // An update can move the program (a new AppImage's name has its version): the entry names the
  // program running now, and stays off if the desktop turned it off. One this account can't
  // change stays as it is: a login item is never a reason not to start.
  if (platform === "linux") {
    const found = entry();
    const updated = found === null ? null : pointedAt(found, options.program);
    if (updated !== null && updated !== found) {
      try {
        writeFileSync(autostart, updated);
      } catch (error) {
        failed("refresh", error);
      }
    }
  }
  const get = (): OpenAtLogin => {
    if (platform === "linux") {
      // The desktop reads the entry as this account does: one it can't read opens nothing.
      const found = entry();
      return { supported: true, on: found !== null && !turnedOff(found), needsApproval: false };
    }
    const settings = app.getLoginItemSettings(args ? { args } : undefined);
    // Electron sends executableWillLaunchAtLogin on every system, always false outside Windows.
    const enabled = platform !== "win32" || settings.executableWillLaunchAtLogin !== false;
    return {
      supported: true,
      on: settings.openAtLogin && enabled,
      needsApproval: platform === "darwin" && settings.status === "requires-approval",
    };
  };
  return {
    get,
    set(on) {
      if (platform === "linux") {
        try {
          if (on) {
            mkdirSync(dirname(autostart), { recursive: true });
            writeFileSync(autostart, autostartEntry(options.program));
          } else {
            rmSync(autostart, { force: true });
          }
        } catch (error) {
          failed(on ? "turnOn" : "turnOff", error);
          throw notChanged(autostart, error);
        }
      } else {
        app.setLoginItemSettings({ openAtLogin: on, ...(args && { args }) });
      }
      return get();
    },
    async openSettings() {
      if (platform === "darwin") await options.openUrl(LOGIN_ITEMS_SETTINGS);
    },
  };
}

/**
 * Whether this copy uses the system's login items: only the app as released, on the data folder
 * the system opens it on (#3758); a new data folder's first start registers it.
 */
export const usesSystemLoginItems = (copy: {
  packaged: boolean;
  testBuild: boolean;
  otherDataFolder: boolean;
}): boolean => copy.packaged && !copy.testBuild && !copy.otherDataFolder;

/** A development or test build's login item: a file in the data folder, never the system's. */
export function createFileLoginItem(dataDir: string): LoginItem {
  const file = join(dataDir, "login-item.json");
  const get = (): OpenAtLogin => {
    let on = false;
    try {
      on = (JSON.parse(readFileSync(file, "utf8")) as { on?: unknown }).on === true;
    } catch {
      on = false;
    }
    return { supported: true, on, needsApproval: false };
  };
  return {
    get,
    set(on) {
      try {
        writeFileSync(file, JSON.stringify({ on }));
      } catch (error) {
        throw notChanged(file, error);
      }
      return get();
    },
    openSettings: async () => undefined,
  };
}

/** Whether this start was the system opening IncarnaMind at login; `app` only where the system's login items are used. */
export function openedAtLogin(
  platform: NodeJS.Platform,
  argv: readonly string[],
  app: LoginItemApp | null,
): boolean {
  if (argv.includes(OPENED_AT_LOGIN)) return true;
  return platform === "darwin" && app?.getLoginItemSettings().wasOpenedAtLogin === true;
}
