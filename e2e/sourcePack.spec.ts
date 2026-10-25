/**
 * The source pack (#134), in the built app: Export options › Source pack (PDF) writes a cover
 * list and a page for each cited Location, from the pages saved when the Citations were made,
 * after a source file has gone. The scripted model cites a Word section, a slide, rows of a
 * sheet and of a CSV, and a PDF page; the pack is read back with pdf.js. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
import { existsSync } from "node:fs";
import { copyFile, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { openDatabase } from "../src/core/storage";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  openOptions,
  pointAndClick,
  removeDataFolder,
  savedPath,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
  WINDOW_SIZE,
} from "./app";
import { pdfPictures, pdfText } from "./pdfText";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

/** The window, once what moves in it has stopped. */
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const FIXTURES = join(__dirname, "..", "tests", "fixtures", "formats");
const WORD = "Coastal Flood Risk Review.docx";
const FILES = [WORD, "Quarterly Research Update.pptx", "Regional Revenue.xlsx", "Orders.csv"];
const PDF = "Tide Gauges.pdf";
const NAMES = [
  "Coastal Flood Risk Review",
  "Orders",
  "Quarterly Research Update",
  "Regional Revenue",
  "Tide Gauges",
];
const QUESTION =
  "Compare each: the western fastest growth, the barrier crest halves damage, and West totals in rows.";

/** Text compared without its spaces and line breaks, which fonts and wrapping decide. */
const unspaced = (text: string) => text.replace(/\s+/g, "");

let dataDir: string;
let sources: string;
let home: string;
let out: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  home = await createDataFolder();
  out = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
  await removeDataFolder(out);
});

/** The sheet sits inside the window, and its format note and Save button are in it. */
async function expectToFit(window: Page, sheet: Locator): Promise<void> {
  const [box, width] = await Promise.all([
    sheet.boundingBox(),
    window.evaluate(() => globalThis.innerWidth),
  ]);
  if (!box) throw new Error("The sheet isn't laid out.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  await expect(sheet.getByTestId("export-format-note")).toBeVisible();
  await expect(sheet.getByTestId("export-save")).toBeVisible();
}

/** The Documents a page is saved for, by name, as the data folder's database has them. */
function savedPageNames(): string[] {
  const db = openDatabase(join(dataDir, "incarnamind.db"));
  try {
    return db
      .all<{ name: string }>(
        `SELECT d.name FROM cited_pages p JOIN documents d ON d.id = p.document_id
         WHERE p.deleted_at IS NULL AND p.image_type IS NOT NULL ORDER BY d.name`,
      )
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

test("Export options › Source pack writes a cover list and a page for each cited Location, from the saved pages, after a source file is deleted", async () => {
  // Two Answers, five pages drawn, two packs printed: more than one launch's time on a slow runner.
  test.setTimeout(240_000);
  const library = await realpath(sources);
  for (const file of FILES) await copyFile(join(FIXTURES, file), join(library, file));
  await writeFile(
    join(library, PDF),
    buildPdf([
      { lines: ["Tide gauges"] },
      { lines: ["Felixstowe", "The Felixstowe gauges recorded the highest readings of the year."] },
    ]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(
    window,
    [...FILES, PDF].map((file) => join(library, file)),
  );
  await newMind(window);
  await nameMind(window, "Tides 潮汐");

  // The Mind keeps both Answers, with their Citations.
  await addToNote(window, await askInAssistant(window, QUESTION));
  await addToNote(
    window,
    await askInAssistant(window, "Which gauges recorded the highest readings?"),
  );
  const citations = window.getByTestId("mind-editor").getByTestId("citation");
  await expect(citations).toHaveCount(5);
  await expect.poll(savedPageNames, { timeout: 60_000 }).toEqual(NAMES);

  // The Word file is deleted: its page is in the pack all the same.
  await rm(join(library, WORD));
  await useOutputLocation(window, out);
  await openOptions(window, "Export options");
  const sheet = window.getByTestId("export-dialog");
  await sheet.getByTestId("export-format").selectOption("source-pack");
  await expect(sheet.getByTestId("export-format-note")).toHaveText(
    "Each cited page, its quotes highlighted and numbered.",
  );
  await expect(sheet.getByTestId("export-pack-empty")).toHaveCount(0);
  // A pack has no Questions to include.
  await expect(sheet.getByTestId("export-include-questions")).toHaveCount(0);
  await screenshot(window, "source-pack-options-en-wide");
  await sheet.getByTestId("export-save").click();
  await expect(sheet).toBeHidden();
  const exportButton = window.getByTestId("export-mind");
  await expect(exportButton).toHaveAttribute("data-format", "source-pack");

  await pointAndClick(window, window.getByTestId("mind-editor"));
  await window.keyboard.press("ControlOrMeta+Shift+E");
  const path = await savedPath(window, "Tides 潮汐 - source pack.pdf");
  const pdf = await readFile(path);
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const pages = await pdfText(pdf);

  // The cover list names the Mind and each Citation's Document; a page for each follows, each
  // with its picture, its number at the foot.
  expect(pages).toHaveLength(1 + NAMES.length);
  const cover = unspaced(pages[0] ?? "");
  expect(cover).toContain(unspaced("Tides 潮汐"));
  expect(cover).toContain(unspaced("Document and Location"));
  for (const name of NAMES) expect(cover, name).toContain(unspaced(name));
  const shown = pages.slice(1).map((page) => NAMES.filter((name) => page.includes(name)));
  expect(shown.map((names) => names.length)).toEqual([1, 1, 1, 1, 1]);
  expect(shown.flat().sort()).toEqual(NAMES);
  pages.slice(1).forEach((page, index) => {
    expect(page.trim().endsWith(String(index + 2)), `page ${index + 2} is numbered`).toBe(true);
  });
  expect((await pdfPictures(pdf)).map((pictures) => pictures.length)).toEqual([0, 1, 1, 1, 1, 1]);
  if (SCREENSHOTS) await writeFile(join(SCREENSHOTS, "source-pack.pdf"), pdf);

  // Exported again, it is the same pack under the next free name.
  await exportFromMenu(window);
  const again = await savedPath(window, "Tides 潮汐 - source pack 2.pdf");
  expect(await pdfText(await readFile(again))).toEqual(pages);
  expect((await readdir(out)).sort()).toEqual([
    "Tides 潮汐 - source pack 2.pdf",
    "Tides 潮汐 - source pack.pdf",
  ]);
  expect(existsSync(join(library, WORD))).toBe(false);

  // The sheet holds at the narrowest and the widest window, in English and in Chinese.
  await setWindowSize(app, window, 900, WINDOW_SIZE.height);
  await openOptions(window, "Export options");
  await expectToFit(window, sheet);
  await screenshot(window, "source-pack-options-en-narrow");
  await window.keyboard.press("Escape");
  await setLanguage(window, "zh-CN");
  await openOptions(window, "导出选项");
  await expectToFit(window, sheet);
  await screenshot(window, "source-pack-options-zh-narrow");
  await window.keyboard.press("Escape");
  await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
  await openOptions(window, "导出选项");
  await expectToFit(window, sheet);
  await screenshot(window, "source-pack-options-zh-wide");
  await app.close();
});

test("a Mind with no Citations says so in the sheet and on Export, and in Chinese at the narrowest window", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await newMind(window);
  await nameMind(window, "Tides");
  await pointAndClick(window, window.getByTestId("mind-editor"));
  await window.keyboard.type("Spring tides come twice a month.");
  await useOutputLocation(window, out);

  await openOptions(window, "Export options");
  const sheet = window.getByTestId("export-dialog");
  await sheet.getByTestId("export-format").selectOption("source-pack");
  const empty = sheet.getByTestId("export-pack-empty");
  await expect(empty).toHaveText("No Citations yet, so no cited pages to export.");
  await sheet.getByTestId("export-save").click();
  await expect(sheet).toBeHidden();

  // Export says it on the Mind, with no file made and no fix offered for a place that is fine.
  await exportFromMenu(window);
  const problem = window.getByTestId("export-result").getByTestId("export-problem");
  await expect(problem).toHaveText("No Citations yet, so no cited pages to export.");
  await expect(window.getByTestId("export-change-location")).toHaveCount(0);
  expect(await readdir(out)).toEqual([]);

  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 900, WINDOW_SIZE.height);
  await openOptions(window, "导出选项");
  await expect(sheet.getByTestId("export-format")).toHaveValue("source-pack");
  await expect(sheet.getByTestId("export-format").locator("option:checked")).toHaveText(
    "PDF 引用页面合集",
  );
  await expect(sheet.getByTestId("export-format-note")).toHaveText(
    "每个引用页面，引文高亮并编号。",
  );
  await expect(sheet.getByTestId("export-pack-empty")).toHaveText(
    "还没有引用，没有可导出的引用页面。",
  );
  await expectToFit(window, sheet);
  await screenshot(window, "source-pack-options-zh-empty-narrow");
  await app.close();
});
