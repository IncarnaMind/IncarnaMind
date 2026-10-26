import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { agentSocketPath } from "../../src/core/agents/socket";
import {
  agentSocketAnswers,
  cursorLaunch,
  cursorSettingsFromGuide,
  legacyAgentClient,
  modernAgentClient,
} from "../../tests/helpers/agentClients";
import { acceptPlainTextKeys, coreOf, dismissChatSetup, setWindowSize } from "../app";
import { launchPackaged, packagedExecutable, packagedLogLines } from "./app";

test.use({ trace: "off" });
test.setTimeout(3 * 60_000);

let folders: string[] = [];
let dataFolder: string | null = null;
test.afterEach(async () => {
  const info = test.info();
  if (dataFolder && info.status !== info.expectedStatus) {
    const log = (await packagedLogLines(dataFolder, /./))
      .join("\n")
      .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, "[redacted]");
    await mkdir(info.outputDir, { recursive: true });
    const path = info.outputPath("app.log");
    await writeFile(path, log);
    await info.attach("app-log", { path, contentType: "text/plain" });
    console.info(`Retained the failing app's data at ${dataFolder}`);
    folders = [];
    dataFolder = null;
    return;
  }
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
  folders = [];
  dataFolder = null;
});

for (const [protocol, documents] of [
  ["2025-11-25", false],
  ["2025-11-25", true],
  ["2026-07-28", false],
  ["2026-07-28", true],
] as const) {
  test(`with Documents ${documents ? "present" : "missing"}, the packaged shim searches and checks Citations with ${protocol}, and refuses unpaired, paused and revoked access`, async () => {
    expect(existsSync(packagedExecutable)).toBe(true);
    const home = await mkdtemp(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "incarnamind-mcp-home-"),
    );
    const data = await mkdtemp(join(tmpdir(), "incarnamind-mcp-data-"));
    const sources = await mkdtemp(join(tmpdir(), "incarnamind-mcp-sources-"));
    folders = [home, data, sources];
    dataFolder = data;
    expect(existsSync(join(home, "Documents"))).toBe(false);
    const file = join(sources, "Tides.md");
    await writeFile(file, "Spring tides happen at new moon and full moon.");
    const app = await test.step(
      "Launch the packaged app",
      () => launchPackaged(home, data, { testHooks: true, documents }),
      { box: true },
    );
    const connect = protocol === "2026-07-28" ? modernAgentClient : legacyAgentClient;
    try {
      const window = await test.step("Reach the app window", () => app.firstWindow(), {
        box: true,
      });
      expect(existsSync(join(home, "Documents"))).toBe(documents);
      await setWindowSize(app, window, 900, 700);
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      const core = await coreOf(window);
      expect(await core.evaluate((bridge) => bridge.getAgents())).toMatchObject({
        enabled: false,
        pairings: [],
      });
      const folder = await core.evaluate((bridge) =>
        bridge.createLibraryGroup({ name: "Coast", description: "Tides" }),
      );
      const added = await core.evaluate(
        (bridge, input) => bridge.addDocuments([input.file], { groupId: input.folder }),
        { file, folder: folder.id },
      );
      await expect
        .poll(() =>
          core.evaluate(
            async (bridge, id) =>
              (await bridge.listDocuments())
                .filter((document) => id.includes(document.id))
                .map((document) => document.status),
            added.added,
          ),
        )
        .toEqual(["ready"]);
      const hiddenFolder = await core.evaluate((bridge) =>
        bridge.createLibraryGroup({ name: "Private archive", description: "Not shared" }),
      );
      const hiddenFile = join(sources, "Private-tides.md");
      await writeFile(hiddenFile, "Spring tides have the private archive marker rosewood.");
      const hiddenAdded = await core.evaluate(
        (bridge, input) => bridge.addDocuments([input.file], { groupId: input.folder }),
        { file: hiddenFile, folder: hiddenFolder.id },
      );
      await expect
        .poll(() =>
          core.evaluate(
            async (bridge, id) =>
              (await bridge.listDocuments())
                .filter((document) => id.includes(document.id))
                .map((document) => document.status),
            hiddenAdded.added,
          ),
        )
        .toEqual(["ready"]);
      await core.evaluate((bridge) => bridge.setAgentsEnabled(true));
      const connected = await core.evaluate(
        (bridge, id) => bridge.setUpAgent({ client: "codex", folderIds: [id] }),
        folder.id,
      );
      expect(
        await readFile(join(home, ".agents", "skills", "incarnamind", "SKILL.md"), "utf8"),
      ).toContain("name: incarnamind");
      const launch = await core.evaluate(
        (bridge, id) => bridge.getAgentLaunch(id),
        connected.pairing.id,
      );
      expect(await realpath(launch.command)).toBe(await realpath(packagedExecutable));
      const socket = launch.env.INCARNAMIND_AGENT_SOCKET ?? "";
      if (process.platform === "win32") {
        expect(socket.startsWith("\\\\.\\pipe\\")).toBe(true);
        expect(socket === agentSocketPath(data, "win32")).toBe(true);
      }
      expect(await agentSocketAnswers(socket)).toBe(true);
      if (process.platform !== "win32") expect((await stat(socket)).mode & 0o777).toBe(0o600);
      const settings = join(home, ".cursor", "mcp.json");
      await mkdir(join(home, ".cursor"), { recursive: true });
      await writeFile(settings, await cursorSettingsFromGuide(launch), { mode: 0o600 });
      const client = await test.step(
        "Complete the pairing and MCP handshake using the Cursor guide's file",
        async () => connect(cursorLaunch(JSON.parse(await readFile(settings, "utf8")))),
        { box: true },
      );
      try {
        const found = await client.callTool({
          name: "search",
          arguments: { query: "spring tides new moon" },
        });
        const output = found.structuredContent as { passages: { cite: string | null }[] };
        const cite = output.passages[0]?.cite;
        expect(cite).toMatch(/^\[cite:[a-z0-9]{8}\]$/);
        const checked = await client.callTool({
          name: "check_citations",
          arguments: { text: `Spring tides come at new moon ${cite}.` },
        });
        expect(checked.structuredContent).toMatchObject({ citations: [{ check: "found" }] });
        const hidden = await client.callTool({
          name: "search",
          arguments: { query: "rosewood", folderIds: [hiddenFolder.id] },
        });
        expect(hidden.isError).toBe(true);
        await core.evaluate((bridge) => bridge.setLocalOnly(true));
        expect(
          (await client.callTool({ name: "search", arguments: { query: "spring tides" } })).isError,
        ).toBe(true);
        await core.evaluate((bridge) => bridge.setLocalOnly(false));
        await core.evaluate(
          (bridge, id) => bridge.updateAgent(id, { folderIds: [] }),
          connected.pairing.id,
        );
        expect(
          (await client.callTool({ name: "search", arguments: { query: "spring tides" } })).isError,
        ).toBe(true);
        const activity = await core.evaluate(
          (bridge, id) => bridge.listAgentActivity(id),
          connected.pairing.id,
        );
        expect(JSON.stringify(activity).includes(launch.env.INCARNAMIND_AGENT_TOKEN ?? "")).toBe(
          false,
        );
        await core.evaluate((bridge, id) => bridge.disconnectAgent(id), connected.pairing.id);
      } finally {
        await client.close();
      }
      const revoked = await connect(launch);
      try {
        expect(
          (await revoked.callTool({ name: "search", arguments: { query: "spring tides" } }))
            .isError,
        ).toBe(true);
      } finally {
        await revoked.close();
      }
      const unknown = await connect({
        ...launch,
        env: { ...launch.env, INCARNAMIND_AGENT_TOKEN: "unpaired-test-agent" },
      });
      try {
        expect(
          (await unknown.callTool({ name: "search", arguments: { query: "spring tides" } }))
            .isError,
        ).toBe(true);
      } finally {
        await unknown.close();
      }
      expect(existsSync(join(home, ".agents", "skills", "incarnamind", "SKILL.md"))).toBe(false);
      const log = (await packagedLogLines(data, /./)).join("\n");
      expect(log.includes(launch.env.INCARNAMIND_AGENT_TOKEN ?? "")).toBe(false);
    } finally {
      await app.close();
    }
  });
}
