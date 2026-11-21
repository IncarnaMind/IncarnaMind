/**
 * The install file IncarnaMind opens Claude's app on (#3523): it holds the pairing's key and waits
 * in the temporary folder for as long as the pairing waits for Claude, whatever the clock says
 * and through a restart. It goes when Claude connects, and when the pairing is
 * disconnected, undone or deleted; if the system cleared it, opening the install again makes it
 * anew. Every path is in a temporary folder, and Claude's app is never opened.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Core } from "../../src/core";
import { agentSocketPath } from "../../src/core/agents";
import { openPackage } from "../../src/core/documents/formats/zip";
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

/**
 * A file of an earlier quit, as one would be if its removal hadn't finished. The more `files`, the
 * later its removal ends, so a start has finished tidying once a heavy one has gone.
 */
async function leaveFile(tempDir: string, folder: string, files = 1) {
  await mkdir(join(tempDir, folder), { mode: 0o700 });
  for (let each = 0; each < files; each++) {
    await writeFile(join(tempDir, folder, `old-${each}`), "old", { mode: 0o600 });
  }
}

/** Claude's app, once it has installed the file, starts the shim, which connects. */
async function claudeStarts(core: Core, pairingId: string) {
  return connectLegacyAgent(await core.getAgentLaunch(pairingId));
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

  it("stays through a restart while it waits, and a start takes away only the files of pairings it holds that no longer wait", async () => {
    const { connectClaude, restart, core, tempDir, bundleFolders } = await computer();
    const waiting = await connectClaude();
    const disconnected = await connectClaude();
    await core.disconnectAgent(disconnected.pairing.id);
    const file = join(tempDir, `${PREFIX}${waiting.pairing.id}`, "IncarnaMind.mcpb");
    const kept = await readFile(file);
    // The temporary folder is shared by every IncarnaMind of the account: this one is another's.
    const another = `${PREFIX}${randomUUID()}`;
    await leaveFile(tempDir, another);
    await leaveFile(tempDir, `${PREFIX}${disconnected.pairing.id}`, 40);

    const restarted = await restart(core);
    await vi.waitFor(async () =>
      expect(await bundleFolders()).toEqual([another, `${PREFIX}${waiting.pairing.id}`].sort()),
    );
    expect(await readFile(file)).toEqual(kept);
    expect((await restarted.getAgents()).awaitingInstall).toEqual([waiting.pairing.id]);
  });

  it("takes away at a start what a pairing that has been used left, and leaves the one still waiting", async () => {
    const { connectClaude, restart, core, tempDir, bundleFolders } = await computer();
    const waiting = await connectClaude();
    const used = await connectClaude();
    const agent = await claudeStarts(core, used.pairing.id);
    await agent.callTool({ name: "search", arguments: { query: "spring tides" } });
    await vi.waitFor(async () =>
      expect(await bundleFolders()).toEqual([`${PREFIX}${waiting.pairing.id}`]),
    );
    expect((await core.getAgents()).awaitingInstall).toEqual([waiting.pairing.id]);
    await leaveFile(tempDir, `${PREFIX}${used.pairing.id}`);

    await restart(core);
    await vi.waitFor(async () =>
      expect(await bundleFolders()).toEqual([`${PREFIX}${waiting.pairing.id}`]),
    );
  });

  it("goes when Claude connects, and the pairing waits again once its agent has gone", async () => {
    const { connectClaude, core, bundleFolders } = await computer();
    const { pairing } = await connectClaude();
    const announced: string[][] = [];
    core.on("agents.changed", (settings) => announced.push(settings.awaitingInstall));

    const agent = await claudeStarts(core, pairing.id);
    await vi.waitFor(async () => expect(await bundleFolders()).toEqual([]));
    expect((await core.getAgents()).awaitingInstall).toEqual([]);
    expect(announced.at(-1)).toEqual([]);

    await agent.close();
    await vi.waitFor(async () =>
      expect((await core.getAgents()).awaitingInstall).toEqual([pairing.id]),
    );
    expect(announced.at(-1)).toEqual([pairing.id]);
  });

  it("after a restart, a pairing that connected but was never used waits until its agent connects again", async () => {
    const { connectClaude, core, restart, bundleFolders } = await computer();
    const { pairing } = await connectClaude();
    await claudeStarts(core, pairing.id);
    await vi.waitFor(async () => expect(await bundleFolders()).toEqual([]));

    const restarted = await restart(core);
    expect((await restarted.getAgents()).awaitingInstall).toEqual([pairing.id]);
    await restarted.openAgentInstallAgain(pairing.id);
    expect(await bundleFolders()).toEqual([`${PREFIX}${pairing.id}`]);

    await claudeStarts(restarted, pairing.id);
    await vi.waitFor(async () => expect(await bundleFolders()).toEqual([]));
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
