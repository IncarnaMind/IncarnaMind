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

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * With only their own AI connected and no model set up (#3612): the assistant panel never shows,
 * not even from ⌘K. The bar over a selection only formats and comments, as the User's AI app's own
 * page does (#3764), and ⌘J hands the selected words to that AI, for the User to say there what to
 * change. The line where the change will land says what became of the request and offers Continue
 * in the open chat; the AI's change comes back waiting for the User. A model set up brings the
 * panel back. The app opens nothing here: each link it would open is recorded.
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

test("with only their own AI, the panel never shows, the bar over a selection only formats and comments, and ⌘J hands the words to it; its change waits for the User; a model brings the panel back", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1280, 820);
  await acceptPlainTextKeys(window);
  try {
    await dismissChatSetup(window);
    await catchCopies(window);
    const { folderId, launch } = await connected(window);
    const mindId = await openNote(window, folderId);
    const note = `“${TITLE}”`;

    // The panel is out of sight, with no rail, and nothing in ⌘K offers it or asks (#3764); the
    // pill asks.
    const assistant = window.getByTestId("assistant");
    await expect(assistant).toBeHidden();
    await expect(window.getByTestId("assistant-rail")).toBeHidden();
    await expect(window.getByTestId("own-ai-pill-ask")).toHaveText(/Ask Claude Code/);
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type("Assistant:");
    await expect(window.getByTestId("palette-search")).toHaveValue("Assistant:");
    const items = window.getByTestId("palette-item");
    await expect(items.filter({ hasText: "Ask “Assistant:”" })).toHaveCount(0);
    await expect(items.filter({ hasText: /^Assistant:/ })).toHaveCount(0);
    await expect(items.filter({ hasText: "Assistant: Show" })).toHaveCount(0);
    await window.keyboard.press("Escape");

    // The bar over the words formats and comments, with no AI group and no field (#3764). ⌘J
    // opens Claude Code with the words typed, for the User to say what to change, and the line
    // where the change will land says so, with Continue in the open chat.
    let menu = await selectParagraph(window, SECOND);
    await expect(menu.getByTestId("format-bold")).toBeVisible();
    await expect(menu.getByTestId("selection-comment")).toBeVisible();
    await expect(menu.locator('[data-testid^="selection-action-"]')).toHaveCount(0);
    await expect(menu.getByTestId("selection-edit-field")).toHaveCount(0);
    await shot(window, "selection-menu-en");
    await window.keyboard.press("ControlOrMeta+j");
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    expect(typedIn((await urlsOpened(app))[0])).toBe(
      `About my note ${note} in IncarnaMind, the words “The return fare rose from 14 pounds to 16 pound…”:`,
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

    // Words asked about again: the line says it was asked; ✕ takes the line away, and the words
    // stay where they were. No field of the bar's asks for what to change.
    menu = await selectParagraph(window, THIRD);
    await window.keyboard.press("ControlOrMeta+j");
    await expect.poll(() => urlsOpened(app)).toHaveLength(2);
    expect(typedIn((await urlsOpened(app))[1])).toBe(
      `About my note ${note} in IncarnaMind, the words “The board will review the winter timetable in M…”:`,
    );
    await expect(assistant).toBeHidden();
    await expect(window.getByTestId("edit-handoff")).toHaveCount(0);
    await expect(asked).toContainText("Asked Claude Code: send the request there.");
    await pointAndClick(window, asked.getByTestId("menu-edit-close"));
    await expect(asked).toHaveCount(0);
    await expect(paragraph(window, THIRD)).toHaveText(THIRD);

    // In Chinese, the same in Chinese words.
    await setLanguage(window, "zh-CN");
    menu = await selectParagraph(window, FIRST);
    await expect(menu.locator('[data-testid^="selection-action-"]')).toHaveCount(0);
    await window.keyboard.press("ControlOrMeta+j");
    await expect.poll(() => urlsOpened(app)).toHaveLength(3);
    expect(typedIn((await urlsOpened(app))[2])).toBe(
      `关于我在 IncarnaMind 中的笔记“${TITLE}”里的“Harbourline Ferries carried 412,000 passengers …”：`,
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
