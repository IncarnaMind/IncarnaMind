import type { DeviceSettings } from "../../core/api";
import { TIP_SHOWS } from "./tips";

/** Whether this is a Mac: the menu bar, where Windows and Linux have the tray. */
export const onMac = () => /Mac/.test(navigator.platform);

/**
 * Whether setting up Meetings offers what the offers to take notes need: not on Windows, where
 * calls can't be noticed until its watcher ships (#2843).
 */
export const offersCanTurnOn = () => !/Win/.test(navigator.platform);

/**
 * Whether setting up Meetings still turns on the offers and what they need here (#189): only in a
 * data folder an earlier version started, where they were off (a new one has them from its first
 * start, #3758), and never once the User has turned one of them on or off.
 */
export const setUpTurnsOnOffers = (device: DeviceSettings) =>
  offersCanTurnOn() && !device.keepRunning && (device.tips["call-offers"] ?? 0) < TIP_SHOWS;
