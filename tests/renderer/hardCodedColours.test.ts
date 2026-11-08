import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/*
 * Every colour the interface draws comes from a token in styles.css, which has a value for each
 * theme (#1262): a colour written anywhere else would stay the same in Dark. The few listed here
 * must not change with the theme, each for the reason given. A new one fails until it is a token,
 * or listed with its reason.
 */

const renderer = join(__dirname, "../../src/renderer");

/** Colours that are not the app's, by file: what a file or a system draws, kept as it draws it. */
const KEPT: Readonly<Record<string, { colours: readonly string[]; why: string }>> = {
  "print/print.css": {
    colours: ["*"],
    why: "the PDF export is printed paper, with its own palette, whatever the app's theme",
  },
  "src/styles.css": {
    colours: ["#000"],
    why: "a mask's opaque end: only its alpha is used, never shown as a colour",
  },
  "src/editor/wordTableCss.ts": {
    colours: ["#000"],
    why: "a mask's opaque end: only its alpha is used, never shown as a colour",
  },
  "src/viewer/viewer.css": {
    colours: [
      "#000",
      "#e8202a",
      "rgb(246 214 150 / 0.55)",
      "#ffe066",
      "#d4f0cc",
      "#d6e8ff",
      "#ffc2da",
      "#d6bdff",
      "#f3d64c",
      "#7ac574",
      "#6aa8ee",
      "#ee8fb7",
      "#b28ce8",
    ],
    why: "on a Document's paper: a workbook's default ink and Excel's red note corner, Word's comment wash, and the User's highlight colours with their swatches",
  },
  "src/viewer/slides/slides.css": {
    colours: ["#000000"],
    why: "PowerPoint's default text colour, on the deck's own slide",
  },
  "src/viewer/slides/ChartView.tsx": {
    colours: ["#d9d9d9", "#bfbfbf", "#595959", "#4472c4", "#ffffff"],
    why: "Office's own chart colours, drawn on the deck's slide as PowerPoint draws them",
  },
  "src/editor/wordLookCss.ts": {
    colours: [
      "#ffff00",
      "#00ff00",
      "#00ffff",
      "#ff00ff",
      "#0000ff",
      "#ff0000",
      "#000080",
      "#008080",
      "#008000",
      "#800080",
      "#800000",
      "#808000",
      "#808080",
      "#c0c0c0",
      "#000000",
      "#ffffff",
    ],
    why: "Word's highlight palette, on a Word-look Note's paper",
  },
  "src/permissionGuide/GuideSteps.tsx": {
    colours: ["bg-white"],
    why: "the knob of macOS's own switch, which macOS draws white in both its themes",
  },
};

const NAMED = "white|black|red|orange|yellow|green|blue|purple|pink|gray|grey|silver|navy";
const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^)]*\)/gi;
const TAILWIND = new RegExp(
  `\\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|decoration|caret|accent|divide|placeholder)-(?:white|black|(?:${PALETTE})-\\d{2,3})\\b`,
  "g",
);

const withoutBlockComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));

/** What a style sheet's declarations set, past the tokens styles.css defines. */
function cssColours(text: string): string[] {
  const found: string[] = [];
  for (const [, property = "", value = ""] of withoutBlockComments(text).matchAll(
    /(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+)/g,
  )) {
    if (/^--(?:color|shadow)-/.test(property)) continue;
    found.push(...(value.match(/#[0-9a-f]{3,8}\b/gi) ?? []), ...(value.match(FUNCTION) ?? []));
    found.push(...(value.match(new RegExp(`(?<![\\w"'-])(?:${NAMED})(?![\\w-])`, "g")) ?? []));
  }
  return found;
}

/** The colours a script writes into a class or a style. */
function codeColours(text: string): string[] {
  const code = withoutBlockComments(text).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return [
    ...(code.match(/(?<=["'`[(\s,])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})(?![\w])/gi) ?? []),
    ...(code.match(FUNCTION) ?? []),
    ...(code.match(TAILWIND) ?? []),
  ];
}

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? sources(path) : [path];
  });
}

const files = sources(renderer)
  .filter((path) => /\.(css|tsx?|html)$/.test(path))
  .map((path) => ({
    name: relative(renderer, path).split("\\").join("/"),
    text: readFileSync(path, "utf8"),
  }));

const normal = (colour: string) => colour.toLowerCase().replace(/\s+/g, " ");

describe("colours in the interface", () => {
  test("every colour is a token, but those that must not change with the theme", () => {
    const strays: string[] = [];
    for (const { name, text } of files) {
      const found = name.endsWith(".css") ? cssColours(text) : codeColours(text);
      const kept = KEPT[name]?.colours ?? [];
      if (kept.includes("*")) continue;
      for (const colour of found) {
        if (!kept.includes(normal(colour))) strays.push(`${name}: ${colour}`);
      }
    }
    expect(strays).toEqual([]);
  });

  test("each colour kept as it is is still there, so the list says what is true", () => {
    for (const [name, { colours }] of Object.entries(KEPT)) {
      const file = files.find((each) => each.name === name);
      expect(file, name).toBeDefined();
      if (!file || colours.includes("*")) continue;
      const found = (name.endsWith(".css") ? cssColours(file.text) : codeColours(file.text)).map(
        normal,
      );
      for (const colour of colours) expect(found, `${name}: ${colour}`).toContain(colour);
    }
  });
});
