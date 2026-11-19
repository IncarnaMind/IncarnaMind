import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import type { AgentLaunch, CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  catchCopies,
  copied,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  urlsOpened,
} from "./app";

test.skip(
  !SHOW_AGENT_CONNECTION,
  "Settings › Agents is hidden while SHOW_AGENT_CONNECTION is false.",
);

/*
 * Ask your AI (#3373): a User who connected their own AI and set up no model asks it, from
 * IncarnaMind, to fix a sentence that needs a look, and with what they typed in the chat box; the
 * page above the Note stays bare. Claude Code has a link that opens it with the request typed; VS
 * Code has none, so the request is copied. The app opens nothing here: each link it would open is
 * recorded.
 */

let dataDir: string;
let sources: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
});

const TITLE = "Ferry report for the board";
const CROSSINGS = "Tallow Sound Ferries ran 2,816 crossings in 2025.";
const OVERSTATED = "Fuel cost doubled over the year.";
const BOOKING = "The board approved a new booking system for 2026.";

/** "Tallow Sound Ferries" with its annual summary, read by VS Code and then Claude Code. */
async function connected(window: Page): Promise<AgentLaunch> {
  const summary = join(sources, "Annual summary 2025.md");
  await writeFile(
    summary,
    "# Tallow Sound Ferries: 2025 annual summary\n\nIn 2025 the company ran 2,816 crossings. Fuel cost £310,000 over the year, up from £284,000 in 2024.\n",
  );
  const launch = await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({
      name: "Tallow Sound Ferries",
      description: "",
    });
    await bridge.addDocuments([path], { groupId: folder.id });
    await bridge.setAgentsEnabled(true);
    await bridge.connectAgent({ name: "VS Code", client: "vscode", folderIds: [folder.id] });
    const claudeCode = await bridge.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [folder.id],
      propose: true,
    });
    return claudeCode.launch;
  }, summary);
  await expectReadyDocuments(window, 1);
  return launch;
}

/** The Note Claude Code wrote, its fuel sentence checked by Claude Code itself as overstated. */
async function writtenAndChecked(launch: AgentLaunch): Promise<string> {
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
  try {
    const made = await agent.callTool({
      name: "create_mind",
      arguments: { title: TITLE, markdown: `${CROSSINGS} ${OVERSTATED}\n\n${BOOKING}` },
    });
    const { mindId } = made.structuredContent as { mindId: string };
    const { task, sentences } = (
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } })
    ).structuredContent as { task: string; sentences: { n: number; text: string }[] };
    const fuel = sentences.find((each) => each.text === OVERSTATED);
    await agent.callTool({
      name: "report_check",
      arguments: {
        mindId,
        task,
        results: [{ n: fuel?.n, verdict: "overstated", explanation: "£310,000 against £284,000." }],
      },
    });
    return mindId;
  } finally {
    await agent.close();
  }
}

/** The prompt a recorded link would have typed in Claude Code. */
const typedIn = (url: string | undefined) =>
  new URL(url ?? "about:blank").searchParams.get("q") ?? "";

test("an agent-only User asks their own AI from a check's card and the chat box, the page bare", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await catchCopies(window);
    const mindId = await writtenAndChecked(await connected(window));
    await pointAndClick(
      window,
      window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`),
    );
    await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);

    // The card's first action asks Claude Code, used last, reached with the keyboard: Space goes
    // into the card on its mark.
    const mark = frontMind(window).locator('[data-testid="claim-mark"][data-check="unsupported"]');
    await mark.focus();
    await window.keyboard.press("Space");
    const card = window.getByTestId("claim-card");
    const ask = card.getByTestId("claim-ask-agent");
    await expect(ask).toHaveText("Ask Claude Code");
    await expect(ask).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(card).toBeHidden();
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    const [link] = await urlsOpened(app);
    expect(link?.startsWith("claude-cli://open?q=")).toBe(true);
    const request = typedIn(link);
    expect(request).toBe(
      `In IncarnaMind, the check of my note “${TITLE}” (mindId: ${mindId}) says this sentence is overstated:\n\n“${OVERSTATED}”\n\nFix that sentence from my Documents, and change nothing else in the note. Then check the note again yourself.`,
    );
    expect(request).not.toContain(CROSSINGS);
    expect(request).not.toContain(BOOKING);
    // No line above the Note asks for a model, and none offers the agent: the page stays bare.
    await expect(window.getByTestId("chat-readiness")).toHaveCount(0);
    await expect(frontMind(window)).not.toContainText("Asking needs an AI model");
    await expect(frontMind(window)).not.toContainText("Set up a model");

    // VS Code has no such link: from the card's ⋯ the request is copied, and the line says where to.
    await pointAndClick(window, mark);
    await pointAndClick(window, card.getByTestId("check-menu"));
    await pointAndClick(
      window,
      card.getByTestId("check-actions").getByRole("menuitem", { name: "Ask VS Code" }),
    );
    await expect(window.getByTestId("copied-line")).toHaveText("Copied. Paste it into VS Code.");
    expect(await copied(window)).toBe(request);
    expect(await urlsOpened(app)).toHaveLength(1);

    // The chat box: Enter offers Claude Code for the words, in place of the setup card; Enter again asks.
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What did fuel cost in 2025?");
    await window.keyboard.press("Enter");
    const offer = window.getByTestId("composer-ask-agent");
    await expect(offer.getByTestId("composer-ask-agent-ask")).toBeFocused();
    await expect(window.getByTestId("model-setup")).toHaveCount(0);
    await window.keyboard.press("Enter");
    await expect.poll(() => urlsOpened(app)).toHaveLength(2);
    expect(typedIn((await urlsOpened(app))[1])).toBe(
      `In IncarnaMind, about my note “${TITLE}” (mindId: ${mindId}):\n\nWhat did fuel cost in 2025?`,
    );
    await expect(offer).toBeHidden();
    await expect(window.getByTestId("composer-input")).toHaveValue("");

    // In Chinese, the same request in Chinese words.
    await setLanguage(window, "zh-CN");
    await pointAndClick(window, mark);
    await expect(card.getByTestId("claim-ask-agent")).toHaveText("交给 Claude Code");
    await pointAndClick(window, card.getByTestId("claim-ask-agent"));
    await expect.poll(() => urlsOpened(app)).toHaveLength(3);
    expect(typedIn((await urlsOpened(app))[2])).toContain(
      `我的笔记“${TITLE}”（mindId：${mindId}）经核对，这句话有夸大：`,
    );
  } finally {
    await app.close();
  }
});
