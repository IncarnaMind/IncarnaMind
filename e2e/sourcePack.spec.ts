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
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
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
  savedLine,
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

/**
 * The small pack of #1455: two short Chinese Markdown Documents of project facts. The scripted
 * model quotes the line that shares the most words with the Question, so each line has a Latin
 * word to ask for it by.
 */
const PROJECT = {
  name: "星河项目概况",
  text: "# 星河项目概况\n\n星河项目于 2026 年 3 月启动，总预算为 1200 万元。\n\n项目团队共有 18 人，分布在上海和成都两地，代号 ALPHA。\n\n第一阶段已于 6 月完成，第二阶段预计在 11 月底交付，评审 BETA。\n",
};
const RISKS = {
  name: "星河项目风险",
  text: "# 星河项目风险\n\n供应商交付延迟可能使第二阶段推迟两周，2026 年内需复核。\n\n成都团队的测试环境尚未就绪，代号 ALPHA。\n\n项目组已与备选供应商签订意向书，评审 BETA。\n",
};
const BRIEF = "星河项目简报";

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

/** It sits inside the window, from side to side. */
async function expectInWindow(window: Page, shown: Locator): Promise<void> {
  const [box, width] = await Promise.all([
    shown.boundingBox(),
    window.evaluate(() => globalThis.innerWidth),
  ]);
  if (!box) throw new Error("It isn't laid out.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

/** The sheet sits inside the window, and its format note and Save button are in it. */
async function expectToFit(window: Page, sheet: Locator): Promise<void> {
  await expectInWindow(window, sheet);
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

/**
 * A Mind named `BRIEF` citing the Documents' sections: a Citation for each Question, one for each
 * Document for a Question with "each", added to it; it waits until their pages are saved.
 */
async function briefCiting(
  window: Page,
  documents: readonly { name: string; text: string }[],
  questions: readonly string[],
): Promise<Locator> {
  const library = await realpath(sources);
  const files = documents.map(({ name, text }) => ({ path: join(library, `${name}.md`), text }));
  await Promise.all(files.map(({ path, text }) => writeFile(path, text)));
  await addDocuments(
    window,
    files.map(({ path }) => path),
  );
  await newMind(window);
  await nameMind(window, BRIEF);
  for (const question of questions) await addToNote(window, await askInAssistant(window, question));
  await expect
    .poll(savedPageNames, { timeout: 60_000 })
    .toEqual(documents.map(({ name }) => name).sort());
  return window.getByTestId("mind-editor").getByTestId("citation");
}

/** The small pack, read back: a cover list, then each section's page, its quotes found and numbered. */
async function expectSmallPack(path: string, column: string): Promise<void> {
  const pdf = await readFile(path);
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const [cover = "", ...sheets] = await pdfText(pdf);
  for (const words of [BRIEF, column, PROJECT.name, RISKS.name]) {
    expect(unspaced(cover), words).toContain(unspaced(words));
  }
  const shown = sheets.map((sheet) =>
    [PROJECT.name, RISKS.name].filter((name) => sheet.includes(name)),
  );
  expect(shown.map((names) => names.length)).toEqual([1, 1]);
  expect(shown.flat().sort()).toEqual([PROJECT.name, RISKS.name].sort());
  // Each page is headed by the numbers of the Citations on it: the seven between them.
  const numbers = sheets.flatMap((sheet) =>
    (/^[\d,\s]+/.exec(sheet)?.[0] ?? "").split(/\D+/).filter(Boolean).map(Number),
  );
  expect(numbers.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  for (const sheet of sheets) expect(sheet).not.toMatch(/此页未找到引文|Quote not found/);
  expect((await pdfPictures(pdf)).map((pictures) => pictures.length)).toEqual([0, 1, 1]);
}

/** Chromium fails to print the next PDF, as it may; the one after prints. */
async function failNextPrint(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents }) => {
    const [contents] = webContents.getAllWebContents();
    if (!contents) throw new Error("No page to reach printing by.");
    const prototype: Pick<typeof contents, "printToPDF"> = Object.getPrototypeOf(contents);
    const print = prototype.printToPDF;
    prototype.printToPDF = () => {
      prototype.printToPDF = print;
      return Promise.reject(new Error("Printing failed."));
    };
  });
}

test("a small pack, two Chinese Markdown Documents cited seven times in two sections, exports from Export › More formats in Chinese and in English (#1455)", async () => {
  // Four Answers and two pages drawn, then two packs printed.
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  const citations = await briefCiting(
    window,
    [PROJECT, RISKS],
    ["each 2026", "each alpha", "each beta", "预算 1200"],
  );
  await expect(citations).toHaveCount(7);
  for (const citation of await citations.all()) {
    await expect(citation).toHaveAttribute("data-check", "found");
  }
  await useOutputLocation(window, out);

  // The hidden print page paints no frame, as in the app: the pack is saved all the same, at once.
  await exportFromMenu(window, "source-pack");
  const result = window.getByTestId("export-result");
  const done = result.getByTestId("export-done");
  await expect(done.getByTestId("export-saved")).toHaveText(
    savedLine(`${BRIEF} - 引用页面合集.pdf`, out, "zh-CN"),
    {
      timeout: 30_000,
    },
  );
  await expect(done.getByTestId("export-unchecked")).toHaveText("未核对");
  await expect(result.getByTestId("export-problem")).toHaveCount(0);
  await expectSmallPack((await done.getAttribute("title")) ?? "", "文档和位置");

  await setLanguage(window, "en");
  await exportFromMenu(window, "source-pack");
  await expectSmallPack(
    await savedPath(window, `${BRIEF} - source pack.pdf`),
    "Document and Location",
  );
  expect((await readdir(out)).sort()).toEqual([
    `${BRIEF} - source pack.pdf`,
    `${BRIEF} - 引用页面合集.pdf`,
  ]);
  await app.close();
});

test("a PDF that couldn't be laid out says so in the Mind, in Chinese and in English, and Try again exports it, with no Change output location…", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  await expect(await briefCiting(window, [PROJECT], ["预算 1200"])).toHaveCount(1);
  await useOutputLocation(window, out);

  await failNextPrint(app);
  await exportFromMenu(window, "source-pack");
  const result = window.getByTestId("export-result");
  const problem = result.getByTestId("export-problem");
  await expect(problem).toHaveText("无法完成 PDF 排版，因此没有保存任何内容。· 重试");
  await expect(result.getByTestId("export-change-location")).toHaveCount(0);
  expect(await readdir(out)).toEqual([]);
  await screenshot(window, "source-pack-not-laid-out-zh-wide");
  await setWindowSize(app, window, 900, WINDOW_SIZE.height);
  await expectInWindow(window, result);
  await screenshot(window, "source-pack-not-laid-out-zh-narrow");

  // The line stays, in the language the User turns to; Try again is the action, by the keyboard too.
  await setLanguage(window, "en");
  await expect(problem).toHaveText("Couldn’t lay out the PDF, so nothing was saved. · Try again");
  await expect(result.getByTestId("export-change-location")).toHaveCount(0);
  await expectInWindow(window, result);
  await screenshot(window, "source-pack-not-laid-out-en-narrow");
  await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
  await screenshot(window, "source-pack-not-laid-out-en-wide");
  await result.getByTestId("export-dismiss").focus();
  await window.keyboard.press("Shift+Tab");
  await expect(result.getByTestId("export-try-again")).toBeFocused();
  await window.keyboard.press("Enter");
  await savedPath(window, `${BRIEF} - source pack.pdf`);
  await expect(problem).toHaveCount(0);
  await app.close();
});

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
