import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  confirmLink,
  createDataFolder,
  dismissChatSetup,
  interceptOpenDialog,
  launchApp,
  linkedFolderRow,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * After linking a folder, the sidebar shows where it is (#763): linking makes its Folder (#3613),
 * in the one list of Folders beside the User's own, in sight, open and washed for a moment, its
 * files in it, sub-folders' too.
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
  en: { folders: "Folders", name: "contracts" },
  "zh-CN": { folders: "文件夹", name: "contracts" },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`a folder just linked reveals the sidebar and is in sight in Folders, its row washed and open with its files (${language})`, async () => {
    test.setTimeout(120_000);
    const words = WORDS[language];
    const linked = join(sources, words.name);
    await mkdir(join(linked, "2026"), { recursive: true });
    await writeFile(join(linked, "Lease.txt"), "The lease term is five years.\n");
    await writeFile(join(linked, "2026", "Renewal.txt"), "The renewal term is two years.\n");
    await writeFile(join(sources, "Own.txt"), "A file of my own.\n");
    const { app, window } = await launchApp(dataDir, { home: sources });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Own.txt")]);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.createLibraryGroup({ name: "Mine", description: "" });
    });
    await expect(window.locator("[data-linked-folder-id]")).toHaveCount(0);
    await window.getByTestId("sidebar-toggle").click();
    const panel = window.getByTestId("sidebar-panel");
    await expect(panel).toHaveAttribute("data-hidden", "true");

    await interceptOpenDialog(app, linked);
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(language === "en" ? "Link a folder" : "添加关联文件夹");
    await window.keyboard.press("Enter");
    const dialog = window.getByTestId("link-folder-dialog");
    await expect(dialog.getByTestId("link-folder-files")).toBeVisible();
    await confirmLink(dialog);

    await expect(panel).not.toHaveAttribute("data-hidden", "true");
    // Its Folder comes in the one list of Folders, beside the User's own, with its mark.
    await expect(window.getByTestId("folders-title")).toHaveText(words.folders);
    const row = linkedFolderRow(window, words.name);
    await expect(row).toBeInViewport();
    await expect(row).toHaveAttribute("data-just-linked", "true");
    await expect(row.getByTestId("folder-bound")).toBeVisible();
    await expect(window.getByTestId("folders-section").getByTestId("library-folder")).toHaveCount(
      2,
    );
    // A moment later the wash is gone, and the row stays where it was.
    await expect(row).not.toHaveAttribute("data-just-linked", "true", { timeout: 10_000 });
    await expect(row).toBeVisible();

    // It is open, its files, from its top and its folder, in it; none in Not in a Folder.
    const folder = window.getByTestId("library-folder").filter({ has: row });
    await expect(row.getByTestId("folder-row")).toHaveAttribute("aria-expanded", "true");
    await expect(
      folder.getByTestId("document-list-item").filter({ hasText: /^(Lease|Renewal)/ }),
    ).toHaveCount(2);
    await expect(
      window
        .getByTestId("not-in-a-folder")
        .getByTestId("document-list-item")
        .filter({ hasText: /^(Lease|Renewal)/ }),
    ).toHaveCount(0);
    await app.close();
  });
}
