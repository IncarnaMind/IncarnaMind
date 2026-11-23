import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import {
  acceptPlainTextKeys,
  createDataFolder,
  expectReadyDocuments,
  launchApp,
  removeDataFolder,
} from "./app";

test.skip(
  !SHOW_AGENT_CONNECTION,
  "The agent socket stays closed while SHOW_AGENT_CONNECTION is false.",
);

/*
 * Outside agents (#351): an agent's MCP client starts IncarnaMind's server as
 * the app gives it to the agent, the app's own binary running the shim the
 * build ships as plain Node, and reaches the running app through its socket.
 * The pairing is made through the bridge here; its Settings page comes later.
 */

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

test("an agent reaches the app through the shipped shim, and cites only its Folder", async () => {
  const tides = join(sources, "Tides.md");
  await writeFile(
    tides,
    "# Tides\n\nSpring tides happen twice a month, at new moon and full moon, when the sun and the moon pull in line.\n",
  );
  const { window } = await launchApp(dataDir);
  // Linux with no keyring running (CI): the pairing's key is kept as other keys are, once allowed.
  await acceptPlainTextKeys(window);
  const launch = await window.evaluate(async (path) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const coast = await bridge.createLibraryGroup({ name: "Coast", description: "The sea." });
    await bridge.addDocuments([path], { groupId: coast.id });
    await bridge.setAgentsEnabled(true);
    return (await bridge.connectAgent({ name: "Test agent", folderIds: [coast.id] })).launch;
  }, tides);
  await expectReadyDocuments(window, 1);

  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(
    new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      env: launch.env,
      stderr: "pipe",
    }),
  );
  try {
    const found = await agent.callTool({
      name: "search",
      arguments: { query: "spring tides new moon" },
    });
    const passages = (found.structuredContent as { passages: { passageId: string }[] }).passages;
    expect(passages.length).toBeGreaterThan(0);
    const cited = await agent.callTool({
      name: "cite",
      arguments: {
        citations: [
          {
            passageId: passages[0]?.passageId,
            quote: "Spring tides happen twice a month, at new moon and full moon",
          },
        ],
      },
    });
    const cite =
      (cited.structuredContent as { citations: { cite: string | null }[] }).citations[0]?.cite ??
      "";
    expect(cite).toMatch(/^\[cite:[a-z0-9]{8}\]$/);

    const checked = await agent.callTool({
      name: "check_citations",
      arguments: { text: `Spring tides come at new and full moon ${cite}.` },
    });
    expect(checked.structuredContent).toMatchObject({ citations: [{ check: "found" }] });

    // Chat apps won't open links of IncarnaMind's: the agent asks it to show the Citation.
    const shown = await agent.callTool({ name: "show_citation", arguments: { cite } });
    expect(shown.isError ?? false).toBe(false);
    await expect(window.getByTestId("viewer-title")).toContainText("Tides");
  } finally {
    await agent.close();
  }
});
