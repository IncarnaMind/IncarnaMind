import { describe, expect, test } from "vitest";
import { TAG_COLOURS } from "../../src/shared/tagColours";
import { contrast, type Theme, token } from "../helpers/contrast";

/*
 * Every text colour passes 4.5:1 on each surface it is drawn on, in both themes (#1262; DESIGN.md,
 * Colors, "Light or dark"). Marks that aren't text (a check's ring, a Tag's dot, a placeholder,
 * which DESIGN keeps for placeholders and disabled text) pass 3:1, WCAG's bar for graphics.
 * A pair is [text, surface]; a new token drawn on a new surface is added here.
 */
const TEXT_ON_SURFACE: readonly (readonly [string, string])[] = [
  ...["ink", "ink-strong", "ink-answer", "ink-secondary", "ink-meta"].flatMap((ink) =>
    ["sheet", "frame", "hover", "chip", "wash", "accent-wash"].map(
      (surface) => [ink, surface] as const,
    ),
  ),
  // A tab's name and the toolbars' buttons on the tab strip, and pointed at.
  ...["ink", "ink-secondary"].flatMap((ink) =>
    ["tab-strip", "tab-hover"].map((surface) => [ink, surface] as const),
  ),
  ["ink", "selection-inactive"],
  ["ink", "mark"],
  // Links, the focus ring and a chosen row.
  ...["sheet", "frame", "hover", "accent-wash"].map((surface) => ["accent", surface] as const),
  ["accent-strong", "sheet"],
  ["accent-strong", "accent-wash"],
  // A check's words and marks, on the page and on their wash.
  ["success", "sheet"],
  ["success", "success-wash"],
  ["warning", "sheet"],
  ["warning", "warning-wash"],
  ["danger", "sheet"],
  ["danger", "danger-wash"],
  // Text and icons on a filled control.
  ...["ink", "ink-strong", "ink-secondary", "accent", "success", "danger", "danger-strong"].map(
    (fill) => ["on-primary", fill] as const,
  ),
  // The format menu's text colours, on a Note's sheet.
  ...["grey", "brown", "red", "orange", "yellow", "green", "blue", "purple"].map(
    (colour) => [`text-${colour}`, "sheet"] as const,
  ),
];

const MARKS_ON_SURFACE: readonly (readonly [string, string])[] = [
  ...["frame", "hover", "sheet"].map((surface) => ["review", surface] as const),
  ["attention", "sheet"],
  ["ink-placeholder", "sheet"],
  ...TAG_COLOURS.flatMap((colour) =>
    ["frame", "hover", "sheet"].map((surface) => [`tag-${colour}-edge`, surface] as const),
  ),
];

describe.each(["light", "dark"] satisfies Theme[])("the %s theme", (theme) => {
  test.each(TEXT_ON_SURFACE)("%s reads on %s at 4.5:1", (text, surface) => {
    const ratio = contrast(token(text, theme), token(surface, theme));
    expect(ratio, `${token(text, theme)} on ${token(surface, theme)}`).toBeGreaterThanOrEqual(4.5);
  });

  test.each(MARKS_ON_SURFACE)("%s stands out on %s at 3:1", (mark, surface) => {
    const ratio = contrast(token(mark, theme), token(surface, theme));
    expect(ratio, `${token(mark, theme)} on ${token(surface, theme)}`).toBeGreaterThanOrEqual(3);
  });

  test("a Tag chip's text reads on its fill at 7:1", () => {
    for (const colour of TAG_COLOURS) {
      expect(
        contrast(token(`tag-${colour}-ink`, theme), token(`tag-${colour}`, theme)),
        colour,
      ).toBeGreaterThanOrEqual(7);
    }
  });
});

describe("the dark theme keeps the light one's order (#1262)", () => {
  const brightness = (name: string, theme: Theme) => contrast(token(name, theme), "#000000");

  test("the sheet is the lightest surface, the frame darker than it, and the tab strip darker still", () => {
    for (const theme of ["light", "dark"] satisfies Theme[]) {
      expect(brightness("sheet", theme), theme).toBeGreaterThan(brightness("frame", theme));
      expect(brightness("frame", theme), theme).toBeGreaterThan(brightness("tab-strip", theme));
    }
  });

  test("the inks step down from ink to placeholder", () => {
    const inks = ["ink", "ink-answer", "ink-secondary", "ink-meta", "ink-placeholder"];
    for (const theme of ["light", "dark"] satisfies Theme[]) {
      const steps = inks.map((ink) => contrast(token(ink, theme), token("sheet", theme)));
      expect(steps, theme).toEqual([...steps].sort((a, b) => b - a));
    }
  });
});
