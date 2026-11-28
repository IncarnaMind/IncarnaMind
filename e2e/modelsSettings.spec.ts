import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  expectEstimateTip,
  launchApp,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Settings › AI (#179, #2835): what each job uses, the User's accounts and keys as rows, and a
 * provider's page with Test and its models. A provider is no longer added in IncarnaMind (#3767),
 * so a profile's providers are saved by the bridge. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
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

test("a second provider kept from before has its own page: it tests, its models go in and out of the menu, its model is picked for Answers, and removed it leaves no default", async () => {
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
    const settings = await openSettings(window, "ai");
    const rows = settings.getByTestId("provider-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(first.host);
    await expect(rows.first().getByTestId("provider-row-status")).toContainText(
      "On this computer · Used for Answers",
    );
    const answers = settings.getByTestId("model-default-chatModel");
    await expect(answers).toHaveValue(`${existing.id}\nfirst-model`);
    const quick = settings.getByTestId("model-default-quickTasksModel");
    await expect(quick).toHaveValue("");
    await expect(quick.locator("option:checked")).toHaveText("Follows Answers · first-model");
    await expect(settings.getByTestId("model-default-row-transcription")).toBeVisible();
    await expect(settings.getByTestId("model-default-row-sorting")).toBeVisible();
    await screenshot(window, "models-1100-en");

    // A provider is no longer added in IncarnaMind (#3767): a second one kept from before is a
    // row of its own, and the default stays.
    const added = await window.evaluate(async (baseUrl) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (
        await core.saveChatProvider({
          kind: "openai-compatible",
          baseUrl,
          modelId: "b-fast",
          keepDefault: true,
        })
      ).id;
    }, second.url);
    await expect(rows).toHaveCount(2);
    await settings.locator(`[data-provider-id="${added}"]`).click();
    const page = settings.getByTestId("provider-page");
    await expect(page.getByTestId("provider-page-title")).toHaveText(second.host);
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

    // Back on Settings › AI, its model becomes the Answers default.
    await page.getByTestId("models-back").click();
    await expect(settings.getByTestId("provider-row")).toHaveCount(2);
    await answers.selectOption(`${added}\nb-strong`);
    await expect.poll(() => chatModel(window)).toEqual({ providerId: added, modelId: "b-strong" });
    // Quick tasks follow it, in their own row.
    await expect(quick.locator("option:checked")).toHaveText(/^Follows Answers · b-/);

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

test("a key provider's page: where its data goes, its key with Test, and each model's estimate per 100 Answers in yuan beside Pricing ↗, in English and Chinese", async () => {
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
      const settings = await openSettings(window, "ai");
      await settings.getByTestId("provider-row").first().click();
      const page = settings.getByTestId("provider-page");
      await expect(page).toHaveAttribute("data-provider-id", provider.id);
      for (const language of ["en", "zh-CN"] as const) {
        await setLanguage(window, language);
        const zh = language === "zh-CN";
        await expect(page.getByTestId("provider-sends")).toContainText(
          zh
            ? "你提问、修改或核对的内容，连同所需的笔记和文档内容，会发送给 DeepSeek。"
            : "What you ask, edit or check, with the notes and the parts of your Documents it needs, goes to DeepSeek.",
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
        await expect(cost).toHaveText(zh ? /^约 ¥\d+\.\d+$/ : /^About ¥\d+\.\d+$/);
        await expect(page.getByTestId("provider-cost-head")).toHaveText(
          zh ? "每 100 个回答的费用 · 价格 ↗" : "Cost per 100 Answers · Pricing ↗",
        );
        // Where the estimate comes from shows in the app's tip on the keyboard's focus too (#1257).
        await expectEstimateTip(
          window,
          cost,
          zh
            ? /^按 DeepSeek 深度求索的价格估算，核对于 \d{4}年\d{1,2}月\d{1,2}日$/
            : /^Estimate from DeepSeek’s price, checked \d{1,2}\s\w+\s\d{4}$/,
        );
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
