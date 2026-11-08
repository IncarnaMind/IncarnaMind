import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  organizeRow,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Settings › AI › Organize and Tags (#2835): one model for automatic tagging and Organize, in one
 * picker grouped by who pays, its options under it. Under Automatic the picker shows what sorts
 * now. Ollama is a stand-in at its own address, with a local decision model and a chat model
 * installed; the chat model is the scripted one.
 */

let dataDir: string;
let ollama: Server;
let ollamaUrl: string;

test.beforeEach(async () => {
  dataDir = await createDataFolder();
  ollama = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/tags") {
      response.end(
        JSON.stringify({ models: [{ name: "tev1:0.8b" }, { name: "fake-model:latest" }] }),
      );
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => ollama.listen(0, "127.0.0.1", resolve));
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
});
test.afterEach(async () => {
  ollama.closeAllConnections();
  await new Promise((resolve) => ollama.close(resolve));
  await removeDataFolder(dataDir);
});

/** A chat model in the stand-in Ollama, as the setup screen would save it. */
async function addOllama(window: Page, baseUrl: string): Promise<void> {
  await window.evaluate(async (url) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({ kind: "ollama", baseUrl: url, modelId: "fake-model" });
  }, baseUrl);
}

const libraryOf = (window: Page) =>
  window.evaluate(
    async () =>
      (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getLibrary())
        .settings,
  );

// protects=Organize and Tags shows what sorts now under Automatic, offers the models on this computer under that heading, and keeps the one chosen; fails_when=the picker shows nothing under Automatic, a choice isn't saved, or isn't shown when Settings opens again; no_claim=which model Automatic prefers.
test("Organize and Tags shows what sorts now; another model is chosen from the picker and kept", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await addOllama(window, ollamaUrl);
    const settings = await openSettings(window, "ai");
    const { picker, automatic } = organizeRow(settings);

    // Automatic picks the local decision models, which run here and are on by themselves.
    await expect(picker.locator("option:checked")).toHaveText(
      "Tev1 and Clef-Flash, picked per Document",
    );
    await expect(settings.getByTestId("ai-organize-hints")).toHaveText("Also gives meeting hints");
    await expect(automatic).toBeChecked();
    await expect(settings.getByTestId("tagging-automatic-sends")).toHaveText(
      "Runs on this computer.",
    );
    const local = picker.locator('optgroup[label="On this computer · free"] option');
    await expect(local.filter({ hasText: "fake-model" })).toHaveCount(1);

    // Choosing the chat model saves it at once; a chat model gives no meeting hints.
    const chat = await local.filter({ hasText: "fake-model" }).getAttribute("value");
    if (!chat) throw new Error("No chat model to choose.");
    await picker.selectOption(chat);
    await expect
      .poll(async () => (await libraryOf(window)).classifier)
      .toMatchObject({ kind: "chat", choice: { modelId: "fake-model" } });
    await expect(settings.getByTestId("ai-organize-hints")).toHaveText(
      "No meeting hints with this model",
    );
    await closeSettings(window);

    const again = organizeRow(await openSettings(window, "ai"));
    await expect(again.picker).toHaveValue(chat);
  } finally {
    await app.close();
  }
});

test("in Chinese: 整理和标签, with what sorts now and the picker's groups", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await addOllama(window, ollamaUrl);
    await setLanguage(window, "zh-CN");
    const settings = await openSettings(window, "ai");
    const { picker, automatic } = organizeRow(settings);
    await expect(
      settings.getByTestId("ai-jobs").getByText("整理和标签", { exact: true }),
    ).toBeVisible();
    await expect(picker.locator('optgroup[label="在这台电脑上 · 免费"]')).toHaveCount(1);
    await expect(settings.getByTestId("ai-organize-hints")).toHaveText("也提供会议提示");
    await expect(
      settings.getByRole("switch", { name: "新文档到达时自动整理和打标签" }),
    ).toBeChecked();
    await expect(automatic).toBeChecked();
  } finally {
    await app.close();
  }
});

// The switch for sorting and tagging new Documents as they arrive says what each one sends, and
// to which service, before it is turned on; choosing the model alone never turns it on (#2308).
for (const language of ["en", "zh-CN"] as const) {
  test(`a cloud model's switch says what each new Document sends to its service before it is turned on (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1440, 900);
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      const provider = await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return bridge.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-ant-not-a-real-key",
          modelId: "claude-haiku-5-5",
        });
      });
      await setLanguage(window, language);
      const settings = await openSettings(window, "ai");
      const { picker, automatic } = organizeRow(settings);
      await picker.selectOption(
        JSON.stringify({
          kind: "chat",
          choice: { providerId: provider.id, modelId: "claude-haiku-5-5" },
        }),
      );
      await expect
        .poll(async () => (await libraryOf(window)).classifier)
        .toMatchObject({ kind: "chat", choice: { modelId: "claude-haiku-5-5" } });
      await expect(automatic).not.toBeChecked();
      expect((await libraryOf(window)).automatic).toBe(false);
      await expect(settings.getByTestId("tagging-automatic-sends")).toHaveText(
        translate(language, "setup.sorting.sendsWhenOn", { service: "Anthropic" }),
      );

      await pointAndClick(window, automatic);
      await expect(automatic).toBeChecked();
      await expect.poll(async () => (await libraryOf(window)).automatic).toBe(true);
    } finally {
      await app.close();
    }
  });
}
