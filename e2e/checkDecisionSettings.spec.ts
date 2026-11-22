import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  capture,
  checkCard,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMindAndType,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
} from "./app";

/*
 * Settings › AI › Checking sentences (#3118): the switch for the decision model that reads each
 * sentence of a check first, and what Settings › Privacy says of it while it is on by default.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

/** A switch slides by a CSS transition, which the motion module's count of what moves leaves out. */
async function picture(window: Page, name: string): Promise<void> {
  await expect
    .poll(() =>
      window
        .locator(".switch")
        .evaluateAll((switches) =>
          switches.reduce((moving, each) => moving + each.getAnimations().length, 0),
        ),
    )
    .toBe(0);
  await capture(window, name);
}

const DECIDER = { host: "openrouter", modelId: "perplexity/pplx-decider-v1.2" };

const WORDS = {
  en: {
    label: "Checking sentences",
    line: "A first reading of each sentence by Decider v1.2",
    tip: "Decider v1.2 gives each sentence a quick first reading and marks the ones it is sure of; your AI model checks the rest. Decider v1.2 is Perplexity’s model: OpenRouter passes what it reads on to Perplexity.",
    sends:
      "With this on, every check sends the note’s text and the passages found for it or cited in it to OpenRouter",
    sendsByDefault:
      "On with your checks to OpenRouter, which already send the note’s text and the passages found for it or cited in it there",
    maker: "Decider v1.2 is Perplexity’s model: OpenRouter passes these on to Perplexity",
    noKey: "Needs a key for OpenRouter",
    addKey: "Add a key…",
    localMode: "Unavailable: “Keep everything on this computer” is on.",
    flow: "Checks by a decision model",
    unused: "On with your checks to OpenRouter · not used yet",
    turnOff: "Turn off",
    turnedOff: "Turned off Checks by a decision model",
    faster: "Check faster with Decider v1.2",
    fasterAction: "Turn on in Settings ›",
    sentence: "Underlying EBITDA was 96 million in the quarter.",
  },
  "zh-CN": {
    label: "核对句子",
    line: "Decider v1.2 对每个句子的初步判断",
    tip: "Decider v1.2 快速给出每句的初步判断，有把握的直接给出结论，其余由你的 AI 模型核对。Decider v1.2 是 Perplexity 的模型：OpenRouter 会把它读到的内容转交给 Perplexity。",
    sends: "开启后，每次核对都会把笔记内容，以及为它找到或它引用的文档段落发送给 OpenRouter",
    sendsByDefault:
      "随发往 OpenRouter 的核对一并开启：这些核对本来就会把笔记内容，以及为它找到或它引用的文档段落发送到那里",
    maker: "Decider v1.2 是 Perplexity 的模型：OpenRouter 会把这些内容转交给 Perplexity",
    noKey: "需要 OpenRouter 的密钥",
    addKey: "添加密钥…",
    localMode: "不可用：已开启“所有内容都留在这台电脑上”。",
    flow: "决策模型核对",
    unused: "随发往 OpenRouter 的核对一并开启 · 尚未使用",
    turnOff: "关闭",
    turnedOff: "已关闭“决策模型核对”",
    faster: "用 Decider v1.2 更快核对",
    fasterAction: "去设置开启 ›",
    sentence: "本季度基础 EBITDA 为 9,600 万。",
  },
} as const;

let dataDir: string;
let app: ElectronApplication | null = null;
let host: Server;
let hostUrl: string;
let asked: string[];
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  asked = [];
  // Stands in for the decision model's host, so nothing can reach the real one.
  host = createServer((request, response) => {
    asked.push(request.url ?? "");
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  hostUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
});
test.afterEach(async () => {
  await app?.close();
  app = null;
  await new Promise((resolve) => host.close(resolve));
  await removeDataFolder(dataDir);
});

/** What the host was sent, apart from Settings reading its public list of models: nothing, in Settings. */
const sentToHost = () => asked.filter((url) => !url.startsWith("/api/v1/models"));

async function launch(byDefault: boolean, width: number) {
  const launched = await launchApp(dataDir, { decisions: hostUrl, decisionsByDefault: byDefault });
  app = launched.app;
  await setWindowSize(launched.app, launched.window, width, 900);
  await dismissChatSetup(launched.window);
  await acceptPlainTextKeys(launched.window);
  return launched.window;
}

/** An OpenRouter key and model for Answers, made up, with every use of its own allowed: nothing is sent. */
const addOpenRouter = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const saved = await bridge.saveChatProvider({
      kind: "openrouter",
      apiKey: "sk-or-v1-a-made-up-key",
      modelId: "anthropic/claude-haiku-5.5",
    });
    for (const { flow, consent } of await bridge.listDataFlows()) {
      const theirs = flow.service.id === saved.service?.id && flow.id !== "decision-checks";
      if (theirs && consent !== "accepted") await bridge.allowDataFlow(flow.id, flow.service.id);
    }
    return saved.id;
  });

const chosen = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.getSettings()).device.checkDecisionModel;
  });

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The row's words end before its switch, and the row stays inside the page. */
async function holds(page: Locator, row: Locator): Promise<void> {
  const words = await row.locator("label").boundingBox();
  const lines = await row.getByTestId("check-decision-sends").boundingBox();
  const control = await row.getByTestId("check-decision-switch").boundingBox();
  expect(words && lines && control).toBeTruthy();
  if (!words || !lines || !control) return;
  expect(Math.max(words.x + words.width, lines.x + lines.width)).toBeLessThanOrEqual(control.x);
  expect(await page.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  // protects=without the host's key the switch is off and can't be turned on, one line names the service it needs and Add a key… opens the same add sheet; with the key, where the User's checks go to that service, it is on before they touch it, with the line that says what goes there; off stays off and stores it, on again is the User's own choice of the model, and Local mode turns it off with one line and gives it back; fails_when=the switch can be turned on with no key or in Local mode, shows off where it is on by default, the sends line is missing while it can be turned on, or the row's words run under the switch at a narrow window; no_claim=what a check then does, which the core's tests cover.
  test(`the switch says what it does and why it is off, at 900 px (${language})`, async () => {
    const window = await launch(true, 900);
    // A model set up, with no key for the decision model's host: the row is listed (#3645).
    await connectLocalChatModel(window);
    const settings = await openSettings(window, "ai");
    await setLanguage(window, language);
    const page = settings.getByTestId("settings-page-ai");
    const row = page.getByTestId("check-decision-settings");
    const toggle = row.getByTestId("check-decision-switch");

    await expect(row.locator("label")).toHaveText(words.label);
    await expect(row).toContainText(words.line);
    await expect(toggle).toHaveAccessibleDescription(new RegExp(`^${escaped(words.tip)}`));
    await expect(row.getByTestId("check-decision-blocked")).toHaveText(words.noKey);
    await expect(row.getByTestId("check-decision-sends")).toHaveCount(0);
    await expect(toggle).toBeDisabled();
    await expect(toggle).not.toBeChecked();
    await picture(window, `checks-row-no-key-${language}-900`);
    const addKey = row.getByTestId("check-decision-add-key");
    await expect(addKey).toHaveText(words.addKey);
    await pointAndClick(window, addKey);
    const sheet = settings.getByTestId("ai-add-sheet");
    await expect(sheet).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await addOpenRouter(window);
    await expect(row).toHaveAttribute("data-reads", "default");
    await expect(toggle).toBeEnabled();
    await expect(toggle).toBeChecked();
    await expect(row.getByTestId("check-decision-sends")).toHaveText(words.sendsByDefault);
    await expect(row.getByTestId("check-decision-blocked")).toHaveCount(0);
    await expect(addKey).toHaveCount(0);
    expect(await chosen(window)).toBeNull();
    await holds(page, row);
    await picture(window, `checks-row-on-by-default-${language}-900`);

    await pointAndClick(window, toggle);
    await expect(toggle).not.toBeChecked();
    await expect(row).toHaveAttribute("data-reads", "off");
    await expect(row.getByTestId("check-decision-sends")).toHaveText(words.sends);
    expect(await chosen(window)).toBe("off");
    await picture(window, `checks-row-off-${language}-900`);

    // The keyboard turns it on as the pointer does.
    await toggle.focus();
    await window.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await expect(row).toHaveAttribute("data-reads", "chosen");
    expect(await chosen(window)).toEqual(DECIDER);

    await pointAndClick(window, settings.getByTestId("local-only"));
    await expect(toggle).toBeDisabled();
    await expect(toggle).not.toBeChecked();
    await expect(row.getByTestId("check-decision-blocked")).toHaveText(words.localMode);
    await picture(window, `checks-row-local-mode-${language}-900`);
    await pointAndClick(window, settings.getByTestId("local-only"));
    await expect(toggle).toBeEnabled();
    await expect(toggle).toBeChecked();
    expect(sentToHost()).toEqual([]);
  });
}

// protects=where the decision model is off by default, a User with the key sees the switch off with the line that says what would go, and turning it on is their choice; removing the key's account turns it off and forgets the choice; fails_when=the switch shows on with nothing chosen, or a model stays chosen once its key is gone; no_claim=whether reading by default ships.
test("off by default it waits for the User, and goes with its key", async () => {
  const window = await launch(false, 1440);
  const providerId = await addOpenRouter(window);
  const settings = await openSettings(window, "ai");
  const row = settings.getByTestId("check-decision-settings");
  const toggle = row.getByTestId("check-decision-switch");
  await expect(row).toHaveAttribute("data-reads", "off");
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(row.getByTestId("check-decision-sends")).toHaveText(WORDS.en.sends);
  await holds(settings.getByTestId("settings-page-ai"), row);

  await pointAndClick(window, toggle);
  await expect(row).toHaveAttribute("data-reads", "chosen");
  expect(await chosen(window)).toEqual(DECIDER);
  await picture(window, "checks-row-chosen-en-1440");

  await window.evaluate(async (id) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.deleteChatProvider(id);
  }, providerId);
  // The last model gone, the row goes with the other jobs that need one (#3645).
  await expect(row).toHaveCount(0);
  expect(await chosen(window)).toBeNull();
  expect(sentToHost()).toEqual([]);
});

// protects=Settings › Privacy lists the flow that is on by default under its service as on with the User's checks and not used yet, never as allowed by them or as waiting to be allowed, in both languages; Turn off ends it, turns the switch off and leaves an Undo line, and Undo brings it back as it was; fails_when=the service reads as only partly allowed because of it, its button says Stop allowing or Allow, Turn off leaves it listed or the switch on, or Undo doesn't bring it back; no_claim=the line once it has read, whose date the core's tests cover.
test("Privacy says it is on with the User's checks, and Turn off can be undone", async () => {
  const window = await launch(true, 1440);
  await addOpenRouter(window);
  const settings = await openSettings(window, "privacy");
  const service = settings.getByTestId("data-service").filter({ hasText: "OpenRouter" });
  await expect(service).toHaveAttribute("data-consent", "accepted");
  await service.getByTestId("data-service-decision-details").click();
  const use = service.locator('[data-testid="data-flow"][data-flow-id="decision-checks"]');

  for (const language of ["zh-CN", "en"] as const) {
    await setLanguage(window, language);
    await expect(use).toContainText(WORDS[language].flow);
    await expect(use.getByTestId("data-flow-by-default")).toHaveText(WORDS[language].unused);
    await expect(use.getByTestId("data-flow-maker")).toHaveText(WORDS[language].maker);
    await expect(use.getByTestId("data-flow-revoke")).toHaveText(WORDS[language].turnOff);
    await use.scrollIntoViewIfNeeded();
    await picture(window, `privacy-on-by-default-${language}-1440`);
  }

  await pointAndClick(window, use.getByTestId("data-flow-revoke"));
  await expect(use).toHaveCount(0);
  await expect(service).toHaveAttribute("data-consent", "accepted");
  expect(await chosen(window)).toBe("off");
  const undoLine = settings.getByTestId("consent-settings").getByTestId("undo-line-here");
  await expect(undoLine).toContainText(WORDS.en.turnedOff);
  await picture(window, "privacy-turned-off-en-1440");
  await undoLine.getByTestId("undo-action").click();
  await expect(use.getByTestId("data-flow-by-default")).toHaveText(WORDS.en.unused);
  expect(await chosen(window)).toBeNull();

  await showSettingsPage(window, "ai");
  await expect(settings.getByTestId("check-decision-settings")).toHaveAttribute(
    "data-reads",
    "default",
  );
  expect(sentToHost()).toEqual([]);
});

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  // protects=a User who holds the host's key and never touched the switch reads one line in the check card that a decision model can read first; it opens Settings at the switch, with the keyboard on it and the line that says what goes, and turns nothing on; ✕ ends the line for good; fails_when=the line shows without a key, turns the model on itself, comes back after ✕, or pushes anything out of the card; no_claim=the User who turned the switch off or on, which the line's unit test covers.
  test(`the check card points at the switch once, and ✕ ends it for good (${language})`, async () => {
    const window = await launch(false, 1440);
    await setLanguage(window, language);
    await newMindAndType(window, words.sentence);
    const card = await checkCard(window);
    // No key for its host: nothing to turn on, so no line.
    await expect(card.getByTestId("check-faster")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(card).toBeHidden();

    await addOpenRouter(window);
    await checkCard(window);
    const line = card.getByTestId("check-faster");
    await expect(line).toContainText(words.faster);
    const action = line.getByTestId("check-faster-settings");
    await expect(action).toHaveText(words.fasterAction);
    // The link is whole on one row, whichever row the line's break leaves it on.
    expect((await action.boundingBox())?.height).toBeLessThanOrEqual(20);
    // The line stays inside the card, whose press stays in view under it.
    const [cardBox, lineBox] = [await card.boundingBox(), await line.boundingBox()];
    if (!cardBox || !lineBox) throw new Error("The card isn't laid out.");
    expect(lineBox.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    await expect(card.getByTestId("badge-check-mind")).toBeInViewport();
    await picture(window, `check-faster-line-${language}-1440`);

    // The keyboard reaches it, and it opens Settings at the switch: nothing is turned on.
    await action.focus();
    await window.keyboard.press("Enter");
    const row = window.getByTestId("check-decision-settings");
    await expect(row).toBeInViewport();
    await expect(row.getByTestId("check-decision-switch")).toBeFocused();
    await expect(row.getByTestId("check-decision-switch")).not.toBeChecked();
    await expect(row.getByTestId("check-decision-sends")).toHaveText(words.sends);
    expect(await chosen(window)).toBeNull();
    await picture(window, `check-faster-settings-${language}-1440`);
    await window.keyboard.press("Escape");
    await expect(row).toBeHidden();

    // ✕ ends it for good: on this card, and the next time it opens.
    await checkCard(window);
    await pointAndClick(window, line.getByTestId("tip-close"));
    await expect(line).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(card).toBeHidden();
    await checkCard(window);
    await expect(card.getByTestId("badge-check-mind")).toBeVisible();
    await expect(line).toHaveCount(0);
    expect(await chosen(window)).toBeNull();
    expect(sentToHost()).toEqual([]);
  });
}
