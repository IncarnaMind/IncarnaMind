import { expect, type Locator, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  addFilesLabel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * The empty states of the Library and the sidebar (#763, item 26): each names
 * what is missing and offers the two ways to add it, in place, in English and
 * Chinese and at both window widths the issue asks for.
 */
let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

for (const [language, width] of [
  ["en", 900],
  ["en", 1600],
  ["zh-CN", 900],
  ["zh-CN", 1600],
] as const) {
  test(`an empty Library and sidebar say No Documents yet and offer both ways in (${language}, ${width}px)`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, 900);
      await setLanguage(window, language);
      await dismissChatSetup(window);

      const none = translate(language, "library.none");
      const add = addFilesLabel(language);
      const link = translate(language, "startGuide.documents.linkFolder");

      // Each says it on one or two lines, with both buttons there to press, at either width.
      const fits = async (line: Locator, add: Locator, link: Locator) => {
        for (const button of [add, link]) {
          await expect(button).toBeVisible();
          const box = await button.boundingBox();
          expect(box?.width ?? 0).toBeGreaterThan(40);
        }
        await expect
          .poll(() => line.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
          .toBe(true);
      };

      const library = window.getByTestId("library-empty");
      await pointAndClick(window, window.getByTestId("open-library"));
      await expect(library).toContainText(none);
      await fits(
        library,
        library.getByTestId("library-empty-add-files"),
        library.getByTestId("library-empty-link-folder"),
      );
      await expect(library.getByTestId("library-empty-add-files")).toHaveText(add);
      await expect(library.getByTestId("library-empty-link-folder")).toHaveText(link);

      const sidebar = window.getByTestId("documents-empty");
      await expect(sidebar).toContainText(none);
      await fits(
        sidebar,
        sidebar.getByTestId("documents-empty-add-files"),
        sidebar.getByTestId("documents-empty-link-folder"),
      );
      await expect(sidebar.getByTestId("documents-empty-add-files")).toHaveText(add);
      await expect(sidebar.getByTestId("documents-empty-link-folder")).toHaveText(link);
    } finally {
      await app.close();
    }
  });
}
