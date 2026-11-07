import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
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
