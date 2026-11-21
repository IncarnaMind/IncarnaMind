import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import type { AgentLaunch, CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  catchCopies,
  closeSettings,
  copied,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  frontMind,
  launchApp,
  openDocumentAt,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  urlsOpened,
  useLocalChatModel,
} from "./app";

test.skip(
  !SHOW_AGENT_CONNECTION,
  "Settings › Agents is hidden while SHOW_AGENT_CONNECTION is false.",
);

/*
 * Ask your AI (#3373, #3419): a User who connected their own AI and set up no model finds the page
 * above the Note bare and the assistant folded out of sight, with no rail, and a pill that asks
 * that AI about the Note, whose ⌄ also opens IncarnaMind's own chat on model setup; they ask it to
 * fix a sentence that needs a look, all of them at once, and with what they typed in the chat box.
 * Claude Code has a link that opens it with one line typed; VS Code has none, so the line is
 * copied. The rest waits for the agent's read_request, which the card and its Activity then show.
 * The app opens nothing here: each link it would open is recorded.
 *
 * With no model set up (#3533): a question typed with a Document open names it in the line, its id
 * waits for the agent, and an agent that finds no request waiting is told so, not refused; Check
 * on a Note asks that agent, or says what a check needs, and a model set up changes neither.
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

/** Claude Code's own connection, as the agent's Tools reach IncarnaMind. */
async function claudeCode(launch: AgentLaunch): Promise<Client> {
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
  return agent;
}

/**
 * The Note Claude Code wrote, its fuel sentence checked by Claude Code itself as overstated and
 * its booking sentence as not found.
 */
async function writtenAndChecked(launch: AgentLaunch): Promise<string> {
  const agent = await claudeCode(launch);
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
    const booking = sentences.find((each) => each.text === BOOKING);
    await agent.callTool({
      name: "report_check",
      arguments: {
        mindId,
        task,
        results: [
          { n: fuel?.n, verdict: "overstated", explanation: "£310,000 against £284,000." },
          { n: booking?.n, verdict: "not found", explanation: "No Document mentions it." },
        ],
      },
    });
    return mindId;
  } finally {
    await agent.close();
  }
}

/** Saves a screenshot when INCARNAMIND_SCREENSHOTS names a folder for them. */
async function shot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await window.screenshot({ path: join(folder, `${name}.png`), animations: "disabled" });
}

/** The prompt a recorded link would have typed in Claude Code. */
const typedIn = (url: string | undefined) =>
  new URL(url ?? "about:blank").searchParams.get("q") ?? "";

test("an agent-only User finds a bare page, the assistant folded and a pill that asks their own AI; the card and the chat box ask it too", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await catchCopies(window);
    const launch = await connected(window);
    const mindId = await writtenAndChecked(launch);
    await pointAndClick(
      window,
      window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`),
    );
    await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
    const noteNamed = `About my note “${TITLE}” in IncarnaMind:`;
    const fixLine = `Fix the sentence IncarnaMind flagged in “${TITLE}”.`;

    // No line above the Note, the assistant folded out of sight with no rail, and the pill asks
    // Claude Code, used last.
    const assistant = window.getByTestId("assistant");
    await expect(assistant).toHaveAttribute("data-folded", "true");
    await expect(assistant).toBeHidden();
    await expect(window.getByTestId("assistant-rail")).toBeHidden();
    const pill = window.getByTestId("own-ai-pill-ask");
    await expect(pill).toContainText("Ask Claude Code");
    await expect(window.getByTestId("ask-pill")).toHaveCount(0);
    await expect(window.getByTestId("chat-readiness")).toHaveCount(0);
    await expect(frontMind(window)).not.toContainText("Asking needs an AI model");
    await pointAndClick(window, pill);
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    let [link] = await urlsOpened(app);
    expect(link?.startsWith("claude-cli://open?q=")).toBe(true);
    expect(typedIn(link)).toBe(noteNamed);

    // The card's first action asks Claude Code, reached with the keyboard: Space goes into the card
    // on its mark.
    const mark = frontMind(window)
      .locator('[data-testid="claim-mark"][data-check="unsupported"]')
      .first();
    await mark.focus();
    await window.keyboard.press("Space");
    const card = window.getByTestId("claim-card");
    const ask = card.getByTestId("claim-ask-agent");
    await expect(ask).toHaveText("Ask Claude Code");
    await expect(ask).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(card).toBeHidden();
    // Claude Code opens in a window of its own: this one says where the request went.
    await expect(window.getByTestId("copied-line")).toHaveText(
      "Opened Claude Code with your request typed. Send it there.",
    );
    await shot(window, "ask-opened-line-en");
    await expect.poll(() => urlsOpened(app)).toHaveLength(2);
    link = (await urlsOpened(app))[1];
    expect(typedIn(link)).toBe(fixLine);

    // The card says the request waits for Claude Code; Claude Code reads the rest once, over its
    // connection, and the card says so.
    await pointAndClick(window, mark);
    await expect(card.getByTestId("claim-asked")).toHaveText(
      "Waiting for Claude Code to read your request.",
    );
    await shot(window, "ask-card-waiting-en");
    await window.keyboard.press("Escape");
    const agent = await claudeCode(launch);
    let request = "";
    try {
      const read = await agent.callTool({ name: "read_request", arguments: { note: TITLE } });
      request = (read.structuredContent as { request: string }).request;
    } finally {
      await agent.close();
    }
    expect(request).toBe(
      `In IncarnaMind, the check of my note “${TITLE}” (mindId: ${mindId}) says this sentence is overstated:\n\n“${OVERSTATED}”\n\nFix that sentence from my Documents, and change nothing else in the note. Then check the note again yourself.`,
    );
    expect(request).not.toContain(CROSSINGS);
    expect(request).not.toContain(BOOKING);
    await pointAndClick(window, mark);
    await expect(card.getByTestId("claim-asked")).toHaveText("Claude Code read your request.");
    await shot(window, "ask-card-read-en");
    await window.keyboard.press("Escape");
    await expect(card).toBeHidden();

    // VS Code has no such link: from the card's ⋯ the request is copied, and the line says where to.
    await pointAndClick(window, mark);
    await pointAndClick(window, card.getByTestId("check-menu"));
    await pointAndClick(
      window,
      card.getByTestId("check-actions").getByRole("menuitem", { name: "Ask VS Code" }),
    );
    await expect(window.getByTestId("copied-line")).toHaveText("Copied. Paste it into VS Code.");
    expect(await copied(window)).toBe(fixLine);
    expect(await urlsOpened(app)).toHaveLength(2);

    // Every sentence that needs a look, in one request from the Note's check.
    await pointAndClick(window, window.getByTestId("check-badge-open"));
    const askAll = window.getByTestId("badge-ask-agent-all");
    await expect(askAll).toHaveText("Ask Claude Code to fix 2");
    await shot(window, "ask-all-en");
    await pointAndClick(window, askAll);
    await expect.poll(() => urlsOpened(app)).toHaveLength(3);
    expect(typedIn((await urlsOpened(app))[2])).toBe(
      `Fix the 2 sentences IncarnaMind flagged in “${TITLE}”.`,
    );

    // What Claude Code read can be read again in its Activity.
    const settings = await openSettings(window, "agents");
    const row = settings.locator('[data-testid="agent-pairing"][data-name="Claude Code"]');
    await pointAndClick(window, row.getByTestId("agent-activity-toggle"));
    const call = row.getByTestId("agent-activity-call").filter({ hasText: "Read your request" });
    await expect(call).toContainText(`Read your request about “${TITLE}”`);
    await pointAndClick(window, call.getByText("Show the request"));
    await expect(call.getByTestId("agent-activity-request")).toContainText(OVERSTATED);
    await shot(window, "activity-request-en");
    await closeSettings(window);

    // The pill's key does what the pill does.
    await pointAndClick(window, frontMind(window).getByTestId("mind-editor"));
    await window.keyboard.press("ControlOrMeta+j");
    await expect.poll(() => urlsOpened(app)).toHaveLength(4);
    expect(typedIn((await urlsOpened(app))[3])).toBe(noteNamed);
    await expect(assistant).toBeHidden();

    // IncarnaMind's own chat is under the pill's ⌄, last, by the keyboard as its agents are: it
    // opens the assistant on model setup, with the cursor in its key field.
    await window.getByTestId("own-ai-pill-others").focus();
    await window.keyboard.press("Enter");
    await expect(window.getByRole("menuitem", { name: "Ask VS Code" })).toBeFocused();
    await window.keyboard.press("ArrowDown");
    const useModel = window.getByTestId("own-ai-pill-use-model");
    await expect(useModel).toHaveText("Use a model in IncarnaMind…");
    await expect(useModel).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(assistant).toBeVisible();
    await expect(assistant).not.toHaveAttribute("data-folded", "true");
    await expect(window.getByTestId("model-setup")).toBeVisible();
    await expect(window.getByTestId("setup-key")).toBeFocused();
    await expect(window.getByTestId("own-ai-pill")).toHaveCount(0);
    await pointAndClick(window, window.getByTestId("setup-later"));

    // Their own fold then shows the rail, as for everyone, beside the pill; opened again, Enter in
    // the chat box offers Claude Code for the words, in place of the setup card, and Enter again asks.
    await pointAndClick(window, window.getByTestId("assistant-fold"));
    await expect(window.getByTestId("assistant-rail")).toBeVisible();
    await expect(window.getByTestId("own-ai-pill")).toBeVisible();
    await pointAndClick(window, window.getByTestId("assistant-fold"));
    await expect(assistant).not.toHaveAttribute("data-folded", "true");
    await expect(window.getByTestId("own-ai-pill")).toHaveCount(0);
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What did fuel cost in 2025?");
    await window.keyboard.press("Enter");
    const offer = window.getByTestId("composer-ask-agent");
    await expect(offer.getByTestId("composer-ask-agent-ask")).toBeFocused();
    await expect(window.getByTestId("model-setup")).toHaveCount(0);
    await window.keyboard.press("Enter");
    await expect.poll(() => urlsOpened(app)).toHaveLength(5);
    expect(typedIn((await urlsOpened(app))[4])).toBe(`${noteNamed}\n\nWhat did fuel cost in 2025?`);
    await expect(offer).toBeHidden();
    await expect(window.getByTestId("composer-input")).toHaveValue("");

    // In Chinese, the same request in Chinese words.
    await setLanguage(window, "zh-CN");
    await pointAndClick(window, mark);
    await expect(card.getByTestId("claim-ask-agent")).toHaveText("交给 Claude Code");
    await pointAndClick(window, card.getByTestId("claim-ask-agent"));
    await expect(window.getByTestId("copied-line")).toHaveText(
      "已打开 Claude Code，请求已填好，在那里发送即可。",
    );
    await shot(window, "ask-opened-line-zh-CN");
    await expect.poll(() => urlsOpened(app)).toHaveLength(6);
    expect(typedIn((await urlsOpened(app))[5])).toBe(
      `把 IncarnaMind 在笔记“${TITLE}”里标出来的那句改好。`,
    );
    await pointAndClick(window, mark);
    await expect(card.getByTestId("claim-asked")).toHaveText("等 Claude Code 读取你的请求。");
    await shot(window, "ask-card-waiting-zh-CN");
  } finally {
    await app.close();
  }
});

const FERRY_NOTE = `${CROSSINGS} ${OVERSTATED}\n\n${BOOKING}`;

/** A Note Claude Code wrote with none of its sentences checked, which a Check would check. */
async function writtenUnchecked(launch: AgentLaunch): Promise<string> {
  const agent = await claudeCode(launch);
  try {
    const made = await agent.callTool({
      name: "create_mind",
      arguments: { title: TITLE, markdown: FERRY_NOTE },
    });
    return (made.structuredContent as { mindId: string }).mindId;
  } finally {
    await agent.close();
  }
}

test("with no model, a question typed with a Document open names it in the line, its id waits for the agent, and an agent that finds nothing waiting is not refused", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await catchCopies(window);
    const launch = await connected(window);
    const documentId = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [document] = await bridge.listDocuments();
      if (!document) throw new Error("The Document wasn't added.");
      return document.id;
    });
    await openDocumentAt(window, { documentId });
    await expect(
      window.getByTestId("viewer-tab-strip").or(window.getByTestId("tab-group")),
    ).toBeVisible();

    // ⌘J goes to the chat box; Enter offers Claude Code for the words, and Enter again asks it.
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("Summarise this document");
    await window.keyboard.press("Enter");
    const offer = window.getByTestId("composer-ask-agent");
    await expect(offer.getByTestId("composer-ask-agent-ask")).toBeFocused();
    await shot(window, "ask-document-offer-en");
    await window.keyboard.press("Enter");
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    expect(typedIn((await urlsOpened(app))[0])).toBe(
      "About my document “Annual summary 2025” in IncarnaMind:\n\nSummarise this document",
    );

    // The rest waits for the agent, once; a second look finds nothing waiting, and is no failed call.
    const agent = await claudeCode(launch);
    try {
      const first = await agent.callTool({ name: "read_request", arguments: {} });
      expect(first.isError ?? false).toBe(false);
      expect(first.structuredContent).toEqual({
        mindId: null,
        title: "Annual summary 2025",
        request: `My message is about the document I have open in IncarnaMind: “Annual summary 2025” (documentId: ${documentId}).`,
      });
      const again = await agent.callTool({ name: "read_request", arguments: {} });
      expect(again.isError ?? false).toBe(false);
      expect(again.structuredContent).toMatchObject({ mindId: null, title: "" });
    } finally {
      await agent.close();
    }

    // The same, in Chinese.
    await setLanguage(window, "zh-CN");
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("总结一下这个文档");
    await window.keyboard.press("Enter");
    await expect(offer.getByTestId("composer-ask-agent-ask")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect.poll(() => urlsOpened(app)).toHaveLength(2);
    expect(typedIn((await urlsOpened(app))[1])).toBe(
      "关于我在 IncarnaMind 中的文档“Annual summary 2025”：\n\n总结一下这个文档",
    );
  } finally {
    await app.close();
  }
});

test("with no model, Check asks the User's own AI to check the Note; with no agent it says what a check needs; with a model it checks as before", async () => {
  const { app, window } = await launchApp(dataDir, { home, fakeChat: true });
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await catchCopies(window);
    const launch = await connected(window);
    const mindId = await writtenUnchecked(launch);
    await pointAndClick(
      window,
      window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`),
    );
    await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
    const press = async () => {
      if (!(await window.getByTestId("check-card").isVisible())) {
        await pointAndClick(window, window.getByTestId("check-badge-open"));
      }
      await pointAndClick(window, window.getByTestId("badge-check-mind"));
    };

    // An agent that can read the Note: the card's line offers to ask it, as "Ask {agent}" is worded
    // everywhere, and says nothing about asking a model.
    await press();
    const line = window.getByTestId("checks-ask-agent");
    await expect(line.getByTestId("checks-ask-agent-ask")).toHaveText("Ask Claude Code");
    await expect(line.getByTestId("checks-ask-agent-set-up")).toHaveText("Set up a model");
    await expect(window.getByTestId("check-card")).not.toContainText("Asking needs an AI model");
    await shot(window, "check-no-model-agent-en");
    await setLanguage(window, "zh-CN");
    await expect(line.getByTestId("checks-ask-agent-ask")).toHaveText("交给 Claude Code");
    await shot(window, "check-no-model-agent-zh-CN");
    await setLanguage(window, "en");
    await pointAndClick(window, line.getByTestId("checks-ask-agent-ask"));
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    expect(typedIn((await urlsOpened(app))[0])).toBe(
      `Check my note “${TITLE}” in IncarnaMind against my Documents.`,
    );
    await expect(line).toHaveCount(0);

    // What waits for Claude Code says how to check the Note with the Tools it has, once.
    const agent = await claudeCode(launch);
    try {
      const read = await agent.callTool({ name: "read_request", arguments: { note: TITLE } });
      const { request } = read.structuredContent as { request: string };
      expect(request).toContain(`(mindId: ${mindId})`);
      expect(request).toContain("check_mind_yourself");
      expect(request).toContain("report_check");
    } finally {
      await agent.close();
    }

    // No agent either: the line is about checking, with the way to set a model up.
    const connectedAgents = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const { pairings } = await bridge.getAgents();
      for (const each of pairings) await bridge.disconnectAgent(each.id);
      return pairings.length;
    });
    expect(connectedAgents).toBe(2);
    await press();
    const alone = window.getByTestId("checks-problem");
    await expect(alone).toContainText("Checking needs an AI model");
    await expect(alone).not.toContainText("Asking");
    await shot(window, "check-no-model-alone-en");
    await setLanguage(window, "zh-CN");
    await expect(alone).toContainText("核对需要 AI 模型");
    await shot(window, "check-no-model-alone-zh-CN");
    await setLanguage(window, "en");

    // With a model set up the Check runs: neither line shows.
    // biome-ignore lint/correctness/useHookAtTopLevel: an e2e helper whose name begins with "use", not a React hook.
    await useLocalChatModel(window);
    await press();
    await expect(window.getByTestId("checks-ask-agent")).toHaveCount(0);
    await expect(window.getByTestId("check-card")).not.toContainText("Checking needs an AI model");
    await shot(window, "check-with-model-en");
  } finally {
    await app.close();
  }
});
