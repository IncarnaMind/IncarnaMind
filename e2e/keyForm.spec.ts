import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  launchApp,
  openSettings,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * A saved provider's key (#719). A key is no longer added in IncarnaMind (#3767): the key form, the
 * service list and the ChatGPT sign-in left with it, and a profile's provider changes its key on
 * its own page, where a key that is another service's goes nowhere.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const KEYS = {
  anthropic: `sk-ant-api03-${"aZ3".repeat(14)}`,
  openai: `sk-proj-${"aZ3".repeat(20)}`,
  bare: `sk-${"aZ3".repeat(16)}`,
};

test("in Settings, a key that is not the page's service goes nowhere on a provider's page, and the page stays the provider's", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const saved = await window.evaluate(async (apiKey) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return core.saveChatProvider({ kind: "anthropic", apiKey, modelId: "claude-haiku-5-5" });
    }, KEYS.anthropic);
    const settings = await openSettings(window, "ai");
    await settings.getByTestId("provider-row").first().click();
    const page = settings.getByTestId("provider-page");
    await expect(page).toHaveAttribute("data-provider-id", saved.id);
    const title = settings.getByTestId("provider-page-title");
    const pageKey = page.getByTestId("provider-page-key");
    const save = page.getByTestId("provider-page-save-key");
    await pageKey.fill(KEYS.bare);
    await expect(page.getByTestId("provider-key-wrong")).toHaveText(
      "This isn’t Anthropic’s key: its keys start with sk-ant-.",
    );
    await expect(save).toBeDisabled();
    await pageKey.press("Enter");
    await expect(page.getByTestId("provider-page-key-error")).toHaveCount(0);
    await pageKey.fill(KEYS.openai);
    await expect(page.getByTestId("provider-key-wrong")).toContainText("This is OpenAI’s key");
    await expect(title).toHaveText("Anthropic");
    await expect(save).toBeDisabled();
    await page.getByTestId("provider-key-anyway").click();
    await expect(save).toBeEnabled();
    await expect(title).toHaveText("Anthropic");
    await pageKey.fill(KEYS.anthropic);
    await expect(page.getByTestId("provider-key-wrong")).toHaveCount(0);
    await expect(save).toBeEnabled();
  } finally {
    await app.close();
  }
});
