/**
 * Running in the background (#189): with "Keep running in the menu bar" (the tray on Windows and
 * Linux) on, the icon stays and closing the window leaves IncarnaMind running. The setting lives
 * with the core's, which starts after the first window; a copy in the data folder lets a start at
 * login decide before that whether to open the window at all.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "background.json";

export function keptRunning(dataDir: string): boolean {
  try {
    return (
      (JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as { keepRunning?: unknown })
        .keepRunning === true
    );
  } catch {
    return false;
  }
}

export function keepRunningCopy(dataDir: string, keepRunning: boolean): void {
  writeFileSync(join(dataDir, FILE), JSON.stringify({ keepRunning }));
}

/**
 * Whether closing the last window quits. macOS keeps an app running with its Dock icon, as it
 * always has; elsewhere the tray icon is what keeps IncarnaMind reachable.
 */
export const closingLastWindowQuits = (platform: NodeJS.Platform, keepRunning: boolean): boolean =>
  platform !== "darwin" && !keepRunning;

/** A start at login opens no window when IncarnaMind keeps running in the background: its icon is there. */
export const startsWithoutWindow = (atLogin: boolean, keepRunning: boolean): boolean =>
  atLogin && keepRunning;
