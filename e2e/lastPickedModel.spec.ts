import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  askInAssistant,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  ollamaListing,
  openSettings,
  openSteps,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  showSettingsPage,
} from "./app";

/**
 * A Mind keeps a model only when the User picked one in it; every other Mind, older ones too, and
 * the assistant with no Mind in focus use the model last chosen on this device (#1379). The
 * Answers default applies until there is one, and changing it in Settings sets it too. The
 * scripted model answers, and an Answer's steps name the model that was asked.
 */
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const OPUS = "claude-opus-5-5";

let dataDir: string;
let home: string;
let running: ElectronApplication | null = null;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
});
test.afterEach(async () => {
  await running?.close().catch(() => undefined);
  running = null;
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

/** Starts the app on the test's data folder, 1100px wide, and returns its window. */
async function start(): Promise<Page> {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  running = app;
  await setWindowSize(app, window, 1100, 900);
  await dismissChatSetup(window);
  return window;
}

async function quit(): Promise<void> {
  const app = running;
  running = null;
  await app?.close();
}

/**
 * An Anthropic key whose list holds the three models, `answers` the model Answers use. With
 * `keepDefault`, the default stays as it was.
 */
async function connectAnthropic(
  window: Page,
  answers: string,
  keepDefault = false,
): Promise<string> {
  await acceptPlainTextKeys(window);
  await running?.evaluate(
    (_electron, ids) => {
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url.startsWith("https://api.anthropic.com/v1/models")
          ? Promise.resolve(Response.json({ data: ids.map((id) => ({ id })) }))
          : original(input, init);
      };
    },
    [SONNET, HAIKU, OPUS],
  );
  return window.evaluate(
    async (input) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-ant-test",
        ...input,
      });
      return provider.id;
    },
    { modelId: answers, keepDefault },
  );
}

const chipOf = (window: Page) => window.getByTestId("composer-model");

async function openMindNamed(window: Page, name: string): Promise<void> {
  await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: name }));
  await expect(frontMindName(window)).toHaveText(name);
}

const settingsOf = async (window: Page) =>
  (await coreOf(window)).evaluate((core) => core.getSettings());

const lastPick = async (window: Page) => (await settingsOf(window)).device.lastChatModel;

const setLanguage = async (window: Page, language: "zh-CN") =>
  (await coreOf(window)).evaluate(
    (core, value) => core.updateSettings({ user: { language: value } }),
    language,
  );

async function chooseInChip(window: Page, name: string): Promise<void> {
  await motionSettled(window);
  await pointAndClick(window, chipOf(window));
  const menu = window.getByTestId("composer-model-menu");
  const option = menu.getByTestId("composer-model-option").filter({ hasText: name });
  await expect(option).toBeVisible();
  await motionSettled(window);
  await pointAndClick(window, option);
  await expect(menu).toBeHidden();
}

async function expectFoot(window: Page, text: string): Promise<void> {
  await motionSettled(window);
  await pointAndClick(window, chipOf(window));
  const menu = window.getByTestId("composer-model-menu");
  await expect(menu).toContainText(text);
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

test("a model picked in one Mind is what a new Mind and an older one with no pick follow, its Answers are asked with it, and a Mind's own pick stays through a restart", async () => {
  let window = await start();
  const providerId = await connectAnthropic(window, SONNET);

  await newMind(window);
  await nameMind(window, "Older");
  await expect(chipOf(window)).toHaveText("Claude Sonnet 5.5");
  expect(await lastPick(window)).toBeNull();

  await newMind(window);
  await nameMind(window, "Picked");
  await chooseInChip(window, "Claude Haiku 5.5");
  await expect(chipOf(window)).toHaveText("Claude Haiku 5.5");
  await expect.poll(() => lastPick(window)).toEqual({ providerId, modelId: HAIKU });
  expect((await settingsOf(window)).user.chatModel).toEqual({ providerId, modelId: SONNET });

  await openMindNamed(window, "Older");
  await expect(chipOf(window)).toHaveText("Claude Haiku 5.5");
  const older = await askInAssistant(window, "Which model answers?");
  await expect(await openSteps(window, older)).toContainText("Answered by Claude Haiku 5.5");

  await newMind(window);
  await expect(chipOf(window)).toHaveText("Claude Haiku 5.5");
  await expectFoot(window, "Default for new Minds: Claude Haiku 5.5");
  await setLanguage(window, "zh-CN");
  await expectFoot(window, "新 Mind 的默认模型：Claude Haiku 5.5");

  await chooseInChip(window, "Claude Opus 5.5");
  await expect.poll(() => lastPick(window)).toEqual({ providerId, modelId: OPUS });
  await openMindNamed(window, "Picked");
  await expect(chipOf(window)).toHaveText("Claude Haiku 5.5");
  await openMindNamed(window, "Older");
  await expect(chipOf(window)).toHaveText("Claude Opus 5.5");
  await quit();

  window = await start();
  await expect.poll(() => lastPick(window)).toEqual({ providerId, modelId: OPUS });
  await openMindNamed(window, "Picked");
  await expect(chipOf(window)).toHaveText("Claude Haiku 5.5");
  await openMindNamed(window, "Older");
  await expect(chipOf(window)).toHaveText("Claude Opus 5.5");
  await newMind(window);
  await expect(chipOf(window)).toHaveText("Claude Opus 5.5");
});

test("the Answers default applies on a fresh install, and changing it in Settings also sets what new Minds start on", async () => {
  const window = await start();
  const providerId = await connectAnthropic(window, SONNET);

  await newMind(window);
  await expect(chipOf(window)).toHaveText("Claude Sonnet 5.5");
  await chooseInChip(window, "Claude Haiku 5.5");
  await newMind(window);
  await expect(chipOf(window)).toHaveText("Claude Haiku 5.5");

  const settings = await openSettings(window, "models");
  const answers = settings.getByTestId("model-default-chatModel");
  await expect(answers).toHaveAccessibleDescription(
    "A Mind or conversation with no model of its own uses the one you last chose; until then, this one.",
  );
  await answers.selectOption(`${providerId}\n${OPUS}`);
  await expect.poll(() => lastPick(window)).toEqual({ providerId, modelId: OPUS });
  expect((await settingsOf(window)).user.chatModel).toEqual({ providerId, modelId: OPUS });
  await settings.getByRole("button", { name: "Close Settings" }).click();
  await newMind(window);
  await expect(chipOf(window)).toHaveText("Claude Opus 5.5");
  await expectFoot(window, "Default for new Minds: Claude Opus 5.5");

  await setLanguage(window, "zh-CN");
  await window.getByRole("button", { name: "设置" }).click();
  const settingsZh = await showSettingsPage(window, "models");
  await expect(settingsZh.getByTestId("model-default-chatModel")).toHaveAccessibleDescription(
    "没有自选模型的 Mind 和对话，用你上次选的模型；还没选过，就用这个。",
  );
});

test("when a provider is removed, the Minds on its models fall back, and each chip says what is used", async () => {
  const ollama = await ollamaListing(["fake-model"]);
  try {
    const window = await start();
    await window.evaluate(async (baseUrl) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.saveChatProvider({ kind: "ollama", baseUrl, modelId: "fake-model" });
    }, ollama.url);
    const anthropic = await connectAnthropic(window, HAIKU, true);

    await newMind(window);
    await nameMind(window, "Own pick");
    await expect(chipOf(window)).toHaveText("fake-model");
    await chooseInChip(window, "Claude Haiku 5.5");
    await expect.poll(() => lastPick(window)).toEqual({ providerId: anthropic, modelId: HAIKU });
    await newMind(window);
    await nameMind(window, "No pick");
    await expect(chipOf(window)).toHaveText("Claude Haiku 5.5");

    await (await coreOf(window)).evaluate((core, id) => core.deleteChatProvider(id), anthropic);
    expect(await lastPick(window)).toBeNull();

    await expect(chipOf(window)).toHaveText("fake-model");
    const answer = await askInAssistant(window, "Which model answers now?");
    await expect(await openSteps(window, answer)).toContainText("Answered by fake-model");
    await openMindNamed(window, "Own pick");
    await expect(chipOf(window)).toHaveText("fake-model");
    await newMind(window);
    await expect(chipOf(window)).toHaveText("fake-model");
  } finally {
    ollama.server.close();
  }
});

test("with no Mind in focus, the model chosen in the assistant is kept, and kept across a restart", async () => {
  const ollama = await ollamaListing(["fake-model", "other-model"]);
  try {
    let window = await start();
    await window.evaluate(async (baseUrl) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.saveChatProvider({ kind: "ollama", baseUrl, modelId: "fake-model" });
    }, ollama.url);

    await newMind(window);
    await pointAndClick(window, window.getByTestId("open-library"));
    await expect(chipOf(window)).toHaveText("fake-model");
    await chooseInChip(window, "other-model");
    await expect(chipOf(window)).toHaveText("other-model");
    const answer = await askInAssistant(window, "Which model answers?");
    await expect(await openSteps(window, answer)).toContainText("Answered by other-model");
    await quit();

    window = await start();
    await pointAndClick(window, window.getByTestId("open-library"));
    await expect(chipOf(window)).toHaveText("other-model");
  } finally {
    ollama.server.close();
  }
});
