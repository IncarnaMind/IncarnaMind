/**
 * A start that comes while IncarnaMind is quitting: another launch, or a click on its Dock icon
 * (#1448). The User asked for a window, so they get one: either the quitting copy opens again once
 * it has quit, or the new copy, if it can't get going, steps aside and starts again.
 */
import type { App, Event, RelaunchOptions } from "electron";
import type { Logger } from "../core";
import { UPDATE_RECOVERY_PREFIX } from "./instanceUpdate";

const STARTED_AGAIN = "--started-again-after-stall";
const STALL_MS = 5_000;

function relaunchOptions(extra: string[] = []): RelaunchOptions {
  const args = [
    ...process.argv
      .slice(1)
      .filter(
        (arg) =>
          arg !== STARTED_AGAIN && arg !== "--updated" && !arg.startsWith(UPDATE_RECOVERY_PREFIX),
      ),
    ...extra,
  ];
  // An AppImage's own files go away when it quits: it is started again from the AppImage.
  const appImage = process.env.APPIMAGE;
  return { args, ...(appImage && { execPath: appImage }) };
}

/** The quit guard has committed: a failed installer must not leave that core running (#1448). */
export function restartAfterFailedUpdate(
  app: Pick<App, "relaunch" | "exit">,
  showProblem: () => void,
  closeCore: () => void,
  recoveryId?: string,
): void {
  try {
    showProblem();
  } finally {
    exitAfterFailedUpdate(app, closeCore, { recoveryId });
  }
}

export function exitAfterFailedUpdate(
  app: Pick<App, "relaunch" | "exit">,
  closeCore: () => void,
  restart: { recoveryId?: string } | null,
): void {
  try {
    if (restart) {
      const args = [STARTED_AGAIN];
      if (restart.recoveryId) args.push(`${UPDATE_RECOVERY_PREFIX}${restart.recoveryId}`);
      app.relaunch(relaunchOptions(args));
    }
  } finally {
    try {
      closeCore();
    } finally {
      app.exit(0);
    }
  }
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
 * A start that waited for a previous data owner retries a stalled native startup once (#1448).
 * Its SQLite ownership lasts through actual process exit, including native cleanup.
 * An ordinary fresh launch with no previous owner is left alone.
 */
export function startAgainIfStalled(
  app: Pick<App, "whenReady" | "releaseSingleInstanceLock" | "relaunch" | "exit">,
  showProblem: () => void,
  logger: Pick<Logger, "error">,
  previousOwner: boolean,
): void {
  if (!previousOwner && !process.argv.includes(STARTED_AGAIN)) return;
  const timer = setTimeout(() => {
    const again = process.argv.includes(STARTED_AGAIN);
    logger.error("app.startStalled", { again });
    // SQLite ownership ends with the process, after Electron's native cleanup (#1448).
    app.releaseSingleInstanceLock();
    try {
      if (again) showProblem();
      else app.relaunch(relaunchOptions([STARTED_AGAIN]));
    } finally {
      app.exit(0);
    }
  }, STALL_MS);
  app.whenReady().then(() => clearTimeout(timer));
}
