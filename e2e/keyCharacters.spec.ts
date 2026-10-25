import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
 * A key with a character keys don't use, such as a Chinese word pasted by mistake, is said in
 * place in plain words before anything is sent, and a key with spaces and invisible characters
 * around it is cleaned and tested.
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

test("a key with a Chinese word in it is said in place in plain words, in English and Chinese, and sends nothing", async () => {
  const fake = await recordingServer();
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 900);
    await acceptPlainTextKeys(window);
    const settings = await openSettings(window, "models");
    const form = await addProviderForm(settings, "openai-compatible");
    await form.locator('input[type="url"]').fill(fake.url);
    await form.getByTestId("provider-model-text").fill("any");
    const key = form.locator('input[type="password"]');
    const use = form.getByTestId("provider-use-key");
    const said = form.getByTestId("key-character-line");
    const expectUnderKey = async () => {
      const keyBox = await key.boundingBox();
      const saidBox = await said.boundingBox();
      const formBox = await form.boundingBox();
      expect(saidBox?.y ?? 0).toBeGreaterThan((keyBox?.y ?? 0) + (keyBox?.height ?? 0) - 1);
      expect((saidBox?.x ?? 0) + (saidBox?.width ?? 0)).toBeLessThanOrEqual(
        (formBox?.x ?? 0) + (formBox?.width ?? 0) + 1,
      );
    };

    await key.fill("sk-test-1234作品-not-a-real-key");
    await expect(said).toHaveText("This key has a character keys don’t use (作). Paste it again.");
    await expect(key).toHaveAttribute("aria-invalid", "true");
    await expect(use).toBeDisabled();
    await expect(form.getByTestId("connection-test")).toHaveCount(0);
    await expect(form).not.toContainText("ByteString");
    await key.press("Enter");
    await expect(said).toBeVisible();
    await expectUnderKey();
    if (process.env.INCARNAMIND_SCREENSHOTS) {
      await window.screenshot({
        path: `${process.env.INCARNAMIND_SCREENSHOTS}/key-character-900-en.png`,
      });
    }

    await language(window, "zh-CN");
    await expect(said).toHaveText("密钥里有一个不该有的字符（作）。重新粘贴密钥。");
    await expect(form).not.toContainText("ByteString");
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
    await expect(use).toBeEnabled();
    await use.click();
    await expect(settings.getByTestId("provider-page")).toBeVisible();
    expect(fake.keysSeen.length).toBeGreaterThan(0);
    expect(new Set(fake.keysSeen)).toEqual(new Set(["Bearer good-key"]));
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
    await acceptPlainTextKeys(window);
    const settings = await openSettings(window, "models");
    const form = await addProviderForm(settings, "openai-compatible");
    await form.locator('input[type="url"]').fill(fake.url);
    await form.getByTestId("provider-model-text").fill("any");
    await form.locator('input[type="password"]').fill("  \u200B\uFEFFgood-key\u00A0 ");

    await expect(form.getByTestId("key-character-line")).toHaveCount(0);
    await form.getByTestId("provider-use-key").click();
    await expect(settings.getByTestId("provider-page")).toBeVisible();
    expect(fake.keysSeen.length).toBeGreaterThan(0);
    expect(new Set(fake.keysSeen)).toEqual(new Set(["Bearer good-key"]));
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
    await acceptPlainTextKeys(window);
    const settings = await openSettings(window, "models");
    const form = await addProviderForm(settings, "kimi");
    const key = form.locator('input[type="password"]');
    const said = form.getByTestId("key-character-line");
    const wrong = form.getByTestId("provider-key-wrong");

    await key.fill("sk-proj-abc123\u200Bdef456");
    await expect(said).toContainText("(U+200B)");
    await expect(wrong).toHaveCount(0);
    await expect(form.getByTestId("provider-use-key")).toBeDisabled();

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
