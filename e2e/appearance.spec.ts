import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Light, Dark or Same as system (#1262): Settings › General › Appearance and ⌘K's Switch theme
 * change the theme at once and keep it; Same as system follows the system's change live; and a
 * launch in Dark paints its first frame dark. A Document's page stays paper-white in both.
 * The colours are the sheet's and the frame's tokens in each theme (styles.css).
 */

const SHEET = { light: "rgb(255, 255, 255)", dark: "rgb(30, 32, 36)" } as const;
const FRAME_HEX = { light: "#F4F5F7", dark: "#141518" } as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** The page's own background: the sheet, in the theme it shows. */
const pageColour = (window: Page) =>
  window.evaluate(() => getComputedStyle(document.body).backgroundColor);

const keptAppearance = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.getSettings()).device.appearance;
  });

const electronTheme = (app: ElectronApplication) =>
  app.evaluate(({ nativeTheme }) => ({
    source: nativeTheme.themeSource,
    dark: nativeTheme.shouldUseDarkColors,
  }));

const choice = (settings: Locator, name: string) =>
  settings.getByTestId("appearance-settings").getByRole("radio", { name, exact: true });

for (const language of ["en", "zh-CN"] as const) {
  const words =
    language === "en"
      ? { light: "Light", dark: "Dark", system: "Same as system", title: "Appearance" }
      : { light: "浅色", dark: "深色", system: "跟随系统", title: "外观" };

  test(`choosing Dark in Settings switches the theme at once and keeps it, then Light and Same as system (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1100, 720);
      await dismissChatSetup(window);
      const settings = await openSettings(window, "general");
      await setLanguage(window, language);
      await expect(settings.getByTestId("appearance-settings")).toContainText(words.title);
      await expect(choice(settings, words.system)).toBeChecked();
      expect(await pageColour(window)).toBe(SHEET.light);

      await choice(settings, words.dark).click();
      await expect(window.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect.poll(() => pageColour(window)).toBe(SHEET.dark);
      await expect(choice(settings, words.dark)).toBeChecked();
      await expect.poll(() => keptAppearance(window)).toBe("dark");
      // Native menus, scrollbars and dialogs follow: Electron is told.
      await expect.poll(() => electronTheme(app)).toEqual({ source: "dark", dark: true });

      await choice(settings, words.light).click();
      await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
      await expect.poll(() => pageColour(window)).toBe(SHEET.light);
      await expect.poll(() => keptAppearance(window)).toBe("light");

      await choice(settings, words.system).click();
      await expect(window.locator("html")).not.toHaveAttribute("data-theme");
      await expect.poll(() => keptAppearance(window)).toBe("system");
      await expect.poll(() => electronTheme(app).then((theme) => theme.source)).toBe("system");
      await window.keyboard.press("Escape");
      await expect(settings).toBeHidden();
    } finally {
      await app.close();
    }
  });
}

test("⌘K's Switch theme turns the window dark, and back", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 720);
    await dismissChatSetup(window);
    await runCommand(window, "appearance.switch", "Switch theme");
    await expect(window.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => pageColour(window)).toBe(SHEET.dark);
    await expect.poll(() => keptAppearance(window)).toBe("dark");

    await runCommand(window, "appearance.switch", "Switch theme");
    await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(() => pageColour(window)).toBe(SHEET.light);
  } finally {
    await app.close();
  }
});

test("Same as system follows the system's change live, and a choice holds against it", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 720);
    await dismissChatSetup(window);
    expect(await pageColour(window)).toBe(SHEET.light);

    await window.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => pageColour(window)).toBe(SHEET.dark);
    await window.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => pageColour(window)).toBe(SHEET.light);

    // Light, chosen, stays light when the system turns dark; so does a Document's page in Dark.
    const settings = await openSettings(window, "general");
    await choice(settings, "Light").click();
    await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
    await window.emulateMedia({ colorScheme: "dark" });
    await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await pageColour(window)).toBe(SHEET.light);

    // The system's Increase contrast still applies in Dark: the rules are stronger.
    await choice(settings, "Dark").click();
    await expect.poll(() => pageColour(window)).toBe(SHEET.dark);
    const rule = () =>
      window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--color-rule").trim(),
      );
    const usual = await rule();
    await window.emulateMedia({ contrast: "more" });
    await expect.poll(rule).not.toBe(usual);
    await closeSettings(window);
  } finally {
    await app.close();
  }
});

test("a relaunch in Dark paints its first frame dark, before the page's script runs", async () => {
  const first = await launchApp(dataDir);
  try {
    await dismissChatSetup(first.window);
    const settings = await openSettings(first.window, "general");
    await choice(settings, "Dark").click();
    await expect.poll(() => keptAppearance(first.window)).toBe("dark");
  } finally {
    await first.app.close();
  }

  // The pages see the system's light or dark as Electron gives it, as the User's computer does.
  const { app, window } = await launchApp(dataDir, { systemColours: true, keepWindow: true });
  try {
    // What the window shows before its page has painted: the dark frame, not a light one.
    const background = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((each) => each.isVisible())
        .map((each) => each.getBackgroundColor().toUpperCase()),
    );
    expect(background).toEqual([FRAME_HEX.dark]);
    expect(await electronTheme(app)).toEqual({ source: "dark", dark: true });
    // The style sheet alone paints it dark, as the first frame does before any script runs:
    // with the page's own choice taken off, the system's colours, which Electron took from the
    // kept choice before the window opened, are already dark.
    const painted = await window.evaluate(() => {
      const root = document.documentElement;
      const chosen = root.dataset.theme;
      delete root.dataset.theme;
      const seen = {
        prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
        sheet: getComputedStyle(document.body).backgroundColor,
      };
      if (chosen) root.dataset.theme = chosen;
      return seen;
    });
    expect(painted).toEqual({ prefersDark: true, sheet: SHEET.dark });
  } finally {
    await app.close();
  }
});
