import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * The empty states of the Library, the sidebar and Home (#763, item 26): each
 * names what is missing and offers the two ways to add it, in place, in
 * English and Chinese and at both window widths the issue asks for.
 */
let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const goHome = async (window: Page) => {
  await window.getByTestId("sidebar-home").click();
  await expect(window.getByTestId("home")).toBeVisible();
};

for (const [language, width] of [
  ["en", 900],
  ["en", 1600],
  ["zh-CN", 900],
  ["zh-CN", 1600],
] as const) {
  test(`an empty Library, sidebar and Home say No Documents yet and offer Add files… and Link a folder… (${language}, ${width}px)`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, 900);
      await setLanguage(window, language);
      await dismissChatSetup(window);

      const none = language === "zh-CN" ? "还没有文档" : "No Documents yet";
      const add = language === "zh-CN" ? "添加文件…" : "Add files…";
      const link = language === "zh-CN" ? "添加同步文件夹…" : "Link a folder…";

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

      const home = window.getByTestId("home-empty");
      await goHome(window);
      await expect(home).toContainText(none);
      await fits(
        home,
        home.getByTestId("home-empty-add-files"),
        home.getByTestId("home-empty-link-folder"),
      );
      await expect(home.getByTestId("home-empty-add-files")).toHaveText(add);
      await expect(home.getByTestId("home-empty-link-folder")).toHaveText(link);

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
