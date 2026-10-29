import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addDocuments,
  clickNotification,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  forceQuit,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  notificationsShown,
  ollamaListing,
  pointAndClick,
  recordNotifications,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Research (#130): "Research…" in the assistant's composer takes a topic, and
 * a plan card opens in the tray above it, with the steps the composer's model
 * proposed, each edited in place, the sources, where it writes and an
 * estimate with the composer's model. Start makes it a Task whose progress
 * shows in the thread under its Question, as it searches the web and the
 * Library; it asks in the tray before filing the pages it read, takes
 * messages through Tell it…, stops at the monthly cap with what is left, and
 * goes on after a quit. A local server stands in for the web, and the
 * scripted chat model plans and searches. Set INCARNAMIND_SCREENSHOTS to a
 * folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const fixture = (name: string) => readFileSync(join(__dirname, `../tests/fixtures/web/${name}`));
const MODEL = "claude-haiku-5-5";
const MODEL_NAME = "Claude Haiku 5.5";
const TOPIC = "how tea reached Europe";

let dataDir: string;
let home: string;
let sources: string;
let server: Server;
let port: number;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  sources = await createDataFolder();
  server = createServer((request, response) => {
    const page =
      request.url === "/tea"
        ? fixture("article.html")
        : request.url === "/members"
          ? fixture("login.html")
          : null;
    response.writeHead(page ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page ?? "Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(sources);
});

/** An Anthropic key, Questions and automatic tagging allowed to go there, and web search on. */
async function useAnthropic(window: Page): Promise<void> {
  await acceptPlainTextKeys(window);
  await window.evaluate(async (modelId) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId,
    });
    if (!provider.service) return;
    await core.allowDataFlow("chat", provider.service.id);
    await core.allowDataFlow("tagging", provider.service.id);
    await core.updateSettings({ user: { webSearch: true } });
  }, MODEL);
}

/** The tray sits joined above the composer, its width, and never over it. */
async function expectAboveComposer(window: Page, tray: Locator): Promise<void> {
  const [trayBox, composerBox] = [
    await tray.boundingBox(),
    await window.getByTestId("composer").boundingBox(),
  ];
  if (!trayBox || !composerBox) throw new Error("The tray or the composer isn't on screen.");
  expect(trayBox.y + trayBox.height).toBeLessThanOrEqual(composerBox.y + 1);
  expect(Math.abs(trayBox.width - composerBox.width)).toBeLessThan(2);
}

/** The Folder a Research files its pages into: named for its plan's title. */
const folderNameOf = (topic: string) => `What do the sources say about ${topic}`;

const valuesOf = (fields: Locator) =>
  fields.evaluateAll((each) => each.map((field) => (field as HTMLTextAreaElement).value));

/** "/" in the composer, "Research…", then the topic: the plan card opens. */
async function research(window: Page, topic: string): Promise<Locator> {
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("/res");
  await expect(window.getByTestId("slash-item-research")).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("composer-research")).toBeVisible();
  await window.keyboard.type(topic);
  await window.keyboard.press("Enter");
  const card = window.getByTestId("research-plan");
  await expect(card.getByTestId("research-plan-step")).toHaveCount(3);
  return card;
}

test("Research… plans in the tray: the steps edited in place, the sources, where it writes and an estimate with the composer's model; Start shows it searching under its Question, then the pages it saved are filed into a new Folder with Tags and its cited draft waits as changes", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home, web: port });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 900);
  await useAnthropic(window);
  const note = join(sources, "Tea trade.txt");
  await writeFile(note, "Tea trade.\nDutch traders shipped tea to Amsterdam in 1610.\n");
  await addDocuments(window, [note]);
  await newMind(window);
  await window.keyboard.type("Credit memo");
  await screenshot(window, "research-before-en-1600");

  const card = await research(window, TOPIC);
  // The topic is the Question in the thread, with the plan below.
  const thread = window.getByTestId("assistant-thread");
  const question = thread.getByTestId("assistant-question").last();
  await expect(question).toContainText(TOPIC);
  await expect(question.getByTestId("assistant-question-research")).toHaveText("Research");
  await expect(thread.getByTestId("research-plan-line")).toHaveText(
    "Plan below. Edit it, then Start.",
  );
  await expectAboveComposer(window, window.getByTestId("task-tray"));
  await expect(card.getByTestId("research-plan-title")).toHaveText(
    `What do the sources say about ${TOPIC}?`,
  );
  const steps = card.getByTestId("research-plan-step");
  await expect
    .poll(() => valuesOf(steps))
    .toEqual([
      `Search the web and the Library for ${TOPIC}`,
      `Read what the sources say about ${TOPIC}`,
      "Compare what they found",
    ]);
  await expect(card.getByTestId("research-plan-write-step")).toHaveText(
    "Write a cited draft into “Credit memo”",
  );
  await expect(card.getByTestId("research-plan-web")).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByTestId("research-plan-library")).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByTestId("research-plan-estimate")).toHaveText(
    new RegExp(`^About \\$\\d+\\.\\d+ · 4–8 min · ${MODEL_NAME}$`),
  );
  await expect(window.getByTestId("composer-input")).toHaveAttribute(
    "placeholder",
    "Change the plan…",
  );
  await expect(card.getByTestId("research-plan-write-into")).toBeInViewport();
  await screenshot(window, "research-plan-en-1600");

  // A step is edited in place; Enter adds one after it, Backspace in an empty one takes it out.
  await pointAndClick(window, steps.nth(1));
  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.type("Read the first traders' accounts");
  await window.keyboard.press("Enter");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(2)).toBeFocused();
  await window.keyboard.press("Backspace");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(1)).toBeFocused();
  await expect(card.getByTestId("research-plan-estimate")).toContainText("4–8 min");

  // The sources by keyboard; one at least.
  await card.getByTestId("research-plan-library").focus();
  await window.keyboard.press("Space");
  await expect(card.getByTestId("research-plan-library")).toHaveAttribute("aria-pressed", "false");
  await card.getByTestId("research-plan-web").focus();
  await window.keyboard.press("Space");
  await expect(card.getByTestId("research-plan-start")).toBeDisabled();
  await expect(card.getByTestId("research-plan-estimate")).toHaveText(
    "Choose the web, the Library or both",
  );
  await window.keyboard.press("Space");
  await card.getByTestId("research-plan-library").focus();
  await window.keyboard.press("Space");
  await expect(card.getByTestId("research-plan-start")).toBeEnabled();

  // Write into: another Mind or a new one, and back.
  await pointAndClick(window, card.getByTestId("research-plan-write-into"));
  await pointAndClick(window, window.getByTestId("research-plan-new-mind"));
  await expect(card.getByTestId("research-plan-write-step")).toHaveText(
    "Write a cited draft into a new note",
  );
  await pointAndClick(window, card.getByTestId("research-plan-write-into"));
  await pointAndClick(window, window.getByTestId("research-plan-mind").first());
  await expect(card.getByTestId("research-plan-write-into")).toHaveText("Credit memo");

  // "Change the plan…" in the composer has the model redo the steps.
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Check the dates too");
  await window.keyboard.press("Enter");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(3)).toHaveValue("Check the dates too");
  await expect(card.getByTestId("research-plan-estimate")).toContainText("5–10 min");

  // Start (⌘↵ from the composer): the card goes, and its progress shows under its Question.
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(window.getByTestId("research-plan")).toHaveCount(0);
  await expect(window.getByTestId("task-tray")).toHaveCount(0);
  const progress = thread.getByTestId("task-progress");
  await expect(progress).toContainText("Research");
  await expect(thread.getByTestId("assistant-question").last()).toContainText(TOPIC);
  // Its first search asks to send to Anthropic, as an Answer's does.
  const consent = window.getByTestId("consent-dialog");
  await expect(consent).toContainText("Anthropic");
  await pointAndClick(window, consent.getByTestId("consent-allow"));
  await expect(progress.getByTestId("task-progress-steps")).toContainText("Searched the web for", {
    timeout: 30_000,
  });
  await expect(progress.getByTestId("task-progress-steps")).toContainText(
    "Read “Tea - The Open Encyclopedia”",
  );
  await screenshot(window, "research-running-en-1600");

  // Having read a web page, it asks in the tray before filing it; ⌘↵ in the composer allows.
  const tray = window.getByTestId("task-tray");
  const ask = tray.getByTestId("task-ask");
  await expect(ask.getByTestId("approval-card")).toContainText("Save 1 web page to a new Folder", {
    timeout: 60_000,
  });
  await expect(ask.getByTestId("approval-card")).toContainText(`${folderNameOf(TOPIC)} (new)`);
  await expect(ask.getByTestId("approval-third-party")).toHaveText(
    "Asks first: this Task read web pages.",
  );
  await expect(ask.getByTestId("approval-always-allow")).toHaveCount(0);
  await expect(progress.getByTestId("task-progress-waiting")).toHaveText(
    "Waiting for your approval below",
  );
  await expectAboveComposer(window, tray);
  await screenshot(window, "research-ask-en-1600");
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(tray).toHaveCount(0);
  await expect(progress).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  await expect(progress.getByTestId("task-progress-meta")).toHaveText(/^Done in \d+ min$/);
  const folderName = folderNameOf(TOPIC);
  await expect(progress.getByTestId("task-progress-steps")).toContainText(
    `1 source saved in “${folderName}”`,
  );
  await expect(progress.getByTestId("task-progress-steps")).toContainText(
    "Wrote a cited draft as 2 changes in “Credit memo”",
  );
  await expect(progress.getByTestId("task-progress-summary")).toHaveText(
    "1 source saved · 2 changes proposed",
  );
  await pointAndClick(window, progress.getByTestId("task-progress-details"));
  const record = progress.getByTestId("task-record-details");
  await expect(record).toContainText(`1 source saved in ${folderName}`);
  await expect(record).toContainText("Tags: Tea");
  await expect(record).toContainText("save: Allowed");
  await expect(record).toContainText("No steering messages");
  await expect(progress.getByTestId("task-progress-record")).toContainText("Started");
  await screenshot(window, "research-record-en-1600");

  // The page it read is a Document filed into a new Folder named for the research, with a Tag.
  const state = await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return {
      documents: await core.listDocuments(),
      library: await core.getLibrary(),
      tags: await core.listTags(),
    };
  });
  const page = state.documents.find((each) => each.kind === "web");
  expect(page?.name).toBe("Tea - The Open Encyclopedia");
  const filed = state.library.groups.find((each) => each.name === folderName);
  expect(state.library.assignments.find((each) => each.documentId === page?.id)?.groupId).toBe(
    filed?.id,
  );
  const tea = state.tags.find((each) => each.name === "Tea");
  expect(page?.tags.map((each) => each.tagId)).toContain(tea?.id);
  await expect(window.getByTestId("sidebar").getByText(folderName)).toBeVisible();

  // The draft waits in the Mind as changes to accept, its Citation found; Review brings it into view.
  const editor = window.getByTestId("mind-editor");
  await expect(window.getByTestId("proposals-count")).toHaveText("2 changes from the assistant");
  await expect(editor.locator("[data-proposal-id]").first()).toContainText(
    "Your Documents answer this",
  );
  await expect(editor.getByTestId("citation").first()).toHaveAttribute("data-check", "found");
  await progress.getByTestId("task-progress-review").focus();
  await window.keyboard.press("Enter");
  await expect(editor.locator("[data-proposal-id]").first()).toBeInViewport();
  await screenshot(window, "research-done-en-1600");
  await app.close();
});

test("with a model that can't search the web, Research says it reads the Library only; a plan with no steps says why, with Try again and a first step to write", async () => {
  const ollama = await ollamaListing(["fake-model"]);
  try {
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 760);
    await window.evaluate(async (baseUrl) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
        kind: "ollama",
        baseUrl,
        modelId: "fake-model",
      });
    }, ollama.url);
    await newMind(window);
    await window.keyboard.type("Tide notes");

    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("/res");
    const offer = window.getByTestId("slash-item-research");
    await expect(offer).toContainText(
      "Searches the Library only, then drafts with Citations. fake-model can’t search the web.",
    );
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("composer-research")).toHaveAttribute(
      "title",
      "Searches the Library only, then drafts with Citations. fake-model can’t search the web.",
    );
    await window.keyboard.type("Spring tides, no plan");
    await window.keyboard.press("Enter");

    const card = window.getByTestId("research-plan");
    await expect(card.getByTestId("research-plan-web-unavailable")).toHaveText(
      "fake-model can’t search the web, so this research reads your Library only",
    );
    const failed = card.getByTestId("research-plan-failed");
    await expect(failed).toContainText("Couldn’t make a plan: The model sent no steps.");
    await expect(failed.getByRole("button")).toHaveText("Try again");
    const step = card.getByTestId("research-plan-step");
    await expect(step).toHaveCount(1);
    await expect(step).toHaveAttribute("placeholder", "Write a first step");
    await motionSettled(window);
    await screenshot(window, "research-library-only-en");
    await step.fill("Read the tide tables in the Library");
    await expect(card.getByTestId("research-plan-start")).toBeEnabled();
    await app.close();
  } finally {
    ollama.server.close();
  }
});

for (const [language, said, choose] of [
  [
    "en",
    "Couldn’t make a plan: The model used its whole reply thinking and sent no steps. Write the steps yourself, or choose another model.",
    "Choose another model",
  ],
  [
    "zh-CN",
    "未能制定计划：模型把回复全用在了思考上，没有给出步骤。你可以自己写步骤，或换一个模型。",
    "换一个模型",
  ],
] as const) {
  test(`a model that thinks through its whole plan reply says so, and offers another model rather than Try again (${language})`, async () => {
    const ollama = await ollamaListing(["fake-model-always-thinks"]);
    try {
      const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1100, 760);
      await window.evaluate(async (baseUrl) => {
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
          kind: "ollama",
          baseUrl,
          modelId: "fake-model-always-thinks",
        });
      }, ollama.url);
      await newMind(window);
      await window.keyboard.type("Tide notes");
      await setLanguage(window, language);

      await window.keyboard.press("ControlOrMeta+j");
      await window.keyboard.type("/res");
      await window.keyboard.press("Enter");
      await window.keyboard.type("Spring tides");
      await window.keyboard.press("Enter");

      const failed = window.getByTestId("research-plan").getByTestId("research-plan-failed");
      await expect(failed).toContainText(said);
      await expect(failed.getByRole("button")).toHaveText(choose);
      await pointAndClick(window, failed.getByRole("button"));
      await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "models");
      await app.close();
    } finally {
      ollama.server.close();
    }
  });
}

test("with the thinking model picked in the chip, Choose another model opens the chip's menu, and another model there makes the plan", async () => {
  const ollama = await ollamaListing(["fake-model", "fake-model-always-thinks"]);
  try {
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 760);
    await window.evaluate(async (baseUrl) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
        kind: "ollama",
        baseUrl,
        modelId: "fake-model",
      });
    }, ollama.url);
    await newMind(window);
    await window.keyboard.type("Tide notes");
    const pick = async (name: string) => {
      const option = window
        .getByTestId("composer-model-menu")
        .getByTestId("composer-model-option")
        .filter({ hasText: name });
      await pointAndClick(window, option.first());
    };
    await pointAndClick(window, window.getByTestId("composer-model"));
    await pick("fake-model-always-thinks");

    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("/res");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Spring tides");
    await window.keyboard.press("Enter");
    const card = window.getByTestId("research-plan");
    const failed = card.getByTestId("research-plan-failed");
    await expect(failed.getByRole("button")).toHaveText("Choose another model");

    await pointAndClick(window, failed.getByRole("button"));
    await expect(window.getByTestId("composer-model-menu")).toBeVisible();
    await expect(window.getByTestId("settings")).toBeHidden();
    await pick("fake-model");
    await expect(card.getByTestId("research-plan-step")).toHaveCount(3);
    await expect(failed).toHaveCount(0);
    await app.close();
  } finally {
    ollama.server.close();
  }
});

test("the plan card follows the composer's model chip, says when the web can't be searched, fits 900px in Chinese, and Esc puts the topic back; steering and the Done record stay explicit when the Task finishes while drafting", async () => {
  test.setTimeout(120_000);
  const ollama = await ollamaListing(["fake-model", "other-model"]);
  try {
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
    await dismissChatSetup(window);
    await setWindowSize(app, window, 900, 760);
    await window.evaluate(async (baseUrl) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
        kind: "ollama",
        baseUrl,
        modelId: "fake-model",
      });
    }, ollama.url);
    const note = join(sources, "Tea trade.txt");
    await writeFile(note, "Tea trade.\nDutch traders shipped tea to Amsterdam in 1610.\n");
    await addDocuments(window, [note]);
    await newMind(window);
    await window.keyboard.type("Credit memo");
    await setLanguage(window, "zh-CN");

    const card = await research(window, `${TOPIC}, slowly`);
    // A model on this computer can't search the web: the card says so, with Web off.
    await expect(card.getByTestId("research-plan-estimate")).toHaveText("4–8 分钟 · fake-model");
    await expect(card.getByTestId("research-plan-web")).toBeDisabled();
    await expect(card.getByTestId("research-plan-web")).toHaveAttribute("aria-pressed", "false");
    await expect(card.getByTestId("research-plan-web-unavailable")).toHaveText(
      "fake-model 不能联网搜索，因此这次研究只查阅你的资料库",
    );
    // The composer's model chip is the card's model: changing it changes the card.
    await pointAndClick(window, window.getByTestId("composer-model"));
    const option = window
      .getByTestId("composer-model-menu")
      .getByTestId("composer-model-option")
      .filter({ hasText: "other-model" });
    await pointAndClick(window, option);
    await expect(card.getByTestId("research-plan-estimate")).toHaveText("4–8 分钟 · other-model");
    await expect(card.getByTestId("research-plan-web-unavailable")).toHaveText(
      "other-model 不能联网搜索，因此这次研究只查阅你的资料库",
    );

    // At 900px in Chinese, the card holds inside the composer's width, Start in view.
    const [cardBox, composerBox] = [
      await card.boundingBox(),
      await window.getByTestId("composer").boundingBox(),
    ];
    if (!cardBox || !composerBox) throw new Error("The card or the composer isn't on screen.");
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(composerBox.x + composerBox.width + 1);
    await expect(card.getByTestId("research-plan-start")).toBeInViewport();
    await motionSettled(window);
    await screenshot(window, "research-plan-zh-900");

    // Esc cancels: the topic comes back to the composer, ready to be asked again.
    await card.getByTestId("research-plan-start").focus();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("research-plan")).toHaveCount(0);
    await expect(window.getByTestId("composer-input")).toHaveValue(`${TOPIC}, slowly`);
    await expect(window.getByTestId("composer-research")).toBeVisible();

    // Asked again and started, it runs slowly; Stop ends it in the middle of a step.
    await window.keyboard.press("Enter");
    await expect(card.getByTestId("research-plan-step")).toHaveCount(3);
    await card.getByTestId("research-plan-start").focus();
    await window.keyboard.press("ControlOrMeta+Enter");
    const progress = window.getByTestId("assistant-thread").getByTestId("task-progress");
    await expect(progress).toHaveAttribute("data-status", "running");
    await expect(progress.getByTestId("task-progress-meta")).toHaveText(
      /^已完成 0\/4 步 · \d+ 分钟$/,
    );
    await expect(progress.getByTestId("task-progress-actions").getByRole("button")).toHaveText([
      "计划",
      "告诉它…",
      "暂停",
      "停止",
    ]);
    await screenshot(window, "research-running-zh-900");

    // Plan shows its plan in the tray as it runs; Esc puts it away.
    await progress.getByTestId("task-progress-plan").focus();
    await window.keyboard.press("Enter");
    const view = window.getByTestId("research-plan-view");
    await expect(view.getByTestId("research-plan-view-step")).toHaveCount(4);
    await expect(view.getByTestId("research-plan-view-step").last()).toHaveText(
      "4.撰写带引用的草稿",
    );
    await expect(view.getByTestId("research-plan-view-close")).toBeFocused();
    await screenshot(window, "research-plan-view-zh-900");
    await window.keyboard.press("Escape");
    await expect(view).toHaveCount(0);

    // Tell it…: the composer aims at the Task, and Enter sends there.
    const input = window.getByTestId("composer-input");
    const chip = window.getByTestId("composer-tell");
    await progress.getByTestId("task-progress-tell").focus();
    await window.keyboard.press("Enter");
    await expect(input).toBeFocused();
    await expect(chip).toHaveText("→ 研究");
    await expect(input).toHaveAttribute("placeholder", "告诉它要改什么…");
    // Paused, it starts no step, so what is sent waits in the tray.
    await progress.getByTestId("task-progress-pause").focus();
    await window.keyboard.press("Enter");
    await expect(progress).toHaveAttribute("data-status", "paused");
    await window.keyboard.press("ControlOrMeta+j");
    await expect(chip).toBeVisible();
    await window.keyboard.type("不要写折扣店");
    await window.keyboard.press("Enter");
    const queued = window.getByTestId("task-tray").getByTestId("task-queued-message");
    await expect(queued).toHaveText("↳“不要写折扣店” · 下一步时读取");
    await expect(chip).toHaveCount(0);
    await expect(input).toHaveValue("");
    await expectAboveComposer(window, window.getByTestId("task-tray"));
    // ↑ in the empty composer takes the last one back to be edited, still aimed at the Task.
    await window.keyboard.press("ArrowUp");
    await expect(input).toHaveValue("不要写折扣店");
    await expect(chip).toBeVisible();
    await expect(queued).toHaveCount(0);
    await window.keyboard.type("，也不要写咖啡，只比较欧洲最早的几条贸易路线和它们各自的年份");
    await window.keyboard.press("Enter");
    await expect(queued).toHaveText(
      "↳“不要写折扣店，也不要写咖啡，只比较欧洲最早的几条贸易路线和它们各自的年份” · 下一步时读取",
    );
    // A long message wraps in the tray rather than being cut.
    const [one, remove] = [
      await queued.boundingBox(),
      await queued.getByTestId("task-queued-remove").boundingBox(),
    ];
    if (!one || !remove) throw new Error("The queued message isn't on screen.");
    expect(one.height).toBeGreaterThan(remove.height * 1.5);
    await screenshot(window, "research-queued-zh-900");
    // ✕ takes it back, and Undo tells it again.
    await queued.getByTestId("task-queued-remove").focus();
    await window.keyboard.press("Enter");
    await expect(queued).toHaveCount(0);
    await expect(window.getByTestId("undo-message")).toHaveText(
      "已撤回“不要写折扣店，也不要写咖啡，只比较欧洲最早的几条贸易路线和它们各自的年份”",
    );
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect(queued).toHaveCount(1);
    // Resumed, it reads the message when its next step starts.
    await progress.getByTestId("task-progress-resume").focus();
    await window.keyboard.press("Enter");
    await expect(progress).toHaveAttribute("data-status", "running");
    await expect(queued).toHaveCount(0, { timeout: 30_000 });
    await expect(window.getByTestId("task-tray")).toHaveCount(0);
    // ⌘K reaches Tell it… too; Esc goes back to asking.
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type("告诉正在运行");
    await expect(window.getByTestId("palette").getByTestId("palette-item").first()).toContainText(
      "告诉正在运行的任务…",
    );
    await window.keyboard.press("Enter");
    await expect(chip).toBeVisible();
    await expect(input).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(chip).toHaveCount(0);

    await progress.getByTestId("task-progress-tell").focus();
    await window.keyboard.press("Enter");
    const unsent = "这条说明还没有发送，不能在任务完成后改变它的目标";
    await input.type(unsent);
    await expect(progress).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(input).toHaveValue(unsent);
    await expect(chip).toBeVisible();
    const finished = window.getByTestId("composer-tell-finished");
    await expect(finished).toContainText("已结束");
    await expect(finished.getByRole("button", { name: "改为提问" })).toBeVisible();
    await pointAndClick(window, progress.getByTestId("task-progress-details"));
    const record = progress.getByTestId("task-record-details");
    await expect(record).toContainText("未保存来源");
    await expect(record).toContainText("无批准记录");
    await expect(record).toContainText("不要写折扣店");
    await expect(record).not.toContainText(unsent);
    await screenshot(window, "research-record-zh-900");
    await pointAndClick(window, finished.getByRole("button", { name: "改为提问" }));
    await expect(chip).toHaveCount(0);
    await expect(finished).toHaveCount(0);
    await expect(input).toHaveValue(unsent);
    await expect(input).toBeFocused();
    await app.close();
  } finally {
    ollama.server.close();
  }
});

test("at the monthly cap a Research pauses and lists what it has still to do; Resumed, it goes on after a force-quit and, its Mind off screen, says in a notification what it did", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1600, 900);
  await useAnthropic(window);
  const note = join(sources, "Tea trade.txt");
  await writeFile(note, "Tea trade.\nDutch traders shipped tea to Amsterdam in 1610.\n");
  await addDocuments(window, [note]);
  await newMind(window);
  await window.keyboard.type("Credit memo");

  // The Library only, slowly, with this month's spending already at the cap.
  const card = await research(window, `${TOPIC}, slowly`);
  await pointAndClick(window, card.getByTestId("research-plan-web"));
  await expect(card.getByTestId("research-plan-web")).toHaveAttribute("aria-pressed", "false");
  await window.evaluate(async () => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { monthlyCap: { amount: 0.000_001, currency: "USD" } },
    });
  });
  await pointAndClick(window, card.getByTestId("research-plan-start"));
  const progress = window.getByTestId("assistant-thread").getByTestId("task-progress");
  await expect(progress).toHaveAttribute("data-status", "paused", { timeout: 30_000 });
  const remaining = progress.getByTestId("task-progress-remaining");
  await expect(remaining).toContainText("Still to do");
  await expect(remaining.locator("li")).toHaveText([
    "–Search the web and the Library for how tea reached Europe, slowly",
    "–Read what the sources say about how tea reached Europe, slowly",
    "–Compare what they found, slowly",
    "–Write a cited draft",
  ]);
  await expect(progress.getByTestId("task-progress-actions").getByRole("button")).toHaveText([
    "Plan",
    "Change cap",
    "Resume",
    "Stop",
  ]);
  await screenshot(window, "research-cap-en-1600");

  // The cap raised, Resume goes on from where it stopped.
  await window.evaluate(async () => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { monthlyCap: null },
    });
  });
  await progress.getByTestId("task-progress-resume").focus();
  await window.keyboard.press("Enter");
  await expect(progress).toHaveAttribute("data-status", "running");
  await expect(remaining).toHaveCount(0);
  const taskId = (await progress.getAttribute("data-task")) ?? "";
  const progressOf = () =>
    window.evaluate(
      async (id) =>
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listTasks()).find(
          (task) => task.id === id,
        )?.progress?.done ?? 0,
      taskId,
    );
  await expect.poll(progressOf, { timeout: 60_000 }).toBeGreaterThan(0);
  expect(await progressOf()).toBeLessThan(4);

  // Force-quit halfway: at the next start it goes on by itself.
  await window.keyboard.press("ControlOrMeta+t");
  await enterContent(window);
  await nameMind(window, "Notes");
  await forceQuit(app);
  const again = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(again.app, again.window, 1600, 900);
  await recordNotifications(again.app);
  const notes = await again.window.evaluate(
    async () =>
      (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds()).find(
        (mind) => mind.title === "Notes",
      )?.id ?? "",
  );
  await again.window.evaluate(
    (id) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.changeLayout("main", {
        type: "open",
        item: { kind: "mind", mindId: id },
        where: { in: "place" },
      }),
    notes,
  );
  // Done while its Mind isn't on screen, it says so in a notification, with what it did.
  await expect
    .poll(() => notificationsShown(again.app), { timeout: 90_000 })
    .toEqual([{ title: "Research finished", body: "Credit memo · 2 changes proposed" }]);
  // Its click opens the Mind, with what it did under its Question.
  await clickNotification(again.app, 0);
  await expect(
    again.window.getByTestId("mind-tab").filter({ hasText: "Credit memo" }),
  ).toHaveAttribute("aria-selected", "true");
  const done = again.window.getByTestId("assistant-thread").getByTestId("task-progress");
  await expect(done).toHaveAttribute("data-status", "done");
  await expect(done).toHaveAttribute("data-shown", "true");
  await expect(done.getByTestId("task-progress-summary")).toHaveText("2 changes proposed");
  await expect(again.window.getByTestId("proposals-count")).toHaveText(
    "2 changes from the assistant",
  );
  await screenshot(again.window, "research-resumed-en-1600");
  await again.app.close();
});
