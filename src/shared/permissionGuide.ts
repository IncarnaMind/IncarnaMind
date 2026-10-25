/**
 * The guide beside System Settings (#1105): where recording is missing a
 * permission the User must add by hand, a small window next to System Settings
 * says what to click and shows the row to switch on, notices when the system
 * has granted it, and closes. Where it can't sit beside System Settings, the
 * same steps show in the app's window as text. It shares the app's preload,
 * which gives its page the core and this bridge for the argument.
 */
import type { AudioSource } from "../core/api";

export const PERMISSION_GUIDE_ARGUMENT = "--incarnamind-permission-guide";
export const PERMISSION_GUIDE_BRIDGE_KEY = "incarnamindPermissionGuide";

/** Where the steps show: in a window beside System Settings, in the app's window, or nowhere on this system. */
export type GuidePlacement = "beside" | "inline" | "none";

/** What the guide shows: the permission it is for, and whether the system has granted it. */
export interface PermissionGuideState {
  source: AudioSource;
  placement: Exclude<GuidePlacement, "none">;
  status: "waiting" | "granted";
}

export const PERMISSION_GUIDE_CHANNELS = {
  /** Page → main: make the window this size, in CSS pixels, keeping its top right corner. */
  size: "permissionGuide:size",
  /** Page → main: the User closed it (✕ or Esc). */
  close: "permissionGuide:close",
  /** Page → main: what the guide is showing now (`PermissionGuideState`), or null. */
  state: "permissionGuide:state",
} as const;

export interface PermissionGuideBridge {
  resize(width: number, height: number): void;
  close(): void;
  state(): Promise<PermissionGuideState | null>;
  onState(listener: (state: PermissionGuideState | null) => void): () => void;
}

/** The guide's width, and its distance from the screen's edge. */
export const GUIDE_WIDTH = 316;
export const GUIDE_MARGIN = 16;

/** System Settings' width on opening, centred on the screen until the User moves it. */
const SYSTEM_SETTINGS_WIDTH = 715;

/**
 * Whether the guide fits in the room beside System Settings on a screen whose usable area is
 * `areaWidth` wide, with System Settings in the middle: each side has half of what it leaves.
 */
export function fitsBesideSystemSettings(areaWidth: number): boolean {
  return (areaWidth - SYSTEM_SETTINGS_WIDTH) / 2 >= GUIDE_WIDTH + 2 * GUIDE_MARGIN;
}

/**
 * Where the guide goes: where the User must add the permission by hand, which is macOS (the
 * first system this serves); beside System Settings if the screen has room, else in place.
 */
export function guidePlacement(platform: string, areaWidth: number): GuidePlacement {
  if (platform !== "darwin") return "none";
  return fitsBesideSystemSettings(areaWidth) ? "beside" : "inline";
}

/** The permission a source needs, as the system's media access names it. */
export const MEDIA_ACCESS_OF: Readonly<Record<AudioSource, "microphone" | "screen">> = {
  microphone: "microphone",
  // The computer's sound is Chromium's loopback, a screen capture with audio.
  system: "screen",
};

/** Whether the system's answer to "may IncarnaMind use this?" means the permission is there now. */
export const isGranted = (access: string): boolean => access === "granted";
