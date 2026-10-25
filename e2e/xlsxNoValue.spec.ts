import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { xlsxPackage } from "../tests/helpers/office";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  launchApp,
  openDocumentAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A workbook whose formulas have no saved result, as a script that writes formulas leaves them
 * (#1514), says "No saved value" in those cells, never 0, as words where there is room and as a
 * dash with the words on hover where there is not; a formula with a saved result, 0 too, shows it. Set INCARNAMIND_SCREENSHOTS to a folder to also save a screenshot.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

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

for (const [language, said] of [
  ["en", "No saved value"],
  ["zh-CN", "无保存的值"],
] as const) {
  test(`a formula with no saved result says so, not 0 (${language})`, async () => {
    const text = (ref: string, value: string) =>
      `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
    const sheet = [
      "<sheetData>",
      `<row r="1">${text("A1", "Shipments")}${text("B1", "March")}${text("C1", "April")}</row>`,
      `<row r="2">${text("A2", "Europe")}<c r="B2"><v>128400</v></c><c r="C2"><v>96200</v></c></row>`,
      `<row r="3">${text("A3", "Total")}<c r="B3"><f>SUM(B2:B2)</f><v></v></c><c r="C3"><f>SUM(C2:C2)</f></c><c r="D3"><f>SUM(B2:C2)</f><v>0</v></c></row>`,
      `<row r="4">${text("A4", "Net")}<c r="B4"><f>B2-C2</f></c></row>`,
      "</sheetData>",
    ].join("");
    const file = join(sources, "Shipments.xlsx");
    await writeFile(file, xlsxPackage({ sheets: [{ name: "Totals", xml: sheet }] }));
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [file]);
    await openDocumentAt(window, { documentId: await documentIdOf(window, "Shipments") });

    const grid = window.getByTestId("viewer").getByTestId("viewer-grid");
    await expect(grid.locator('td[data-ref="B2"]')).toHaveText("128400");
    // Beside another cell a column holds no words: a dash, with the words on hover and for a
    // screen reader, not "No sav".
    for (const ref of ["B3", "C3"]) {
      const cell = grid.locator(`td[data-ref="${ref}"]`);
      await expect(cell).toHaveText("\u2014");
      await expect(cell).toHaveAttribute("title", said);
      await expect(cell).toHaveAttribute("aria-label", said);
    }
    await expect(grid.locator('td[data-ref="D3"]')).toHaveText("0");
    // With empty cells to its right the words run on over them, as text does, whole.
    const net = grid.locator('td[data-ref="B4"]');
    await expect(net).toHaveText(said);
    await expect(net).toHaveAttribute("colspan", /^[2-9]$/);
    expect(await net.evaluate((cell) => cell.scrollWidth <= cell.clientWidth + 1)).toBe(true);
    await screenshot(window, `xlsx-no-value-${language === "en" ? "en" : "zh"}`);
    await app.close();
  });
}
