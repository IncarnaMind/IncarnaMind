import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { acceptPlainTextKeys, createDataFolder, launchApp, removeDataFolder } from "./app";

/*
 * Electron 45 deprecates safeStorage's synchronous encryptString and decryptString and
 * Electron 46 removes them (#2010). A secret the previous version wrote with the
 * synchronous API must still open with the asynchronous one, and the built app must
 * save and read a key through its own keychain.
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
  const opened = await app.evaluate(async ({ safeStorage }, value) => {
    // Linux without a keyring refuses to encrypt until an app allows it, as this app does once the User accepts.
    if (process.platform === "linux") safeStorage.setUsePlainTextEncryption(true);
    const stored = safeStorage.encryptString(value);
    return (await safeStorage.decryptStringAsync(stored)).result;
  }, secret);

  expect(opened).toBe(secret);

  // The app's own keychain saves a key and opens it again with the asynchronous API.
  await acceptPlainTextKeys(window);
  const providers = await window.evaluate(async (value) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({ kind: "openai", apiKey: value, modelId: "gpt-5.4-mini" });
    return bridge.listChatProviders();
  }, secret);

  expect(providers).toEqual([expect.objectContaining({ hasApiKey: true })]);
});
