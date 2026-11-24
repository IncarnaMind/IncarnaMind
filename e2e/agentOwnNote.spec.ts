import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import type { AgentLaunch, CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  expectReadyDocuments,
  frontMind,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

/*
 * The User's own AI keeps working on a Note it wrote (#3371). Written while the User types in
 * another Note, it opens in a tab behind that one, and the caret stays where they type; the
 * sidebar's foot says so, with Open. Its changes there land at once, each said the same way, and
 * ⌘Z takes them back one by one, last first. The agent is connected through the bridge, as
 * Settings connects one, with a temporary home folder: no agent of this computer is touched.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save stills there.
 */

let dataDir: string;
let sources: string;
let home: string;
let contextClosed: Promise<void> | undefined;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  try {
    await contextClosed;
  } finally {
    contextClosed = undefined;
    await removeDataFolder(dataDir);
    await removeDataFolder(sources);
    await removeDataFolder(home);
  }
});

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const OPENING = "Tides rise and fall twice a day along the coast.";
const RANGE = "The range changes through the month.";

/** A Folder "Coast" with one Document in it, and Claude Code connected to it with leave to write. */
async function connectedToCoast(window: Page): Promise<AgentLaunch> {
  const tides = join(sources, "Tides.md");
  await writeFile(tides, "# Tides\n\nSpring tides come twice a month, at new and full moon.\n");
  const launch = await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const coast = await bridge.createLibraryGroup({ name: "Coast", description: "The sea." });
    await bridge.addDocuments([path], { groupId: coast.id });
    await bridge.setAgentsEnabled(true);
    const connected = await bridge.connectAgent({
      name: "Claude Code",
      folderIds: [coast.id],
      propose: true,
    });
    return connected.launch;
  }, tides);
  await expectReadyDocuments(window, 1);
  return launch;
}

async function connect(launch: AgentLaunch): Promise<Client> {
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
  return agent;
}

function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

/** The paragraphs of the Note in front that hold words. */
const paragraphsOf = (window: Page) =>
  frontMind(window).getByTestId("mind-editor").locator(":scope > p").filter({ hasText: /\S/ });

test("a Note the agent writes opens behind the one being typed in, and ⌘Z takes back its changes there one by one", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  const electron = app.process();
  try {
    await acceptPlainTextKeys(window);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    const launch = await connectedToCoast(window);

    await newMind(window);
    await nameMind(window, "Field notes");
    await enterContent(window);
    await window.keyboard.type("High water at the quay was at ");
    const fieldNotes = await frontMind(window).getAttribute("data-mind-id");

    const agent = await connect(launch);
    try {
      const { mindId } = structured<{ mindId: string }>(
        await agent.callTool({
          name: "create_mind",
          arguments: { title: "Tide report", markdown: `${OPENING}\n\n${RANGE}` },
        }),
      );

      // Behind, beside the Note in front: the caret stays where the User types.
      const tab = window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`);
      await expect(tab).toBeVisible();
      await expect(tab).toHaveAttribute("aria-selected", "false");
      await window.keyboard.type("six.");
      await expect(frontMind(window)).toHaveAttribute("data-mind-id", fieldNotes ?? "");
      await expect(frontMind(window).getByTestId("mind-editor")).toBeFocused();
      await expect(paragraphsOf(window).last()).toHaveText("High water at the quay was at six.");
      const line = window.getByTestId(`agent-note-${mindId}`);
      await expect(line.getByTestId("status-label")).toHaveText(
        "Claude Code wrote the note “Tide report”",
      );
      await motionSettled(window);
      await shot(window, "agent-note-written-en");

      await pointAndClick(window, line.getByTestId("agent-note-open"));
      await expect(frontMind(window)).toHaveAttribute("data-mind-id", mindId);
      await expect(line).toBeHidden();
      await expect(paragraphsOf(window)).toHaveText([OPENING, RANGE]);

      // Three changes in a row, each there at once and said where the Library's work shows.
      let { version } = structured<{ version: string }>(
        await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
      );
      const states: string[][] = [[OPENING, RANGE]];
      const asks: { changes: object[]; shows: string[]; says: string }[] = [
        {
          changes: [{ paragraph: "¶1", text: "Tides rise and fall twice a day." }],
          shows: ["Tides rise and fall twice a day.", RANGE],
          says: "Claude Code changed 1 paragraph in “Tide report”",
        },
        {
          changes: [{ paragraph: "¶2+", text: "Neap tides come at the quarter moons." }],
          shows: [
            "Tides rise and fall twice a day.",
            RANGE,
            "Neap tides come at the quarter moons.",
          ],
          says: "Claude Code added 1 paragraph to “Tide report”",
        },
        {
          changes: [{ paragraph: "¶1", text: "Tides turn twice a day." }],
          shows: ["Tides turn twice a day.", RANGE, "Neap tides come at the quarter moons."],
          says: "Claude Code changed 1 paragraph in “Tide report”",
        },
      ];
      for (const ask of asks) {
        const done = structured<{ status: string; version: string }>(
          await agent.callTool({
            name: "propose_changes",
            arguments: { mindId, version, changes: ask.changes },
          }),
        );
        expect(done.status).toBe("applied");
        ({ version } = done);
        await expect(paragraphsOf(window)).toHaveText(ask.shows);
        await expect(line.getByTestId("status-label")).toHaveText(ask.says);
        states.push(ask.shows);
      }
      await expect(window.getByTestId("proposals-count")).toHaveCount(0);
      await motionSettled(window);
      await shot(window, "agent-note-changed-en");

      await setLanguage(window, "zh-CN");
      await expect(line.getByTestId("status-label")).toHaveText(
        "Claude Code 修改了“Tide report”中的 1 个段落",
      );
      await expect(line.getByTestId("agent-note-open")).toHaveText("打开");
      await motionSettled(window);
      await shot(window, "agent-note-changed-zh");
      // At a narrow window the line takes two lines, its Open after the words, inside the sidebar.
      await setWindowSize(app, window, 900, 720);
      const sidebar = await window.getByTestId("sidebar-status").boundingBox();
      const open = await line.getByTestId("agent-note-open").boundingBox();
      expect((open?.x ?? 0) + (open?.width ?? 0)).toBeLessThanOrEqual(
        (sidebar?.x ?? 0) + (sidebar?.width ?? 0) + 1,
      );
      await motionSettled(window);
      await shot(window, "agent-note-changed-zh-narrow");
      await setLanguage(window, "en");
      await motionSettled(window);
      await shot(window, "agent-note-changed-en-narrow");
      await setWindowSize(app, window, 1440, 900);

      // ⌘Z in the Note, which holds no step of the User's, takes the changes back last first.
      await pointAndClick(window, paragraphsOf(window).first());
      for (const shown of states.slice(0, -1).reverse()) {
        await window.keyboard.press("ControlOrMeta+z");
        await expect(paragraphsOf(window)).toHaveText(shown);
      }
    } finally {
      await agent.close();
    }
  } finally {
    // Playwright can still be closing the context after Electron exits (#1741).
    await new Promise<void>((resolve, reject) => {
      if (electron.exitCode !== null || electron.signalCode !== null) resolve();
      else electron.once("exit", () => resolve());
      contextClosed = app.close();
      contextClosed.catch(reject);
    });
    expect(electron.exitCode).toBe(0);
  }
});
