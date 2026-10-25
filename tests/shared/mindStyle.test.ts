import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { fontKind } from "../../src/shared/fontKinds";
import {
  cssString,
  DEFAULT_MIND_STYLE,
  exportedFamily,
  fontFamilyList,
  isMindFont,
  isMindStyle,
  type MindStyle,
  mindStyleOf,
  sameStyle,
  TEXT_SIZES,
  writeMindStyle,
  writingProperties,
  writingType,
} from "../../src/shared/mindStyle";

const settings = () => new Y.Doc().getMap<unknown>("settings");

describe("what counts as a Mind's style", () => {
  test("is a preset or an installed family, and a size", () => {
    expect(isMindStyle(DEFAULT_MIND_STYLE)).toBe(true);
    expect(isMindStyle({ font: "serif", size: "large" })).toBe(true);
    expect(isMindStyle({ font: { family: "Songti SC" }, size: "small" })).toBe(true);
  });

  test.each([
    ["a font the app doesn't have", { font: "cursive", size: "default" }],
    ["a family with nothing in it", { font: { family: "  " }, size: "default" }],
    ["a family with a control character", { font: { family: "Bad\u0000Font" }, size: "default" }],
    ["a family that isn't text", { font: { family: 12 }, size: "default" }],
    ["a family with more in it", { font: { family: "Georgia", weight: 700 }, size: "default" }],
    ["a size it hasn't got", { font: "serif", size: "huge" }],
    ["more than a font and a size", { font: "serif", size: "large", spacing: 2 }],
    ["no size", { font: "serif" }],
  ])("is not %s", (_name, value) => {
    expect(isMindStyle(value)).toBe(false);
  });

  test("a family longer than a font name can be is refused", () => {
    expect(isMindFont({ family: "x".repeat(201) })).toBe(false);
    expect(isMindFont({ family: "x".repeat(200) })).toBe(true);
  });
});

describe("a Mind's style in its settings", () => {
  test("a Mind that never chose is in the default style", () => {
    expect(mindStyleOf(settings())).toEqual(DEFAULT_MIND_STYLE);
  });

  test("keeps what was written, and forgets what is the default again", () => {
    const map = settings();
    writeMindStyle(map, { font: { family: "Georgia" }, size: "large" });
    expect(mindStyleOf(map)).toEqual({ font: { family: "Georgia" }, size: "large" });
    writeMindStyle(map, { font: "mono", size: "default" });
    expect(mindStyleOf(map)).toEqual({ font: "mono", size: "default" });
    expect(map.has("textSize")).toBe(false);
    writeMindStyle(map, DEFAULT_MIND_STYLE);
    expect([...map.keys()]).toEqual([]);
  });

  test("writing the style a Mind is in changes nothing", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("settings");
    writeMindStyle(map, { font: { family: "Georgia" }, size: "small" });
    let updates = 0;
    doc.on("update", () => updates++);
    writeMindStyle(map, { font: { family: "Georgia" }, size: "small" });
    expect(updates).toBe(0);
  });

  test("anything malformed counts as no choice", () => {
    const map = settings();
    map.set("font", { family: "" });
    map.set("textSize", "gigantic");
    expect(mindStyleOf(map)).toEqual(DEFAULT_MIND_STYLE);
    map.set("font", "serif");
    expect(mindStyleOf(map)).toEqual({ font: "serif", size: "default" });
  });

  test("a family is the same font however it was made", () => {
    const a: MindStyle = { font: { family: "Georgia" }, size: "default" };
    expect(sameStyle(a, { font: { family: "Georgia" }, size: "default" })).toBe(true);
    expect(sameStyle(a, { font: { family: "Times" }, size: "default" })).toBe(false);
    expect(sameStyle(a, { font: "serif", size: "default" })).toBe(false);
  });
});

describe("the type a Mind is written in", () => {
  test("is 16/26 by default, and 17/28 in Serif, which reads smaller (DESIGN.md)", () => {
    expect(writingType(DEFAULT_MIND_STYLE, true).body).toEqual({ size: 16, leading: 26 });
    expect(writingType({ font: "serif", size: "default" }, true).body).toEqual({
      size: 17,
      leading: 28,
    });
    expect(writingType({ font: "mono", size: "default" }, true).body).toEqual({
      size: 16,
      leading: 26,
    });
  });

  test("keeps the title 34/42 and the headings 22/30 at the default size", () => {
    const type = writingType(DEFAULT_MIND_STYLE, true);
    expect(type.display).toEqual({ size: 34, leading: 42 });
    expect(type.heading).toEqual({ size: 22, leading: 30 });
  });

  test("the writing is 14/23, 16/26 and 18/29, and a step up in Serif: 15/24, 17/28 and 19/31", () => {
    const bodies = (font: "default" | "serif" | "mono") =>
      TEXT_SIZES.map((size) => writingType({ font, size }, true).body);
    const other = [
      { size: 14, leading: 23 },
      { size: 16, leading: 26 },
      { size: 18, leading: 29 },
    ];
    expect(bodies("default")).toEqual(other);
    expect(bodies("mono")).toEqual(other);
    expect(bodies("serif")).toEqual([
      { size: 15, leading: 24 },
      { size: 17, leading: 28 },
      { size: 19, leading: 31 },
    ]);
  });

  test("Small and Large scale the body, the headings and the title together", () => {
    const small = writingType({ font: "default", size: "small" }, true);
    const large = writingType({ font: "default", size: "large" }, true);
    expect(small.body.size).toBeLessThan(16);
    expect(large.body.size).toBeGreaterThan(16);
    expect(small.heading.size).toBeLessThan(22);
    expect(large.heading.size).toBeGreaterThan(22);
    expect(small.display.size).toBeLessThan(34);
    expect(large.display.size).toBeGreaterThan(34);
    // The line keeps its room as the text grows.
    expect(large.body.leading / large.body.size).toBeCloseTo(26 / 16, 1);
    expect(small.body.leading / small.body.size).toBeCloseTo(26 / 16, 1);
  });

  test("a line spacing is that many single lines of the text, which the title and headings don't take", () => {
    const spaced = writingType({ font: "default", size: "default", lineSpacing: 2 }, true);
    expect(spaced.body).toEqual({ size: 16, leading: 37 });
    expect(spaced.heading).toEqual(writingType(DEFAULT_MIND_STYLE, true).heading);
    expect(spaced.note).toEqual(writingType(DEFAULT_MIND_STYLE, true).note);
    expect(writingType({ ...DEFAULT_MIND_STYLE, lineSpacing: "default" }, true).body).toEqual({
      size: 16,
      leading: 26,
    });
  });

  test("footnotes, References and tables stay one pixel and two of leading below the writing at every font and size", () => {
    for (const font of ["default", "serif", "mono", { family: "Georgia" }] as const) {
      for (const size of TEXT_SIZES) {
        const { body, note } = writingType({ font, size }, true);
        expect(note).toEqual({ size: body.size - 1, leading: body.leading - 2 });
      }
    }
    expect(writingType(DEFAULT_MIND_STYLE, true).note).toEqual({ size: 15, leading: 24 });
  });

  test("goes to the page as the theme's own sizes and the writing font", () => {
    const properties = writingProperties(writingType({ font: "serif", size: "default" }, true));
    expect(properties).toMatchObject({
      "--writing-font": "var(--font-serif)",
      "--text-body": "17px",
      "--text-body--line-height": "28px",
      "--text-heading": "22px",
      "--text-display": "34px",
      "--text-note": "16px",
      "--text-note--line-height": "26px",
    });
  });
});

describe("the font family a Mind is drawn in", () => {
  test("a preset is the app's own font for it", () => {
    expect(fontFamilyList("default", true)).toBe("var(--font-system)");
    expect(fontFamilyList("serif", true)).toBe("var(--font-serif)");
    expect(fontFamilyList("mono", true)).toBe("var(--font-mono-writing)");
  });

  test("a font installed here comes first, then the system's Chinese face of its kind", () => {
    expect(fontFamilyList({ family: "Georgia" }, true)).toBe(
      '"Georgia", var(--font-cjk-serif), var(--font-system)',
    );
    expect(fontFamilyList({ family: "Helvetica Neue" }, true)).toBe(
      '"Helvetica Neue", var(--font-cjk-sans), var(--font-system)',
    );
  });

  test("a font that isn't installed here falls back to the default font, Chinese included", () => {
    expect(fontFamilyList({ family: "Georgia" }, false)).toBe("var(--font-system)");
    expect(writingType({ font: { family: "Georgia" }, size: "default" }, false).family).toBe(
      "var(--font-system)",
    );
  });

  test("a name can't break out of the string it is written in", () => {
    expect(cssString('Evil"; } body { display: none; } x { font-family: "')).not.toContain('"; }');
    expect(cssString("</style><script>")).not.toMatch(/[<>]/);
    expect(cssString("A\\B")).toBe('"A\\5c B"');
  });
});

describe("what exports write", () => {
  test("a preset is its font's name, a family its own, and the default none", () => {
    expect(exportedFamily("default")).toBeNull();
    expect(exportedFamily("serif")).toBe("Source Serif 4");
    expect(exportedFamily("mono")).toBe("JetBrains Mono");
    expect(exportedFamily({ family: "Songti SC" })).toBe("Songti SC");
  });
});

describe("a font's kind, from its name", () => {
  test.each([
    ["Georgia", "serif"],
    ["Songti SC", "serif"],
    ["宋体", "serif"],
    ["Helvetica Neue", "sans"],
    ["PingFang SC", "sans"],
    ["Menlo", "mono"],
    ["Something Unheard Of", "sans"],
  ])("%s is %s", (name, kind) => {
    expect(fontKind(name)).toBe(kind);
  });
});
