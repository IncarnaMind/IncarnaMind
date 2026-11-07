/**
 * Light or dark (#1262), for every window's page: the User's choice in Settings › General ›
 * Appearance pins <html data-theme>, which styles.css follows whatever the system says; "system"
 * leaves the page to the system's appearance, live. The first frame needs none of this: the main
 * process has given Electron the kept choice before the window opened.
 */
import type { Appearance } from "../../core/api";

export type Theme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function showAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  if (appearance === "system") delete root.dataset.theme;
  else root.dataset.theme = appearance;
}

/** The theme the window shows now: the one chosen, or the system's. */
export function shownTheme(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** The other theme, which ⌘K's switch chooses. */
export const otherTheme = (): Theme => (shownTheme() === "dark" ? "light" : "dark");
