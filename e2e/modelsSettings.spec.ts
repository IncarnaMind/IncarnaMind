import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Settings › Models (#179): three defaults, the User's providers as rows, Add a provider's
 * directory in the language's groups, and a provider's page with Test and its models. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: `${SCREENSHOTS}/${name}.png` });
}

/** An OpenAI-compatible server on this computer that lists `models`; the scripted model answers. */
async function modelServer(
  models: string[],
): Promise<{ url: string; host: string; server: Server }> {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: `http://${host}/v1`, host, server };
}

const chatModel = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.getSettings()).user.chatModel;
  });

const groupsShown = (directory: Locator) =>
  directory
    .getByTestId("provider-directory-group")
    .evaluateAll((all) => all.map((each) => each.getAttribute("data-group")));

let dataDir: string;
const servers: Server[] = [];
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

test("adds a provider from the directory with a fake endpoint, tests it, and picks its model for Answers; the provider already there is a row", async () => {
  const first = await modelServer(["first-model"]);
  const second = await modelServer(["b-fast", "b-strong"]);
  servers.push(first.server, second.server);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 900);
    const existing = await window.evaluate(async (baseUrl) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return core.saveChatProvider({ kind: "openai-compatible", baseUrl, modelId: "first-model" });
    }, first.url);

    // The provider already there is a row, and its model is the Answers default.
    const settings = await openSettings(window, "models");
    const rows = settings.getByTestId("provider-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(first.host);
    await expect(rows.first().getByTestId("provider-row-status")).toHaveText(
      "On this computer · 1 model in the menu",
    );
    const answers = settings.getByTestId("model-default-chatModel");
    await expect(answers).toHaveValue(`${existing.id}\nfirst-model`);
    await expect(settings.getByTestId("models-follow-answers")).toHaveText(
      "Quick tasks and reading images are automatic.",
    );
    await expect(settings.getByTestId("model-default-row-transcription")).toBeVisible();
    await expect(settings.getByTestId("model-default-row-sorting")).toBeVisible();
    await screenshot(window, "models-1100-en");

    // Add a provider…: the directory, its search focused, in English's groups.
    await settings.getByTestId("models-add-provider").click();
    const directory = settings.getByTestId("provider-directory");
    await expect(directory.getByTestId("provider-directory-search")).toBeFocused();
    await expect
      .poll(() => groupsShown(directory))
      .toEqual(["popular", "international", "china", "local", "other"]);
    await expect(
      directory.locator('[data-group="popular"] [data-testid="provider-directory-entry"]'),
    ).toHaveText([/^Anthropic/, /^OpenAI/, /^Google/, /^Ollama/, /^OpenRouter/]);
    await window.keyboard.type("compatible");
    const entries = directory.getByTestId("provider-directory-entry");
    await expect(entries).toHaveCount(1);
    await entries.click();

    // Its page adds it: the address and a model to try, and the default stays.
    const add = settings.getByTestId("provider-add");
    const form = add.getByTestId("provider-form");
    await form.locator('input[type="url"]').fill(second.url);
    await form.getByTestId("provider-model-text").fill("b-fast");
    await form.getByTestId("provider-use-key").click();
    const page = settings.getByTestId("provider-page");
    await expect(page.getByTestId("provider-page-title")).toHaveText(second.host);
    const added = (await page.getAttribute("data-provider-id")) ?? "";
    expect(await chatModel(window)).toEqual({ providerId: existing.id, modelId: "first-model" });

    // Test: its list, then one word from its first model.
    await page.getByTestId("provider-test").click();
    await expect(page.getByTestId("provider-test-result")).toHaveText(
      /^Works: b-fast answered in \d+\.\d s$/,
    );
    const models = page.getByTestId("provider-model-row");
    await expect(models).toHaveCount(2);
    await expect(models.first().getByTestId("provider-model-cost")).toHaveText(
      "Free, on this computer",
    );

    // In the menu: taken out and put back, in its place.
    const strong = models.filter({ hasText: "b-strong" }).getByTestId("provider-model-in-menu");
    await strong.uncheck();
    await expect(strong).not.toBeChecked();
    await expect
      .poll(() =>
        window.evaluate(async (id) => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          return (await core.listChatModels()).find((each) => each.provider.id === id)?.models;
        }, added),
      )
      .toEqual(["b-fast"]);
    await strong.check();
    await expect(strong).toBeChecked();
    await screenshot(window, "provider-1100-en");

    // Back on Models, its model becomes the Answers default.
    await page.getByTestId("models-back").click();
    await expect(settings.getByTestId("provider-row")).toHaveCount(2);
    await expect(settings.getByTestId("models-add-provider")).toBeFocused();
    await answers.selectOption(`${added}\nb-strong`);
    await expect.poll(() => chatModel(window)).toEqual({ providerId: added, modelId: "b-strong" });
    // Quick tasks and reading images have no row of their own: they follow Answers.
    await expect(settings.getByTestId("model-default-quickTasksModel")).toHaveCount(0);

    // Removed, it leaves no default pointing at it, and one line says where Answers went.
    await settings.getByTestId("provider-row").filter({ hasText: second.host }).click();
    await settings.getByTestId("provider-remove").click();
    await expect(settings.getByTestId("models-removed")).toHaveText(
      `Removed ${second.host}. Answers now use first-model · ${first.host}.`,
    );
    await expect(answers).toHaveValue(`${existing.id}\nfirst-model`);
    await expect(settings.getByTestId("provider-row")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("by keyboard alone, in Chinese: ⌘K opens Add a provider, its groups follow the language, and a provider's page opens and goes back", async () => {
  const { app, window } = await launchApp(dataDir, { ollama: "http://127.0.0.1:9" });
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 900, 760);
    await setLanguage(window, "zh-CN");
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type("> 添加 AI 模型服务");
    await expect(window.getByTestId("palette").getByTestId("palette-item").first()).toHaveText(
      /添加 AI 模型服务…/,
    );
    await window.keyboard.press("Enter");

    const settings = window.getByTestId("settings");
    const directory = settings.getByTestId("provider-directory");
    await expect(directory.getByTestId("provider-directory-search")).toBeFocused();
    // China's providers are all popular in Chinese, so its own group is left out.
    await expect
      .poll(() => groupsShown(directory))
      .toEqual(["popular", "international", "local", "other"]);
    await expect(directory.locator("h5")).toHaveText(["常用", "国际", "本机", "其他"]);
    await expect(
      directory.locator('[data-group="popular"] [data-testid="provider-directory-entry"]'),
    ).toHaveText([/^DeepSeek/, /^通义千问/, /^Kimi/, /^智谱/, /^硅基流动/, /^Ollama/]);
    await screenshot(window, "directory-900-zh");

    // Typing narrows it; Tab reaches the tile and Enter opens the page that adds it.
    await window.keyboard.type("kimi");
    await expect(directory.getByTestId("provider-directory-entry")).toHaveCount(2);
    await window.keyboard.press("Tab");
    await expect(directory.getByTestId("provider-directory-entry").first()).toBeFocused();
    await window.keyboard.press("Enter");
    const add = settings.getByTestId("provider-add");
    await expect(add.getByTestId("provider-page-title")).toHaveText("Kimi（月之暗面）");
    await expect(add.getByTestId("models-back")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(settings.getByTestId("your-providers")).toContainText("还没有添加服务。");
    await expect(settings.getByTestId("model-default-chatModel")).toBeDisabled();
  } finally {
    await app.close();
  }
});

test("a key provider's page: where its data goes, its key with Test, and each model's estimate per Answer in yuan beside Pricing ↗, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    // DeepSeek's list, answered in the main process: no network.
    await app.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url === "https://api.deepseek.com/models"
          ? Promise.resolve(
              Response.json({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }),
            )
          : original(input, init);
      };
    });
    const provider = await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return core.saveChatProvider({
        kind: "deepseek",
        apiKey: "sk-not-real",
        modelId: "deepseek-flash",
      });
    });
    for (const [width, height] of [
      [900, 760],
      [1440, 900],
    ] as const) {
      await setWindowSize(app, window, width, height);
      const settings = await openSettings(window, "models");
      await settings.getByTestId("provider-row").first().click();
      const page = settings.getByTestId("provider-page");
      await expect(page).toHaveAttribute("data-provider-id", provider.id);
      for (const language of ["en", "zh-CN"] as const) {
        await setLanguage(window, language);
        const zh = language === "zh-CN";
        await expect(page.getByTestId("provider-sends")).toContainText(
          zh
            ? "会把你的问题和文档内容发送给 DeepSeek。"
            : "Sends your questions and document text to DeepSeek.",
        );
        await expect(page.getByTestId("provider-page-key")).toHaveAttribute(
          "placeholder",
          zh ? "已保存密钥" : "Key saved",
        );
        await expect(page.getByTestId("provider-page-get-key")).toHaveText(
          zh ? "获取密钥 ↗" : "Get a key ↗",
        );
        const flash = page.getByTestId("provider-model-row").first();
        await expect(flash).toHaveAttribute("data-model", "deepseek-flash");
        const cost = flash.getByTestId("provider-model-cost");
        await expect(cost).toHaveText(zh ? /^每个回答约 ¥0\.\d+$/ : /^About ¥0\.\d+ per Answer$/);
        await expect(cost).toHaveAttribute(
          "title",
          zh
            ? /^按 DeepSeek 深度求索的价格估算，核对于 \d{4}年\d{1,2}月\d{1,2}日$/
            : /^Estimate from DeepSeek’s price, checked \d{1,2} \w+ \d{4}$/,
        );
        await expect(page.getByTestId("provider-cost-head")).toHaveText(
          zh ? "每个回答的费用 · 价格 ↗" : "Cost per Answer · Pricing ↗",
        );
        // Where the estimate comes from is reached by the keyboard too.
        await cost.focus();
        await expect(cost).toBeFocused();
        await expect(cost).toHaveAccessibleDescription(/DeepSeek/);
        // The Answers model stays in the menu.
        await expect(flash.getByTestId("provider-model-in-menu")).toBeDisabled();
        // Nothing runs past the page's edge.
        const box = await page.boundingBox();
        const dialog = await settings.boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
          (dialog?.x ?? 0) + (dialog?.width ?? 0),
        );
        await page.getByTestId("provider-test").click();
        await expect(page.getByTestId("provider-test-result")).toHaveText(
          zh ? /^可以使用：.+ 用时 \d+\.\d 秒回答$/ : /^Works: .+ answered in \d+\.\d s$/,
        );
        await screenshot(window, `provider-${width}-${zh ? "zh" : "en"}`);
        await page.getByTestId("models-back").click();
        await screenshot(window, `models-${width}-${zh ? "zh" : "en"}`);
        await settings.getByTestId("provider-row").first().click();
      }
      await setLanguage(window, "en");
      await settings.getByRole("button", { name: "Close Settings" }).click();
      await expect(settings).toBeHidden();
    }
  } finally {
    await app.close();
  }
});
