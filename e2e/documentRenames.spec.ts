import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * Twenty Documents renamed in a row in the Library, each by F2, all land and are still there
 * when the app opens again: on Node 26, every write from about the eighth rename failed (#1289).
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

const COUNT = 20;

const rowNamed = (library: Locator, name: string) =>
  library.getByTestId("library-document").filter({
    has: library.page().getByTestId("library-document-name").getByText(name, { exact: true }),
  });

test("renaming 20 Documents in a row: each lands, and they keep their names", async () => {
  test.setTimeout(120_000);
  const paths = await Promise.all(
    Array.from({ length: COUNT }, async (_, index) => {
      const path = join(sources, `report-${index + 1}.txt`);
      await writeFile(path, `Report ${index + 1}. The harbour handled ${index * 7} tonnes.\n`);
      return path;
    }),
  );
  const first = await launchApp(dataDir);
  await setWindowSize(first.app, first.window, 1440, 900);
  await dismissChatSetup(first.window);
  await addDocuments(first.window, paths);
  await pointAndClick(first.window, first.window.getByTestId("open-library"));
  const library = first.window.getByTestId("library");
  await pointAndClick(first.window, library.getByTestId("library-show-all"));
  await expect(library.getByTestId("library-document")).toHaveCount(COUNT);

  for (let index = 1; index <= COUNT; index++) {
    const row = rowNamed(library, `report-${index}`);
    await row.locator("[data-row-main]").focus();
    await first.window.keyboard.press("F2");
    await library
      .getByRole("textbox", { name: `New name for report-${index}`, exact: true })
      .fill(`Harbour report ${index}`);
    await first.window.keyboard.press("Enter");
    await expect(rowNamed(library, `Harbour report ${index}`)).toHaveCount(1);
  }
  await expect(first.window.getByTestId("error-notice")).toHaveCount(0);
  await first.app.close();

  const again = await launchApp(dataDir);
  try {
    await setWindowSize(again.app, again.window, 1440, 900);
    await pointAndClick(again.window, again.window.getByTestId("open-library"));
    const reopened = again.window.getByTestId("library");
    await pointAndClick(again.window, reopened.getByTestId("library-show-all"));
    const names = reopened.getByTestId("library-document-name");
    await expect(names).toHaveCount(COUNT);
    expect((await names.allInnerTexts()).sort()).toEqual(
      Array.from({ length: COUNT }, (_, index) => `Harbour report ${index + 1}`).sort(),
    );
  } finally {
    await again.app.close();
  }
});
