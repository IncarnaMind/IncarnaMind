import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { ALL_SHARED_ID, type CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { translate } from "../src/shared/i18n";
import { installAgent } from "../tests/helpers/agentInstalls";
import {
  acceptPlainTextKeys,
  agentsToConnect,
  catchCopies,
  controlReads,
  copied,
  createDataFolder,
  expectHomeInFront,
  frontMind,
  interceptOpenExternal,
  interceptOpenPath,
  launchApp,
  motionSettled,
  openExample,
  openSettings,
  removeDataFolder,
  setWindowSize,
  showSettingsPage,
  urlsOpened,
  useLocalChatModel,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Agents are hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * The setup's Your AI step offers the AI the User already has before a model in IncarnaMind
 * (#3362): an agent connects inside the step as Settings › AI connects it, Sorting waits for a
 * model, and Get started follows the agent: add Documents, ask it for a document, see what needs a
 * look. A real agent client drives the Tools over the app's own connection. The home folder is a
 * temporary one, where Claude Code is found by its settings file, which connecting it adds to (a
 * copy of the file is kept, and Disconnect takes both away), and copying is caught in the page. Set INCARNAMIND_SCREENSHOTS to a folder to save the stills in four looks and two widths.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const STAND_INS = { fakeChat: true, ollama: "http://127.0.0.1:9", decisions: "http://127.0.0.1:9" };
const LOOKS = [
  ["en", "light"],
  ["zh-CN", "light"],
  ["en", "dark"],
  ["zh-CN", "dark"],
] as const;
const WIDTHS = [1280, 900] as const;

/** A made-up OpenRouter key, in its form: the test build checks it with the scripted model. */
const OPENROUTER_KEY = `sk-or-v1-${"0f9a".repeat(16)}`;

const HARBOUR = [
  "# Harbour report 2025",
  "",
  "The Port of Wenlow handled 1.8 million tonnes of cargo in 2025.",
  "",
  "Ferry crossings to Ardmore Island rose to 4,200 in 2025.",
].join("\n");
const AGENT_LINE = "Write a short summary of “Harbour report 2025” as a new note in IncarnaMind.";
const CARGO = "The port handled 1.8 million tonnes of cargo in 2025";
const FERRY = "Ferry crossings to Ardmore Island fell to 3,100 in 2025";

let dataDir: string;
let home: string;
let sources: string;
let apps: string;
let app: ElectronApplication | null = null;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  sources = await realpath(await createDataFolder());
  apps = await realpath(await createDataFolder());
  // Claude Code's command, so the step lists it first as found on this computer, and the settings
  // file it keeps.
  await installAgent("claude-code", { applications: apps, commands: apps, home }, "command");
  await writeFile(join(home, ".claude.json"), "{}\n");
});
test.afterEach(async () => {
  await app?.close();
  app = null;
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(sources);
  await removeDataFolder(apps);
});

const core = (window: Page) => ({
  settings: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings(),
    ),
  agents: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getAgents(),
    ),
  look: (language: "en" | "zh-CN", appearance: "light" | "dark") =>
    window.evaluate(
      (look) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: look.language },
          device: { appearance: look.appearance },
        }),
      { language, appearance },
    ),
  add: (path: string) =>
    window.evaluate(
      (file) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addDocuments([file]),
      path,
    ),
  launchOf: (pairingId: string) =>
    window.evaluate(
      (id) => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getAgentLaunch(id),
      pairingId,
    ),
});

async function launch(width = 1280) {
  const launched = await launchApp(dataDir, {
    ...STAND_INS,
    firstRunSetup: true,
    home,
    agentApps: [apps],
  });
  app = launched.app;
  // Connecting Claude's app or Cursor opens them: here nothing of this computer's opens.
  await interceptOpenPath(launched.app);
  await interceptOpenExternal(launched.app);
  await setWindowSize(launched.app, launched.window, width, 900);
  await acceptPlainTextKeys(launched.window);
  await catchCopies(launched.window);
  return launched.window;
}

const panelOf = (window: Page) => window.getByTestId("setup-panel");

async function atStep(window: Page, step: string): Promise<Locator> {
  const panel = panelOf(window);
  await expect(panel).toHaveAttribute("data-step", step);
  return panel;
}

/** The window in each look and width, saved under `name`, then back to English, light, 1280 px. */
async function stills(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS || !app) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  for (const [language, appearance] of LOOKS) {
    await core(window).look(language, appearance);
    for (const width of WIDTHS) {
      await setWindowSize(app, window, width, 900);
      const fits = await window.evaluate(
        () => document.documentElement.scrollWidth <= globalThis.innerWidth,
      );
      expect(fits, `${name} ${language} ${appearance} ${width}`).toBe(true);
      await motionSettled(window);
      await window.screenshot({
        path: join(SCREENSHOTS, `${name}-${language}-${appearance}-${width}.png`),
      });
    }
  }
  await core(window).look("en", "light");
  await setWindowSize(app, window, 1280, 900);
}

/** What each link opening Claude Code would have typed there, as the app recorded them. */
async function typedInClaudeCode(): Promise<string[]> {
  const links = await urlsOpened(app as ElectronApplication);
  return links
    .filter((link) => link.startsWith("claude-cli://"))
    .map((link) => new URL(link).searchParams.get("q") ?? "");
}

/** The agent's client, started as the agent starts IncarnaMind's server. */
async function agentOf(window: Page, pairingId: string): Promise<Client> {
  const launch = await core(window).launchOf(pairingId);
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(
    new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      env: launch.env,
      stderr: "pipe",
    }),
  );
  return agent;
}

const structured = <T>(result: unknown): T => {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
};

async function cite(agent: Client, query: string, quote: string): Promise<string> {
  const { passages } = structured<{ passages: { passageId: string }[] }>(
    await agent.callTool({ name: "search", arguments: { query } }),
  );
  const { citations } = structured<{ citations: { cite: string | null }[] }>(
    await agent.callTool({
      name: "cite",
      arguments: { citations: passages.map(({ passageId }) => ({ passageId, quote })) },
    }),
  );
  const found = citations.find((each) => each.cite !== null)?.cite;
  if (!found) throw new Error(`No Passage holds “${quote}”.`);
  return found;
}

/** The agent's way through the Your AI step: Claude Code, with what it reads and may write. */
async function connectClaudeCode(window: Page, ai: Locator): Promise<void> {
  const claudeCode = ai.locator('[data-testid="setup-agent"][data-value="claude-code"] input');
  await claudeCode.press("Space");
  const connect = ai.getByTestId("setup-agent-connect");
  await expect(connect).toBeVisible();
  // Keyboard alone reaches the press that connects it.
  const allow = connect.getByTestId("setup-agent-allow");
  for (
    let presses = 0;
    presses < 20 && !(await allow.evaluate((b) => b === document.activeElement));
    presses++
  )
    await window.keyboard.press("Tab");
  await expect(allow).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(ai.getByTestId("setup-agent-connected")).toHaveText("Claude Code is connected");
}

// protects=a fresh profile's Your AI step offers the User's own AI first, Claude Code connects inside the step with the lines Settings shows, Meetings follows the AI connection, the card follows the agent with no key asked for, and Settings › AI lists the agent as one connected there and disconnects it; fails_when=the step asks for a key first, connecting leaves the step or needs a Document, Sorting shows with no model, the card asks for a key, or Settings shows another agent than the one connected
test("connecting the AI the User has in the step: no key, sorting on request, the agent's card, and Settings lists it", async () => {
  test.setTimeout(180_000);
  const window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  const ai = await atStep(window, "ai");
  // The AI they have leads; a model in IncarnaMind is one quiet line, closed (#3537).
  await expect(ai.getByRole("heading", { level: 2 })).toHaveText(["Use the AI you already have"]);
  const agents = ai.getByTestId("setup-agent");
  const claudeCode = ai.locator('[data-testid="setup-agent"][data-value="claude-code"]');
  // The chat apps first, then the coding tools, the one found on this computer ahead of the
  // others; Other agent last.
  await expect(claudeCode).toContainText("On this computer");
  const order = await agents.evaluateAll((rows) =>
    rows.map((row) => [
      row.getAttribute("data-value"),
      row.textContent?.includes("On this computer"),
    ]),
  );
  expect(order.slice(0, 3).map(([value]) => value)).toEqual([
    "claude-desktop",
    "codex",
    "claude-code",
  ]);
  expect(order.slice(3, -1).some(([, found]) => found)).toBe(false);
  await expect(agents.last()).toHaveAttribute("data-value", "other");
  await expect(agents.first().locator("input")).toBeFocused();
  const inApp = ai.getByTestId("setup-in-app-open");
  await expect(inApp).toHaveText("Use a model in IncarnaMind");
  for (const behind of ["setup-key", "setup-way-chatgpt", "setup-way-more", "setup-way-local"]) {
    await expect(ai.getByTestId(behind), behind).toHaveCount(0);
  }
  await expect(ai.getByTestId("setup-next")).toBeDisabled();
  await stills(window, "1-your-ai");
  // Pressed, it opens in place with the key field and the other ways, still the one step.
  await inApp.click();
  await expect(ai.getByRole("heading", { level: 2 })).toHaveText([
    "Use the AI you already have",
    "Use a model in IncarnaMind",
  ]);
  // The key field takes the focus, as a person who pressed it means to paste one.
  await expect(ai.getByTestId("setup-key")).toBeFocused();
  await expect(ai.getByTestId("setup-way-more")).toBeVisible();
  await expect(ai.getByTestId("setup-next")).toBeDisabled();
  await expect(panelOf(window)).toHaveAttribute("data-step", "ai");
  await stills(window, "1b-your-ai-model-open");

  // Chosen: the three lines of the connect dialog, with all of the User's Documents and notes as
  // what it reads, those to come too (#3544), the rest under Details, and Allow and connect in
  // view at both widths.
  await claudeCode.locator("input").press("Space");
  const connect = ai.getByTestId("setup-agent-connect");
  await expect(connect).toContainText("Let Claude Code read your Documents?");
  await expect(connect.getByTestId("connect-agent-reads")).toHaveText(
    translate("en", "agents.connect.reads.all", { agent: "Claude Code" }),
  );
  await expect(connect.getByTestId("agent-folder-row")).toHaveCount(0);
  await expect(connect.getByTestId("agent-propose")).toBeChecked();
  await expect(connect.getByTestId("connect-agent-disconnect")).toHaveText(
    "You can disconnect it at any time.",
  );
  const details = connect.getByTestId("connect-agent-details");
  await expect(details).not.toHaveAttribute("open", "");
  await expect(details).toContainText(
    translate("en", "agents.connect.body", { agent: "Claude Code" }),
  );
  await expect(details.getByTestId("connect-agent-skill")).toBeHidden();
  for (const width of WIDTHS) {
    await setWindowSize(app as ElectronApplication, window, width, 900);
    await expect(connect.getByTestId("setup-agent-allow")).toBeInViewport({ ratio: 1 });
  }
  await setWindowSize(app as ElectronApplication, window, 1280, 900);
  // Nothing is connected before the press, and the file is as it was.
  expect((await core(window).agents()).pairings).toEqual([]);
  expect(await readFile(join(home, ".claude.json"), "utf8")).toBe("{}\n");
  await stills(window, "2-your-ai-agent-chosen");
  await details.locator("summary").first().click();
  await expect(details.getByTestId("connect-agent-skill")).toBeVisible();
  await expect(details.getByTestId("connect-agent-backup")).toBeVisible();
  await stills(window, "2b-your-ai-agent-details");
  await details.locator("summary").first().click();

  await connectClaudeCode(window, ai);
  await expect(ai.getByTestId("setup-agent-done")).toContainText(
    "Added to the settings of Claude Code. Start a new session in Claude Code to use it.",
  );
  // Added to Claude Code's own file, beside what was there, with a copy of the file as it was.
  const settings = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  expect(settings.mcpServers.incarnamind).toMatchObject({ type: "stdio" });
  expect(await readFile(join(home, ".claude.json.incarnamind-backup"), "utf8")).toBe("{}\n");
  await expect(ai.getByTestId("setup-next")).toBeEnabled();
  await stills(window, "3-your-ai-connected");

  await ai.getByTestId("setup-next").click();
  const meetings = await atStep(window, "meetings");
  await expect(meetings.getByTestId("setup-progress-step")).toHaveText([
    "Your work",
    "Your AI",
    "Meetings",
  ]);
  await expect(meetings.getByTestId("setup-meetings-needs-model")).toHaveText(
    "Notes after a call and help during it need a model in IncarnaMind.",
  );
  await meetings.getByTestId("setup-back").click();
  await (await atStep(window, "ai")).getByTestId("setup-next").click();
  await (await atStep(window, "meetings")).getByTestId("setup-skip").click();
  await expect(panelOf(window)).toHaveCount(0);
  await expectHomeInFront(window);
  await openExample(window);

  // Get started follows the agent, and nothing on it asks for a key.
  const card = window.getByTestId("first-open-steps");
  await expect(card.getByTestId("first-open-step")).toHaveText([
    /Add your Documents/,
    /Ask your AI for a document/,
    /See what needs a look/,
  ]);
  await expect(card).not.toContainText(/key|Choose a model/i);
  await expect(card.getByTestId("first-open-set")).toContainText(
    "Your AI: Claude Code · Sorting: not set",
  );

  // Settings › AI lists it as one connected there, and disconnects it.
  await card.getByTestId("first-open-set-change").click();
  const models = await showSettingsPage(window, "ai");
  await expect(models.getByTestId("model-default-row-sorting")).toContainText(
    "Ask your connected AI to suggest Folders and Tags.",
  );
  // With only their own AI connected, Settings › AI leads with it, a model in IncarnaMind is one
  // quiet row, and what is for the built-in assistant is held back: no Connectors, no Skills, here
  // or in ⌘K (#3537, #3645).
  await expect(models.getByTestId("agents-connected")).toContainText("Your AI");
  await expect(models.getByTestId("agent-pairing")).toHaveAttribute("data-name", "Claude Code");
  await expect(models.getByTestId("ai-use-model")).toContainText("Use a model in IncarnaMind…");
  const listed = await models
    .locator('[data-testid^="settings-nav-"]')
    .evaluateAll((all) =>
      all.map((each) => each.getAttribute("data-testid")?.replace("settings-nav-", "")),
    );
  expect(listed).toEqual(["general", "ai", "meetings", "privacy"]);
  await expect(window.getByTestId("settings-nav-connectors")).toHaveCount(0);
  await expect(window.getByTestId("settings-nav-skills")).toHaveCount(0);
  await expect(window.getByTestId("settings-page-connectors")).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("settings")).toBeHidden();
  await window.keyboard.press("ControlOrMeta+k");
  await window.getByTestId("palette-search").fill("Settings");
  await expect(window.locator('[data-key="command:settings.privacy"]')).toBeVisible();
  await expect(window.locator('[data-key="command:settings.connectors"]')).toHaveCount(0);
  await expect(window.locator('[data-key="command:settings.skills"]')).toHaveCount(0);
  await window.keyboard.press("Escape");
  const page = await openSettings(window, "ai");
  // Connecting is on, as connecting turned it on: there is no switch to show.
  await expect(page.getByTestId("agents-enabled")).toHaveCount(0);
  const row = page.locator('[data-testid="agent-pairing"][data-name="Claude Code"]');
  await expect(row.getByTestId("agent-pairing-reads")).toHaveText(
    "Reads all your Documents and notes, and what you add later",
  );
  await expect(row.getByTestId("agent-pairing-proposes")).toHaveText(
    "Writes notes, Canvases and files there; proposes changes to yours",
  );
  await row.getByTestId("agent-disconnect").click();
  await expect(page.getByTestId("agent-pairing")).toHaveCount(0);
  expect((await core(window).agents()).pairings).toEqual([]);
  // Exactly what was added is gone: the file is as it was, and so is its copy.
  await expect.poll(() => readFile(join(home, ".claude.json"), "utf8")).toBe("{}\n");
  await expect(stat(join(home, ".claude.json.incarnamind-backup"))).rejects.toThrow(/ENOENT/);
});

// protects=the step works on a cold start where the agents on this computer can't be listed: it says so where the agents would be, with Try again, and a model is set up as before; fails_when=the step, or its Back and Set up later, is missing, or the problem has no way to try again
test("agents that can't be listed: the step says so in their place, and a model still sets up", async () => {
  const window = await launch();
  await atStep(window, "work");
  await controlReads(app as ElectronApplication, "core:listAgentClients", { failing: true });
  await window.reload();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  const ai = await atStep(window, "ai");
  await expect(ai.getByRole("heading", { level: 2 })).toHaveText(["Use the AI you already have"]);
  await expect(ai.getByTestId("setup-in-app-open")).toBeVisible();
  const problem = ai.getByTestId("setup-agents-problem");
  await expect(problem).toContainText("Couldn\u2019t list the agents on this computer");
  await expect(ai.getByTestId("setup-agent")).toHaveCount(0);
  await expect(ai.getByTestId("setup-back")).toBeVisible();
  await expect(ai.getByTestId("setup-skip")).toBeVisible();
  await stills(window, "7-agents-unlisted");

  await controlReads(app as ElectronApplication, "core:listAgentClients", { failing: false });
  await problem.getByTestId("setup-agents-problem-retry").press("Enter");
  await expect(ai.locator('[data-testid="setup-agent"][data-value="claude-code"]')).toBeVisible();
  await expect(problem).toHaveCount(0);
  await expect(ai.getByTestId("setup-agent").first().locator("input")).toBeFocused();

  await useLocalChatModel(window);
  await expect(ai.getByTestId("setup-ai-works")).toBeVisible();
  await expect(ai.getByTestId("setup-next")).toBeEnabled();
});

/** Skips each step left, until the setup has ended. */
async function skipTheRest(window: Page): Promise<void> {
  const panel = panelOf(window);
  while ((await panel.count()) > 0) {
    const step = await panel.getAttribute("data-step");
    await panel.getByTestId("setup-skip").click();
    await expect(window.locator(`[data-testid="setup-panel"][data-step="${step}"]`)).toHaveCount(0);
  }
}

// protects=a long list of agents stays easy to choose from: those on this computer first, then the most used, any other found by typing its name, by keyboard, in the setup and in Settings › AI alike; fails_when=every agent shows at once, a found agent isn't first, typing a name or one it went by doesn't find it, or the keyboard can't reach the search or the agent found
test("the agents found here come first, and any other is found by typing, in the step and in Settings", async () => {
  test.setTimeout(240_000);
  // Zed and Qwen Code installed beside Claude Code, in the test's own folders.
  await installAgent("zed", { applications: apps, commands: apps, home });
  await installAgent("qwen-code", { applications: apps, commands: apps, home }, "command");
  const window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  const ai = await atStep(window, "ai");
  const agents = ai.getByTestId("setup-agent");
  const listed = () =>
    agents.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-value")));
  // The chat apps first, then the coding tools, those found here ahead of the rest.
  expect(await listed()).toEqual([
    "claude-desktop",
    "codex",
    "claude-code",
    "zed",
    "qwen-code",
    "cursor",
    "vscode",
    "other",
  ]);
  await expect(ai.getByTestId("setup-agents-search")).toHaveAttribute(
    "placeholder",
    "Search 20 agents",
  );
  await stills(window, "8-agents-step");

  // From the first agent, the search is one Shift+Tab away; a name it went by finds it.
  await agents.first().locator("input").focus();
  await window.keyboard.press("Shift+Tab");
  const search = ai.getByTestId("setup-agents-search");
  await expect(search).toBeFocused();
  await window.keyboard.type("windsurf");
  await expect.poll(listed).toEqual(["devin", "other"]);
  await stills(window, "8-agents-step-typed");
  await search.focus();
  await window.keyboard.press("Tab");
  await expect(agents.first().locator("input")).toBeFocused();
  await window.keyboard.press("Space");
  await expect(ai.getByTestId("setup-agent-connect")).toContainText(
    "Let Devin Desktop read your Documents?",
  );
  // A name that isn't listed says so, and leaves Other agent to choose; Esc empties the field.
  await search.fill("goose");
  await expect(ai.getByTestId("setup-agents-none")).toHaveText(
    "No agent matches “goose”. Choose Other agent to connect it.",
  );
  await expect.poll(listed).toEqual(["other"]);
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(panelOf(window)).toHaveAttribute("data-step", "ai");
  await expect.poll(listed).toHaveLength(8);

  await skipTheRest(window);
  await openExample(window);
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setAgentsEnabled(true),
  );
  await window.getByTestId("first-open-set-change").click();
  const page = await showSettingsPage(window, "ai");
  const list = await agentsToConnect(page);
  const rows = () =>
    list
      .getByTestId("agent-client")
      .evaluateAll((each) => each.map((row) => row.getAttribute("data-client")));
  await expect(list.getByTestId("agent-client")).toHaveCount(8);
  // The chat apps first, then the coding tools found on this computer.
  expect((await rows()).slice(0, 5)).toEqual([
    "claude-desktop",
    "codex",
    "claude-code",
    "zed",
    "qwen-code",
  ]);
  await expect(list.locator('[data-client="qwen-code"]')).toContainText(
    "Copy one line to run in a terminal",
  );
  await stills(window, "8-agents-settings");
  await page.getByTestId("agents-list-search").fill("kimi");
  await expect.poll(rows).toEqual(["kimi-code", "other"]);
  await expect(list.locator('[data-client="kimi-code"]')).toContainText(
    "IncarnaMind adds itself to the settings of Kimi Code",
  );
  await stills(window, "8-agents-settings-typed");
});

// protects=a Note the agent writes ticks the card's second step, and once the agent's check lands the third opens the Note at its first mark that needs a look; fails_when=the step ticks on a Note the agent didn't write, before its check lands, or opens the Note anywhere but at its mark
test("the agent's Note ticks the second step, and its check opens the Note at what needs a look", async () => {
  test.setTimeout(240_000);
  const window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  await connectClaudeCode(window, await atStep(window, "ai"));
  await (await atStep(window, "ai")).getByTestId("setup-next").click();
  await (await atStep(window, "meetings")).getByTestId("setup-skip").click();
  await openExample(window);
  const card = window.getByTestId("first-open-steps");
  const step = (name: string) =>
    card.locator(`[data-testid="first-open-step"][data-step="${name}"]`);
  await expect(step("files")).toHaveAttribute("data-state", "open");
  await stills(window, "4-card-agent-none-done");

  const path = join(sources, "Harbour report 2025.md");
  await writeFile(path, `${HARBOUR}\n`);
  await core(window).add(path);
  await expect(step("files")).toHaveAttribute("data-state", "done");
  await expect(step("agentAsk")).toHaveAttribute("data-state", "open");
  await expect(card.getByTestId("first-open-agent-line")).toHaveText(AGENT_LINE);
  await expect(step("agentAsk")).not.toContainText("Paste this into");
  await stills(window, "4b-card-agent-ask-opens");
  // One press opens Claude Code with the line typed, and copies nothing; until the Note comes the
  // step says the request is to be sent there, then that it is being written (#3587).
  await card.getByTestId("first-open-agent-ask").click();
  await expect.poll(typedInClaudeCode).toEqual([AGENT_LINE]);
  await expect(window.getByTestId("copied-line")).toHaveText(
    "Opened Claude Code with your request typed. Send it there.",
  );
  expect(await copied(window)).toBe("");
  const asked = card.getByTestId("first-open-agent-asked");
  await expect(asked).toHaveText("Asked Claude Code: send the request there.");
  await expect(card.getByTestId("first-open-agent-ask")).toHaveText("Ask again");
  await stills(window, "4e-card-agent-asked");
  // A Note of the User's own isn't the agent's.
  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.createMind({
      title: "My own plans",
    }),
  );
  await expect(step("agentAsk")).toHaveAttribute("data-state", "open");

  const [pairing] = (await core(window).agents()).pairings;
  if (!pairing) throw new Error("The agent wasn't connected.");
  const agent = await agentOf(window, pairing.id);
  try {
    const cargo = await cite(
      agent,
      "cargo tonnes",
      "The Port of Wenlow handled 1.8 million tonnes of cargo in 2025.",
    );
    await expect(asked).toHaveText("Writing the note in Claude Code.");
    await stills(window, "4f-card-agent-writing");
    const ferry = await cite(
      agent,
      "ferry crossings Ardmore",
      "Ferry crossings to Ardmore Island rose to 4,200 in 2025.",
    );
    const made = structured<{ mindId: string; folder: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Harbour summary",
          markdown: `${CARGO} ${cargo}.\n\n${FERRY} ${ferry}.`,
        },
      }),
    );
    expect(made.folder).toBe("");
    await expect(step("agentAsk")).toHaveAttribute("data-state", "done");
    // A copy of it is the User's: the card still follows the agent's own Note.
    await window.evaluate(
      (mindId) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.duplicateMind(mindId),
      made.mindId,
    );
    await expect(step("agentAsk")).toHaveText(/Your AI wrote a note/);
    await expect(card.getByTestId("first-open-agent-look")).toHaveText(
      "What needs a look shows here once the note is checked.",
    );
    // The step is the User's own Check on the Note; the Note opens from the step once it is checked.
    await expect(card.getByTestId("first-open-agent-look-open")).toHaveCount(0);
    await stills(window, "5-card-agent-second-done");

    // With no model set up, the Note's own Check asks Claude Code at once, as it does from the
    // Note, and the Note's badge says so until the marks land (#3587).
    await card.getByTestId("first-open-agent-look-check").click();
    await expect(frontMind(window)).toHaveAttribute("data-mind-id", made.mindId);
    await expect
      .poll(typedInClaudeCode)
      .toEqual([
        AGENT_LINE,
        "Check my note “Harbour summary” in IncarnaMind against my Documents.",
      ]);
    const badge = window.getByTestId("badge-asked");
    await expect(badge).toHaveText("Asked your AI");

    const given = structured<{ task: string; sentences: { n: number; text: string }[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: made.mindId } }),
    );
    await expect(badge).toHaveText("Your AI is checking");
    const results = given.sentences.map((sentence) =>
      sentence.text.startsWith(CARGO)
        ? { n: sentence.n, verdict: "supported", cites: [cargo] }
        : sentence.text.startsWith(FERRY)
          ? { n: sentence.n, verdict: "contradicted", cites: [ferry] }
          : { n: sentence.n, verdict: "nothing to check" },
    );
    structured(
      await agent.callTool({
        name: "report_check",
        arguments: { mindId: made.mindId, task: given.task, results },
      }),
    );
    await expect(badge).toHaveCount(0);
    // Back at Get started, the step shows what Claude Code's check found.
    await window
      .locator(`[data-testid="mind-tab"]:not([data-mind-id="${made.mindId}"])`)
      .first()
      .click();
    await expect(card.getByTestId("first-open-agent-look")).toHaveText("1 sentence needs a look.");
    await stills(window, "6-card-agent-checked");

    await card.getByTestId("first-open-agent-look-open").click();
    await expect(frontMind(window)).toHaveAttribute("data-mind-id", made.mindId);
    await expect(
      frontMind(window).locator('[data-testid="claim-mark"][data-check="contradicted"]'),
    ).toBeFocused();
    await expect
      .poll(async () => (await core(window).settings()).device.gettingStarted.agentNoteSeen)
      .toBe(true);
  } finally {
    await agent.close();
  }
});

// protects=the card's ask step opens the AI that has a link with the line typed and copies it only for one that has none, the other connected AIs behind its ⌄, in English and Chinese; fails_when=the press copies for an AI that opens, opens nothing for one that does, or the line is another than the card's
test("the step asks the AI with the line typed, and copies it only where the AI has no way to open", async () => {
  test.setTimeout(240_000);
  const window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  await connectClaudeCode(window, await atStep(window, "ai"));
  await (await atStep(window, "ai")).getByTestId("setup-next").click();
  await (await atStep(window, "meetings")).getByTestId("setup-skip").click();
  await openExample(window);
  // VS Code, connected last, has no link that opens it with a line.
  await window.evaluate(async (everything) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setAgentsEnabled(true);
    await bridge.connectAgent({ name: "VS Code", client: "vscode", folderIds: [everything] });
  }, ALL_SHARED_ID);
  const path = join(sources, "Harbour report 2025.md");
  await writeFile(path, `${HARBOUR}\n`);
  await core(window).add(path);

  const card = window.getByTestId("first-open-steps");
  const ask = card.getByTestId("first-open-agent-ask");
  await expect(ask).toHaveText("Ask VS Code");
  await stills(window, "4c-card-agent-ask-copies");
  await ask.click();
  await expect(window.getByTestId("copied-line")).toHaveText("Copied. Paste it into VS Code.");
  expect(await copied(window)).toBe(AGENT_LINE);
  expect(await typedInClaudeCode()).toEqual([]);

  // The other connected AI is one step away, as the Ask pill offers it.
  await card.getByTestId("first-open-agent-others").click();
  const other = window.getByTestId("first-open-agent-other");
  await expect(other).toHaveText("Ask Claude Code");
  await other.click();
  await expect.poll(typedInClaudeCode).toEqual([AGENT_LINE]);
  await expect(window.getByTestId("copied-line")).toHaveText(
    "Opened Claude Code with your request typed. Send it there.",
  );

  // Asked, the AI asked last leads with Ask again; the same press in Chinese carries the card's
  // line in Chinese.
  await core(window).look("zh-CN", "light");
  await expect(ask).toHaveText(translate("zh-CN", "agents.asked.again"));
  await expect(card.getByTestId("first-open-agent-asked")).toHaveText(
    "已交给 Claude Code：在那里发送请求即可。",
  );
  await card.getByTestId("first-open-agent-others").click();
  await expect(window.getByTestId("first-open-agent-other")).toHaveText(
    translate("zh-CN", "agents.ask.action", { agent: "VS Code" }),
  );
  await window.getByTestId("first-open-agent-other").click();
  const line = translate("zh-CN", "firstOpen.agent.line", { document: "“Harbour report 2025”" });
  await expect(window.getByTestId("copied-line")).toHaveText(
    translate("zh-CN", "agents.ask.copied", { agent: "VS Code" }),
  );
  expect(await copied(window)).toBe(line);
  await expect(card.getByTestId("first-open-agent-asked")).toHaveText(
    "已为 VS Code 复制：粘贴到那里并发送请求。",
  );
  await ask.click();
  await expect(window.getByTestId("copied-line")).toHaveText(
    translate("zh-CN", "agents.ask.copied", { agent: "VS Code" }),
  );
  await card.getByTestId("first-open-agent-others").click();
  await window.getByTestId("first-open-agent-other").click();
  await expect.poll(typedInClaudeCode).toEqual([AGENT_LINE, line]);
  await stills(window, "4d-card-agent-ask-picked");
});

// protects=the first-open card offers Ask with only a model, and asks the User to use their agent when both are connected; fails_when=either path shows the other card
test("the first-open card follows the connected agent when both an agent and a model are set up", async () => {
  test.setTimeout(180_000);
  const window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  await atStep(window, "ai");
  await useLocalChatModel(window);
  const ai = await atStep(window, "ai");
  await expect(ai.getByTestId("setup-ai-works")).toBeVisible();
  await ai.getByTestId("setup-next").click();
  await (await atStep(window, "meetings")).getByTestId("setup-skip").click();
  await openExample(window);
  const card = window.getByTestId("first-open-steps");
  await expect(card.getByTestId("first-open-step")).toHaveText([
    /Add your Documents/,
    /Ask/,
    /Check a Citation/,
  ]);
  await stills(window, "7-card-model-only");

  await app?.close();
  app = null;
  await removeDataFolder(dataDir);
  dataDir = await createDataFolder();
  const again = await launch();
  await (await atStep(again, "work")).getByTestId("setup-skip").click();
  await atStep(again, "ai");
  await useLocalChatModel(again);
  await connectClaudeCode(again, await atStep(again, "ai"));
  await (await atStep(again, "ai")).getByTestId("setup-next").click();
  await (await atStep(again, "meetings")).getByTestId("setup-skip").click();
  await openExample(again);
  await expect(again.getByTestId("first-open-steps").getByTestId("first-open-step")).toHaveText([
    /Add your Documents/,
    /Ask your AI for a document/,
    /See what needs a look/,
  ]);
});

// protects=a User with their own AI and no model here can still choose a decision model, its key typed in place, and the step turns nothing more on than it does for a User with a model: the key sorts and is no Answers model; fails_when=the step is hidden, offers to sort with the User's AI, makes the key the Answers model, or the card's foot misreads what sorts
test("with only their own AI, the User chooses a dedicated sorting model later in Settings, and the key sorts and answers nothing", async () => {
  test.setTimeout(180_000);
  const window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  await connectClaudeCode(window, await atStep(window, "ai"));
  await (await atStep(window, "ai")).getByTestId("setup-next").click();
  await (await atStep(window, "meetings")).getByTestId("setup-skip").click();
  await openExample(window);
  await window.getByTestId("first-open-steps").getByTestId("first-open-set-change").click();
  const settings = await showSettingsPage(window, "ai");
  await settings.getByTestId("ai-use-model-open").click();
  await (await atStep(window, "ai")).getByTestId("setup-next").click();
  const sorting = await atStep(window, "sorting");
  await expect(sorting.getByTestId("setup-decision-host")).toHaveValue("openrouter");
  await sorting.getByTestId("setup-decision-key").fill(OPENROUTER_KEY);
  await stills(window, "3c-sorting-agent-only-key");
  await sorting.getByTestId("setup-next").click();
  await (await atStep(window, "meetings")).getByTestId("setup-skip").click();
  await expect(panelOf(window)).toHaveCount(0);
  await window.keyboard.press("Escape");

  const read = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [settings, library, providers] = await Promise.all([
      bridge.getSettings(),
      bridge.getLibrary(),
      bridge.listChatProviders(),
    ]);
    return {
      chatModel: settings.user.chatModel,
      classifier: library.settings.classifier,
      automatic: library.settings.automatic,
      providers: providers.map((each) => each.catalogId),
    };
  });
  // Kept for sorting alone, as it would be for a User with a model: no Answers model came of it.
  expect(read).toMatchObject({
    chatModel: null,
    classifier: { kind: "decision", host: "openrouter" },
    automatic: false,
    providers: ["openrouter"],
  });
  const foot = window.getByTestId("first-open-steps").getByTestId("first-open-set");
  await expect(foot).toContainText(/^Your AI: Claude Code · Sorting: (?!not set)/);

  // The foot reads a model on this computer, and nothing set, as it does for every User.
  const sortWith = (classifier: unknown) =>
    window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const { settings } = await bridge.getLibrary();
      await bridge.saveLibrarySettings({ ...settings, classifier: chosen } as typeof settings);
    }, classifier);
  await sortWith({ kind: "auto", baseUrl: "http://127.0.0.1:9" });
  await expect(foot).toContainText("Sorting: on this computer");
  await sortWith({ kind: "automatic" });
  await expect(foot).toContainText("Sorting: not set");
});
