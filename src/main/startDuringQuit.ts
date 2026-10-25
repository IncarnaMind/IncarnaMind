/**
 * A start that comes while IncarnaMind is quitting: another launch, or a click on its Dock icon
 * (#1448). The User asked for a window, so they get one: either the quitting copy opens again once
 * it has quit, or the new copy, if it can't get going, steps aside and starts again.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { App, Event, RelaunchOptions } from "electron";
import type { Logger } from "../core";

const STARTED_AGAIN = "--started-again-after-stall";
const STALL_MS = 5_000;

// Chromium's lock is a symlink to a host and PID, so checking its target misses a quitting copy.
export function electronInstanceWasPresent(
  folder: string,
  report: (what: string, error: unknown) => void,
): boolean {
  try {
    lstatSync(join(folder, "SingletonLock"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    report("app.singleInstanceLockCheckFailed", error);
    return true;
  }
}

function relaunchOptions(extra: string[] = []): RelaunchOptions {
  const args = [...process.argv.slice(1).filter((arg) => arg !== STARTED_AGAIN), ...extra];
  // An AppImage's own files go away when it quits: it is started again from the AppImage.
  const appImage = process.env.APPIMAGE;
  return { args, ...(appImage && { execPath: appImage }) };
}

/**
 * Wires the quitting copy's side. The returned function is called for each start that reaches this
 * copy: true when the windows are closing for a quit, so the start must not open or show one, and
 * the app opens again once this copy has ended, if `canReopen` (an update installing on this quit
 * starts the app itself). While the quit waits on the User (the unsaved-changes question), it
 * returns false: the start brings that window forward, and the User's answer decides.
 */
export function reopenAfterQuit(
  app: Pick<App, "on" | "relaunch">,
  canReopen: () => boolean,
  logger: Pick<Logger, "info">,
): () => boolean {
  let quit: Event | null = null;
  let reopening = false;
  app.on("before-quit", (event) => {
    quit = event;
  });
  return () => {
    // Held back is the only way a quit stops: nothing prevents `will-quit` or a window's close, and
    // an update that fails never asks to quit.
    if (quit?.defaultPrevented) quit = null;
    if (!quit) return false;
    if (!reopening) {
      reopening = true;
      const reopens = canReopen();
      logger.info("app.reopenAfterQuit", { reopens });
      // Now, not at `will-quit`: Electron's helper waits for this copy to end, even by a crash.
      if (reopens) app.relaunch(relaunchOptions());
    }
    return true;
  };
}

/**
 * A copy can take Electron's lock after the old copy releases its data lock but before it exits
 * (#1448). On macOS this can stall `ready`: the new copy releases its locks and tries once more
 * before showing a problem and quitting. The retry watches even after the old locks are gone;
 * ordinary launches without a previous owner are left alone.
 */
export function startAgainIfStalled(
  app: Pick<App, "whenReady" | "releaseSingleInstanceLock" | "relaunch" | "exit">,
  letGoOfFolder: () => void,
  showProblem: () => void,
  logger: Pick<Logger, "error">,
  previousOwner: boolean,
): void {
  if (!previousOwner && !process.argv.includes(STARTED_AGAIN)) return;
  const timer = setTimeout(() => {
    const again = process.argv.includes(STARTED_AGAIN);
    logger.error("app.startStalled", { again });
    // Electron's lock first: a start that comes in between still finds the folder held, and watches too.
    app.releaseSingleInstanceLock();
    letGoOfFolder();
    try {
      if (again) showProblem();
      else app.relaunch(relaunchOptions([STARTED_AGAIN]));
    } finally {
      app.exit(0);
    }
  }, STALL_MS);
  app.whenReady().then(() => clearTimeout(timer));
}
