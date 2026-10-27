import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import {
  confirmLink,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  interceptOpenDialog,
  launchApp,
  leaveText,
  linkedFolderRow,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Add Documents… (⌘O, Ctrl+O) and Link a folder… are commands: ⌘K finds them by name and, in
 * Chinese, by pinyin; ⌘O runs Add Documents… from a Mind, the sidebar and the Library, and does
 * nothing while the focus is in text; the Library's Add menu and the File menu show the same
 * keys and run the same commands. The system's open dialog is stubbed, as in the other specs.
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

const palette = (window: Page) => window.getByTestId("palette");
const KEYS = /⌘O|Ctrl\+O/;

async function writeSource(name: string): Promise<string> {
  const path = join(sources, name);
  await writeFile(path, `${name} notes.\n`);
  return path;
}

async function writeFolder(name: string): Promise<string> {
  const path = join(sources, name);
  await mkdir(path);
  await writeFile(join(path, "Rates.txt"), "Cold-chain rates.\n");
  return path;
}

async function countPickers(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const asked = { count: 0 };
    (globalThis as { pickersAsked?: typeof asked }).pickersAsked = asked;
    dialog.showOpenDialog = (async () => {
      asked.count += 1;
      return { canceled: true, filePaths: [] };
    }) as unknown as typeof dialog.showOpenDialog;
  });
}

const pickersAsked = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { pickersAsked?: { count: number } }).pickersAsked?.count ?? 0);

/** Whether the page takes ⌘O where the focus is, as macOS needs so its menu doesn't run the command from the text. */
const takesKeys = (window: Page) =>
  window.evaluate(() => {
    const mac = /Mac/.test(navigator.platform);
    const event = new KeyboardEvent("keydown", {
      key: "o",
      code: "KeyO",
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
      cancelable: true,
    });
    document.activeElement?.dispatchEvent(event);
    return event.defaultPrevented;
  });

async function openPalette(window: Page, query: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(query);
}

const commandItem = (window: Page, id: string) =>
  palette(window).locator(`[data-key="command:${id}"]`);

const documentItems = (window: Page, name: string) =>
  window.getByTestId("document-list-item").filter({ hasText: name });

test("⌘K finds Add Documents… and Link a folder… by name, and each opens what its button opens", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);

    await interceptOpenDialog(app, await writeSource("Tides.txt"));
    await openPalette(window, "add documents");
    const add = commandItem(window, "documents.add");
    await expect(add).toContainText("Add Documents…");
    await expect(add).toContainText(KEYS);
    await window.keyboard.press("Enter");
    await expect(palette(window)).toBeHidden();
    await expect(documentItems(window, "Tides")).toHaveCount(1);

    await interceptOpenDialog(app, await writeFolder("Carriers"));
    await openPalette(window, "link a folder");
    await expect(commandItem(window, "linkedFolder.add")).toContainText("Link a folder…");
    await window.keyboard.press("Enter");
    const dialog = window.getByTestId("link-folder-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("link-folder-files")).toBeVisible();
    await confirmLink(dialog);
    await expect(linkedFolderRow(window, "Carriers")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("in Chinese ⌘K finds them by pinyin and by its initials, and each opens what its button opens", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await setLanguage(window, "zh-CN");

    await interceptOpenDialog(app, await writeSource("Tides.txt"));
    await openPalette(window, "tianjiawendang");
    await expect(commandItem(window, "documents.add")).toContainText("添加文档…");
    await window.keyboard.press("Enter");
    await expect(palette(window)).toBeHidden();
    await expect(documentItems(window, "Tides")).toHaveCount(1);

    await interceptOpenDialog(app, await writeFolder("Carriers"));
    await openPalette(window, "tjglwjj");
    await expect(commandItem(window, "linkedFolder.add")).toContainText("添加关联文件夹…");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("link-folder-dialog")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("⌘O opens the picker from the sidebar, a Mind and the Library, and does nothing in a text field", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await countPickers(app);

    await newMind(window);
    await enterContent(window);
    await window.keyboard.press("ControlOrMeta+o");
    expect(await takesKeys(window)).toBe(true);
    expect(await pickersAsked(app)).toBe(0);

    await window.getByTestId("open-library").click();
    await expect(window.getByTestId("library-search")).toBeVisible();
    await window.getByTestId("library-search").click();
    await expect(window.getByTestId("library-search")).toBeFocused();
    await window.keyboard.press("ControlOrMeta+o");
    expect(await takesKeys(window)).toBe(true);
    expect(await pickersAsked(app)).toBe(0);

    await window.getByTestId("library-add-documents").focus();
    await window.keyboard.press("ControlOrMeta+o");
    await expect.poll(() => pickersAsked(app)).toBe(1);

    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+o");
    await expect.poll(() => pickersAsked(app)).toBe(2);

    await pointAndClick(window, window.getByTestId("mind-tab").first());
    await window.keyboard.press("ControlOrMeta+o");
    await expect.poll(() => pickersAsked(app)).toBe(3);
  } finally {
    await app.close();
  }
});

test("⌘O adds the Documents picked", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await interceptOpenDialog(app, await writeSource("Rates.txt"));
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+o");
    await expect(documentItems(window, "Rates")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

for (const { width, language } of [
  { width: 900, language: "en" },
  { width: 1600, language: "zh-CN" },
] as const) {
  test(`the Library's Add menu shows ⌘O beside its first row at ${width}px, in ${language === "en" ? "English" : "Chinese"}, and the row adds Documents`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, 700);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await interceptOpenDialog(app, await writeSource("Tides.txt"));
      await window.getByTestId("open-library").click();

      const add = window.getByTestId("library-add-documents");
      await pointAndClick(window, add);
      const menu = window.getByTestId("library-add-documents-items");
      const row = window.getByTestId("library-add-files");
      await expect(row).toContainText(KEYS);
      const [menuBox, rowBox] = await Promise.all([menu.boundingBox(), row.boundingBox()]);
      if (!menuBox || !rowBox) throw new Error("The menu isn't showing.");
      expect(rowBox.x).toBeGreaterThanOrEqual(menuBox.x);
      expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(menuBox.x + menuBox.width);

      await pointAndClick(window, row);
      await expect(documentItems(window, "Tides")).toHaveCount(1);
    } finally {
      await app.close();
    }
  });
}

test("the File menu has Add Documents… on ⌘O and Link a folder…, no other menu item has ⌘O, and choosing them runs the commands", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    const items = await app.evaluate(({ Menu }) => {
      const found: { path: string; accelerator: string }[] = [];
      const walk = (menu: Electron.Menu, path: string) => {
        for (const item of menu.items) {
          const here = `${path} > ${item.label}`;
          if (item.accelerator) found.push({ path: here, accelerator: String(item.accelerator) });
          if (item.submenu) walk(item.submenu, here);
        }
      };
      const menu = Menu.getApplicationMenu();
      if (menu) walk(menu, "");
      return found;
    });
    const keysOf = (accelerator: string) =>
      accelerator
        .toLowerCase()
        .split("+")
        .map((part) => (part === "commandorcontrol" ? "cmdorctrl" : part))
        .sort()
        .join("+");
    expect(
      items.filter((item) => keysOf(item.accelerator) === "cmdorctrl+o").map((item) => item.path),
    ).toEqual([" > File > Add Documents…"]);

    await interceptOpenDialog(app, await writeSource("Tides.txt"));
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
      file?.submenu?.items.find((item) => item.label === "Add Documents…")?.click();
    });
    await expect(documentItems(window, "Tides")).toHaveCount(1);

    await window.getByTestId("open-library").click();
    await window.getByTestId("library-search").click();
    await expect(window.getByTestId("library-search")).toBeFocused();
    await interceptOpenDialog(app, await writeFolder("Carriers"));
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
      file?.submenu?.items.find((item) => item.label === "Link a folder…")?.click();
    });
    await expect(window.getByTestId("link-folder-dialog")).toBeVisible();
  } finally {
    await app.close();
  }
});
