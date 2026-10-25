import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A long Not in a Folder lists five Documents at first; each "Show N more
 * Documents" doubles what it lists, so the end of 1,731 is a handful of
 * clicks away (#1354).
 */

const COUNT = 1_731;
const FIRST_DOCUMENTS = 5;
const STEPS = [50, 100, 200, 400, 800, 176] as const;

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

test("Show more reaches the end of 1,731 Documents in six clicks, by mouse and by keyboard", async () => {
  test.setTimeout(300_000);
  const paths = await Promise.all(
    Array.from({ length: COUNT }, async (_, index) => {
      const path = join(sources, `Report ${String(index + 1).padStart(4, "0")}.txt`);
      await writeFile(path, `Report ${index + 1}. The harbour handled ${index * 7} tonnes.\n`);
      return path;
    }),
  );
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, "en");
    await dismissChatSetup(window);
    await window.evaluate(async (files) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addDocuments(files);
    }, paths);
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const documents = await (
              globalThis as unknown as { incarnamind: CoreBridge }
            ).incarnamind.listDocuments();
            return documents.filter((each) => each.status === "ready").length;
          }),
        { timeout: 240_000 },
      )
      .toBe(COUNT);

    const notInAFolder = window.getByTestId("not-in-a-folder");
    await expect(notInAFolder).toHaveAttribute("data-count", String(COUNT));
    const rows = notInAFolder.getByTestId("document-list-item");
    await expect(rows).toHaveCount(FIRST_DOCUMENTS);

    // The row says how many the next click lists, in both languages.
    const more = window.getByTestId("show-more-documents");
    await expect(more).toHaveText(translate("en", "sidebar.showMore", { count: STEPS[0] }));
    await setLanguage(window, "zh-CN");
    await expect(more).toHaveText(translate("zh-CN", "sidebar.showMore", { count: STEPS[0] }));
    await setLanguage(window, "en");
    await expect(more).toHaveText(translate("en", "sidebar.showMore", { count: STEPS[0] }));

    let listed = FIRST_DOCUMENTS;
    for (const [click, step] of STEPS.entries()) {
      await expect(more).toHaveText(translate("en", "sidebar.showMore", { count: step }));
      if (click === 2) {
        await more.focus();
        await window.keyboard.press("Enter");
      } else await pointAndClick(window, more);
      listed += step;
      await expect(rows).toHaveCount(listed, { timeout: 15_000 });
    }

    await expect(more).toHaveCount(0);
    await expect(rows).toHaveCount(COUNT, { timeout: 15_000 });
    await expect(rows.filter({ hasText: "Report 1731" })).toHaveCount(1);
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows.last()).toBeInViewport();
  } finally {
    await app.close();
  }
});
