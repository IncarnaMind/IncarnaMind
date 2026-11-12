import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { paragraph, wordFile } from "../tests/helpers/word";
import {
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  importWordFile,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  openOptions,
  removeDataFolder,
  savedPath,
  setWindowSize,
  useOutputLocation,
  WINDOW_SIZE,
} from "./app";
import { pdfText } from "./pdfText";

/** Set INCARNAMIND_SCREENSHOTS to a folder to save pictures of the sheet at each width. */
async function screenshot(target: Page, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await target.screenshot({ path: join(folder, `${name}.png`) });
}

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );

async function newNote(window: Page, title: string, text: string): Promise<void> {
  await newMind(window);
  await nameMind(window, title);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type(text);
}

let dataDir: string;
let out: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  out = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(out);
});

test("Export options gives a Note page numbers and a watermark, the PDF prints them, and another Note starts at the defaults, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
  await newNote(window, "Tides", "Spring tides come twice a month.");
  await useOutputLocation(window, out);

  const sheet = window.getByTestId("export-dialog");
  await openOptions(window, "Export options");
  const pageNumbers = sheet.getByTestId("export-page-numbers");
  const watermark = sheet.getByTestId("export-watermark");
  // Word and PDF start numbered, with no watermark.
  await expect(sheet.getByTestId("export-format")).toHaveValue("docx");
  await expect(pageNumbers).toBeChecked();
  await expect(watermark).toHaveValue("none");
  await motionSettled(window);
  await screenshot(window, "export-marks-en-wide");

  // A watermark of its own, and no page numbers, is saved with this Note.
  await watermark.selectOption("words");
  const words = sheet.getByTestId("export-watermark-words");
  await expect(words).toBeFocused();
  await expect(sheet.getByTestId("export-save")).toBeDisabled();
  await words.fill("Internal");
  await expect(sheet.getByTestId("export-save")).toBeEnabled();
  await pageNumbers.uncheck();
  await setWindowSize(app, window, 900, WINDOW_SIZE.height);
  await motionSettled(window);
  await screenshot(window, "export-marks-en-narrow");
  await sheet.getByTestId("export-save").click();
  await expect(sheet).toBeHidden();

  // The PDF prints the watermark on its pages, and prints no page number.
  await exportFromMenu(window, "pdf");
  const pages = await pdfText(await readFile(await savedPath(window, "Tides.pdf")));
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    expect(page).toContain("Internal");
    expect(page.split("\n").map((line) => line.trim())).not.toContain("1");
  }

  // The Note that made the choice has it; another Note has the defaults.
  await openOptions(window, "Export options");
  await expect(pageNumbers).not.toBeChecked();
  await expect(watermark).toHaveValue("words");
  await expect(sheet.getByTestId("export-watermark-words")).toHaveValue("Internal");
  await window.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
  await newNote(window, "Neap tides", "Neap tides are weaker.");
  await openOptions(window, "Export options");
  await expect(pageNumbers).toBeChecked();
  await expect(watermark).toHaveValue("none");
  await window.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // In Chinese, at both widths, the watermarks read 无、草稿、机密 and the User's own words.
  await setLanguage(window, "zh-CN");
  await setWindowSize(app, window, 1600, WINDOW_SIZE.height);
  await openOptions(window, "导出选项");
  await expect(pageNumbers).toBeChecked();
  await expect(watermark).toHaveAccessibleName("水印");
  await expect(watermark.locator("option")).toHaveText(["无", "草稿", "机密", "自定义文字…"]);
  await watermark.selectOption("draft");
  await motionSettled(window);
  await screenshot(window, "export-marks-zh-wide");
  await setWindowSize(app, window, 900, WINDOW_SIZE.height);
  const [sheetBox, windowWidth] = await Promise.all([
    sheet.boundingBox(),
    window.evaluate(() => globalThis.innerWidth),
  ]);
  if (!sheetBox) throw new Error("The sheet isn't laid out.");
  expect(sheetBox.x).toBeGreaterThanOrEqual(0);
  expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(windowWidth);
  await motionSettled(window);
  await screenshot(window, "export-marks-zh-narrow");
  await window.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("a Note made from a Word file starts without page numbers in Word, with them in PDF, and says its file's own stay, in English and Chinese; a watermark set alone keeps both; a Note written here starts with them", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
  await importWordFile(
    app,
    window,
    out,
    "Lease brief.docx",
    wordFile({ body: paragraph("The lease ends in 2030.") }),
  );
  await expect(window.getByTestId("mind-editor")).toContainText("The lease ends in 2030.");

  const sheet = window.getByTestId("export-dialog");
  const format = sheet.getByTestId("export-format");
  const pageNumbers = sheet.getByTestId("export-page-numbers");
  const usual = {
    en: "At the foot of every Word and PDF page.",
    "zh-CN": "Word 和 PDF 的每页页脚都会显示页码。",
  };
  const wordHint = {
    en: "Your file’s own headers, footers and page numbers stay as they are. Turn this on to add page numbers if the file has no footer of its own.",
    "zh-CN": "文件自带的页眉、页脚和页码保持不变。开启后，仅当文件没有自带页脚时才添加页码。",
  };
  const title = { en: "Export options", "zh-CN": "导出选项" };
  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    await openOptions(window, title[language]);
    await expect(format).toHaveValue("docx");
    await expect(pageNumbers).not.toBeChecked();
    await expect(pageNumbers).toHaveAccessibleDescription(wordHint[language]);
    await motionSettled(window);
    await screenshot(window, `export-marks-word-docx-${language}`);
    await format.selectOption("pdf");
    await expect(pageNumbers).toBeChecked();
    await expect(pageNumbers).toHaveAccessibleDescription(usual[language]);
    await motionSettled(window);
    await screenshot(window, `export-marks-word-pdf-${language}`);
    await window.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }

  // Saving the sheet with the marks untouched saves no choice: the PDF keeps its page numbers.
  await openOptions(window, "导出选项");
  await expect(pageNumbers).not.toBeChecked();
  await sheet.getByTestId("export-save").click();
  await expect(sheet).toBeHidden();
  const marksIn = (wanted: "docx" | "pdf") =>
    window.evaluate(async (each) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [mind] = await core.listMinds();
      if (!mind) throw new Error("There is no Note.");
      return core.getExportMarks(mind.id, each);
    }, wanted);
  expect(await marksIn("pdf")).toEqual({ pageNumbers: true, watermark: "none" });

  // A watermark set alone, with PDF or with Word showing, leaves each format's page numbers as
  // they start: off in Word, on in PDF, also when the format is changed in the open sheet.
  const watermark = sheet.getByTestId("export-watermark");
  for (const [showing, chosen] of [
    ["pdf", "draft"],
    ["docx", "confidential"],
  ] as const) {
    await openOptions(window, "导出选项");
    await format.selectOption(showing);
    await watermark.selectOption(chosen);
    await sheet.getByTestId("export-save").click();
    await expect(sheet).toBeHidden();
    expect(await marksIn("docx")).toEqual({ pageNumbers: false, watermark: chosen });
    expect(await marksIn("pdf")).toEqual({ pageNumbers: true, watermark: chosen });
    await openOptions(window, "导出选项");
    await format.selectOption("docx");
    await expect(watermark).toHaveValue(chosen);
    await expect(pageNumbers).not.toBeChecked();
    await format.selectOption("pdf");
    await expect(watermark).toHaveValue(chosen);
    await expect(pageNumbers).toBeChecked();
    await window.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }

  await newNote(window, "Tides", "Spring tides come twice a month.");
  await openOptions(window, "导出选项");
  await expect(pageNumbers).toBeChecked();
  await expect(pageNumbers).toHaveAccessibleDescription(usual["zh-CN"]);
  await window.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});
