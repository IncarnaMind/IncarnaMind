import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  removeDataFolder,
  setWindowSize,
  showSettingsPage,
} from "./app";

/**
 * Settings in plain words (#763 item 23): the glossary's words on the Models,
 * Search and Privacy pages, in English and Chinese, and none of the words it
 * replaces.
 */
let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const WORDS = {
  en: {
    models: ["Defaults", "Your providers"],
    search: ["Search model"],
    gone: [/chat model/i, /embedding/i, /rerank/i, /\bindex/i, /local mode(?!l)/i],
  },
  "zh-CN": {
    models: ["默认模型", "已添加的服务"],
    search: ["搜索模型"],
    gone: [/对话模型/, /提供商/, /嵌入/, /重排序|重新排序/, /本地模式/],
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`Models and Search say it in the glossary's words (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1100, 800);
    await dismissChatSetup(window);
    await window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({ kind: "ollama", modelId: "test-model" });
      await bridge.saveEmbeddingProvider({ kind: "built-in" });
    }, language);
    const words = WORDS[language];

    const settings = await openSettings(window, "models");
    await window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosen } });
    }, language);
    const chat = window.getByTestId("models-settings");
    for (const word of words.models) await expect(settings).toContainText(word);
    for (const gone of words.gone) await expect(chat).not.toContainText(gone);

    await showSettingsPage(window, "search");
    for (const word of words.search) await expect(settings).toContainText(word);
    for (const gone of words.gone) await expect(settings).not.toContainText(gone);
    await app.close();
  });
}
