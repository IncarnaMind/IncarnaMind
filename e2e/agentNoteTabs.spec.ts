import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  catchCopies,
  closeSettings,
  copied,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  writeNote,
} from "./app";

test.skip(
  !SHOW_AGENT_CONNECTION,
  "Settings › Agents is hidden while SHOW_AGENT_CONNECTION is false.",
);

/*
 * An outside agent adds a tab to the User's Note (#3414): the tab waits with the first Block it
 * holds, as one change. The panel lists it; opened, its words show as the change, Accept keeps the
 * tab and Reject takes it out with them. The home folder is a temporary one.
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

async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** A Folder "Harbour" with one Document in it; its id. */
async function withHarbour(window: Page): Promise<string> {
  const costs = join(sources, "Costs.md");
  await writeFile(
    costs,
    "# Costs\n\nFuel cost 3.1 million in 2026, against 2.7 million in 2025.\n",
  );
  const harbour = await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const folder = await bridge.createLibraryGroup({ name: "Harbour", description: "Ferries." });
    await bridge.addDocuments([path], { groupId: folder.id });
    return folder.id;
  }, costs);
  await expectReadyDocuments(window, 1);
  return harbour;
}

/** An agent connected as the User connects one that may propose changes in "Harbour". */
async function connectAgent(window: Page): Promise<Client> {
  const page = await openSettings(window, "agents");
  await page.getByTestId("agents-enabled").click();
  await page
    .getByTestId("agents-list")
    .locator('[data-client="other"]')
    .getByTestId("agent-connect")
    .click();
  const dialog = window.getByTestId("connect-agent-dialog");
  await dialog.getByTestId("connect-agent-name").fill("Ferry agent");
  await dialog.getByTestId("agent-folder").check();
  await dialog.getByTestId("agent-propose").check();
  await dialog.getByTestId("connect-agent-allow").click();
  await expect(
    page.locator('[data-testid="agent-pairing"][data-name="Ferry agent"]'),
  ).toBeVisible();
  const settings = JSON.parse(await copied(window)) as {
    mcpServers: { incarnamind: { command: string; args: string[]; env: Record<string, string> } };
  };
  await closeSettings(window);
  const { command, args, env } = settings.mcpServers.incarnamind;
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(new StdioClientTransport({ command, args, env, stderr: "pipe" }));
  return agent;
}

const tabRows = (outline: Locator) => outline.getByTestId("note-tab");

test("a tab an agent proposes waits with its first paragraph: Accept keeps it, ⌘Z and Reject take it out", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  try {
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    await setWindowSize(app, window, 1280, 800);
    const harbour = await withHarbour(window);
    await catchCopies(window);
    const mindId = await writeNote(window, "Harbourline Ferries", [
      { tab: "Summary" },
      { heading: "Harbourline Ferries", level: 1 },
      { text: "Sailings ran on time on most days." },
      { tab: "Fleet" },
      { text: "Two ferries were refitted over the winter." },
    ]);
    // Open before it moves into the Folder, as the User has their Note open.
    await pointAndClick(
      window,
      window.getByTestId("mind-list-item").filter({ hasText: "Harbourline Ferries" }),
    );
    const editor = window.getByTestId("mind-editor");
    await expect(editor).toBeVisible();
    await window.evaluate(
      async (place) => {
        await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.moveToFolder({
          mindIds: [place.mindId],
          folderId: place.folderId,
        });
      },
      { mindId, folderId: harbour },
    );

    const agent = await connectAgent(window);
    try {
      const read = await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } });
      const named = read.structuredContent as { markdown: string; version: string };
      expect(named.markdown).toContain("```tab\nFleet\n```\n\n¶2 Two ferries");
      const proposed = await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId,
          version: named.version,
          changes: [
            {
              paragraph: "¶2+",
              text: "```tab\nCosts\n```\n\nFuel cost 3.1 million in 2026.",
            },
          ],
        },
      });
      expect(proposed.isError ?? false).toBe(false);
      expect(proposed.structuredContent).toMatchObject({ status: "waiting", waiting: 1 });
    } finally {
      await agent.close();
    }

    await expect(window.getByTestId("proposals-count")).toHaveText("1 change waiting");
    const outline = window.getByTestId("outline");
    if (!(await outline.isVisible())) {
      await pointAndClick(window, window.getByTestId("outline-button"));
    }
    await expect(tabRows(outline)).toHaveText(["Summary", "Fleet", "Costs"]);

    // Opened, the tab shows what it holds as the change, its bar there to decide on.
    await pointAndClick(window, tabRows(outline).filter({ hasText: "Costs" }));
    const added = editor.locator("p.proposal-node--insert");
    await expect(added).toBeVisible();
    await expect(added).toHaveText("Fuel cost 3.1 million in 2026.");
    await pointAndClick(window, added);
    const bar = window.getByTestId("change-bar");
    await expect(bar).toBeVisible();
    await expect(bar.getByTestId("change-bar-author")).toHaveText("Proposed by Ferry agent");
    await shot(window, "agent-tab-waiting-en");
    await pointAndClick(window, bar.getByTestId("change-accept"));
    await expect(window.getByTestId("proposals-count")).toHaveCount(0);
    await expect(tabRows(outline)).toHaveText(["Summary", "Fleet", "Costs"]);
    await expect(editor.locator(":scope > p:visible")).toHaveText([
      "Fuel cost 3.1 million in 2026.",
    ]);

    await editor.focus();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(window.getByTestId("proposals-count")).toHaveText("1 change waiting");
    await pointAndClick(window, tabRows(outline).filter({ hasText: "Costs" }));
    await pointAndClick(window, added);
    await pointAndClick(window, bar.getByTestId("change-reject"));
    await expect(window.getByTestId("proposals-count")).toHaveCount(0);
    await expect(tabRows(outline)).toHaveText(["Summary", "Fleet"]);
    await expect(editor.getByText("Fuel cost 3.1 million")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
