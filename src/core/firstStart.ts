/**
 * A new data folder's first start (#3758): IncarnaMind opens at login, keeps running in the menu
 * bar (the tray on Windows and Linux) and offers to take notes when a call starts. Set once: one
 * the User turns off stays off, and a data folder an earlier version started keeps its own. Where
 * this copy can't open at login or notice calls, that one stays off.
 */
import type { CallWatcher, Logger, LoginItem } from "./adapters";
import type { SettingsStore } from "./settings";

export function turnOnAtFirstStart(options: {
  settings: SettingsStore;
  loginItem: LoginItem | undefined;
  callWatcher: CallWatcher | undefined;
  /** Whether this copy records audio: an offer to take notes needs it. */
  records: boolean;
  log: Logger;
}): void {
  const { loginItem, callWatcher, log } = options;
  const callsNoticed = options.records && callWatcher !== undefined && !callWatcher.problem;
  options.settings.update({
    device: { keepRunning: true, ...(callsNoticed && { callOffers: true }) },
  });
  if (!loginItem) return;
  try {
    if (loginItem.get().supported) loginItem.set(true);
  } catch (error) {
    log.error("firstStart.openAtLoginFailed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
