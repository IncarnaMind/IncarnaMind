import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, onTestFinished, test } from "vitest";
import type { AgentLaunch, AgentProgram } from "../../src/core";
import { type HostedEvent, runHostedTurn } from "../../src/core/agents/hosted";
import { agentSandboxHolds, createAgentProcesses } from "../../src/main/agentProcesses";
import { createProcessLauncher } from "../../src/main/processes";
import { type AgentProfile, loadOsSandbox } from "../../src/main/sandbox";
import { buildAgentShim, startAgentsCore } from "../helpers/agents";
import { createTempDataFolder } from "../helpers/core";
import { replyingModel } from "../helpers/models";

const SCRIPTED_AGENT = fileURLToPath(new URL("../fixtures/acp-agent.mjs", import.meta.url));

const sandbox = await loadOsSandbox();
const unavailable = !sandbox.available
  ? sandbox.reason
  : process.platform !== "darwin"
    ? "a hosted agent runs only in macOS's sandbox for now"
    : undefined;

const processes = createProcessLauncher(async () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
);

const confineIn = (profile: AgentProfile) => (program: AgentProgram) =>
  sandbox.available
    ? sandbox.confineAgent(program, profile)
    : Promise.reject(new Error("no sandbox"));

/** The scripted agent, in the sandbox `profile` describes, asked to use the MCP server `launch` starts. */
async function useIncarnaMind(launch: AgentLaunch, profile: AgentProfile, workingFolder: string) {
  const logFile = join(workingFolder, "agent.log");
  const agentProcess = await createAgentProcesses(processes, confineIn(profile)).start({
    command: process.execPath,
    args: [SCRIPTED_AGENT],
    cwd: workingFolder,
    env: { ACP_TEST_LOG: logFile },
  });
  onTestFinished(() => agentProcess.stop());
  const events: HostedEvent[] = [];
  for await (const event of runHostedTurn({
    process: agentProcess,
    cwd: workingFolder,
    mcpServer: {
      name: "incarnamind",
      command: launch.command,
      args: launch.args,
      env: Object.entries(launch.env).map(([name, value]) => ({ name, value })),
    },
    modes: ["read-only"],
    prompt: "use incarnamind",
    version: "0.0.0-test",
    ask: async () => "deny",
    actions: {
      writeTextFile: () => Promise.reject(new Error("not in this test")),
      startCommand: () => Promise.reject(new Error("not in this test")),
    },
    reportError: (error) => {
      throw error;
    },
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  const lines = (await readFile(logFile, "utf8")).split("\n").filter((line) => line !== "");
  const mcp = lines.map((line) => JSON.parse(line)).find((line) => line.event === "mcp");
  return { events, mcp };
}

describe.skipIf(unavailable !== undefined)(
  `A hosted agent in the OS sandbox (#353 spike)${unavailable === undefined ? "" : ` (skipped: ${unavailable})`}`,
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      await buildAgentShim();
    });

    test("agents are offered only once a file in the data folder can't be read in the sandbox", async () => {
      const data = await createTempDataFolder();
      const working = await createTempDataFolder();
      const files = {
        inDataFolder: join(data, "canary.txt"),
        inWorkingFolder: join(working, "own.txt"),
        workingFolder: working,
      };
      await writeFile(files.inDataFolder, "DATA CANARY");
      await writeFile(files.inWorkingFolder, "OWN FILE");
      const profile = { denyRead: [data], allowWrite: [working], socket: join(working, "a.sock") };

      expect(await agentSandboxHolds(processes, confineIn(profile), files)).toBeUndefined();
      expect(
        await agentSandboxHolds(processes, confineIn({ ...profile, denyRead: [] }), files),
      ).toBe("a file in IncarnaMind's data folder could be read in the sandbox");
    });

    test("the MCP shim reaches the app through the one socket the profile allows, outside the data folder", async () => {
      const sockets = await realpath(await createTempDataFolder());
      const socketPath = join(sockets, "agents.sock");
      const { core, dataDir } = await startAgentsCore(replyingModel(), {
        agents: {
          socketPath,
          launcher: { command: process.execPath, args: [await buildAgentShim()] },
          version: "0.0.0-test",
        },
      });
      await core.setAgentsEnabled(true);
      const { launch } = await core.connectAgent({ name: "Codex" });
      const working = await createTempDataFolder();
      const profile = { denyRead: [dataDir], allowWrite: [working], socket: socketPath };

      const allowed = await useIncarnaMind(launch, profile, working);

      expect(allowed.events.at(-1)).toEqual({ type: "finished", stopReason: "end_turn" });
      expect(allowed.mcp).toMatchObject({ ok: true });
      expect(allowed.mcp.tools).toContain("search");

      const elsewhere = await createTempDataFolder();
      const refused = await useIncarnaMind(
        launch,
        { ...profile, allowWrite: [elsewhere], socket: join(sockets, "another.sock") },
        elsewhere,
      );

      expect(refused.mcp).toMatchObject({ ok: false });
      expect(refused.mcp.error).toContain("IncarnaMind isn't open");
    });
  },
);
