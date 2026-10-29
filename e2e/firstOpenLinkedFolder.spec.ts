import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  confirmLink,
  createDataFolder,
  interceptOpenDialog,
  launchApp,
  linkedFolderRow,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * A folder linked on the first open is never silent (#763). The quiet first open keeps the
 * sidebar's Folders away until the User's first Document of their own, so a folder with nothing
 * to read has no row to show there: the first step says it was linked, that there is nothing to
 * read in it yet, and where it will appear. With a Document of the User's own, the section and
 * its row come, as the line said they would.
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

const WORDS = {
  en: {
    section: "Folders on disk",
    noFiles: "No supported files yet. Files added later are read.",
    showSidebar: "Show Sidebar",
  },
  "zh-CN": {
    section: "磁盘上的文件夹",
    noFiles: "还没有支持的文件。之后放进去的文件会自动读取。",
    showSidebar: "显示侧边栏",
  },
} as const;

/** The paths of every Linked folder the core has, through the bridge. */
const linkedPaths = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listLinkedFolders()).map((each) => each.path);
  });

for (const language of ["en", "zh-CN"] as const) {
  test(`a folder linked on the first open with nothing to read says where it will appear (${language})`, async () => {
    test.setTimeout(180_000);
    const words = WORDS[language];
    const folder = join(sources, "contracts");
    await mkdir(folder, { recursive: true });
    const linkedPath = await realpath(folder);
    const { app, window } = await launchApp(dataDir, { examples: true });
    await setWindowSize(app, window, 900, 700);
    await setLanguage(window, language);
    const steps = window.getByTestId("first-open-steps");
    await expect(steps).toBeVisible();
    const panel = window.getByTestId("sidebar-panel");
    await window.getByTestId("sidebar-toggle").click();
    await expect(panel).toHaveAttribute("data-hidden", "true");

    await interceptOpenDialog(app, folder);
    await steps.getByTestId("first-open-link-folder").click();
    const dialog = window.getByTestId("link-folder-dialog");
    await expect(dialog.getByTestId("link-folder-files")).toHaveText(words.noFiles);
    await confirmLink(dialog);

    // The core saved the folder, though the sidebar has nothing of it to show yet.
    await expect.poll(() => linkedPaths(window)).toContain(linkedPath);
    const said = steps.getByTestId("first-open-linked-folder");
    await expect(said).toBeVisible();
    await expect(said).toBeInViewport();
    await expect(said).toContainText("contracts");
    await expect(said).toContainText(words.section);
    await expect(panel).toHaveAttribute("data-hidden", "true");
    await expect(window.getByTestId("linked-folders-section")).toHaveCount(0);

    // Its first Document of the User's own: the section and its row come, and the line goes.
    await writeFile(join(folder, "Lease.txt"), "The lease term is five years.\n");
    await expect(said).toHaveCount(0, { timeout: 30_000 });
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(words.showSidebar);
    await window.keyboard.press("Enter");
    await expect(panel).not.toHaveAttribute("data-hidden", "true");
    const section = window.getByTestId("linked-folders-section");
    await expect(section.getByTestId("linked-folders-section-heading")).toHaveText(words.section);
    await expect(linkedFolderRow(window, "contracts")).toBeInViewport({ timeout: 15_000 });
    await app.close();
  });
}

test("a folder linked on the first open that holds only files IncarnaMind can't read says so, in English and Chinese", async () => {
  test.setTimeout(180_000);
  const folder = join(sources, "scans");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "Old scan.wps"), "Not a format IncarnaMind reads.\n");
  const linkedPath = await realpath(folder);
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 900, 700);
  await setLanguage(window, "en");
  const steps = window.getByTestId("first-open-steps");
  await expect(steps).toBeVisible();
  const panel = window.getByTestId("sidebar-panel");
  await window.getByTestId("sidebar-toggle").click();
  await expect(panel).toHaveAttribute("data-hidden", "true");

  await interceptOpenDialog(app, folder);
  await steps.getByTestId("first-open-link-folder").click();
  const dialog = window.getByTestId("link-folder-dialog");
  await expect(dialog.getByTestId("link-folder-files")).toHaveText(WORDS.en.noFiles);
  await confirmLink(dialog);

  await expect.poll(() => linkedPaths(window)).toContain(linkedPath);
  const said = steps.getByTestId("first-open-linked-folder");
  await expect(said).toBeVisible();
  await expect(said).toBeInViewport();
  await expect(said).toContainText("scans");
  await expect(said).toContainText(WORDS.en.section);
  await expect(window.getByTestId("linked-folders-section")).toHaveCount(0);

  await setLanguage(window, "zh-CN");
  await expect(said).toContainText(WORDS["zh-CN"].section);
  await expect(said).toContainText("scans");
  await expect(panel).toHaveAttribute("data-hidden", "true");
  await app.close();
});
