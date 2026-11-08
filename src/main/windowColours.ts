/**
 * The colours a window needs before its page has painted, and those of the window buttons Windows
 * draws over the top band (#1262): styles.css's `frame`, `sheet`, `tab-strip` and `ink-secondary`
 * in each theme, since the main process can't read the page's style sheet. A unit test holds them
 * to the tokens.
 */
export const WINDOW_COLOURS = {
  frame: { light: "#F4F5F7", dark: "#141518" },
  sheet: { light: "#FFFFFF", dark: "#1E2024" },
  tabStrip: { light: "#E6E8EB", dark: "#0E0F11" },
  inkSecondary: { light: "#4A4F57", dark: "#B2B7BE" },
} as const;

export type Theme = "light" | "dark";
export type WindowSurface = "frame" | "sheet";

/** Windows' minimise, maximise and close, over the band's right end in its colours. */
export const overlayColours = (theme: Theme) => ({
  color: WINDOW_COLOURS.tabStrip[theme],
  symbolColor: WINDOW_COLOURS.inkSecondary[theme],
});
