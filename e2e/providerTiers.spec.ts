import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setWindowSize,
  showSettingsPage,
} from "./app";

// ADR-0019: Add a provider in Settings → Models lists every provider, the language's popular ones
// first; a provider the User already set up is among theirs, whatever its tier.

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const LANGUAGES = [
  {
    language: "en",
    popular: ["Anthropic", "OpenAI", "Google", "Ollama", "OpenRouter"],
    added: "Added",
  },
  {
    language: "zh-CN",
    popular: ["DeepSeek 深度求索", "通义千问", "Kimi", "智谱 GLM", "硅基流动", "Ollama"],
    added: "已添加",
  },
] as const;

/** Sets up Mistral (best effort) with a key and makes it the chat model, as the User did before. */
async function setUpMistral(window: Page): Promise<void> {
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await bridge.saveChatProvider({
      kind: "mistral",
      modelId: "mistral-small-latest",
      apiKey: "key-not-real",
    });
    await bridge.updateSettings({
      user: { chatModel: { providerId: provider.id, modelId: "mistral-small-latest" } },
    });
  });
}

for (const { language, popular, added } of LANGUAGES) {
  test(`Add a provider lists the popular providers first, and Mistral, set up, is a row with its own page (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setUpMistral(window);
    await window.evaluate(async (value) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: value } });
    }, language);

    for (const [width, height] of [
      [1440, 900],
      [1100, 800],
    ] as const) {
      await setWindowSize(app, window, width, height);
      await window.getByRole("button", { name: /^(Settings|设置)$/ }).click();
      const settings = await showSettingsPage(window, "models");
      // The provider set up before is a row, and its model answers.
      await expect(settings.getByTestId("provider-row")).toHaveText([/^Mistral/]);
      await expect(settings.getByTestId("model-default-chatModel")).toHaveValue(
        /\nmistral-small-latest$/,
      );

      await settings.getByTestId("models-add-provider").click();
      const directory = settings.getByTestId("provider-directory");
      await expect(
        directory.locator('[data-group="popular"] [data-testid="provider-directory-entry"]'),
      ).toHaveText(popular.map((name) => new RegExp(`^${name}`)));
      const mistral = directory.locator('[data-catalog-id="mistral"]');
      await expect(mistral).toContainText(added);
      await mistral.click();
      const page = settings.getByTestId("provider-page");
      await expect(page.getByTestId("provider-page-title")).toHaveText("Mistral");
      await expect(page.getByTestId("provider-page-get-key")).toHaveAttribute(
        "href",
        /^https:\/\//,
      );

      await settings.getByRole("button", { name: /^(Close Settings|关闭设置)$/ }).click();
      await expect(settings).toBeHidden();
    }

    // The set-up best-effort provider answers in the assistant, with the scripted model.
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("Does a best-effort provider still answer?");
    await window.keyboard.press("Enter");
    // Choosing Mistral allowed sending to it (ADR-0022): nothing asks before the Answer.
    await expect(window.getByTestId("consent-dialog")).toBeHidden();
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });
    await app.close();
  });
}
