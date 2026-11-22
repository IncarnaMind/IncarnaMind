import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  closeSettings,
  controlReads,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  showSettingsPage,
} from "./app";

/*
 * Settings › AI is one page that starts with the User's own AI (#3645): Your AI, then a model in
 * IncarnaMind, optional and one quiet row while there is none, then the jobs, the accounts and the
 * limits. Each setup a User can be in, with no model set up unless the test says so. The home
 * folder is a temporary one with Claude Code's settings in it, so no agent of the User's is
 * touched. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let home: string;
let app: ElectronApplication | null = null;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  await writeFile(join(home, ".claude.json"), "{}\n");
  await mkdir(join(home, ".claude"), { recursive: true });
});
test.afterEach(async () => {
  await app?.close();
  app = null;
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

async function launch(): Promise<Page> {
  const launched = await launchApp(dataDir, { home });
  app = launched.app;
  await setWindowSize(launched.app, launched.window, 1440, 900);
  await dismissChatSetup(launched.window);
  await acceptPlainTextKeys(launched.window);
  return launched.window;
}

/** Claude Code connected as the setup connects it: all of the User's Documents, and it may write. */
const connectClaudeCode = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setAgentsEnabled(true);
    await bridge.setUpAgent({ client: "claude-code", folderIds: ["all"], propose: true });
  });

/** A model in IncarnaMind, with a made-up key: nothing is sent with it here. */
const setUpModel = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-api03-a-made-up-key",
      modelId: "claude-haiku-5-5",
    });
  });

const nav = (settings: Locator) =>
  settings
    .locator('[data-testid^="settings-nav-"]')
    .evaluateAll((all) =>
      all.map((each) => each.getAttribute("data-testid")?.replace("settings-nav-", "")),
    );

/** The parts of the page from the top, each by its test id, as far as they are there. */
async function order(settings: Locator, ids: readonly string[]): Promise<string[]> {
  const tops: [string, number][] = [];
  await expect(settings.getByTestId("ai-limits")).toBeVisible();
  for (const id of ids) {
    const part = settings.getByTestId(id).first();
    if ((await part.count()) === 0) continue;
    const box = await part.boundingBox();
    if (box) tops.push([id, box.y]);
  }
  return tops.sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

const PARTS = [
  "ai-lede",
  "agents-connected",
  "ai-use-model",
  "ai-jobs",
  "your-providers",
  "ai-limits",
] as const;

/** The rows of What each job uses that need a model in IncarnaMind. */
const MODEL_ROWS = [
  "model-default-row-chatModel",
  "model-default-row-quickTasksModel",
  "model-default-row-imageModel",
  "web-search-settings",
] as const;

// protects=with nothing set up, AI leads with Your AI's line and the agents to connect, then one quiet row for a model, then only the jobs that run without one, and Limits with no cap; no Agents page and no switch to find; Add an account or key… from ⌘K still opens its sheet; fails_when=the model row comes first, a job that needs a model is listed, the cap or the switch shows, or the sheet can't be reached; no_claim=the setup dialog the row opens (firstRunSetup.spec.ts).
test("nothing set up: Your AI and the agents to connect, then one quiet row, and only the jobs that run without a model", async () => {
  const window = await launch();
  const settings = await openSettings(window, "ai");
  expect(await nav(settings)).toEqual(["general", "ai", "meetings", "privacy"]);
  await expect(settings.getByTestId("agents-list").getByTestId("agent-client")).toHaveCount(8);
  expect(await order(settings, PARTS)).toEqual([
    "ai-lede",
    "agents-connected",
    "ai-use-model",
    "ai-jobs",
    "ai-limits",
  ]);
  await expect(settings.getByTestId("agents-enabled")).toHaveCount(0);
  await expect(settings.getByTestId("agents-connect-another")).toHaveCount(0);
  await expect(settings.getByTestId("ai-use-model-open")).toContainText(
    "Optional: the assistant, sorting by itself, notes after calls",
  );
  for (const row of MODEL_ROWS) await expect(settings.getByTestId(row), row).toHaveCount(0);
  await expect(settings.getByTestId("check-writes-settings")).toContainText(
    "Check what your own AI writes",
  );
  await expect(settings.getByTestId("model-default-row-sorting")).toBeVisible();
  await expect(settings.getByTestId("model-default-row-transcription")).toBeVisible();
  await expect(settings.getByTestId("ai-document-search")).toBeVisible();
  await expect(settings.getByTestId("spending-cap-settings")).toHaveCount(0);
  await expect(settings.getByTestId("local-only-setting")).toContainText(
    "Only local models answer, and your own AI is paused.",
  );
  await shot(window, "ai-nothing-en-1440");

  // General's link to the cap goes with the cap.
  await showSettingsPage(window, "general");
  await expect(settings.getByTestId("spending-cap-moved")).toHaveCount(0);
  await closeSettings(window);

  // ⌘K's Add an account or key… opens its sheet on the page, with no model.
  await runCommand(window, "settings.addProvider", "Add an account or key…");
  await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "ai");
  await expect(window.getByTestId("ai-add-sheet")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("ai-add-sheet")).toBeHidden();
  await closeSettings(window);

  await setLanguage(window, "zh-CN");
  await setWindowSize(app as ElectronApplication, window, 900, 900);
  await window.getByRole("button", { name: "设置", exact: true }).click();
  const chinese = await showSettingsPage(window, "ai");
  await expect(chinese.getByTestId("ai-lede")).toHaveText("让你常用的 AI 工具读取你的文档。");
  await expect(chinese.getByTestId("ai-use-model-open")).toContainText(
    "在 IncarnaMind 里用一个模型…",
  );
  await expect(chinese.getByTestId("ai-use-model-open")).toContainText(
    "可选：助手、自动整理、会后笔记",
  );
  await expect(chinese.getByTestId("check-writes-settings")).toContainText(
    "自动核对你自己的 AI 写入的内容",
  );
  const fits = await chinese
    .getByTestId("settings-page-ai")
    .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
  expect(fits).toBe(true);
  await shot(window, "ai-nothing-zh-900");
});

// protects=with Claude Code connected and no model, Your AI holds its row and Connect another agent…, which unfolds the list with its search focused and without Claude Code, then the quiet row and the jobs that run without a model; Organize says to ask the connected AI; at 900 × 560 nothing spills; fails_when=the list is open, the switch shows, Claude Code is offered again, the search isn't focused, or a model's row shows
test("Claude Code connected, no model: its row, Connect another agent…, then the quiet row", async () => {
  const window = await launch();
  await connectClaudeCode(window);
  const settings = await openSettings(window, "ai");
  expect(await order(settings, PARTS)).toEqual([
    "agents-connected",
    "ai-use-model",
    "ai-jobs",
    "ai-limits",
  ]);
  await expect(settings.getByTestId("agent-pairing")).toHaveAttribute("data-name", "Claude Code");
  await expect(settings.getByTestId("agents-enabled")).toHaveCount(0);
  await expect(settings.getByTestId("agents-list")).toHaveCount(0);
  for (const row of MODEL_ROWS) await expect(settings.getByTestId(row), row).toHaveCount(0);
  await expect(settings.getByTestId("model-default-row-sorting")).toContainText(
    "Ask your connected AI to suggest Folders and Tags.",
  );
  await shot(window, "ai-claude-en-1440");

  const another = settings.getByTestId("agents-connect-another");
  await expect(another).toHaveText("Connect another agent…");
  await another.click();
  await expect(settings.getByTestId("agents-list-search")).toBeFocused();
  const list = settings.getByTestId("agents-list");
  await expect(list.locator('[data-client="claude-code"]')).toHaveCount(0);
  await expect(list.locator('[data-client="other"]')).toBeVisible();
  await expect(another).toHaveCount(0);
  await shot(window, "ai-claude-another-en-1440");
  await closeSettings(window);

  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    await setWindowSize(app as ElectronApplication, window, 900, 560);
    await window
      .getByRole("button", { name: language === "en" ? "Settings" : "设置", exact: true })
      .click();
    const narrow = await showSettingsPage(window, "ai");
    await expect(narrow.getByTestId("agent-pairing")).toBeInViewport();
    const fits = await narrow
      .getByTestId("settings-page-ai")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    expect(fits, language).toBe(true);
    await shot(window, `ai-claude-${language}-900x560`);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("settings")).toBeHidden();
  }
});

// protects=a User who turned connecting off keeps the switch, off, with their connected agent, and it stays while Settings is open after they turn it on, then goes; nothing turns it on for them; fails_when=the switch is hidden while connecting is off, it vanishes under the pointer, or connecting is on before they turn it on
test("connecting turned off: the switch stays, off, until the User turns it on", async () => {
  const window = await launch();
  await connectClaudeCode(window);
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setAgentsEnabled(false),
  );
  const settings = await openSettings(window, "ai");
  const enabled = settings.getByTestId("agents-enabled");
  await expect(enabled).not.toBeChecked();
  await expect(settings.getByTestId("agents-connected")).toContainText(
    "Off: no agent can reach your Documents.",
  );
  await expect(settings.getByTestId("agent-pairing")).toBeVisible();
  await shot(window, "ai-claude-off-en-1440");
  await enabled.click();
  await expect(enabled).toBeChecked();
  expect(
    await window.evaluate(
      async () =>
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getAgents())
          .enabled,
    ),
  ).toBe(true);
  await closeSettings(window);
  await openSettings(window, "ai");
  await expect(window.getByTestId("agents-enabled")).toHaveCount(0);
});

// protects=with Claude Code connected and a model set up, Your AI still leads, then every job, Accounts and keys and Limits with the cap, with no quiet row; the sorting picker names the model ("Use Claude Haiku 5.5"), not "your AI"; General's cap link shows; fails_when=the model's sections come first, the quiet row shows, a job is missing, or the picker says "your AI model"
test("Claude Code connected and a model: Your AI first, then every job, Accounts and keys and Limits", async () => {
  const window = await launch();
  await connectClaudeCode(window);
  await setUpModel(window);
  const settings = await openSettings(window, "ai");
  expect(await nav(settings)).toEqual([
    "general",
    "ai",
    "meetings",
    "connectors",
    "skills",
    "privacy",
  ]);
  expect(await order(settings, PARTS)).toEqual([
    "agents-connected",
    "ai-jobs",
    "your-providers",
    "ai-limits",
  ]);
  await expect(settings.getByTestId("ai-use-model")).toHaveCount(0);
  for (const row of MODEL_ROWS.slice(0, 2))
    await expect(settings.getByTestId(row), row).toBeVisible();
  await expect(settings.getByTestId("check-writes-settings")).toContainText(
    "Check what the assistant and your own AI write",
  );
  await expect(settings.getByTestId("models-sorting").locator("option")).toContainText([
    "Use Claude Haiku 5.5",
  ]);
  await expect(settings.getByTestId("models-sorting")).not.toContainText("your AI model");
  await expect(settings.getByTestId("spending-cap-settings")).toBeVisible();
  await shot(window, "ai-claude-model-en-1440");
  await showSettingsPage(window, "general");
  await expect(settings.getByTestId("spending-cap-moved")).toBeVisible();
});

// protects=with a model and nothing connected, Your AI is its line and Connect an agent…, folded, which unfolds the list; fails_when=the list of agents is open above the model's sections or the line is missing
test("a model only: Your AI is one line and Connect an agent…", async () => {
  const window = await launch();
  await setUpModel(window);
  const settings = await openSettings(window, "ai");
  expect(await order(settings, PARTS)).toEqual([
    "ai-lede",
    "agents-connected",
    "ai-jobs",
    "your-providers",
    "ai-limits",
  ]);
  await expect(settings.getByTestId("agents-list")).toHaveCount(0);
  const connect = settings.getByTestId("agents-connect-another");
  await expect(connect).toHaveText("Connect an agent…");
  await connect.click();
  await expect(
    settings.getByTestId("agents-list").locator('[data-client="claude-code"]'),
  ).toBeVisible();
  await shot(window, "ai-model-en-1440");
});

// protects=a failed read of the agents leaves the rest of Settings › AI on screen, Your AI saying so with Try again, and a Try again still waiting keeps the page and the line until the read lands, then the agents show; fails_when=the page goes blank on the failure or while Try again waits, or the line stays after the read succeeds
test("agents that can't be read: Your AI says so with Try again, and the page stays while it waits", async () => {
  const window = await launch();
  await connectClaudeCode(window);
  await controlReads(app as ElectronApplication, "core:getAgents", { failNext: 1 });
  const settings = await openSettings(window, "ai");
  const failed = settings.getByTestId("agents-read-failed");
  await expect(failed).toContainText("Couldn’t read your AI’s connections");
  await expect(settings.getByTestId("ai-use-model-open")).toBeVisible();
  await expect(settings.getByTestId("ai-jobs")).toBeVisible();
  await expect(settings.getByTestId("ai-limits")).toBeVisible();

  await controlReads(app as ElectronApplication, "core:getAgents", { hold: 1 });
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(failed).toBeVisible();
  await expect(settings.getByTestId("ai-use-model-open")).toBeVisible();
  await expect(settings.getByTestId("ai-jobs")).toBeVisible();

  await controlReads(app as ElectronApplication, "core:getAgents", { settle: "resolve" });
  await expect(failed).toHaveCount(0);
  await expect(settings.getByTestId("agent-pairing")).toHaveAttribute("data-name", "Claude Code");
});
