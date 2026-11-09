import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  removeDataFolder,
  setWindowSize,
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
    ai: [
      "What each job uses",
      "Accounts and keys",
      "Limits",
      "Document search",
      "On this computer",
    ],
    gone: [
      /chat model/i,
      /embedding/i,
      /rerank/i,
      /\bindex/i,
      /local mode(?!l)/i,
      /Your providers/,
      /Defaults/,
      /Already pay for a plan/,
    ],
  },
  "zh-CN": {
    ai: ["各项任务使用的模型", "账户和密钥", "限制", "文档搜索", "在这台电脑上"],
    gone: [
      /对话模型/,
      /提供商/,
      /嵌入/,
      /重排序|重新排序/,
      /本地模式/,
      /在本机运行/,
      /已添加的服务/,
    ],
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`Settings › AI says it in the glossary's words (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1100, 800);
    await dismissChatSetup(window);
    await window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({ kind: "ollama", modelId: "test-model" });
      await bridge.saveEmbeddingProvider({ kind: "built-in" });
    }, language);
    const words = WORDS[language];

    await openSettings(window, "ai");
    await window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosen } });
    }, language);
    const page = window.getByTestId("models-settings");
    for (const word of words.ai) await expect(page).toContainText(word);
    for (const gone of words.gone) await expect(page).not.toContainText(gone);
    await app.close();
  });
}
