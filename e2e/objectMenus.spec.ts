import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  linkedFolderRow,
  linkFolderFromSidebar,
  menuCommands,
  mindWrittenBefore,
  motionSettled,
  nameMind,
  newMind,
  openPageMenu,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSourceLocations,
  sidebarFolder,
  useLocalChatModel,
} from "./app";

/*
 * Every object has one menu, in one order (#223): a right-click opens the
 * menu its ⋯ button opens, each item shows its shortcut, and the keyboard
 * drives it. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots
 * of the menus there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

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
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** Moves the mouse onto an element in small steps, as a person does, and returns where it is. */
async function slideTo(window: Page, target: Locator): Promise<{ x: number; y: number }> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  const point = { x: box.x + Math.min(48, box.width / 2), y: box.y + box.height / 2 };
  await window.mouse.move(point.x, point.y, { steps: 8 });
  return point;
}

async function rightClick(window: Page, target: Locator): Promise<{ x: number; y: number }> {
  const point = await slideTo(window, target);
  await window.mouse.click(point.x, point.y, { button: "right" });
  return point;
}

/**
 * Whether the item shows the focus ring DESIGN.md gives every control: a solid accent outline, 2px,
 * drawn inside the item so the menu's scrolling can't clip it.
 */
const ringShows = (item: Locator) =>
  item.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--color-accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(element);
    return (
      style.outlineStyle === "solid" &&
      Number.parseFloat(style.outlineWidth) >= 2 &&
      style.outlineColor === accent &&
      Number.parseFloat(style.outlineOffset) < 0
    );
  });

/**
 * Every row of the menu is in view, or the menu scrolls and shows it does (#1501): a row outside the
 * menu's frame is a row reached only by scrolling, which nothing must leave unsaid.
 */
async function expectReachable(menu: Locator): Promise<void> {
  await expect(menu.getByRole("menuitem").first()).toBeVisible();
  const reach = await menu.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    const out = [...element.querySelectorAll('[role^="menuitem"]')].filter((row) => {
      const box = row.getBoundingClientRect();
      return box.top < frame.top - 1 || box.bottom > frame.bottom + 1;
    });
    return {
      inWindow: frame.top >= 0 && frame.bottom <= window.innerHeight,
      out: out.map((row) => row.getAttribute("data-testid")),
      scrolls: element.scrollHeight > element.clientHeight + 1,
      says: getComputedStyle(element).backgroundImage.includes("gradient"),
    };
  });
  expect(reach.inWindow).toBe(true);
  if (reach.out.length > 0) {
    expect(reach.scrolls && reach.says, `${reach.out.join(", ")} out of view and no cue`).toBe(
      true,
    );
  }
}

/**
 * Right-clicks an object, reads its menu, closes it, then opens the ⋯ button of the
 * same object and reads that: they are one menu. Returns the commands.
 */
async function sameFromBothWays(
  window: Page,
  row: Locator,
  hit: Locator,
  button: Locator,
  menu: Locator,
): Promise<string[]> {
  await rightClick(window, hit);
  const byRightClick = await menuCommands(menu);
  await expectReachable(menu);
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await slideTo(window, hit);
  await row.hover();
  await button.click();
  const byButton = await menuCommands(menu);
  expect(byButton).toEqual(byRightClick);
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  return byRightClick;
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Mind's menu shows every row in a window 800 px tall, Delete last after its rule (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1280, 800);
    await newMind(window);
    const mind = window.getByTestId("mind-row").first();
    await rightClick(window, mind.getByTestId("mind-list-item"));
    const menu = mind.getByTestId("mind-actions");
    const commands = await menuCommands(menu);
    expect(commands.slice(-2)).toEqual(["—", "mind.delete"]);
    await expect(menu.getByTestId("mind.delete")).toBeInViewport({ ratio: 1 });
    const scrolls = await menu.evaluate(
      (element) => element.scrollHeight > element.clientHeight + 1,
    );
    expect(scrolls).toBe(false);
    await expectReachable(menu);
    await screenshot(window, `menu-mind-800-${language}`);
    await app.close();
  });
}

test("a menu the window can't hold scrolls and says so: its cut edge shows, the wheel and End reach the rest", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1280, 800);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  const document = window.getByTestId("document-list-item").first();
  await rightClick(window, document.getByTestId("open-document"));
  const menu = document.getByTestId("document-file-actions");
  await menuCommands(menu);
  await expectReachable(menu);
  // The window's shortest height holds every menu, so a short frame stands in for a taller menu.
  await menu.evaluate((element) => {
    element.style.maxHeight = "240px";
  });
  await expectReachable(menu);
  expect(await menu.evaluate((element) => element.scrollHeight > element.clientHeight + 1)).toBe(
    true,
  );
  await screenshot(window, "menu-scrolls-top");
  const scrolled = () => menu.evaluate((element) => element.scrollTop);
  expect(await scrolled()).toBe(0);
  const box = await menu.boundingBox();
  if (!box) throw new Error("The menu isn't laid out.");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.wheel(0, 120);
  await expect.poll(scrolled).toBeGreaterThan(0);
  await expect(menu.getByTestId("document.open")).toBeFocused();
  await window.keyboard.press("End");
  await expect(menu.getByTestId("document.delete")).toBeFocused();
  await expect(menu.getByTestId("document.delete")).toBeInViewport();
  await screenshot(window, "menu-scrolls-end");
  await app.close();
});

test("a right-click opens the menu the ⋯ button opens, for a Mind, a Document, a Folder, a Tag, a Linked folder, a tab, an Answer and a Citation", async () => {
  const library = join(sources, "Library");
  await mkdir(library, { recursive: true });
  await writeFile(join(library, "Reading notes.md"), "# Notes\n\nAttention lets a model focus.\n");
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1600, 800);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await (await coreOf(window)).evaluate(async (core) => {
    await core.createLibraryGroup({ name: "Finance", description: "" });
    const tag = await core.createTag({ name: "Tides" });
    const [first] = await core.listDocuments();
    if (first) await core.addDocumentTag(first.id, tag.id);
  });

  // A Mind written before Questions went to the assistant (#201), with a Question and its Answer;
  // and a Mind holding an Answer added from the assistant, with its Citation of a page.
  await mindWrittenBefore(window, "Tide questions", [
    { question: "When do spring tides happen?", answer: "At new moon and at full moon." },
  ]);
  await newMind(window);
  await nameMind(window, "Cited notes");
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
  await expect(editor.getByTestId("citation")).toHaveCount(1);
  await newMind(window);

  // A Mind: Open, Open in new tab; Export… (one item, which opens the Export button's menu),
  // the AI use statement and check record; Move to…, New Folder with this note; Rename; then
  // Delete after a rule.
  const mind = window.getByTestId("mind-row").first();
  const mindMenu = await sameFromBothWays(
    window,
    mind,
    mind.getByTestId("mind-list-item"),
    mind.getByTestId("mind-menu"),
    mind.getByTestId("mind-actions"),
  );
  expect(mindMenu).toEqual([
    "mind.open",
    "mind.openTab",
    "—",
    "mind.outline",
    "mind.duplicate",
    "mind.exportMenu",
    "mind.aiUseStatement",
    "mind.checkRecord",
    "mind.history",
    "mind.check",
    "mind.tieOut",
    "mind.checkContradictions",
    "mind.citationStyle",
    "mind.style",
    "skill.fromMind",
    "—",
    "mind.moveTo",
    "folder.newWith",
    "—",
    "mind.tidy",
    "mind.rename",
    "—",
    "mind.delete",
  ]);
  await rightClick(window, mind.getByTestId("mind-list-item"));
  await menuCommands(mind.getByTestId("mind-actions"));
  await screenshot(window, "menu-mind");
  await window.keyboard.press("Escape");

  // A Document in the sidebar: Open first, its own actions, its file's, Delete last.
  const document = window.getByTestId("document-list-item").first();
  const documentMenu = await sameFromBothWays(
    window,
    document,
    document.getByTestId("open-document"),
    document.getByTestId("document-file-menu"),
    document.getByTestId("document-file-actions"),
  );
  expect(documentMenu).toEqual([
    "document.open",
    "document.openTab",
    "document.peek",
    "—",
    "document.ask",
    "document.startMind",
    "document.dontCite",
    "—",
    "document.moveTo",
    "folder.newWith",
    "—",
    "document.tags",
    "—",
    "document.rename",
    "—",
    "document.openExternally",
    "document.showInFolder",
    "file.copyPath",
    "file.info",
    "—",
    "document.delete",
  ]);
  await rightClick(window, document.getByTestId("open-document"));
  await menuCommands(document.getByTestId("document-file-actions"));
  await screenshot(window, "menu-document");
  await window.keyboard.press("Escape");

  // A Folder.
  const folder = sidebarFolder(window, "Finance");
  const folderMenu = await sameFromBothWays(
    window,
    folder,
    folder.getByTestId("folder-row"),
    folder.getByTestId("folder-menu"),
    folder.getByTestId("folder-actions"),
  );
  expect(folderMenu).toEqual([
    "folder.open",
    "—",
    "folder.newMind",
    "folder.new",
    "folder.organize",
    "folder.editDescription",
    "folder.keepInside",
    "folder.sort",
    "—",
    "folder.rename",
    "—",
    "file.info",
    "—",
    "folder.delete",
  ]);

  // A Tag, in the sidebar's Tags section.
  const tag = window.getByTestId("sidebar-tag").first();
  const tagMenu = await sameFromBothWays(
    window,
    tag,
    tag.getByTestId("row-text"),
    tag.getByTestId("tag-menu"),
    tag.getByTestId("tag-actions"),
  );
  expect(tagMenu).toEqual(["tag.open", "—", "tag.manage", "tag.rename", "—", "tag.delete"]);

  // A Linked folder, in the Linked folders section.
  await linkFolderFromSidebar(app, window, library);
  await showSourceLocations(window);
  const linked = linkedFolderRow(window, "Library");
  const linkedMenu = await sameFromBothWays(
    window,
    linked,
    linked.getByTestId("row-text"),
    linked.getByTestId("linked-folder-menu"),
    linked.getByTestId("linked-folder-actions"),
  );
  expect(linkedMenu).toEqual([
    "linkedFolder.pause",
    "folder.sort",
    "—",
    "linkedFolder.reveal",
    "file.copyPath",
    "file.info",
    "linkedFolder.locate",
    "—",
    "linkedFolder.unlink",
  ]);

  // A tab: its own actions, then Close and Close other tabs last. The keyboard opens the same menu
  // as the right-click, its ⋯ being out of sight in the tab.
  const tab = window.getByRole("tab", { selected: true }).first();
  await rightClick(window, tab);
  const tabMenu = tab.getByTestId("tab-actions");
  const byRightClick = await menuCommands(tabMenu);
  // Its Mind's items first, then the tab's own, and Delete last.
  const tabOwn = byRightClick.indexOf("tab.split");
  expect(byRightClick.slice(0, tabOwn)).toEqual([
    "mind.outline",
    "mind.duplicate",
    "mind.exportMenu",
    "mind.aiUseStatement",
    "mind.checkRecord",
    "mind.history",
    "mind.check",
    "mind.tieOut",
    "mind.checkContradictions",
    "mind.style",
    "—",
  ]);
  expect(byRightClick.slice(-2)).toEqual(["—", "mind.delete"]);
  expect(byRightClick.indexOf("tab.rename")).toBeLessThan(byRightClick.indexOf("tab.close"));
  expect(byRightClick.indexOf("tab.close")).toBeLessThan(byRightClick.indexOf("tab.closeOthers"));
  // Close and its kin come before Delete, after a rule.
  expect(byRightClick[byRightClick.indexOf("tab.close") - 1]).toBe("—");
  await window.keyboard.press("Escape");
  await expect(tabMenu).toBeHidden();
  await tab.focus();
  await window.keyboard.press("Shift+F10");
  expect(await menuCommands(tabMenu)).toEqual(byRightClick);
  await window.keyboard.press("Escape");
  await expect(tab).toBeFocused();

  // An Answer, in its Mind: Copy, Regenerate; then Delete.
  await window.getByTestId("mind-list-item").filter({ hasText: "Tide questions" }).click();
  const written = window.getByTestId("mind-editor").getByTestId("answer");
  await expect(written).toBeVisible();
  const answerMenu = written.getByTestId("answer-actions");
  await rightClick(window, written.locator(".answer-content p").first());
  const answerByRightClick = await menuCommands(answerMenu);
  expect(answerByRightClick).toEqual(["answer.copy", "answer.regenerate", "—", "block.delete"]);
  await window.keyboard.press("Escape");
  await slideTo(window, written);
  await written.getByTestId("answer-menu").click();
  expect(await menuCommands(answerMenu)).toEqual(answerByRightClick);
  await window.keyboard.press("Escape");

  // A Citation: Open, Checked by me (a toggle, #1933), then Remove; its card's ⋯ opens the same.
  await window.getByTestId("mind-list-item").filter({ hasText: "Cited notes" }).click();
  const citation = window.getByTestId("mind-editor").getByTestId("citation");
  const citationMenu = citation.getByTestId("citation-actions");
  await rightClick(window, citation.getByTestId("citation-chip"));
  expect(await menuCommands(citationMenu)).toEqual([
    "citation.open",
    "—",
    "citation.signOff",
    "—",
    "citation.remove",
  ]);
  await screenshot(window, "menu-citation");
  await window.keyboard.press("Escape");
  await citation.getByTestId("citation-chip").hover();
  const card = window.getByTestId("citation-card");
  await expect(card).toBeVisible();
  await card.getByTestId("citation-menu").click();
  expect(await menuCommands(card.getByTestId("citation-actions"))).toEqual([
    "citation.open",
    "—",
    "citation.signOff",
    "—",
    "citation.remove",
  ]);
  await window.keyboard.press("Escape");

  await app.close();
});

test("the context-menu key and Shift+F10 open the focused row's menu; arrows move, Enter runs, Esc closes and returns the focus to the row", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  const mind = window.getByTestId("mind-row").first();
  const row = mind.getByTestId("mind-list-item");
  const menu = mind.getByTestId("mind-actions");

  for (const key of ["ContextMenu", "Shift+F10"]) {
    await row.focus();
    await window.keyboard.press(key);
    await expect(menu).toBeVisible();
    // The first item has the focus; the arrows move through the items and wrap round. The focused
    // one shows the blue ring, not only a faint fill (#157).
    await expect(menu.getByTestId("mind.open")).toBeFocused();
    await expect.poll(() => ringShows(menu.getByTestId("mind.open"))).toBe(true);
    await window.keyboard.press("ArrowDown");
    await expect(menu.getByTestId("mind.openTab")).toBeFocused();
    await expect.poll(() => ringShows(menu.getByTestId("mind.openTab"))).toBe(true);
    await expect.poll(() => ringShows(menu.getByTestId("mind.open"))).toBe(false);
    await window.keyboard.press("ArrowUp");
    await window.keyboard.press("ArrowUp");
    await expect(menu.getByTestId("mind.delete")).toBeFocused();
    // Esc closes it and the focus is back on the row, not lost.
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(row).toBeFocused();
  }

  // Enter runs the focused item: Export… opens the Export button's menu for this Mind, whose
  // Export options… opens the sheet.
  await row.focus();
  await window.keyboard.press("Shift+F10");
  const target = menu.getByTestId("mind.exportMenu");
  for (let step = 0; step < 20; step++) {
    if (await target.evaluate((item) => item === document.activeElement)) break;
    await window.keyboard.press("ArrowDown");
  }
  await expect(target).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("export-menu")).toBeVisible();
  await expect(menu).toBeHidden();
  await window.getByTestId("export-options").click();
  await expect(window.getByTestId("export-dialog")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("export-dialog")).toBeHidden();
  await app.close();
});

test("each item shows its shortcut as the system writes it, and the labels are in Chinese too", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 900, 700);
  await newMind(window);
  const mind = window.getByTestId("mind-row").first();
  const menu = mind.getByTestId("mind-actions");

  await rightClick(window, mind.getByTestId("mind-list-item"));
  await expect(menu.getByTestId("mind.moveTo")).toHaveText(/^Move to…(⇧⌘M|Ctrl\+Shift\+M)$/);
  await expect(menu.getByTestId("mind.rename")).toHaveText(/^RenameF2$/);
  await screenshot(window, "menu-mind-narrow");
  await window.keyboard.press("Escape");

  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await rightClick(window, mind.getByTestId("mind-list-item"));
  await expect(menu.getByRole("menuitem")).toHaveText([
    "打开",
    "在新标签页中打开",
    /^大纲(⌥⌘L|Ctrl\+Alt\+L)$/,
    "创建副本",
    "导出…",
    "导出 AI 使用声明",
    "导出核对记录…",
    "历史版本",
    "核对",
    "核对数字",
    "核对矛盾",
    "引用格式…",
    "样式…",
    "做成技能",
    /^移动到…(⇧⌘M|Ctrl\+Shift\+M)$/,
    /^新建文件夹并放入此笔记(⌃⌘N)?$/,
    "整理中文排版",
    /^重命名F2$/,
    "删除",
  ]);
  await screenshot(window, "menu-mind-zh-narrow");
  // The menu stays inside the window and its items on one line each, at this width.
  const box = await menu.boundingBox();
  if (!box) throw new Error("The menu isn't laid out.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(900);
  for (const item of await menu.getByRole("menuitem").all()) {
    expect((await item.boundingBox())?.height).toBeLessThanOrEqual(32);
  }
  await app.close();
});

test("a right-click opens the menu at the pointer, the ⋯ at its button, and the keyboard at the row", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 900);
  await newMind(window);
  const mind = window.getByTestId("mind-row").first();
  const menu = mind.getByTestId("mind-actions");
  const nearBy = async (point: { x: number; y: number }) => {
    await motionSettled(window);
    const box = await menu.boundingBox();
    if (!box) throw new Error("The menu isn't laid out.");
    expect(Math.abs(point.x - box.x)).toBeLessThan(4);
    expect(Math.abs(point.y - box.y)).toBeLessThan(4);
  };

  const point = await rightClick(window, mind.getByTestId("mind-list-item"));
  await expect(menu).toBeVisible();
  await nearBy(point);
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // The ⋯ opens it under the button, not at the last pointer.
  await mind.hover();
  const button = mind.getByTestId("mind-menu");
  await button.click();
  await motionSettled(window);
  const buttonBox = await button.boundingBox();
  const menuBox = await menu.boundingBox();
  if (!buttonBox || !menuBox) throw new Error("Not laid out.");
  expect(menuBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height - 2);
  await window.keyboard.press("Escape");

  // The keyboard opens it at the focused row.
  await mind.getByTestId("mind-list-item").focus();
  await window.keyboard.press("Shift+F10");
  await motionSettled(window);
  const rowBox = await mind.boundingBox();
  const keyedBox = await menu.boundingBox();
  if (!rowBox || !keyedBox) throw new Error("Not laid out.");
  expect(keyedBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 2);
  expect(keyedBox.y).toBeLessThan(rowBox.y + rowBox.height + 16);
  await app.close();
});

/** Reads a box that must be there. */
async function boxOf(
  target: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't laid out.");
  return box;
}

test("the context-menu key opens a sidebar row's menu clear of the window buttons, and above the row when it can't open below", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  // macOS's traffic lights over the sidebar's header, whatever system the test runs on.
  await window.evaluate(() => {
    document.documentElement.dataset.titleBar = "inset";
    delete document.documentElement.dataset.fullScreen;
  });
  const buttonsLeft = await window.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;height:0;width:var(--window-buttons-left)";
    document.body.append(probe);
    const width = probe.offsetWidth;
    probe.remove();
    return width;
  });
  expect(buttonsLeft).toBeGreaterThan(0);
  const row = window.getByTestId("document-list-item").first();
  const main = row.getByTestId("open-document");
  const menu = row.getByTestId("document-file-actions");
  const height = await window.evaluate(() => globalThis.innerHeight);

  // The row is high in the window and its menu is too tall to open below it: it opens
  // below the band the buttons sit in, not over them, still at the row's left.
  await main.focus();
  await window.keyboard.press("Shift+F10");
  await expect(menu.getByTestId("document.open")).toBeFocused();
  await motionSettled(window);
  const rowBox = await boxOf(row);
  const high = await boxOf(menu);
  expect(high.x).toBeLessThan(buttonsLeft);
  expect(high.y).toBeGreaterThanOrEqual(44);
  expect(high.y + high.height).toBeLessThanOrEqual(height);
  expect(Math.abs(high.x - (rowBox.x + 24))).toBeLessThan(8);
  await window.keyboard.press("Escape");
  await expect(main).toBeFocused();

  // Low in the window, it opens above the row, not over it.
  await (await coreOf(window)).evaluate(async (core) => {
    for (let index = 1; index <= 14; index++) await core.createMind({ title: `Notes ${index}` });
  });
  await expect(window.getByTestId("mind-row")).toHaveCount(14);
  await main.focus();
  await window.keyboard.press("Shift+F10");
  await expect(menu.getByTestId("document.open")).toBeFocused();
  await motionSettled(window);
  const lowRow = await boxOf(row);
  const low = await boxOf(menu);
  expect(lowRow.y).toBeGreaterThan(high.y);
  expect(low.y).toBeGreaterThanOrEqual(44);
  expect(low.y + low.height).toBeLessThanOrEqual(lowRow.y + 2);
  await window.keyboard.press("Escape");
  await expect(main).toBeFocused();
  await app.close();
});

test("the context-menu key opens a Library row's and a tab's menu beside it, with the first item focused, and Esc returns to it", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 900);
  await newMind(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  const height = await window.evaluate(() => globalThis.innerHeight);

  const tab = window.getByTestId("mind-tab").first();
  const tabMenu = window.getByTestId("tab-actions");
  await tab.focus();
  await window.keyboard.press("Shift+F10");
  await expect(tabMenu).toBeVisible();
  await expect(tabMenu.getByRole("menuitem").first()).toBeFocused();
  await motionSettled(window);
  const tabBox = await boxOf(tab);
  const underTab = await boxOf(tabMenu);
  expect(underTab.y).toBeGreaterThanOrEqual(tabBox.y + tabBox.height - 2);
  expect(underTab.y).toBeLessThan(tabBox.y + tabBox.height + 16);
  expect(Math.abs(underTab.x - (tabBox.x + 24))).toBeLessThan(8);
  await window.keyboard.press("Escape");
  await expect(tab).toBeFocused();

  await window.getByTestId("open-library").click();
  const library = window.getByTestId("library");
  const row = library.locator("[data-document-id]").first();
  const main = row.locator("[data-row-main]");
  const menu = window.getByTestId("document-file-actions").filter({ visible: true });
  await main.focus();
  await window.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await motionSettled(window);
  const rowBox = await boxOf(row);
  const beside = await boxOf(menu);
  expect(Math.abs(beside.x - (rowBox.x + 24))).toBeLessThan(8);
  expect(beside.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 2);
  expect(beside.y + beside.height).toBeLessThanOrEqual(height);
  await window.keyboard.press("Escape");
  await expect(main).toBeFocused();
  await app.close();
});

/**
 * Opens the menu of `row` with the context-menu key and checks it stays beside the row, inside the
 * window and under `floor`, with every item reachable: the last one, by keyboard, ends up inside the menu.
 */
async function expectBesideRow(
  window: Page,
  row: Locator,
  main: Locator,
  menu: Locator,
  floor: number,
) {
  await main.scrollIntoViewIfNeeded();
  await main.focus();
  await window.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await motionSettled(window);
  const height = await window.evaluate(() => globalThis.innerHeight);
  const rowBox = await boxOf(row);
  const box = await boxOf(menu);
  expect(box.y).toBeGreaterThanOrEqual(floor);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
  const above = box.y + box.height <= rowBox.y + 2;
  const below = box.y >= rowBox.y + rowBox.height - 2;
  expect(above || below).toBe(true);
  await window.keyboard.press("End");
  const last = menu.locator('[role^="menuitem"]').last();
  await expect(last).toBeFocused();
  const lastBox = await boxOf(last);
  const scrolled = await boxOf(menu);
  expect(lastBox.y).toBeGreaterThanOrEqual(scrolled.y - 1);
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(scrolled.y + scrolled.height + 1);
  await window.keyboard.press("Escape");
  await expect(main).toBeFocused();
}

test("at the default window height and the smallest, the context-menu key opens a row's menu beside the row, scrolling when the room is short, and clear of the window buttons", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await window.evaluate(() => {
    document.documentElement.dataset.titleBar = "inset";
    delete document.documentElement.dataset.fullScreen;
  });
  const sizes = [
    [1600, 660],
    [900, 560],
  ] as const;
  const row = window.getByTestId("document-list-item").first();
  const main = row.getByTestId("open-document");
  const sidebarMenu = row.getByTestId("document-file-actions");
  const BAND = 44;

  for (const [width, height] of sizes) {
    await setWindowSize(app, window, width, height);
    await expectBesideRow(window, row, main, sidebarMenu, BAND);
  }
  // The row low in the sidebar: the menu goes above it.
  await (await coreOf(window)).evaluate(async (core) => {
    for (let index = 1; index <= 14; index++) await core.createMind({ title: `Notes ${index}` });
  });
  await expect(window.getByTestId("mind-row")).toHaveCount(14);
  for (const [width, height] of sizes) {
    await setWindowSize(app, window, width, height);
    await expectBesideRow(window, row, main, sidebarMenu, BAND);
  }

  await window.getByTestId("open-library").click();
  const libraryRow = window.getByTestId("library").locator("[data-document-id]").first();
  const libraryMain = libraryRow.locator("[data-row-main]");
  const libraryMenu = window.getByTestId("document-file-actions").filter({ visible: true });
  for (const [width, height] of sizes) {
    await setWindowSize(app, window, width, height);
    await expectBesideRow(window, libraryRow, libraryMain, libraryMenu, 8);
  }
  await app.close();
});

test("a Document's Tags…, a Folder's Edit description and a Tag's Rename and Delete start the flows the app already has", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await (await coreOf(window)).evaluate(async (core) => {
    await core.createLibraryGroup({ name: "Finance", description: "Invoices" });
    const tag = await core.createTag({ name: "Tides" });
    const [first] = await core.listDocuments();
    if (first) await core.addDocumentTag(first.id, tag.id);
  });

  const document = window.getByTestId("document-list-item").first();
  await rightClick(window, document.getByTestId("open-document"));
  await document.getByTestId("document.tags").click();
  await expect(document.getByTestId("document-tags-popover")).toBeVisible();
  await window.keyboard.press("Escape");

  const folder = sidebarFolder(window, "Finance");
  await rightClick(window, folder.getByTestId("folder-row"));
  await folder.getByTestId("folder.editDescription").click();
  await expect(window.getByTestId("library")).toBeVisible();
  await expect(window.getByTestId("library").locator("form input").first()).toHaveValue("Finance");
  await expect(window.getByTestId("library").locator("form textarea")).toHaveValue("Invoices");

  const tag = window.getByTestId("sidebar-tag").filter({ hasText: "Tides" });
  await rightClick(window, tag.getByTestId("row-text"));
  await tag.getByTestId("tag.rename").click();
  // In its row, with no dialog.
  const dialog = window.getByTestId("tags-dialog");
  await expect(window.getByTestId("sidebar-tag").getByRole("textbox")).toHaveValue("Tides");
  await expect(dialog).toBeHidden();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("sidebar-tag").getByRole("textbox")).toHaveCount(0);
  await rightClick(window, tag.getByTestId("row-text"));
  await tag.getByTestId("tag.delete").click();
  await expect(window.getByTestId("undo-message")).toHaveText("Moved “Tides” to Recently deleted");
  await app.close();
});

test("a menu opens at once while another is closing, and a right-click on another row replaces the open menu", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 900);
  await newMind(window);
  await newMind(window);
  const [first, second] = [
    window.getByTestId("mind-row").nth(0),
    window.getByTestId("mind-row").nth(1),
  ];
  const firstMenu = first.getByTestId("mind-actions");
  const secondMenu = second.getByTestId("mind-actions");

  // Esc, then at once a right-click on another row: the new menu opens, the old one is gone.
  await rightClick(window, first.getByTestId("mind-list-item"));
  await expect(firstMenu).toBeVisible();
  await window.keyboard.press("Escape");
  await rightClick(window, second.getByTestId("mind-list-item"));
  await expect(secondMenu).toBeVisible();
  await expect(firstMenu).toBeHidden();

  // With no Esc, a right-click on the row above dismisses it and opens that row's menu at once.
  await rightClick(window, first.getByTestId("mind-list-item"));
  await expect(firstMenu).toBeVisible();
  await expect(secondMenu).toBeHidden();

  // Esc, then at once the ⋯ of the other row: one click opens it, though the first is still leaving.
  await window.keyboard.press("Escape");
  await second.hover();
  await second.getByTestId("mind-menu").click();
  await expect(secondMenu).toBeVisible();
  await expect(firstMenu).toBeHidden();

  // Esc, then at once Shift+F10 on the other row.
  await window.keyboard.press("Escape");
  await first.getByTestId("mind-list-item").focus();
  await window.keyboard.press("Shift+F10");
  await expect(firstMenu).toBeVisible();
  await expect(secondMenu).toBeHidden();
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`the sidebar's, the tab's and the page's Mind menus have one Export… and no format rows, fit at 900px tall without scrolling and end with Delete; Export… opens the Export button's menu (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await newMind(window);
    await nameMind(window, "Harbour survey");
    await window.getByTestId("mind-editor").click();
    await window.keyboard.type("Spring tides come twice a month.");
    const row = window.getByTestId("mind-row").first();
    const tab = window.getByRole("tab", { selected: true }).first();
    const exportLabel = language === "en" ? "Export…" : "导出…";

    const surfaces: readonly [string, () => Promise<Locator>][] = [
      [
        "sidebar",
        async () => {
          await rightClick(window, row.getByTestId("mind-list-item"));
          return row.getByTestId("mind-actions");
        },
      ],
      [
        "tab",
        async () => {
          await rightClick(window, tab);
          return tab.getByTestId("tab-actions");
        },
      ],
      ["page", () => openPageMenu(window)],
    ];
    for (const [name, open] of surfaces) {
      const menu = await open();
      const items = menu.getByRole("menuitem");
      await expect(items.first()).toBeVisible();
      const ids = await items.evaluateAll((all) =>
        all.map((each) => each.getAttribute("data-testid")),
      );
      expect(
        ids.filter((id) => id === "mind.exportMenu"),
        name,
      ).toHaveLength(1);
      expect(
        ids.filter(
          (id) =>
            id?.startsWith("mind.exportAs") || id === "mind.export" || id === "mind.exportOptions",
        ),
        name,
      ).toEqual([]);
      await expect(menu.getByTestId("mind.exportMenu"), name).toContainText(exportLabel);
      // Delete is the last item (the page's counts and switch follow it, outside the list).
      expect(ids.at(-1), name).toBe("mind.delete");
      if (name === "page") {
        // The Mind is open on this page: nothing to open it with.
        expect(ids, name).not.toContain("mind.open");
        expect(ids, name).not.toContain("mind.openTab");
      }
      // One name per way of opening: the Mind's menu says Open and Open in new tab, with no keys,
      // the tab's has one Split to the right with its keys, and none says "Open to the side".
      const texts = await items.allTextContents();
      expect(texts.join("\n"), name).not.toMatch(/Open to the side|在旁边打开|在侧边打开/);
      if (name === "sidebar") {
        expect(texts.slice(0, 2), name).toEqual(
          language === "en" ? ["Open", "Open in new tab"] : ["打开", "在新标签页中打开"],
        );
      }
      if (name === "tab") {
        expect(
          ids.filter((id) => id === "tab.split"),
          name,
        ).toHaveLength(1);
        await expect(menu.getByTestId("tab.split"), name).toHaveText(
          language === "en"
            ? /^Split to the right(⌥⌘\\|Ctrl\+Alt\+\\)$/
            : /^向右拆分(⌥⌘\\|Ctrl\+Alt\+\\)$/,
        );
      }
      // Duplicate and Tidy Chinese text join this menu with the Note basics (#1935).
      expect(ids.length, name).toBeLessThanOrEqual(19);
      // It fits: no scrollbar, and inside the window.
      const fits = await menu.evaluate((element) => ({
        scrolls: element.scrollHeight > element.clientHeight + 1,
        bottom: element.getBoundingClientRect().bottom,
      }));
      expect(fits.scrolls, name).toBe(false);
      expect(fits.bottom, name).toBeLessThanOrEqual(900);
      await screenshot(window, `menu-mind-${name}-${language}`);
      await window.keyboard.press("Escape");
      await expect(menu, name).toBeHidden();
    }

    // Export… opens the Export button's own short menu, from each.
    for (const [name, open] of surfaces) {
      const menu = await open();
      await menu.getByTestId("mind.exportMenu").click();
      const exportMenu = window.getByTestId("export-menu");
      await expect(exportMenu, name).toBeVisible();
      await expect(menu, name).toBeHidden();
      // Word, the line that starts Check under it (D266), PDF, More formats, Citation style, Export options.
      await expect(exportMenu.getByRole("menuitem"), name).toHaveCount(6);
      await window.keyboard.press("Escape");
      await expect(exportMenu, name).toBeHidden();
    }
    await app.close();
  });
}
