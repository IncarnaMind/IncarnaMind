import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  controlReads,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * A change made from a Library row lands a round trip after the key, and the focus goes on from
 * the row only if the User hasn't put it somewhere else meanwhile (#1741): ⌘⌫ hands it to the
 * next row, Move to… to the row in the Folder it went to. Each core call is held, so the User
 * clicks the search before it lands, at a person's pace; then, held again with nothing else
 * focused, the focus goes on as before.
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

const NAMES = ["Budget", "Ledger", "Survey", "Minutes"];

/** Four loose Documents and an empty Folder, Archive, in the Library's page; and Archive's id. */
async function openSeededLibrary(
  app: ElectronApplication,
  window: Page,
): Promise<{ library: Locator; archiveId: string }> {
  await setWindowSize(app, window, 1200, 800);
  await dismissChatSetup(window);
  const paths = NAMES.map((name) => join(sources, `${name}.txt`));
  for (const [at, name] of NAMES.entries()) {
    await writeFile(paths[at] as string, `${name}: the harbour project's figures.\n`);
  }
  const archiveId = await (await coreOf(window)).evaluate(async (core: CoreBridge, input) => {
    const archive = await core.createLibraryGroup({ name: "Archive", description: "" });
    await core.addDocuments(input);
    return archive.id;
  }, paths);
  await pointAndClick(window, window.getByTestId("open-library"));
  const library = window.getByTestId("library");
  await expect(library.getByTestId("library-document")).toHaveCount(NAMES.length);
  return { library, archiveId };
}

const rowNamed = (library: Locator, name: string): Locator =>
  library.getByTestId("library-document").filter({
    has: library.page().getByTestId("library-document-name").getByText(name, { exact: true }),
  });

/** The names of the loose Documents, top to bottom, as the page shows them: two at least. */
async function looseNames(library: Locator): Promise<[string, string, ...string[]]> {
  const [first, second, ...rest] = await library
    .locator('[data-testid="library-section"][data-section="not-in-a-folder"]')
    .getByTestId("library-document-name")
    .allTextContents();
  if (first === undefined || second === undefined) {
    throw new Error("Fewer than two loose Documents show.");
  }
  return [first, second, ...rest];
}

test("⌘⌫ on a Library row leaves the focus where the User put it while the delete landed, and otherwise hands it to the next row", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    const { library } = await openSeededLibrary(app, window);
    const search = library.getByTestId("library-search");
    const undoLine = window.getByTestId("undo-line");

    const [first] = await looseNames(library);
    await controlReads(app, "core:deleteDocuments", { hold: 1 });
    await rowNamed(library, first).locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+Backspace");
    await pointAndClick(window, search);
    await expect(search).toBeFocused();
    // Held, the delete hasn't landed: the row is still there.
    await expect(rowNamed(library, first)).toHaveCount(1);
    await controlReads(app, "core:deleteDocuments", { settle: "resolve" });
    await expect(undoLine).toContainText(`Moved “${first}” to Recently deleted`);
    await expect(rowNamed(library, first)).toHaveCount(0);
    await expect(search).toBeFocused();

    const [next, after] = await looseNames(library);
    await controlReads(app, "core:deleteDocuments", { hold: 1 });
    await rowNamed(library, next).locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+Backspace");
    await expect(rowNamed(library, next)).toHaveCount(1);
    await controlReads(app, "core:deleteDocuments", { settle: "resolve" });
    await expect(undoLine).toContainText(`Moved “${next}” to Recently deleted`);
    await expect(rowNamed(library, next)).toHaveCount(0);
    await expect(rowNamed(library, after).locator("[data-row-main]")).toBeFocused();
  } finally {
    await app.close();
  }
});

test("Move to… from a Library row leaves the focus where the User put it while the move landed, and otherwise takes it to the row in its Folder", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    const { library, archiveId } = await openSeededLibrary(app, window);
    const search = library.getByTestId("library-search");
    const undoLine = window.getByTestId("undo-line");
    const picker = window.getByTestId("move-to-picker");
    const archive = library.locator(`[data-testid="library-section"][data-section="${archiveId}"]`);
    const moveToArchive = async (name: string) => {
      await rowNamed(library, name).locator("[data-row-main]").first().focus();
      await window.keyboard.press("ControlOrMeta+Shift+M");
      await expect(picker.getByTestId("move-to-search")).toBeFocused();
      await window.keyboard.type("Archive");
      await expect(
        picker.locator('[data-testid="move-to-option"][aria-selected="true"]'),
      ).toContainText("Archive");
      await window.keyboard.press("Enter");
    };

    const [first, second] = await looseNames(library);
    await controlReads(app, "core:moveToFolder", { hold: 1 });
    await moveToArchive(first);
    await pointAndClick(window, search);
    await expect(search).toBeFocused();
    await controlReads(app, "core:moveToFolder", { settle: "resolve" });
    await expect(undoLine).toContainText(`Moved “${first}” to Archive`);
    await expect(rowNamed(archive, first)).toHaveCount(1);
    await expect(search).toBeFocused();

    await controlReads(app, "core:moveToFolder", { hold: 1 });
    await moveToArchive(second);
    await controlReads(app, "core:moveToFolder", { settle: "resolve" });
    await expect(undoLine).toContainText(`Moved “${second}” to Archive`);
    await expect(rowNamed(archive, second).locator("[data-row-main]")).toBeFocused();
  } finally {
    await app.close();
  }
});
