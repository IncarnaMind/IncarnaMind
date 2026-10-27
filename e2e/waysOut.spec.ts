import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, SaveChatProviderInput } from "../src/core/api";
import { createFakeGitHub, LOGIN, USER_CODE } from "../tests/helpers/fakeGitHub";
import {
  acceptPlainTextKeys,
  addDocuments,
  addProviderForm,
  addProviderPage,
  assistantAnswers,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  motionSettled,
  newMind,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  urlsOpened,
} from "./app";

/*
 * A new User's dead ends lead somewhere (#765): a refused key opens its field
 * in Settings and the Question is asked again once a new one is saved; a
 * model that can't add Citations says so with a way to another model; and
 * with no Ollama, the first-run choice offers to get it. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** Nothing listens here: as if Ollama weren't on this computer. */
const NO_OLLAMA = "http://127.0.0.1:9";

const ATTENTION = "rgb(217, 119, 6)";

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const saveProvider = (window: Page, input: SaveChatProviderInput) =>
  window.evaluate(async (provider) => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider(
      provider,
    );
  }, input);

const setLocalMode = (window: Page, on: boolean) =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setLocalOnly(value),
    on,
  );

/** The dot leads the line: it ends before the text and sits on its first line. */
async function expectDotLeads(dot: Locator, line: Locator): Promise<void> {
  const [dotBox, lineBox] = await Promise.all([dot.boundingBox(), line.boundingBox()]);
  if (!dotBox || !lineBox) throw new Error("The dot and its line aren't laid out.");
  expect(dotBox.x + dotBox.width).toBeLessThanOrEqual(lineBox.x);
  expect(dotBox.y).toBeGreaterThanOrEqual(lineBox.y);
  expect(dotBox.y + dotBox.height).toBeLessThanOrEqual(lineBox.y + 22);
}

/** Asks in the assistant beside the Mind, and returns the Answer once it has ended. */
async function ask(window: Page, question: string): Promise<Locator> {
  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(before + 1);
  const answer = answers.last();
  await expect(answer).toHaveAttribute("data-status", /^(done|failed)$/, { timeout: 15_000 });
  return answer;
}

test("a refused key: Check the key opens its field with the refusal, and once a new key is saved the Question is asked again", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, ollama: NO_OLLAMA });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  // Linux in CI has no keyring: keys are kept in plain text there, once accepted.
  await acceptPlainTextKeys(window);
  await saveProvider(window, {
    kind: "anthropic",
    apiKey: "sk-ant-refused-0000",
    modelId: "claude-haiku-5-5",
  });
  await newMind(window);
  await window.getByTestId("mind-editor").click();

  const answer = await ask(window, "What is in my Documents?");
  await expect(answer).toHaveAttribute("data-status", "failed");

  const models = await openSettings(window, "models");
  const health = models.getByTestId("model-health");
  await expect(health).toHaveText("The key for Claude Haiku 5.5 was refused · Check the key");
  const dot = health.getByTestId("model-health-dot");
  await expect(dot).toHaveCSS("background-color", ATTENTION);
  await expectDotLeads(dot, health.getByTestId("answer-error"));
  await screenshot(models, "model-health-refused");
  await setLanguage(window, "zh-CN");
  await expect(health).toHaveText("Claude Haiku 5.5 的密钥被拒绝了 · 检查密钥");
  await setLanguage(window, "en");
  await closeSettings(window);

  const error = answer.getByTestId("answer-error");
  await expect(error).toContainText("The key for Claude Haiku 5.5 was refused");
  const action = error.getByTestId("answer-error-action");
  await expect(action).toHaveText("Check the key");
  await pointAndClick(window, action);

  // Anthropic's key field, open, focused, with the refusal said beside it.
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "models");
  const page = settings.getByTestId("provider-page");
  await expect(page.getByTestId("provider-page-title")).toHaveText("Anthropic");
  const key = page.getByTestId("provider-page-key");
  await expect(key).toBeFocused();
  await expect(key).toBeInViewport();
  const refusal = page.getByTestId("provider-key-refused");
  await expect(refusal).toHaveText(/^Anthropic refused this key \(Today, .+\)\.$/);
  await motionSettled(window);
  await screenshot(window, "key-refused-settings");

  await window.keyboard.type("sk-ant-new-key");
  await window.keyboard.press("Enter");
  await expect(refusal).toHaveCount(0);
  await expect(key).toHaveValue("");
  await settings.getByTestId("models-back").click();
  await expect(settings.getByTestId("model-health")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // The Answer offers to ask again, and asking again answers.
  await expect(action).toHaveText("Ask again");
  await screenshot(answer, "key-refused-ask-again");
  await pointAndClick(window, action);
  const answered = assistantAnswers(window).last();
  await expect(answered).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answered.getByTestId("assistant-answer-text")).not.toBeEmpty();
  await app.close();
});

test("a model that can't add Citations says so under its Answer, and Choose another model opens the model menu", async () => {
  await writeFile(
    join(sources, "Tides.md"),
    "# Tides\n\nSpring tides happen at new moon and at full moon.\n",
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true, ollama: NO_OLLAMA });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await saveProvider(window, { kind: "ollama", modelId: "tiny-no-tools" });
  await addDocuments(window, [join(sources, "Tides.md")]);
  await newMind(window);
  await window.getByTestId("mind-editor").click();

  const answer = await ask(window, "When do spring tides happen?");
  await expect(answer).toHaveAttribute("data-status", "done");
  const line = answer.getByTestId("answer-no-citations");
  await expect(line).toHaveText(
    "tiny-no-tools can’t add Citations: nothing here is checked · Choose another model",
  );
  await screenshot(answer, "no-citations-line");
  await pointAndClick(window, line.getByTestId("answer-choose-model"));
  await expect(window.getByTestId("composer-model-menu")).toBeVisible();
  await window.keyboard.press("Escape");

  await setLanguage(window, "zh-CN");
  await expect(line).toHaveText("tiny-no-tools 无法添加引用：这里的内容均未核对 · 换一个模型");
  await screenshot(answer, "no-citations-line-zh");
  await app.close();
});

test("with no Ollama on this computer, the setup card's local way says so, and opened offers Get Ollama before Check again", async () => {
  const { app, window } = await launchApp(dataDir, { ollama: NO_OLLAMA });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 1200, 860);
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("What is in my Documents?");
  await window.keyboard.press("Enter");
  const setup = window.getByTestId("model-setup");
  await expect(setup).toBeVisible();
  // A model on this computer is one of the ways in from the start (#1922), and says it needs Ollama.
  const local = setup.getByTestId("way-local");
  await expect(local).toContainText("Install a model on this computer…");
  await expect(local.getByTestId("ollama-status")).toHaveText("Needs the free Ollama app");
  const get = setup.getByTestId("ollama-get");
  const again = setup.getByTestId("ollama-check-again");
  await expect(get).toHaveText("Get Ollama ↗");
  await expect(again).toHaveText("Check again");
  const getBox = await get.boundingBox();
  const againBox = await again.boundingBox();
  expect(getBox && againBox && getBox.x + getBox.width <= againBox.x).toBe(true);
  await screenshot(setup, "first-run-get-ollama");

  await pointAndClick(window, get);
  await expect.poll(() => urlsOpened(app)).toEqual(["https://ollama.com/download"]);
  await app.close();
});

test("a choice that can't be used right now says why, with its next step: Ollama not running, and in local mode a hosted provider, the plans and the model menu; English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, ollama: NO_OLLAMA });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await acceptPlainTextKeys(window);
  await setLocalMode(window, true);

  const settings = await openSettings(window, "models");
  const ollama = await addProviderPage(settings, "ollama");
  await expect(ollama.getByTestId("ollama-status")).toHaveText(
    "Install and start Ollama from ollama.com to run models here.",
  );
  await expect(ollama.getByTestId("ollama-get")).toHaveText("Get Ollama ↗");
  await expect(ollama.getByTestId("ollama-check-again")).toHaveText("Check again");
  await expect(ollama.getByTestId("local-mode-unavailable")).toHaveCount(0);
  await setLanguage(window, "zh-CN");
  await expect(ollama.getByTestId("ollama-status")).toHaveText(
    "要在本机运行模型，请从 ollama.com 安装并启动 Ollama。",
  );
  await expect(ollama.getByTestId("ollama-get")).toHaveText("下载 Ollama ↗");
  await expect(ollama.getByTestId("ollama-check-again")).toHaveText("重新检查");
  await setLanguage(window, "en");
  await settings.getByTestId("models-back").click();

  const hosted = await addProviderPage(settings, "anthropic");
  const hostedLine = hosted.getByTestId("local-mode-unavailable");
  const plansLine = settings.getByTestId("plans-settings").getByTestId("local-mode-unavailable");
  const unavailable = "Unavailable: “Keep everything on this computer” is on · Allow cloud models";
  await expect(hostedLine).toHaveText(unavailable);
  await screenshot(settings, "why-unavailable-provider-en");
  await setLanguage(window, "zh-CN");
  await expect(hostedLine).toHaveText(
    "不可用：已开启“所有内容都留在这台电脑上” · 允许使用云端模型",
  );
  await screenshot(settings, "why-unavailable-provider-zh");
  await setLanguage(window, "en");
  await settings.getByTestId("models-back").click();

  await expect(plansLine).toHaveText(unavailable);
  await screenshot(settings, "why-unavailable-plans-en");
  await plansLine.getByTestId("local-mode-turn-off").click();
  await expect(plansLine).toHaveCount(0);
  const undo = settings.getByTestId("undo-line-here");
  await expect(undo.getByTestId("undo-message")).toHaveText(
    "Turned off “Keep everything on this computer”",
  );
  await undo.getByTestId("undo-action").click();
  await expect(plansLine).toHaveText(unavailable);
  await closeSettings(window);

  await saveProvider(window, {
    kind: "anthropic",
    apiKey: "sk-ant-test-0000",
    modelId: "claude-haiku-5-5",
  });
  await newMind(window);
  await window.getByTestId("composer-model").click();
  const option = window.getByTestId("composer-model-option").first();
  await expect(option).toHaveAttribute("aria-disabled", "true");
  const way = window.getByTestId("composer-model-local-mode");
  await expect(way).toHaveText(unavailable);
  await screenshot(window.getByTestId("composer-model-menu"), "why-unavailable-menu-en");
  await way.getByTestId("composer-model-local-off").click();
  await expect(window.getByTestId("undo-message")).toHaveText(
    "Turned off “Keep everything on this computer”",
  );
  await expect(way).toHaveCount(0);
  expect(
    await window.evaluate(
      async () =>
        (
          await (
            globalThis as unknown as { incarnamind: CoreBridge }
          ).incarnamind.getEmbeddingSettings()
        ).localOnly,
    ),
  ).toBe(false);
  await app.close();
});

test("the default model's failure line is about the model in use: another model of the same provider doesn't show a model's failure; English and Chinese", async () => {
  const unknown = "claude-haiku-5-5-not-found";
  const { app, window } = await launchApp(dataDir, { fakeChat: true, ollama: NO_OLLAMA });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await acceptPlainTextKeys(window);
  await window.evaluate(async (modelId) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await bridge.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test-0000",
      modelId,
    });
    await bridge.setChatModelInMenu({
      providerId: provider.id,
      modelId: "claude-haiku-5-5",
      inMenu: true,
    });
  }, unknown);
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  const answer = await ask(window, "What is in my Documents?");
  await expect(answer).toHaveAttribute("data-status", "failed");

  const models = await openSettings(window, "models");
  const health = models.getByTestId("model-health");
  await expect(health).toHaveText(`Anthropic doesn’t know ${unknown} · Choose another model`);
  await setLanguage(window, "zh-CN");
  await expect(health).toHaveText(`Anthropic 找不到 ${unknown} · 换一个模型`);
  await setLanguage(window, "en");

  await models
    .getByTestId("model-default-chatModel")
    .selectOption({ label: "Claude Haiku 5.5 · Anthropic" });
  await expect(health).toHaveCount(0);
  await app.close();
});

test("signing in again to a plan clears its failure line before anything is asked again, and so does an Answer that works", async () => {
  const github = await createFakeGitHub();
  const { app, window } = await launchApp(dataDir, { copilot: github.origin, ollama: NO_OLLAMA });
  try {
    await interceptOpenExternal(app);
    await setWindowSize(app, window, 1440, 900);
    await acceptPlainTextKeys(window);
    const settings = await openSettings(window, "models");
    const row = settings.getByTestId("plans-copilot");
    await row.getByTestId("plans-copilot-sign-in").focus();
    await window.keyboard.press("Enter");
    await expect(row.getByTestId("copilot-cancel")).toBeFocused();
    await window.keyboard.press("Shift+Tab");
    await window.keyboard.press("Enter");
    await expect(row.getByTestId("copilot-code")).toBeVisible();
    github.approve();
    await expect(row.getByTestId("plans-copilot-account")).toHaveText(`Copilot Pro+ · ${LOGIN}`);
    await closeSettings(window);

    const refusal = {
      kind: "error" as const,
      status: 403,
      body: JSON.stringify({ message: "Resource not accessible by integration" }),
    };
    github.replies.push(refusal, refusal, refusal, refusal);
    await newMind(window);
    await window.getByTestId("mind-editor").click();
    const answer = await ask(window, "What does my plan cover?");
    await expect(answer).toHaveAttribute("data-status", "failed");

    await openSettings(window, "models");
    const health = settings.getByTestId("model-health");
    await expect(health).toHaveText(
      "GitHub didn’t let IncarnaMind use your Copilot plan · Sign in again · Use an API key instead",
    );
    await setLanguage(window, "zh-CN");
    await expect(health).toHaveText(
      "GitHub 不允许 IncarnaMind 使用你的 Copilot 订阅 · 重新登录 · 改用 API 密钥",
    );
    await setLanguage(window, "en");
    await pointAndClick(window, health.getByTestId("answer-error-action"));
    await pointAndClick(window, row.getByTestId("copilot-sign-in"));
    await expect(row.getByTestId("copilot-code")).toHaveText(USER_CODE);
    github.approve();
    await expect(row.getByTestId("copilot-notice")).toBeHidden();
    await expect(health).toHaveCount(0);
    await expect(assistantAnswers(window)).toHaveCount(1);
    await closeSettings(window);

    github.replies.push(refusal, refusal, refusal, refusal);
    const refused = await ask(window, "Who pays for it?");
    await expect(refused).toHaveAttribute("data-status", "failed");
    await openSettings(window, "models");
    await expect(health).toBeVisible();
    await closeSettings(window);
    github.replies.length = 0;
    const answered = await ask(window, "Who owns it?");
    await expect(answered).toHaveAttribute("data-status", "done");
    await openSettings(window, "models");
    await expect(health).toHaveCount(0);
  } finally {
    await app.close();
    await github.close();
  }
});

test("with local mode on, a hosted provider's key can still be saved: its field stays usable beside the line", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, ollama: NO_OLLAMA });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await acceptPlainTextKeys(window);
  await saveProvider(window, {
    kind: "anthropic",
    apiKey: "sk-ant-first-0000",
    modelId: "claude-haiku-5-5",
  });
  await setLocalMode(window, true);

  const settings = await openSettings(window, "models");
  await settings.getByTestId("provider-row").first().click();
  const page = settings.getByTestId("provider-page");
  await expect(page.getByTestId("local-mode-unavailable")).toBeVisible();
  const key = page.getByTestId("provider-page-key");
  await expect(key).toBeEditable();
  await key.fill("sk-ant-second-0000");
  const save = page.getByTestId("provider-page-save-key");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(key).toHaveValue("");
  await expect(page.getByTestId("provider-page-key-error")).toHaveCount(0);
  await settings.getByTestId("models-back").click();

  const form = await addProviderForm(settings, "openai");
  const addKey = form.locator('input[type="password"]');
  await expect(addKey).toBeEditable();
  await addKey.fill(`sk-proj-${"aZ3".repeat(20)}`);
  const use = form.getByTestId("provider-use-key");
  await expect(use).toBeEnabled();
  await use.click();
  await expect(settings.getByTestId("provider-page-title")).toHaveText("OpenAI");
  await app.close();
});
