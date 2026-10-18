import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, SaveChatProviderInput } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addDocuments,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  motionSettled,
  newMind,
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
  const error = answer.getByTestId("answer-error");
  await expect(error).toContainText("The key for Claude Haiku 5.5 was refused");
  const action = error.getByTestId("answer-error-action");
  await expect(action).toHaveText("Check the key");
  await pointAndClick(window, action);

  // Anthropic's key field, open, focused, with the refusal said beside it.
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "models");
  const form = settings.getByTestId("provider-form");
  await expect(form.getByRole("radio", { name: "Anthropic" })).toBeChecked();
  const key = form.locator('input[type="password"]');
  await expect(key).toBeFocused();
  await expect(key).toBeInViewport();
  await expect(form.getByTestId("provider-key-refused")).toHaveText(
    /^Anthropic refused this key \(Today, .+\)\.$/,
  );
  await motionSettled(window);
  await screenshot(window, "key-refused-settings");

  await window.keyboard.type("sk-ant-new-key");
  await form.getByTestId("provider-use-key").click();
  await expect(form).toBeHidden();
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
  await setup.getByTestId("setup-other").click();
  const local = setup.getByTestId("way-local");
  await expect(local).toContainText("Needs the free Ollama app");
  await local.click();
  await expect(setup.getByTestId("ollama-status")).toHaveText(
    "Install and start Ollama from ollama.com to run models here.",
  );
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
