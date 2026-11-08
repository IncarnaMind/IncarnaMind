import { describe, expect, test } from "vitest";
import { TAG_COLOURS } from "../../src/shared/tagColours";
import { contrast, luminance, type Theme, token } from "../helpers/contrast";

/*
 * A Tag's dot (DESIGN.md, Tags) is all that says which Tag it is on a
 * sidebar row, so it must stand out from where it sits: 3:1 or better,
 * WCAG's contrast for graphics, on the sidebar (frame), a row pointed at
 * (hover) and a selected row (sheet). A light hue (yellow, say) may be under
 * that if its hairline edge, a darker shade, is not. A named chip's text
 * must read on its fill. Both themes (#1262).
 */
const surfaces = ["frame", "hover", "sheet"];
const THEMES: readonly Theme[] = ["light", "dark"];

describe.each(THEMES)("Tag dots in the %s theme", (theme) => {
  test("each stands out 3:1 on the sidebar, a row pointed at and a selected row, by itself or by its edge", () => {
    for (const colour of TAG_COLOURS) {
      const dot = token(`tag-${colour}-dot`, theme);
      const edge = token(`tag-${colour}-edge`, theme);
      for (const surface of surfaces) {
        const on = token(surface, theme);
        expect(
          Math.max(contrast(dot, on), contrast(edge, on)),
          `${colour} (${dot}, edge ${edge}) on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
      // The edge is the dot's own colour or a darker shade of it, never a lighter one.
      expect(luminance(edge)).toBeLessThanOrEqual(luminance(dot));
    }
  });

  test("the review ring stands out 3:1 too, and is darker than the orange dot", () => {
    const ring = token("review", theme);
    for (const surface of surfaces) {
      expect(contrast(ring, token(surface, theme)), surface).toBeGreaterThanOrEqual(3);
    }
    expect(luminance(ring)).toBeLessThan(luminance(token("tag-orange-dot", theme)));
  });
});

describe("Tag dots' edges", () => {
  test("yellow, the lightest, needs its edge in the light theme; purple stands out by itself", () => {
    const frame = token("frame");
    expect(contrast(token("tag-yellow-dot"), frame)).toBeLessThan(3);
    expect(contrast(token("tag-yellow-edge"), frame)).toBeGreaterThanOrEqual(3);
    expect(token("tag-purple-edge")).toBe(token("tag-purple-dot"));
  });

  test("in the dark theme every dot stands out by itself, so each edge is its dot", () => {
    for (const colour of TAG_COLOURS) {
      expect(token(`tag-${colour}-edge`, "dark"), colour).toBe(token(`tag-${colour}-dot`, "dark"));
    }
  });
});

describe.each(THEMES)("Tag chips in the %s theme", (theme) => {
  test("each chip's text reads on its fill at 7:1 or better", () => {
    for (const colour of TAG_COLOURS) {
      const fill = token(`tag-${colour}`, theme);
      const ink = token(`tag-${colour}-ink`, theme);
      expect(contrast(ink, fill), `${colour} (${ink} on ${fill})`).toBeGreaterThanOrEqual(7);
    }
  });
});
