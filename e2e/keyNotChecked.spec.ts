import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addProviderForm,
  createDataFolder,
  launchApp,
  openSettings,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * With "Keep everything on this computer" on, saving a key sends nothing to its provider: the key
 * is kept, and one line by the key field says it wasn't checked.
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

test("with “Keep everything on this computer” on, a key saved on Add a provider or on a provider's page is kept unchecked, and one line says so in both languages", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 800);
  await setLocalOnly(window, true);
  const settings = await openSettings(window, "models");
  const form = await addProviderForm(settings, "openai");
  await acceptPlainTextKeys(window, form);
  await form.getByLabel(/^API key/).fill("sk-proj-not-a-real-key");

  await form.getByTestId("provider-use-key").click();

  const page = settings.getByTestId("provider-page");
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

test("a key replaced on a provider's page while the setting is on says it wasn't checked either", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 800);
  const settings = await openSettings(window, "models");
  const form = await addProviderForm(settings, "openai");
  await acceptPlainTextKeys(window, form);
  await form.getByLabel(/^API key/).fill("sk-proj-not-a-real-key");
  await form.getByTestId("provider-use-key").click();
  const page = settings.getByTestId("provider-page");
  await expect(page.getByTestId("provider-page-key")).toHaveAttribute("placeholder", "Key saved");
  await expect(page.getByTestId("provider-key-not-checked")).toHaveCount(0);

  await setLocalOnly(window, true);
  await page.getByTestId("provider-page-key").fill("sk-proj-another-not-a-real-key");
  await page.getByTestId("provider-page-save-key").click();

  await expect(page.getByTestId("provider-key-not-checked")).toHaveText(
    "Saved, not checked: nothing was sent to OpenAI.",
  );
});
