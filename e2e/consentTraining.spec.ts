import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
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

const PROVIDERS = [
  {
    id: "cohere",
    serviceId: "https://api.cohere.ai",
    input: {
      kind: "openai-compatible",
      catalogId: "cohere",
      apiKey: "sk-ant-a-key-that-is-refused",
      modelId: "command-r-08-2024",
    },
    en: "May train on prompts and replies unless you opt out; logs are kept up to 30 days.",
    zh: "可能用提示和回复训练，可选择退出；记录最多保留 30 天。",
    href: "https://cohere.com/data-usage-policy",
  },
  {
    id: "google",
    serviceId: "https://generativelanguage.googleapis.com",
    input: {
      kind: "google",
      apiKey: "not-a-real-key",
      modelId: "gemini-3.8-flash",
    },
    en: "Unpaid use may improve Google's products, with human review; paid use doesn't.",
    zh: "未付费时可能用于改进 Google 产品并经人工审阅；付费则不会。",
    href: "https://ai.google.dev/gemini-api/terms",
  },
  {
    id: "kimi",
    serviceId: "https://api.moonshot.cn",
    input: {
      kind: "kimi",
      apiKey: "not-a-real-key",
      modelId: "kimi-k2.6",
    },
    en: "May use what you send to train and improve its models unless agreed otherwise in writing.",
    zh: "可能用你发送的内容训练和改进模型，除非另有书面约定。",
    href: "https://platform.kimi.ai/docs/agreement/modeluse",
  },
  {
    id: "deepseek",
    serviceId: "https://api.deepseek.com",
    input: {
      kind: "deepseek",
      apiKey: "not-a-real-key",
      modelId: "deepseek-flash",
    },
    en: "Privacy policy allows training and stores data in China; API terms are silent on both.",
    zh: "隐私政策允许用于训练，数据存储在中国；API 条款对此未作说明。",
    href: "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
  },
] as const;

for (const language of ["en", "zh-CN"] as const) {
  for (const provider of PROVIDERS) {
    test(`catalog data use appears in consent and Privacy (${provider.id}, ${language})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await setWindowSize(app, window, 900, 900);
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      await saveProviderUnasked(window, provider.input);
      if (provider.id === "cohere") {
        await window.evaluate(async () => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await bridge.saveRerankSettings({ kind: "cohere", apiKey: "not-a-real-key" });
        });
      }
      await setLanguage(window, language);
      await newMind(window);
      await window.getByTestId("mind-editor").click();
      await window.keyboard.press("ControlOrMeta+j");
      await window.keyboard.type("What is due?");
      await window.keyboard.press("Enter");

      const dialog = window.getByTestId("consent-dialog");
      const decline = window.getByTestId("consent-decline");
      await expect(dialog).toBeVisible();
      await expect(decline).toBeFocused();
      await capture(window, `consent-${provider.id}-${language}`);
      const summary = language === "en" ? provider.en : provider.zh;
      const notice = dialog.getByTestId("provider-training-data-use");
      const link = notice.locator("a");
      await expect(notice).toContainText(summary);
      await expect(link).toHaveText(language === "en" ? "Data use ↗" : "条款 ↗");
      await expect(link).toHaveAttribute("href", provider.href);
      await expect(link).toHaveCSS("white-space", "nowrap");

      if (provider.id === "cohere") {
        await window.keyboard.press("Enter");
      } else {
        await pointAndClick(window, decline);
      }
      await expect(dialog).toBeHidden();
      await window.keyboard.press("ControlOrMeta+,");
      const settings = await showSettingsPage(window, "privacy");
      const service = settings.locator(
        `[data-testid="data-service"][data-service-id="${provider.serviceId}"]`,
      );
      await expect(service).toHaveCount(1);
      await capture(window, `privacy-${provider.id}-${language}`);
      await expect(service.getByTestId("provider-training-data-use")).toContainText(summary);
      await expect(service.getByTestId("provider-training-data-use").locator("a")).toHaveAttribute(
        "href",
        provider.href,
      );
      if (provider.id === "cohere") {
        const rerank = settings.locator(
          '[data-testid="data-service"][data-service-id="https://api.cohere.com"]',
        );
        await expect(rerank.getByTestId("provider-training-data-use")).toContainText(summary);
        await expect(rerank.getByTestId("provider-training-data-use").locator("a")).toHaveAttribute(
          "href",
          provider.href,
        );
      }
      await app.close();
    });
  }

  test(`a non-training provider has no training warning (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 900, 900);
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
    await expect(window.getByTestId("consent-decline")).toBeFocused();
    await capture(window, `consent-anthropic-${language}`);
    await expect(dialog.getByTestId("provider-training-data-use")).toHaveCount(0);
    await pointAndClick(window, window.getByTestId("consent-decline"));
    await window.keyboard.press("ControlOrMeta+,");
    const settings = await showSettingsPage(window, "privacy");
    const service = settings.locator(
      '[data-testid="data-service"][data-service-id="https://api.anthropic.com"]',
    );
    await capture(window, `privacy-anthropic-${language}`);
    await expect(service.getByTestId("provider-training-data-use")).toHaveCount(0);
    await app.close();
  });
}
