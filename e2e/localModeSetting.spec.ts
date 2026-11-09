import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const localOnly = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.getEmbeddingSettings()).localOnly;
  });

const TURNED_ON = {
  en: "Turned on “Keep everything on this computer”",
  "zh-CN": "已开启“所有内容都留在这台电脑上”",
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`“Keep everything on this computer” is in Settings › AI › Limits, and Privacy links there; turning it on offers Undo under it (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 720);
    await setLanguage(window, language);
    await window.getByRole("button", { name: language === "en" ? "Settings" : "设置" }).click();
    const settings = window.getByTestId("settings");

    // Privacy keeps the consent record, and a link where the switch went.
    await showSettingsPage(window, "privacy");
    const privacy = settings.getByTestId("settings-page-privacy");
    await expect(privacy.getByTestId("local-only")).toHaveCount(0);
    await pointAndClick(window, privacy.getByTestId("local-mode-moved-link"));
    await expect(settings).toHaveAttribute("data-page", "ai");
    const limits = settings.getByTestId("ai-limits");
    const setting = limits.getByTestId("local-only-setting");
    await expect(setting.getByTestId("local-only")).toBeFocused();
    for (const other of ["general", "meetings"] as const) {
      await showSettingsPage(window, other);
      await expect(
        settings.getByTestId(`settings-page-${other}`).getByTestId("local-only"),
      ).toHaveCount(0);
    }
    await showSettingsPage(window, "ai");

    await pointAndClick(window, setting.getByTestId("local-only"));
    await expect.poll(() => localOnly(window)).toBe(true);
    const undo = setting.getByTestId("undo-line-here");
    await expect(undo.getByTestId("undo-message")).toHaveText(TURNED_ON[language]);
    await expect(window.getByTestId("undo-line").getByTestId("undo-message")).toHaveCount(0);
    await pointAndClick(window, undo.getByTestId("undo-action"));
    await expect.poll(() => localOnly(window)).toBe(false);
    await expect(setting.getByTestId("local-only")).not.toBeChecked();
    await app.close();
  });
}

test("typing “local” in ⌘K finds it and opens Settings › AI at its switch, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  for (const [language, typed, label] of [
    ["en", "local", "Keep everything on this computer"],
    ["zh-CN", "本地", "所有内容都留在这台电脑上"],
  ] as const) {
    await setLanguage(window, language);
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type(typed);
    const found = window.getByTestId("palette-item").filter({ hasText: label });
    await expect(found).toHaveCount(1);
    await window.keyboard.press("Enter");
    const settings = window.getByTestId("settings");
    await expect(settings).toHaveAttribute("data-page", "ai");
    await expect(settings.getByTestId("local-only")).toBeFocused();
    // Space turns it on or off, and the focus stays on it.
    const before = await localOnly(window);
    await window.keyboard.press("Space");
    await expect.poll(() => localOnly(window)).toBe(!before);
    await expect(settings.getByTestId("local-only")).toBeFocused();
    await settings.getByTestId("settings-close").click();
    await expect(settings).toBeHidden();
  }
  await app.close();
});
