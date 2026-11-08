import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  launchApp,
  newMind,
  openDocumentAt,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A PDF added to the Library and sorted into a Folder opens with its pages from every way in
 * (#2828): its row in the Library, a Citation in a Note, and ⌘K.
 */

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

const pageDrawn = (window: Page, page: number): Locator =>
  window.getByTestId("viewer").locator(`[data-page-number="${page}"]`);

async function expectPages(window: Page, page: number, words: string): Promise<void> {
  await expect(pageDrawn(window, page)).toHaveAttribute("data-drawn", "true");
  await expect(pageDrawn(window, page).locator(".textLayer")).toContainText(words);
  await expect(window.getByTestId("viewer-not-opened")).toHaveCount(0);
}

for (const [language, name, folder] of [
  ["en", "Quarterly report", "Contracts"],
  ["zh-CN", "季度报告", "合同"],
] as const) {
  test(`a PDF sorted into a Folder opens with its pages from the Library, a Citation and ⌘K (${language})`, async () => {
    const file = join(sources, `${name}.pdf`);
    await writeFile(
      file,
      buildPdf([
        { lines: ["Board summary", "Prepared for the trustees."] },
        { lines: ["Results", "Revenue grew by ten percent in the third quarter."] },
      ]),
    );
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1440, 900);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await addDocuments(window, [file]);
      const documentId = await documentIdOf(window, name);
      await window.evaluate(
        async ([id, folderName]) => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const made = await bridge.createLibraryGroup({ name: folderName, description: "" });
          await bridge.moveToFolder({ documentIds: [id], folderId: made.id });
        },
        [documentId, folder] as const,
      );

      await pointAndClick(window, window.getByTestId("open-library"));
      const section = window.getByTestId("library-section").filter({
        has: window.getByTestId("library-section-name").getByText(folder, { exact: true }),
      });
      const row = section.locator(
        `[data-testid="library-document"][data-document-id="${documentId}"]`,
      );
      await expect(row).toBeVisible();
      await pointAndClick(window, row.locator("[data-row-main]"));
      await expect(window.getByTestId("viewer-title")).toHaveText(name);
      await expectPages(window, 1, "Board summary");
      await window.getByTestId("document-tab").getByTestId("tab-close").click();
      await expect(window.getByTestId("viewer")).toHaveCount(0);

      await newMind(window);
      await openDocumentAt(window, {
        documentId,
        pageFrom: 2,
        pageTo: 2,
        quote: "Revenue grew by ten percent",
      });
      await expectPages(window, 2, "Revenue grew by ten percent");
      await window.getByTestId("document-tab").getByTestId("tab-close").click();
      await expect(window.getByTestId("viewer")).toHaveCount(0);

      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(name);
      const item = window.getByTestId("palette-item").filter({ hasText: name }).first();
      await pointAndClick(window, item);
      await expect(window.getByTestId("viewer-title")).toHaveText(name);
      await expectPages(window, 1, "Board summary");
    } finally {
      await app.close();
    }
  });
}
