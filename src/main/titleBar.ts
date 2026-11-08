/**
 * The window's title bar options per platform (src/shared/titleBar.ts), and
 * telling the page when the window goes full screen, where macOS hides its
 * traffic lights and the page gives their room back.
 */
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { FILES_CHANNELS } from "../shared/bridge";
import { titleBarOf } from "../shared/titleBar";
import { overlayColours, type Theme } from "./windowColours";

/** Every pane header is 44px (DESIGN.md), and so is the band they make. */
const BAND_HEIGHT = 44;
/**
 * The band the headers' contents sit in runs from y 8 (the card's top) to y 44,
 * and its centre, y 26, is the line they all share (DESIGN.md, Layout).
 */
const BAND_CENTRE = 26;
/** macOS 26's traffic lights are 14px circles (older ones 12px, in a 14px frame). */
const LIGHT_SIZE = 14;

export function titleBarOptions(
  platform: NodeJS.Platform,
  theme: Theme,
): BrowserWindowConstructorOptions {
  switch (titleBarOf(platform)) {
    case "inset":
      return {
        titleBarStyle: "hiddenInset",
        // On the band's line, the first at the sidebar's icon column (x 16).
        trafficLightPosition: { x: 16, y: BAND_CENTRE - LIGHT_SIZE / 2 },
      };
    case "overlay":
      return {
        titleBarStyle: "hidden",
        // Drawn over the band's right end in its colours: `tab-strip`, symbols in `ink-secondary`.
        titleBarOverlay: { ...overlayColours(theme), height: BAND_HEIGHT },
      };
    case "native":
      return {};
  }
}

/** Tells the page when the window enters full screen (true) and leaves it (false). */
export function reportFullScreen(window: BrowserWindow): void {
  window.on("enter-full-screen", () => window.webContents.send(FILES_CHANNELS.fullScreen, true));
  window.on("leave-full-screen", () => window.webContents.send(FILES_CHANNELS.fullScreen, false));
}
