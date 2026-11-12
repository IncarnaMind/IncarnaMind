import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/*
 * The UI audit (e2e/audit) isn't run by CI, so a test id it clicks can leave the app
 * unnoticed (#2680). This reads every id its scripts use and fails when the renderer has no
 * such id, so the pull request that renames one is the one that fails.
 */

const ROOT = join(__dirname, "..", "..");
const AUDIT = join(ROOT, "e2e", "audit");
// The bare Electron app the audit measures typing against: its ids live in its own main.
const BASELINE = join(AUDIT, "baseline", "main.cjs");

const sourcesIn = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));

const rendererText = [
  ...sourcesIn(join(ROOT, "src", "renderer")),
  readFileSync(BASELINE, "utf8"),
].join("\n");

/** What the app gives a test id from parts, which no scan of its text could find whole. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the text of the app's own template.
const TAB_OF_A_KIND = ["`${tab.item.kind}-tab`"];
const BUILT_FROM_PARTS: Record<string, string[]> = {
  "mind-tab": TAB_OF_A_KIND,
  "document-tab": TAB_OF_A_KIND,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of the app's own template.
  "page-menu": ['testId="page"', "`${prefix}-menu`"],
};

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Every quoted word that could be a test id, anywhere in the renderer. */
function quotedIds(text: string): Set<string> {
  const found = new Set<string>();
  for (const [, , word] of text.matchAll(/(["'`])([^"'`\s${}]+)\1/g)) {
    if (word && ID.test(word)) found.add(word);
  }
  return found;
}

/** The templates a test id is made from on a line that names one, such as `settings-nav-${each}`. */
function idTemplates(text: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const line of text.split("\n")) {
    if (!/test-?id/i.test(line)) continue;
    for (const [, template] of line.matchAll(/`([a-z][a-z0-9:-]*)\$\{[^`]*`/g)) {
      patterns.push(new RegExp(`^${template}.+$`));
    }
  }
  return patterns;
}

const known = quotedIds(rendererText);
const templates = idTemplates(rendererText);

function inTheApp(id: string): boolean {
  if (id in BUILT_FROM_PARTS) {
    return BUILT_FROM_PARTS[id]?.every((part) => rendererText.includes(part)) ?? false;
  }
  const sample = id.replace(/\$\{[^}]*\}/g, "x");
  return known.has(id) || templates.some((pattern) => pattern.test(sample));
}

/** The test ids a script names: `getByTestId("…")`, and `[data-testid="…"]` in a selector. */
function idsIn(text: string): string[] {
  const ids = new Set<string>();
  for (const [, , id] of text.matchAll(/getByTestId\((["'`])([^"'`]+)\1\)/g)) {
    if (id) ids.add(id);
  }
  for (const [, id] of text.matchAll(/data-testid=\\?["']?([a-z][a-z0-9-]*)/g)) {
    if (id) ids.add(id);
  }
  return [...ids];
}

const scripts = readdirSync(AUDIT)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ name, text: readFileSync(join(AUDIT, name), "utf8") }));

describe("the UI audit's test ids", () => {
  test("every id the audit scripts use is in the app", () => {
    const missing = scripts.flatMap(({ name, text }) =>
      idsIn(text)
        .filter((id) => !inTheApp(id))
        .map((id) => `${name}: ${id}`),
    );
    expect(missing).toEqual([]);
  });

  test("the scripts do use ids, and an id that is gone is told from one that is there", () => {
    expect(scripts.map((each) => each.name)).toEqual(
      expect.arrayContaining(["walk.audit.ts", "speed.audit.ts"]),
    );
    expect(idsIn(`await click(window, window.getByTestId("plus-new-mind"));`)).toEqual([
      "plus-new-mind",
    ]);
    expect(idsIn(`window.locator('[data-testid="page-menu"]:visible')`)).toEqual(["page-menu"]);
    expect(inTheApp("plus-new-mind")).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an id as a script writes it.
    expect(inTheApp("settings-nav-${page}")).toBe(true);
    expect(inTheApp("document-tab")).toBe(true);
    expect(inTheApp("no-such-test-id-anywhere")).toBe(false);
  });
});
