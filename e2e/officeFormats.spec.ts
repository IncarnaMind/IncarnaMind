/**
 * Word, PowerPoint, Excel and CSV Documents (ADR-0011), end to end: linked,
 * processed, cited by slide, rows and section, opened at each Citation with
 * the quote highlighted and its mark beside it, and exported with each
 * Citation's Location in its footnote; and a file too large to open, refused.
 *
 * The files are tests/fixtures/formats/ (see tests/core/formats.test.ts). Set
 * INCARNAMIND_SCREENSHOTS to a folder to keep a screenshot of each preview.
 */
import { copyFile, mkdir, readFile, realpath, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import type { TestHooks } from "../src/shared/testHooks";
import { footnotesOf, part, unzip } from "../tests/helpers/docx";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  exportFromMenu,
  launchApp,
  linkFolderFromSidebar,
  nameMind,
  newMind,
  openDocumentAt,
  removeDataFolder,
  savedLine,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

const FIXTURES = join(__dirname, "..", "tests", "fixtures", "formats");
const FILES = [
  "Coastal Flood Risk Review.docx",
  "Quarterly Research Update.pptx",
  "Regional Revenue.xlsx",
  "Orders.csv",
];

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

/** Keeps a screenshot of the window, once the viewer has settled, when INCARNAMIND_SCREENSHOTS names a folder. */
async function screenshot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await window.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  await mkdir(folder, { recursive: true });
  await window.screenshot({ path: join(folder, `${name}.png`) });
}

/**
 * A window wide enough that a Document's group beside the Mind is over 860px,
 * with the assistant docked beside them (#253): room for each page's margin,
 * where the mark and its label go.
 */
async function widen(app: ElectronApplication, window: Page) {
  await setWindowSize(app, window, 2400, 1000);
}

/** An element's box; it must be shown. */
async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
}

/** Expects the Citation's mark beside the highlight: right of it, centred on its first line. */
async function expectMarkBeside(mark: Locator, highlight: Locator) {
  const markBox = await boxOf(mark);
  const line = await highlight.evaluate((element) => {
    const rect = element.getClientRects()[0] ?? element.getBoundingClientRect();
    return { right: rect.right, middle: rect.top + rect.height / 2 };
  });
  expect(markBox.height).toBe(18);
  expect(markBox.x).toBeGreaterThan(line.right);
  expect(Math.abs(markBox.y + markBox.height / 2 - line.middle)).toBeLessThanOrEqual(1.5);
}

/**
 * Asks a Question beside a new Mind, waits for its Answer to finish in the
 * assistant, and adds it to the Mind, whose note then holds its Citations.
 */
async function ask(window: Page, text: string) {
  await newMind(window);
  await nameMind(window, "Formats");
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await addToNote(window, await askInAssistant(window, text));
  return editor;
}

test("Word, PowerPoint, Excel and CSV files in a linked folder are cited by section, slide and rows, opened at each Citation, and exported with their Locations", async () => {
  const library = join(await realpath(sources), "Library");
  await mkdir(library, { recursive: true });
  for (const file of FILES) await copyFile(join(FIXTURES, file), join(library, file));

  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await widen(app, window);
  await linkFolderFromSidebar(app, window, library);

  // Each file becomes a Document, and is processed.
  const items = window.getByTestId("document-list-item");
  await expect(items).toHaveCount(FILES.length);
  for (let index = 0; index < FILES.length; index++) {
    await expect(items.nth(index)).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  }

  const mind = await ask(
    window,
    "Compare each: the western fastest growth, the barrier crest halves damage, and West totals in rows.",
  );
  const chips = mind.getByTestId("citation-chip");
  await expect(chips).toHaveCount(4);
  const labels = await chips.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label") ?? ""),
  );
  const labelOf = (document: string) => labels.find((label) => label.includes(document)) ?? "";
  expect(labelOf("Quarterly Research Update")).toMatch(
    /^Citation \d: Quarterly Research Update, slide 3\. Quote found on slide 3$/,
  );
  expect(labelOf("Regional Revenue")).toMatch(
    /^Citation \d: Regional Revenue, Revenue, rows 7–8\. Quote found in Revenue, rows 7–8$/,
  );
  expect(labelOf("Coastal Flood Risk Review")).toMatch(
    /^Citation \d: Coastal Flood Risk Review, § 2\.1 Sensitivity\. Quote found in § 2\.1 Sensitivity$/,
  );
  expect(labelOf("Orders")).toMatch(/^Citation \d: Orders, rows 4–5\. Quote found in rows 4–5$/);

  const viewer = window.getByTestId("viewer");
  const mark = viewer.getByTestId("viewer-quote-mark");
  const open = async (document: string) => {
    await window.keyboard.press("Escape");
    const index = labels.findIndex((label) => label.includes(document));
    await chips.nth(index).click();
    await expect(window.getByTestId("viewer-title")).toHaveText(document);
  };

  // The slide: drawn as PowerPoint lays it out, at slide 3, the quote washed on it and the mark beside it.
  await open("Quarterly Research Update");
  await expect(viewer.getByTestId("viewer-slides")).toHaveAttribute("data-drawn", "yes");
  const slide = viewer.locator('[data-slide="3"]');
  const slideQuote = slide.locator("[data-quote-highlight]");
  await expect(slideQuote).toHaveText([
    "The western region grew fastest, at 18 per cent year on year.",
  ]);
  await expect(slideQuote.first()).toBeInViewport();
  // At the deck's own 16:9, as wide as the column allows.
  const drawnSlide = await boxOf(slide.locator(".viewer-deck-sheet"));
  expect(drawnSlide.width / drawnSlide.height).toBeCloseTo(16 / 9, 1);
  // Its speaker notes are there, folded, as the quote is on the slide.
  const notes = slide.getByTestId("viewer-slide-notes");
  await expect(notes).toContainText("Point at the red bar: that is the west.");
  await expect(notes).not.toHaveAttribute("open");
  await expect(slide.locator("img")).toHaveCount(1);
  await expect(mark.getByTestId("viewer-quote-mark-label")).toHaveText("slide 3");
  await expect(mark).toHaveAttribute("data-label-shown", "true");
  await expectMarkBeside(mark, slideQuote.first());
  await screenshot(window, "pptx-slides");

  // The rows: the Revenue sheet's grid, rows 7 and 8 washed, the mark beside them.
  await open("Regional Revenue");
  const sheet = viewer.getByTestId("viewer-sheet");
  await expect(sheet.getByRole("tab", { name: "Revenue" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const cells = sheet.locator("td[data-quote-highlight]");
  await expect(cells).toHaveCount(12);
  expect(await cells.evaluateAll((elements) => elements.map((each) => each.dataset.ref))).toEqual([
    "A7",
    "B7",
    "C7",
    "D7",
    "E7",
    "F7",
    "A8",
    "B8",
    "C8",
    "D8",
    "E8",
    "F8",
  ]);
  await expect(cells.first()).toHaveText("West");
  await expect(cells.nth(1)).toHaveText("£350,200");
  await expect(cells.first()).toBeInViewport();
  await expect(mark.getByTestId("viewer-quote-mark-label")).toHaveText("Revenue, rows 7–8");
  await expect(mark).toHaveAttribute("data-label-shown", "true");
  await expectMarkBeside(mark, cells.nth(5));
  await screenshot(window, "xlsx-grid");
  // Its other sheets: the notes, and an empty one.
  await sheet.getByRole("tab", { name: "Notes" }).click();
  await expect(sheet.locator('td[data-ref="C3"]')).toHaveText(
    "Northern figures exclude the Leeds office, which reported late.",
  );
  await sheet.getByRole("tab", { name: "Empty" }).click();
  await expect(sheet.getByTestId("viewer-sheet-empty")).toBeVisible();

  // The section: the Word file's pages, the quote washed under 2.1 Sensitivity.
  await open("Coastal Flood Risk Review");
  const docx = viewer.getByTestId("viewer-docx");
  await expect(docx).toHaveAttribute("data-rendered", "yes");
  const wordQuote = docx.locator("[data-quote-highlight]");
  await expect(wordQuote.first()).toBeVisible();
  const washed = (await wordQuote.allTextContents()).join("");
  expect(washed).toContain("Raising the barrier crest by 40 centimetres halves");
  // It is under the cited heading: the heading comes before it in the drawn pages.
  const follows = await docx.evaluate((element) => {
    const heading = [...element.querySelectorAll("p")].find(
      (paragraph) => paragraph.textContent === "2.1 Sensitivity",
    );
    const quote = element.querySelector("[data-quote-highlight]");
    return heading && quote
      ? (heading.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      : false;
  });
  expect(follows).toBe(true);
  await expect(wordQuote.first()).toBeInViewport();
  await expect(mark.getByTestId("viewer-quote-mark-label")).toHaveText("§ 2.1 Sensitivity");
  await expectMarkBeside(mark, wordQuote.first());
  await screenshot(window, "docx-pages");
  // Its outline lists its sections, and goes to one.
  await viewer.getByTestId("viewer-outline-button").click();
  const outline = viewer.getByTestId("viewer-outline-item");
  await expect(outline).toHaveText([
    "1 Introduction",
    "1.1 Scope",
    "2 Results",
    "2.1 Sensitivity",
    "3 Discussion",
    "3.1 Limitations",
  ]);
  await screenshot(window, "docx-outline");

  // The CSV: one sheet, rows 4 and 5 washed.
  await open("Orders");
  const orders = viewer.getByTestId("viewer-sheet").locator("td[data-quote-highlight]");
  await expect(orders).toHaveCount(10);
  await expect(orders.first()).toHaveText("1003");
  await expect(mark.getByTestId("viewer-quote-mark-label")).toHaveText("rows 4–5");
  await screenshot(window, "csv-grid");

  // Exported to .docx, each Citation's footnote names its Location.
  const target = join(sources, "Formats.docx");
  await useOutputLocation(window, sources);
  await window.keyboard.press("Escape");
  await exportFromMenu(window);
  const result = window.getByTestId("export-result");
  await expect(result.getByTestId("export-done")).toHaveText(savedLine("Formats.docx", sources));
  // Every quote was found: no line about one that wasn't.
  await expect(result.getByTestId("export-unverified")).toHaveCount(0);
  const footnotes = Object.values(
    footnotesOf(part(unzip(await readFile(target)), "word/footnotes.xml")),
  ).sort();
  expect(footnotes).toEqual([
    "Coastal Flood Risk Review, § 2.1 Sensitivity",
    "Orders, rows 4–5",
    "Quarterly Research Update, slide 3",
    "Regional Revenue, Revenue, rows 7–8",
  ]);
  await app.close();
});

test("a Markdown file opens at its cited section and a text file at its cited lines, with the quote washed there", async () => {
  const notes = join(sources, "Field notes.md");
  const log = join(sources, "Harbour log.txt");
  await writeFile(
    notes,
    [
      "# Field notes",
      "",
      "Arrived at the harbour before dawn.",
      "",
      "## Methods",
      "",
      "Each gauge was read at high water.",
      "",
      "## Results",
      "",
      "Each gauge was read at high water, and again at low water.",
      "",
    ].join("\n"),
  );
  await writeFile(
    log,
    Array.from(
      { length: 140 },
      (_, index) => `${index + 1}: the tide turned at ${index % 12} o'clock.`,
    ).join("\n"),
  );
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await widen(app, window);
  await window.getByTestId("add-documents-input").setInputFiles([notes, log]);
  const items = window.getByTestId("document-list-item");
  await expect(items).toHaveCount(2);
  for (let index = 0; index < 2; index++) {
    await expect(items.nth(index)).toHaveAttribute("data-status", "ready");
  }
  const viewer = window.getByTestId("viewer");
  const text = viewer.getByTestId("viewer-text");

  // Section 3 is "Results": the quote is washed there, not under "Methods", where it also starts.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Field notes"),
    pageFrom: 3,
    quote: "Each gauge was read at high water",
    citation: { check: "found", number: 2, label: "§ Results" },
  });
  const washed = text.locator("[data-quote-highlight]");
  await expect(washed).toHaveCount(1);
  expect(await washed.evaluate((element) => element.closest("p")?.textContent ?? "")).toContain(
    "and again at low water",
  );
  await expect(viewer.getByTestId("viewer-quote-mark-label")).toHaveText("§ Results");
  await expect(viewer.getByTestId("viewer-quote-mark")).toHaveAttribute("data-label-shown", "true");
  await screenshot(window, "markdown-section");

  // Lines 101–140 are the third block of lines: the quote, on lines 5, 17… 137, is washed
  // where it first is in that block, on line 101, and scrolled into view.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Harbour log"),
    pageFrom: 3,
    quote: "the tide turned at 4 o'clock.",
    citation: { check: "found", number: 1, label: "line 101" },
  });
  const line = text.locator("[data-quote-highlight]");
  await expect(line).toHaveCount(1);
  expect(
    await line.evaluate((element) => element.previousSibling?.textContent?.split("\n").at(-1)),
  ).toBe("101: ");
  await expect(line).toBeInViewport();
  await screenshot(window, "txt-lines");
  await app.close();
});

test("a deck opens at a quote in a slide's speaker notes, which open, and marks a slide whose quote isn't on it", async () => {
  const deck = join(sources, "Quarterly Research Update.pptx");
  await copyFile(join(FIXTURES, "Quarterly Research Update.pptx"), deck);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await widen(app, window);
  await window.getByTestId("add-documents-input").setInputFiles([deck]);
  await expect(window.getByTestId("document-list-item")).toHaveAttribute("data-status", "ready");
  const documentId = await documentIdOf(window, "Quarterly Research Update");
  const viewer = window.getByTestId("viewer");
  const mark = viewer.getByTestId("viewer-quote-mark");

  // In the notes: they open under the slide, the quote washed there, the mark beside it.
  await openDocumentAt(window, {
    documentId,
    pageFrom: 3,
    quote: "Point at the red bar: that is the west.",
    citation: { check: "found", number: 2, label: "slide 3" },
  });
  const notes = viewer.locator('[data-slide="3"]').getByTestId("viewer-slide-notes");
  await expect(notes).toHaveAttribute("open", "");
  const washed = notes.locator("[data-quote-highlight]");
  await expect(washed).toHaveText("Point at the red bar: that is the west.");
  await expect(washed).toBeInViewport();
  await expectMarkBeside(mark, washed);
  await screenshot(window, "pptx-notes");
  // The notes fold again by hand.
  await notes.locator("summary").click();
  await expect(notes).not.toHaveAttribute("open");

  // Not on the slide or anywhere in the deck: the cited slide is shown, its mark at its top.
  await openDocumentAt(window, {
    documentId,
    pageFrom: 4,
    quote: "Revenue doubled in the north.",
    citation: { check: "not-found", number: 3, label: "slide 4" },
  });
  const cited = viewer.locator('[data-slide="4"]');
  await expect(cited).toHaveAttribute("data-quote-found", "none");
  await expect(viewer.locator("[data-quote-highlight]")).toHaveCount(0);
  await expect(mark).toHaveAttribute("data-check", "not-found");
  const markBox = await boxOf(mark);
  const sheetBox = await boxOf(cited.locator(".viewer-deck-sheet"));
  expect(markBox.x).toBeGreaterThan(sheetBox.x + sheetBox.width);
  expect(Math.abs(markBox.y - sheetBox.y - 8)).toBeLessThanOrEqual(1);
  await expect(cited.locator(".viewer-deck-sheet")).toBeInViewport();
  await screenshot(window, "pptx-slide-mark");
  await app.close();
});

test("a Question about a Word comment cites the comment by its author, found, and the viewer washes it in its note beside the page (#76)", async () => {
  const report = join(sources, "Field Report.docx");
  await copyFile(join(FIXTURES, "Field Report.docx"), report);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await widen(app, window);
  await addDocuments(window, [report]);

  // Only the comment says this: the scripted model searches, and quotes the line that answers.
  const mind = await ask(
    window,
    "What should be confirmed with the hydrology team before release?",
  );
  const chip = mind.getByTestId("citation-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute(
    "aria-label",
    "Citation 1: Field Report, § Start, comment by J. Moreau. Quote found in § Start, comment by J. Moreau",
  );

  // Opened at the Citation: the quote is washed in the comment's note, not in the page.
  await chip.click();
  await expect(window.getByTestId("viewer-title")).toHaveText("Field Report");
  const viewer = window.getByTestId("viewer");
  const docx = viewer.getByTestId("viewer-docx");
  await expect(docx).toHaveAttribute("data-rendered", "yes");
  const note = docx.getByTestId("viewer-docx-comment");
  await expect(note).toHaveAttribute("aria-label", "Comment by J. Moreau");
  const washed = note.locator("[data-quote-highlight]");
  await expect(washed).toHaveText("Confirm with the hydrology team before release.");
  await expect(washed).toBeInViewport();
  await expect(docx.locator("section.docx [data-quote-highlight]")).toHaveCount(0);

  // Its mark: in the margin between the page's text and the note, level with the quote.
  const mark = viewer.getByTestId("viewer-quote-mark");
  await expect(mark).toHaveAttribute("data-check", "found");
  await expect(mark).toHaveAttribute(
    "aria-label",
    "Citation 1: quote found, § Start, comment by J. Moreau",
  );
  const markBox = await boxOf(mark);
  const noteBox = await boxOf(note);
  const text = await boxOf(docx.locator("section.docx > article").first());
  expect(markBox.x).toBeGreaterThan(text.x + text.width);
  expect(markBox.x + markBox.width).toBeLessThanOrEqual(noteBox.x);
  const line = await washed.evaluate((element) => {
    const rect = element.getClientRects()[0] ?? element.getBoundingClientRect();
    return rect.top + rect.height / 2;
  });
  expect(Math.abs(markBox.y + markBox.height / 2 - line)).toBeLessThanOrEqual(1.5);
  await screenshot(window, "docx-comment-cited");
  await app.close();
});

test("the viewer washes a Markdown table's row quoted without its pipes, and a slide's row quoted with pipes, its figure written another way (#76)", async () => {
  const notes = join(sources, "Survey.md");
  await writeFile(
    notes,
    ["# Survey", "", "| Site | Gauges |", "|:-----|-------:|", "| Mid estuary | 4 |", ""].join(
      "\n",
    ),
  );
  const deck = join(sources, "Quarterly Research Update.pptx");
  await copyFile(join(FIXTURES, "Quarterly Research Update.pptx"), deck);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await widen(app, window);
  await addDocuments(window, [notes, deck]);
  const viewer = window.getByTestId("viewer");
  const mark = viewer.getByTestId("viewer-quote-mark");

  // The Markdown row: its cells washed, though the quote has no pipes.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Survey"),
    pageFrom: 1,
    quote: "Mid estuary 4",
    citation: { check: "found", number: 1, label: "§ Survey" },
  });
  const text = viewer.getByTestId("viewer-text");
  await expect(text).toHaveAttribute("data-view", "formatted");
  await expect(text.locator("td [data-quote-highlight]")).toHaveText(["Mid estuary", "4"]);
  await expect(mark.getByTestId("viewer-quote-mark-label")).toHaveText("§ Survey");
  await screenshot(window, "markdown-row-without-pipes");

  // The slide's table row, quoted with pipes and "1260" for the cell's "1,260".
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Quarterly Research Update"),
    pageFrom: 4,
    quote: "Qualified | 42 | 1260",
    citation: { check: "found", number: 2, label: "slide 4" },
  });
  await expect(viewer.getByTestId("viewer-slides")).toHaveAttribute("data-drawn", "yes");
  const slide = viewer.locator('[data-slide="4"]');
  await expect(slide).toHaveAttribute("data-quote-found", "slide");
  const cells = slide.locator("[data-quote-highlight]");
  await expect(cells).toHaveText(["Qualified", "42", "1,260"]);
  await expect(cells.first()).toBeInViewport();
  await expectMarkBeside(mark, cells.first());
  await screenshot(window, "pptx-row-with-pipes");
  await app.close();
});

/** A one-pixel PNG: a picture beside a Markdown file. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** A computed style of the first element a locator finds. */
const styleOf = (locator: Locator, property: string) =>
  locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

/*
 * "Field Station Budget.xlsx" and "Field Report.docx" were written once with
 * openpyxl 3.1.5 and python-docx 1.2.0, for their styles, frozen panes, a
 * note, a picture and a chart, and a comment, headers, footers and lists.
 */
test("previews look like the files: a workbook's own styles and panes, a Word file's comments beside its pages, and Markdown formatted with its pictures", async () => {
  for (const file of ["Field Station Budget.xlsx", "Field Report.docx"]) {
    await copyFile(join(FIXTURES, file), join(sources, file));
  }
  const notes = join(sources, "Survey.md");
  await writeFile(join(sources, "site map.png"), PIXEL);
  await writeFile(
    notes,
    [
      "# Survey",
      "",
      "![The site](site%20map.png) ![From the web](https://example.com/a.png)",
      "",
      "| Site | Gauges |",
      "|:-----|-------:|",
      "| Mid estuary | 4 |",
      "",
      "- [x] Calibrate",
      "",
    ].join("\n"),
  );
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await widen(app, window);
  await addDocuments(window, [
    join(sources, "Field Station Budget.xlsx"),
    join(sources, "Field Report.docx"),
    notes,
  ]);
  const viewer = window.getByTestId("viewer");

  // The workbook: its fills, fonts, formats, frozen panes, hidden column and row, note and drawings.
  await openDocumentAt(window, { documentId: await documentIdOf(window, "Field Station Budget") });
  const grid = viewer.getByTestId("viewer-grid");
  const title = grid.locator('td[data-ref="A1"]');
  await expect(title).toHaveText("Field Station Budget, 2026");
  await expect(title).toHaveAttribute("colspan", "6");
  expect(await styleOf(title, "background-color")).toBe("rgb(31, 56, 100)");
  expect(await styleOf(title, "color")).toBe("rgb(255, 255, 255)");
  expect(await styleOf(title, "font-weight")).toBe("700");
  await expect(grid).toHaveAttribute("data-frozen", "4,1");
  expect(await styleOf(grid.locator('td[data-ref="C4"]'), "position")).toBe("sticky");
  expect(await styleOf(grid.locator('td[data-ref="A6"]'), "position")).toBe("sticky");
  await expect(grid.locator("thead th", { hasText: /^G$/ })).toHaveCount(0);
  await expect(grid.locator('th[data-row-header="8"]')).toHaveCount(0);
  await expect(grid.locator('td[data-ref="A5"]')).toHaveText("15-Jan-26");
  await expect(grid.locator('td[data-ref="C5"]')).toHaveText("$18,450.50");
  await expect(grid.locator('td[data-ref="D5"]')).toHaveText("31.2%");
  const variance = grid.locator('td[data-ref="F6"]');
  await expect(variance).toHaveText("-830");
  expect(await styleOf(variance, "color")).toBe("rgb(255, 0, 0)");
  await expect(grid.locator('td[data-ref="C5"]')).toHaveAttribute("title", /Hydro Instruments/);
  await expect(viewer.getByTestId("viewer-sheet-picture")).toHaveCount(1);
  const chart = viewer.getByTestId("viewer-sheet-placeholder");
  await expect(chart).toHaveAttribute("data-kind", "chart");
  await expect(chart).toContainText("Cost by item");
  await screenshot(window, "xlsx-styled");
  // The second sheet: no gridlines, rich text.
  await viewer.getByRole("tab", { name: "Notes" }).click();
  await expect(grid).toHaveAttribute("data-gridlines", "off");
  const run = grid.locator('td[data-ref="A1"] span', { hasText: /^over budget$/ });
  expect(await styleOf(run, "font-weight")).toBe("700");
  expect(await styleOf(run, "color")).toBe("rgb(192, 0, 0)");

  // The Word file: its header, footer, list bullets and its comment as a note beside the page.
  await openDocumentAt(window, { documentId: await documentIdOf(window, "Field Report") });
  const docx = viewer.getByTestId("viewer-docx");
  await expect(docx).toHaveAttribute("data-rendered", "yes");
  await expect(docx.locator("section.docx header").first()).toHaveText(
    "Field Report — Draft for the steering group",
  );
  await expect(docx.locator("section.docx footer").first()).toHaveText(
    "Coastal Monitoring Programme · Confidential",
  );
  const comment = docx.getByTestId("viewer-docx-comment");
  await expect(comment).toHaveCount(1);
  await expect(comment).toContainText("J. Moreau");
  await expect(comment).toContainText("Confirm with the hydrology team before release.");
  const page = await docx.locator("section.docx").first().boundingBox();
  const note = await comment.boundingBox();
  expect(note && page && note.x).toBeGreaterThan((page?.x ?? 0) + (page?.width ?? 0));
  // Word's Symbol-font bullets are drawn as bullets, not as missing glyphs.
  const styles = await docx.evaluate((element) =>
    [...element.querySelectorAll("style")].map((style) => style.textContent).join(""),
  );
  expect(styles).not.toContain("");
  expect(styles).toContain("•");
  await screenshot(window, "docx-comments");

  // The Markdown file: formatted, its picture beside it shown, one from the web not loaded.
  await openDocumentAt(window, {
    documentId: await documentIdOf(window, "Survey"),
    quote: "Mid estuary",
  });
  const text = viewer.getByTestId("viewer-text");
  await expect(text).toHaveAttribute("data-view", "formatted");
  const picture = text.getByTestId("viewer-markdown-image");
  await expect(picture).toHaveAttribute("alt", "The site");
  expect(await picture.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await expect(text.getByTestId("viewer-markdown-image-placeholder")).toHaveAttribute(
    "data-reason",
    "web",
  );
  await expect(text.locator("table th")).toHaveText(["Site", "Gauges"]);
  await expect(text.locator("td [data-quote-highlight]")).toHaveText("Mid estuary");
  await expect(text.locator('li input[type="checkbox"]')).toBeChecked();
  // "Source" shows the text as written, the quote still washed; again, formatted.
  const source = viewer.getByTestId("viewer-markdown-source");
  await source.click();
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await expect(text).toHaveAttribute("data-view", "source");
  await expect(text.locator("pre")).toContainText("![The site](site%20map.png)");
  await expect(text.locator("[data-quote-highlight]")).toHaveText("Mid estuary");
  await source.click();
  await expect(text).toHaveAttribute("data-view", "formatted");
  await screenshot(window, "markdown-formatted");
  await app.close();
});

test("a Word file over 500 MB fails as too large to open, in English and Chinese, and a Word file beside it opens as before", async () => {
  const home = await createDataFolder();
  const library = join(await realpath(sources), "Library");
  await mkdir(library, { recursive: true });
  // Sparse: 500 MB and a byte, with nothing written on disk.
  const huge = join(library, "Huge.docx");
  await writeFile(huge, "");
  await truncate(huge, 500 * 1024 * 1024 + 1);
  const normal = join(library, FILES[0] as string);
  await copyFile(join(FIXTURES, FILES[0] as string), normal);

  try {
    const { app, window } = await launchApp(dataDir, { home });
    await dismissChatSetup(window);
    // Dropped on the window (a test can't drop files), as Other Documents.
    await window.evaluate(
      async (paths) => {
        const hooks = (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks;
        if (!hooks) throw new Error("Test hooks are off: launch with INCARNAMIND_TEST_HOOKS=1.");
        await hooks.addPaths(paths);
      },
      [huge, normal],
    );

    const items = window.getByTestId("document-list-item");
    const refused = items.filter({ hasText: "Huge" });
    const review = items.filter({ hasText: "Coastal Flood Risk Review" });
    await expect(refused).toHaveAttribute("data-status", "failed", { timeout: 30_000 });
    await expect(review).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
    // "Failed" at the row's end; the reason for screen readers, and the limit in its tooltip.
    const status = refused.getByTestId("document-status");
    await expect(status.locator("[aria-hidden]").filter({ hasText: "Failed" })).toHaveText(
      "Failed",
    );
    await expect(status.locator(".bg-attention")).toBeVisible();
    await expect(status.locator(".sr-only")).toHaveText("Failed: the file is too large to open");
    await expect(status).toHaveAttribute(
      "title",
      "Failed: the file is too large to open\nToo large to open (limit 500 MB).",
    );
    await screenshot(window, "too-large");

    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: "zh-CN" },
      }),
    );
    await expect(status.locator(".sr-only")).toHaveText("失败：文件太大，无法打开");
    await expect(status).toHaveAttribute(
      "title",
      "失败：文件太大，无法打开\nToo large to open (limit 500 MB).",
    );
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: "en" },
      }),
    );

    // Opened, the viewer says why it can't show it.
    const viewer = window.getByTestId("viewer");
    // Opened, it says why in the same plain words as its row, with the way on (#763).
    await refused.getByTestId("open-document").click();
    const tooLarge = viewer.getByRole("alert");
    await expect(tooLarge).toContainText("This file is too large to open", { timeout: 30_000 });
    await expect(viewer.getByTestId("viewer-fix-open")).toHaveText("Open in default app");
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: "zh-CN" },
      }),
    );
    await expect(tooLarge).toContainText("这个文件太大，无法打开");
    await expect(viewer.getByTestId("viewer-fix-open")).toHaveText("用默认应用打开");
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: "en" },
      }),
    );
    // The Word file beside it is drawn as before.
    await review.getByTestId("open-document").click();
    await expect(window.getByTestId("viewer-title")).toHaveText("Coastal Flood Risk Review");
    await expect(viewer.getByTestId("viewer-docx")).toHaveAttribute("data-rendered", "yes");
    await expect(viewer.getByTestId("viewer-docx")).toContainText("Coastal Flood Risk Review");
    await app.close();
  } finally {
    await removeDataFolder(home);
  }
});
