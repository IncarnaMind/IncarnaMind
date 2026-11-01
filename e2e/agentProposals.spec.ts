import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  catchCopies,
  closeSettings,
  copied,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  expectReadyDocuments,
  frontMind,
  launchApp,
  nameMind,
  newMind,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

test.skip(
  !SHOW_AGENT_CONNECTION,
  "Settings › Agents is hidden while SHOW_AGENT_CONNECTION is false.",
);

/*
 * An outside agent proposes changes to a Note (#352): the User lets it where they connect it,
 * the agent reads the Note by name over MCP and proposes a rewrite, and the change waits in the
 * Note with the agent's name until the User accepts it, which ⌘Z takes back. The home folder is
 * a temporary one, and copying is caught in the page.
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

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

/** Saves a screenshot when INCARNAMIND_SCREENSHOTS names a folder for them. */
async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** A Folder "Coast" with one Document in it; its id. */
async function withCoast(window: Page): Promise<string> {
  const tides = join(sources, "Tides.md");
  await writeFile(
    tides,
    "# Tides\n\nSpring tides happen twice a month, at new moon and full moon, when the sun and the moon pull in line.\n",
  );
  const coast = await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({ name: "Coast", description: "The sea." });
    await bridge.addDocuments([path], { groupId: folder.id });
    return folder.id;
  }, tides);
  await expectReadyDocuments(window, 1);
  return coast;
}

test("an agent the User lets propose changes: its change waits in the Note with its name, Accept applies it and ⌘Z takes it back", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    const coast = await withCoast(window);
    await catchCopies(window);
    await acceptPlainTextKeys(window);

    await newMind(window);
    await nameMind(window, "Field notes");
    await enterContent(window);
    await window.keyboard.type("Tides rise twice a day.");
    const editor = frontMind(window).getByTestId("mind-editor");
    await expect(editor.locator(":scope > p")).toHaveText(["Tides rise twice a day."]);
    const mindId = await frontMind(window).getAttribute("data-mind-id");
    await window.evaluate(
      async (place) => {
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.moveToFolder({
          mindIds: [place.mindId],
          folderId: place.folderId,
        });
      },
      { mindId: mindId ?? "", folderId: coast },
    );

    const page = await openSettings(window, "agents");
    await page.getByTestId("agents-enabled").click();
    await page
      .getByTestId("agents-list")
      .locator('[data-client="other"]')
      .getByTestId("agent-connect")
      .click();
    const dialog = window.getByTestId("connect-agent-dialog");
    await dialog.getByTestId("connect-agent-name").fill("Research agent");
    await dialog.getByTestId("agent-folder").check();
    const propose = dialog.getByTestId("agent-propose");
    await expect(propose).not.toBeChecked();
    await expect(dialog).toContainText("Let it propose changes to the notes in these Folders");
    await propose.check();
    await shot(window, "agent-proposals-connect");
    await dialog.getByTestId("connect-agent-allow").click();
    const row = page.locator('[data-testid="agent-pairing"][data-name="Research agent"]');
    await expect(row.getByTestId("agent-pairing-proposes")).toHaveText(
      "May propose changes to their notes, which wait for you",
    );
    await shot(window, "agent-proposals-row");
    const settings = JSON.parse(await copied(window)) as {
      mcpServers: { incarnamind: { command: string; args: string[]; env: Record<string, string> } };
    };
    const server = settings.mcpServers.incarnamind;
    await closeSettings(window);

    const agent = new Client({ name: "test-agent", version: "1.0.0" });
    await agent.connect(
      new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: server.env,
        stderr: "pipe",
      }),
    );
    try {
      const read = await agent.callTool({
        name: "read_mind",
        arguments: { mindId, named: true },
      });
      const named = read.structuredContent as { markdown: string; version: string };
      expect(named.markdown).toContain("¶1 Tides rise twice a day.");
      const proposed = await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version: named.version,
          changes: [{ paragraph: "¶1", text: "Tides rise and fall twice a day." }],
        },
      });
      expect(proposed.isError ?? false).toBe(false);
    } finally {
      await agent.close();
    }

    // It waits: the Note's bar and the change's own bar name the agent.
    await expect(window.getByTestId("proposals-count")).toHaveText("1 change waiting");
    await expect(window.getByTestId("proposals-agents")).toHaveText("Proposed by Research agent");
    await pointAndClick(window, editor.locator("ins.proposal-insert").first());
    const bar = window.getByTestId("change-bar");
    await expect(bar.getByTestId("change-bar-author")).toHaveText("Proposed by Research agent");
    await shot(window, "agent-proposals-waiting-en");

    await pointAndClick(window, bar.getByTestId("change-accept"));
    await expect(editor.locator(":scope > p")).toHaveText(["Tides rise and fall twice a day."]);
    await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
    await expect
      .poll(() =>
        window.evaluate(async () =>
          (
            await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listAiUse()
          ).map((entry) => [entry.kind, entry.agent]),
        ),
      )
      .toEqual([["outside-agent-change-accepted", "Research agent"]]);

    await editor.focus();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(window.getByTestId("proposals-count")).toHaveText("1 change waiting");
    await expect(editor.locator(":scope > p")).toHaveText(["Tides rise and fall twice a day."]);

    await setLanguage(window, "zh-CN");
    await expect(window.getByTestId("proposals-agents")).toHaveText("Research agent 建议");
    await pointAndClick(window, editor.locator("ins.proposal-insert").first());
    await expect(bar.getByTestId("change-bar-author")).toHaveText("Research agent 建议");
    await shot(window, "agent-proposals-waiting-zh");
  } finally {
    await app.close();
  }
});
