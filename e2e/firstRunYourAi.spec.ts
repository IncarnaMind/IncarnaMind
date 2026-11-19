import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { translate } from "../src/shared/i18n";
import {
  acceptPlainTextKeys,
  catchCopies,
  copied,
  createDataFolder,
  frontMind,
  interceptOpenExternal,
  interceptOpenPath,
  launchApp,
  motionSettled,
  removeDataFolder,
  setWindowSize,
  showSettingsPage,
  useLocalChatModel,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Agents are hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * The setup's Your AI step offers the AI the User already has before a model in IncarnaMind
 * (#3362): an agent connects inside the step as Settings › Agents connects it, Sorting waits for a
 * model, and Get started follows the agent: add Documents, ask it for a document, see what needs a
 * look. A real agent client drives the Tools over the app's own connection. The home folder is a
 * temporary one, where Claude Code is found by its settings file, and copying is caught in the
 * page. Set INCARNAMIND_SCREENSHOTS to a folder to save the stills in four looks and two widths.
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

const HARBOUR = [
  "# Harbour report 2025",
  "",
  "The Port of Wenlow handled 1.8 million tonnes of cargo in 2025.",
  "",
  "Ferry crossings to Ardmore Island rose to 4,200 in 2025.",
].join("\n");
const CARGO = "The port handled 1.8 million tonnes of cargo in 2025";
const FERRY = "Ferry crossings to Ardmore Island fell to 3,100 in 2025";

let dataDir: string;
let home: string;
let sources: string;
let app: ElectronApplication | null = null;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await realpath(await createDataFolder());
  sources = await realpath(await createDataFolder());
  // Claude Code keeps its settings here: the step lists it first, as found on this computer.
  await writeFile(join(home, ".claude.json"), "{}\n");
});
test.afterEach(async () => {
  await app?.close();
  app = null;
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(sources);
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
  const launched = await launchApp(dataDir, { ...STAND_INS, firstRunSetup: true, home });
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

// protects=a fresh profile's Your AI step offers the User's own AI first, Claude Code connects inside the step with the lines Settings shows, Sorting waits for a model, the card follows the agent with no key asked for, and Settings › Agents lists the agent as one connected there and disconnects it; fails_when=the step asks for a key first, connecting leaves the step or needs a Document, Sorting shows with no model, the card asks for a key, or Settings shows another agent than the one connected
test("connecting the AI the User has in the step: no key, no Sorting, the agent's card, and Settings lists it", async () => {
  test.setTimeout(180_000);
  const window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  const ai = await atStep(window, "ai");
  await expect(ai.getByRole("heading", { level: 2 })).toHaveText([
    "Use the AI you already have",
    "Use a model in IncarnaMind",
  ]);
  const agents = ai.getByTestId("setup-agent");
  const claudeCode = ai.locator('[data-testid="setup-agent"][data-value="claude-code"]');
  // Found on this computer, so listed before every agent that isn't; Other agent last.
  await expect(claudeCode).toContainText("On this computer");
  const order = await agents.evaluateAll((rows) =>
    rows.map((row) => [
      row.getAttribute("data-value"),
      row.textContent?.includes("On this computer"),
    ]),
  );
  expect(order.findIndex(([, found]) => !found)).toBeGreaterThan(
    order.findIndex(([value]) => value === "claude-code"),
  );
  await expect(agents.last()).toHaveAttribute("data-value", "other");
  await expect(agents.first().locator("input")).toBeFocused();
  await expect(ai.getByTestId("setup-key")).toBeVisible();
  await expect(ai.getByTestId("setup-next")).toBeDisabled();
  await stills(window, "1-your-ai");

  // Chosen: the connect dialog's lines, with nothing to read yet but the Documents to come.
  await claudeCode.locator("input").press("Space");
  const connect = ai.getByTestId("setup-agent-connect");
  await expect(connect).toContainText("Let Claude Code read your Documents?");
  await expect(connect).toContainText(
    translate("en", "agents.connect.body", { agent: "Claude Code" }),
  );
  await expect(connect.getByTestId("agent-folder-row")).toHaveText([/Not in a Folder/]);
  await expect(connect.getByTestId("agent-folder")).toBeChecked();
  await expect(connect.getByTestId("agent-folders-all-unfiled")).toHaveText(
    "No Documents yet: it reads those added outside a Folder.",
  );
  await expect(connect.getByTestId("agent-propose")).toBeChecked();
  await expect(connect.getByTestId("connect-agent-skill")).toBeVisible();
  // Nothing is connected before the press.
  expect((await core(window).agents()).pairings).toEqual([]);
  await stills(window, "2-your-ai-agent-chosen");

  await connectClaudeCode(window, ai);
  await expect(ai.getByTestId("setup-agent-done")).toContainText(
    "Copied. Paste it into a terminal and run it.",
  );
  expect(await copied(window)).toMatch(/^claude mcp add --scope user incarnamind /);
  await expect(ai.getByTestId("setup-next")).toBeEnabled();
  await stills(window, "3-your-ai-connected");

  // No model: Sorting isn't offered, and Meetings says what a model adds.
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

  // Get started follows the agent, and nothing on it asks for a key.
  const card = window.getByTestId("first-open-steps");
  await expect(card.getByTestId("first-open-step")).toHaveText([
    /Add your Documents/,
    /Ask your AI for a document/,
    /See what needs a look/,
  ]);
  await expect(card).not.toContainText(/key|Choose a model/i);
  await expect(card.getByTestId("first-open-set")).toContainText("Your AI: Claude Code");

  // Settings › Agents lists it as one connected there, and disconnects it.
  await card.getByTestId("first-open-set-change").click();
  const page = await showSettingsPage(window, "agents");
  await expect(page.getByTestId("agents-enabled")).toBeChecked();
  const row = page.locator('[data-testid="agent-pairing"][data-name="Claude Code"]');
  await expect(row.getByTestId("agent-pairing-reads")).toHaveText("Reads Not in a Folder");
  await expect(row.getByTestId("agent-pairing-proposes")).toHaveText(
    "Can write notes there; its changes wait for you",
  );
  await row.getByTestId("agent-disconnect").click();
  await expect(page.getByTestId("agent-pairing")).toHaveCount(0);
  expect((await core(window).agents()).pairings).toEqual([]);
});

// protects=a Note the agent writes ticks the card's second step, and once the agent's check lands the third opens the Note at its first mark that needs a look; fails_when=the step ticks on a Note the agent didn't write, before its check lands, or opens the Note anywhere but at its mark
test("the agent's Note ticks the second step, and its check opens the Note at what needs a look", async () => {
  test.setTimeout(240_000);
  const window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  await connectClaudeCode(window, await atStep(window, "ai"));
  await (await atStep(window, "ai")).getByTestId("setup-next").click();
  await (await atStep(window, "meetings")).getByTestId("setup-skip").click();
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
  await expect(card.getByTestId("first-open-agent-line")).toHaveText(
    "Write a summary of my documents as a new note in IncarnaMind, then check it against them.",
  );
  await card.getByTestId("first-open-agent-copy").click();
  expect(await copied(window)).toBe(
    "Write a summary of my documents as a new note in IncarnaMind, then check it against them.",
  );
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
    expect(made.folder).toBe("Not in a Folder");
    await expect(step("agentAsk")).toHaveAttribute("data-state", "done");
    await expect(step("agentAsk")).toHaveText(/Your AI wrote a note/);
    await expect(card.getByTestId("first-open-agent-look")).toHaveText(
      "Its marks show here once Claude Code has checked the note.",
    );
    await expect(card.getByTestId("first-open-agent-look-open")).toHaveCount(0);
    await stills(window, "5-card-agent-second-done");

    const given = structured<{ task: string; sentences: { n: number; text: string }[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: made.mindId } }),
    );
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

// protects=a User who chooses only a model keeps today's setup and card, and one who chooses both gets the agent's card with Sorting still offered; fails_when=the model-only card changes, or a model and an agent together lose Sorting or the agent's card
test("only a model keeps today's card; a model and an agent get the agent's, with Sorting", async () => {
  test.setTimeout(180_000);
  const window = await launch();
  await (await atStep(window, "work")).getByTestId("setup-skip").click();
  await atStep(window, "ai");
  await useLocalChatModel(window);
  const ai = await atStep(window, "ai");
  await expect(ai.getByTestId("setup-ai-works")).toBeVisible();
  await ai.getByTestId("setup-next").click();
  await (await atStep(window, "sorting")).getByTestId("setup-skip").click();
  await (await atStep(window, "meetings")).getByTestId("setup-skip").click();
  const card = window.getByTestId("first-open-steps");
  await expect(card.getByTestId("first-open-step")).toHaveText([
    /Add your Documents/,
    /Ask/,
    /Check a Citation/,
  ]);
  await stills(window, "7-card-model-only");

  // Both: the agent leads, and Sorting stays.
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
  await (await atStep(again, "sorting")).getByTestId("setup-skip").click();
  await (await atStep(again, "meetings")).getByTestId("setup-skip").click();
  await expect(again.getByTestId("first-open-steps").getByTestId("first-open-step")).toHaveText([
    /Add your Documents/,
    /Ask your AI for a document/,
    /See what needs a look/,
  ]);
});
