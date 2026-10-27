import { expect, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  motionSettled,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Esc out of an overlay leaves the field behind it able to type (#2107).
 * Chromium gives a text field the focus back when an overlay over it closes,
 * but not its caret, so the word typed next went nowhere. The palette, the
 * popover menus and the dialogs take and give back the focus through one
 * helper now, and every check below runs in English and Simplified Chinese.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("Esc out of the editor's ⌘K still types: the whole word lands in the Note", async () => {
  for (const [language, word] of [
    ["en", "harvest"],
    ["zh-CN", "调查"],
  ] as const) {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1280, 660);
    await dismissChatSetup(window);
    await newMind(window);
    await enterContent(window);
    await window.keyboard.type("Alpha");
    if (language !== "en") await setLanguage(window, language);

    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("palette")).toBeHidden();
    await enterContent(window);
    await window.keyboard.type(word);
    await expect(window.getByTestId("mind-editor")).toHaveText(`Alpha${word}`);
    await app.close();
  }
});

test("Esc out of ⌘K leaves the composer able to type, with the caret it had", async () => {
  for (const [language, word] of [
    ["en", "harvest"],
    ["zh-CN", "调查"],
  ] as const) {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1280, 660);
    await dismissChatSetup(window);
    await newMind(window);
    const composer = window.getByTestId("composer-input");
    await composer.click();
    await window.keyboard.type("first ");
    await window.keyboard.press("End");
    await expect(composer).toHaveValue("first ");
    if (language !== "en") await setLanguage(window, language);

    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("palette")).toBeHidden();
    // The field looks focused, as it did before: what the keys do is the point.
    await expect(composer).toBeFocused();

    await window.keyboard.type(word);
    await expect(composer).toHaveValue(`first ${word}`);
    await app.close();
  }
});

test("Esc out of the popover with no chip in the band leaves the composer able to type", async () => {
  for (const [language, command, word] of [
    ["en", "Show Tasks", "harvest"],
    ["zh-CN", "xianshi renwu", "调查"],
  ] as const) {
    const { app, window } = await launchApp(dataDir, { fakeChat: true, scriptedTasks: true });
    await setWindowSize(app, window, 1280, 660);
    await dismissChatSetup(window);
    await newMind(window);
    const composer = window.getByTestId("composer-input");
    await composer.click();
    await expect(composer).toBeFocused();
    if (language !== "en") await setLanguage(window, language);

    // Show Tasks opens the popover even with nothing running, from the band's corner.
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type(command);
    await window.keyboard.press("Enter");
    const popover = window.getByTestId("tasks-popover");
    await expect(popover).toBeVisible();
    await expect(window.getByTestId("tasks-chip")).toHaveCount(0);

    await window.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await motionSettled(window);
    await expect(composer).toBeFocused();

    await window.keyboard.type(word);
    await expect(composer).toHaveValue(word);
    await app.close();
  }
});

test("Esc out of a ⋯ menu gives the focus back to the row it was opened from, in both languages", async () => {
  for (const language of ["en", "zh-CN"] as const) {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1280, 660);
    await dismissChatSetup(window);
    await newMind(window);
    if (language !== "en") await setLanguage(window, language);

    const mind = window.getByTestId("mind-row").first();
    const row = mind.getByTestId("mind-list-item");
    const menu = mind.getByTestId("mind-actions");
    await row.focus();
    await expect(row).toBeFocused();
    await window.keyboard.press("Shift+F10");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("mind.open")).toBeFocused();

    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(row).toBeFocused();
    // The row takes the keys again: the menu opens from it once more.
    await window.keyboard.press("Shift+F10");
    await expect(menu).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await app.close();
  }
});
