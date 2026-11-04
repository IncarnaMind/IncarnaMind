/**
 * A highlight's colours (#327, DESIGN.md › Viewer › Highlights and comments):
 * yellow, pink and purple for the User's own, each keeping body text at 4.5:1
 * and none of them mistakable for a wash that already means something else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ANNOTATION_COLOURS } from "../../src/core/api";

const renderer = join(__dirname, "../../src/renderer/src");
const viewerCss = readFileSync(join(renderer, "viewer/viewer.css"), "utf8");
const tokensCss = readFileSync(join(renderer, "styles.css"), "utf8");

const hex = (value: string): [number, number, number] => {
  const number = Number.parseInt(value.slice(1), 16);
  return [(number >> 16) & 0xff, (number >> 8) & 0xff, number & 0xff];
};

const washes = new Map<string, string>();
for (const match of viewerCss.matchAll(
  /\.annotation-highlight--(\w+),[\s\S]{0,160}?--annotation-wash:\s*(#[0-9a-f]{6});/g,
)) {
  const [, colour, value] = match;
  if (colour && value) washes.set(colour, value);
}

const token = (name: string): string => {
  const match = tokensCss.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`));
  if (!match?.[1]) throw new Error(`The token ${name} isn't in styles.css.`);
  return match[1];
};

const channel = (value: number): number => {
  const each = value / 255;
  return each <= 0.03928 ? each / 12.92 : ((each + 0.055) / 1.055) ** 2.4;
};

const luminance = (colour: string): number => {
  const [r = 0, g = 0, b = 0] = hex(colour);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

const distance = (a: string, b: string): number => {
  const [r1 = 0, g1 = 0, b1 = 0] = hex(a);
  const [r2 = 0, g2 = 0, b2 = 0] = hex(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
};

describe("a highlight's colours", () => {
  test("the User is offered yellow, pink and purple", () => {
    expect(ANNOTATION_COLOURS).toEqual(["yellow", "pink", "purple"]);
  });

  test("body text keeps 4.5:1 on each, and none is taken for another wash", () => {
    const ink = token("ink");
    const forbidden = [
      token("success-wash"),
      token("warning-wash"),
      token("accent-wash"),
      token("danger-wash"),
      "#fcebc0",
    ];
    for (const colour of ANNOTATION_COLOURS) {
      const wash = washes.get(colour);
      if (!wash) throw new Error(`The wash for ${colour} isn't in viewer.css.`);
      expect(contrast(wash, ink), `${colour} against ink`).toBeGreaterThanOrEqual(4.5);
      for (const other of forbidden) {
        expect(distance(wash, other), `${colour} against ${other}`).toBeGreaterThanOrEqual(40);
      }
    }
  });
});
