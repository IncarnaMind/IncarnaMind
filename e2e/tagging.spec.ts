import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openAdvancedModels,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Settings → Models → Advanced → Tagging: one model choice for automatic tagging
 * and Organize. Automatic says which model it uses and why; another model is
 * chosen from a list grouped as the model chip groups them, and saved at once.
 * Ollama is a stand-in at its own address, with a local decision model and a
 * chat model installed; the chat model is the scripted one.
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

/** The Tagging section, under Advanced, opened and scrolled into view. */
async function tagging(window: Page): Promise<Locator> {
  const section = await openAdvancedModels(await openSettings(window, "models"));
  await section.scrollIntoViewIfNeeded();
  return section;
}

const option = (section: Locator, model: string) =>
  section.getByTestId("tagging-option").and(section.locator(`[data-model="${model}"]`));

test("Automatic says which model it uses; another one is chosen from the list and kept", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await addOllama(window, ollamaUrl);
    const section = await tagging(window);

    // Automatic is the default, and picks the local decision model over the chat model.
    const automatic = section.getByTestId("tagging-automatic");
    await expect(automatic.getByRole("radio")).toBeChecked();
    await expect(section.getByTestId("tagging-automatic-line")).toHaveText(
      "Using the local decision models on this computer (Tev1, Clef-Flash)",
    );
    await expect(section.getByTestId("tagging-review")).toHaveText(
      "Uncertain Tags are marked for review.",
    );
    await expect(
      section.getByRole("checkbox", {
        name: "Tag and sort new Documents automatically",
        description: "Runs on this computer.",
      }),
    ).toBeChecked();

    // The list: the models on this computer, labelled, and what they cost.
    await expect(section.getByText("On this computer", { exact: true })).toBeVisible();
    const decision = option(section, "Tev1 0.8B");
    await expect(decision).toContainText("Local decision model");
    await expect(decision).toContainText("Free, on this computer");
    const chat = option(section, "fake-model");
    await expect(chat).toContainText("Free, on this computer");

    // Choosing the chat model saves it at once, and the section says Tags are kept.
    await chat.click();
    await expect(chat.getByRole("radio")).toBeChecked();
    await expect(automatic.getByRole("radio")).not.toBeChecked();
    await expect(section.getByTestId("tagging-review")).toHaveText("Every Tag it adds is kept.");
    await expect
      .poll(() =>
        window.evaluate(
          async () =>
            (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getLibrary())
              .settings.classifier,
        ),
      )
      .toMatchObject({ kind: "chat", choice: { modelId: "fake-model" } });

    // By keyboard: the arrows move the choice, as in any radio group, and it is saved too.
    await chat.getByRole("radio").focus();
    await window.keyboard.press("ArrowUp");
    await expect(decision.getByRole("radio")).toBeChecked();
    await closeSettings(window);

    // Reopened, Advanced opens by itself on the choice; the section fits without a scroll bar.
    const settings = await openSettings(window, "models");
    await expect(settings.getByTestId("models-advanced")).toHaveAttribute("open", "");
    const again = settings.getByTestId("tagging-settings");
    await expect(option(again, "Tev1 0.8B").getByRole("radio")).toBeChecked();
    await setWindowSize(app, window, 1100, 760);
    await expect
      .poll(() => again.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await again.getByTestId("tagging-automatic").click();
    await expect(again.getByTestId("tagging-automatic").getByRole("radio")).toBeChecked();
  } finally {
    await app.close();
  }
});

test("in Chinese: 自动打标签, with the model Automatic uses and the list's groups", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await addOllama(window, ollamaUrl);
    await window.evaluate(async () =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: "zh-CN" },
      }),
    );
    await window.getByRole("button", { name: "设置" }).click();
    const settings = window.getByTestId("settings");
    await settings.getByTestId("settings-nav-models").click();
    const section = await openAdvancedModels(settings);
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole("heading", { name: "自动打标签" })).toBeVisible();
    await expect(section.getByTestId("tagging-automatic-line")).toHaveText(
      "正在使用本地分类模型（Tev1, Clef-Flash）",
    );
    await expect(section.getByText("在本机运行", { exact: true })).toBeVisible();
    await expect(
      section.getByRole("checkbox", {
        name: "自动为新文档打标签并整理",
        description: "在这台电脑上运行。",
      }),
    ).toBeChecked();
    await expect(option(section, "Tev1 0.8B")).toContainText("本地分类模型");
    await expect(option(section, "Tev1 0.8B")).toContainText("免费，在本机运行");
    await option(section, "fake-model").click();
    await expect(section.getByTestId("tagging-review")).toHaveText("它添加的标签都会保留。");
  } finally {
    await app.close();
  }
});

const libraryOf = (window: Page) =>
  window.evaluate(
    async () =>
      (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getLibrary())
        .settings,
  );

// Choosing a cloud model here turns tagging on, so its row says what each new Document sends to
// its service before it is chosen; a choice not made, such as Other model… left unsaved, changes
// nothing (#2308, ADR-0022's amendment).
for (const language of ["en", "zh-CN"] as const) {
  test(`a cloud model's row says what each new Document sends to its service before choosing it turns tagging on (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1440, 900);
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-ant-not-a-real-key",
          modelId: "claude-haiku-5-5",
        });
      });
      const section = await tagging(window);
      await setLanguage(window, language);
      const sends = translate(language, "setup.sorting.sends", { service: "Anthropic" });
      const haiku = option(section, "Claude Haiku 5.5");
      await expect(haiku.getByTestId("tagging-option-sends")).toHaveText(sends);
      const automatic = section.getByTestId("tagging-automatic-organize");
      await expect(automatic).not.toBeChecked();

      await section.getByTestId("tagging-other").click();
      const form = section.getByTestId("tagging-other-form");
      await expect(form.getByTestId("tagging-other-sends")).toHaveText(sends);
      await form.getByLabel(translate(language, "library.model")).fill("claude-sonnet-5-5");
      await expect(automatic).not.toBeChecked();
      expect((await libraryOf(window)).automatic).toBe(false);

      await haiku.click();
      await expect(automatic).toBeChecked();
      expect((await libraryOf(window)).automatic).toBe(true);
    } finally {
      await app.close();
    }
  });
}
