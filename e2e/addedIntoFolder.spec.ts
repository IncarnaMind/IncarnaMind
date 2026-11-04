import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { EVENT_CHANNEL } from "../src/shared/bridge";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
} from "./app";

/*
 * A Document added into a Folder shows in that Folder from the start, never under Not in a Folder
 * on the way: that section coming and going moved a sidebar scrolled to its end by 40 px (#1741).
 * Here the window hears the core's news a little late, each message 60 ms after the one before and
 * in the order it was sent, as on a busy machine.
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

const FOLDER = "Harbour project";

/** From now on each of the core's events reaches the window `gap` ms after the one before it. */
function hearEventsLate(app: ElectronApplication, gap: number): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow }, { channel, gap }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        const contents = window.webContents;
        const send = contents.send.bind(contents);
        let last = 0;
        contents.send = (sent: string, ...args: unknown[]) => {
          if (sent !== channel) return send(sent, ...args);
          const at = Math.max(Date.now(), last + gap);
          last = at;
          setTimeout(() => {
            if (!contents.isDestroyed()) send(sent, ...args);
          }, at - Date.now());
        };
      }
    },
    { channel: EVENT_CHANNEL, gap },
  );
}

/** Notes from now on whether Not in a Folder ever shows in the sidebar; `notInFolderShown` reads it. */
const watchNotInFolder = (window: Page) =>
  window.evaluate(() => {
    const seen = { shown: false };
    (globalThis as unknown as { notInFolder: typeof seen }).notInFolder = seen;
    const look = () => {
      if (document.querySelector('[data-testid="not-in-a-folder-section"]')) seen.shown = true;
    };
    look();
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true });
  });

const notInFolderShown = (window: Page) =>
  window.evaluate(
    () => (globalThis as unknown as { notInFolder: { shown: boolean } }).notInFolder.shown,
  );

async function textFile(name: string): Promise<string> {
  const path = join(sources, `${name}.md`);
  await writeFile(path, `${name}: the harbour project's figures.\n`);
  return path;
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element has no box.");
  return box;
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Document added into a Folder shows in it from the start, never under Not in a Folder, and a sidebar scrolled to its end stays put (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1100, 900);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      const first = await textFile("Supply contract");
      const folderId = await (await coreOf(window)).evaluate(
        async (core: CoreBridge, { name, path }) => {
          const folder = await core.createLibraryGroup({ name, description: "" });
          for (let index = 1; index <= 30; index++) {
            await core.createMind({ title: `Matter note ${index}`, folderId: folder.id });
          }
          await core.addDocuments([path], { groupId: folder.id });
          return folder.id;
        },
        { name: FOLDER, path: first },
      );
      const folder = sidebarFolder(window, FOLDER);
      const folderRow = folder.getByTestId("folder-row");
      if ((await folderRow.getAttribute("aria-expanded")) !== "true") {
        await pointAndClick(window, folderRow);
      }
      await expect(folder).toHaveAttribute("data-count", "1");
      await expect(window.getByTestId("not-in-a-folder-section")).toHaveCount(0);

      // Scrolled to its end with the wheel, as a person does.
      const tree = window.getByTestId("sidebar-tree");
      await pointAt(window, tree);
      await window.mouse.wheel(0, 3000);
      await expect
        .poll(() => tree.evaluate((each) => each.scrollHeight - each.clientHeight - each.scrollTop))
        .toBeLessThanOrEqual(1);
      const before = await boxOf(folderRow);

      await hearEventsLate(app, 60);
      await watchNotInFolder(window);
      const added = await textFile("Delivery log");
      await (await coreOf(window)).evaluate(
        async (core: CoreBridge, { path, groupId }) => {
          await core.addDocuments([path], { groupId });
        },
        { path: added, groupId: folderId },
      );
      await expect(
        folder.getByTestId("document-list-item").filter({ hasText: "Delivery log" }),
      ).toHaveCount(1);
      await expect(folder).toHaveAttribute("data-count", "2");
      expect(await notInFolderShown(window)).toBe(false);
      const after = await boxOf(folderRow);
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);

      // A Document added outside any Folder does show under Not in a Folder, and is seen to.
      const loose = await textFile("Draft brief");
      await (await coreOf(window)).evaluate(async (core: CoreBridge, path) => {
        await core.addDocuments([path]);
      }, loose);
      await expect(
        window
          .getByTestId("not-in-a-folder-section")
          .getByTestId("document-list-item")
          .filter({ hasText: "Draft brief" }),
      ).toHaveCount(1);
      expect(await notInFolderShown(window)).toBe(true);
    } finally {
      await app.close();
    }
  });
}
