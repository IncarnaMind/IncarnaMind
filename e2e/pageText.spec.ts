import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { countFor, countText } from "../src/shared/wordCount";
import {
  createDataFolder,
  dismissChatSetup,
  enterContent,
  focusSettled,
  launchApp,
  motionSettled,
  newMind,
  openPageMenu,
  pageMenuButton,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  WORD_KEY,
} from "./app";

/*
 * A Mind's page holds only its text (#908; DESIGN.md › A Mind's page: only its
 * text): no title field and nothing above the text, a ⋯ at the page's top
 * right with the Mind's menu and, at its foot, the counts. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots of it.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** What is drawn on the page above its text, by class or tag: nothing, when nothing needs the User. */
const drawnAboveText = (window: Page) =>
  window.getByTestId("mind-pane").evaluate((pane) => {
    const editor = pane.querySelector('[data-testid="mind-editor"]');
    if (!editor) throw new Error("No text on the page.");
    const top = editor.getBoundingClientRect().top;
    return [...pane.querySelectorAll("*")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        // A screen reader's words take a pixel and show nothing.
        return box.height > 1 && box.bottom <= top && !element.contains(editor);
      })
      .map((element) => element.className || element.tagName);
  });

const menuItemIds = (menu: Locator) =>
  menu
    .locator('[role="menuitem"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-testid") ?? ""));

test("the page starts with its text; the ⋯ at its top right opens by click and by keyboard, in the sidebar row's order, with the counts at its foot", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  await enterContent(window);
  await expect.poll(() => drawnAboveText(window)).toEqual([]);

  const text = "The tide turns at noon";
  await window.keyboard.type(text);

  // At the page's top right, labelled for the Mind, and it stays while the text scrolls.
  const button = pageMenuButton(window);
  await expect(button).toHaveAccessibleName("More for The tide turns at noon");
  const pane = await window.getByTestId("mind-pane").boundingBox();
  const at = await button.boundingBox();
  if (!pane || !at) throw new Error("Not laid out.");
  expect(at.width).toBeCloseTo(28, 0);
  expect(at.x).toBeGreaterThan(pane.x + pane.width / 2);
  for (let line = 0; line < 60; line++) await window.keyboard.press("Enter");
  await window.keyboard.type("The last line.");
  expect((await button.boundingBox())?.y).toBeCloseTo(at.y, 0);

  // Its menu is the sidebar row's, in the same order, with Style as a submenu before Delete, then the counts.
  const menu = await openPageMenu(window);
  const pageItems = await menuItemIds(menu);
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  const row = window.getByTestId("mind-row");
  await row.hover();
  await row.getByTestId("mind-menu").click();
  const rowItems = await menuItemIds(row.getByTestId("mind-actions"));
  await window.keyboard.press("Escape");
  expect(pageItems.length).toBeGreaterThan(5);
  // Minus what only the row offers (opening a Mind that is open), with Style before Delete, which is last.
  const shared = rowItems.filter((id) => !["mind.style", "mind.open", "mind.openTab"].includes(id));
  expect(pageItems).toEqual([...shared.slice(0, -1), "page-style", "mind.delete"]);

  // Its Rename names the Mind in its tab, and its text stays as it is.
  await pointAndClick(window, (await openPageMenu(window)).getByTestId("mind.rename"));
  const field = window.getByTestId("tab-rename");
  await expect(field).toBeFocused();
  await field.fill("Tide notes");
  await field.press("Enter");
  await expect(button).toHaveAccessibleName("More for Tide notes");
  await expect(window.getByTestId("mind-editor").locator("p").first()).toHaveText(text);

  // By keyboard: Enter on the button, the first item focused; the counts at the foot.
  await button.focus();
  await window.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(menu.locator('[role="menuitem"]').first()).toBeFocused();
  const counts = menu.getByTestId("page-counts");
  const lines = countText(`${text}\nThe last line.`);
  await expect(counts).toHaveText(
    `${countFor(lines, "words")} words · ${countFor(lines, "characters")} characters`,
  );
  await expect(menu.getByTestId("page-count-shown")).toHaveText("Show word count while writing");
  await expect(menu.getByTestId("page-count-shown")).toHaveAttribute("aria-checked", "false");
  await expect(counts).toBeInViewport();
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, "page-menu-en-1440.png") });
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(window.getByTestId("mind-count")).toHaveCount(0);

  // The selection's count of the whole.
  await window.getByTestId("mind-editor").locator("p").first().click();
  await focusSettled(window, window.getByTestId("mind-editor"));
  await window.keyboard.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");
  await window.keyboard.press(`Shift+${WORD_KEY}+ArrowRight`);
  await window.keyboard.press(`Shift+${WORD_KEY}+ArrowRight`);
  await openPageMenu(window);
  await expect(counts).toHaveText(
    `2 of ${countFor(lines, "words")} words · 8 of ${countFor(lines, "characters")} characters`,
  );

  // ⌘K reaches the switch too: the count shows at the page's bottom left.
  await window.keyboard.press("Escape");
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("word count while writing");
  await pointAndClick(
    window,
    window.getByTestId("palette-item").filter({ hasText: "Show word count while writing" }).first(),
  );
  await expect(window.getByTestId("mind-count-button")).toBeVisible();
  await openPageMenu(window);
  await expect(menu.getByTestId("page-count-shown")).toHaveAttribute("aria-checked", "true");
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  // The window's narrowest, 900px, leaves the page about 600px beside the sidebar and the assistant.
  for (const width of [1100, 900]) {
    test(`the page and its ⋯ hold at ${width}px in ${language}, the counts in the language's words`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, width, 760);
      await newMind(window);
      await enterContent(window);
      const text = language === "en" ? "Spring tides come twice a month." : "潮水每天涨落两次。";
      await window.keyboard.type(text);
      await expect.poll(() => drawnAboveText(window)).toEqual([]);

      const menu = await openPageMenu(window);
      const counted = countText(text);
      const words = countFor(counted, "words");
      const characters = countFor(counted, "characters");
      await expect(menu.getByTestId("page-counts")).toHaveText(
        language === "en"
          ? `${words} words · ${characters} characters`
          : `字数 ${words} · 字符数 ${characters}`,
      );
      await expect(menu.getByTestId("page-count-shown")).toHaveText(
        language === "en" ? "Show word count while writing" : "写作时显示字数",
      );
      // The menu and the button stay inside the window, and nothing scrolls sideways.
      const [box, button] = await Promise.all([
        menu.boundingBox(),
        pageMenuButton(window).boundingBox(),
      ]);
      if (!box || !button) throw new Error("Not laid out.");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(button.x + button.width).toBeLessThanOrEqual(width);
      expect(await window.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      if (SCREENSHOTS)
        await window.screenshot({ path: join(SCREENSHOTS, `page-menu-${language}-${width}.png`) });

      // Style, with its value, opens its choices beside the menu, inside the window.
      const style = menu.getByTestId("page-style");
      await expect(style).toContainText(language === "en" ? "StyleDefault" : "样式默认");
      await pointAt(window, style);
      const choices = window.getByTestId("page-style-menu");
      await expect(choices).toBeVisible();
      await motionSettled(window);
      const beside = await choices.boundingBox();
      if (!beside) throw new Error("Style's choices aren't laid out.");
      expect(beside.x).toBeGreaterThanOrEqual(0);
      expect(beside.x + beside.width).toBeLessThanOrEqual(width);
      expect(beside.y + beside.height).toBeLessThanOrEqual(760);
      if (SCREENSHOTS)
        await window.screenshot({ path: join(SCREENSHOTS, `page-style-${language}-${width}.png`) });
      await app.close();
    });
  }
}

test("Style › in the page's ⋯ opens its choices beside it by pointer and by keyboard; a choice shows on the page at once, and Other fonts… opens the list", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  await enterContent(window);
  await window.keyboard.type("Spring tides come at new moon");
  const paragraph = window.getByTestId("mind-editor").locator("p").first();
  const familyOf = () => paragraph.evaluate((element) => getComputedStyle(element).fontFamily);
  const before = await familyOf();

  // By pointer: Serif changes the page at once, and the item says so; the menu stays for the next choice.
  const menu = await openPageMenu(window);
  const style = menu.getByTestId("page-style");
  await pointAt(window, style);
  const choices = window.getByTestId("page-style-menu");
  await expect(choices).toBeVisible();
  await pointAndClick(window, choices.getByTestId("mind-style-font-serif"));
  await expect.poll(familyOf).toMatch(/Source Serif 4/);
  await expect(choices.getByTestId("mind-style-font-serif")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(style).toContainText("Serif");
  await expect(window.getByTestId("undo-line")).toContainText("Font changed to Serif");
  await window.keyboard.press("Escape");
  await expect(choices).toBeHidden();
  await expect(style).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await pointAndClick(window, window.getByTestId("undo-action"));
  await expect.poll(familyOf).toBe(before);

  // By keyboard: → on Style opens its choices with the first focused; ← goes back.
  await pageMenuButton(window).focus();
  await window.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  // Its counts come a moment later, and until a key or the pointer touches the menu it moves the focus back to its first item.
  await expect(menu.getByTestId("page-counts")).toBeVisible();
  await style.focus();
  await window.keyboard.press("ArrowRight");
  await expect(choices).toBeVisible();
  await expect(choices.getByTestId("mind-style-font-default")).toBeFocused();
  await window.keyboard.press("ArrowLeft");
  await expect(choices).toBeHidden();
  await expect(style).toBeFocused();

  // Other fonts… closes the menu and opens the list of fonts beside the ⋯.
  await pointAt(window, style);
  await expect(choices).toBeVisible();
  await pointAndClick(window, choices.getByTestId("mind-style-other-fonts"));
  const picker = window.getByTestId("mind-style-font-picker");
  await expect(picker).toBeVisible();
  await expect(menu).toBeHidden();
  await window.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await app.close();
});
