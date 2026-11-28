import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
 * A key with a character keys don't use, such as a Chinese word pasted by mistake, is said in
 * place in plain words before anything is sent, and a key with spaces and invisible characters
 * around it is cleaned and tested. No chat model's key is added in IncarnaMind (#3767): a
 * profile's provider is saved by the bridge, and its key is replaced on its own page.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const language = (window: Page, value: "en" | "zh-CN") =>
  window.evaluate(
    (chosen) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: chosen },
      }),
    value,
  );

async function recordingServer(): Promise<{
  server: Server;
  url: string;
  keysSeen: (string | undefined)[];
}> {
  const keysSeen: (string | undefined)[] = [];
  const http = createServer((request, response) => {
    keysSeen.push(request.headers.authorization);
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.method === "GET"
            ? { object: "list", data: [{ id: "any", object: "model" }] }
            : {
                id: "c1",
                object: "chat.completion",
                created: 1,
                model: "any",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "OK" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    server: http,
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
    keysSeen,
  };
}

/** Saves a provider through the bridge (#3767), and opens its page in Settings › AI. */
async function providerPage(
  window: Page,
  input: { kind: "openai-compatible"; baseUrl: string } | { kind: "kimi" },
) {
  const providerId = await saveProvider(window, {
    ...input,
    apiKey: "first-key",
    modelId: input.kind === "kimi" ? "kimi-k2.6" : "any",
  });
  const settings = await openProviderRow(window, providerId);
  const page = settings.getByTestId("provider-page");
  await expect(page).toBeVisible();
  return page;
}

test("a key with a Chinese word in it is said in place in plain words, in English and Chinese, and sends nothing", async () => {
  const fake = await recordingServer();
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 900);
    const page = await providerPage(window, { kind: "openai-compatible", baseUrl: fake.url });
    const before = fake.keysSeen.length;
    const key = page.getByTestId("provider-page-key");
    const save = page.getByTestId("provider-page-save-key");
    const said = page.getByTestId("key-character-line");
    const expectUnderKey = async () => {
      const keyBox = await key.boundingBox();
      const saidBox = await said.boundingBox();
      const pageBox = await page.boundingBox();
      expect(saidBox?.y ?? 0).toBeGreaterThan((keyBox?.y ?? 0) + (keyBox?.height ?? 0) - 1);
      expect((saidBox?.x ?? 0) + (saidBox?.width ?? 0)).toBeLessThanOrEqual(
        (pageBox?.x ?? 0) + (pageBox?.width ?? 0) + 1,
      );
    };

    await key.fill("sk-test-1234作品-not-a-real-key");
    await expect(said).toHaveText("This key has a character keys don’t use (作). Paste it again.");
    await expect(key).toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeDisabled();
    await expect(page.getByTestId("provider-test-result")).toHaveCount(0);
    await expect(page).not.toContainText("ByteString");
    await key.press("Enter");
    await expect(said).toBeVisible();
    await expectUnderKey();
    expect(fake.keysSeen.length).toBe(before);
    if (process.env.INCARNAMIND_SCREENSHOTS) {
      await window.screenshot({
        path: `${process.env.INCARNAMIND_SCREENSHOTS}/key-character-900-en.png`,
      });
    }

    await language(window, "zh-CN");
    await expect(said).toHaveText("密钥里有一个不该有的字符（作）。重新粘贴密钥。");
    await expect(page).not.toContainText("ByteString");
    await expectUnderKey();
    if (process.env.INCARNAMIND_SCREENSHOTS) {
      await window.screenshot({
        path: `${process.env.INCARNAMIND_SCREENSHOTS}/key-character-900-zh.png`,
      });
    }

    await key.fill("sk-12\u200B34");
    await expect(said).toHaveText("密钥里有一个不该有的字符（U+200B）。重新粘贴密钥。");
    await language(window, "en");
    await expect(said).toHaveText(
      "This key has a character keys don’t use (U+200B). Paste it again.",
    );

    await key.fill("good-key");
    await expect(said).toHaveCount(0);
    await expect(key).not.toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(key).toHaveAttribute("placeholder", "Key saved");
    // Its test sends the key as it was saved, the only one the server sees after the first.
    await page.getByTestId("provider-test").click();
    await expect(page.getByTestId("provider-test-result")).toBeVisible();
    expect(fake.keysSeen.length).toBeGreaterThan(before);
    expect(new Set(fake.keysSeen.slice(before))).toEqual(new Set(["Bearer good-key"]));
  } finally {
    await app.close();
    fake.server.closeAllConnections();
    fake.server.close();
  }
});

test("a key with spaces and invisible characters around it is cleaned and tested", async () => {
  const fake = await recordingServer();
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 900);
    const page = await providerPage(window, { kind: "openai-compatible", baseUrl: fake.url });
    const before = fake.keysSeen.length;
    const key = page.getByTestId("provider-page-key");
    await key.fill("  \u200B\uFEFFgood-key\u00A0 ");

    await expect(page.getByTestId("key-character-line")).toHaveCount(0);
    await page.getByTestId("provider-page-save-key").click();
    await expect(key).toHaveAttribute("placeholder", "Key saved");
    await page.getByTestId("provider-test").click();
    await expect(page.getByTestId("provider-test-result")).toBeVisible();
    expect(fake.keysSeen.length).toBeGreaterThan(before);
    expect(new Set(fake.keysSeen.slice(before))).toEqual(new Set(["Bearer good-key"]));
  } finally {
    await app.close();
    fake.server.closeAllConnections();
    fake.server.close();
  }
});

test("a key that names another service and holds an invisible character gets the character line, not the form's", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 900);
    const page = await providerPage(window, { kind: "kimi" });
    const key = page.getByTestId("provider-page-key");
    const said = page.getByTestId("key-character-line");
    const wrong = page.getByTestId("provider-key-wrong");

    await key.fill("sk-proj-abc123\u200Bdef456");
    await expect(said).toContainText("(U+200B)");
    await expect(wrong).toHaveCount(0);
    await expect(page.getByTestId("provider-page-save-key")).toBeDisabled();

    await key.fill("sk-proj-abc123def456");
    await expect(said).toHaveCount(0);
    await expect(wrong).toContainText("This is OpenAI’s key");

    await key.fill("\u200Bsk-proj-abc123def456\u200B");
    await expect(said).toHaveCount(0);
    await expect(wrong).toContainText("This is OpenAI’s key");
  } finally {
    await app.close();
  }
});
