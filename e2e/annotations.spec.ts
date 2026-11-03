import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  newMind,
  openDocumentAt,
  pointAndClick,
  removeDataFolder,
  runFromPalette,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

/**
 * Highlights and notes on a Document (#327): made from the viewer's selection
 * menu by the mouse and the keyboard, drawn in the page, listed in its tab and
 * counted in the Library, recoloured, noted, edited, deleted with Undo, found
 * by ⌘K in English and Chinese, added to a Mind with a Citation that is found,
 * and a PDF's own highlights read from the file.
 */

const MARKDOWN = `# Costs

## Contingency

A contingency of 4% is held for weather delays.

## Programme

The programme allows 18 months from notice to handover.
`;

const CHINESE = `# 预算

## 应急费

应急费按 4% 预留，用于天气延误。

## 工期

工期从通知起算 18 个月。
`;

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

const frontMind = (window: Page) => window.locator('[data-testid="mind-pane"]:visible').first();

/** The version of the Document at `path` that is indexed, through the core's bridge. */
const contentHashOf = (window: Page, path: string) =>
  window.evaluate(async (wanted) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listDocuments()).find((each) => each.path === wanted)?.contentHash;
  }, path);

/** Writes a version of the file, dated as changed after `before`, and waits until it is indexed. */
async function writeVersion(window: Page, path: string, bytes: Uint8Array): Promise<void> {
  const before = await contentHashOf(window, path);
  await writeFile(path, bytes);
  const moment = new Date(Date.now() + 1000);
  await utimes(path, moment, moment);
  await expect.poll(() => contentHashOf(window, path), { timeout: 20_000 }).not.toBe(before);
}

const documentIdOf = async (window: Page): Promise<string> => {
  const ids = await (await coreOf(window)).evaluate(async (core) =>
    (await core.listDocuments()).map((document) => document.id),
  );
  const [id] = ids;
  if (!id) throw new Error("The Document wasn't added.");
  return id;
};

/** The app on a Markdown Document, open in the viewer, with the panel's row count read. */
async function openMarkdown(language: "en" | "zh-CN" = "en", text = MARKDOWN, name = "Costs.md") {
  const path = join(sources, name);
  await writeFile(path, text);
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  if (language !== "en") await setLanguage(window, language);
  await addDocuments(window, [path]);
  await expectReadyDocuments(window, 1);
  await openDocumentAt(window, { documentId: await documentIdOf(window) });
  const viewer = window.getByTestId("viewer");
  await expect(viewer.getByTestId("viewer-text")).toBeVisible();
  return { app, window, viewer };
}

const paragraph = (viewer: Locator, words: string) =>
  viewer.locator("p").filter({ hasText: words }).first();

const noteMark = (viewer: Locator) => viewer.locator("[data-annotation-note]").first();

async function openPanel(window: Page, viewer: Locator): Promise<Locator> {
  const toggle = viewer.getByTestId("viewer-annotations-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await pointAndClick(window, toggle);
  const panel = window.getByTestId("annotations-panel");
  await expect(panel).toBeVisible();
  return panel;
}

/** Selects words in a paragraph and chooses Highlight, in `colour`. */
async function highlight(
  window: Page,
  viewer: Locator,
  words: string,
  colour = "yellow",
): Promise<void> {
  await slideSelect(window, paragraph(viewer, words), words);
  await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
  // The colour's own swatch, so the click lands on the colour asked for, never the row's middle.
  await expect(window.getByTestId("viewer-selection-highlight")).toBeVisible();
  await pointAndClick(window, window.getByTestId(`viewer-selection-highlight-${colour}`));
  await expect(viewer.locator(`[data-annotation-id]`).first()).toContainText(words);
}

test("by the mouse: a highlight is drawn in the page, noted, recoloured, listed in its tab, counted in the Library and deleted with Undo", async () => {
  const { window, viewer } = await openMarkdown();

  await highlight(window, viewer, "4% is held");
  await expect(viewer.locator("[data-annotation-id]").first()).toHaveClass(/yellow/);
  await expect(window.getByTestId("undo-line")).toBeVisible();

  // Its note: the mark opens it, a click on the note edits it in place.
  await pointAndClick(window, noteMark(viewer));
  const popover = window.getByTestId("annotation-note");
  await expect(popover).toBeVisible();
  await pointAndClick(window, popover.getByTestId("annotation-note-start"));
  const field = popover.getByTestId("annotation-note-field");
  await expect(field).toBeFocused();
  await window.keyboard.type("Ask whether the 4% covers the roof.");
  await pointAndClick(window, popover.getByTestId("annotation-note-save"));
  await expect(popover.getByTestId("annotation-note-text")).toContainText(
    "Ask whether the 4% covers the roof.",
  );

  // Its colour, from the highlight's own menu.
  await pointAndClick(window, popover.getByTestId("annotation-colour-green"));
  await expect(viewer.locator("[data-annotation-id]").first()).toHaveClass(/green/);
  // Esc closes the note.
  await window.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  // Its Document's tab lists it, with its quote, note and Location.
  const panel = await openPanel(window, viewer);
  const row = panel.getByTestId("annotation-row").first();
  await expect(row).toContainText("4% is held");
  await expect(row).toContainText("Ask whether the 4% covers the roof.");
  await expect(row).toContainText("§ Contingency");
  await expect(row.locator(".annotation-colour--green")).toBeVisible();
  await expect(panel).toContainText("1 highlight");

  // The Library's row says it has one.
  await pointAndClick(window, window.getByTestId("open-library"));
  await expect(window.getByTestId("library-annotation-count").first()).toHaveText("1");

  // Delete, with Undo that puts it back: back in the Document's tab.
  await openDocumentAt(window, { documentId: await documentIdOf(window) });
  await openPanel(window, window.getByTestId("viewer"));
  await pointAndClick(window, row.getByTestId("annotation-row-delete"));
  await expect(panel.getByTestId("annotation-row")).toHaveCount(0);
  await expect(window.getByTestId("undo-line")).toContainText("Deleted a highlight");
  await window.keyboard.press("ControlOrMeta+z");
  await expect(panel.getByTestId("annotation-row")).toHaveCount(1);
});

test("by the keyboard: ⌘K highlights the selection and finds a highlight's words and a note's words", async () => {
  const { window, viewer } = await openMarkdown();
  const words = "18 months from notice";

  // The selection, then ⌘K's own command: no mouse touches the menu.
  await slideSelect(window, paragraph(viewer, words), words);
  await window.keyboard.press("Escape");
  await slideSelect(window, paragraph(viewer, words), words);
  await runFromPalette(window, "Highlight the selected text");
  await expect(viewer.locator("[data-annotation-id]").first()).toContainText(words);

  // A note, with the keyboard: its mark is focused and Enter opens it.
  await pointAndClick(window, noteMark(viewer));
  const popover = window.getByTestId("annotation-note");
  await pointAndClick(window, popover.getByTestId("annotation-note-start"));
  await window.keyboard.type("Check the notice period with the client.");
  await window.keyboard.press("ControlOrMeta+Enter");
  await window.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  // ⌘K finds the note's words, and the highlight's.
  await window.keyboard.press("ControlOrMeta+k");
  await window.getByTestId("palette-search").fill("notice period");
  const found = window.locator('[data-testid="palette-item"][data-kind="annotation"]');
  await expect(found.first()).toBeVisible();
  await expect(found.first()).toContainText("Costs");
  await window.keyboard.press("Escape");

  await window.keyboard.press("ControlOrMeta+k");
  await window.getByTestId("palette-search").fill("18 months");
  await expect(
    window.locator('[data-testid="palette-item"][data-kind="annotation"]').first(),
  ).toBeVisible();
  await window.keyboard.press("Escape");
});

test("in Chinese: the menu, the panel and search are in Chinese", async () => {
  const { window, viewer } = await openMarkdown("zh-CN", CHINESE, "预算.md");
  await slideSelect(window, paragraph(viewer, "应急费按 4% 预留"), "应急费按 4% 预留");
  await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
  await expect(window.getByTestId("viewer-selection-highlight")).toContainText("高亮");
  await pointAndClick(window, window.getByTestId("viewer-selection-highlight"));
  await expect(viewer.locator("[data-annotation-id]").first()).toContainText("应急费");

  const panel = await openPanel(window, viewer);
  await expect(panel).toContainText("高亮与笔记");
  const row = panel.getByTestId("annotation-row").first();
  await expect(row).toContainText("应急费");

  await pointAndClick(window, noteMark(viewer));
  const popover = window.getByTestId("annotation-note");
  await pointAndClick(window, popover.getByTestId("annotation-note-start"));
  await window.keyboard.type("问一下屋顶是否包含在内。");
  await pointAndClick(window, popover.getByTestId("annotation-note-save"));
  await window.keyboard.press("Escape");

  await window.keyboard.press("ControlOrMeta+k");
  await window.getByTestId("palette-search").fill("屋顶");
  await expect(
    window.locator('[data-testid="palette-item"][data-kind="annotation"]').first(),
  ).toBeVisible();
});

test("Add to note and Collect into a Mind give quotes whose Citations are found", async () => {
  const { window, viewer } = await openMarkdown();
  await newMind(window);
  await pointAndClick(window, window.getByTestId("viewer"));
  await highlight(window, viewer, "4% is held");

  // Add to note, from the note's popover, at the Mind's cursor.
  await pointAndClick(window, noteMark(viewer));
  const popover = window.getByTestId("annotation-note");
  await pointAndClick(window, popover.getByTestId("annotation-add-to-note"));
  const quote = frontMind(window).locator("blockquote").first();
  await expect(quote).toContainText("4% is held");
  await expect(quote.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");

  // Collect into a Mind, from the highlight's own menu.
  const panel = await openPanel(window, viewer);
  const row = panel.getByTestId("annotation-row").first();
  await row.click({ button: "right" });
  await pointAndClick(window, row.locator('[data-testid="annotation.collect"]').first());
  await expect
    .poll(
      async () =>
        (await (await coreOf(window)).evaluate(async (core) => (await core.listMinds()).length)) ??
        0,
    )
    .toBeGreaterThan(1);
  await expect(frontMind(window).locator("h2").filter({ hasText: "Costs" })).toBeVisible();
  const collected = frontMind(window).locator("blockquote").first();
  await expect(collected).toContainText("4% is held");
  await expect(collected.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
});

test("a PDF's own highlights and notes are shown, marked From the file, and a new version re-anchors or says the text is gone", async () => {
  const path = join(sources, "Rate cuts.pdf");
  const pdf = (text: string) =>
    buildPdf([
      {
        lines: [text],
        marks: [
          {
            subtype: "Highlight",
            rect: [72, 748, 300, 764],
            quadPoints: [72, 764, 300, 764, 72, 748, 300, 748],
            contents: "Compare with Table 3.",
            title: "Priya Raman",
            color: [1, 0.9, 0.2],
          },
        ],
      },
    ]);
  await writeFile(path, pdf("Grocers studied across the eleven chains."));
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await addDocuments(window, [path]);
  await expectReadyDocuments(window, 1);
  const documentId = await documentIdOf(window);
  await openDocumentAt(window, { documentId });
  const viewer = window.getByTestId("viewer");
  const panel = await openPanel(window, viewer);

  const row = panel.getByTestId("annotation-row").first();
  await expect(row).toContainText("Grocers studied across the eleven chains.");
  await expect(row.getByTestId("annotation-from-file")).toContainText("From the file");
  await expect(row).toContainText("Compare with Table 3.");
  await expect(viewer.locator("[data-annotation-id]").first()).toContainText("Grocers");

  // A new version that still has the words: kept, re-anchored.
  await writeVersion(
    window,
    path,
    pdf("Grocers studied across the eleven chains. Margins held steady."),
  );
  await expect(
    window.getByTestId("annotations-panel").getByTestId("annotation-row").first(),
  ).toContainText("Grocers");

  // A version whose words the User's own highlight had: it stays, saying they are gone.
  const fresh = window.getByTestId("viewer");
  const layer = fresh.locator('[data-page-number="1"] .textLayer');
  await expect(layer).toContainText("Margins held steady");
  await slideSelect(window, layer, "Margins held steady");
  await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
  await pointAndClick(window, window.getByTestId("viewer-selection-highlight"));
  await writeVersion(window, path, pdf("Only these words are left on the page."));
  await expect
    .poll(async () =>
      (
        await (await coreOf(window)).evaluate(async (core) => core.listAnnotations(documentId))
      ).some((annotation) => annotation.missing),
    )
    .toBe(true);
  await openPanel(window, window.getByTestId("viewer"));
  await expect(
    window.getByTestId("annotations-panel").getByTestId("annotation-missing").first(),
  ).toContainText("Text not found in this version");
});
