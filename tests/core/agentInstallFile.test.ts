/**
 * The install file IncarnaMind opens Claude's app on (#3523): it holds the pairing's key and waits
 * in the temporary folder for as long as the pairing waits for Claude, whatever the clock says
 * and through a restart. It goes when Claude first connects, and when the pairing is
 * disconnected, undone or deleted; if the system cleared it, opening the install again makes it
 * anew. Every path is in a temporary folder, and Claude's app is never opened.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Core } from "../../src/core";
import { DATABASE_FILE } from "../../src/core";
import { agentSocketPath } from "../../src/core/agents";
import { openPackage } from "../../src/core/documents/formats/zip";
import { openDatabase } from "../../src/core/storage";
import { type Migration, migrations } from "../../src/core/storage/migrations";
import { agentSocketAnswers } from "../helpers/agentClients";
import { agentsAdapter, buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";

const TOKEN_ENV = "INCARNAMIND_AGENT_TOKEN";
const PREFIX = "incarnamind-agent-";

/** One computer: its folders, what its app was asked to open, and starting IncarnaMind on it. */
async function computer() {
  const dataDir = await createTempDataFolder();
  const home = await createTempDataFolder();
  const tempDir = await createTempDataFolder();
  const keychain = createMemoryKeychain();
  const shim = await buildAgentShim();
  const opened: string[] = [];
  const start = async (): Promise<Core> =>
    startCore(dataDir, {
      keychain,
      paths: { dataDir, home, documents: join(dataDir, "Documents"), tempDir },
      agents: {
        ...(await agentsAdapter(dataDir)),
        shimScript: shim,
        applications: [await createTempDataFolder()],
      },
      shell: {
        openPath: async (path) => {
          opened.push(path);
        },
        showItemInFolder: () => undefined,
      },
    });
  const bundleFolders = async () =>
    (await readdir(tempDir)).filter((name) => name.startsWith(PREFIX)).sort();
  /** Quits IncarnaMind and starts it again on the same folders. */
  const restart = async (core: Core): Promise<Core> => {
    core.close();
    await expect.poll(() => agentSocketAnswers(agentSocketPath(dataDir))).toBe(false);
    return start();
  };
  const core = await start();
  await core.setAgentsEnabled(true);
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  const connectClaude = () => core.setUpAgent({ client: "claude-desktop", folderIds: [coast.id] });
  return { core, coast, dataDir, tempDir, opened, bundleFolders, restart, connectClaude };
}

/** A file of an earlier quit, as one would be if its removal hadn't finished. */
async function leaveFile(tempDir: string, folder: string) {
  await mkdir(join(tempDir, folder), { mode: 0o700 });
  await writeFile(join(tempDir, folder, "IncarnaMind.mcpb"), "old", { mode: 0o600 });
}

/** Claude's app, once it has installed the file, starts the shim, which connects. */
async function claudeStarts(core: Core, pairingId: string) {
  await connectLegacyAgent(await core.getAgentLaunch(pairingId));
}

describe("Claude's install file (#3523)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  it("is made for the pairing in a folder of its own, for its owner alone", async () => {
    const { connectClaude, opened, tempDir, bundleFolders } = await computer();
    const { pairing } = await connectClaude();
    const folder = join(tempDir, `${PREFIX}${pairing.id}`);
    expect(await bundleFolders()).toEqual([`${PREFIX}${pairing.id}`]);
    expect(opened).toEqual([join(folder, "IncarnaMind.mcpb")]);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(join(folder, "IncarnaMind.mcpb"))).mode & 0o777).toBe(0o600);
  });

  it("is still there long after the 15 minutes it used to wait, while Claude hasn't connected", async () => {
    const { connectClaude, opened, core } = await computer();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await connectClaude();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    } finally {
      vi.useRealTimers();
    }
    expect((await stat(opened[0] ?? "")).isFile()).toBe(true);
    expect((await core.getAgents()).awaitingInstall).toHaveLength(1);
  });

  it("stays through a restart while it waits, and a start takes away the file of a pairing that is gone", async () => {
    const { connectClaude, restart, core, tempDir, bundleFolders } = await computer();
    const { pairing } = await connectClaude();
    const file = join(tempDir, `${PREFIX}${pairing.id}`, "IncarnaMind.mcpb");
    const kept = await readFile(file);
    const gone = `${PREFIX}${randomUUID()}`;
    await leaveFile(tempDir, gone);

    const restarted = await restart(core);
    // The start has finished tidying once the file of the pairing that is gone has gone.
    await vi.waitFor(async () => expect(await bundleFolders()).toEqual([`${PREFIX}${pairing.id}`]));
    expect(await readFile(file)).toEqual(kept);
    expect((await restarted.getAgents()).awaitingInstall).toEqual([pairing.id]);
  });

  it("takes away at a start what a pairing that has connected left, and leaves the one still waiting", async () => {
    const { connectClaude, restart, core, tempDir, bundleFolders } = await computer();
    const waiting = await connectClaude();
    const connected = await connectClaude();
    await claudeStarts(core, connected.pairing.id);
    await vi.waitFor(async () =>
      expect(await bundleFolders()).toEqual([`${PREFIX}${waiting.pairing.id}`]),
    );
    await leaveFile(tempDir, `${PREFIX}${connected.pairing.id}`);

    await restart(core);
    await vi.waitFor(async () =>
      expect(await bundleFolders()).toEqual([`${PREFIX}${waiting.pairing.id}`]),
    );
  });

  it("goes when Claude first connects, and the pairing stays connected through a restart", async () => {
    const { connectClaude, core, restart, bundleFolders } = await computer();
    const { pairing } = await connectClaude();
    const announced: string[][] = [];
    core.on("agents.changed", (settings) => announced.push(settings.awaitingInstall));

    await claudeStarts(core, pairing.id);
    await vi.waitFor(async () => expect(await bundleFolders()).toEqual([]));
    expect((await core.getAgents()).awaitingInstall).toEqual([]);
    expect(announced.at(-1)).toEqual([]);

    const restarted = await restart(core);
    expect((await restarted.getAgents()).awaitingInstall).toEqual([]);
  });

  it("goes when the pairing is disconnected", async () => {
    const { connectClaude, core, bundleFolders } = await computer();
    const { pairing } = await connectClaude();
    await core.disconnectAgent(pairing.id);
    expect(await bundleFolders()).toEqual([]);
  });

  it("goes when the setup is undone", async () => {
    const { connectClaude, core, bundleFolders } = await computer();
    const { pairing } = await connectClaude();
    await core.undoAgentSetup(pairing.id);
    expect(await bundleFolders()).toEqual([]);
    expect((await core.getAgents()).pairings).toEqual([]);
  });

  it("goes with the pairing when the app can't be opened on it", async () => {
    const dataDir = await createTempDataFolder();
    const tempDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      paths: { dataDir, tempDir },
      agents: {
        ...(await agentsAdapter(dataDir)),
        shimScript: await buildAgentShim(),
        applications: [await createTempDataFolder()],
      },
      shell: {
        openPath: async () => {
          throw new Error("No app opens it.");
        },
        showItemInFolder: () => undefined,
      },
    });
    const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
    await expect(
      core.setUpAgent({ client: "claude-desktop", folderIds: [coast.id] }),
    ).rejects.toThrow("No app opens it.");
    expect((await readdir(tempDir)).filter((name) => name.startsWith(PREFIX))).toEqual([]);
    expect((await core.getAgents()).pairings).toEqual([]);
  });

  describe("opening the install again", () => {
    const manifestOf = async (path: string) =>
      JSON.parse(
        new TextDecoder().decode(await openPackage(await readFile(path)).read("manifest.json")),
      );

    it("makes the same pairing's file anew when the system cleared it, with the same key, and opens it", async () => {
      const { connectClaude, core, opened, tempDir } = await computer();
      const { pairing } = await connectClaude();
      const folder = join(tempDir, `${PREFIX}${pairing.id}`);
      const path = join(folder, "IncarnaMind.mcpb");
      await rm(folder, { recursive: true });

      await core.openAgentInstallAgain(pairing.id);

      expect(opened).toEqual([path, path]);
      const key = (await core.getAgentLaunch(pairing.id)).env[TOKEN_ENV];
      const inFile = (await manifestOf(path)).server.mcp_config.env[TOKEN_ENV];
      expect(inFile === key).toBe(true);
      expect((await core.getAgents()).pairings).toHaveLength(1);
      expect((await readdir(tempDir)).filter((name) => name.startsWith(PREFIX))).toEqual([
        `${PREFIX}${pairing.id}`,
      ]);
    });

    it("keeps the folder and the file to their owner, though the modes were widened", async () => {
      const { connectClaude, core, tempDir } = await computer();
      const { pairing } = await connectClaude();
      const folder = join(tempDir, `${PREFIX}${pairing.id}`);
      await chmod(join(folder, "IncarnaMind.mcpb"), 0o644);
      await chmod(folder, 0o755);

      await core.openAgentInstallAgain(pairing.id);

      expect((await stat(folder)).mode & 0o777).toBe(0o700);
      expect((await stat(join(folder, "IncarnaMind.mcpb"))).mode & 0o777).toBe(0o600);
    });

    it("then goes when Claude connects", async () => {
      const { connectClaude, core, bundleFolders, tempDir } = await computer();
      const { pairing } = await connectClaude();
      await rm(join(tempDir, `${PREFIX}${pairing.id}`), { recursive: true });
      await core.openAgentInstallAgain(pairing.id);
      expect(await bundleFolders()).toHaveLength(1);

      await claudeStarts(core, pairing.id);
      await vi.waitFor(async () => expect(await bundleFolders()).toEqual([]));
    });

    it("does nothing for a pairing whose agent has connected: its file is gone for good", async () => {
      const { connectClaude, core, opened, bundleFolders } = await computer();
      const { pairing } = await connectClaude();
      await claudeStarts(core, pairing.id);
      await vi.waitFor(async () => expect(await bundleFolders()).toEqual([]));

      await core.openAgentInstallAgain(pairing.id);

      expect(opened).toHaveLength(1);
      expect(await bundleFolders()).toEqual([]);
    });

    it("does nothing for an agent that takes no install file, and refuses one that isn't connected", async () => {
      const { core, coast, opened, bundleFolders } = await computer();
      const { pairing } = await core.setUpAgent({ client: "codex", folderIds: [coast.id] });
      expect((await core.getAgents()).awaitingInstall).toEqual([]);

      await core.openAgentInstallAgain(pairing.id);
      expect(opened).toEqual([]);
      expect(await bundleFolders()).toEqual([]);

      await expect(core.openAgentInstallAgain("no-such-pairing")).rejects.toThrow();
    });
  });
});

describe("when an agent first connected", () => {
  it("is kept for a pairing used before it was kept", async () => {
    const dataDir = await createTempDataFolder();
    const tempDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const adapters = {
      keychain,
      paths: { dataDir, tempDir },
      agents: await agentsAdapter(dataDir),
    };
    const original = startCore(dataDir, adapters);
    const coast = await original.createLibraryGroup({ name: "Coast", description: "The sea." });
    const used = await original.connectAgent({
      name: "Used",
      folderIds: [coast.id],
      client: "claude-desktop",
    });
    const unused = await original.connectAgent({
      name: "Unused",
      folderIds: [coast.id],
      client: "claude-desktop",
    });
    original.close();

    const ours = migrations.find((each) => each.description.includes("(#3523)")) as Migration;
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.exec(`
      ALTER TABLE agent_pairings DROP COLUMN connected_at;
      UPDATE agent_pairings SET last_used_at = '2026-11-20T10:00:00.000Z' WHERE id = '${used.pairing.id}';
      DELETE FROM schema_migrations WHERE version = ${ours.version};
      PRAGMA user_version = ${ours.version - 1};
    `);
    db.close();

    const upgraded = startCore(dataDir, adapters);
    expect((await upgraded.getAgents()).awaitingInstall).toEqual([unused.pairing.id]);
  });
});
