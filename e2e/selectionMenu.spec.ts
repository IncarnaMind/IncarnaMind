import { expect, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  slideSelect,
  wordsBox,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const selectedText = (window: Page) => window.evaluate(() => globalThis.getSelection()?.toString());

/** Selects the last `count` letters of the line the cursor is on, with Shift+Left. */
async function shiftSelectBack(window: Page, count: number) {
  await window.keyboard.press("End");
  for (let index = 0; index < count; index++) await window.keyboard.press("Shift+ArrowLeft");
}

test("selecting text with the mouse or the keyboard opens a menu: Turn into, formatting, and Undo", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Spring tides are strongest at new moon");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Neap tides are the weakest");
  await window.keyboard.press("Enter");
  await window.keyboard.type("A plain closing line");
  const menu = window.getByTestId("selection-menu");
  const turnInto = window.getByTestId("selection-turn-into");
  const paragraphs = editor.locator("p");
  await expect(menu).toHaveCount(0);

  // Sliding the mouse over words opens the menu under them, once the button is let go.
  await slideSelect(window, paragraphs.nth(0), "Spring tides are strongest");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("role", "menu");
  expect(await selectedText(window)).toContain("Spring tides");
  const under = await menu.boundingBox();
  const line = await paragraphs.nth(0).boundingBox();
  if (!under || !line) throw new Error("The menu or the line isn't visible.");
  expect(under.y).toBeGreaterThanOrEqual(line.y + line.height - 2);

  // Turn into a heading by mouse: Text › Heading 2.
  await turnInto.hover();
  await turnInto.click();
  const turnMenu = window.getByTestId("selection-turn-into-menu");
  await expect(turnMenu).toBeVisible();
  await window.getByTestId("turn-into-heading-2").hover();
  await window.getByTestId("turn-into-heading-2").click();
  await expect(editor.locator("h2")).toHaveText("Spring tides are strongest at new moon");
  await expect(turnMenu).toHaveCount(0);
  await expect(turnInto).toContainText("Heading 2");

  // Undo takes the whole change back.
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(editor.locator("h2")).toHaveCount(0);
  await expect(paragraphs.nth(0)).toHaveText("Spring tides are strongest at new moon");

  // Bold by mouse, shown as pressed; Undo takes it off.
  await slideSelect(window, paragraphs.nth(0), "strongest");
  await expect(menu).toBeVisible();
  await window.getByTestId("format-bold").hover();
  await window.getByTestId("format-bold").click();
  await expect(paragraphs.nth(0).locator("strong")).toHaveText("strongest");
  await expect(window.getByTestId("format-bold")).toHaveAttribute("aria-checked", "true");
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(paragraphs.nth(0).locator("strong")).toHaveCount(0);

  // The menu sits over the lines below: Esc puts it away to click one.
  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Shift+arrows open it too; ⌘/ moves into it, and the arrows choose: Text › Bulleted list.
  await paragraphs.nth(1).click();
  await shiftSelectBack(window, "weakest".length);
  await expect(menu).toBeVisible();
  expect(await selectedText(window)).toBe("weakest");
  await window.keyboard.press("ControlOrMeta+/");
  await expect(turnInto).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(turnMenu).toBeVisible();
  await expect(window.getByTestId("turn-into-text")).toBeFocused();
  for (let step = 0; step < 4; step++) await window.keyboard.press("ArrowDown");
  await expect(window.getByTestId("turn-into-bullet-list")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(editor.locator("ul li")).toHaveText("Neap tides are the weakest");
  await expect(editor).toBeFocused();
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(editor.locator("ul")).toHaveCount(0);

  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Underline from the keyboard: ⌘/, then the arrows to its button (past Aa, B and I), then Enter.
  await paragraphs.nth(2).click();
  await shiftSelectBack(window, "closing line".length);
  await expect(menu).toBeVisible();
  await window.keyboard.press("ControlOrMeta+/");
  await expect(turnInto).toBeFocused();
  for (let step = 0; step < 4; step++) await window.keyboard.press("ArrowDown");
  await expect(window.getByTestId("format-underline")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(paragraphs.nth(2).locator("u")).toHaveText("closing line");
  await expect(window.getByTestId("format-underline")).toHaveAttribute("aria-checked", "true");

  // Esc closes the innermost thing: the Turn into list, then the menu, and the cursor is back in the text.
  await expect(menu).toBeVisible();
  await window.keyboard.press("ControlOrMeta+/");
  await expect(turnInto).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(turnMenu).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(turnMenu).toHaveCount(0);
  await expect(menu).toBeVisible();
  await expect(turnInto).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(editor).toBeFocused();

  // With the cursor still in the text, Esc closes the menu too, and the words stay selected.
  await slideSelect(window, paragraphs.nth(1), "Neap");
  await expect(menu).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  expect(await selectedText(window)).toContain("Neap");
  await app.close();
});

test("after Esc puts the menu away, a right-click or a shift-click on the same words leaves it away, and selecting them again opens it", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Spring tides are strongest at new moon");
  const menu = window.getByTestId("selection-menu");
  const line = editor.locator("p").first();

  await slideSelect(window, line, "strongest");
  await expect(menu).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // The menu shows a moment after the button is up: run the page's clock past it, so "it stays
  // away" is checked, not only "it hasn't opened yet".
  await window.clock.install();
  const box = await wordsBox(line, "strongest");
  await window.mouse.move(box.left + 8, box.y, { steps: 3 });
  await window.mouse.click(box.left + 8, box.y, { button: "right" });
  await window.clock.runFor(500);
  expect(await selectedText(window)).toBe("strongest");
  await expect(menu).toHaveCount(0);

  // A shift-click on the end of the words keeps the selection the same.
  await window.mouse.move(box.right, box.y, { steps: 3 });
  await window.keyboard.down("Shift");
  await window.mouse.click(box.right, box.y);
  await window.keyboard.up("Shift");
  await window.clock.runFor(500);
  expect(await selectedText(window)).toBe("strongest");
  await expect(menu).toHaveCount(0);
  await window.clock.resume();

  // Selecting the same words again is the User's own selection: the menu opens. A person starts
  // the drag beside them: a press inside words that are still selected drags them, so the
  // selection doesn't move.
  await window.mouse.click(box.left - 6, box.y);
  await slideSelect(window, line, "strongest");
  await expect(menu).toBeVisible();
  await app.close();
});

test("a Chinese input method composing over a selection doesn't fire the menu's actions", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Tides follow the moon");
  const menu = window.getByTestId("selection-menu");
  await shiftSelectBack(window, "the moon".length);
  await expect(menu).toBeVisible();

  const session = await window.context().newCDPSession(window);
  try {
    // The input method takes the selection and holds "chao" as it composes.
    await session.send("Input.imeSetComposition", {
      text: "chao",
      selectionStart: 4,
      selectionEnd: 4,
    });
    await window.getByTestId("format-bold").click({ force: true, trial: true });
    await window.keyboard.press("ControlOrMeta+/");
    await expect(editor.locator("p")).toContainText("chao");
    await expect(editor.locator("strong")).toHaveCount(0);
    await expect(window.getByTestId("selection-turn-into")).not.toBeFocused();

    // It commits Chinese text: the menu doesn't reopen over a collapsed cursor.
    await session.send("Input.insertText", { text: "潮汐" });
    await expect(editor.locator("p")).toHaveText("Tides follow 潮汐");
    await expect(menu).toHaveCount(0);
  } finally {
    await session.detach();
  }
  await app.close();
});
