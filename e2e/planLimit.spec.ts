import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { ANSWER, createFakeOpenAI, type FakeOpenAIServer } from "../tests/helpers/fakeOpenAI";
import {
  addDocuments,
  assistantAnswers,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  makeTagOnDocument,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  signInWithChatGpt,
} from "./app";

/*
 * On a ChatGPT plan, a model whose usage limit is used up (#551): the Problem
 * line under the Answer names it and when it resets, and offers the plan's
 * next model with limit left; one click asks the same Question again in place
 * with it, and the model chip says which model answers, until when. The
 * limits last the session: reopened, the app says "for now". Tagging or
 * Organize that meets the plan's limit waits: one line in the sidebar says
 * until when, with Use an API key instead, and the work goes on by itself at
 * the reset. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots,
 * narrow and wide, in English and Chinese.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const NARROW = { width: 900, height: 720 };
const WIDE = { width: 1600, height: 720 };
const PLAN_LINE_WIDE = 1440;

const SOL = "gpt-6.1-sol";
const LUNA = "gpt-6-luna";
const ASTRA = "gpt-6-astra";

let dataDir: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

/** The plan refuses `model` for its usage limit, which resets in `hours`. Returns when (epoch ms). */
function usedUp(openai: FakeOpenAIServer, model: string, hours: number): number {
  const resetsAt = Math.round(Date.now() / 1000 + hours * 3600);
  openai.replyFor[model] = {
    kind: "error",
    status: 429,
    body: {
      error: {
        code: "subscription_sharing_usage_limit_exceeded",
        message: "Limit reached.",
        resets_at: resetsAt,
      },
    },
  };
  return resetsAt * 1000;
}

/** The minutes of a time, as the interface writes them on either clock: "14:05", "2:05 pm". */
const minutesOf = (at: number) => String(new Date(at).getMinutes()).padStart(2, "0");

async function expectChipWhole(window: Page) {
  const assistant = window.getByTestId("assistant");
  const fits = (element: HTMLElement | SVGElement) => element.scrollWidth <= element.clientWidth;
  expect(await assistant.getByTestId("composer-model").locator("span").evaluate(fits)).toBe(true);
  const scope = assistant.getByTestId("composer-scope-all");
  expect(await scope.evaluate(fits)).toBe(true);
  const scopeBox = await scope.boundingBox();
  const askBox = await assistant.getByTestId("composer-ask").boundingBox();
  if (!scopeBox || !askBox) throw new Error("The composer's controls aren't visible.");
  expect(scopeBox.x + scopeBox.width).toBeLessThanOrEqual(askBox.x);
}

async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** Shots of the assistant now, narrow and wide, ending wide. */
async function shots(app: Parameters<typeof setWindowSize>[0], window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await setWindowSize(app, window, NARROW.width, NARROW.height);
  await shot(window, `${name}-narrow`);
  await setWindowSize(app, window, WIDE.width, WIDE.height);
  await shot(window, `${name}-wide`);
}

async function planLineShots(app: Parameters<typeof setWindowSize>[0], window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await setWindowSize(app, window, NARROW.width, NARROW.height);
  await shot(window, `${name}-narrow`);
  await setWindowSize(app, window, PLAN_LINE_WIDE, NARROW.height);
  await shot(window, `${name}-wide`);
  await setWindowSize(app, window, NARROW.width, NARROW.height);
}

async function askAndFail(window: Page, question: string): Promise<Locator> {
  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(before + 1);
  await expect(answers.last()).toHaveAttribute("data-status", "failed");
  return answers.last();
}

async function resetTime(line: Locator, pattern: RegExp): Promise<string> {
  await expect(line).toHaveText(pattern);
  return pattern.exec((await line.textContent()) ?? "")?.[1] ?? "";
}

test("a used-up plan model offers the next one in one click, which answers in place and holds the chip until the reset, in English and Chinese; reopened, it says for now", async () => {
  test.setTimeout(120_000);
  const openai = await createFakeOpenAI();
  openai.modelList = [
    { slug: SOL, display_name: "GPT-6.1 Sol", visibility: "list" },
    { slug: LUNA, display_name: "GPT-6 Luna", visibility: "list" },
    { slug: ASTRA, display_name: "GPT-6 Astra", visibility: "list" },
  ];
  let { app, window } = await launchApp(dataDir, { chatGpt: openai.endpoints.issuer, home });
  try {
    await setWindowSize(app, window, WIDE.width, WIDE.height);
    await dismissChatSetup(window);
    await signInWithChatGpt(app, window, openai);
    const chip = window.getByTestId("assistant").getByTestId("composer-model");
    await expect(chip).toHaveText("GPT-6.1 Sol");

    usedUp(openai, SOL, 2);
    const answer = await askAndFail(window, "What did the committee decide?");
    const line = answer.getByTestId("answer-error");
    const time = await resetTime(
      line,
      /^GPT-6\.1 Sol’s limit on your plan is used up until (.+)\. · Answer with GPT-6 Luna$/,
    );
    await shots(app, window, "limit-en");
    await setLanguage(window, "zh-CN");
    // A reset on another day names the day, which each language writes its own way.
    const zhTime = await resetTime(
      line,
      /^你的套餐里 GPT-6\.1 Sol 的额度已用完，(.+) 恢复。· 改用 GPT-6 Luna 回答$/,
    );
    await shots(app, window, "limit-zh");
    await setLanguage(window, "en");
    await expect(chip).toHaveText("GPT-6.1 Sol");

    await pointAndClick(window, line.getByTestId("answer-error-action"));
    await expect(assistantAnswers(window)).toHaveCount(1);
    await expect(answer).toHaveAttribute("data-status", "done");
    await expect(answer).toContainText(ANSWER);
    expect(openai.responses().at(-1)?.body.model).toBe(LUNA);
    await expect(chip).toHaveText(`GPT-6 Luna · until ${time}`);
    await expect(chip).toHaveAttribute(
      "title",
      `GPT-6.1 Sol’s limit is used up until ${time}. Questions go to GPT-6 Luna until then.`,
    );
    await expectChipWhole(window);
    await shots(app, window, "answered-en");
    await setLanguage(window, "zh-CN");
    await expect(chip).toHaveText(`GPT-6 Luna · ${zhTime} 前`);
    await expectChipWhole(window);
    await shots(app, window, "answered-zh");

    usedUp(openai, LUNA, 1);
    const second = await askAndFail(window, "什么时候上线？");
    const secondLine = second.getByTestId("answer-error");
    const lunaTime = await resetTime(
      secondLine,
      /^你的套餐里 GPT-6 Luna 的额度已用完，(.+) 恢复。· 改用 GPT-6 Astra 回答$/,
    );
    const action = await pointAt(window, secondLine.getByTestId("answer-error-action"));
    await window.mouse.dblclick(action.x, action.y);
    await expect(second).toHaveAttribute("data-status", "done");
    await expect(second).toContainText(ANSWER);
    expect(openai.responses().filter((request) => request.body.model === ASTRA)).toHaveLength(1);
    // Astra stands in for Sol, the model the User chose, until Sol's reset.
    await expect(chip).toHaveText(`GPT-6 Astra · ${zhTime} 前`);

    // None left: Luna's limit resets first.
    usedUp(openai, ASTRA, 3);
    const third = await askAndFail(window, "谁负责？");
    await expect(third.getByTestId("answer-error")).toHaveText(
      `你的套餐额度已全部用完，${lunaTime} 恢复。`,
    );
    await expect(third.getByTestId("answer-error-action")).toHaveCount(0);
    await shots(app, window, "none-left-zh");

    // Quit and reopen: the limits are forgotten, so the stopped Answer says "for now" and offers
    // the plan's first model again, which answers.
    const conversation = (await window.getByTestId("assistant-title").textContent()) ?? "";
    await app.close();
    ({ app, window } = await launchApp(dataDir, { chatGpt: openai.endpoints.issuer, home }));
    await setWindowSize(app, window, WIDE.width, WIDE.height);
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type(conversation);
    await pointAndClick(
      window,
      window.getByTestId("palette-item").filter({ hasText: conversation }).first(),
    );
    const reopened = assistantAnswers(window).last();
    const reopenedLine = reopened.getByTestId("answer-error");
    await expect(reopenedLine).toHaveText(
      "你的套餐里 GPT-6 Astra 的额度暂时已用完。· 改用 GPT-6.1 Sol 回答",
    );
    openai.replyFor = {};
    await pointAndClick(window, reopenedLine.getByTestId("answer-error-action"));
    await expect(reopened).toHaveAttribute("data-status", "done");
    await expect(reopened).toContainText(ANSWER);
    expect(openai.responses().at(-1)?.body.model).toBe(SOL);
    await expect(window.getByTestId("assistant").getByTestId("composer-model")).toHaveText(
      "GPT-6.1 Sol",
    );
  } finally {
    await app.close();
    await openai.close();
  }
});

const listed = (window: Page, name: string) =>
  window.getByTestId("document-list-item").filter({ hasText: name });

async function invoices(sources: string, names: readonly string[]): Promise<string[]> {
  const paths = names.map((name) => join(sources, `${name}.txt`));
  for (const path of paths) await writeFile(path, "An invoice for the harbour works.\n");
  return paths;
}

test("tagging that meets the plan's limit waits: one line says until when, with Use an API key instead, and tagging goes on by itself at the reset, in English and Chinese", async () => {
  test.setTimeout(120_000);
  const openai = await createFakeOpenAI();
  openai.reply = { kind: "answer", text: JSON.stringify({ tags: [] }) };
  const sources = await createDataFolder();
  const { app, window } = await launchApp(dataDir, { chatGpt: openai.endpoints.issuer, home });
  try {
    await setWindowSize(app, window, NARROW.width, NARROW.height);
    await dismissChatSetup(window);
    await signInWithChatGpt(app, window, openai);
    await window.evaluate(async (model) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const plan = (await core.listChatProviders()).find((each) => each.kind === "chatgpt");
      if (!plan) throw new Error("The ChatGPT plan isn't set up.");
      await core.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: plan.id, modelId: model } },
        automatic: true,
      });
    }, LUNA);

    // The plan's limit resets a little later: long enough to read the line.
    const resets = usedUp(openai, LUNA, 20 / 3600);
    await addDocuments(window, await invoices(sources, ["Invoice 71", "Invoice 72"]));
    // A Tag of the User's own: only then does the footer name Tags (#1942).
    await makeTagOnDocument(window, "Invoice 71");
    await expect(listed(window, "Invoice 71")).toHaveAttribute(
      "data-tagging",
      "waiting-for-provider",
    );
    await expect(listed(window, "Invoice 72")).toHaveAttribute(
      "data-tagging",
      "waiting-for-provider",
    );
    const footer = window.getByTestId("sidebar-status");
    const paused = footer.getByTestId("tagging-paused");
    await expect(paused.getByTestId("status-label")).toHaveText(
      new RegExp(`^Your ChatGPT plan’s limit is reached until .*:${minutesOf(resets)}`),
    );
    await expect(paused).toHaveAttribute(
      "title",
      /\. Tagging and Organize wait for it to reset, then go on by themselves\.$/,
    );
    await expect(footer.getByTestId("status-more")).toHaveCount(0);
    const useKey = paused.getByTestId("tagging-paused-use-key");
    await expect(useKey).toHaveText("Use an API key instead");
    // At the narrowest window it wraps inside the sidebar, its action whole.
    const row = await footer.boundingBox();
    const action = await useKey.boundingBox();
    if (!row || !action) throw new Error("The plan's line isn't visible.");
    expect(action.x + action.width).toBeLessThanOrEqual(row.x + row.width);
    await planLineShots(app, window, "tagging-limit-en");

    await setLanguage(window, "zh-CN");
    await expect(paused.getByTestId("status-label")).toHaveText(
      new RegExp(`^ChatGPT 订阅额度已用完，.*:${minutesOf(resets)}.* 恢复$`),
    );
    await expect(useKey).toHaveText("改用 API 密钥");
    await planLineShots(app, window, "tagging-limit-zh");

    await pointAndClick(window, useKey);
    await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "models");
    await setLanguage(window, "en");
    await closeSettings(window);

    // Nothing more is sent while it waits; at the reset, tagging goes on by itself.
    const sent = () => openai.responses().filter((request) => request.body.model === LUNA);
    expect(sent()).toHaveLength(1);
    delete openai.replyFor[LUNA];
    await expect(listed(window, "Invoice 71")).toHaveAttribute("data-tagging", "tagged", {
      timeout: 60_000,
    });
    await expect(listed(window, "Invoice 72")).toHaveAttribute("data-tagging", "tagged");
    await expect(paused).toHaveCount(0);
    expect(sent()).toHaveLength(3);
  } finally {
    await app.close();
    await openai.close();
    await removeDataFolder(sources);
  }
});

test("while Organize files new Documents on the plan, its limit has the same one line, and Organize files them by itself at the reset", async () => {
  test.setTimeout(120_000);
  const openai = await createFakeOpenAI();
  openai.reply = {
    kind: "answer",
    text: JSON.stringify({ groupId: "__unsorted__", tags: [] }),
  };
  const sources = await createDataFolder();
  const { app, window } = await launchApp(dataDir, { chatGpt: openai.endpoints.issuer, home });
  try {
    await setWindowSize(app, window, WIDE.width, WIDE.height);
    await dismissChatSetup(window);
    await signInWithChatGpt(app, window, openai);
    await window.evaluate(async (model) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const plan = (await core.listChatProviders()).find((each) => each.kind === "chatgpt");
      if (!plan) throw new Error("The ChatGPT plan isn't set up.");
      await core.createLibraryGroup({ name: "Invoices", description: "Invoices" });
      await core.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: plan.id, modelId: model } },
        automatic: true,
      });
    }, LUNA);

    const resets = usedUp(openai, LUNA, 15 / 3600);
    await addDocuments(window, await invoices(sources, ["Invoice 81"]));
    await makeTagOnDocument(window, "Invoice 81");
    await expect(listed(window, "Invoice 81")).toHaveAttribute(
      "data-tagging",
      "waiting-for-provider",
    );
    const footer = window.getByTestId("sidebar-status");
    const paused = footer.getByTestId("tagging-paused");
    await setLanguage(window, "zh-CN");
    await expect(paused.getByTestId("status-label")).toHaveText(
      new RegExp(`^ChatGPT 订阅额度已用完，.*:${minutesOf(resets)}.* 恢复$`),
    );
    // Organize waits for the same limit: it adds no line of its own.
    await expect(footer.getByTestId("status-more")).toHaveCount(0);

    delete openai.replyFor[LUNA];
    await expect(listed(window, "Invoice 81")).toHaveAttribute("data-tagging", "tagged", {
      timeout: 60_000,
    });
    await expect(paused).toHaveCount(0);
  } finally {
    await app.close();
    await openai.close();
    await removeDataFolder(sources);
  }
});

test("with no Tag yet, an Organize on the plan still says when its limit resets (#1942)", async () => {
  test.setTimeout(120_000);
  const openai = await createFakeOpenAI();
  openai.reply = {
    kind: "answer",
    text: JSON.stringify({ groupId: "__unsorted__", tags: [] }),
  };
  const sources = await createDataFolder();
  const { app, window } = await launchApp(dataDir, { chatGpt: openai.endpoints.issuer, home });
  try {
    await setWindowSize(app, window, WIDE.width, WIDE.height);
    await dismissChatSetup(window);
    await signInWithChatGpt(app, window, openai);
    await window.evaluate(async (model) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const plan = (await core.listChatProviders()).find((each) => each.kind === "chatgpt");
      if (!plan) throw new Error("The ChatGPT plan isn't set up.");
      await core.createLibraryGroup({ name: "Invoices", description: "Invoices" });
      await core.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: plan.id, modelId: model } },
        automatic: true,
      });
    }, LUNA);

    const resets = usedUp(openai, LUNA, 15 / 3600);
    await addDocuments(window, await invoices(sources, ["Invoice 87"]));
    // No Tag of the User's own yet: the footer names none...
    await expect(window.getByTestId("sidebar-tags")).toHaveCount(0);
    // ...while Organize's own limit is still the User's to act on.
    const paused = window.getByTestId("sidebar-status").getByTestId("tagging-paused");
    await expect(paused.getByTestId("status-label")).toHaveText(
      new RegExp(`^Your ChatGPT plan’s limit is reached until .*:${minutesOf(resets)}`),
    );
  } finally {
    await app.close();
    await openai.close();
    await removeDataFolder(sources);
  }
});

test("an Organize the User runs on the plan, while Automatic tagging goes to another service, names the plan in its line, in English and Chinese", async () => {
  const openai = await createFakeOpenAI();
  openai.reply = {
    kind: "answer",
    text: JSON.stringify({ groupId: "__unsorted__", tags: [] }),
  };
  const sources = await createDataFolder();
  const { app, window } = await launchApp(dataDir, { chatGpt: openai.endpoints.issuer, home });
  try {
    await setWindowSize(app, window, WIDE.width, WIDE.height);
    await dismissChatSetup(window);
    await signInWithChatGpt(app, window, openai);
    // Automatic tags with the chat model's service, a server; Organize has the plan's model.
    // Automatic tagging is stopped, so only the Organize the User runs sends.
    await window.evaluate(async (model) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const plan = (await core.listChatProviders()).find((each) => each.kind === "chatgpt");
      if (!plan) throw new Error("The ChatGPT plan isn't set up.");
      const server = await core.saveChatProvider({
        kind: "openai-compatible",
        baseUrl: "https://llm.example.com/v1",
        modelId: "example-model",
      });
      await core.updateSettings({
        user: { chatModel: { providerId: server.id, modelId: "example-model" } },
      });
      await core.createLibraryGroup({ name: "Invoices", description: "Invoices" });
      await core.saveLibrarySettings({
        classifier: null,
        organizeWith: { kind: "chat", choice: { providerId: plan.id, modelId: model } },
        automatic: false,
      });
      await core.setTaggingWithAi(null, false);
    }, LUNA);
    await addDocuments(window, await invoices(sources, ["Invoice 91"]));
    await makeTagOnDocument(window, "Invoice 91");
    await expect(listed(window, "Invoice 91")).toBeVisible();

    const resets = usedUp(openai, LUNA, 1);
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.classifyDocuments(),
    );
    await expect(listed(window, "Invoice 91")).toHaveAttribute(
      "data-tagging",
      "waiting-for-provider",
    );
    const label = window
      .getByTestId("sidebar-status")
      .getByTestId("tagging-paused")
      .getByTestId("status-label");
    await expect(label).toHaveText(
      new RegExp(`^Your ChatGPT plan’s limit is reached until .*:${minutesOf(resets)}`),
    );
    await setLanguage(window, "zh-CN");
    await expect(label).toHaveText(
      new RegExp(`^ChatGPT 订阅额度已用完，.*:${minutesOf(resets)}.* 恢复$`),
    );
  } finally {
    await app.close();
    await openai.close();
    await removeDataFolder(sources);
  }
});
