import { describe, expect, it } from "vitest";
import { titleBarOptions } from "../../src/main/titleBar";

/*
 * The window's title bar per platform. Only macOS's runs in the smoke tests
 * (e2e/titleBar.spec.ts), so Windows' and Linux's options are pinned here.
 */
describe("titleBarOptions", () => {
  it("centres macOS's 14px traffic lights on the headers' line, y 26, at the sidebar's icon column", () => {
    expect(titleBarOptions("darwin", "light")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 26 - 14 / 2 },
    });
  });

  it("draws Windows' buttons over the band's right end, as tall as the band and in its colours", () => {
    expect(titleBarOptions("win32", "light")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#E6E8EB", symbolColor: "#4A4F57", height: 44 },
    });
  });

  it("draws them in the band's dark colours in the dark theme (#1262)", () => {
    expect(titleBarOptions("win32", "dark")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#0E0F11", symbolColor: "#B2B7BE", height: 44 },
    });
  });

  it("keeps Linux's own title bar", () => {
    expect(titleBarOptions("linux", "dark")).toEqual({});
  });
});
