import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  editFolderInLibrary,
  frontMindName,
  launchApp,
  linkedFolderRow,
  linkFolderFromSidebar,
  motionRunning,
  motionSettled,
  newMind,
  openLinkedFolderMenu,
  pointAndClick,
  removeDataFolder,
  renameInTab,
  setLanguage,
  setMotionSpeed,
  setWindowSize,
  showSourceLocations,
  sidebarFolder,
  tabMenu,
} from "./app";

/*
 * Undo, the remaining gaps (#606): a Mind made from a Document, in a Folder, with ⌘N or the
 * sidebar's + says nothing and leaves nothing for ⌘Z to take back (Delete does); a run of typing in
 * a multi-line field is one step; pausing a Linked folder and changing its layout are taken
 * back. Each is checked in the core, through the bridge. Set INCARNAMIND_SCREENSHOTS to a folder
 * to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

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

/** Reads the core through the bridge. */
async function read<T>(window: Page, query: (core: CoreBridge) => Promise<T>): Promise<T> {
  return (await coreOf(window)).evaluate(query);
}

const undoMessage = (window: Page) => window.getByTestId("undo-message");
const undo = (window: Page) => window.keyboard.press("ControlOrMeta+z");
const redo = (window: Page) => window.keyboard.press("ControlOrMeta+Shift+z");

/** Clicks the empty foot of the sidebar's tree, where ⌘Z goes to the app's changes. */
async function leaveText(window: Page): Promise<void> {
  const box = await window.getByTestId("sidebar-tree").boundingBox();
  if (!box) throw new Error("The sidebar isn't showing.");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height - 8, { steps: 8 });
  await window.mouse.down();
  await window.mouse.up();
}

const mindIds = (window: Page) =>
  read(window, async (core) => (await core.listMinds()).map((mind) => mind.id).sort());
const deletedMindIds = (window: Page) =>
  read(window, async (core) =>
    (await core.listDeleted()).filter((item) => item.kind === "mind").map((item) => item.id),
  );

const documentRow = (window: Page, name: string) =>
  window.getByTestId("document-list-item").filter({ hasText: name });

async function documentMenuCommand(window: Page, name: string, command: string): Promise<void> {
  await pointAndClick(window, documentRow(window, name).getByTestId("document-file-menu"));
  await pointAndClick(
    window,
    window.getByTestId("document-file-actions").filter({ visible: true }).getByTestId(command),
  );
}

async function startWithADocument(language: "en" | "zh-CN" = "en") {
  const running = await launchApp(dataDir);
  const { window } = running;
  await dismissChatSetup(window);
  await writeFile(join(sources, "Tides.txt"), "Neap tides are the smallest of the month.\n");
  // Added by the core, not through the sidebar's picker, which leaves a step of its own for ⌘Z.
  const path = join(sources, "Tides.txt");
  await (await coreOf(window)).evaluate(async (core, file) => core.addDocuments([file]), path);
  await expect(window.getByTestId("document-list-item")).toHaveAttribute("data-status", "ready");
  await read(window, (core) => core.createLibraryGroup({ name: "Finance", description: "" }));
  if (language !== "en") await setLanguage(window, language);
  return running;
}

async function madeQuietly(window: Page, make: () => Promise<void>): Promise<string> {
  const before = await mindIds(window);
  await make();
  await expect.poll(async () => (await mindIds(window)).length).toBe(before.length + 1);
  await expect(undoMessage(window)).toHaveCount(0);
  await leaveText(window);
  await undo(window);
  expect((await mindIds(window)).length).toBe(before.length + 1);
  expect(await deletedMindIds(window)).toHaveLength(0);
  const made = (await mindIds(window)).find((id) => !before.includes(id));
  if (!made) throw new Error("No Mind was made.");
  return made;
}

test("Ask about a Document with no Mind to ask in, New Mind here, ⌘N, + and Start a Mind from a Document: each makes a Mind with no line and nothing for ⌘Z to take back", async () => {
  const { window } = await startWithADocument();

  // With no Mind, asking about a Document makes one.
  await madeQuietly(window, () => documentMenuCommand(window, "Tides", "document.ask"));

  const finance = sidebarFolder(window, "Finance");
  await madeQuietly(window, async () => {
    await finance.getByTestId("folder-row").click({ button: "right" });
    await finance.getByTestId("folder.newMind").click();
  });
  expect(await read(window, async (core) => (await core.listMinds()).length)).toBe(2);

  await madeQuietly(window, () => window.keyboard.press("ControlOrMeta+n"));
  await madeQuietly(window, () => newMind(window));

  // Named after the Document, it is no more news than one with no name.
  await madeQuietly(window, () => documentMenuCommand(window, "Tides", "document.startMind"));
});

test("a line already showing follows a switch of language, in its words and its Undo", async () => {
  const { window } = await startWithADocument();
  const undoButton = window.getByTestId("undo-action");
  const started = await madeQuietly(window, () =>
    documentMenuCommand(window, "Tides", "document.startMind"),
  );

  // A line of plain words, with Undo's accessible name: Undo still takes the change back.
  const font = async () =>
    (await coreOf(window)).evaluate(
      async (core, mindId) => (await core.getMindStyle(mindId)).font,
      started,
    );
  const menu = await tabMenu(window);
  await pointAndClick(window, menu.getByTestId("mind.style"));
  await pointAndClick(window, window.getByTestId("mind-style-font-serif"));
  await expect(undoMessage(window)).toHaveText("Font changed to Serif");
  await expect.poll(font).toBe("serif");
  await setLanguage(window, "zh-CN");
  await expect(undoMessage(window)).toHaveText("字体已改为“衬线”");
  await expect(undoButton).toHaveText("撤销");
  await expect(undoButton).toHaveAttribute("aria-label", /衬线/);
  await pointAndClick(window, undoButton);
  await expect.poll(font).toBe("default");
});

test("⌘N twice in a row makes two Minds with no line, and ⌘Z takes neither back: Delete does", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await window.keyboard.press("ControlOrMeta+n");
  await window.keyboard.press("ControlOrMeta+n");
  await expect.poll(() => mindIds(window)).toHaveLength(2);
  await expect(undoMessage(window)).toHaveCount(0);

  await leaveText(window);
  await undo(window);
  expect(await mindIds(window)).toHaveLength(2);
  expect(await deletedMindIds(window)).toHaveLength(0);
});

test("a Mind made, then written in, goes to Recently deleted with its text when deleted, and ⌘Z brings it back with it", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  await renameInTab(window, "Ferries");
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  await window.keyboard.type("Ferries run at noon");
  await expect(editor).toContainText("Ferries run at noon");

  await pointAndClick(window, (await tabMenu(window)).getByTestId("mind.delete"));
  await expect.poll(() => mindIds(window)).toHaveLength(0);
  expect(await deletedMindIds(window)).toHaveLength(1);
  await leaveText(window);
  await undo(window);
  await expect.poll(() => mindIds(window)).toHaveLength(1);
  await pointAndClick(window, window.getByTestId("mind-list-item"));
  await expect(frontMindName(window)).toHaveText("Ferries");
  await expect(window.getByTestId("mind-editor")).toContainText("Ferries run at noon");
});

/** A word typed in one go in a multi-line field is one step: ⌘Z gives back the text as it was, ⇧⌘Z the word. */
async function typedWordIsOneStep(window: Page, field: Locator, before: string): Promise<void> {
  await pointAndClick(window, field);
  await window.keyboard.press("ControlOrMeta+End");
  await window.keyboard.type("tides");
  await expect(field).toHaveValue(`${before}tides`);
  await undo(window);
  await expect(field).toHaveValue(before);
  await redo(window);
  await expect(field).toHaveValue(`${before}tides`);
  await undo(window);
  await expect(field).toHaveValue(before);
}

test("typing in a multi-line field is one step: a form in a dialog, and a form in a page", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await writeFile(join(sources, "Tides.txt"), "Neap tides are the smallest of the month.\n");
  await addDocuments(window, [join(sources, "Tides.txt")]);
  await read(window, (core) => core.createLibraryGroup({ name: "Finance", description: "Rent" }));

  // A dialog: the addresses of web pages.
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-more").click();
  await window.getByTestId("plus-add-web-page").click();
  const dialog = window.getByTestId("add-web-page-dialog");
  await typedWordIsOneStep(window, dialog.getByTestId("add-web-page-addresses"), "");
  await window.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // A page: a Folder's description in the Library.
  const form = await editFolderInLibrary(window, "Finance");
  const description = form.locator("textarea");
  await typedWordIsOneStep(window, description, "Rent");
});

// protects=one Undo takes back a whole word typed while a menu's closing copy is still fading, which
// leaves the page mid-word; fails_when=that copy's removal ends the typing run (#1140).
test("typing while a closed menu is still fading is one step, though its copy would leave mid-word", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setMotionSpeed(window, 0.2);
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-more").click();
  await window.getByTestId("plus-add-web-page").click();
  const addresses = window.getByTestId("add-web-page-dialog").getByTestId("add-web-page-addresses");
  await pointAndClick(window, addresses);
  await window.keyboard.type("ti");
  await expect.poll(() => motionRunning(window)).toBe(0);
  await window.keyboard.type("des");
  await expect(addresses).toHaveValue("tides");
  await undo(window);
  await expect(addresses).toHaveValue("");
  await redo(window);
  await expect(addresses).toHaveValue("tides");
});

test("Chinese typed by an input method into a multi-line field is one step too", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await window.getByTestId("plus-menu").click();
  await window.getByTestId("plus-more").click();
  await window.getByTestId("plus-add-web-page").click();
  const addresses = window.getByTestId("add-web-page-dialog").getByTestId("add-web-page-addresses");
  await pointAndClick(window, addresses);
  const session = await window.context().newCDPSession(window);
  try {
    await session.send("Input.imeSetComposition", {
      text: "chao",
      selectionStart: 4,
      selectionEnd: 4,
    });
    await session.send("Input.imeSetComposition", {
      text: "chaoxi",
      selectionStart: 6,
      selectionEnd: 6,
    });
    await session.send("Input.insertText", { text: "潮汐" });
  } finally {
    await session.detach();
  }
  await expect(addresses).toHaveValue("潮汐");
  await undo(window);
  await expect(addresses).toHaveValue("");
  await redo(window);
  await expect(addresses).toHaveValue("潮汐");
});

async function linkPapers(window: Page, app: ElectronApplication) {
  const papers = join(sources, "Papers");
  await mkdir(papers, { recursive: true });
  await writeFile(join(papers, "Attention.txt"), "Attention lets a model focus.\n");
  await writeFile(join(papers, "Tides.txt"), "Neap tides are the smallest of the month.\n");
  await linkFolderFromSidebar(app, window, papers);
  await showSourceLocations(window);
  const linked = () => read(window, async (core) => (await core.listLinkedFolders())[0]);
  await expect.poll(async () => (await linked())?.status).toBe("watching");
  return { row: linkedFolderRow(window, "Papers"), linked };
}

test("pausing a Linked folder and showing it as a flat list: ⌘Z sets it back as it was, ⇧⌘Z does it again, with the line in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const { row, linked } = await linkPapers(window, app);

  await (await openLinkedFolderMenu(row)).getByTestId("linkedFolder.pause").click();
  await expect(undoMessage(window)).toHaveText("Paused reading in “Papers”");
  await screenshot(window, "pause-a-linked-folder-en-1600");
  expect((await linked())?.status).toBe("paused");
  await setWindowSize(app, window, 900, 660);
  await leaveText(window);
  await undo(window);
  await expect.poll(async () => (await linked())?.status).toBe("watching");
  await redo(window);
  await expect.poll(async () => (await linked())?.status).toBe("paused");
  await expect(undoMessage(window)).toHaveText("Paused reading in “Papers”");
  await screenshot(window, "pause-a-linked-folder-en-900");
  await undo(window);
  await expect.poll(async () => (await linked())?.status).toBe("watching");

  await (await openLinkedFolderMenu(row)).getByTestId("linkedFolder.layout").click();
  await expect(undoMessage(window)).toHaveText("Showing “Papers” as a flat list");
  expect((await linked())?.layout).toBe("flat");
  await leaveText(window);
  await undo(window);
  await expect.poll(async () => (await linked())?.layout).toBe("tree");
  await redo(window);
  await expect.poll(async () => (await linked())?.layout).toBe("flat");
  await undo(window);
  await expect.poll(async () => (await linked())?.layout).toBe("tree");

  await setLanguage(window, "zh-CN");
  await (await openLinkedFolderMenu(row)).getByTestId("linkedFolder.pause").click();
  await expect(undoMessage(window)).toHaveText("已暂停读取“Papers”");
  await screenshot(window, "pause-a-linked-folder-zh-900");
  await setWindowSize(app, window, 1600, 660);
  await leaveText(window);
  await undo(window);
  await redo(window);
  await expect(undoMessage(window)).toHaveText("已暂停读取“Papers”");
  await screenshot(window, "pause-a-linked-folder-zh-1600");
  await undo(window);
  await expect.poll(async () => (await linked())?.status).toBe("watching");
  await (await openLinkedFolderMenu(row)).getByTestId("linkedFolder.layout").click();
  await expect(undoMessage(window)).toHaveText("已将“Papers”显示为平铺列表");
});

test("quitting between the change and its Undo leaves the change made, and ⌘Z in the next launch takes back nothing", async () => {
  const first = await launchApp(dataDir);
  await dismissChatSetup(first.window);
  const { row } = await linkPapers(first.window, first.app);
  await (await openLinkedFolderMenu(row)).getByTestId("linkedFolder.pause").click();
  await expect(undoMessage(first.window)).toHaveText("Paused reading in “Papers”");
  await first.app.close();

  const { window } = await launchApp(dataDir);
  await showSourceLocations(window);
  await expect
    .poll(() => read(window, async (core) => (await core.listLinkedFolders())[0]?.status))
    .toBe("paused");
  await leaveText(window);
  await undo(window);
  await expect(undoMessage(window)).toHaveCount(0);
  expect((await read(window, (core) => core.listLinkedFolders()))[0]?.status).toBe("paused");
});
