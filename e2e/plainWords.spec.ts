import { copyFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  addDocuments,
  addFilesLabel,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  interceptOpenPath,
  launchApp,
  openDocumentAt,
  pathsOpened,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

const FIXTURES = join(__dirname, "..", "tests", "fixtures", "formats");

/**
 * The empty states of the Library and the sidebar (#763, item 26): each names
 * what is missing and offers the two ways to add it, in place, in English and
 * Chinese and at both window widths the issue asks for.
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

/** Keeps a screenshot of the window, once it has settled, when INCARNAMIND_SCREENSHOTS names a folder. */
async function screenshot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await window.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  await mkdir(folder, { recursive: true });
  await window.screenshot({ path: join(folder, `${name}.png`) });
}

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

      const sidebar = window.getByTestId("documents-empty");
      await expect(sidebar.getByText(none, { exact: true })).toBeVisible();
      await fits(
        sidebar,
        sidebar.getByTestId("documents-empty-add-files"),
        sidebar.getByTestId("documents-empty-link-folder"),
      );
      await expect(sidebar.getByTestId("documents-empty-add-files")).toHaveText(add);
      await expect(sidebar.getByTestId("documents-empty-link-folder")).toHaveText(link);
      await screenshot(window, `sidebar-empty-${language}-${width}`);

      const library = window.getByTestId("library-empty");
      await pointAndClick(window, window.getByTestId("open-library"));
      await expect(library.getByText(none, { exact: true })).toBeVisible();
      await fits(
        library,
        library.getByTestId("library-empty-add-files"),
        library.getByTestId("library-empty-link-folder"),
      );
      await expect(library.getByTestId("library-empty-add-files")).toHaveText(add);
      await expect(library.getByTestId("library-empty-link-folder")).toHaveText(link);
      await screenshot(window, `library-empty-${language}-${width}`);
    } finally {
      await app.close();
    }
  });
}

type Pick = { canceled: boolean; filePaths: string[] };

for (const language of ["en", "zh-CN"] as const) {
  test(`each of the five new buttons opens its own door (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setLanguage(window, language);
      await dismissChatSetup(window);
      await interceptOpenPath(app);
      // What each picker was asked for, and what it answers: a test can't drive the system's own.
      await app.evaluate(({ dialog }) => {
        const asked: string[] = [];
        (globalThis as { picksAsked?: unknown }).picksAsked = asked;
        (globalThis as { nextPick?: unknown }).nextPick = { canceled: true, filePaths: [] };
        dialog.showOpenDialog = ((
          ...args: unknown[]
        ): Promise<{ canceled: boolean; filePaths: string[] }> => {
          const options = args.at(-1) as { properties?: string[] } | undefined;
          asked.push((options?.properties ?? []).join(","));
          return Promise.resolve((globalThis as unknown as { nextPick: Pick }).nextPick);
        }) as unknown as typeof dialog.showOpenDialog;
      });
      const asked = () =>
        app.evaluate(() => (globalThis as { picksAsked?: string[] }).picksAsked ?? []);
      const answer = (pick: Pick) =>
        app.evaluate((_electron, chosen) => {
          (globalThis as { nextPick?: unknown }).nextPick = chosen;
        }, pick);
      const folder = join(sources, "Reading");
      await mkdir(folder, { recursive: true });

      // The sidebar's two: Add files asks the system for files; Link a folder asks for a folder
      // and opens its dialog, which Escape closes with nothing linked.
      const sidebar = window.getByTestId("documents-empty");
      await expect(sidebar).toBeVisible();
      await sidebar.getByTestId("documents-empty-add-files").click();
      await expect.poll(async () => (await asked()).length).toBe(1);
      await answer({ canceled: false, filePaths: [folder] });
      await sidebar.getByTestId("documents-empty-link-folder").click();
      const dialog = window.getByTestId("link-folder-dialog");
      await expect(dialog).toBeVisible();
      expect((await asked()).at(-1)).toBe("openDirectory");
      await window.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      // The Library's two: the same doors, where the Library is empty too.
      await pointAndClick(window, window.getByTestId("open-library"));
      const library = window.getByTestId("library-empty");
      await expect(
        library.getByText(translate(language, "library.none"), { exact: true }),
      ).toBeVisible();
      await answer({ canceled: true, filePaths: [] });
      await library.getByTestId("library-empty-add-files").click();
      await expect.poll(async () => (await asked()).length).toBe(3);
      await answer({ canceled: false, filePaths: [folder] });
      await library.getByTestId("library-empty-link-folder").click();
      await expect(dialog).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      // Nothing was linked or added, so the Library still has nothing.
      await expect(window.getByTestId("library-count")).toHaveText("0");

      // The empty sheet's one: its file's own app is asked to open the file.
      const workbook = join(sources, "Regional Revenue.xlsx");
      await copyFile(join(FIXTURES, "Regional Revenue.xlsx"), workbook);
      await addDocuments(window, [workbook]);
      await openDocumentAt(window, { documentId: await documentIdOf(window, "Regional Revenue") });
      const sheet = window.getByTestId("viewer-sheet");
      await sheet.getByRole("tab", { name: "Empty" }).click();
      const empty = sheet.getByTestId("viewer-sheet-empty");
      await expect(empty).toBeVisible();
      await empty.getByTestId("viewer-sheet-open").click();
      await expect.poll(() => pathsOpened(app)).toEqual([await realpath(workbook)]);
    } finally {
      await app.close();
    }
  });
}
