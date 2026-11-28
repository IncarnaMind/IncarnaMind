import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, SaveChatProviderInput } from "../src/core/api";
import { createFakeGitHub, LOGIN, USER_CODE } from "../tests/helpers/fakeGitHub";
import {
  acceptPlainTextKeys,
  addDocuments,
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
} from "./app";

/*
 * A new User's dead ends lead somewhere (#765): a refused key opens its field
 * in Settings and the Question is asked again once a new one is saved; a
 * model that can't add Citations says so with a way to another model; and a
 * saved provider that local mode stops says why, with the way to turn it off.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
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
  window.evaluate(
    async (provider) =>
      (
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider(
          provider,
        )
      ).id,
    input,
  );

/** A saved provider's own page, from Settings › AI's Accounts and keys. */
async function openProviderPage(settings: Locator, providerId: string): Promise<Locator> {
  await settings.locator(`[data-testid="provider-row"][data-provider-id="${providerId}"]`).click();
  const page = settings.getByTestId("provider-page");
  await expect(page).toBeVisible();
  return page;
}

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

  const models = await openSettings(window, "ai");
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
  await expect(settings).toHaveAttribute("data-page", "ai");
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

test("a choice that can't be used right now says why, with its next step: in local mode a saved hosted provider, a saved plan and the model menu; English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, ollama: NO_OLLAMA });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await acceptPlainTextKeys(window);
  const plan = await saveProvider(window, { kind: "chatgpt", modelId: "gpt-5.5" });
  const anthropic = await saveProvider(window, {
    kind: "anthropic",
    apiKey: "sk-ant-test-0000",
    modelId: "claude-haiku-5-5",
  });
  await setLocalMode(window, true);

  const settings = await openSettings(window, "ai");
  const hosted = await openProviderPage(settings, anthropic);
  const hostedLine = hosted.getByTestId("local-mode-unavailable");
  const plansLine = settings.getByTestId("provider-page").getByTestId("local-mode-unavailable");
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

  // A saved plan's own page says so too.
  await openProviderPage(settings, plan);
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

  const models = await openSettings(window, "ai");
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
    // No plan is added in IncarnaMind (#3767): this one is saved through the bridge.
    const copilot = await saveProvider(window, { kind: "copilot", modelId: "gpt-5.5" });
    await openProviderPage(await openSettings(window, "ai"), copilot);
    const row = window.getByTestId("settings").getByTestId("plans-copilot");
    await row.getByTestId("plans-copilot-sign-in").focus();
    await window.keyboard.press("Enter");
    await expect(row.getByTestId("copilot-sign-in")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(row.getByTestId("copilot-code")).toBeVisible();
    github.approve();
    await expect(row.getByTestId("plans-copilot-account")).toHaveText(
      `Signed in to GitHub as ${LOGIN}`,
    );
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

    const settings = await openSettings(window, "ai");
    const health = settings.getByTestId("model-health");
    // No key is added in IncarnaMind (#3767): Sign in again is the line's one way back.
    await expect(health).toHaveText(
      "GitHub didn’t let IncarnaMind use your Copilot plan · Sign in again",
    );
    await setLanguage(window, "zh-CN");
    await expect(health).toHaveText("GitHub 不允许 IncarnaMind 使用你的 Copilot 订阅 · 重新登录");
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
    await openSettings(window, "ai");
    await expect(health).toBeVisible();
    await closeSettings(window);
    github.replies.length = 0;
    const answered = await ask(window, "Who owns it?");
    await expect(answered).toHaveAttribute("data-status", "done");
    await openSettings(window, "ai");
    await expect(health).toHaveCount(0);
  } finally {
    await app.close();
    await github.close();
  }
});

test("with local mode on, a saved hosted provider's key can still be changed: its field stays usable beside the line", async () => {
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

  const settings = await openSettings(window, "ai");
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
  await app.close();
});
