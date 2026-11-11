import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  askInAssistant,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  frontMind,
  frontMindName,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  ollamaListing,
  openSteps,
  pointAndClick,
  removeDataFolder,
  runCommand,
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
const removedLine = (window: Page) => window.getByTestId("composer-model-removed");

/** Removes the saved provider of a kind, as Settings › AI's Remove does. */
async function removeProviderOf(window: Page, kind: string): Promise<void> {
  await (await coreOf(window)).evaluate(async (core, wanted) => {
    const provider = (await core.listChatProviders()).find((each) => each.kind === wanted);
    if (provider) await core.deleteChatProvider(provider.id);
  }, kind);
}

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
    await expect(removedLine(window)).toContainText(
      "Claude Haiku 5.5 was removed, so this note now uses fake-model",
    );
    const answer = await askInAssistant(window, "Which model answers now?");
    await expect(await openSteps(window, answer)).toContainText("Answered by fake-model");
  } finally {
    ollama.server.close();
  }
});

test("a note whose model was removed says so once under the chip, in English and Chinese; a pick or Close ends it for good, through a restart and ⌘Z; a note whose provider is saved says nothing", async () => {
  test.setTimeout(180_000);
  const ollama = await ollamaListing(["fake-model"]);
  try {
    let window = await start();
    await connectOllama(window, ollama.url);
    await connectAnthropic(window, SONNET);
    for (const [name, model] of [
      ["Picks", "fake-model"],
      ["Closes", "fake-model"],
      ["Waits", "fake-model"],
      ["Saved", "Claude Haiku 5.5"],
    ] as const) {
      await newMind(window);
      await nameMind(window, name);
      await chooseInChip(window, model);
    }
    await newMind(window);
    await nameMind(window, "Plain");
    await removeProviderOf(window, "ollama");
    const line = removedLine(window);
    const change = line.getByTestId("composer-model-removed-change");
    const close = line.getByTestId("composer-model-removed-close");

    // The line sits under the chip, and Change opens the chip's menu; a pick ends it.
    await openMindNamed(window, "Picks");
    await expect(line).toContainText(
      "fake-model was removed, so this note now uses Claude Sonnet 5.5",
    );
    await expect(chipOf(window)).toHaveText("Sonnet 5.5");
    const chipBox = await chipOf(window).boundingBox();
    const lineBox = await line.boundingBox();
    if (!chipBox || !lineBox) throw new Error("The chip and the line aren't drawn.");
    expect(lineBox.y).toBeGreaterThanOrEqual(chipBox.y + chipBox.height);
    await expect(change).toHaveText("Change");
    await expect(close).toHaveText("Close");
    await pointAndClick(window, change);
    await expect(menuOf(window)).toBeVisible();
    const option = menuOf(window)
      .getByTestId("composer-model-option")
      .filter({ hasText: "Claude Haiku 5.5" });
    await motionSettled(window);
    await pointAndClick(window, option);
    await expect(menuOf(window)).toBeHidden();
    await expect(line).toHaveCount(0);
    await expect(chipOf(window)).toHaveText("Haiku 5.5");

    // A note with no pick, and one whose provider is saved, have nothing to say.
    await openMindNamed(window, "Plain");
    await expect(chipOf(window)).toHaveText("Sonnet 5.5");
    await expect(line).toHaveCount(0);
    await openMindNamed(window, "Saved");
    await expect(chipOf(window)).toHaveText("Haiku 5.5");
    await expect(line).toHaveCount(0);

    // Close ends it too; ⌘Z in the note takes back the typing, not the line's end.
    await openMindNamed(window, "Closes");
    await expect(line).toBeVisible();
    await pointAndClick(window, close);
    await expect(line).toHaveCount(0);
    await expect(chipOf(window)).toHaveText("Sonnet 5.5");
    await frontMind(window).locator(".mind-editor").click();
    await window.keyboard.type("Typed after closing");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(line).toHaveCount(0);

    // The keyboard reaches Change, and so does ⌘K; the words are Chinese in Chinese.
    await openMindNamed(window, "Waits");
    await expect(line).toBeVisible();
    await change.focus();
    await window.keyboard.press("Enter");
    await expect(menuOf(window)).toBeVisible();
    await closeMenu(window);
    await runCommand(window, "model.changeRemoved", "Choose another model for this note");
    await expect(menuOf(window)).toBeVisible();
    await closeMenu(window);
    await setLanguage(window, "zh-CN");
    await expect(line).toContainText("已移除 fake-model，这篇笔记现在使用 Claude Sonnet 5.5");
    await expect(change).toHaveText("更改");
    await expect(close).toHaveText("关闭");

    // After a restart, an ended line stays ended and an open one is still there, once.
    await quit();
    window = await start();
    await openMindNamed(window, "Picks");
    await expect(chipOf(window)).toHaveText("Haiku 5.5");
    await expect(removedLine(window)).toHaveCount(0);
    await openMindNamed(window, "Closes");
    await expect(chipOf(window)).toHaveText("Sonnet 5.5");
    await expect(removedLine(window)).toHaveCount(0);
    await openMindNamed(window, "Waits");
    await expect(removedLine(window)).toHaveCount(1);
    await expect(removedLine(window)).toContainText("已移除 fake-model");
  } finally {
    ollama.server.close();
  }
});

test("a second window on the same note shows the line too, and closing it in one window closes it in both", async () => {
  test.setTimeout(180_000);
  const ollama = await ollamaListing(["fake-model"]);
  try {
    const window = await start();
    await connectOllama(window, ollama.url);
    await connectAnthropic(window, SONNET);
    await newMind(window);
    await nameMind(window, "Shared");
    await chooseInChip(window, "fake-model");
    await removeProviderOf(window, "ollama");
    await expect(removedLine(window)).toBeVisible();

    if (!running) throw new Error("The app isn't running.");
    const info = await running.evaluate(({ app, BrowserWindow }) => {
      const [first] = BrowserWindow.getAllWindows();
      if (!first) throw new Error("The app has no window.");
      return {
        url: first.webContents.getURL(),
        preload: `${app.getAppPath()}/out/preload/index.js`,
      };
    });
    const spawned = running.waitForEvent("window");
    await running.evaluate(({ BrowserWindow }, values) => {
      const win = new BrowserWindow({
        width: 1100,
        height: 800,
        show: true,
        webPreferences: {
          preload: values.preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      void win.loadURL(values.url);
    }, info);
    const second = await spawned;
    await second.waitForLoadState("domcontentloaded");
    await second
      .getByTestId("tab-strip")
      .getByRole("tab", { name: /Shared/u })
      .click();
    await expect(removedLine(second)).toBeVisible({ timeout: 20_000 });

    await pointAndClick(second, removedLine(second).getByTestId("composer-model-removed-close"));
    await expect(removedLine(second)).toHaveCount(0);
    await expect(removedLine(window)).toHaveCount(0);
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
