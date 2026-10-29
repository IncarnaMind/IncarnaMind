import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  confirmLink,
  createDataFolder,
  interceptOpenDialog,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * A folder linked on the first open shows where it is at once (#763): linking one is using
 * Linked folders, so the sidebar's Folders on disk section and its new row come with it, empty
 * or still being read, the row washed like any new item. A folder with nothing IncarnaMind can
 * read says so at its row's end, and a notice under the row says why; a file added to it later
 * is read, and both go.
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
    empty: "Nothing to read yet",
    notice: "No files IncarnaMind can read in “contracts” yet. New ones are read as they arrive.",
    scanNotice: "No files IncarnaMind can read in “scans” yet. New ones are read as they arrive.",
  },
  "zh-CN": {
    section: "磁盘上的文件夹",
    empty: "还没有可读取的文件",
    notice: "“contracts”里还没有 IncarnaMind 能读取的文件。之后放进去的文件会自动读取。",
    scanNotice: "“scans”里还没有 IncarnaMind 能读取的文件。之后放进去的文件会自动读取。",
  },
} as const;

/** The names of every Document the core has, through the bridge. */
const documentNames = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listDocuments()).map((each) => each.name);
  });

/** A Linked folder's row in the sidebar, with the notice that can sit under it. */
const linkedRow = (window: Page, name: string) =>
  window.getByTestId("linked-folder-row").filter({
    has: window.getByTestId("row-text").getByText(name, { exact: true }),
  });

/** Links `folder` from the first step, with the sidebar hidden first: the link opens it again. */
async function linkFromFirstStep(app: ElectronApplication, window: Page, folder: string) {
  const steps = window.getByTestId("first-open-steps");
  await expect(steps).toBeVisible();
  const panel = window.getByTestId("sidebar-panel");
  await window.getByTestId("sidebar-toggle").click();
  await expect(panel).toHaveAttribute("data-hidden", "true");
  await interceptOpenDialog(app, folder);
  await steps.getByTestId("first-open-link-folder").click();
  const dialog = window.getByTestId("link-folder-dialog");
  await expect(dialog.getByTestId("link-folder-files")).toBeVisible({ timeout: 15_000 });
  await confirmLink(dialog);
  // Linking one opened the sidebar again, for the row to be seen.
  await expect(panel).not.toHaveAttribute("data-hidden", "true");
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a folder with nothing to read, linked on the first open, shows its row and says why (${language})`, async () => {
    test.setTimeout(180_000);
    const words = WORDS[language];
    const folder = join(sources, "contracts");
    await mkdir(folder, { recursive: true });
    const { app, window } = await launchApp(dataDir, { examples: true });
    await setWindowSize(app, window, 900, 700);
    await setLanguage(window, language);
    await linkFromFirstStep(app, window, folder);

    // The section and its row came with the link, the row washed as any new item is.
    const row = linkedRow(window, "contracts");
    const item = row.getByTestId("folder-item");
    await expect(item).toHaveAttribute("data-just-linked", "true");
    await expect(item).toBeInViewport();
    const section = window.getByTestId("linked-folders-section");
    await expect(section.getByTestId("linked-folders-section-heading")).toHaveText(words.section);
    // Its own folder only: the example's stays with the example's Note.
    await expect(section.getByTestId("folder-item")).toHaveCount(1);

    // Its end says its state, its tooltip names the kinds it reads, and the notice is under it.
    const status = item.getByTestId("folder-status");
    await expect(status).toHaveAttribute("data-state", "empty", { timeout: 15_000 });
    await expect(status).toHaveText(new RegExp(`^${words.empty}`));
    await expect(status).toHaveAttribute("title", /PDF/);
    const notice = row.getByTestId("linked-folder-nothing-to-read");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(words.notice);

    // A file added there later is read: the notice and the state go.
    await writeFile(join(folder, "Lease.txt"), "The lease term is five years.\n");
    await expect(notice).toHaveCount(0, { timeout: 30_000 });
    await expect(status).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => documentNames(window)).toContain("Lease");
    await expect(item).toBeVisible();
    await app.close();
  });
}

test("a folder holding only files IncarnaMind can't read says so under its row, in English and Chinese", async () => {
  test.setTimeout(180_000);
  const folder = join(sources, "scans");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "Old scan.wps"), "Not a format IncarnaMind reads.\n");
  const { app, window } = await launchApp(dataDir, { examples: true });
  await setWindowSize(app, window, 900, 700);
  await setLanguage(window, "en");
  await linkFromFirstStep(app, window, folder);

  const row = linkedRow(window, "scans");
  const item = row.getByTestId("folder-item");
  await expect(item).toHaveAttribute("data-just-linked", "true");
  await expect(item).toBeInViewport();
  const status = item.getByTestId("folder-status");
  await expect(status).toHaveAttribute("data-state", "empty", { timeout: 15_000 });
  await expect(status).toHaveText(new RegExp(`^${WORDS.en.empty}`));
  const notice = row.getByTestId("linked-folder-nothing-to-read");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(WORDS.en.scanNotice);
  await expect(window.getByTestId("linked-folders-section-heading")).toHaveText(WORDS.en.section);

  await setLanguage(window, "zh-CN");
  await expect(window.getByTestId("linked-folders-section-heading")).toHaveText(
    WORDS["zh-CN"].section,
  );
  await expect(status).toHaveText(new RegExp(`^${WORDS["zh-CN"].empty}`));
  await expect(notice).toHaveText(WORDS["zh-CN"].scanNotice);
  await expect(item).toBeVisible();
  await app.close();
});
