import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  launchApp,
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

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const DECIDER = { host: "openrouter", modelId: "perplexity/pplx-decider-v1.2" };

const WORDS = {
  en: {
    label: "Checking sentences",
    line: "Decider v1.2 reads each sentence first",
    tip: "Decider v1.2 gives each sentence a quick first reading and marks the few it is sure of; your AI model checks the rest.",
    sends: "Checks send the note’s text and the passages found for it or cited in it to OpenRouter",
    noKey: "Needs a key for OpenRouter",
    addKey: "Add a key…",
    localMode: "Unavailable: “Keep everything on this computer” is on.",
    flow: "Checks by a decision model",
    unused: "On with your checks to OpenRouter · not used yet",
    turnOff: "Turn off",
    turnedOff: "Turned off Checks by a decision model",
  },
  "zh-CN": {
    label: "核对句子",
    line: "Decider v1.2 先读每个句子",
    tip: "Decider v1.2 快速给出每句的初步判断，少数有把握的直接给出结论，其余由你的 AI 模型核对。",
    sends: "核对会把笔记内容，以及为它找到或它引用的文档段落发送给 OpenRouter",
    noKey: "需要 OpenRouter 的密钥",
    addKey: "添加密钥…",
    localMode: "不可用：已开启“所有内容都留在这台电脑上”。",
    flow: "决策模型核对",
    unused: "随发往 OpenRouter 的核对一并开启 · 尚未使用",
    turnOff: "关闭",
    turnedOff: "已关闭“决策模型核对”",
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
    await shot(window, `checks-row-no-key-${language}-900`);
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
    await expect(row.getByTestId("check-decision-sends")).toHaveText(words.sends);
    await expect(row.getByTestId("check-decision-blocked")).toHaveCount(0);
    await expect(addKey).toHaveCount(0);
    expect(await chosen(window)).toBeNull();
    await holds(page, row);
    await shot(window, `checks-row-on-by-default-${language}-900`);

    await pointAndClick(window, toggle);
    await expect(toggle).not.toBeChecked();
    await expect(row).toHaveAttribute("data-reads", "off");
    await expect(row.getByTestId("check-decision-sends")).toHaveText(words.sends);
    expect(await chosen(window)).toBe("off");
    await shot(window, `checks-row-off-${language}-900`);

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
    await shot(window, `checks-row-local-mode-${language}-900`);
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
  await shot(window, "checks-row-chosen-en-1440");

  await window.evaluate(async (id) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.deleteChatProvider(id);
  }, providerId);
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  await expect(row.getByTestId("check-decision-blocked")).toHaveText(WORDS.en.noKey);
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
    await expect(use.getByTestId("data-flow-revoke")).toHaveText(WORDS[language].turnOff);
    await use.scrollIntoViewIfNeeded();
    await shot(window, `privacy-on-by-default-${language}-1440`);
  }

  await pointAndClick(window, use.getByTestId("data-flow-revoke"));
  await expect(use).toHaveCount(0);
  await expect(service).toHaveAttribute("data-consent", "accepted");
  expect(await chosen(window)).toBe("off");
  const undoLine = settings.getByTestId("consent-settings").getByTestId("undo-line-here");
  await expect(undoLine).toContainText(WORDS.en.turnedOff);
  await shot(window, "privacy-turned-off-en-1440");
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
