/**
 * Opening IncarnaMind at login (#189), through the system: Electron's login items on macOS and
 * Windows, and an autostart entry on Linux (the XDG Autostart specification), which Electron has
 * no API for. Opened that way, IncarnaMind starts with the `OPENED_AT_LOGIN` argument (macOS says
 * so itself), so it can start without its window.
 *
 * A development or test build never touches the computer's login items: it keeps the choice in
 * a file in its data folder (`createFileLoginItem`), which the smoke tests read.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LoginItem } from "../core";
import type { OpenAtLogin } from "../core/api";

export const OPENED_AT_LOGIN = "--opened-at-login";

/** Electron's `app`, as far as login items go. */
export interface LoginItemApp {
  getLoginItemSettings(options?: { args?: string[] }): {
    openAtLogin: boolean;
    wasOpenedAtLogin?: boolean;
    status?: string;
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
}

const LOGIN_ITEMS_SETTINGS = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

/** The autostart entry's file name: the app's id, so a second entry never appears beside it. */
export const AUTOSTART_FILE = "com.incarnamind.app.desktop";

/**
 * A path in a desktop entry's Exec line, quoted as the Desktop Entry specification says, its "%"
 * doubled so no launcher reads it as a field code.
 */
const execQuoted = (path: string) =>
  `"${path.replace(/(["`$\\])/g, "\\$1").replaceAll("%", "%%")}"`;

export function autostartEntry(program: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=IncarnaMind",
    `Exec=${execQuoted(program)} ${OPENED_AT_LOGIN}`,
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

export function createSystemLoginItem(options: SystemLoginItemOptions): LoginItem {
  const { platform, app } = options;
  const autostart = join(options.configHome, "autostart", AUTOSTART_FILE);
  const args = platform === "win32" ? [OPENED_AT_LOGIN] : undefined;
  // An update can move the program (a new AppImage's name has its version): an entry that is on
  // names the program running now.
  if (platform === "linux" && existsSync(autostart)) {
    const entry = autostartEntry(options.program);
    if (readFileSync(autostart, "utf8") !== entry) writeFileSync(autostart, entry);
  }
  const get = (): OpenAtLogin => {
    if (platform === "linux")
      return { supported: true, on: existsSync(autostart), needsApproval: false };
    const settings = app.getLoginItemSettings(args ? { args } : undefined);
    return {
      supported: true,
      on: settings.openAtLogin,
      needsApproval: platform === "darwin" && settings.status === "requires-approval",
    };
  };
  return {
    get,
    set(on) {
      if (platform === "linux") {
        if (on) {
          mkdirSync(dirname(autostart), { recursive: true });
          writeFileSync(autostart, autostartEntry(options.program));
        } else {
          rmSync(autostart, { force: true });
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
      writeFileSync(file, JSON.stringify({ on }));
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
