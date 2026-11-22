/**
 * Setting IncarnaMind up in the User's agent from Settings → AI (#351):
 * one click where the agent allows it, the key handed over behind the scenes,
 * the agent's settings file written only as shown, with Undo, and tidied when
 * the agent is disconnected. Every path is in a temporary home folder.
 */
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentLaunch, Core } from "../../src/core";
import { SERVER_INSTRUCTIONS } from "../../src/core/agents/mcp";
import { SKILL_MARKDOWN } from "../../src/core/agents/skill";
import { AGENT_CLIENT_IDS } from "../../src/core/api";
import { openPackage } from "../../src/core/documents/formats/zip";
import { agentsAdapter, buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";

const TOKEN_ENV = "INCARNAMIND_AGENT_TOKEN";

async function started() {
  const dataDir = await createTempDataFolder();
  const home = await createTempDataFolder();
  const applications = await createTempDataFolder();
  const tempDir = await createTempDataFolder();
  const links: string[] = [];
  const opened: string[] = [];
  const shim = await buildAgentShim();
  const core = startCore(dataDir, {
    paths: { dataDir, home, documents: join(dataDir, "Documents"), tempDir },
    agents: {
      ...(await agentsAdapter(dataDir)),
      shimScript: shim,
      applications: [applications],
      openLink: async (url) => {
        links.push(url);
      },
    },
    shell: {
      openPath: async (path) => {
        opened.push(path);
      },
      showItemInFolder: () => undefined,
    },
  });
  const sources = await createSourceFolder();
  const [tides] = await addAndProcess(core, [
    await writeSourceFile(
      sources,
      "Tides.md",
      "# Tides\n\nSpring tides come at new and full moon, when the sun and the moon pull in line.\n",
    ),
  ]);
  if (!tides) throw new Error("Nothing was added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.setAgentsEnabled(true);
  return { core, home, applications, links, opened, shim, coast };
}

/** The settings an agent was given, as it would start the server. */
const launchIn = (entry: { command: string; args: string[]; env: Record<string, string> }) =>
  entry satisfies AgentLaunch;

async function searchesThrough(core: Core, launch: AgentLaunch) {
  const agent = await connectLegacyAgent(launch);
  const found = await agent.callTool({ name: "search", arguments: { query: "spring tides" } });
  expect(found.isError ?? false).toBe(false);
  void core;
}

describe("setting an agent up", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("lists the agents on this computer first", async () => {
    const { core, home, applications } = await started();
    await mkdir(join(home, ".codex"));
    await mkdir(join(applications, "Cursor.app"));
    const clients = await core.listAgentClients();
    expect(clients.slice(0, 2).map((each) => [each.id, each.installed])).toEqual([
      ["codex", true],
      ["cursor", true],
    ]);
    expect(clients.at(-1)).toMatchObject({ id: "other", installed: false, setup: "manual" });
    // The agents in wide use, and "Other agent" for the rest (ADR-0019, #3374).
    expect(clients.map((each) => each.id).sort()).toEqual([...AGENT_CLIENT_IDS].sort());
    expect(clients.find((each) => each.id === "devin")?.otherNames).toContain("Windsurf");
    expect(clients.find((each) => each.id === "codex")?.name).toBe("ChatGPT app and Codex");
  });

  it("names a new Codex pairing in the interface language, and keeps the name it had", async () => {
    const { core, coast } = await started();
    const english = await core.setUpAgent({ client: "codex", folderIds: [coast.id] });
    expect(english.pairing.name).toBe("ChatGPT app and Codex");
    await core.updateSettings({ user: { language: "zh-CN" } });
    const chinese = await core.setUpAgent({ client: "codex", folderIds: [coast.id] });
    expect(chinese.pairing.name).toBe("ChatGPT 应用和 Codex");
    expect((await core.getAgents()).pairings.map((each) => each.name)).toContain(
      "ChatGPT app and Codex",
    );
  });

  it("writes Codex's settings as shown, works from them, and takes them back with Undo", async () => {
    const { core, home, coast } = await started();
    const path = join(home, ".codex", "config.toml");
    await mkdir(join(home, ".codex"));
    const theirs = 'model = "gpt-6-luna"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n';
    await writeFile(path, theirs);

    const preview = await core.previewAgentSetup("codex");
    expect(preview?.path).toBe(path);
    expect(preview?.change).toContain("[mcp_servers.incarnamind]");
    expect(preview?.change).toContain("•••••••");

    const { pairing, result } = await core.setUpAgent({ client: "codex", folderIds: [coast.id] });
    expect(result).toEqual({ kind: "wrote", path });
    expect(pairing).toMatchObject({
      name: "ChatGPT app and Codex",
      client: "codex",
      folderIds: [coast.id],
    });
    const written = await readFile(path, "utf8");
    expect(written.startsWith(theirs.trimEnd())).toBe(true);
    const token = (await core.getAgentLaunch(pairing.id)).env[TOKEN_ENV] ?? "";
    expect(written).toContain(`INCARNAMIND_AGENT_TOKEN = "${token}"`);
    // `ask` can run close to Codex's default 60 s Tool timeout.
    expect(written).toContain("tool_timeout_sec = 120");
    await searchesThrough(core, await core.getAgentLaunch(pairing.id));

    await core.undoAgentSetup(pairing.id);
    expect(await readFile(path, "utf8")).toBe(theirs);
    expect((await core.getAgents()).pairings).toEqual([]);
  });

  it.each([
    ["antigravity", [".gemini", "config", "mcp_config.json"], "Antigravity"],
    ["workbuddy", [".workbuddy", "mcp.json"], "WorkBuddy"],
    ["vscode", [".copilot", "mcp-config.json"], "VS Code"],
    ["cline", [".cline", "data", "settings", "cline_mcp_settings.json"], "Cline"],
    ["kimi-code", [".kimi-code", "mcp.json"], "Kimi Code"],
  ] as const)(
    "adds itself to %s's own mcpServers file, keeps the User's servers, and leaves when disconnected",
    async (client, segments, name) => {
      const { core, home, coast } = await started();
      const path = join(home, ...segments);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ theme: "dark", mcpServers: { notes: { command: "n" } } }),
      );

      const preview = await core.previewAgentSetup(client);
      expect(preview?.path).toBe(path);
      const { pairing, result } = await core.setUpAgent({ client, folderIds: [coast.id] });
      expect(result).toEqual({ kind: "wrote", path });
      expect(pairing.name).toBe(name);
      const settings = JSON.parse(await readFile(path, "utf8"));
      expect(settings.theme).toBe("dark");
      expect(Object.keys(settings.mcpServers)).toEqual(["notes", "incarnamind"]);
      await searchesThrough(core, launchIn(settings.mcpServers.incarnamind));
      // Copied again from its Details, it comes in the same shape.
      const again = JSON.parse((await core.copyAgentSetup(pairing.id)).text);
      expect(again.mcpServers.incarnamind).toEqual(settings.mcpServers.incarnamind);

      await core.disconnectAgent(pairing.id);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        theme: "dark",
        mcpServers: { notes: { command: "n" } },
      });
    },
  );

  describe("Disconnect and the settings file IncarnaMind made", () => {
    /** Connects, quits and starts again on the same folders, as a restart does. */
    async function restarted(
      client: "workbuddy" | "antigravity" | "codex" | "vscode" | "cline" | "kimi-code",
      existing?: { file: readonly string[]; text: string },
    ) {
      const dataDir = await createTempDataFolder();
      const home = await createTempDataFolder();
      const tempDir = await createTempDataFolder();
      const keychain = createMemoryKeychain();
      const start = async () =>
        startCore(dataDir, {
          keychain,
          paths: { dataDir, home, documents: join(dataDir, "Documents"), tempDir },
          agents: {
            ...(await agentsAdapter(dataDir)),
            shimScript: await buildAgentShim(),
            applications: [await createTempDataFolder()],
          },
        });
      const first = await start();
      await first.setAgentsEnabled(true);
      const coast = await first.createLibraryGroup({ name: "Coast", description: "The sea." });
      if (existing) {
        await mkdir(join(home, ...existing.file.slice(0, -1)), { recursive: true });
        await writeFile(join(home, ...existing.file), existing.text);
      }
      const { pairing } = await first.setUpAgent({ client, folderIds: [coast.id] });
      first.close();
      return { core: await start(), home, pairing, coast };
    }

    it.each([
      ["workbuddy", ".workbuddy", [".workbuddy", "mcp.json"]],
      ["antigravity", ".gemini", [".gemini", "config", "mcp_config.json"]],
      ["codex", ".codex", [".codex", "config.toml"]],
      ["vscode", ".copilot", [".copilot", "mcp-config.json"]],
      ["cline", ".cline", [".cline", "data", "settings", "cline_mcp_settings.json"]],
      ["kimi-code", ".kimi-code", [".kimi-code", "mcp.json"]],
    ] as const)(
      "takes away the file and the folder it made for %s, and the agent stays among those not on this computer",
      async (client, folder, file) => {
        const { core, home, pairing } = await restarted(client);
        expect(await readFile(join(home, ...file), "utf8")).toContain("incarnamind");
        expect((await core.listAgentClients()).find((each) => each.id === client)?.installed).toBe(
          true,
        );
        await core.disconnectAgent(pairing.id);
        await expect(stat(join(home, folder))).rejects.toThrow(/ENOENT/);
        expect((await core.listAgentClients()).find((each) => each.id === client)?.installed).toBe(
          false,
        );
      },
    );

    it("Undo takes the folder it made away too", async () => {
      const { core, home, coast } = await started();
      const { pairing } = await core.setUpAgent({ client: "workbuddy", folderIds: [coast.id] });
      await core.undoAgentSetup(pairing.id);
      await expect(stat(join(home, ".workbuddy"))).rejects.toThrow(/ENOENT/);
    });

    it.each([
      [
        "codex",
        [".codex", "config.toml"],
        'model = "gpt-6-luna"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n',
      ],
      [
        "antigravity",
        [".gemini", "config", "mcp_config.json"],
        `${JSON.stringify({ theme: "dark", mcpServers: { notes: { command: "n" } } }, null, 2)}\n`,
      ],
    ] as const)(
      "keeps the %s file that was there before, byte for byte",
      async (client, file, text) => {
        const { core, home, pairing } = await restarted(client, { file, text });
        await core.disconnectAgent(pairing.id);
        expect(await readFile(join(home, ...file), "utf8")).toBe(text);
      },
    );

    it("keeps a file it made once the User added a server of their own, with only that server left", async () => {
      const { core, home, pairing } = await restarted("workbuddy");
      const path = join(home, ".workbuddy", "mcp.json");
      const settings = JSON.parse(await readFile(path, "utf8"));
      settings.mcpServers.notes = { command: "n" };
      await writeFile(path, JSON.stringify(settings));
      await core.disconnectAgent(pairing.id);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        mcpServers: { notes: { command: "n" } },
      });
    });
  });

  it("leaves a settings file it can't read alone, and gives the settings to paste instead", async () => {
    const { core, home, coast } = await started();
    const path = join(home, ".workbuddy", "mcp.json");
    await mkdir(join(home, ".workbuddy"));
    await writeFile(path, "{ // comments aren't JSON\n}");
    const { pairing, result } = await core.setUpAgent({
      client: "workbuddy",
      folderIds: [coast.id],
    });
    expect(result).toMatchObject({ kind: "copy", how: "settings", path });
    expect(await readFile(path, "utf8")).toBe("{ // comments aren't JSON\n}");
    if (result.kind !== "copy") throw new Error("Expected settings to copy.");
    const token = (await core.getAgentLaunch(pairing.id)).env[TOKEN_ENV] ?? "";
    expect(result.text).toContain(token);
    expect(result.shown).not.toContain(token);
  });

  it.each(["opencode", "openclaw", "gemini-cli", "qwen-code"] as const)(
    "gives %s a line to run that starts the server, and writes none of its settings",
    async (client) => {
      const { core, home, coast } = await started();
      const { pairing, result } = await core.setUpAgent({ client, folderIds: [coast.id] });
      if (result.kind !== "copy") throw new Error("Expected a line to copy.");
      const token = (await core.getAgentLaunch(pairing.id)).env[TOKEN_ENV] ?? "";
      expect(result.how).toBe("command");
      expect(result.text).toContain(token);
      expect(result.shown).not.toContain(token);
      expect((await core.copyAgentSetup(pairing.id)).text).toBe(result.text);
      // Only the Skill, in the shared folder these agents read.
      expect(await readdir(home)).toEqual([".agents"]);
      await core.disconnectAgent(pairing.id);
      expect(await readdir(home)).toEqual([]);
    },
  );

  it("leaves the settings an agent's own line wrote to that agent when it is disconnected", async () => {
    const { core, home, coast } = await started();
    const { pairing } = await core.setUpAgent({ client: "gemini-cli", folderIds: [coast.id] });
    // What `gemini mcp add -s user` wrote when the User ran the line: Gemini CLI's, not ours.
    const path = join(home, ".gemini", "settings.json");
    await mkdir(join(home, ".gemini"));
    const theirs = JSON.stringify({
      mcpServers: { incarnamind: launchIn(await core.getAgentLaunch(pairing.id)) },
    });
    await writeFile(path, theirs);
    await core.disconnectAgent(pairing.id);
    expect(await readFile(path, "utf8")).toBe(theirs);
    expect((await core.getAgents()).pairings).toEqual([]);
  });

  it.each(["devin", "zed", "trae", "qoder", "codebuddy", "minimax-code", "kilo-code"] as const)(
    "gives %s the settings to paste into its own screen, and writes nothing but a Skill",
    async (client) => {
      const { core, home, coast } = await started();
      const { pairing, result } = await core.setUpAgent({ client, folderIds: [coast.id] });
      if (result.kind !== "copy") throw new Error("Expected settings to copy.");
      expect(result.how).toBe("settings");
      const pasted = JSON.parse(result.text);
      await searchesThrough(core, launchIn(pasted.mcpServers?.incarnamind ?? pasted.incarnamind));
      for (const name of await readdir(home)) {
        expect([".agents", ".qoder", ".codebuddy", ".kilo", ".config"].includes(name), name).toBe(
          true,
        );
      }
      await core.disconnectAgent(pairing.id);
      expect(await readdir(home)).toEqual([]);
    },
  );

  it('gives "Other agent" settings an MCP client can start, under the name the User types', async () => {
    const { core, coast } = await started();
    const { pairing, result } = await core.setUpAgent({
      client: "other",
      folderIds: [coast.id],
      name: "Research bot",
    });
    expect(pairing.name).toBe("Research bot");
    if (result.kind !== "copy") throw new Error("Expected settings to copy.");
    expect(result).toMatchObject({ how: "settings" });
    const settings = JSON.parse(result.text);
    await searchesThrough(core, launchIn(settings.mcpServers.incarnamind));
  });

  it("opens Cursor on its own install link", async () => {
    const { core, links, coast } = await started();
    const cursor = await core.setUpAgent({ client: "cursor", folderIds: [coast.id] });
    expect(cursor.result).toEqual({ kind: "opened", how: "link" });

    const cursorUrl = new URL(links[0] ?? "");
    expect(cursorUrl.protocol).toBe("cursor:");
    const config = JSON.parse(
      Buffer.from(cursorUrl.searchParams.get("config") ?? "", "base64").toString(),
    );
    await searchesThrough(core, launchIn(config));
  });

  it("opens Claude on an install bundle carrying the shim, in English and Chinese", async () => {
    const { core, opened, shim, coast } = await started();
    const { pairing, result } = await core.setUpAgent({
      client: "claude-desktop",
      folderIds: [coast.id],
    });
    expect(result).toEqual({ kind: "opened", how: "bundle" });
    expect(opened[0]).toMatch(/IncarnaMind\.mcpb$/);
    const bundle = openPackage(await readFile(opened[0] ?? ""));
    const manifest = JSON.parse(new TextDecoder().decode(await bundle.read("manifest.json")));
    expect(manifest).toMatchObject({
      manifest_version: "0.3",
      name: "incarnamind",
      server: { type: "node", entry_point: "server/index.js" },
    });
    const token = (await core.getAgentLaunch(pairing.id)).env[TOKEN_ENV];
    expect(manifest.server.mcp_config.env[TOKEN_ENV]).toBe(token);
    expect(manifest.server.mcp_config.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(Buffer.from((await bundle.read("server/index.js")) ?? [])).toEqual(await readFile(shim));
    const zh = JSON.parse(
      new TextDecoder().decode(await bundle.read("mcpb-resources/zh-Hans.json")),
    );
    expect(zh.description).toMatch(/引文/);
  });

  describe("Claude Code's settings file (#3487)", () => {
    const FILE = [".claude.json"] as const;
    /** What Claude Code keeps in its own file, beside the servers. */
    const theirs = {
      firstStartTime: "2026-11-20T15:59:24.401Z",
      userID: "b0ed6c26",
      numStartups: 41,
      projects: { "/Users/ada/work": { allowedTools: [], history: ["one", "two"] } },
      mcpServers: { notes: { type: "stdio", command: "n", args: [], env: {} } },
    };
    const text = `${JSON.stringify(theirs, null, 2)}\n`;

    it("adds itself to the file, shown first, keeps all the rest and a copy of it, and works", async () => {
      const { core, home, coast } = await started();
      const path = join(home, ...FILE);
      await writeFile(path, text, { mode: 0o640 });

      const preview = await core.previewAgentSetup("claude-code");
      expect(preview).toMatchObject({ path, backup: `${path}.incarnamind-backup` });
      expect(JSON.parse(preview?.change ?? "").mcpServers.incarnamind.type).toBe("stdio");
      expect(preview?.change).toContain("•••••••");

      const { pairing, result } = await core.setUpAgent({
        client: "claude-code",
        folderIds: [coast.id],
      });
      expect(result).toEqual({ kind: "wrote", path });
      const settings = JSON.parse(await readFile(path, "utf8"));
      expect({ ...settings, mcpServers: { notes: settings.mcpServers.notes } }).toEqual(theirs);
      expect(Object.keys(settings.mcpServers)).toEqual(["notes", "incarnamind"]);
      expect(settings.mcpServers.incarnamind.type).toBe("stdio");
      // The file keeps its mode; the copy, which holds the User's account, is for them alone.
      expect((await stat(path)).mode & 0o777).toBe(0o640);
      expect(await readFile(`${path}.incarnamind-backup`, "utf8")).toBe(text);
      expect((await stat(`${path}.incarnamind-backup`)).mode & 0o777).toBe(0o600);
      expect((await readdir(home)).filter((name) => name.includes("incarnamind-new"))).toEqual([]);
      await searchesThrough(core, launchIn(settings.mcpServers.incarnamind));
      // Its Details still give the line Claude Code documents.
      expect((await core.copyAgentSetup(pairing.id)).text).toMatch(/^claude mcp add --scope user /);

      await core.disconnectAgent(pairing.id);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(theirs);
      await expect(stat(`${path}.incarnamind-backup`)).rejects.toThrow(/ENOENT/);
    });

    it("makes the file when Claude Code has made none, and takes it away again", async () => {
      const { core, home, coast } = await started();
      const path = join(home, ...FILE);
      expect((await core.previewAgentSetup("claude-code"))?.backup).toBeNull();
      const { pairing } = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
      expect(Object.keys(JSON.parse(await readFile(path, "utf8")))).toEqual(["mcpServers"]);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(stat(`${path}.incarnamind-backup`)).rejects.toThrow(/ENOENT/);
      await core.disconnectAgent(pairing.id);
      expect(await readdir(home)).toEqual([]);
    });

    it.each([
      ["comments", "{ // Claude Code doesn't write these\n}"],
      ["a list", "[1, 2]"],
      ["a number it can't keep", '{"messageCount": 12345678901234567890, "mcpServers": {}}'],
      ["servers that aren't an object", '{"mcpServers": []}'],
    ])(
      "leaves a file with %s alone, with no copy, and gives the line to run instead",
      async (_name, given) => {
        const { core, home, coast } = await started();
        const path = join(home, ...FILE);
        await writeFile(path, given);
        const { pairing, result } = await core.setUpAgent({
          client: "claude-code",
          folderIds: [coast.id],
        });
        expect(result).toMatchObject({ kind: "copy", how: "command", path });
        if (result.kind !== "copy") throw new Error("Expected a line to copy.");
        expect(result.text).toMatch(/^claude mcp add --scope user incarnamind --env /);
        const token = (await core.getAgentLaunch(pairing.id)).env[TOKEN_ENV] ?? "";
        expect(result.text).toContain(token);
        expect(result.shown).not.toContain(token);
        expect(await readFile(path, "utf8")).toBe(given);
        expect((await readdir(home)).filter((name) => name.includes("backup"))).toEqual([]);
      },
    );

    it("takes only its own entry out once Claude Code has rewritten the file, on Undo and on Disconnect", async () => {
      for (const leave of ["undo", "disconnect"] as const) {
        const { core, home, coast } = await started();
        const path = join(home, ...FILE);
        await writeFile(path, text);
        const { pairing } = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
        // Claude Code adds its own state at its next start, and the User a server.
        const now = JSON.parse(await readFile(path, "utf8"));
        now.numStartups = 42;
        now.mcpServers.mine = { type: "stdio", command: "m", args: [], env: {} };
        await writeFile(path, JSON.stringify(now));
        if (leave === "undo") await core.undoAgentSetup(pairing.id);
        else await core.disconnectAgent(pairing.id);
        delete now.mcpServers.incarnamind;
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual(now);
        await expect(stat(`${path}.incarnamind-backup`)).rejects.toThrow(/ENOENT/);
      }
    });

    it("leaves no empty server list behind in a file that had none", async () => {
      const { core, home, coast } = await started();
      const path = join(home, ...FILE);
      const given = `${JSON.stringify({ userID: "b0ed6c26", numStartups: 3 }, null, 2)}\n`;
      await writeFile(path, given);
      const { pairing } = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
      await core.disconnectAgent(pairing.id);
      expect(await readFile(path, "utf8")).toBe(given);
    });

    it("keeps its copy on Undo until the last Claude Code pairing goes, as Disconnect does", async () => {
      for (const first of ["second", "first"] as const) {
        const { core, home, coast } = await started();
        const path = join(home, ...FILE);
        await writeFile(path, text);
        const one = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
        const two = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
        const [early, late] = first === "second" ? [two, one] : [one, two];
        await core.undoAgentSetup(early.pairing.id);
        expect(await readFile(`${path}.incarnamind-backup`, "utf8")).toBe(text);
        if (first === "second") await core.undoAgentSetup(late.pairing.id);
        else await core.disconnectAgent(late.pairing.id);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual(theirs);
        await expect(stat(`${path}.incarnamind-backup`)).rejects.toThrow(/ENOENT/);
      }
    });

    it("keeps its copy until the last Claude Code pairing goes", async () => {
      const { core, home, coast } = await started();
      const path = join(home, ...FILE);
      await writeFile(path, text);
      const first = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
      const second = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
      // The second one's entry took the place of the first's: leaving the first changes nothing.
      const both = await readFile(path, "utf8");
      await core.disconnectAgent(first.pairing.id);
      expect(await readFile(path, "utf8")).toBe(both);
      expect(await readFile(`${path}.incarnamind-backup`, "utf8")).toBe(text);
      await core.disconnectAgent(second.pairing.id);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(theirs);
      await expect(stat(`${path}.incarnamind-backup`)).rejects.toThrow(/ENOENT/);
    });
  });

  describe("a settings file the User keeps as a link, as a dotfiles manager does (#3487)", () => {
    const AGENTS = [
      { client: "claude-code", folder: [], name: ".claude.json", keeps: '"userID": "b0ed6c26"' },
      { client: "codex", folder: [".codex"], name: "config.toml", keeps: 'model = "gpt-6-luna"' },
    ] as const;
    const ours = (name: string) =>
      name.endsWith(".json") ? '{\n  "userID": "b0ed6c26"\n}\n' : 'model = "gpt-6-luna"\n';

    it.each(
      AGENTS.flatMap((agent) => [
        [agent.client, "absolute", agent] as const,
        [agent.client, "relative", agent] as const,
      ]),
    )(
      "%s: a %s link stays a link, its target holds the entry, and Disconnect puts the target back",
      async (_client, kind, agent) => {
        const { core, home, coast } = await started();
        const managed = await createTempDataFolder();
        const target = join(managed, agent.name);
        await writeFile(target, ours(agent.name), { mode: 0o640 });
        await mkdir(join(home, ...agent.folder), { recursive: true });
        const path = join(home, ...agent.folder, agent.name);
        await symlink(kind === "relative" ? relative(join(path, ".."), target) : target, path);

        const { pairing, result } = await core.setUpAgent({
          client: agent.client,
          folderIds: [coast.id],
        });
        expect(result).toEqual({ kind: "wrote", path });
        expect((await lstat(path)).isSymbolicLink()).toBe(true);
        expect(await readlink(path)).toBe(
          kind === "relative" ? relative(join(path, ".."), target) : target,
        );
        expect(await readFile(target, "utf8")).toContain("incarnamind");
        expect(await readFile(target, "utf8")).toContain(agent.keeps);
        expect((await stat(target)).mode & 0o777).toBe(0o640);
        expect(await readdir(managed)).toEqual([agent.name]);
        expect(
          (await readdir(join(home, ...agent.folder))).filter((name) => name.includes("-new")),
        ).toEqual([]);

        await core.disconnectAgent(pairing.id);
        expect((await lstat(path)).isSymbolicLink()).toBe(true);
        expect(await readFile(target, "utf8")).not.toContain("incarnamind");
        expect(await readdir(managed)).toEqual([agent.name]);
      },
    );

    it("keeps the copy of Claude Code's file beside the link the User knows, not its target", async () => {
      const { core, home, coast } = await started();
      const managed = await createTempDataFolder();
      const target = join(managed, "claude.json");
      await writeFile(target, ours(".claude.json"));
      const path = join(home, ".claude.json");
      await symlink(target, path);
      const { pairing } = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
      expect(await readFile(`${path}.incarnamind-backup`, "utf8")).toBe(ours(".claude.json"));
      expect(await readdir(managed)).toEqual(["claude.json"]);
      await core.disconnectAgent(pairing.id);
      await expect(stat(`${path}.incarnamind-backup`)).rejects.toThrow(/ENOENT/);
    });

    it.each(AGENTS)(
      "%s: a link to nothing is left alone, and the User is given the line or the settings",
      async (agent) => {
        const { core, home, coast } = await started();
        const managed = await createTempDataFolder();
        const target = join(managed, agent.name);
        await mkdir(join(home, ...agent.folder), { recursive: true });
        const path = join(home, ...agent.folder, agent.name);
        await symlink(target, path);

        const { result } = await core.setUpAgent({ client: agent.client, folderIds: [coast.id] });
        expect(result.kind).toBe("copy");
        expect((await lstat(path)).isSymbolicLink()).toBe(true);
        expect(await readlink(path)).toBe(target);
        await expect(stat(target)).rejects.toThrow(/ENOENT/);
        expect(await readdir(managed)).toEqual([]);
        expect(
          (await readdir(join(home, ...agent.folder))).filter(
            (name) => name.includes("backup") || name.includes("-new"),
          ),
        ).toEqual([]);
      },
    );
  });

  describe("set-ups and a Disconnect at once on one settings file (#3487)", () => {
    const FILES = [
      {
        client: "claude-code",
        path: [".claude.json"],
        text: `${JSON.stringify({ userID: "b0ed6c26", mcpServers: { notes: { type: "stdio", command: "n", args: [], env: {} } } }, null, 2)}\n`,
        entries: (text: string) => Object.keys(JSON.parse(text).mcpServers ?? {}),
        mine: (text: string) => (text.match(/"INCARNAMIND_AGENT_TOKEN": "([^"]+)"/g) ?? []).length,
      },
      {
        client: "codex",
        path: [".codex", "config.toml"],
        text: 'model = "gpt-6-luna"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n',
        entries: (text: string) =>
          [...text.matchAll(/^\[mcp_servers\.([\w-]+)\]/gm)].map((found) => found[1] ?? ""),
        mine: (text: string) => (text.match(/INCARNAMIND_AGENT_TOKEN = "[^"]+"/g) ?? []).length,
      },
    ] as const;

    it.each(FILES)(
      "$client: each ends with the User's own entries and exactly one of its own, none lost to another's write",
      async ({ client, path: parts, text, entries, mine }) => {
        const { core, home, coast } = await started();
        const path = join(home, ...parts);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, text);
        const userEntries = entries(text);
        const set = () => core.setUpAgent({ client, folderIds: [coast.id] });

        let leaving = await set();
        for (let round = 0; round < 5; round++) {
          const settled = await Promise.all([
            set(),
            set(),
            core.disconnectAgent(leaving.pairing.id),
          ]);
          const [one, two] = settled;
          if (!one || !two) throw new Error("A set-up gave nothing.");
          expect(one.result).toMatchObject({ kind: "wrote" });
          expect(two.result).toMatchObject({ kind: "wrote" });
          const now = await readFile(path, "utf8");
          // The User's entries are all there, and one of IncarnaMind's, whose key is a pairing still connected.
          expect(entries(now)).toEqual([...userEntries, "incarnamind"]);
          expect(mine(now)).toBe(1);
          const keys = await Promise.all(
            [one, two].map(
              async (each) => (await core.getAgentLaunch(each.pairing.id)).env[TOKEN_ENV] ?? "",
            ),
          );
          expect(keys.some((key) => key !== "" && now.includes(key))).toBe(true);
          expect((await readdir(join(path, ".."))).filter((name) => name.includes("-new"))).toEqual(
            [],
          );
          if (client === "claude-code") {
            expect(await readFile(`${path}.incarnamind-backup`, "utf8")).toBe(text);
          }
          // The one whose key is in the file leaves in the next round; the other, whose entry is gone, now.
          const inFile = keys[0] !== "" && now.includes(keys[0] ?? "") ? one : two;
          await core.disconnectAgent((inFile === one ? two : one).pairing.id);
          leaving = inFile;
        }
        await core.disconnectAgent(leaving.pairing.id);
        expect(await readFile(path, "utf8")).toBe(text);
        await expect(stat(`${path}.incarnamind-backup`)).rejects.toThrow(/ENOENT/);
      },
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "leaves a settings file as it was, and no copy of it, when it can't be replaced",
    async () => {
      const { core, home, coast } = await started();
      // The link's folder takes no new file, so the copy beside the link is made and the write then fails, as a rename can on Windows.
      const managed = await createTempDataFolder();
      const target = join(managed, "claude.json");
      const given = `${JSON.stringify({ userID: "b0ed6c26" })}\n`;
      await writeFile(target, given);
      const path = join(home, ".claude.json");
      await symlink(target, path);
      await chmod(managed, 0o500);
      try {
        const { result } = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
        expect(result).toMatchObject({ kind: "copy", how: "command", path });
        expect(await readFile(target, "utf8")).toBe(given);
        await expect(stat(`${path}.incarnamind-backup`)).rejects.toThrow(/ENOENT/);
      } finally {
        await chmod(managed, 0o700);
      }
    },
  );

  it("on Windows writes the same file in the home, and gives the line in Windows' quoting when it can't", async () => {
    const real = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    let setup: Awaited<ReturnType<typeof started>>;
    try {
      setup = await started();
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: real });
    }
    const { core, home, coast } = setup;
    const path = join(home, ".claude.json");
    await writeFile(path, '{"userID": "b0ed6c26"}\n');
    const connected = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
    expect(connected.result).toEqual({ kind: "wrote", path });
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers.incarnamind.type).toBe("stdio");
    await core.disconnectAgent(connected.pairing.id);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ userID: "b0ed6c26" });

    await writeFile(path, "[1]");
    const { result } = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
    if (result.kind !== "copy") throw new Error("Expected a line to copy.");
    expect(result.text).toMatch(/^claude mcp add --scope user incarnamind --env "/);
    expect(result.text).not.toContain("'");
  });

  it("leaves no pairing when the agent's app can't be opened", async () => {
    const { core, links, coast } = await started();
    links.push = () => {
      throw new Error("No app can open this link.");
    };
    await expect(core.setUpAgent({ client: "cursor", folderIds: [coast.id] })).rejects.toThrow(
      /No app/,
    );
    expect((await core.getAgents()).pairings).toEqual([]);
  });

  it("names a second copy of the same agent apart, and needs a Folder", async () => {
    const { core, coast } = await started();
    await core.setUpAgent({ client: "other", folderIds: [coast.id] });
    const second = await core.setUpAgent({ client: "other", folderIds: [coast.id] });
    expect(second.pairing.name).toBe("Other agent 2");
    await expect(core.setUpAgent({ client: "codex", folderIds: [] })).rejects.toThrow(/Folder/);
  });

  it("shows a Citation an agent asks to show, in front", async () => {
    const { core, coast } = await started();
    const { pairing } = await core.setUpAgent({ client: "other", folderIds: [coast.id] });
    const agent = await connectLegacyAgent(await core.getAgentLaunch(pairing.id));
    const found = await agent.callTool({ name: "search", arguments: { query: "spring tides" } });
    const cite = (found.structuredContent as { passages: { cite: string }[] }).passages[0]?.cite;
    const shown = vi.fn();
    core.on("agents.citationShown", shown);

    const result = await agent.callTool({ name: "show_citation", arguments: { cite } });
    expect(result.isError ?? false).toBe(false);
    expect(shown).toHaveBeenCalledWith(
      expect.objectContaining({
        quote: expect.stringContaining("Spring tides come at new and full moon"),
        citation: expect.objectContaining({ check: "found" }),
      }),
    );
    const unknown = await agent.callTool({
      name: "show_citation",
      arguments: { cite: "[cite:zzzzzzzz]" },
    });
    expect(unknown.isError).toBe(true);
  });
});

describe("a connection whose program has moved (#3644)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a connection whose entry starts a program that is no longer there (an AppImage's from an earlier start, an app moved since) says it needs repair, and Repair writes that entry again with IncarnaMind as it is now, keeping the rest of the file; fails_when=a broken connection reads as working, Repair changes anything but IncarnaMind's own entry, or the repaired agent can't reach IncarnaMind
  it("says so for Claude Code's and Codex's entries, and Repair writes each again", async () => {
    const { core, home, coast } = await started();
    const gone = join(home, "gone", ".mount_x7Kq", "incarnamind");
    const claude = join(home, ".claude.json");
    const theirs = { numStartups: 3, mcpServers: { notes: { command: "n", args: [], env: {} } } };
    await writeFile(claude, `${JSON.stringify(theirs, null, 2)}\n`);
    await mkdir(join(home, ".codex"));
    const codex = join(home, ".codex", "config.toml");
    const codexTheirs = 'model = "gpt-6-luna"\n';
    await writeFile(codex, codexTheirs);
    const claudeCode = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
    const chatgpt = await core.setUpAgent({ client: "codex", folderIds: [coast.id] });
    expect(await core.agentNeedsRepair(claudeCode.pairing.id)).toBe(false);
    expect(await core.agentNeedsRepair(chatgpt.pairing.id)).toBe(false);

    // The program each entry names goes, as an AppImage's mount does when it quits.
    const written = JSON.parse(await readFile(claude, "utf8"));
    written.mcpServers.incarnamind.command = gone;
    await writeFile(claude, JSON.stringify(written, null, 2));
    const launch = await core.getAgentLaunch(chatgpt.pairing.id);
    const table = await readFile(codex, "utf8");
    await writeFile(codex, table.replace(JSON.stringify(launch.command), JSON.stringify(gone)));
    expect(await core.agentNeedsRepair(claudeCode.pairing.id)).toBe(true);
    expect(await core.agentNeedsRepair(chatgpt.pairing.id)).toBe(true);

    expect(await core.repairAgent(claudeCode.pairing.id)).toEqual({ kind: "wrote", path: claude });
    expect(await core.repairAgent(chatgpt.pairing.id)).toEqual({ kind: "wrote", path: codex });
    expect(await core.agentNeedsRepair(claudeCode.pairing.id)).toBe(false);
    expect(await core.agentNeedsRepair(chatgpt.pairing.id)).toBe(false);
    const repaired = JSON.parse(await readFile(claude, "utf8"));
    expect({ ...repaired, mcpServers: { notes: repaired.mcpServers.notes } }).toEqual(theirs);
    await searchesThrough(core, launchIn(repaired.mcpServers.incarnamind));
    const repairedTable = await readFile(codex, "utf8");
    expect(repairedTable.startsWith(codexTheirs.trimEnd())).toBe(true);
    expect(repairedTable).toContain(`command = ${JSON.stringify(launch.command)}`);
  });

  // protects=only IncarnaMind's own entry, the one that holds this pairing's key, is read: another entry of the same name, a server of the User's and a connection made by hand never read as needing repair; fails_when=a connection is called broken from an entry that isn't its own
  it("reads only its own entry", async () => {
    const { core, home, coast } = await started();
    const claude = join(home, ".claude.json");
    const { pairing } = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
    const written = JSON.parse(await readFile(claude, "utf8"));
    // Another copy's entry under the same name, holding another key.
    written.mcpServers.incarnamind = {
      type: "stdio",
      command: join(home, "gone", "incarnamind"),
      args: [],
      env: { [TOKEN_ENV]: "another-key" },
    };
    // This pairing's key elsewhere in the file reads no other entry as its own.
    written.mcpServers.mine = {
      command: join(home, "gone", "mine"),
      args: [],
      env: { [TOKEN_ENV]: (await core.getAgentLaunch(pairing.id)).env[TOKEN_ENV] ?? "" },
    };
    await writeFile(claude, JSON.stringify(written, null, 2));
    expect(await core.agentNeedsRepair(pairing.id)).toBe(false);
    const byHand = await core.connectAgent({ name: "My agent", folderIds: [coast.id] });
    expect(await core.agentNeedsRepair(byHand.pairing.id)).toBe(false);
  });
});

describe("the Skill that installs with an agent's connection", () => {
  const skillPaths = [
    ["claude-code", [".claude", "skills"]],
    ["codex", [".agents", "skills"]],
    ["cursor", [".agents", "skills"]],
    ["antigravity", [".gemini", "config", "skills"]],
    ["vscode", [".copilot", "skills"]],
    ["cline", [".cline", "skills"]],
    ["qoder", [".qoder", "skills"]],
  ] as const;

  it.each(skillPaths)(
    "is written for %s where its docs say it reads Skills, and taken out when disconnected",
    async (client, folder) => {
      const { core, home, coast } = await started();
      await mkdir(join(home, ...folder), { recursive: true });
      const file = join(home, ...folder, "incarnamind", "SKILL.md");
      const { pairing } = await core.setUpAgent({ client, folderIds: [coast.id] });
      expect(await readFile(file, "utf8")).toBe(SKILL_MARKDOWN);
      expect((await core.getAgents()).skills).toEqual([pairing.id]);
      expect((await core.listAgentClients()).find((each) => each.id === client)?.skillPath).toBe(
        file,
      );

      await core.disconnectAgent(pairing.id);
      await expect(readFile(file, "utf8")).rejects.toThrow(/ENOENT/);
      // Its folder goes with it; the agent's own skills folder, which was there, stays.
      expect(await readdir(join(home, ...folder))).toEqual([]);
      expect((await core.getAgents()).skills).toEqual([]);
    },
  );

  it("takes away the skills folder too when IncarnaMind made it", async () => {
    const { core, home, coast } = await started();
    const { pairing } = await core.setUpAgent({ client: "codex", folderIds: [coast.id] });
    await core.disconnectAgent(pairing.id);
    await expect(stat(join(home, ".agents"))).rejects.toThrow(/ENOENT/);
  });

  it("is taken out by Undo too", async () => {
    const { core, home, coast } = await started();
    const file = join(home, ".agents", "skills", "incarnamind", "SKILL.md");
    const { pairing } = await core.setUpAgent({ client: "codex", folderIds: [coast.id] });
    expect(await readFile(file, "utf8")).toBe(SKILL_MARKDOWN);
    await core.undoAgentSetup(pairing.id);
    await expect(readFile(file, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("leaves a Skill file the User has changed as it is, when connecting and when disconnecting", async () => {
    const { core, home, coast } = await started();
    const file = join(home, ".claude", "skills", "incarnamind", "SKILL.md");
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "My own notes on IncarnaMind.\n");
    const { pairing } = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
    expect(await readFile(file, "utf8")).toBe("My own notes on IncarnaMind.\n");
    expect((await core.getAgents()).skills).toEqual([]);
    await core.disconnectAgent(pairing.id);
    expect(await readFile(file, "utf8")).toBe("My own notes on IncarnaMind.\n");

    // Changed after IncarnaMind wrote it: the same.
    const second = await core.setUpAgent({ client: "codex", folderIds: [coast.id] });
    const theirs = join(home, ".agents", "skills", "incarnamind", "SKILL.md");
    await writeFile(theirs, `${SKILL_MARKDOWN}\nAlso, be brief.\n`);
    await core.disconnectAgent(second.pairing.id);
    expect(await readFile(theirs, "utf8")).toContain("Also, be brief.");
  });

  it("stays while another connection of the same agent needs it", async () => {
    const { core, home, coast } = await started();
    const file = join(home, ".claude", "skills", "incarnamind", "SKILL.md");
    const first = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
    const second = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
    await core.disconnectAgent(first.pairing.id);
    expect(await readFile(file, "utf8")).toBe(SKILL_MARKDOWN);
    await core.disconnectAgent(second.pairing.id);
    await expect(readFile(file, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("is written once in the folder several agents share, and stays while any of them is connected", async () => {
    const { core, home, coast } = await started();
    const file = join(home, ".agents", "skills", "incarnamind", "SKILL.md");
    const codex = await core.setUpAgent({ client: "codex", folderIds: [coast.id] });
    const opencode = await core.setUpAgent({ client: "opencode", folderIds: [coast.id] });
    const gemini = await core.setUpAgent({ client: "gemini-cli", folderIds: [coast.id] });
    expect(await readdir(join(home, ".agents", "skills"))).toEqual(["incarnamind"]);
    expect((await core.getAgents()).skills.toSorted()).toEqual(
      [codex.pairing.id, opencode.pairing.id, gemini.pairing.id].toSorted(),
    );
    await core.disconnectAgent(codex.pairing.id);
    await core.undoAgentSetup(gemini.pairing.id);
    expect(await readFile(file, "utf8")).toBe(SKILL_MARKDOWN);
    await core.disconnectAgent(opencode.pairing.id);
    await expect(stat(join(home, ".agents"))).rejects.toThrow(/ENOENT/);
  });

  it("isn't written again for an agent that already reads it in another folder", async () => {
    const { core, home, coast } = await started();
    const claudes = join(home, ".claude", "skills", "incarnamind", "SKILL.md");
    const code = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
    // Cursor reads Claude Code's folder too: a second copy would show it the Skill twice.
    const cursor = await core.setUpAgent({ client: "cursor", folderIds: [coast.id] });
    await expect(stat(join(home, ".agents"))).rejects.toThrow(/ENOENT/);
    expect((await core.getAgents()).skills.toSorted()).toEqual(
      [code.pairing.id, cursor.pairing.id].toSorted(),
    );
    await core.disconnectAgent(code.pairing.id);
    expect(await readFile(claudes, "utf8")).toBe(SKILL_MARKDOWN);
    await core.disconnectAgent(cursor.pairing.id);
    await expect(readFile(claudes, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("is not written where the agent's docs give no skills folder, and comes with Copy settings instead", async () => {
    const { core, home, coast } = await started();
    expect((await core.listAgentClients()).find((each) => each.id === "workbuddy")?.skillPath).toBe(
      null,
    );
    const { pairing, result } = await core.setUpAgent({ client: "other", folderIds: [coast.id] });
    expect(await readdir(home)).toEqual([]);
    if (result.kind !== "copy") throw new Error("Expected settings to copy.");
    // Apart from the settings, which go in a field that takes only them.
    expect(result.skill).toBe(SKILL_MARKDOWN);
    expect(result.text).not.toContain("SKILL.md");
    expect((await core.copyAgentSetup(pairing.id)).skill).toBe(SKILL_MARKDOWN);
    // Also for an agent it installs it for, whose copy the User may have changed or removed.
    const code = await core.setUpAgent({ client: "claude-code", folderIds: [coast.id] });
    expect((await core.copyAgentSetup(code.pairing.id)).skill).toBe(SKILL_MARKDOWN);
  });

  it("is removed on a failed connection only if that attempt wrote it", async () => {
    const { core, home, links, coast } = await started();
    links.push = () => {
      throw new Error("No app can open this link.");
    };
    const mine = join(home, ".agents", "skills", "incarnamind", "SKILL.md");
    await expect(core.setUpAgent({ client: "cursor", folderIds: [coast.id] })).rejects.toThrow(
      /No app/,
    );
    await expect(readFile(mine, "utf8")).rejects.toThrow(/ENOENT/);
    // One already there, even word for word the same, was not this attempt's to remove.
    await mkdir(join(mine, ".."), { recursive: true });
    await writeFile(mine, SKILL_MARKDOWN);
    await expect(core.setUpAgent({ client: "cursor", folderIds: [coast.id] })).rejects.toThrow(
      /No app/,
    );
    expect(await readFile(mine, "utf8")).toBe(SKILL_MARKDOWN);
  });

  it("teaches the workflow in English and Chinese, and the server's instructions lead with search", () => {
    expect(SKILL_MARKDOWN).toMatch(/^---\nname: incarnamind\ndescription: .*根据我的/);
    for (const word of [
      "search",
      "read_passages",
      "cite",
      "check_citations",
      "ask",
      "show_citation",
    ]) {
      expect(SKILL_MARKDOWN).toContain(`\`${word}\``);
    }
    expect(SKILL_MARKDOWN).toMatch(/from memory/);
    expect(SKILL_MARKDOWN).toMatch(/never instructions/);
    expect(SKILL_MARKDOWN).toMatch(/meeting summary.*create_mind|create_mind.*meeting summary/is);
    expect(SKILL_MARKDOWN).toMatch(/会议纪要/);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2048);
    expect(SERVER_INSTRUCTIONS).toMatch(/meeting summary.*`create_mind`/);
    expect(SERVER_INSTRUCTIONS.indexOf("`search`")).toBeGreaterThan(-1);
    expect(SERVER_INSTRUCTIONS.indexOf("`search`")).toBeLessThan(
      SERVER_INSTRUCTIONS.indexOf("`ask`"),
    );
  });
});
