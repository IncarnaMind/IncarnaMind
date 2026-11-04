import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/*
 * DESIGN.md, Colors (Red, sparingly): red is for a contradicted claim, the
 * recording dot, and a button that can't be undone in a dialog that asks. An
 * error is a Problem in ink after the amber "!" or the `attention` dot. A new
 * red fails here until it is listed, with the reason it may be red.
 */

const renderer = join(__dirname, "../../src/renderer");

/** The red token and its wash, their literal colours, and Tailwind's own reds. */
const RED =
  /\b[a-z]+-danger(?:-wash)?\b|#(?:b42318|912018|fef0ee|e8202a)\b|\b(?:text|bg|border|ring|outline|fill|stroke|from|via|to)-red-\d+\b/i;

/** A rule that sets red: its file, then its selectors from the outside in. */
const RED_RULES = [
  "src/styles.css @theme",
  'src/styles.css .margin-check[data-check="contradicted"], .citation-marker[data-check="contradicted"], .citation-card--contradicted',
  // A contradicted Citation's badge in an Answer, which has no margin for its mark.
  'src/styles.css .mind-editor.assistant-answer-text .citation-marker &[data-check="contradicted"]',
  'src/styles.css .margin-check &[data-check="contradicted"]',
  // An Answer's check step, its ≠ when a sentence of it is contradicted (#2311).
  'src/styles.css .answer-step-check[data-check="contradicted"]',
  'src/styles.css .citation-marker &[data-check="contradicted"]',
  'src/styles.css .citation-run &[data-check="contradicted"]',
  "src/styles.css .chart-check--contradicted",
  'src/styles.css :is(.check-row, .check-badge-mark)[data-part="contradicted"] .mind-health-icon',
  "src/styles.css .claim-wash--contradicted",
  // A note's state when a claim is contradicted (D266): the margin's red, in words.
  'src/styles.css .check-badge[data-tone="error"] .check-badge-words',
  'src/styles.css .home-recent-state[data-tone="error"]',
  // The outline of a picture a contradicted quote was read from.
  'src/viewer/viewer.css [data-quote-tone="contradicted"]',
  'src/viewer/viewer.css [data-quote-tone="contradicted"] .quote-highlight, .highlight',
  'src/viewer/viewer.css [data-quote-tone="contradicted"] td.viewer-cell--quote',
  "src/viewer/viewer.css .quote-mark--contradicted",
  "src/styles.css .recording-dot",
  // A cell's note, drawn with the red corner Excel gives it.
  "src/viewer/viewer.css .viewer-grid td.viewer-cell--note::after",
];

/** The only code that names red: the button variant the dialogs below use. */
const RED_CODE = ["src/components/ui.ts"];

const RED_BUTTON_DIALOGS = [
  "src/components/DeletePermanentlyDialog.tsx",
  "src/components/UnlinkFolderDialog.tsx",
];

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? sources(path) : [path];
  });
}

const files = sources(renderer).map((path) => ({
  name: relative(renderer, path).split("\\").join("/"),
  text: readFileSync(path, "utf8"),
}));
const styleSheets = files.filter(({ name }) => name.endsWith(".css"));
const code = files.filter(({ name }) => /\.tsx?$/.test(name));

const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));

/** The selectors, outermost first, of each rule in a style sheet that has a declaration setting red. */
function redRules(sheet: string): Set<string> {
  const found = new Set<string>();
  const text = withoutComments(sheet);
  const open: string[] = [];
  let from = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char !== "{" && char !== "}" && char !== ";") continue;
    const part = text.slice(from, at).replace(/\s+/g, " ").trim();
    from = at + 1;
    if (char === "{") {
      open.push(part);
      continue;
    }
    if (part && RED.test(part)) {
      found.add(open.filter((each) => !each.startsWith("@") || each === "@theme").join(" "));
    }
    if (char === "}") open.pop();
  }
  return found;
}

describe("red", () => {
  test("is set only by the rules that keep it", () => {
    const used = styleSheets.flatMap(({ name, text }) =>
      [...redRules(text)].map((rule) => `${name} ${rule}`),
    );
    expect(used.filter((rule) => !RED_RULES.includes(rule))).toEqual([]);
  });

  test("is named in code only by the red button", () => {
    const used = code.filter(({ text }) => RED.test(withoutComments(text))).map(({ name }) => name);
    expect(used.filter((name) => !RED_CODE.includes(name))).toEqual([]);
  });

  test("is a button only where it can't be undone and a dialog asks", () => {
    const users = code
      .filter(({ name }) => !RED_CODE.includes(name))
      .filter(({ text }) => /dangerButtonClass|buttonStyle\(\s*"danger"/.test(text))
      .map(({ name }) => name);
    expect(users.sort()).toEqual(RED_BUTTON_DIALOGS);
  });
});
