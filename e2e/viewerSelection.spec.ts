import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { FakeScanScript } from "../src/core/documents/scan/fake";
import { buildPdf, type PdfPage } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  stubClipboard,
  wordsBox,
} from "./app";

/**
 * Selecting text in a PDF (#101): the menu under it adds it to the note as a
 * quote whose Citation is checked where it was selected, or copies it with its
 * citation, by the mouse, by ⌘/ and the arrows, and from ⌘K.
 */

const HEADER = "Ferrand and Moss, Rate cuts and retail margins";
/** A page: its running header, lines at its top, then lines at its foot over its number. */
const page = (number: number, top: readonly string[], foot: readonly string[] = []): PdfPage => ({
  lines: [HEADER, ...top],
  placed: [
    ...foot.map((text, index) => ({ text, x: 72, y: 110 - index * 14 })),
    { text: `${number}`, x: 290, y: 40 },
  ],
});
const PAPER = buildPdf([
  page(1, ["Grocers studied across the eleven chains.", "Margins recover within two quarters."]),
  page(2, [
    "Pooling the cuts, the recovery peaks in the second quarter.",
    "Margins recover within two quarters.",
  ]),
  page(
    3,
    [],
    [
      "The effect is larger for grocers that fund their stock",
      "at floating rates, as Table 3 shows.",
    ],
  ),
  page(4, [
    "Smaller chains recovered less, about 0.2 points.",
    "Only three of them are in the panel.",
  ]),
]);

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

/** The app with the paper beside a new Mind of two paragraphs, typed so the cursor has been in it. */
async function paperBesideMind({ mind = true } = {}) {
  const path = join(sources, "Rate cuts.pdf");
  await writeFile(path, PAPER);
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await addDocuments(window, [path]);
  await expectReadyDocuments(window, 1);
  if (mind) {
    await newMind(window);
    await window.keyboard.type("Margins");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Recovery");
  }
  await pointAndClick(
    window,
    window
      .getByTestId("document-list-item")
      .filter({ hasText: "Rate cuts" })
      .getByTestId("open-document"),
  );
  const viewer = window.getByTestId("viewer");
  const layer = (page: number) => viewer.locator(`[data-page-number="${page}"] .textLayer`);
  await expect(layer(1)).toContainText("Grocers studied");
  return { app, window, viewer, layer };
}

/**
 * Drags across words of a page's text layer as a person does, from the first
 * letter to just past the last, on to other words with `to`.
 */
async function dragOver(
  window: Page,
  layer: Locator,
  words: string,
  to?: { layer: Locator; words: string },
): Promise<void> {
  await expect(layer).toContainText(words);
  if (to) await expect(to.layer).toContainText(to.words);
  const from = await wordsBox(layer, words);
  const end = to ? await wordsBox(to.layer, to.words) : from;
  await window.mouse.move(from.left - 8, from.y, { steps: 4 });
  await window.mouse.move(from.left + 1, from.y, { steps: 2 });
  await window.mouse.down();
  await window.mouse.move(end.right + 2, end.y, { steps: 12 });
  await window.mouse.up();
}

const menuOf = (window: Page) => window.getByTestId("viewer-selection-menu");

async function quoteIn(window: Page, text: RegExp): Promise<Locator> {
  const quote = frontMindOrAny(window).locator("blockquote").filter({ hasText: text });
  await expect(quote).toHaveCount(1);
  return quote;
}

/** The Mind in view, wherever the focus is. */
const frontMindOrAny = (window: Page) =>
  window.locator('[data-testid="mind-pane"]:visible').first();

/** The Mind's top-level Blocks, by kind. */
const blockKinds = (window: Page) =>
  frontMindOrAny(window)
    .getByTestId("mind-editor")
    .locator(":scope > *")
    .evaluateAll((all) => all.map((block) => block.tagName.toLowerCase()));

test("selected text goes into the note at its cursor as a quote whose Citation is found on the page it was selected on", async () => {
  const { window, viewer, layer } = await paperBesideMind();
  // The cursor in the first paragraph, then the focus on the viewer's own button.
  await pointAndClick(window, frontMindOrAny(window).getByText("Margins", { exact: true }));
  await pointAndClick(window, viewer.getByTestId("pdf-next-page"));
  // The same words are on page 1 too: the Citation must say page 2.
  await dragOver(window, layer(2), "Margins recover within two quarters.");

  await expect(menuOf(window)).toBeVisible();
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));

  const quote = await quoteIn(window, /^Margins recover within two quarters\./);
  const citation = quote.getByTestId("citation-chip");
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(citation).toHaveAttribute("aria-label", /p\. 2/);
  await expect(menuOf(window)).toHaveCount(0);
  await expect(window.getByTestId("undo-line")).toContainText("Added a quote to");
  expect(await blockKinds(window)).toEqual(["p", "blockquote", "p"]);

  // ⌘Z in the Mind takes it back.
  await pointAndClick(window, frontMindOrAny(window).getByText("Margins", { exact: true }));
  await window.keyboard.press("ControlOrMeta+z");
  await expect(frontMindOrAny(window).locator("blockquote")).toHaveCount(0);
});

test("across a page break, the quote leaves out the footer and header, and copies with its citation", async () => {
  const { window, viewer, layer } = await paperBesideMind();
  const copied = await stubClipboard(window);
  // The foot of page 3 and the top of page 4 in view together.
  await viewer
    .locator('[data-page-number="4"]')
    .evaluate((page) => page.scrollIntoView({ block: "center" }));
  await expect(layer(3)).toContainText("floating");
  await dragOver(window, layer(3), "at floating rates", {
    layer: layer(4),
    words: "Smaller chains recovered less,",
  });

  await expect(menuOf(window)).toBeVisible();
  await pointAndClick(window, window.getByTestId("viewer-selection-copy"));
  await expect(window.getByTestId("copied-line")).toContainText("Copied with its citation");

  const clipboard = await copied();
  expect(clipboard["text/plain"]).toContain(
    "at floating rates, as Table 3 shows. Smaller chains recovered less,[1]",
  );
  expect(clipboard["text/plain"]).toMatch(/Sources\n\[1\] .*Rate cuts.*pp?\. 3/);
  expect(clipboard["text/plain"]).not.toContain(HEADER);
  expect(clipboard["text/html"]).toContain("<blockquote>");
  expect(clipboard["text/html"]).toContain('data-check="found"');
  expect(clipboard["text/html"]).toContain("mso-footnote-id:ftn1");
});

test("the keys reach the menu: ⌘/ moves into it, the arrows go through it, and ⌘K has its actions", async () => {
  const { window, layer } = await paperBesideMind();
  const copied = await stubClipboard(window);
  await dragOver(window, layer(1), "Grocers studied across the eleven chains.");
  await expect(menuOf(window)).toBeVisible();

  await window.keyboard.press("ControlOrMeta+/");
  await expect(window.getByTestId("viewer-selection-ask")).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await expect(window.getByTestId("viewer-selection-add")).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await expect(window.getByTestId("viewer-selection-copy")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(menuOf(window)).toHaveCount(0);

  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Add the selected text");
  await window.keyboard.press("Enter");
  const quote = await quoteIn(window, /^Grocers studied across the eleven chains\./);
  await expect(quote.getByTestId("citation-chip")).toHaveAttribute("aria-label", /p\. 1/);

  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Copy the selected text");
  await window.keyboard.press("Enter");
  await expect.poll(async () => (await copied())["text/plain"]).toContain("Grocers studied");
});

test("Shift and the arrows change the selection after a drag, and Add to note takes what they leave selected", async () => {
  const { window, layer } = await paperBesideMind();
  await dragOver(window, layer(1), "Grocers studied across the eleven");
  await expect(menuOf(window)).toBeVisible();

  // The focus is on the page's body after a drag: Shift and → take in " chains." too.
  const selected = () => window.evaluate(() => String(globalThis.getSelection()).trim());
  for (let key = 0; key < 12 && !(await selected()).endsWith("chains."); key++) {
    await window.keyboard.press("Shift+ArrowRight");
  }
  expect(await selected()).toBe("Grocers studied across the eleven chains.");
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));

  const quote = await quoteIn(window, /^Grocers studied across the eleven chains\./);
  await expect(quote.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
});

test("with no Mind open, Add to note asks which Mind, and a new one opens beside the paper, in Chinese", async () => {
  const { window, layer } = await paperBesideMind({ mind: false });
  await setLanguage(window, "zh-CN");
  await window
    .getByTestId("viewer")
    .locator('[data-page-number="4"]')
    .evaluate((page) => page.scrollIntoView());
  await dragOver(window, layer(4), "Only three of them are in the panel.");
  await expect(menuOf(window)).toBeVisible();
  await expect(window.getByTestId("viewer-selection-add")).toHaveText("添加到笔记");
  await expect(window.getByTestId("viewer-selection-copy")).toHaveText("复制（含引用）");

  await pointAndClick(window, window.getByTestId("viewer-selection-add"));
  const picker = window.getByTestId("add-to-picker");
  await expect(picker).toBeVisible();
  await expect(window.getByTestId("add-to-search")).toBeFocused();
  // The words acted on stay drawn while the picker has the focus.
  await expect
    .poll(() => window.evaluate(() => CSS.highlights.get("viewer-held-selection")?.size ?? 0))
    .toBe(1);
  await motionSettled(window);
  await pointAndClick(window, picker.locator('[data-target="new"]'));

  const quote = await quoteIn(window, /^Only three of them are in the panel\./);
  await expect(quote.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
  await expect(window.getByTestId("viewer")).toBeVisible();
});

test("words over more than two pages aren't added, and the notice says why", async () => {
  const { window, viewer, layer } = await paperBesideMind();
  for (const page of [1, 2, 3]) {
    await viewer
      .locator(`[data-page-number="${page}"]`)
      .evaluate((each) => each.scrollIntoView({ block: "center" }));
    await expect(layer(page)).toContainText(page === 3 ? "floating" : "Margins");
  }
  // From page 1 to page 3, as Shift and ↓ would select them: no drag holds three pages in view.
  await viewer.evaluate((root) => {
    const first = root.querySelector('[data-page-number="1"] .textLayer');
    const last = root.querySelector('[data-page-number="3"] .textLayer');
    if (!first || !last) throw new Error("The pages aren't drawn.");
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    globalThis.getSelection()?.removeAllRanges();
    globalThis.getSelection()?.addRange(range);
  });
  await expect(menuOf(window)).toBeVisible();
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));

  await expect(window.getByTestId("error-notice-message")).toContainText("two pages at most");
  await expect(frontMindOrAny(window).locator("blockquote")).toHaveCount(0);
});

test("Esc in the Mind picker adds nothing and makes no Mind", async () => {
  const { window, layer } = await paperBesideMind({ mind: false });
  await dragOver(window, layer(1), "Grocers studied across the eleven chains.");
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));
  await expect(window.getByTestId("add-to-search")).toBeFocused();

  await window.keyboard.press("Escape");

  await expect(window.getByTestId("add-to-picker")).toHaveCount(0);
  await expect(window.locator('[data-testid="mind-pane"]')).toHaveCount(0);
});

const SCANS = join(__dirname, "../tests/fixtures/scans");
/** What the text recognition model read on each scan of the set, with each line's box. */
const READ = JSON.parse(readFileSync(join(SCANS, "read.json"), "utf8")) as FakeScanScript;

test("on a scanned page, the text read from its picture is selected across lines and cited on its page", async () => {
  const script = join(sources, "scans.json");
  const scans = ["en-clean", "zh-clean"];
  await writeFile(
    script,
    JSON.stringify({
      pages: Object.fromEntries(
        scans.map((id, index) => [index + 1, { lines: READ.pages[id]?.lines ?? [], unsure: [] }]),
      ),
    }),
  );
  const path = join(sources, "Lease scan.pdf");
  await writeFile(
    path,
    buildPdf(scans.map((id) => ({ scan: readFileSync(join(SCANS, `${id}.jpg`)) }))),
  );
  const { app, window } = await launchApp(dataDir, { scans: script });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await addDocuments(window, [path]);
  await expectReadyDocuments(window, 1);
  await newMind(window);
  await window.keyboard.type("Terms");
  await pointAndClick(
    window,
    window.getByTestId("document-list-item").getByTestId("open-document"),
  );
  const layer = (page: number) =>
    window.getByTestId("viewer").locator(`[data-page-number="${page}"] .textLayer`);

  await dragOver(window, layer(1), "each undisputed invoice", {
    layer: layer(1),
    words: "of the date of receipt",
  });
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));
  const quote = await quoteIn(
    window,
    /^each undisputed invoice within thirty \(30\) days of the date of receipt/,
  );
  await expect(quote.getByTestId("citation-chip")).toHaveAttribute("data-check", "found");
  await expect(quote.getByTestId("citation-chip")).toHaveAttribute("aria-label", /p\. 1/);

  await window
    .getByTestId("viewer")
    .locator('[data-page-number="2"]')
    .evaluate((page) => page.scrollIntoView());
  await dragOver(window, layer(2), "乙方应于每季度首月", {
    layer: layer(2),
    words: "每逾期一日",
  });
  await pointAndClick(window, window.getByTestId("viewer-selection-add"));
  const chinese = await quoteIn(
    window,
    /^乙方应于每季度首月的五日前.*汇入甲方指定的银行账户。三、乙方逾期支付租金的，每逾期一日/,
  );
  await expect(chinese.getByTestId("citation-chip")).toHaveAttribute("aria-label", /p\. 2/);
});
