import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Deleting most of a Library at once (#1349): ⌘A and ⌘⌫ move every Document
 * to Recently deleted in one step, the line says so with Undo, the focus stays
 * in the Library, and ⌘Z brings them all back in one step too: the count goes
 * from 0 to all of them, never through the numbers in between.
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

/** Records each count the Library header shows from now on, in the page. */
const recordCounts = (window: Page) =>
  window.evaluate(() => {
    const seen: string[] = [];
    const library = document.querySelector('[data-testid="library"]');
    const now = () => document.querySelector('[data-testid="library-count"]')?.textContent ?? "";
    let last = now();
    if (library) {
      new MutationObserver(() => {
        if (now() !== last) {
          last = now();
          seen.push(last);
        }
      }).observe(library, { childList: true, characterData: true, subtree: true });
    }
    (globalThis as unknown as { countsSeen: string[] }).countsSeen = seen;
  });
const countsSeen = (window: Page) =>
  window.evaluate(() => (globalThis as unknown as { countsSeen: string[] }).countsSeen);

for (const [language, width, count] of [
  ["en", 1440, 2_000],
  ["zh-CN", 900, 400],
] as const) {
  const shown = count.toLocaleString("en");
  const words = {
    en: {
      deleted: `Moved ${shown} Documents to Recently deleted`,
      selected: `${shown} selected`,
    },
    "zh-CN": { deleted: `已将 ${shown} 个文档移到回收站`, selected: `已选 ${shown} 个` },
  }[language];

  test(`${shown} Documents selected with ⌘A go to Recently deleted in one step, and ⌘Z brings them all back in one (${language}, ${width}px)`, async () => {
    test.setTimeout(300_000);
    for (let at = 0; at < count; at++) {
      await writeFile(
        join(sources, `Note ${at}.md`),
        `# Note ${at}\n\nHarbour tides, note ${at}.\n`,
      );
    }
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, 900);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await window.evaluate(async (path) => {
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addLinkedFolder(
          path,
        );
      }, sources);
      await expect
        .poll(
          () =>
            window.evaluate(
              async () =>
                (
                  await (
                    globalThis as unknown as { incarnamind: CoreBridge }
                  ).incarnamind.listDocuments()
                ).filter((each) => each.status === "ready").length,
            ),
          { timeout: 240_000 },
        )
        .toBe(count);

      await window.getByTestId("open-library").click();
      const library = window.getByTestId("library");
      const total = library.getByTestId("library-count");
      await expect(total).toHaveText(shown);
      await library.getByTestId("library-document").first().locator("[data-row-main]").focus();
      await window.keyboard.press("ControlOrMeta+a");
      await expect(window.getByTestId("library-selection").getByRole("status")).toHaveText(
        words.selected,
      );

      await window.keyboard.press("ControlOrMeta+Backspace");
      await expect(window.getByTestId("undo-line")).toContainText(words.deleted);
      await expect(library.getByTestId("library-document")).toHaveCount(0);
      await expect(library.getByTestId("library-add-documents")).toBeFocused();

      await recordCounts(window);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(total).toHaveText(shown);
      expect(await countsSeen(window)).toEqual([shown]);
    } finally {
      await app.close();
    }
  });
}
