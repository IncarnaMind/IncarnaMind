/**
 * Light, Dark or Same as system (#1262). The choice is the core's device setting; Electron is told,
 * so native menus, scrollbars and dialogs, and every page's `prefers-color-scheme`, agree with the
 * app. A copy is kept in the data folder (appearance.json), because the first window paints before
 * the core has started: the next launch's first frame is then already in the chosen theme.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserWindow, nativeTheme } from "electron";
import type { Core } from "../core";
import { APPEARANCES, type Appearance } from "../core/api";
import { isRecord } from "../core/errors";
import { titleBarOf } from "../shared/titleBar";
import type { FileLogger } from "./log";
import { overlayColours, type Theme, WINDOW_COLOURS, type WindowSurface } from "./windowColours";

const FILE = "appearance.json";

const isAppearance = (value: unknown): value is Appearance =>
  APPEARANCES.some((each) => each === value);

/** The choice kept for this launch: the User's, or "system" until they make one. */
export function storedAppearance(dataDir: string): Appearance {
  try {
    const saved: unknown = JSON.parse(readFileSync(join(dataDir, FILE), "utf8"));
    return isRecord(saved) && isAppearance(saved.appearance) ? saved.appearance : "system";
  } catch {
    return "system";
  }
}

function showAppearance(appearance: Appearance): void {
  if (nativeTheme.themeSource !== appearance) nativeTheme.themeSource = appearance;
}

/** Before the first window: Electron takes the kept choice, so that window opens in it. */
export function startAppearance(dataDir: string): void {
  showAppearance(storedAppearance(dataDir));
}

export const shownTheme = (): Theme => (nativeTheme.shouldUseDarkColors ? "dark" : "light");

/** What a window shows before its page paints, and around it while it resizes. */
export const windowColour = (surface: WindowSurface): string =>
  WINDOW_COLOURS[surface][shownTheme()];

/** Keeps a window's own colours with the theme shown, as it changes. */
export function themeWindow(window: BrowserWindow, surface: WindowSurface): void {
  const repaint = () => {
    if (window.isDestroyed()) return;
    window.setBackgroundColor(windowColour(surface));
    if (surface === "frame" && titleBarOf(process.platform) === "overlay") {
      window.setTitleBarOverlay(overlayColours(shownTheme()));
    }
  };
  nativeTheme.on("updated", repaint);
  window.once("closed", () => nativeTheme.off("updated", repaint));
}

/** Electron follows the core's setting from now on, and the next launch starts in it. */
export function followAppearance(core: Core, dataDir: string, log: FileLogger): void {
  let kept = storedAppearance(dataDir);
  const keep = (appearance: Appearance) => {
    showAppearance(appearance);
    if (appearance === kept) return;
    kept = appearance;
    try {
      writeFileSync(join(dataDir, FILE), JSON.stringify({ appearance }));
    } catch (error) {
      // The theme still changes now; only the next launch's first frame may show the old one.
      log.exception("appearance.notKept", error);
    }
  };
  core.getSettings().then(
    (settings) => keep(settings.device.appearance),
    (error: unknown) => log.exception("appearance.notRead", error),
  );
  core.on("settings.changed", (settings) => keep(settings.device.appearance));
}
