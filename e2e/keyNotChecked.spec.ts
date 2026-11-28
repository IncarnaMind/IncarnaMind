import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  launchApp,
  openProviderRow,
  removeDataFolder,
  saveProvider,
  setWindowSize,
} from "./app";

/*
 * With "Keep everything on this computer" on, saving a key sends nothing to its provider: the key
 * is kept, and one line by the key field on the provider's page says it wasn't checked.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const setLocalOnly = (window: Page, enabled: boolean) =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setLocalOnly(value),
    enabled,
  );

const setLanguage = (window: Page, value: "en" | "zh-CN") =>
  window.evaluate(
    (chosen) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: chosen },
      }),
    value,
  );

// No chat model's key is added in IncarnaMind (#3767): a profile's provider is saved by the
// bridge, and its key is replaced on its own page.
async function openSavedProvider(window: Page) {
  const providerId = await saveProvider(window, {
    kind: "openai",
    apiKey: "sk-proj-not-a-real-key",
    modelId: "gpt-5.4-mini",
  });
  const settings = await openProviderRow(window, providerId);
  const page = settings.getByTestId("provider-page");
  await expect(page.getByTestId("provider-page-key")).toHaveAttribute("placeholder", "Key saved");
  return page;
}

test("a key replaced on a provider's page with “Keep everything on this computer” on is kept unchecked, and one line says so in both languages", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 800);
  const page = await openSavedProvider(window);
  await expect(page.getByTestId("provider-key-not-checked")).toHaveCount(0);

  await setLocalOnly(window, true);
  await page.getByTestId("provider-page-key").fill("sk-proj-another-not-a-real-key");
  await page.getByTestId("provider-page-save-key").click();

  const line = page.getByTestId("provider-key-not-checked");
  await expect(line).toHaveText("Saved, not checked: nothing was sent to OpenAI.");
  await expect(page.getByTestId("provider-page-key")).toHaveAttribute("placeholder", "Key saved");

  await setLanguage(window, "zh-CN");
  await expect(line).toHaveText("已保存，未验证：没有向 OpenAI 发送任何内容。");
  await setLanguage(window, "en");

  // Turned off, the line is no longer true to say: the key is checked when it is next used.
  await setLocalOnly(window, false);
  await expect(line).toHaveCount(0);
});
