/**
 * Light or dark (#1262), for every window's page: the User's choice in Settings › General ›
 * Appearance pins <html data-theme>, which styles.css follows whatever the system says; "system"
 * leaves the page to the system's appearance, live. The first frame needs none of this: the main
 * process has given Electron the kept choice before the window opened.
 */
import type { Appearance } from "../../core/api";
import { useAppStore } from "./store";

export type Theme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

let chosen: Appearance = "system";
let system: Theme = "light";

/** Follows the system's light or dark, which Same as system shows. */
export function installAppearance(): void {
  const query = window.matchMedia(DARK_QUERY);
  system = query.matches ? "dark" : "light";
  query.addEventListener("change", (event) => {
    system = event.matches ? "dark" : "light";
  });
}

export function showAppearance(appearance: Appearance): void {
  chosen = appearance;
  const root = document.documentElement;
  if (appearance === "system") delete root.dataset.theme;
  else root.dataset.theme = appearance;
}

/** The theme the window shows now: the one chosen, or the system's. */
export const shownTheme = (): Theme => (chosen === "system" ? system : chosen);

/** The other theme, which ⌘K's switch chooses and names. */
export const otherTheme = (): Theme => (shownTheme() === "dark" ? "light" : "dark");

/** The User's choice, shown at once; then as the core kept it, the old one if it refused. */
export async function chooseAppearance(appearance: Appearance): Promise<void> {
  showAppearance(appearance);
  await useAppStore.getState().updateSettings({ device: { appearance } });
  showAppearance(useAppStore.getState().settings?.device.appearance ?? "system");
}
