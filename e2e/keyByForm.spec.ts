import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  ANTHROPIC_KEY,
  acceptPlainTextKeys,
  askFirstQuestion,
  assistantAnswers,
  createDataFolder,
  interceptOpenDialog,
  launchApp,
  pasteText,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  welcomeStep as step,
} from "./app";

/*
 * A key is recognised by its form only (#2865). In Chinese, a key in the form DeepSeek and Qwen
 * share is used after one press of Use this key, DeepSeek asked first, so the first Answer comes
 * as soon as with a key whose form names its service, plus that press; nothing is saved, and
 * nothing of the key reaches the core, before it. The fake chat model answers: no network.
 */

/** Made up in the form DeepSeek's and Qwen's keys share: never a real key. */
const SHARED_KEY = `sk-${"0123456789abcdef".repeat(2)}`;

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

const savedProviders = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listChatProviders()).map((each) => each.catalogId ?? each.kind);
  });

for (const { key, name, service, presses } of [
  { key: SHARED_KEY, name: "a DeepSeek-form", service: "deepseek", presses: 1 },
  { key: ANTHROPIC_KEY, name: "an Anthropic", service: "anthropic", presses: 0 },
] as const) {
  test(`in Chinese, ${name} key pasted on the first-run card is used ${presses === 1 ? "after one press of Use this key" : "at once"}, and the first Answer comes within 6 steps`, async () => {
    test.setTimeout(120_000);
    const file = join(sources, "项目简报.md");
    await writeFile(file, "# 项目简报\n\n项目简报写明了港口计划。\n");
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      examples: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 1440, 900);
      await acceptPlainTextKeys(window);
      await setLanguage(window, "zh-CN");
      let steps = 0;

      // 1 and 2: Add files…, and the file picked in the system's dialog.
      const files = step(window, "files");
      await expect(files).toHaveAttribute("data-state", "open");
      await interceptOpenDialog(app, file);
      await pointAndClick(window, files.getByTestId("first-open-add-files"));
      steps += 2;

      // 3: Ask, the Question about the file it offers; with no AI yet, the card asks for one.
      const ready = step(window, "question").getByTestId("first-open-ready");
      await expect(ready).toHaveText("提问：“项目简报”讲了什么？", { timeout: 30_000 });
      await pointAndClick(window, ready);
      steps += 1;
      const card = window.getByTestId("model-setup");
      await expect(card).toBeVisible();
      const field = card.getByTestId("setup-key");
      await expect(field).toBeFocused();
      await expect(card.getByTestId("setup-key-line")).toHaveText(
        "可以识别 DeepSeek、通义千问、智谱 GLM、硅基流动等服务的密钥。",
      );

      // 4: the key, pasted.
      await pasteText(app, window, key);
      steps += 1;
      if (presses === 1) {
        const ask = card.getByTestId("setup-key-ask");
        await expect(ask).toHaveText("是 DeepSeek 吗？· 使用这个密钥 · 换一个服务");
        // Asked, not yet chosen: nothing is saved and the Question still waits.
        expect(await savedProviders(window)).toEqual([]);
        await expect(window.getByTestId("assistant-waiting-model")).toBeVisible();
        // 5: Use this key.
        await pointAndClick(window, ask.getByTestId("setup-key-use"));
        steps += 1;
      }

      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 30_000,
      });
      expect(await savedProviders(window)).toEqual([service]);
      expect(steps).toBeLessThanOrEqual(6);
      expect(steps).toBe(4 + presses);
    } finally {
      await app.close();
    }
  });
}

test("in English the same key asks in English, Another service opens the service choice on the next service its form may be with the key kept, and the plans stay first", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 900, 800);
    await acceptPlainTextKeys(window);
    await setLanguage(window, "en");
    const card = await askFirstQuestion(window);
    await expect(card.getByTestId("setup-key-line")).toHaveText(
      translate("en", "setup.key.recognised"),
    );
    const order = await card.evaluate((element) =>
      [
        ...element.querySelectorAll(
          '[data-testid="setup-chatgpt"], [data-testid="way-local"], [data-testid="setup-other"]',
        ),
      ].map((each) => each.getAttribute("data-testid")),
    );
    expect(order).toEqual(["setup-chatgpt", "way-local", "setup-other"]);
    await expect(card.getByTestId("setup-chatgpt")).toBeVisible();

    await pasteText(app, window, SHARED_KEY);
    const ask = card.getByTestId("setup-key-ask");
    await expect(ask).toHaveText("DeepSeek? · Use this key · Another service");
    await pointAndClick(window, ask.getByTestId("setup-key-other-service"));

    const form = card.getByTestId("provider-form");
    await expect(form).toBeVisible();
    await expect(form.getByRole("radio", { name: "Qwen", exact: true })).toBeChecked();
    await expect(form.locator('input[type="password"]')).toHaveValue(SHARED_KEY);
    expect(await savedProviders(window)).toEqual([]);
  } finally {
    await app.close();
  }
});
