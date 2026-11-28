import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setWindowSize,
  sidebarFolder,
  typeWithInputMethod,
} from "./app";

/*
 * In every sidebar list (docs/agents/interaction.md, rules 1 and 6): Enter on
 * a focused Mind, Document or Folder opens it (a Folder unfolds or folds);
 * F2 or a double-click renames it in place; Esc cancels; Enter saves, but not
 * while an input method is composing. Each runs in English and Chinese.
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

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );

const createFolder = (window: Page, name: string) =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.createLibraryGroup({
        name: value,
        description: "",
      }),
    name,
  );

interface Row {
  /** The row's button, which takes the keys. */
  main: Locator;
  /** The row, to find its state in. */
  row: Locator;
  /** The field the name is typed in: while it is there, the row has no name to find it by. */
  field: Locator;
  /** What the row shows now. */
  name: Locator;
}

/** F2 renames and Esc cancels; a double-click renames and Enter saves; an input method's Enter doesn't. */
async function renames(window: Page, find: (name: string) => Row, from: string, to: string) {
  const row = find(from);
  await row.main.focus();
  await window.keyboard.press("F2");
  await expect(row.field).toBeFocused();
  await expect(row.field).toHaveValue(from);
  await window.keyboard.type("Not this");
  await window.keyboard.press("Escape");
  await expect(row.field).toHaveCount(0);
  await expect(row.name).toHaveText(from);
  await expect(row.main).toBeFocused();

  await row.main.dblclick();
  await expect(row.field).toBeFocused();
  await row.field.fill(to);
  await window.keyboard.press("Enter");
  const renamed = find(to);
  await expect(renamed.name).toHaveText(to);
  // The row has the focus again, wherever the new name put it in the list.
  await expect(renamed.main).toBeFocused();
  await expect(renamed.field).toHaveCount(0);

  await renamed.main.focus();
  await window.keyboard.press("F2");
  await expect(renamed.field).toBeFocused();
  await typeWithInputMethod(window, renamed.field, "新名称");
  const final = find("新名称");
  await expect(final.name).toHaveText("新名称");
  await expect(final.main).toBeFocused();
  await expect(final.field).toHaveCount(0);
}

const mindAt =
  (window: Page) =>
  (name: string): Row => {
    const row = window
      .getByTestId("mind-row")
      .filter({ has: window.getByTestId("mind-list-item").filter({ hasText: name }) });
    return {
      main: row.getByTestId("mind-list-item"),
      row,
      field: window.getByTestId("mind-rename"),
      name: row.getByTestId("row-text"),
    };
  };

const documentAt =
  (window: Page) =>
  (name: string): Row => {
    const row = window
      .getByTestId("document-list-item")
      .filter({ has: window.getByTestId("row-text").filter({ hasText: name }) });
    return {
      main: row.getByTestId("open-document"),
      row,
      field: window.getByTestId("document-list-item").locator("input"),
      name: row.getByTestId("row-text"),
    };
  };

const folderAt =
  (window: Page) =>
  (name: string): Row => {
    const row = sidebarFolder(window, name);
    return {
      main: row.getByTestId("folder-row"),
      row,
      field: window.getByTestId("folder-rename-field"),
      name: row.getByTestId("folder-row").getByTestId("row-text"),
    };
  };

for (const language of ["en", "zh-CN"] as const) {
  test(`Enter opens a focused Mind, Document or Folder in the sidebar, and F2 or a double-click renames it (${language})`, async () => {
    await writeFile(join(sources, "Tides.txt"), "Spring tides come twice a month.\n");
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1100, 700);
      await dismissChatSetup(window);
      await addDocuments(window, [join(sources, "Tides.txt")]);
      await createFolder(window, "Ocean");
      await newMind(window);
      await nameMind(window, "Shortlist");
      await newMind(window);
      await nameMind(window, "Notes");
      await setLanguage(window, language);

      // Enter opens a Mind that isn't open, and starts no rename.
      const shortlist = mindAt(window)("Shortlist");
      await expect(shortlist.main).not.toHaveAttribute("aria-current", "page");
      await shortlist.main.focus();
      await window.keyboard.press("Enter");
      await expect(shortlist.main).toHaveAttribute("aria-current", "page");
      await expect(shortlist.field).toHaveCount(0);
      // Nor on the one already open.
      await window.keyboard.press("Enter");
      await expect(shortlist.field).toHaveCount(0);

      // Enter opens a Document in the viewer.
      const tides = documentAt(window)("Tides");
      await tides.main.focus();
      await window.keyboard.press("Enter");
      // Beside the Note, which keeps the focus, as the window has room for two groups.
      await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
      await expect(tides.field).toHaveCount(0);

      // Enter on a Folder unfolds it, and again folds it.
      const ocean = folderAt(window)("Ocean");
      const before = (await ocean.row.getAttribute("data-expanded")) ?? "";
      await ocean.main.focus();
      await window.keyboard.press("Enter");
      await expect(ocean.row).not.toHaveAttribute("data-expanded", before);
      await expect(ocean.field).toHaveCount(0);
      await window.keyboard.press("Enter");
      await expect(ocean.row).toHaveAttribute("data-expanded", before);

      await renames(window, mindAt(window), "Notes", "Reading list");
      await renames(window, documentAt(window), "Tides", "Tide tables");
      await renames(window, folderAt(window), "Ocean", "Seas");
    } finally {
      await app.close();
    }
  });
}
