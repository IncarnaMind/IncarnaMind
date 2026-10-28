import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
} from "./app";

/*
 * New Folder (⇧⌘N, Ctrl+Shift+N) makes "Untitled Folder" in the sidebar's tree
 * with its name field open in its row: Enter keeps what is typed, Esc keeps
 * "Untitled Folder", ⌘Z takes it all back. New Folder with these makes the
 * Folder with the chosen Documents (and Minds) in it, in one step to undo;
 * a Folder something was filed in since is kept, and the line says so.
 * Each is checked in the core, through the bridge. Set INCARNAMIND_SCREENSHOTS
 * to a folder to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

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

async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const nameField = (window: Page) => window.getByTestId("folder-rename-field");
const undoMessage = (window: Page) => window.getByTestId("undo-line").getByTestId("undo-message");

const folderNames = async (window: Page) =>
  (await (await coreOf(window)).evaluate((core) => core.getLibrary())).groups
    .map((group) => group.name)
    .sort();

/** The Folder each Document is filed in, by name (null: Not in a Folder), as the core has it. */
async function filedIn(window: Page, names: string[]): Promise<(string | null)[]> {
  const ids = await Promise.all(names.map((name) => documentIdOf(window, name)));
  return (await coreOf(window)).evaluate(async (core, documentIds) => {
    const library = await core.getLibrary();
    return documentIds.map((id) => {
      const groupId = library.assignments.find((each) => each.documentId === id)?.groupId ?? null;
      return library.groups.find((group) => group.id === groupId)?.name ?? null;
    });
  }, ids);
}

async function writeTexts(...names: string[]): Promise<string[]> {
  return Promise.all(
    names.map(async (name) => {
      const path = join(sources, `${name}.txt`);
      await writeFile(path, `${name} notes.\n`);
      return path;
    }),
  );
}

/** Types a name through an input method: its candidate's Enter changes nothing, the next Enter saves. */
async function typeWithInputMethod(window: Page, field: Locator, name: string): Promise<void> {
  const session = await window.context().newCDPSession(window);
  try {
    await session.send("Input.imeSetComposition", {
      text: "dierzhang",
      selectionStart: 9,
      selectionEnd: 9,
    });
    await field.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
    await expect(field).toBeVisible();
    await session.send("Input.insertText", { text: name });
    await expect(field).toHaveValue(name);
  } finally {
    await session.detach();
  }
  await window.keyboard.press("Enter");
}

test("⇧⌘N makes “Untitled Folder” with its name open in the tree: Enter keeps a typed name, Esc keeps “Untitled Folder”, ⌘Z removes it", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    const field = nameField(window);

    // Type a name and press Enter: it is the Folder's name, and the line says what was made.
    await window.keyboard.press("ControlOrMeta+Shift+n");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Untitled Folder");
    await window.keyboard.type("Finance");
    await window.keyboard.press("Enter");
    await expect(field).toHaveCount(0);
    await expect(sidebarFolder(window, "Finance")).toHaveCount(1);
    await expect.poll(() => folderNames(window)).toEqual(["Finance"]);
    await expect(undoMessage(window)).toHaveText("Made “Finance”");
    await expect(window.getByRole("dialog")).toHaveCount(0);

    // ⌘Z removes it, naming and all; ⇧⌘Z brings it back with its name.
    await window.keyboard.press("ControlOrMeta+z");
    await expect(sidebarFolder(window, "Finance")).toHaveCount(0);
    await expect.poll(() => folderNames(window)).toEqual([]);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(sidebarFolder(window, "Finance")).toHaveCount(1);
    await expect.poll(() => folderNames(window)).toEqual(["Finance"]);

    // Esc keeps the name it was made with, and what was typed is dropped.
    await window.keyboard.press("ControlOrMeta+Shift+n");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Untitled Folder");
    await window.keyboard.type("Not kept");
    await window.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(sidebarFolder(window, "Untitled Folder")).toHaveCount(1);
    await expect.poll(() => folderNames(window)).toEqual(["Finance", "Untitled Folder"]);
    await expect(undoMessage(window)).toHaveText("Made “Untitled Folder”");

    // ⌘Z removes that one, and Finance stays.
    await window.keyboard.press("ControlOrMeta+z");
    await expect(sidebarFolder(window, "Untitled Folder")).toHaveCount(0);
    await expect.poll(() => folderNames(window)).toEqual(["Finance"]);
  } finally {
    await app.close();
  }
});

test("the + menu and a Folder's ⋯ make one too, and show the keys", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    const field = nameField(window);

    await pointAndClick(window, window.getByTestId("plus-menu"));
    const item = window.getByTestId("plus-new-folder");
    await expect(item).toContainText("New Folder");
    await expect(item).toContainText(/⇧⌘N|Ctrl\+Shift\+N/);
    await pointAndClick(window, item);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Untitled Folder");
    await window.keyboard.type("Reading");
    await window.keyboard.press("Enter");
    await expect(sidebarFolder(window, "Reading")).toHaveCount(1);

    // The Folder's ⋯ has it after "New note here": the new Folder is a Folder of its own.
    const reading = sidebarFolder(window, "Reading");
    await reading.getByTestId("folder-row").hover();
    await pointAndClick(window, reading.getByTestId("folder-menu"));
    const entry = window.getByTestId("folder.new");
    await expect(entry).toContainText("New Folder");
    await expect(entry).toContainText(/⇧⌘N|Ctrl\+Shift\+N/);
    await pointAndClick(window, entry);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Untitled Folder");
    await window.keyboard.press("Escape");
    await expect.poll(() => folderNames(window)).toEqual(["Reading", "Untitled Folder"]);
  } finally {
    await app.close();
  }
});

test("a blank name changes nothing, a name another Folder has is said in a line, and a second new Folder is numbered", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    const field = nameField(window);
    await (await coreOf(window)).evaluate((core) =>
      core.createLibraryGroup({ name: "Finance", description: "" }),
    );

    await window.keyboard.press("ControlOrMeta+Shift+n");
    await expect(field).toBeFocused();
    await window.keyboard.type("   ");
    await window.keyboard.press("Enter");
    await expect(field).toHaveCount(0);
    await expect(sidebarFolder(window, "Untitled Folder")).toHaveCount(1);

    // Finance is taken, whatever its case: the Folder keeps the name it has.
    await window.keyboard.press("ControlOrMeta+Shift+n");
    await expect(field).toHaveValue("Untitled Folder 2");
    await window.keyboard.type("finance");
    await window.keyboard.press("Enter");
    await expect(window.getByRole("alert")).toContainText("already exists");
    await expect(sidebarFolder(window, "Untitled Folder 2")).toHaveCount(1);
    await expect
      .poll(() => folderNames(window))
      .toEqual(["Finance", "Untitled Folder", "Untitled Folder 2"]);
  } finally {
    await app.close();
  }
});

test("New Folder with these puts the Documents selected in the Library in the new Folder, named in place; one ⌘Z puts them back and removes it", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await addDocuments(window, await writeTexts("Chen 2019", "Taha 1997", "Leeds July", "Other"));
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    const row = (name: string) => library.getByTestId("library-document").filter({ hasText: name });
    for (const name of ["Chen 2019", "Taha 1997", "Leeds July"]) {
      await pointAndClick(window, row(name).getByTestId("library-select"));
    }
    const bar = library.getByTestId("library-selection");
    await expect(bar).toContainText("3 selected");

    // A checked row's ⋯ offers it for all three.
    await row("Chen 2019").hover();
    await pointAndClick(window, row("Chen 2019").getByTestId("document-file-menu"));
    await expect(window.getByTestId("folder.newWith")).toHaveText(/New Folder with 3 Documents/);
    await window.keyboard.press("Escape");

    // The selection bar's ⋯ is the selection's menu.
    await pointAndClick(window, bar.getByTestId("document-file-menu"));
    await expect(window.getByTestId("folder.newWith")).toHaveText(/New Folder with 3 Documents/);
    await pointAndClick(window, window.getByTestId("folder.newWith"));
    const field = nameField(window);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Untitled Folder");
    // The three are in it already, as the name is typed; the selection is spent.
    const folder = window.getByTestId("library-folder").filter({ has: field });
    await expect(folder).toHaveAttribute("data-count", "3");
    await expect(bar).toHaveCount(0);
    await window.keyboard.type("Chapter 2 sources");
    await window.keyboard.press("Enter");
    await expect(sidebarFolder(window, "Chapter 2 sources")).toHaveAttribute("data-count", "3");
    expect(await filedIn(window, ["Chen 2019", "Taha 1997", "Leeds July", "Other"])).toEqual([
      "Chapter 2 sources",
      "Chapter 2 sources",
      "Chapter 2 sources",
      null,
    ]);
    await expect(undoMessage(window)).toHaveText("Made “Chapter 2 sources” with 3 Documents");

    // One ⌘Z: the three are back where they were, and the Folder is gone.
    await window.keyboard.press("ControlOrMeta+z");
    await expect(sidebarFolder(window, "Chapter 2 sources")).toHaveCount(0);
    expect(await filedIn(window, ["Chen 2019", "Taha 1997", "Leeds July", "Other"])).toEqual([
      null,
      null,
      null,
      null,
    ]);
    await expect.poll(() => folderNames(window)).toEqual([]);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(sidebarFolder(window, "Chapter 2 sources")).toHaveAttribute("data-count", "3");
  } finally {
    await app.close();
  }
});

test("a Document another window filed in the new Folder since keeps it when its making is undone, and the line says so, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await addDocuments(window, await writeTexts("Chen 2019", "Taha 1997"));
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    const row = (name: string) => library.getByTestId("library-document").filter({ hasText: name });
    const field = nameField(window);

    // The Folder is made with the first Document in it.
    await pointAndClick(window, row("Chen 2019").getByTestId("library-select"));
    await pointAndClick(
      window,
      library.getByTestId("library-selection").getByTestId("document-file-menu"),
    );
    await pointAndClick(window, window.getByTestId("folder.newWith"));
    await expect(field).toBeFocused();
    await window.keyboard.type("Chapter 2 sources");
    await window.keyboard.press("Enter");
    await expect(sidebarFolder(window, "Chapter 2 sources")).toHaveAttribute("data-count", "1");

    // Another window files the second in it after it was made: that work is not this step's to take back.
    const taha = await documentIdOf(window, "Taha 1997");
    const fileIn = (folderName: string, id: string) =>
      coreOf(window).then((core) =>
        core.evaluate(
          async (bridge, [name, documentId]) => {
            const library = await bridge.getLibrary();
            const folder = library.groups.find((each) => each.name === name);
            if (!folder) throw new Error("The Folder isn't there.");
            await bridge.moveToFolder({ documentIds: [documentId], folderId: folder.id });
          },
          [folderName, id] as const,
        ),
      );
    await fileIn("Chapter 2 sources", taha);
    await expect(sidebarFolder(window, "Chapter 2 sources")).toHaveAttribute("data-count", "2");

    // ⌘Z: the Folder stays with what was filed in it since, and the Document it was made with goes back.
    await window.keyboard.press("ControlOrMeta+z");
    await expect(sidebarFolder(window, "Chapter 2 sources")).toHaveAttribute("data-count", "1");
    expect(await filedIn(window, ["Chen 2019", "Taha 1997"])).toEqual([null, "Chapter 2 sources"]);
    await expect(window.getByTestId("undo-note")).toHaveText(
      "Kept the Folder “Chapter 2 sources”: you’ve filed things in it since.",
    );

    // In Chinese, a Folder made and named in Chinese.
    await setLanguage(window, "zh-CN");
    await pointAndClick(window, row("Chen 2019").getByTestId("library-select"));
    await pointAndClick(
      window,
      library.getByTestId("library-selection").getByTestId("document-file-menu"),
    );
    await pointAndClick(window, window.getByTestId("folder.newWith"));
    await expect(field).toBeFocused();
    await typeWithInputMethod(window, field, "第二章资料");
    await expect(sidebarFolder(window, "第二章资料")).toHaveAttribute("data-count", "1");
    await fileIn("第二章资料", taha);
    await expect(sidebarFolder(window, "第二章资料")).toHaveAttribute("data-count", "2");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(sidebarFolder(window, "第二章资料")).toHaveAttribute("data-count", "1");
    await expect(window.getByTestId("undo-note")).toHaveText(
      "保留了文件夹“第二章资料”：之后你在里面放了其他内容。",
    );
  } finally {
    await app.close();
  }
});

test("⌃⌘N on a selected row does the same for the whole selection, in the sidebar and in the Library, and does nothing off a row", async () => {
  test.skip(process.platform !== "darwin", "⌃⌘N is Finder's chord, and macOS only has it");
  const { app, window } = await launchApp(dataDir);
  try {
    // Wide enough for a Document opened from the Library to sit beside it.
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    await addDocuments(window, await writeTexts("Alpha", "Beta", "Gamma", "Delta"));
    // Off a row, the chord does nothing.
    await window.keyboard.press("Control+Meta+n");
    await expect.poll(() => folderNames(window)).toEqual([]);

    // The sidebar's selection: a click selects and opens, ⌘-click adds.
    const sidebarRow = (name: string) =>
      window
        .getByTestId("sidebar")
        .getByTestId("document-list-item")
        .filter({ hasText: name })
        .getByTestId("open-document");
    await pointAndClick(window, sidebarRow("Alpha"));
    await pointAndClick(window, sidebarRow("Beta"), { modifiers: ["ControlOrMeta"] });
    await window.keyboard.press("Control+Meta+n");
    await expect(nameField(window)).toBeFocused();
    await window.keyboard.type("Pair");
    await window.keyboard.press("Enter");
    await expect(sidebarFolder(window, "Pair")).toHaveAttribute("data-count", "2");
    expect(await filedIn(window, ["Alpha", "Beta", "Gamma", "Delta"])).toEqual([
      "Pair",
      "Pair",
      null,
      null,
    ]);
    await expect(undoMessage(window)).toHaveText("Made “Pair” with 2 Documents");

    // The Library's rows are selected the same way.
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    const row = (name: string) => library.getByTestId("library-document").filter({ hasText: name });
    await pointAndClick(window, row("Gamma").getByTestId("library-document-name"));
    await pointAndClick(window, row("Delta").getByTestId("library-document-name"), {
      modifiers: ["ControlOrMeta"],
    });
    await expect(library.getByTestId("library-selection")).toContainText("2 selected");
    await row("Delta").locator("[data-row-main]").focus();
    await window.keyboard.press("Control+Meta+n");
    await expect(nameField(window)).toBeFocused();
    await window.keyboard.press("Enter");
    expect(await filedIn(window, ["Alpha", "Beta", "Gamma", "Delta"])).toEqual([
      "Pair",
      "Pair",
      "Untitled Folder",
      "Untitled Folder",
    ]);
  } finally {
    await app.close();
  }
});

test("a sidebar selection of Documents makes one Folder with all of them by the right-click menu, one ⌘Z puts each back; with a Mind in it, the menu is Move to… and Delete", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await addDocuments(window, await writeTexts("Alpha", "Beta", "Gamma"));
    await newMind(window);
    await nameMind(window, "Plan");
    const sidebar = window.getByTestId("sidebar");
    const documentRow = (name: string) =>
      sidebar
        .getByTestId("document-list-item")
        .filter({ hasText: name })
        .getByTestId("open-document");
    const mind = sidebar.getByTestId("mind-row").filter({ hasText: "Plan" });
    await pointAndClick(window, documentRow("Alpha"));
    await pointAndClick(window, documentRow("Beta"), { modifiers: ["ControlOrMeta"] });
    await expect(window.getByTestId("sidebar-selection")).toContainText("2 selected");

    // A selected row's menu is for the selection.
    await pointAndClick(window, documentRow("Beta"), { button: "right" });
    const entry = window.getByTestId("folder.newWith");
    await expect(entry).toHaveText(/New Folder with 2 Documents/);
    await pointAndClick(window, entry);
    await expect(nameField(window)).toBeFocused();
    await window.keyboard.type("Pair");
    await window.keyboard.press("Enter");
    await expect(sidebarFolder(window, "Pair")).toHaveAttribute("data-count", "2");
    await expect(sidebarFolder(window, "Pair")).toHaveAttribute("data-minds", "0");
    expect(await filedIn(window, ["Alpha", "Beta", "Gamma"])).toEqual(["Pair", "Pair", null]);
    await expect(undoMessage(window)).toHaveText("Made “Pair” with 2 Documents");
    // The selection is spent once its items are in the Folder.
    await expect(window.getByTestId("sidebar-selection")).toHaveText("");

    await window.keyboard.press("ControlOrMeta+z");
    await expect(sidebarFolder(window, "Pair")).toHaveCount(0);
    expect(await filedIn(window, ["Alpha", "Beta", "Gamma"])).toEqual([null, null, null]);
    const mindFolders = await (await coreOf(window)).evaluate(async (core) =>
      (await core.listMinds()).map((each) => each.folderId),
    );
    expect(mindFolders).toEqual([null]);

    // With a Mind in the selection too, its kinds mixed, the menu holds Move to… and Delete only.
    await pointAndClick(window, documentRow("Alpha"));
    await pointAndClick(window, documentRow("Beta"), { modifiers: ["ControlOrMeta"] });
    await pointAndClick(window, mind.getByTestId("mind-list-item"), {
      modifiers: ["ControlOrMeta"],
    });
    await expect(window.getByTestId("sidebar-selection")).toContainText("3 selected");
    await pointAndClick(window, documentRow("Beta"), { button: "right" });
    await expect(
      sidebar
        .getByTestId("document-list-item")
        .filter({ hasText: "Beta" })
        .getByTestId("document-file-actions")
        .getByRole("menuitem"),
    ).toHaveText([/^Move 3 items to…/, /^Delete 3 items/]);
    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");

    // An unselected row's menu is for that row alone.
    await pointAndClick(window, documentRow("Gamma"), { button: "right" });
    await expect(window.getByTestId("folder.newWith")).toHaveText(/New Folder with this Document/);
    await window.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});

test("a Mind's ⋯ makes a Folder with that Mind in it, and ⌘Z puts it back", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await newMind(window);
    await nameMind(window, "Plan");
    const mind = window.getByTestId("mind-row").filter({ hasText: "Plan" });
    await mind.hover();
    await pointAndClick(window, mind.getByTestId("mind-menu"));
    const entry = window.getByTestId("folder.newWith");
    await expect(entry).toHaveText(/New Folder with this note/);
    await pointAndClick(window, entry);
    const field = nameField(window);
    await expect(field).toBeFocused();
    await window.keyboard.type("Projects");
    await window.keyboard.press("Enter");
    const folder = sidebarFolder(window, "Projects");
    await expect(folder).toHaveAttribute("data-minds", "1");
    const folderOfMind = async () =>
      (await (await coreOf(window)).evaluate((core) => core.listMinds()))[0]?.folderId ?? null;
    expect(await folderOfMind()).not.toBeNull();
    await expect(undoMessage(window)).toHaveText("Made “Projects” with “Plan”");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(sidebarFolder(window, "Projects")).toHaveCount(0);
    expect(await folderOfMind()).toBeNull();
  } finally {
    await app.close();
  }
});

test("in Chinese: “未命名文件夹”, a name typed through an input method isn't cut off by its Enter, and the line is in Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 700);
    await dismissChatSetup(window);
    await setLanguage(window, "zh-CN");
    const field = nameField(window);
    await window.keyboard.press("ControlOrMeta+Shift+n");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("未命名文件夹");
    await typeWithInputMethod(window, field, "第二章资料");
    await expect(field).toHaveCount(0);
    await expect(sidebarFolder(window, "第二章资料")).toHaveCount(1);
    await expect.poll(() => folderNames(window)).toEqual(["第二章资料"]);
    await expect(undoMessage(window)).toHaveText("已新建文件夹“第二章资料”");

    await pointAndClick(window, window.getByTestId("plus-menu"));
    await expect(window.getByTestId("plus-new-folder")).toContainText("新建文件夹");
    await window.keyboard.press("Escape");

    // With the Documents selected in the Library, in Chinese too.
    await addDocuments(window, await writeTexts("甲", "乙"));
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    for (const name of ["甲", "乙"]) {
      await pointAndClick(
        window,
        library
          .getByTestId("library-document")
          .filter({ hasText: name })
          .getByTestId("library-select"),
      );
    }
    const bar = library.getByTestId("library-selection");
    await pointAndClick(window, bar.getByTestId("document-file-menu"));
    await expect(window.getByTestId("folder.newWith")).toHaveText(
      /^新建文件夹并放入 2 个文档(⌃⌘N)?$/,
    );
    await pointAndClick(window, window.getByTestId("folder.newWith"));
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("未命名文件夹");
    await window.keyboard.press("Enter");
    await expect(undoMessage(window)).toHaveText("已新建文件夹“未命名文件夹”，放入 2 个文档");
  } finally {
    await app.close();
  }
});

test("with the sidebar hidden, the name is still typed in the Folder's row", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await (await coreOf(window)).evaluate(async (core) => {
      await core.createTag({ name: "Tides" });
      await core.createLibraryGroup({ name: "Finance", description: "" });
    });
    await addDocuments(window, await writeTexts("Tide notes"));
    const field = nameField(window);

    // ⇧⌘N from anywhere in the window.
    await window.keyboard.press("ControlOrMeta+Shift+n");
    await expect(field).toBeFocused();
    await window.keyboard.type("Reading");
    await window.keyboard.press("Enter");
    await expect(sidebarFolder(window, "Reading")).toHaveCount(1);

    // With the sidebar hidden, it slides out to take the name.
    await window.keyboard.press("ControlOrMeta+\\");
    await expect(window.getByTestId("sidebar-announcement")).toHaveText("Sidebar hidden");
    await window.keyboard.press("ControlOrMeta+Shift+n");
    await expect(field).toBeFocused();
    await expect(field).toBeInViewport();
    await window.keyboard.type("Notes");
    await window.keyboard.press("Enter");
    await expect.poll(() => folderNames(window)).toEqual(["Finance", "Notes", "Reading"]);
  } finally {
    await app.close();
  }
});

test("the File menu has New Folder on ⇧⌘N, no other menu item has those keys, and choosing it makes a Folder", async () => {
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
    const holders = items.filter((item) => keysOf(item.accelerator) === "cmdorctrl+n+shift");
    expect(holders.map((item) => item.path)).toEqual([" > File > New Folder"]);

    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
      file?.submenu?.items.find((item) => item.label === "New Folder")?.click();
    });
    await expect(nameField(window)).toBeFocused();
    await window.keyboard.press("Escape");
    await expect.poll(() => folderNames(window)).toEqual(["Untitled Folder"]);
  } finally {
    await app.close();
  }
});

for (const { width, language } of [
  { width: 900, language: "en" },
  { width: 1600, language: "en" },
  { width: 900, language: "zh-CN" },
  { width: 1600, language: "zh-CN" },
] as const) {
  test(`the name field and the selection menu hold at ${width}px, in ${language === "en" ? "English" : "Chinese"}`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, 760);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await addDocuments(window, await writeTexts("Alpha", "Beta"));
      const sidebar = window.getByTestId("sidebar");
      const field = nameField(window);
      const inside = async (inner: Locator, outer: Locator) => {
        const [innerBox, outerBox] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
        if (!innerBox || !outerBox) throw new Error("Something isn't laid out.");
        expect(innerBox.x).toBeGreaterThanOrEqual(outerBox.x);
        expect(innerBox.x + innerBox.width).toBeLessThanOrEqual(outerBox.x + outerBox.width);
      };

      await window.keyboard.press("ControlOrMeta+Shift+n");
      await expect(field).toBeFocused();
      await inside(field, sidebar);
      await screenshot(window, `new-folder-field-${language}-${width}`);
      await window.keyboard.press("Escape");
      await window.keyboard.press("ControlOrMeta+z");
      await expect(field).toHaveCount(0);
      await expect.poll(() => folderNames(window)).toEqual([]);

      await window.getByTestId("open-library").click();
      const library = window.getByTestId("library");
      for (const name of ["Alpha", "Beta"]) {
        await pointAndClick(
          window,
          library
            .getByTestId("library-document")
            .filter({ hasText: name })
            .getByTestId("library-select"),
        );
      }
      const bar = library.getByTestId("library-selection");
      await pointAndClick(window, bar.getByTestId("document-file-menu"));
      const entry = window.getByTestId("folder.newWith");
      await expect(entry).toHaveText(
        language === "en"
          ? /^New Folder with 2 Documents(⌃⌘N)?$/
          : /^新建文件夹并放入 2 个文档(⌃⌘N)?$/,
      );
      const box = await entry.boundingBox();
      expect(box?.height).toBeLessThan(40);
      await motionSettled(window);
      await screenshot(window, `new-folder-selection-menu-${language}-${width}`);
      await pointAndClick(window, entry);
      await expect(field).toBeFocused();
      await inside(field, sidebar);
      await screenshot(window, `new-folder-with-these-${language}-${width}`);
      await window.keyboard.press("Escape");
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => folderNames(window)).toEqual([]);
    } finally {
      await app.close();
    }
  });
}
