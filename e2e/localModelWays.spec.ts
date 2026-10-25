import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  newMind,
  ollamaAppOpened,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  urlsOpened,
  useLocalChatModel,
} from "./app";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const LANGUAGES = ["en", "zh-CN"] as const;
const WIDTHS = [900, 1600] as const;

const WORDS = {
  en: {
    notRunning: "Ollama isn’t running on this computer",
    open: "Open Ollama",
    opening: "Opening Ollama…",
    get: "Get Ollama ↗",
    tryAgain: "Try again",
    notDetected: "Install and start Ollama from ollama.com to run models here.",
    installed: "Ollama is on this computer, but it isn’t running.",
    detected: "Ollama is running. Questions and Documents stay on this computer.",
    recommended: (model: string) => `Recommended: ${model}, 3.3 GB. It is downloaded once.`,
    use: (model: string) => `Use local models (${model}, 3.3 GB)`,
  },
  "zh-CN": {
    notRunning: "Ollama 没有在这台电脑上运行",
    open: "打开 Ollama",
    opening: "正在打开 Ollama…",
    get: "下载 Ollama ↗",
    tryAgain: "重试",
    notDetected: "要在本机运行模型，请从 ollama.com 安装并启动 Ollama。",
    installed: "这台电脑上有 Ollama，但它没有运行。",
    detected: "Ollama 正在运行。问题和文档不会离开这台电脑。",
    recommended: (model: string) => `推荐使用 ${model}（3.3 GB），只需下载一次。`,
    use: (model: string) => `使用本地模型（${model}，3.3 GB）`,
  },
} as const;

let dataDir: string;
const servers: Server[] = [];
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/**
 * A stand-in for Ollama that holds its port from the start, so nothing else can take it, and drops
 * every connection until `run` says it runs: not running is then a port that refuses, as
 * Ollama's is, with no gap in which an app launched on a free port finds something else answering.
 */
async function ollamaStandIn(): Promise<{ url: string; run(models?: string[]): void }> {
  let models: string[] | null = null;
  const server = createServer((request, response) => {
    if (request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ models: (models ?? []).map((name) => ({ name, model: name })) }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  server.on("connection", (socket) => {
    if (models === null) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    run: (listed = []) => {
      models = listed;
    },
  };
}

const bridge = (window: Page) => ({
  recommendedModel: () =>
    window.evaluate(async () => {
      const status = await (
        globalThis as unknown as { incarnamind: CoreBridge }
      ).incarnamind.detectOllama();
      return status.recommendedModel;
    }),
  cloudModelInLocalMode: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.saveChatProvider({
        kind: "openai-compatible",
        baseUrl: "https://llm.example.com/v1",
        modelId: "example-model",
      });
      await core.setLocalOnly(true);
    }),
  localOnly: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await core.getEmbeddingSettings()).localOnly;
    }),
});

async function expectInside(inner: Locator, outer: Locator, width: number): Promise<void> {
  const outerBox = await outer.boundingBox();
  expect(outerBox).not.toBeNull();
  if (!outerBox) return;
  expect(outerBox.x).toBeGreaterThanOrEqual(0);
  expect(outerBox.x + outerBox.width).toBeLessThanOrEqual(width);
  for (const box of await Promise.all((await inner.all()).map((each) => each.boundingBox()))) {
    expect(box).not.toBeNull();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(outerBox.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(outerBox.x + outerBox.width + 1);
  }
}

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

for (const language of LANGUAGES) {
  const words = WORDS[language];

  test(`Use a local model opens the Ollama choice in place, with Get Ollama and the recommended model, and one click uses it (${language})`, async () => {
    const ollama = await ollamaStandIn();
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: ollama.url,
      ollamaApp: "missing",
    });
    await interceptOpenExternal(app);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await bridge(window).cloudModelInLocalMode();
    await newMind(window);
    await window.getByTestId("mind-editor").click();
    const recommended = await bridge(window).recommendedModel();

    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What is IncarnaMind?");
    await window.keyboard.press("Enter");
    const refusal = window.getByTestId("composer").getByTestId("composer-not-ready");
    await expect(refusal).toBeVisible();
    const dialog = window.getByTestId("local-model-dialog");

    for (const width of WIDTHS) {
      await setWindowSize(app, window, width, 700);
      await pointAndClick(window, refusal.getByTestId("local-mode-use-local"));
      await expect(dialog).toBeVisible();
      await expect(window.getByTestId("settings")).toBeHidden();
      await expect(dialog.getByTestId("local-model-status")).toHaveText(words.notDetected);
      await expect(dialog.getByTestId("local-model-recommended")).toHaveText(
        words.recommended(recommended),
      );
      await expect(dialog.getByTestId("ollama-get")).toHaveText(words.get);
      await expect(dialog.getByTestId("ollama-check-again")).toBeVisible();
      await expectInside(dialog.getByRole("button"), dialog, width);
      await screenshot(window, `local-model-get-ollama-${language}-${width}`);
      await window.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }

    await pointAndClick(window, refusal.getByTestId("local-mode-use-local"));
    await pointAndClick(window, dialog.getByTestId("ollama-get"));
    await expect.poll(() => urlsOpened(app)).toEqual(["https://ollama.com/download"]);
    await expect(dialog).toBeVisible();
    expect(await ollamaAppOpened(app)).toBe(0);

    ollama.run([recommended]);
    await pointAndClick(window, dialog.getByTestId("ollama-check-again"));
    await expect(dialog.getByTestId("local-model-status")).toHaveText(words.detected);
    const use = dialog.getByTestId("ollama-use");
    await expect(use).toHaveText(words.use(recommended));
    await screenshot(dialog, `local-model-use-${language}`);
    await pointAndClick(window, use);

    await expect(dialog).toBeHidden();
    await expect(refusal).toBeHidden();
    await expect(window.getByTestId("chat-readiness")).toBeHidden();
    expect(await bridge(window).localOnly()).toBe(true);
    await expect(window.getByTestId("composer-input")).toHaveValue("What is IncarnaMind?");
    await window.getByTestId("composer-input").click();
    await window.keyboard.press("Enter");
    await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });
    await app.close();
  });

  test(`Ollama installed but not running: the Answer says so with Open Ollama, and is asked again once it runs (${language})`, async () => {
    const ollama = await ollamaStandIn();
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: ollama.url,
      ollamaApp: "installed",
    });
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await useLocalChatModel(window);
    await newMind(window);
    await window.getByTestId("mind-editor").click();

    const answer = await ask(window, "What is in my Documents?");
    await expect(answer).toHaveAttribute("data-status", "failed");
    const line = answer.getByTestId("answer-error");
    await expect(line).toHaveAttribute("data-error-kind", "ollama-not-running");
    const action = line.getByTestId("answer-error-action");
    for (const width of WIDTHS) {
      await setWindowSize(app, window, width, 700);
      await expect(line).toHaveText(`${words.notRunning} · ${words.open}`);
      await expect(action).toHaveText(words.open);
      await expectInside(action, line, width);
      await screenshot(answer, `ollama-not-running-open-${language}-${width}`);
    }

    await pointAndClick(window, action);
    await expect.poll(() => ollamaAppOpened(app)).toBe(1);
    await expect(line).toHaveText(words.opening);
    await expect(line.getByTestId("answer-error-action")).toHaveCount(0);

    ollama.run();
    const answered = assistantAnswers(window).last();
    await expect(answered).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    await expect(answered.getByTestId("assistant-answer-text")).not.toBeEmpty();
    await expect(answered.getByTestId("answer-error")).toHaveCount(0);
    await app.close();
  });

  test(`Ollama not installed: the Answer says so with Get Ollama, which opens ollama.com; back with it running, Try again asks the Question again (${language})`, async () => {
    const ollama = await ollamaStandIn();
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: ollama.url,
      ollamaApp: "missing",
    });
    await interceptOpenExternal(app);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await useLocalChatModel(window);
    await newMind(window);
    await window.getByTestId("mind-editor").click();

    const answer = await ask(window, "What is in my Documents?");
    await expect(answer).toHaveAttribute("data-status", "failed");
    const line = answer.getByTestId("answer-error");
    await expect(line).toHaveAttribute("data-error-kind", "ollama-not-running");
    const action = line.getByTestId("answer-error-action");
    for (const width of WIDTHS) {
      await setWindowSize(app, window, width, 700);
      await expect(line).toHaveText(`${words.notRunning} · ${words.get}`);
      await expect(action).toHaveText(words.get);
      await expectInside(action, line, width);
      await screenshot(answer, `ollama-not-running-get-${language}-${width}`);
    }

    await pointAndClick(window, action);
    await expect.poll(() => urlsOpened(app)).toEqual(["https://ollama.com/download"]);
    expect(await ollamaAppOpened(app)).toBe(0);
    await expect(line).toBeVisible();

    ollama.run();
    await window.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await expect(line).toHaveText(`${words.notRunning} · ${words.tryAgain}`);
    await pointAndClick(window, line.getByTestId("answer-error-action"));
    const answered = assistantAnswers(window).last();
    await expect(answered).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    await expect(answered.getByTestId("assistant-answer-text")).not.toBeEmpty();
    await expect(answered.getByTestId("answer-error")).toHaveCount(0);
    expect(await ollamaAppOpened(app)).toBe(0);
    await app.close();
  });
}
