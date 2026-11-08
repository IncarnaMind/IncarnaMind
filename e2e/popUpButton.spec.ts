import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Settings' pop-up buttons (src/renderer/src/components/settings/PopUpButton.tsx): a choice among a
 * few options at a row's right end. Read through the language row: it opens with Space, Enter and
 * the arrows, the arrows move through its options, Esc closes it with the focus back on the button,
 * and a screen reader hears the row's label and the chosen option on a button with a menu.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const language = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.getSettings()).user.language;
  });

/** Tabs from the page list until `target` has the focus, as a keyboard User reaches it. */
async function tabTo(window: Page, target: Locator): Promise<void> {
  await window.getByTestId("settings-nav-general").focus();
  for (let presses = 0; presses < 30; presses++) {
    await window.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("Tab never reached the pop-up button.");
}

test("a pop-up button is reached by Tab with its focus ring, opens with Space and the arrows, and chooses with Enter", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    await setWindowSize(app, window, 1100, 800);
    const settings = await openSettings(window, "general");
    const row = settings.getByTestId("language-settings");
    const choice = row.getByTestId("language-choice");
    const menu = row.getByTestId("language-choice-menu");
    const option = (name: string) => row.getByRole("menuitemradio", { name, exact: true });

    // What a screen reader says: the row's label and the chosen option, on a button that has a menu.
    await expect(choice).toHaveAttribute("aria-haspopup", "menu");
    await expect(choice).toHaveAttribute("aria-expanded", "false");
    await expect(choice).toHaveAccessibleName("Interface language English");

    await tabTo(window, choice);
    await expect(choice).toHaveCSS("outline-style", "solid");
    await expect(choice).toHaveCSS("outline-width", "2px");

    // Space opens it with the chosen option focused; the arrows move; Esc closes it, focus back.
    await window.keyboard.press("Space");
    await expect(menu).toBeVisible();
    await expect(choice).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByRole("menuitemradio")).toHaveText([
      "Same as system",
      "English",
      "简体中文",
    ]);
    await expect(option("English")).toBeChecked();
    await expect(option("English")).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await expect(option("Same as system")).toBeFocused();
    await window.keyboard.press("End");
    await expect(option("简体中文")).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(settings).toBeVisible();
    await expect(choice).toBeFocused();
    expect(await language(window)).toBe("en");

    // ArrowDown opens it too, and Enter on an option chooses it.
    await window.keyboard.press("ArrowDown");
    await expect(menu).toBeVisible();
    await window.keyboard.press("ArrowDown");
    await expect(option("简体中文")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(choice).toHaveText("简体中文");
    await expect(choice).toHaveAccessibleName("界面语言 简体中文");
    expect(await language(window)).toBe("zh-CN");
    await expect(choice).toBeFocused();

    // ArrowUp opens it as well, and Space chooses.
    await window.keyboard.press("ArrowUp");
    await expect(option("简体中文")).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await expect(option("English")).toBeFocused();
    await window.keyboard.press("Space");
    await expect(choice).toHaveText("English");
    expect(await language(window)).toBe("en");
  } finally {
    await app.close();
  }
});

test("a pop-up button opens with a click, and a click outside or choosing the shown option changes nothing", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    await setWindowSize(app, window, 900, 800);
    const settings = await openSettings(window, "general");
    const row = settings.getByTestId("language-settings");
    const choice = row.getByTestId("language-choice");
    const menu = row.getByTestId("language-choice-menu");

    await choice.click();
    await expect(menu).toBeVisible();
    await row.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await expect(menu).toBeHidden();
    expect(await language(window)).toBe("en");

    await choice.click();
    await expect(menu).toBeVisible();
    await settings.getByTestId("settings-page-title").click();
    await expect(menu).toBeHidden();
    await expect(settings).toBeVisible();
    expect(await language(window)).toBe("en");
  } finally {
    await app.close();
  }
});
