import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Presets: a hosted service that speaks OpenAI's API has its own name and key page. No chat
 * provider is added in IncarnaMind (#3767), so the page seen is a saved one's.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("a saved Groq key has its own page, with its key link and what goes to Groq, in English and Chinese", async () => {
  // Nothing answers where Ollama would be, so this computer's own Ollama isn't asked.
  const { app, window } = await launchApp(dataDir, { ollama: "http://127.0.0.1:9" });
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await acceptPlainTextKeys(window);
    // No chat provider is added in IncarnaMind (#3767): the profile's is saved through the bridge.
    const provider = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
        kind: "openai-compatible",
        catalogId: "groq",
        apiKey: "groq-a-made-up-key",
        modelId: "openai/gpt-oss-120b",
      }),
    );
    const settings = await openSettings(window, "ai");
    await settings.locator(`[data-provider-id="${provider.id}"]`).click();
    const page = settings.getByTestId("provider-page");
    await expect(page.getByTestId("provider-page-title")).toHaveText("Groq");
    await expect(page.getByTestId("provider-page-get-key")).toHaveAttribute(
      "href",
      "https://console.groq.com/keys",
    );
    await expect(page.getByTestId("provider-sends")).toContainText(
      "What you ask, edit or check, with the notes and the parts of your Documents it needs, goes to Groq.",
    );
    if (process.env.INCARNAMIND_SCREENSHOTS) {
      await settings.screenshot({
        path: `${process.env.INCARNAMIND_SCREENSHOTS}/preset-groq-en.png`,
      });
    }

    await setLanguage(window, "zh-CN");
    await expect(page.getByTestId("provider-sends")).toContainText("Groq");
    await expect(page.getByTestId("provider-page-title")).toHaveText("Groq");
  } finally {
    await app.close();
  }
});

test("Ollama at a server on another computer shows a server's data line, not its own, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { ollama: "http://127.0.0.1:9" });
  try {
    await setWindowSize(app, window, 1100, 900);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.saveChatProvider({
        kind: "ollama",
        baseUrl: "http://192.168.1.20:11434",
        modelId: "home-model",
      });
    });
    const settings = await openSettings(window, "ai");
    await settings.getByTestId("provider-row").first().click();
    const line = settings.getByTestId("provider-page").getByTestId("provider-data-use");
    await expect(line).toContainText("Depends on the server: check its terms.");
    await expect(line).not.toContainText("Local models stay local");
    await setLanguage(window, "zh-CN");
    await expect(line).toContainText("取决于服务器，请查看其条款");
    await expect(line).not.toContainText("本地模型不外传");
  } finally {
    await app.close();
  }
});
