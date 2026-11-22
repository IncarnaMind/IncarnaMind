import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Locator, type Page, test } from "@playwright/test";
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
  useLocalChatModel as setUpLocalChatModel,
  setWindowSize,
  slideSelect,
  urlsOpened,
  writeNote,
} from "./app";

test.skip(
  !SHOW_AGENT_CONNECTION,
  "Settings › Agents is hidden while SHOW_AGENT_CONNECTION is false.",
);

/*
 * With only their own AI connected and no model set up (#3612): the assistant panel never shows,
 * not even from ⌘K, and the selection menu's Explain, Improve writing, Shorten, Translate and Edit
 * with AI hand the selected words to that AI in one press. The line where the change will land
 * says what became of the request and offers Continue in the open chat; the AI's change comes back
 * waiting for the User. A model set up brings the panel back. The app opens nothing here: each
 * link it would open is recorded.
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

const TITLE = "Harbour fares review";
const FIRST = "Harbourline Ferries carried 412,000 passengers in 2025.";
const SECOND = "The return fare rose from 14 pounds to 16 pounds in April.";
const THIRD = "The board will review the winter timetable in March.";

/** The Folder, its fare tables and Claude Code, which may propose changes; the Folder's id and Claude Code's launch. */
async function connected(window: Page): Promise<{ folderId: string; launch: AgentLaunch }> {
  const fares = join(sources, "Fares 2025.md");
  await writeFile(
    fares,
    "# Harbourline Ferries: fares 2025\n\nFrom April the return fare is 16 pounds, up from 14 pounds.\n",
  );
  const made = await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({
      name: "Harbourline Ferries",
      description: "",
    });
    await bridge.addDocuments([path], { groupId: folder.id });
    await bridge.setAgentsEnabled(true);
    const claudeCode = await bridge.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [folder.id],
      propose: true,
    });
    return { folderId: folder.id, launch: claudeCode.launch };
  }, fares);
  await expectReadyDocuments(window, 1);
  return made;
}

/** The User's own Note of three paragraphs, open and filed in the Folder Claude Code reads. */
async function openNote(window: Page, folderId: string): Promise<string> {
  const mindId = await writeNote(window, TITLE, [
    { text: FIRST },
    { text: SECOND },
    { text: THIRD },
  ]);
  await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: TITLE }));
  await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
  await window.evaluate(
    async (place) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.moveToFolder({
        mindIds: [place.mindId],
        folderId: place.folderId,
      });
    },
    { mindId, folderId },
  );
  return mindId;
}

/** Claude Code's own connection, as the agent's Tools reach IncarnaMind. */
async function claudeCode(launch: AgentLaunch): Promise<Client> {
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
  return agent;
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

const paragraph = (window: Page, text: string): Locator =>
  frontMind(window).getByTestId("mind-editor").locator(":scope > p").filter({ hasText: text });

/** Selects a paragraph's words with the mouse, as a person does, and gives back the menu. */
async function selectParagraph(window: Page, text: string): Promise<Locator> {
  await slideSelect(window, paragraph(window, text), text);
  const menu = window.getByTestId("selection-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("with only their own AI, the panel never shows and the selection menu's AI actions hand the words to it; its change waits for the User; a model brings the panel back", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1280, 820);
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await catchCopies(window);
    const { folderId, launch } = await connected(window);
    const mindId = await openNote(window, folderId);
    const note = `“${TITLE}”`;

    // The panel is out of sight, with no rail, and nothing in ⌘K offers it; the pill asks.
    const assistant = window.getByTestId("assistant");
    await expect(assistant).toBeHidden();
    await expect(window.getByTestId("assistant-rail")).toBeHidden();
    await expect(window.getByTestId("own-ai-pill-ask")).toHaveText(/Ask Claude Code/);
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type("Assistant:");
    const items = window.getByTestId("palette-item");
    await expect(items.filter({ hasText: "Ask “Assistant:”" })).toHaveCount(1);
    await expect(items.filter({ hasText: /^Assistant:/ })).toHaveCount(0);
    await expect(items.filter({ hasText: "Assistant: Show" })).toHaveCount(0);
    await window.keyboard.press("Escape");

    // Improve writing: one press opens Claude Code with the line typed, and the line where the
    // change will land says so, with Continue in the open chat.
    let menu = await selectParagraph(window, SECOND);
    await expect(menu.getByTestId("selection-action-improve")).toBeVisible();
    await shot(window, "selection-menu-en");
    await pointAndClick(window, menu.getByTestId("selection-action-improve"));
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    expect(typedIn((await urlsOpened(app))[0])).toBe(
      `About my note ${note} in IncarnaMind: improve the writing of “The return fare rose from 14 pounds to 16 pound…”, as a change in the note for me to review.`,
    );
    const asked = frontMind(window).getByTestId("edit-asked");
    await expect(asked).toContainText("Asked Claude Code: send the request there.");
    await expect(asked.getByTestId("menu-edit-action")).toHaveText("Continue in the open chat");
    await expect(window.getByTestId("copied-line")).toHaveText(
      "Opened Claude Code with your request typed. Send it there.",
    );
    await expect(assistant).toBeHidden();
    await shot(window, "selection-asked-en");

    // Continue in the open chat copies the same line for the chat the User has open.
    await pointAndClick(window, asked.getByTestId("menu-edit-action"));
    await expect.poll(() => copied(window)).toBe(typedIn((await urlsOpened(app))[0]));
    await expect(asked).toContainText(
      "Copied for Claude Code: paste the request there and send it.",
    );

    // Claude Code reads the words and the task, then proposes the change on that paragraph alone:
    // it waits for the User, and the line goes.
    const agent = await claudeCode(launch);
    try {
      const read = await agent.callTool({ name: "read_request", arguments: { note: TITLE } });
      const { request } = read.structuredContent as { request: string };
      expect(request).toContain(`(mindId: ${mindId})`);
      expect(request).toContain(SECOND);
      expect(request).not.toContain(FIRST);
      expect(request).toContain("propose_changes");
      await expect(asked).toContainText("Changing the words you selected in Claude Code.");
      const named = (
        await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } })
      ).structuredContent as { markdown: string; version: string };
      const name = named.markdown
        .split("\n")
        .find((line) => line.includes(SECOND))
        ?.split(" ")[0];
      const proposed = await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version: named.version,
          changes: [
            { paragraph: name, text: "In April the return fare went up from 14 to 16 pounds." },
          ],
        },
      });
      expect(proposed.isError ?? false).toBe(false);
    } finally {
      await agent.close();
    }
    // Its rewrite of the one paragraph comes word by word, as any agent's does.
    await expect(window.getByTestId("proposals-count")).toHaveText(/^\d+ changes? waiting$/);
    await expect(asked).toHaveCount(0);
    await expect(paragraph(window, FIRST)).toHaveText(FIRST);
    await shot(window, "selection-change-waiting-en");

    // Explain asks for a reply in Claude Code and changes nothing; Translate names its language;
    // Edit with AI… sends what the User typed.
    menu = await selectParagraph(window, THIRD);
    await pointAndClick(window, menu.getByTestId("selection-action-explain"));
    await expect.poll(() => urlsOpened(app)).toHaveLength(2);
    expect(typedIn((await urlsOpened(app))[1])).toBe(
      `About my note ${note} in IncarnaMind: explain “The board will review the winter timetable in M…”.`,
    );
    await expect(assistant).toBeHidden();

    menu = await selectParagraph(window, THIRD);
    await pointAndClick(window, menu.getByTestId("selection-action-translate"));
    await pointAndClick(
      window,
      window.getByTestId("selection-choices-translate").getByRole("menuitem", { name: "Français" }),
    );
    await expect.poll(() => urlsOpened(app)).toHaveLength(3);
    expect(typedIn((await urlsOpened(app))[2])).toContain(
      "into French (Français), as a change in the note for me to review.",
    );

    menu = await selectParagraph(window, FIRST);
    await pointAndClick(window, menu.getByTestId("selection-edit-field"));
    await window.keyboard.type("Round it to the nearest thousand");
    await window.keyboard.press("Enter");
    await expect.poll(() => urlsOpened(app)).toHaveLength(4);
    expect(typedIn((await urlsOpened(app))[3])).toBe(
      `About my note ${note} in IncarnaMind, the words “Harbourline Ferries carried 412,000 passengers …”:\n\nRound it to the nearest thousand`,
    );
    await expect(window.getByTestId("edit-handoff")).toHaveCount(0);

    // In Chinese, the same in Chinese words.
    await setLanguage(window, "zh-CN");
    menu = await selectParagraph(window, THIRD);
    await pointAndClick(window, menu.getByTestId("selection-action-shorten"));
    await expect.poll(() => urlsOpened(app)).toHaveLength(5);
    expect(typedIn((await urlsOpened(app))[4])).toBe(
      `关于我在 IncarnaMind 中的笔记“${TITLE}”：精简“The board will review the winter timetable in M…”，作为修改写进笔记，由我确认。`,
    );
    await expect(frontMind(window).getByTestId("edit-asked")).toContainText(
      "已交给 Claude Code：在那里发送请求即可。",
    );
    await shot(window, "selection-asked-zh-CN");
    await setLanguage(window, "en");

    // In a narrow window, the same: no panel at the bottom, and the pill.
    await setWindowSize(app, window, 900, 700);
    await expect(assistant).toBeHidden();
    await expect(window.getByTestId("own-ai-pill-ask")).toBeVisible();
    await shot(window, "selection-narrow-en");

    // A model set up brings the panel back, and the pill goes.
    await setUpLocalChatModel(window);
    await expect(assistant).toBeVisible();
    await expect(window.getByTestId("own-ai-pill")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
