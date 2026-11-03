import { expect, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * New note is ⌘T on every surface that shows its keys: the + menu, the tab strip's + and ⌘K.
 * ⌘N, which people expect, still makes one, though nothing shows it.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const KEYS = /^(⌘T|Ctrl\+T)$/;

for (const language of ["en", "zh-CN"] as const) {
  test(`every surface shows ⌘T for New note, and ⌘N still works (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    const minds = window.getByTestId("mind-list-item");

    // The + menu.
    await pointAndClick(window, window.getByTestId("plus-menu"));
    await expect(window.getByTestId("plus-new-mind").locator("span").last()).toHaveText(KEYS);
    await window.keyboard.press("Escape");

    // ⌘T makes a Mind, and the tab strip's + shows it in its tooltip.
    await window.keyboard.press("ControlOrMeta+t");
    await expect(minds).toHaveCount(1);
    await expect(window.getByTestId("new-tab")).toHaveAttribute("title", /(⌘T|Ctrl\+T)/);

    // ⌘K lists New note with ⌘T.
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette")).toBeVisible();
    await window.keyboard.type(language === "en" ? "New note" : "新建笔记");
    const entry = window.getByTestId("palette-item").first();
    await expect(entry).toContainText(/(⌘T|Ctrl\+T)/);
    await expect(entry).not.toContainText(/(⌘N|Ctrl\+N)/);
    await window.keyboard.press("Escape");

    // ⌘N still makes a Mind.
    await window.keyboard.press("ControlOrMeta+n");
    await expect(minds).toHaveCount(2);
    await app.close();
  });
}
