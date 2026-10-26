import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  confirmLink,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  expectFirstTabAtCardStart,
  interceptOpenDialog,
  launchApp,
  linkedFolderRow,
  placeAssistant,
  previewLink,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  widthOf,
} from "./app";

/*
 * The shell's card (DESIGN.md, Layout): everything right of the 248px sidebar
 * sits in one card, 8px from the sidebar and from the window's top, right and
 * bottom edges, with its 36px tab band inside, and the sidebar header has one
 * "+" menu. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots
 * of the shell at 1440 and 1000px, in English and in Chinese.
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

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
}

/** A new Mind the way a person makes one: the "+" in the band, then typing its title. */
async function newMind(window: Page, title: string): Promise<void> {
  await window.getByTestId("new-tab").click();
  await enterContent(window);
  await window.keyboard.type(title);
}

test("the Mind sits in a card 8px from the sidebar and the window's edges, with its band inside", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window, "Reading notes");
  await newMind(window, "Interview plan");

  for (const [width, requested] of [
    [1440, 860],
    [1000, 700],
  ] as const) {
    await setWindowSize(app, window, width, requested);
    // The screen may not have room for the height asked for: the card follows the page's.
    await expect.poll(() => window.evaluate(() => globalThis.innerHeight)).toBeGreaterThan(600);
    const height = await window.evaluate(() => globalThis.innerHeight);

    // The sidebar is exactly 248px; the card follows after an 8px gap, 8px from the top and
    // the bottom, and ends 4px before the assistant docked on the right (#253, #1099), which ends
    // 8px short of the window.
    const sidebar = await boxOf(window.getByTestId("sidebar"));
    expect(sidebar.width).toBe(248);
    const card = await boxOf(window.getByTestId("card"));
    const assistant = await boxOf(window.getByTestId("assistant"));
    expect(assistant).toMatchObject({ y: 8, height: height - 16 });
    expect(assistant.x + assistant.width).toBe(width - 8);
    expect(card).toEqual({ x: 256, y: 8, width: assistant.x - 4 - 256, height: height - 16 });
    const style = await window
      .getByTestId("card")
      .evaluate((element) => getComputedStyle(element).borderTopLeftRadius);
    expect(style).toBe("10px");

    // The band is the card's first 36px, so it ends level with the sidebar header's rule at y 44,
    // and the tabs sit inside it, the first at the card's left edge.
    const header = await boxOf(window.getByTestId("sidebar-header"));
    const band = await boxOf(window.getByTestId("tab-strip"));
    expect(band).toMatchObject({ x: card.x, y: 8, width: card.width, height: 36 });
    expect(header.y + header.height).toBe(band.y + band.height);
    // Tabs that don't all fit rest on whole tabs, the shown one in view: back to the first.
    await window.getByTestId("tab-list").evaluate((list) => list.scrollTo({ left: 0 }));
    await expectFirstTabAtCardStart(window, window.getByTestId("mind-tab").first());

    if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `shell-${width}.png`) });

    // Split into two groups, both inside the card, the second's strip continuing the band.
    // At 1,000px the card beside the assistant is too narrow for two: with the assistant at the
    // bottom, it has the room.
    if (width < 1400) await placeAssistant(window, { dock: "bottom" });
    await window.keyboard.press("ControlOrMeta+Alt+Backslash");
    const groups = window.getByTestId("tab-group");
    await expect(groups).toHaveCount(2);
    const right = await boxOf(groups.nth(1));
    const cardNow = await boxOf(window.getByTestId("card"));
    expect(right.x + right.width).toBe(cardNow.x + cardNow.width);
    expect(await boxOf(window.getByTestId("tab-strip").nth(1))).toMatchObject({ y: 8, height: 36 });
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `shell-${width}-groups.png`) });
    }
    await window.keyboard.press("ControlOrMeta+w");
    await expect(groups).toHaveCount(1);
    await placeAssistant(window, { dock: "right" });
  }
  await app.close();
});

test("every pane header's contents sit on the band's centre line and their rules level, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window, "Reading notes");
  await newMind(window, "Interview plan");
  await setWindowSize(app, window, 1440, 860);

  const centreOf = async (locator: Locator) => {
    const box = await boxOf(locator);
    return box.y + box.height / 2;
  };
  const activeTab = window.locator('[role="tab"][aria-selected="true"]');
  const otherTab = window.locator('[role="tab"][aria-selected="false"]').first();

  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    // The assistant's header is at the window's top docked on either side.
    for (const dock of ["right", "left"] as const) {
      await placeAssistant(window, { dock });
      const strip = await boxOf(window.getByTestId("tab-strip"));
      const line = strip.y + strip.height / 2;

      const contents = [
        window.getByTestId("plus-menu"),
        window.getByTestId("sidebar-toggle"),
        activeTab.getByTestId("tab-title"),
        activeTab.getByTestId("tab-close"),
        otherTab.getByTestId("tab-title"),
        window.getByTestId("new-tab"),
        window.getByTestId("export-mind"),
        window.getByTestId("assistant-title"),
        ...(await window.getByTestId("assistant-header").getByRole("button").all()),
      ];
      for (const item of contents) {
        expect(Math.abs((await centreOf(item)) - line), `${language} ${dock}`).toBeLessThanOrEqual(
          1,
        );
      }

      // The three rules end on one row: the band's bottom, y 44.
      const bottom = async (testId: string) => {
        const box = await boxOf(window.getByTestId(testId));
        return box.y + box.height;
      };
      expect(await bottom("sidebar-header")).toBe(strip.y + strip.height);
      expect(await bottom("assistant-header")).toBe(strip.y + strip.height);
    }
  }
  await app.close();
});

test("the divider in the gap before the card is grabbed with the mouse and moved with the arrow keys", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const rod = window.getByTestId("sidebar-resize");
  const sidebar = window.getByTestId("sidebar");
  const card = window.getByTestId("card");

  // The gap itself is the grab strip: 8px wide, between the sidebar and the card.
  const gap = await boxOf(rod);
  expect(gap).toMatchObject({ x: 248, width: 8 });

  // Slid onto and dragged 40px right, it widens the sidebar and keeps the 8px gap.
  const y = gap.y + gap.height / 2;
  await window.mouse.move(gap.x + 40, y);
  await window.mouse.move(gap.x + 4, y, { steps: 6 });
  await window.mouse.down();
  await window.mouse.move(gap.x + 44, y, { steps: 6 });
  await window.mouse.up();
  await expect.poll(() => widthOf(sidebar)).toBe(288);
  expect((await boxOf(card)).x).toBe(296);

  // Focused, the arrow keys move it, as before.
  await rod.focus();
  await window.keyboard.press("ArrowLeft");
  await expect.poll(() => widthOf(sidebar)).toBe(278);
  await app.close();
});

test("the + menu in the sidebar header offers New note, Add Documents…, New Folder, Record a meeting and More, with the rest under More, by mouse and by keyboard", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const plus = window.getByTestId("plus-menu");
  const menu = window.getByRole("menu", { name: "New or add" });
  const more = window.getByRole("menu", { name: "More" });

  // It sits at the header's right end, 28px, with a name for a screen reader.
  const header = await boxOf(window.getByTestId("sidebar-header"));
  const button = await boxOf(plus);
  expect(button).toMatchObject({ width: 28, height: 28 });
  expect(button.x + button.width).toBe(header.x + header.width - 8);
  await expect(plus).toHaveAccessibleName("New or add");
  await expect(plus).toHaveAttribute("aria-haspopup", "menu");

  // Opened by the mouse, its five rows are menu items, each with its keys, and the first has the focus.
  await window.mouse.move(button.x - 40, button.y + 14);
  await window.mouse.move(button.x + 14, button.y + 14, { steps: 6 });
  await window.mouse.down();
  await window.mouse.up();
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveText([
    /New note/,
    /Add Documents…/,
    /New Folder/,
    /Record a meeting/,
    /More/,
  ]);
  const mod = process.platform === "darwin" ? "⌘" : "Ctrl+";
  await expect(items.nth(0)).toContainText(`${mod}T`);
  await expect(items.nth(1)).toContainText(`${mod}O`);
  await expect(items.first()).toBeFocused();
  await expect(plus).toHaveAttribute("aria-expanded", "true");
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "shell-menu-en.png") });

  // More opens beside it as the pointer comes onto it, with the rest.
  await items.nth(4).hover();
  await expect(more).toBeVisible();
  await expect(more.getByRole("menuitem")).toHaveText([
    /Import a Word file…/,
    /Voice memo/,
    /Compare Documents…/,
    /Verify a document…/,
    /From starter Folders…/,
    /Add a web page…/,
    /Find sources…/,
    /Link a folder…/,
  ]);

  // The arrow keys, Home and End move between the rows; → opens More, ← closes it; Esc closes the
  // menu and returns to "+".
  await items.first().focus();
  await window.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await window.keyboard.press("End");
  await expect(items.nth(4)).toBeFocused();
  await window.keyboard.press("ArrowRight");
  await expect(more.getByRole("menuitem").first()).toBeFocused();
  await window.keyboard.press("ArrowLeft");
  await expect(more).toBeHidden();
  await expect(items.nth(4)).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(plus).toBeFocused();

  // From the keyboard alone: Enter opens it, Enter on New note makes a Mind named by typing.
  await window.keyboard.press("Enter");
  await expect(items.first()).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await enterContent(window);
  await window.keyboard.type("From the menu");
  await expect(window.getByTestId("mind-tab").getByTestId("tab-title")).toHaveText([
    "From the menu",
  ]);

  // Add Documents… opens the system's picker and adds what is chosen.
  const notes = join(sources, "Field notes.txt");
  await writeFile(notes, "Tea is picked by hand in spring.\n");
  await interceptOpenDialog(app, notes);
  await plus.focus();
  await window.keyboard.press("Enter");
  await expect(items.first()).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("document-list-item")).toHaveCount(1);

  // More › Link a folder… asks first, as "Add folder…" does.
  const folder = join(sources, "Library");
  await mkdir(folder);
  await writeFile(join(folder, "Brew.txt"), "Water at eighty degrees.\n");
  await plus.focus();
  await window.keyboard.press("Enter");
  await expect(items.first()).toBeFocused();
  await window.keyboard.press("End");
  await window.keyboard.press("Enter");
  await expect(more.getByRole("menuitem").first()).toBeFocused();
  await window.keyboard.press("End");
  await expect(more.getByRole("menuitem").last()).toBeFocused();
  const dialog = await previewLink(app, window, folder, more.getByRole("menuitem").last());
  await confirmLink(dialog);
  await expect(linkedFolderRow(window, "Library")).toHaveCount(1);
  await app.close();
});

test("the + menu and the shell speak Chinese too", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: "zh-CN" } });
  });
  const plus = window.getByTestId("plus-menu");
  await expect(plus).toHaveAccessibleName("新建或添加");
  await plus.click();
  await expect(window.getByRole("menuitem")).toHaveText([
    /新建笔记/,
    /添加文档…/,
    /新建文件夹/,
    /录制会议/,
    /更多/,
  ]);
  await window.getByTestId("plus-more").hover();
  await expect(window.getByRole("menu", { name: "更多" }).getByRole("menuitem")).toHaveText([
    /导入 Word 文件…/,
    /语音备忘/,
    /对比文档…/,
    /核对文档…/,
    /从预设文件夹新建…/,
    /添加网页…/,
    /查找资料…/,
    /添加同步文件夹…/,
  ]);
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "shell-zh-menu.png") });
  await window.keyboard.press("Escape");
  await window.getByTestId("plus-menu").focus();
  await window.keyboard.press("Enter");
  await expect(window.getByRole("menuitem").first()).toBeFocused();
  await window.keyboard.press("Enter");
  await enterContent(window);
  await window.keyboard.type("茶叶的产地");
  await window.getByTestId("new-tab").click();
  await enterContent(window);
  await window.keyboard.type("访谈提纲");
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "shell-zh.png") });
  await app.close();
});
