import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  saveProviderUnasked,
  setLanguage,
  setWindowSize,
  showSettingsPage,
} from "./app";

const SHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const capture = async (window: Page, name: string) => {
  if (SHOTS) await window.screenshot({ path: join(SHOTS, `${name}.png`) });
};

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const WORDS = {
  en: "May train on prompts and replies unless you opt out; logs are kept up to 30 days.",
  zh: "可能用提示和回复训练，可选择退出；记录最多保留 30 天。",
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`a training provider says so in consent and Privacy (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, language === "en" ? 1440 : 900, 900);
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await saveProviderUnasked(window, {
      kind: "openai-compatible",
      catalogId: "cohere",
      apiKey: "sk-ant-a-key-that-is-refused",
      modelId: "command-r-08-2024",
    });
    await setLanguage(window, language);
    await newMind(window);
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What is due?");
    await window.keyboard.press("Enter");

    const dialog = window.getByTestId("consent-dialog");
    await expect(dialog).toBeVisible();
    await capture(window, `consent-cohere-${language}`);
    const summary = WORDS[language === "en" ? "en" : "zh"];
    await expect(dialog.getByTestId("provider-training-data-use")).toContainText(summary);
    await expect(dialog.getByTestId("provider-training-data-use").locator("a")).toHaveAttribute(
      "href",
      "https://cohere.com/data-usage-policy",
    );

    await pointAndClick(window, window.getByTestId("consent-decline"));
    await window.keyboard.press("ControlOrMeta+,");
    const settings = await showSettingsPage(window, "privacy");
    const service = settings.getByTestId("data-service").filter({ hasText: "Cohere" });
    await capture(window, `privacy-cohere-${language}`);
    await expect(service.getByTestId("provider-training-data-use")).toContainText(summary);
    await expect(service.getByTestId("provider-training-data-use").locator("a")).toHaveAttribute(
      "href",
      "https://cohere.com/data-usage-policy",
    );
    await app.close();
  });

  test(`a non-training provider has no training warning (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, language === "en" ? 1440 : 900, 900);
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await saveProviderUnasked(window, {
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    await setLanguage(window, language);
    await newMind(window);
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What is due?");
    await window.keyboard.press("Enter");

    const dialog = window.getByTestId("consent-dialog");
    await expect(dialog).toBeVisible();
    await capture(window, `consent-anthropic-${language}`);
    await expect(dialog.getByTestId("provider-training-data-use")).toHaveCount(0);
    await pointAndClick(window, window.getByTestId("consent-decline"));
    await window.keyboard.press("ControlOrMeta+,");
    const settings = await showSettingsPage(window, "privacy");
    const service = settings.getByTestId("data-service").filter({ hasText: "Anthropic" });
    await capture(window, `privacy-anthropic-${language}`);
    await expect(service.getByTestId("provider-training-data-use")).toHaveCount(0);
    await app.close();
  });
}
