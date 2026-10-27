import { copyFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  addFilesLabel,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  expectReadyDocuments,
  interceptOpenPath,
  launchApp,
  openDocumentAt,
  pathsOpened,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setSidebarWidth,
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

const SIDEBAR_MIN = 165;
const SIDEBAR_DEFAULT = 248;

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
      const none = translate(language, "library.none");
      const sidebar = window.getByTestId("documents-empty");
      const dialog = window.getByTestId("link-folder-dialog");

      // The empty sidebar at its narrowest, as the footer row is checked: the line and both ways
      // in stay visible, each inside the sidebar's own box, nothing pushed out of it.
      await expect(sidebar.getByText(none, { exact: true })).toBeVisible();
      await setSidebarWidth(window, SIDEBAR_MIN);
      const sidebarBox = await window.getByTestId("sidebar").boundingBox();
      if (!sidebarBox) throw new Error("The sidebar isn't visible.");
      for (const part of [
        sidebar.getByText(none, { exact: true }),
        sidebar.getByTestId("documents-empty-add-files"),
        sidebar.getByTestId("documents-empty-link-folder"),
      ]) {
        await expect(part).toBeVisible();
        const box = await part.boundingBox();
        if (!box) throw new Error("A part of the empty sidebar isn't visible.");
        expect(box.x).toBeGreaterThanOrEqual(sidebarBox.x);
        expect(box.y).toBeGreaterThanOrEqual(sidebarBox.y);
        expect(box.x + box.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width);
        expect(box.y + box.height).toBeLessThanOrEqual(sidebarBox.y + sidebarBox.height);
      }
      await screenshot(window, `sidebar-empty-narrow-${language}`);
      await setSidebarWidth(window, SIDEBAR_DEFAULT);

      // The sidebar's two: Link a folder asks the system for a folder and opens its dialog, which
      // Escape closes with nothing linked.
      await answer({ canceled: false, filePaths: [folder] });
      await sidebar.getByTestId("documents-empty-link-folder").click();
      await expect.poll(async () => (await asked()).length).toBe(1);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("link-folder-files")).toBeVisible();
      expect((await asked()).at(-1)).toBe("openDirectory");
      await window.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      // Add files asks for files, and the file the sheet answers is added: the sidebar's count
      // moves and its empty line gives way to the Document's row.
      const orders = join(sources, "Harbour orders.csv");
      await copyFile(join(FIXTURES, "Orders.csv"), orders);
      await answer({ canceled: false, filePaths: [orders] });
      await sidebar.getByTestId("documents-empty-add-files").click();
      await expect.poll(async () => (await asked()).length).toBe(2);
      await expect(window.getByTestId("library-row-count")).toHaveText("1");
      const row = window.getByTestId("document-list-item");
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("Harbour orders");
      await expect(sidebar).toHaveCount(0);
      await expectReadyDocuments(window, 1);

      // The Library's Add door needs the Library empty again, so take the Document back through
      // the core: its own pass then starts from nothing too.
      const ordersId = await documentIdOf(window, "Harbour orders");
      await (await coreOf(window)).evaluate((core, id) => core.deleteDocument(id), ordersId);
      await expect(row).toHaveCount(0);
      await expect(window.getByTestId("library-row-count")).toHaveText("0");
      await expect(window.getByTestId("documents-empty")).toBeVisible();

      // The Library's two: the same doors, where the Library is empty too.
      await pointAndClick(window, window.getByTestId("open-library"));
      const library = window.getByTestId("library-empty");
      await expect(library.getByText(none, { exact: true })).toBeVisible();
      await answer({ canceled: false, filePaths: [folder] });
      await library.getByTestId("library-empty-link-folder").click();
      await expect.poll(async () => (await asked()).length).toBe(3);
      await expect(dialog).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      // The dialog closed with nothing linked, so the Library still has nothing.
      await expect(window.getByTestId("library-count")).toHaveText("0");
      await expect(library).toBeVisible();

      // Add files here adds a real workbook too: the Library counts it and shows its row.
      const workbook = join(sources, "Regional Revenue.xlsx");
      await copyFile(join(FIXTURES, "Regional Revenue.xlsx"), workbook);
      await answer({ canceled: false, filePaths: [workbook] });
      await library.getByTestId("library-empty-add-files").click();
      await expect.poll(async () => (await asked()).length).toBe(4);
      await expect(window.getByTestId("library-count")).toHaveText("1");
      await expect(library).toHaveCount(0);
      await expect(window.getByTestId("library-document-name")).toHaveText("Regional Revenue");
      await expectReadyDocuments(window, 1);

      // The empty sheet's one: its file's own app is asked to open the file.
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
