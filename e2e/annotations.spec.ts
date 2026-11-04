import { realpath, utimes, writeFile } from "node:fs/promises";
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
  runCommand,
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
  // The core records a file's real path: macOS's temporary folder is a symbolic link.
  sources = await realpath(await createDataFolder());
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
async function openMarkdown(
  language: "en" | "zh-CN" = "en",
  text = MARKDOWN,
  name = "Costs.md",
  { mind = false }: { mind?: boolean } = {},
) {
  const path = join(sources, name);
  await writeFile(path, text);
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  if (language !== "en") await setLanguage(window, language);
  await addDocuments(window, [path]);
  await expectReadyDocuments(window, 1);
  // With a Mind first, the Document opens beside it, which Add to note writes into.
  if (mind) await newMind(window);
  await openDocumentAt(window, { documentId: await documentIdOf(window) });
  const viewer = window.getByTestId("viewer");
  await expect(viewer.getByTestId("viewer-text")).toBeVisible();
  return { app, window, viewer };
}

const paragraph = (viewer: Locator, words: string) =>
  viewer.locator("p").filter({ hasText: words }).first();

const noteMark = (viewer: Locator) => viewer.locator("[data-annotation-note]").first();

async function openPanel(window: Page, viewer: Locator): Promise<Locator> {
  const panel = window.getByTestId("annotations-panel");
  // It stays open across a viewer's reload, as a new version makes.
  if (await panel.isVisible()) return panel;
  // Its button in the toolbar, or the Document's menu where a narrow toolbar folds it away.
  const toggle = viewer.getByTestId("viewer-annotations-toggle");
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await pointAndClick(window, toggle);
  } else {
    // Where a narrow toolbar folds the button away, the Document's menu has it: opened by the
    // keyboard, which the window takes before its first pointer press does.
    const more = viewer.getByTestId("document-file-menu").first();
    await more.focus();
    await window.keyboard.press("Enter");
    const item = window.getByTestId("document.showAnnotations").first();
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();
  }
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

  // Its menu, in the shared order, in the words the interface uses: a note, not a Mind.
  await row.click({ button: "right" });
  await expect(window.getByTestId("annotation.collect")).toContainText("Collect into a note");
  await window.keyboard.press("Escape");

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

  // The keyboard's own way: its row focused, the command from ⌘K, and ⌘Z puts it back.
  await row.getByTestId("annotation-quote").focus();
  await runCommand(window, "annotation.delete", "Delete highlight");
  await expect(panel.getByTestId("annotation-row")).toHaveCount(0);
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
  await runCommand(window, "viewer.selection.highlight", "Highlight the selected text");
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
  await row.click({ button: "right" });
  await expect(window.getByTestId("annotation.collect")).toContainText("收进一条笔记");
  await window.keyboard.press("Escape");

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
  const { window, viewer } = await openMarkdown("en", MARKDOWN, "Costs.md", { mind: true });
  await highlight(window, viewer, "4% is held");

  // Add to note, from the note's popover, at the Mind's cursor.
  await pointAndClick(window, noteMark(viewer));
  const popover = window.getByTestId("annotation-note");
  await pointAndClick(window, popover.getByTestId("annotation-add-to-note"));
  const quote = frontMind(window).locator("blockquote").first();
  await expect(quote).toContainText("4% is held");
  await expect(quote.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");

  // Collect into a Mind, from the highlight's own menu: a new Mind, a section for the Document,
  // and its quote there with a Citation that is found.
  const before = await (await coreOf(window)).evaluate(async (core) =>
    (await core.listMinds()).map((mind) => mind.id),
  );
  const panel = await openPanel(window, viewer);
  const row = panel.getByTestId("annotation-row").first();
  await row.click({ button: "right" });
  await pointAndClick(window, row.locator('[data-testid="annotation.collect"]').first());
  let collectedMindId = "";
  await expect
    .poll(async () => {
      const ids = await (await coreOf(window)).evaluate(async (core) =>
        (await core.listMinds()).map((mind) => mind.id),
      );
      collectedMindId = ids.find((id) => !before.includes(id)) ?? "";
      return collectedMindId;
    })
    .not.toBe("");
  const collectedMind = window.locator(
    `[data-testid="mind-pane"][data-mind-id="${collectedMindId}"]`,
  );
  await expect(collectedMind.locator("h2").filter({ hasText: "Costs" })).toBeVisible();
  const collected = collectedMind.locator("blockquote").first();
  await expect(collected).toContainText("4% is held");
  await expect(collected.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
});

test("a PDF highlight selected across a page break is drawn on both pages", async () => {
  const path = join(sources, "Break.pdf");
  await writeFile(
    path,
    buildPdf([
      { lines: ["The recovery peaks in the second quarter"] },
      { lines: ["of the year, as Table 3 shows."] },
    ]),
  );
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await addDocuments(window, [path]);
  await expectReadyDocuments(window, 1);
  await openDocumentAt(window, { documentId: await documentIdOf(window) });
  const viewer = window.getByTestId("viewer");
  const page1 = viewer.locator('[data-page-number="1"] .textLayer');
  const page2 = viewer.locator('[data-page-number="2"] .textLayer');
  await viewer.getByTestId("pdf-scroller").evaluate((scroller) => {
    const first = scroller.querySelector('[data-page-number="1"]');
    if (!first) return;
    const bottom =
      first.getBoundingClientRect().bottom -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    scroller.scrollTop = bottom - scroller.clientHeight / 2;
  });
  await expect(page1).toContainText("The recovery peaks");
  await expect(page2).toContainText("of the year");

  await slideSelect(window, page1, "in the second quarter", {
    line: page2,
    words: "of the year",
  });
  await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
  await pointAndClick(window, window.getByTestId("viewer-selection-highlight-yellow"));

  // The one highlight's words are on both pages, so both carry its mark.
  const marks = viewer.locator("[data-annotation-id]");
  await expect(marks).toHaveCount(2);
  await expect(marks.nth(0)).toContainText("in the second quarter");
  await expect(marks.nth(1)).toContainText("of the year");

  // Its row goes to it, rather than saying its words are not in this version.
  const panel = await openPanel(window, viewer);
  await pointAndClick(window, panel.getByTestId("annotation-quote").first());
  await expect(panel).not.toContainText("Text not found in this version");
});

test("a PDF's area is highlighted from ⌘K, drawn as a region, listed with its words, and Undo takes it back", async () => {
  const path = join(sources, "Region.pdf");
  await writeFile(
    path,
    buildPdf([
      {
        lines: ["The recovery peaks in the second quarter", "of the year, as Table 3 shows."],
      },
    ]),
  );
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await addDocuments(window, [path]);
  await expectReadyDocuments(window, 1);
  await openDocumentAt(window, { documentId: await documentIdOf(window) });
  const viewer = window.getByTestId("viewer");
  const page = viewer.locator('[data-page-number="1"]');
  await expect(page).toHaveAttribute("data-drawn", "true");

  // ⌘K starts the pick whose release makes a highlight, not a Question.
  await runCommand(window, "viewer.area.highlight", "Highlight an area");
  await expect(viewer.getByTestId("viewer-area-select")).toHaveAttribute("aria-pressed", "true");
  const line = page.locator(".textLayer span").filter({ hasText: "The recovery peaks" }).first();
  const box = await line.boundingBox();
  if (!box) throw new Error("The page's line isn't in view.");
  await window.mouse.move(box.x + 1, box.y + 1, { steps: 4 });
  await window.mouse.down();
  await window.mouse.move(box.x + box.width - 1, box.y + box.height - 1, { steps: 10 });
  await window.mouse.up();

  // The region is washed in the colour, the pick is done, and its row quotes the words in it.
  const wash = viewer.getByTestId("annotation-area");
  await expect(wash).toHaveCount(1);
  await expect(viewer.getByTestId("viewer-area-select")).toHaveAttribute("aria-pressed", "false");
  const panel = await openPanel(window, viewer);
  const row = panel.getByTestId("annotation-row").first();
  await expect(row).toContainText("The recovery peaks");
  await expect(row).toContainText("p. 1");

  // Undo takes the highlight back.
  await window.keyboard.press("ControlOrMeta+z");
  await expect(wash).toHaveCount(0);
  await expect(panel.getByTestId("annotation-row")).toHaveCount(0);
  await app.close();
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
          {
            subtype: "Text",
            rect: [320, 700, 340, 720],
            contents: "Check this figure.",
            title: "Priya Raman",
            color: [1, 1, 0],
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
  // The header the menu belongs to is replaced once the file is read: open it on the settled one.
  await expect(viewer.locator('[data-page-number="1"]')).toHaveAttribute("data-drawn", "true");
  const panel = await openPanel(window, viewer);

  const row = panel.getByTestId("annotation-row").filter({ hasText: "Grocers" }).first();
  await expect(row).toContainText("Grocers studied across the eleven chains.");
  await expect(row.getByTestId("annotation-from-file")).toContainText("From the file");
  await expect(row).toContainText("Compare with Table 3.");
  await expect(viewer.locator("[data-annotation-id]").first()).toContainText("Grocers");

  // The file's sticky note has no words to draw: its row opens its note, and says nothing of
  // words that a version lost.
  const sticky = panel
    .getByTestId("annotation-row")
    .filter({ hasText: "Check this figure." })
    .first();
  await pointAndClick(window, sticky.getByTestId("annotation-row-edit"));
  await expect(panel.getByTestId("annotation-row-field")).toHaveValue("Check this figure.");
  await expect(panel).not.toContainText("This version doesn’t have the words");

  // A new version that still has the words: kept, re-anchored.
  await writeVersion(
    window,
    path,
    pdf("Grocers studied across the eleven chains. Margins held steady."),
  );
  await expect(
    window
      .getByTestId("annotations-panel")
      .getByTestId("annotation-row")
      .filter({ hasText: "Grocers" })
      .first(),
  ).toContainText("Grocers");

  // A version whose words the User's own highlight had: it stays, saying they are gone.
  const fresh = window.getByTestId("viewer");
  const layer = fresh.locator('[data-page-number="1"] .textLayer');
  await expect(layer).toContainText("Margins held steady");
  await slideSelect(window, layer, "Margins held steady");
  await expect(window.getByTestId("viewer-selection-menu")).toBeVisible();
  await pointAndClick(window, window.getByTestId("viewer-selection-highlight-yellow"));
  await writeVersion(window, path, pdf("Only these words are left on the page."));
  await expect
    .poll(async () =>
      (await coreOf(window)).evaluate(
        async (core, id) =>
          (await core.listAnnotations(id)).some((annotation) => annotation.missing),
        documentId,
      ),
    )
    .toBe(true);
  await openPanel(window, window.getByTestId("viewer"));
  await expect(
    window.getByTestId("annotations-panel").getByTestId("annotation-missing").first(),
  ).toContainText("Text not found in this version");
});
