import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * A selection too long for the model is edited in parts (#2348): split at Block boundaries, one
 * request after another with the same instruction, each streaming in place, and all of them one
 * step of Undo. A Block that alone is too long says so, naming the model to change. The scripted
 * model answers, and Ollama says its window is 6,144 tokens: one part of it is about 2,000
 * characters of English or 500 of Chinese, so a few paragraphs are a few parts.
 *
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const LINE = "Sailors kept their own tables of the tides and the times of high water. ";
const EN = (index: number) => `Tide table ${index}: the water is very high. ${LINE.repeat(26)}`;
const ZH_LINE = "水手们各自记录潮汐的时刻和涨落，港口每年公布高水位的时间。";
const ZH = (index: number) => `潮汐表${index}：今天的水位非常的高。${ZH_LINE.repeat(18)}`;

/** Ollama, telling the app that its model's window holds 6,144 tokens. */
async function smallWindow(): Promise<{ url: string; close(): void }> {
  const server: Server = createServer((request, response) => {
    request.resume();
    if (request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          models: [
            {
              name: "fake-model",
              model: "fake-model",
              size: 1_000_000_000,
              digest: "fake-model",
              details: { parameter_size: "9B", context_length: 6_144 },
            },
          ],
        }),
      );
      return;
    }
    if (request.url === "/api/show") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ capabilities: ["completion"], model_info: {} }));
      return;
    }
    if (request.url === "/api/ps") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

let dataDir: string;
let ollama: { url: string; close(): void };
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  ollama = await smallWindow();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  ollama.close();
});

/** The app with the scripted model, answered over an Ollama whose window is small. */
async function start(language: "en" | "zh-CN") {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1_280, 820);
  await dismissChatSetup(window);
  await window.evaluate(
    async ({ url, chosen }) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosen } });
      await bridge.saveChatProvider({ kind: "ollama", baseUrl: url, modelId: "fake-model" });
    },
    { url: ollama.url, chosen: language },
  );
  return { app, window };
}

/** A Mind of `lines`, each a paragraph, set as they are: typing thousands of characters is slow. */
async function writeParagraphs(window: Page, lines: readonly string[]): Promise<void> {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await editor.evaluate((dom, paragraphs) => {
    const { editor: tiptap } = dom as unknown as { editor: Editor };
    tiptap.commands.setContent(
      paragraphs.map((words) => ({ type: "paragraph", content: [{ type: "text", text: words }] })),
    );
  }, lines);
  await expect(editor.locator(":scope > p")).toHaveText([...lines]);
}

/** All of the Mind selected, and what to change typed in the composer, which says so too. */
async function askOnAll(window: Page, instruction: string): Promise<void> {
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.press("ControlOrMeta+j");
  const composer = window.getByTestId("composer-input");
  await expect(composer).toBeFocused();
  await window.keyboard.type(instruction);
  await window.keyboard.press("Enter");
}

test("a selection three times the model's limit is edited in parts, streamed Block by Block, and one Undo takes it all back", async () => {
  const { app, window } = await start("en");
  await writeParagraphs(window, [EN(0), EN(1), EN(2)]);
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator(":scope > p");
  const line = editor.getByTestId("applied-line");

  await askOnAll(window, "Shorten this");

  // Part by part, said where the edit reports and where it writes: the first Block changes
  // while the last is still as it was. The first Block is done once the second is being written.
  await expect(window.getByTestId("edit-pending")).toContainText("Writing part 1 of 3…");
  await expect(editor.getByTestId("mind-writing")).toContainText(/Writing part \d of 3…/, {
    timeout: 20_000,
  });
  await expect(window.getByTestId("edit-pending")).toContainText("Writing part 2 of 3…", {
    timeout: 30_000,
  });
  await expect(paragraphs.first()).toHaveText(EN(0).replaceAll(" very", ""), {
    useInnerText: true,
  });
  await expect(paragraphs.last()).toHaveText(EN(2), { useInnerText: true });
  await screenshot(window, "parts-running-en");

  // The bar says how many parts the edit was, and every Block changed at once.
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 3 paragraphs", {
    timeout: 30_000,
  });
  await expect(line.getByTestId("applied-parts")).toHaveText("3 parts");
  await expect(window.getByTestId("proposal-spoken")).toHaveText("Changed 3 paragraphs");
  await screenshot(window, "parts-applied-en");

  // One Undo takes all three parts back.
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(line).toHaveCount(0);
  await expect(paragraphs).toHaveText([EN(0), EN(1), EN(2)]);
  await app.close();
});

test("in Chinese, a selection three times the model's limit is edited in parts too, and one Undo takes it all back", async () => {
  const { app, window } = await start("zh-CN");
  await writeParagraphs(window, [ZH(0), ZH(1), ZH(2)]);
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator(":scope > p");
  const line = editor.getByTestId("applied-line");

  await askOnAll(window, "缩短一下");

  await expect(line.getByTestId("applied-count")).toHaveText("修改了 3 个段落", {
    timeout: 30_000,
  });
  await expect(line.getByTestId("applied-parts")).toHaveText("3 部分");
  await screenshot(window, "parts-applied-zh");

  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(line).toHaveCount(0);
  await expect(paragraphs).toHaveText([ZH(0), ZH(1), ZH(2)]);
  await app.close();
});

const TOO_LONG = [
  {
    language: "en",
    block: `${EN(0)}${LINE.repeat(26)}`,
    instruction: "Shorten this",
    said: ["This paragraph is too long for fake-model", "Choose another model"],
  },
  {
    language: "zh-CN",
    block: `${ZH(0)}${ZH_LINE.repeat(18)}`,
    instruction: "缩短一下",
    said: ["这一段对 fake-model 来说太长了", "换一个模型"],
  },
] as const;

for (const { language, block, instruction, said } of TOO_LONG) {
  test(`in ${language}, one Block too long for the model says so, naming the model, with the way to change it`, async () => {
    const { app, window } = await start(language);
    await writeParagraphs(window, [block]);
    const editor = window.getByTestId("mind-editor");
    const paragraph = editor.locator(":scope > p").first();

    await askOnAll(window, instruction);

    const problem = window.getByTestId("edit-problem");
    await expect(problem).toContainText(said[0]);
    await expect(problem.getByRole("button", { name: said[1] })).toBeVisible();
    // Nothing changed, and nothing came to review.
    await expect(editor.getByTestId("applied-line")).toHaveCount(0);
    await expect(paragraph).toHaveText(block);
    await screenshot(window, `block-too-long-${language}`);
    await app.close();
  });
}

/** A Block over the app's own 12,000-character limit: no model changes that, so none is offered. */
const CAP = [
  {
    language: "en",
    block: `${EN(0)}${LINE.repeat(150)}`,
    instruction: "Shorten this",
    said: "This paragraph is longer than one edit can take. Split it into shorter paragraphs.",
    choose: "Choose another model",
  },
  {
    language: "zh-CN",
    block: `${ZH(0)}${ZH_LINE.repeat(420)}`,
    instruction: "缩短一下",
    said: "这一段超出了一次编辑能处理的长度，请把它拆成更短的段落。",
    choose: "换一个模型",
  },
] as const;

for (const { language, block, instruction, said, choose } of CAP) {
  test(`in ${language}, one Block over the app's own limit says to split the paragraph, and offers no model`, async () => {
    const { app, window } = await start(language);
    await writeParagraphs(window, [block]);
    const editor = window.getByTestId("mind-editor");

    await askOnAll(window, instruction);

    const problem = window.getByTestId("edit-problem");
    await expect(problem).toContainText(said);
    // No model can take it: changing the model would show the same line again.
    await expect(problem.getByRole("button", { name: choose })).toHaveCount(0);
    await expect(editor.getByTestId("applied-line")).toHaveCount(0);
    await screenshot(window, `block-cap-${language}`);
    await app.close();
  });
}

test("on a cloud model with a monthly cap, the estimate of the parts shows before the applied line", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1_280, 820);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    await bridge.allowDataFlow("edits", "https://api.anthropic.com");
    await bridge.updateSettings({ user: { monthlyCap: { amount: 20, currency: "USD" } } });
  });
  // Three Blocks of about 6,150 characters: two of them take more than one request's 12,000,
  // so the edit is in three parts. Chinese streams fast, which leaves the estimate in view.
  const big = (index: number) => `潮汐表${index}：今天的水位非常的高。${ZH_LINE.repeat(220)}`;
  await writeParagraphs(window, [big(0), big(1), big(2)]);

  await askOnAll(window, "Shorten this");

  // Three parts, each measured at 6,900 tokens in and 3,000 out: 29,700 tokens, shown first —
  // read in one go, so the estimate showing while the line already applied would be seen.
  const pending = window.getByTestId("edit-pending");
  const line = window.getByTestId("mind-editor").getByTestId("applied-line");
  await expect
    .poll(
      async () =>
        (await pending.count()) > 0 && (await pending.innerText()).includes("29.7K tokens")
          ? await line.count()
          : -1,
      { timeout: 30_000 },
    )
    .toBe(0);
  await expect(pending).toContainText("of $20.00 used this month");
  await expect(line.getByTestId("applied-parts")).toHaveText("3 parts", { timeout: 30_000 });
  await screenshot(window, "parts-estimate-en");
  await app.close();
});
