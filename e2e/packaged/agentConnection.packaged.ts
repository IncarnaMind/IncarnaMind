import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cursorLaunch,
  cursorSettingsFromGuide,
  legacyAgentClient,
  modernAgentClient,
} from "../../tests/helpers/agentClients";
import { acceptPlainTextKeys, coreOf, dismissChatSetup, setWindowSize } from "../app";
import { launchPackaged, packagedExecutable, packagedLogLines } from "./app";

test.use({ trace: "off" });
test.setTimeout(3 * 60_000);

for (const protocol of ["2025-11-25", "2026-07-28"] as const) {
  test(`the packaged shim searches and checks Citations with ${protocol}, and refuses unpaired, paused and revoked access`, async () => {
    expect(existsSync(packagedExecutable)).toBe(true);
    const home = await mkdtemp(
      join(process.platform === "win32" ? tmpdir() : "/tmp", "incarnamind-mcp-home-"),
    );
    const data = await mkdtemp(join(tmpdir(), "incarnamind-mcp-data-"));
    const sources = await mkdtemp(join(tmpdir(), "incarnamind-mcp-sources-"));
    const file = join(sources, "Tides.md");
    await writeFile(file, "Spring tides happen at new moon and full moon.");
    const app = await launchPackaged(home, data, { testHooks: true });
    const connect = protocol === "2026-07-28" ? modernAgentClient : legacyAgentClient;
    try {
      const window = await app.firstWindow();
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
      if (process.platform !== "win32")
        expect((await stat(launch.env.INCARNAMIND_AGENT_SOCKET ?? "")).mode & 0o777).toBe(0o600);
      const settings = join(home, ".cursor", "mcp.json");
      await mkdir(join(home, ".cursor"), { recursive: true });
      await writeFile(settings, await cursorSettingsFromGuide(launch), { mode: 0o600 });
      const client = await connect(cursorLaunch(JSON.parse(await readFile(settings, "utf8"))));
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
      for (const folder of [home, data, sources])
        await rm(folder, { recursive: true, force: true });
    }
  });
}
