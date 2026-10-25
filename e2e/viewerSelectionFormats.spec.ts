import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { type CoreBridge, MIND_TEXT_ORIGINS_FIELD } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  slideSelect,
  stubClipboard,
} from "./app";

/**
 * Selecting text in a Word file, a deck and its speaker notes, Markdown, plain
 * text and a saved web page (#101): Add to note gives a quote whose Citation
 * is found where the words were selected, told from the same words elsewhere
 * by the words around them.
 */

/** Office files to view (see tests/core/formats.test.ts). */
const FORMATS = join(__dirname, "../tests/fixtures/formats");
/** Words the Word fixture's Introduction and its Scope both say. */
const GAUGES = "Tide gauges along the coast were read every fifteen minutes";

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** The app with these files added, a new Mind with its cursor in it, and `name` open beside it. */
async function openBesideMind(files: string[], name: string, { web = "" } = {}) {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await addDocuments(window, files);
  if (web) {
    await window.evaluate(
      (html) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveWebPage({
          address: "https://encyclopedia.example/tea",
          html,
        }),
      web,
    );
  }
  await expectReadyDocuments(window, files.length + (web ? 1 : 0));
  await newMind(window);
  await window.keyboard.type("Notes");
  await pointAndClick(
    window,
    window.getByTestId("document-list-item").filter({ hasText: name }).getByTestId("open-document"),
  );
  return window;
}

/**
 * Selects `words` in `line` as a person drags from their first word to their
 * last, wherever the line wraps them, adds them to the note, and returns the
 * quote that came in.
 */
async function addToNote(window: Page, line: Locator, words: string): Promise<Locator> {
  await expect(line).toContainText(words);
  await line.scrollIntoViewIfNeeded();
  const all = words.split(" ");
  const first = all.slice(0, 2).join(" ");
  const last = all.slice(-2).join(" ");
  await slideSelect(window, line, first, { line, words: last });
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));
  const quote = window
    .locator('[data-testid="mind-pane"]:visible blockquote')
    .filter({ hasText: words });
  await expect(quote).toHaveCount(1);
  await expect(quote.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
  return quote;
}

const citedAt = (quote: Locator) => quote.getByTestId("citation-chip");
// A press inside the words still selected would drag them away rather than select anew.
const clearSelection = (window: Page) =>
  window.evaluate(() => globalThis.getSelection()?.removeAllRanges());
const quotesIn = (window: Page) => window.locator('[data-testid="mind-pane"]:visible blockquote');

test("Word: words the file says in two sections cite the section they were selected in", async () => {
  const path = join(sources, "Coastal Flood Risk Review.docx");
  await copyFile(join(FORMATS, "Coastal Flood Risk Review.docx"), path);
  const window = await openBesideMind([path], "Coastal Flood");
  const scope = window.getByTestId("viewer-docx").locator("p", { hasText: "Scope paragraph 1." });

  const quote = await addToNote(window, scope, GAUGES);

  await expect(citedAt(quote)).toHaveAttribute("aria-label", /§ 1\.1 Scope/);
});

test("PowerPoint: a slide's text, over its bullet points, and its speaker notes cite their slide", async () => {
  const path = join(sources, "Quarterly Research Update.pptx");
  await copyFile(join(FORMATS, "Quarterly Research Update.pptx"), path);
  const window = await openBesideMind([path], "Quarterly Research");
  const slide = window.getByTestId("viewer-slide").filter({ hasText: "Key findings" });

  const text = await addToNote(window, slide, "Customer churn fell to 4.2 per cent");
  await expect(citedAt(text)).toHaveAttribute("aria-label", /slide 2/);
  // The bullets are drawn, not written: they are no part of the words.
  await clearSelection(window);
  await slideSelect(window, slide, "Customer churn", { line: slide, words: "112 per" });
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));
  const bullets = quotesIn(window).filter({ hasText: "dropped by a third" });
  await expect(bullets).toContainText(
    "redesign. Support tickets per customer dropped by a third. Net",
  );
  await expect(citedAt(bullets)).toHaveAttribute("data-check", "found");
  await expect(citedAt(bullets)).toHaveAttribute("aria-label", /slide 2/);

  const notes = slide.getByTestId("viewer-slide-notes");
  await pointAndClick(window, notes.locator("summary"));
  const spoken = await addToNote(window, notes, "it was 6.8 per cent a year ago");
  await expect(citedAt(spoken)).toHaveAttribute("aria-label", /slide 2/);
});

test("Markdown: across bold and a link, the note has the words as shown, cited in their section", async () => {
  const path = join(sources, "Review.md");
  await writeFile(
    path,
    [
      "# Method",
      "",
      "Rates fell sharply in the spring review, as the panel expected.",
      "",
      "# Results",
      "",
      "Rates fell **sharply** in [the spring review](https://example.org/review), as the panel expected.",
    ].join("\n"),
  );
  const window = await openBesideMind([path], "Review");
  const results = window.getByTestId("viewer-text").locator("p").last();

  const quote = await addToNote(window, results, "fell sharply in the spring review");

  await expect(quote).toContainText("fell sharply in the spring review");
  await expect(quote).not.toContainText("**");
  await expect(citedAt(quote)).toHaveAttribute("aria-label", /§ Results/);
});

test("Markdown: words over two paragraphs read apart in the note and on the clipboard", async () => {
  const path = join(sources, "Notes.md");
  await writeFile(
    path,
    ["The survey closed in June as expected.", "", "Second round answers came in July."].join("\n"),
  );
  const window = await openBesideMind([path], "Notes");
  const copied = await stubClipboard(window);
  const view = window.getByTestId("viewer-text");

  await slideSelect(window, view, "in June", { line: view, words: "round answers" });
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));

  const quote = quotesIn(window).filter({ hasText: "Second round" });
  await expect(quote).toContainText("as expected. Second round");
  await expect(citedAt(quote)).toHaveAttribute("data-check", "found");
  await clearSelection(window);
  await slideSelect(window, view, "in June", { line: view, words: "round answers" });
  await pointAndClick(window, window.getByTestId("viewer-selection-copy"));
  await expect
    .poll(async () => (await copied())["text/plain"] ?? "")
    .toContain("as expected. Second round");
});

test("Text: the same line ten times over isn't cited, and the notice says the words are in several places", async () => {
  const path = join(sources, "Repeated.txt");
  await writeFile(path, Array.from({ length: 10 }, () => "Tides rise twice a day.").join("\n"));
  const window = await openBesideMind([path], "Repeated");
  const view = window.getByTestId("viewer-text");
  await expect(view).toContainText("Tides rise twice a day.");
  // The fifth line, which has the same lines all around it.
  await view.evaluate((element) => {
    const text = element.querySelector("[data-unit] [data-at]")?.firstChild as Text;
    const line = "Tides rise twice a day.\n".length;
    const range = document.createRange();
    range.setStart(text, line * 4);
    range.setEnd(text, line * 5 - 1);
    globalThis.getSelection()?.removeAllRanges();
    globalThis.getSelection()?.addRange(range);
  });
  await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));

  await expect(window.getByTestId("error-notice-message")).toContainText("several places");
  await expect(window.locator('[data-testid="mind-pane"]:visible blockquote')).toHaveCount(0);
});

test("Text: the second of two same lines cites its own line, and copies with it", async () => {
  const path = join(sources, "Tides.txt");
  await writeFile(
    path,
    ["Tides rise twice a day.", "Spring tides are larger.", "Tides rise twice a day."].join("\n"),
  );
  const window = await openBesideMind([path], "Tides");
  const copied = await stubClipboard(window);
  const view = window.getByTestId("viewer-text");
  await expect(view).toContainText("Spring tides are larger.");
  // The last line, whose words the first line has too.
  const box = await view.evaluate((element) => {
    const text = element.querySelector("[data-unit] [data-at]")?.firstChild as Text;
    const range = document.createRange();
    const at = text.data.lastIndexOf("Tides rise");
    range.setStart(text, at);
    range.setEnd(text, at + "Tides rise twice a day.".length);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  await window.mouse.move(box.left + 1, box.y, { steps: 4 });
  await window.mouse.down();
  await window.mouse.move(box.right + 2, box.y, { steps: 10 });
  await window.mouse.up();
  await pointAndClick(window, window.getByTestId("viewer-selection-copy"));

  await expect.poll(async () => (await copied())["text/plain"] ?? "").toMatch(/line 3\b/);
});

test("a web page: a paragraph cites its section and paragraph, and its quote is the web page's text", async () => {
  const article = await readFile(join(__dirname, "../tests/fixtures/web/article.html"), "utf8");
  const window = await openBesideMind([], "Tea", { web: article });
  const page = window.getByTestId("viewer-web-article");

  const quote = await addToNote(
    window,
    page.locator("p", { hasText: "Dutch East India Company" }),
    "ship of the Dutch East India Company brought the first green tea leaves",
  );

  await expect(citedAt(quote)).toHaveAttribute("aria-label", /§ History, ¶\s2/);
  const origins = await window
    .locator('[data-testid="mind-pane"]:visible [data-testid="mind-editor"]')
    .evaluate((dom, field) => {
      const { editor } = dom as unknown as { editor: Editor };
      for (const plugin of editor.state.plugins) {
        const state = plugin.getState(editor.state) as
          | { doc?: { getMap(name: string): Map<string, unknown> } }
          | undefined;
        if (state?.doc?.getMap) return [...state.doc.getMap(field).values()];
      }
      return [];
    }, MIND_TEXT_ORIGINS_FIELD);
  expect(origins).toContain("web-page");
});
