import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
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
  openSteps,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  showSettingsPage,
} from "./app";

/**
 * The composer's model chip picks for one note only (#2836): its menu is headed "This note uses",
 * groups models by who pays, and ends with "Use this for new notes too", which sets the Answers
 * default that new notes, and notes with no pick of their own, follow. The scripted model
 * answers, and an Answer's steps name the model that was asked.
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

async function connectOllama(window: Page, baseUrl: string): Promise<void> {
  await window.evaluate(async (url) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({ kind: "ollama", baseUrl: url, modelId: "fake-model" });
  }, baseUrl);
}

const chipOf = (window: Page) => window.getByTestId("composer-model");
const menuOf = (window: Page) => window.getByTestId("composer-model-menu");

async function openMindNamed(window: Page, name: string): Promise<void> {
  await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: name }));
  await expect(frontMindName(window)).toHaveText(name);
}

const settingsOf = async (window: Page) =>
  (await coreOf(window)).evaluate((core) => core.getSettings());

const answersModel = async (window: Page) => (await settingsOf(window)).user.chatModel;

const setLanguage = async (window: Page, language: "zh-CN") =>
  (await coreOf(window)).evaluate(
    (core, value) => core.updateSettings({ user: { language: value } }),
    language,
  );

async function openMenu(window: Page): Promise<Locator> {
  await motionSettled(window);
  await pointAndClick(window, chipOf(window));
  const menu = menuOf(window);
  await expect(menu).toBeVisible();
  return menu;
}

/** The menu's groups by their names, in order. */
const groupNames = (menu: Locator) =>
  menu.getByRole("group").evaluateAll((all) => all.map((each) => each.getAttribute("aria-label")));

async function closeMenu(window: Page): Promise<void> {
  await window.keyboard.press("Escape");
  await expect(menuOf(window)).toBeHidden();
}

async function chooseInChip(window: Page, name: string): Promise<void> {
  const menu = await openMenu(window);
  const option = menu.getByTestId("composer-model-option").filter({ hasText: name });
  await expect(option).toBeVisible();
  await motionSettled(window);
  await pointAndClick(window, option);
  await expect(menu).toBeHidden();
}

test("a model picked in a note's chip is for that note only: a new note and an older one stay on the Answers default, and each keeps its model through a restart", async () => {
  let window = await start();
  const providerId = await connectAnthropic(window, SONNET);

  await newMind(window);
  await nameMind(window, "Older");
  await expect(chipOf(window)).toHaveText("Sonnet 5.5");

  await newMind(window);
  await nameMind(window, "Picked");
  const menu = await openMenu(window);
  await expect(menu).toHaveAccessibleName("This note uses");
  await expect(menu.getByTestId("composer-model-heading")).toHaveText("This note uses");
  await expect(menu.getByTestId("composer-model-default")).toHaveText(
    "New notes use Claude Sonnet 5.5, from Settings › AI.",
  );
  // The note already uses the Answers default: there is nothing to set.
  await expect(menu.getByTestId("composer-model-for-new")).toHaveAttribute("aria-disabled", "true");
  await closeMenu(window);
  await chooseInChip(window, "Claude Haiku 5.5");
  await expect(chipOf(window)).toHaveText("Haiku 5.5");
  expect(await answersModel(window)).toEqual({ providerId, modelId: SONNET });
  expect(Object.keys((await settingsOf(window)).device)).not.toContain("lastChatModel");

  await openMindNamed(window, "Older");
  await expect(chipOf(window)).toHaveText("Sonnet 5.5");
  const older = await askInAssistant(window, "Which model answers?");
  await expect(await openSteps(window, older)).toContainText("Answered by Claude Sonnet 5.5");

  await newMind(window);
  await nameMind(window, "New");
  await expect(chipOf(window)).toHaveText("Sonnet 5.5");
  await quit();

  window = await start();
  await openMindNamed(window, "Picked");
  await expect(chipOf(window)).toHaveText("Haiku 5.5");
  await openMindNamed(window, "Older");
  await expect(chipOf(window)).toHaveText("Sonnet 5.5");
  await openMindNamed(window, "New");
  await expect(chipOf(window)).toHaveText("Sonnet 5.5");
});

test("“Use this for new notes too” makes the note's model the Answers default, which new notes follow, in English and Chinese", async () => {
  const window = await start();
  const providerId = await connectAnthropic(window, SONNET);

  await newMind(window);
  await nameMind(window, "Haiku note");
  await chooseInChip(window, "Claude Haiku 5.5");
  let menu = await openMenu(window);
  const forNew = menu.getByTestId("composer-model-for-new");
  await expect(forNew).toHaveText("Use this for new notes too");
  await expect(forNew).not.toHaveAttribute("aria-disabled");
  await pointAndClick(window, forNew);
  // The menu stays, so the foot says at once what new notes now use.
  await expect(menu.getByTestId("composer-model-default")).toHaveText(
    "New notes use Claude Haiku 5.5, from Settings › AI.",
  );
  await expect(forNew).toHaveAttribute("aria-disabled", "true");
  await expect.poll(() => answersModel(window)).toEqual({ providerId, modelId: HAIKU });
  await closeMenu(window);

  await newMind(window);
  await expect(chipOf(window)).toHaveText("Haiku 5.5");
  const answer = await askInAssistant(window, "Which model answers a new note?");
  await expect(await openSteps(window, answer)).toContainText("Answered by Claude Haiku 5.5");

  // Settings' Answers row is the same default.
  menu = await openMenu(window);
  await pointAndClick(window, menu.getByTestId("composer-model-settings"));
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "ai");
  const answers = settings.getByTestId("model-default-chatModel");
  await expect(answers).toHaveValue(`${providerId}\n${HAIKU}`);
  await expect(answers).toHaveAccessibleDescription(
    /New notes use this, as do notes and conversations with no model of their own\.$/,
  );
  await settings.getByRole("button", { name: "Close Settings" }).click();

  await setLanguage(window, "zh-CN");
  await newMind(window);
  await chooseInChip(window, "Claude Opus 5.5");
  menu = await openMenu(window);
  await expect(menu).toHaveAccessibleName("这篇笔记使用");
  await expect(menu.getByTestId("composer-model-default")).toHaveText(
    "新笔记使用 Claude Haiku 5.5，在“设置 › AI”中设置。",
  );
  await expect(forNew).toHaveText("新笔记也用这个");
  await pointAndClick(window, forNew);
  await expect(menu.getByTestId("composer-model-default")).toHaveText(
    "新笔记使用 Claude Opus 5.5，在“设置 › AI”中设置。",
  );
  await expect.poll(() => answersModel(window)).toEqual({ providerId, modelId: OPUS });
  await closeMenu(window);
  await newMind(window);
  await expect(chipOf(window)).toHaveText("Opus 5.5");

  await window.getByRole("button", { name: "设置" }).click();
  const settingsZh = await showSettingsPage(window, "ai");
  await expect(settingsZh.getByTestId("model-default-chatModel")).toHaveAccessibleDescription(
    /新笔记使用这个模型，没有自选模型的笔记和对话也使用它。$/,
  );
});

test("the menu groups models by who pays: your plans, your keys, on this computer, in English and Chinese", async () => {
  const ollama = await ollamaListing(["fake-model"]);
  try {
    const window = await start();
    await connectOllama(window, ollama.url);
    await connectAnthropic(window, HAIKU, true);
    await newMind(window);

    const menu = await openMenu(window);
    const groups = menu.getByRole("group");
    await expect(groups).toHaveCount(3);
    expect(await groupNames(menu)).toEqual(["Your plans", "Your keys", "On this computer"]);
    await expect(groups.nth(0)).toContainText("Continue with ChatGPT");
    await expect(groups.nth(1).getByTestId("composer-model-option")).toHaveCount(3);
    await expect(groups.nth(1)).toContainText("Claude Haiku 5.5");
    await expect(groups.nth(2).getByTestId("composer-model-option")).toHaveText([/fake-model/]);
    // The menu ends with what new notes use, in view however long the list: only the models scroll.
    const last = menu.getByRole("menuitem").last();
    await expect(last).toHaveText("Settings › AI");
    await closeMenu(window);
    if (!running) throw new Error("The app isn't running.");
    await setWindowSize(running, window, 1100, 640);
    await openMenu(window);
    await expect(menu.getByTestId("composer-model-heading")).toBeInViewport();
    await expect(menu.getByTestId("composer-model-for-new")).toBeInViewport();
    await expect(menu.getByTestId("composer-model-default")).toBeInViewport();
    await closeMenu(window);

    await setLanguage(window, "zh-CN");
    await openMenu(window);
    expect(await groupNames(menu)).toEqual(["你的订阅", "你的密钥", "在这台电脑上"]);
    await expect(menu.getByTestId("composer-model-heading")).toHaveText("这篇笔记使用");
    await expect(menu.getByTestId("composer-model-for-new")).toHaveText("新笔记也用这个");
  } finally {
    ollama.server.close();
  }
});

test("when a provider is removed, a note on its model falls back to the Answers default, and the chip says so", async () => {
  const ollama = await ollamaListing(["fake-model"]);
  try {
    const window = await start();
    await connectOllama(window, ollama.url);
    const anthropic = await connectAnthropic(window, HAIKU, true);

    await newMind(window);
    await nameMind(window, "Own pick");
    await expect(chipOf(window)).toHaveText("fake-model");
    await chooseInChip(window, "Claude Haiku 5.5");
    await expect(chipOf(window)).toHaveText("Haiku 5.5");

    await (await coreOf(window)).evaluate((core, id) => core.deleteChatProvider(id), anthropic);

    await expect(chipOf(window)).toHaveText("fake-model");
    const answer = await askInAssistant(window, "Which model answers now?");
    await expect(await openSteps(window, answer)).toContainText("Answered by fake-model");
  } finally {
    ollama.server.close();
  }
});

test("with no note in view the chip picks for the conversation: its Questions keep it through History and a restart, a New chat starts on the Answers default, and a note added from it goes on with it", async () => {
  const ollama = await ollamaListing(["fake-model", "other-model"]);
  try {
    let window = await start();
    await connectOllama(window, ollama.url);
    await pointAndClick(window, window.getByTestId("open-library"));
    await expect(chipOf(window)).toHaveText("fake-model");
    const menu = await openMenu(window);
    await expect(menu).toHaveAccessibleName("This conversation uses");
    await expect(menu.getByTestId("composer-model-heading")).toHaveText("This conversation uses");
    await closeMenu(window);
    await chooseInChip(window, "other-model");
    await expect(chipOf(window)).toHaveText("other-model");
    const question = "Which model answers?";
    const answer = await askInAssistant(window, question);
    await expect(await openSteps(window, answer)).toContainText("Answered by other-model");

    // A New chat starts on the Answers default; the conversation, reopened from History, goes on.
    await pointAndClick(window, window.getByTestId("assistant-new-chat"));
    await expect(chipOf(window)).toHaveText("fake-model");
    await pointAndClick(window, window.getByTestId("assistant-title"));
    await pointAndClick(
      window,
      window.getByTestId("assistant-history-row").filter({ hasText: "Which model answers" }),
    );
    await expect(chipOf(window)).toHaveText("other-model");
    await setLanguage(window, "zh-CN");
    await openMenu(window);
    await expect(menu.getByTestId("composer-model-heading")).toHaveText("这个对话使用");
    await closeMenu(window);
    await quit();

    window = await start();
    await pointAndClick(window, window.getByTestId("open-library"));
    await expect(chipOf(window)).toHaveText("other-model");
    const again = await askInAssistant(window, "And now?");
    await expect(await openSteps(window, again)).toContainText("由 other-model 回答");

    // Written as a note, the Answer's model goes with it; a note made by hand doesn't take it.
    await pointAndClick(window, again.getByTestId("answer-write-note"));
    await expect(window.getByTestId("mind-list-item")).toHaveCount(1);
    await expect(chipOf(window)).toHaveText("other-model");
    await newMind(window);
    await expect(chipOf(window)).toHaveText("fake-model");
  } finally {
    ollama.server.close();
  }
});
