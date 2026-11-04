import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { acceptPlainTextKeys, coreOf, dismissChatSetup, setWindowSize } from "../app";
import { launchPackaged, packagedExecutable } from "./app";

test.use({ trace: "off" });
test.setTimeout(5 * 60_000);

test("a key the packaged app saved opens after a restart, and the previous cipher opens it too", async () => {
  expect(existsSync(packagedExecutable)).toBe(true);
  const home = await mkdtemp(join(tmpdir(), "incarnamind-secrets-home-"));
  const data = await mkdtemp(join(tmpdir(), "incarnamind-secrets-data-"));
  try {
    const secret = "sk-test-0123456789-packaged";
    const first = await launchPackaged(home, data, { testHooks: true });
    const window = await first.firstWindow();
    await setWindowSize(first, window, 900, 700);
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    const provider = await (await coreOf(window)).evaluate(async (bridge, value) => {
      await bridge.saveChatProvider({ kind: "openai", apiKey: value, modelId: "gpt-5.4-mini" });
      return (await bridge.listChatProviders())[0];
    }, secret);
    await first.close();
    if (!provider) throw new Error("The provider wasn't saved.");

    // The next launch opens the key this build saved with the asynchronous API.
    const second = await launchPackaged(home, data, { testHooks: true });
    try {
      const reopened = await second.firstWindow();
      await setWindowSize(second, reopened, 900, 700);
      await dismissChatSetup(reopened);
      const providers = await (await coreOf(reopened)).evaluate((bridge) =>
        bridge.listChatProviders(),
      );
      expect(providers).toEqual([expect.objectContaining({ id: provider.id, hasApiKey: true })]);

      // An older build reads what this one saved: the synchronous API opens the asynchronous ciphertext.
      const entries = JSON.parse(await readFile(join(data, "secrets.json"), "utf8")) as Record<
        string,
        string
      >;
      const stored = entries[`chat-provider:${provider.id}:api-key`] ?? "";
      const older = await second.evaluate(
        ({ safeStorage }, value) => safeStorage.decryptString(Buffer.from(value, "base64")),
        stored,
      );
      expect(older).toBe(secret);

      // What criterion 2 asks: a key the previous synchronous version wrote opens with the asynchronous API.
      const previous = await second.evaluate(
        ({ safeStorage }, value) => safeStorage.encryptString(value).toString("base64"),
        secret,
      );
      await writeFile(
        join(data, "secrets.json"),
        JSON.stringify({ [`chat-provider:${provider.id}:api-key`]: previous }),
        { mode: 0o600 },
      );
      const reread = await (await coreOf(reopened)).evaluate((bridge) =>
        bridge.listChatProviders(),
      );
      expect(reread).toEqual([expect.objectContaining({ id: provider.id, hasApiKey: true })]);
    } finally {
      await second.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});
