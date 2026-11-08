import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  acceptPlainTextKeys,
  addProviderForm,
  coreOf,
  createDataFolder,
  launchApp,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Electron 45 deprecates safeStorage's synchronous encryptString and decryptString and
 * Electron 46 removes them (#2010). A secret the previous version wrote with the
 * synchronous API must still open with the asynchronous one, the app must save and read
 * a key through its own keychain, and a saved key the system store can't open must say
 * so where the key is entered.
 */

let dataDir: string;

test.beforeEach(async () => {
  dataDir = await createDataFolder();
});

test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("a secret the synchronous safeStorage API wrote opens with the asynchronous one", async () => {
  const { app, window } = await launchApp(dataDir);
  const secret = "sk-test-0123456789-secrets";
  // The app's own plain-text acceptance on Linux without a keyring comes first: it must work before a key is written.
  await acceptPlainTextKeys(window);

  const provider = await (await coreOf(window)).evaluate(async (bridge, value) => {
    await bridge.saveChatProvider({ kind: "openai", apiKey: value, modelId: "gpt-5.4-mini" });
    return (await bridge.listChatProviders())[0];
  }, secret);
  if (!provider) throw new Error("The provider wasn't saved.");
  expect(provider.hasApiKey).toBe(true);

  const secretsFile = join(dataDir, "secrets.json");
  const entry = `chat-provider:${provider.id}:api-key`;
  const entries = JSON.parse(await readFile(secretsFile, "utf8")) as Record<string, string>;
  const stored = entries[entry] ?? "";

  // An older build reads what this one saved: the asynchronous ciphertext opens with the synchronous API.
  const older = await app.evaluate(
    ({ safeStorage }, value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    stored,
  );
  expect(older).toBe(secret);

  // And this build reads what the previous version wrote: the synchronous ciphertext opens with the asynchronous API.
  const previous = await app.evaluate(
    ({ safeStorage }, value) => safeStorage.encryptString(value).toString("base64"),
    secret,
  );
  await writeFile(secretsFile, JSON.stringify({ [entry]: previous }), { mode: 0o600 });
  const reread = await (await coreOf(window)).evaluate((bridge) => bridge.listChatProviders());
  expect(reread).toEqual([expect.objectContaining({ id: provider.id, hasApiKey: true })]);
});

test("a saved key that can't be opened says so where it is entered", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1280, 800);
  const settings = await openSettings(window, "ai");
  const form = await addProviderForm(settings, "openai");
  await acceptPlainTextKeys(window, form);
  await form.getByLabel(/^API key/).fill("sk-test-0123456789-unreadable");
  await form.getByTestId("provider-use-key").click();
  const page = settings.getByTestId("provider-page");
  await expect(page.getByTestId("provider-page-key")).toHaveAttribute("placeholder", "Key saved");

  const provider = (
    await (await coreOf(window)).evaluate((bridge) => bridge.listChatProviders())
  )[0];
  if (!provider) throw new Error("The provider wasn't saved.");

  // A value the system store can't open, as after the keyring that saved it changed.
  await writeFile(
    join(dataDir, "secrets.json"),
    JSON.stringify({ [`chat-provider:${provider.id}:api-key`]: "bm90LWEtcmVhbC1jaXBoZXJ0ZXh0" }),
    { mode: 0o600 },
  );

  await window.reload();
  await window.getByTestId("plus-menu").waitFor();
  const reopened = await openSettings(window, "ai");
  await expect(
    reopened.getByText(
      "The saved API key for OpenAI on this device can’t be read. Enter it again.",
    ),
  ).toBeVisible();
  // The row says so where its state is, and reads as a problem to fix.
  const state = reopened.getByTestId("provider-row").first().getByTestId("account-state");
  await expect(state).toHaveText("Can’t be read");
  await expect(state).toHaveAttribute("data-tone", "problem");
  await reopened.locator(`[data-provider-id="${provider.id}"]`).click();
  const unreadable = reopened.getByTestId("provider-page");
  await expect(unreadable.getByTestId("provider-key-unreadable")).toHaveText(
    "The saved key can’t be read. Enter it again.",
  );

  await setLanguage(window, "zh-CN");
  await expect(unreadable.getByTestId("provider-key-unreadable")).toHaveText(
    "无法读取已保存的密钥。请重新输入。",
  );
  await unreadable.getByTestId("models-back").click();
  await expect(
    reopened.getByText("无法读取这台设备上保存的 OpenAI API 密钥。请重新输入。"),
  ).toBeVisible();
  await expect(
    reopened.getByTestId("provider-row").first().getByTestId("account-state"),
  ).toHaveText("无法读取");
});
