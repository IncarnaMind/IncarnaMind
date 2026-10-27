import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  linkedFolderRow,
  linkFolderFromSidebar,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * After linking a folder, the sidebar shows where it is (#763): its row in
 * the Linked folders section (关联文件夹), apart from the User's own Folders,
 * in sight and washed for a moment. The two sections never share a name. The
 * row doesn't unfold, and opens the Library.
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
  en: { sections: ["Folders", "Linked folders"], name: "contracts" },
  "zh-CN": { sections: ["文件夹", "关联文件夹"], name: "contracts" },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`a folder just linked is in sight in the Linked folders section, its row washed; it doesn't unfold and opens the Library (${language})`, async () => {
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
    await expect(window.getByTestId("linked-folders-section")).toHaveCount(0);

    await linkFolderFromSidebar(app, window, linked);

    // Its section comes, after the Folders, and the two have two names.
    const section = window.getByTestId("linked-folders-section");
    await expect(section.getByTestId("linked-folders-section-heading")).toHaveText(
      words.sections[1],
    );
    await expect(window.getByTestId("folders-title")).toHaveText(words.sections[0]);
    const row = linkedFolderRow(window, words.name);
    await expect(row).toBeInViewport();
    await expect(row).toHaveAttribute("data-just-linked", "true");
    // A moment later the wash is gone, and the row stays where it was.
    await expect(row).not.toHaveAttribute("data-just-linked", "true", { timeout: 10_000 });
    await expect(row).toBeVisible();

    // Its row doesn't unfold: its files, from its top and its folder, are in Not in a Folder.
    const open = row.getByTestId("linked-folder-open");
    await expect(open).not.toHaveAttribute("aria-expanded");
    await expect(section.getByTestId("document-list-item")).toHaveCount(0);
    await expect(
      window
        .getByTestId("not-in-a-folder")
        .getByTestId("document-list-item")
        .filter({ hasText: /^(Lease|Renewal)/ }),
    ).toHaveCount(2);
    // A click opens the Library, and the row stays one row.
    await open.click();
    await expect(window.getByTestId("library")).toBeVisible();
    await expect(section.getByTestId("folder-item")).toHaveCount(1);
    await app.close();
  });
}
