import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  ANTHROPIC_KEY,
  acceptPlainTextKeys,
  askFirstQuestion,
  assistantAnswers,
  createDataFolder,
  fakeChatRequests,
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
 * as soon as with a key whose form names its service, plus that press. The fake chat model
 * answers, with no network, and keeps every request it was sent: none carries the key before the
 * User says where it goes, however it was entered, and then all go there.
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

/** Where the requests that carried `key` would have gone: each service and region, once. */
async function sentWith(app: ElectronApplication, key: string) {
  const places = (await fakeChatRequests(app))
    .filter((request) => request.apiKey === key)
    .map(({ service, endpoint }) => (endpoint ? `${service} · ${endpoint}` : service));
  return [...new Set(places)];
}

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
        // Asked, not yet chosen: nothing is sent or saved, and the Question still waits.
        expect(await sentWith(app, key)).toEqual([]);
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
      expect(await sentWith(app, key)).toEqual([service]);
      expect(steps).toBeLessThanOrEqual(6);
      expect(steps).toBe(4 + presses);
    } finally {
      await app.close();
    }
  });
}

test("in English, a key typed and sent with Enter, then another pasted, asks each time and goes nowhere; Another service keeps it while a service is picked, and it goes only there", async () => {
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

    // Typed, then Enter: the line asks, and nothing is sent.
    const field = card.getByTestId("setup-key");
    await field.fill(SHARED_KEY);
    await field.press("Enter");
    const ask = card.getByTestId("setup-key-ask");
    await expect(ask).toHaveText("DeepSeek? · Use this key · Another service");
    expect(await sentWith(app, SHARED_KEY)).toEqual([]);

    // Another key pasted over it: the line asks again, and neither is sent.
    const second = `sk-${"fedcba9876543210".repeat(2)}`;
    await field.selectText();
    await pasteText(app, window, second);
    await expect(field).toHaveValue(second);
    await expect(ask).toHaveText("DeepSeek? · Use this key · Another service");
    expect(await sentWith(app, SHARED_KEY)).toEqual([]);
    expect(await sentWith(app, second)).toEqual([]);

    await pointAndClick(window, ask.getByTestId("setup-key-other-service"));
    const form = card.getByTestId("provider-form");
    await expect(form).toBeVisible();
    await expect(form.getByRole("radio", { name: "Qwen", exact: true })).toBeChecked();
    const key = form.locator('input[type="password"]');
    await expect(key).toHaveValue(second);

    // The key was typed for no service: it stays while the User picks one, and goes nowhere.
    await form.getByRole("radio", { name: "Kimi", exact: true }).check({ force: true });
    await expect(key).toHaveValue(second);
    expect(await sentWith(app, second)).toEqual([]);
    expect(await savedProviders(window)).toEqual([]);

    // The form's Use this key sends it to Kimi, on the region the form shows, and nowhere else.
    await pointAndClick(window, form.getByTestId("provider-use-key"));
    await expect.poll(() => savedProviders(window), { timeout: 20_000 }).toEqual(["kimi"]);
    expect(await sentWith(app, second)).toEqual(["kimi · intl"]);
    expect(await sentWith(app, SHARED_KEY)).toEqual([]);
  } finally {
    await app.close();
  }
});
