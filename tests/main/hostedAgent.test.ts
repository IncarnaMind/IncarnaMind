import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";
import type { AgentProcess } from "../../src/core";
import {
  type HostedDecision,
  type HostedEvent,
  type HostedPermission,
  runHostedTurn,
} from "../../src/core/agents/hosted";
import { createAgentProcesses } from "../../src/main/agentProcesses";
import { createProcessLauncher } from "../../src/main/processes";
import { createTempDataFolder } from "../helpers/core";

const SCRIPTED_AGENT = fileURLToPath(new URL("../fixtures/acp-agent.mjs", import.meta.url));

const MCP_SERVER = {
  name: "incarnamind",
  command: "/path/to/IncarnaMind",
  args: ["--agent-shim"],
  env: [
    { name: "INCARNAMIND_AGENT_SOCKET", value: "/tmp/agents.sock" },
    { name: "INCARNAMIND_AGENT_TOKEN", value: "a-run-token" },
  ],
};

interface LogLine {
  event: string;
  [key: string]: unknown;
}

async function startAgent() {
  const folder = await createTempDataFolder();
  const logFile = join(folder, "agent.log");
  const environment = async () =>
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  const agentProcess: AgentProcess = await createAgentProcesses(
    createProcessLauncher(environment),
  ).start({
    command: process.execPath,
    args: [SCRIPTED_AGENT],
    cwd: folder,
    env: { ACP_TEST_LOG: logFile },
  });
  onTestFinished(() => agentProcess.stop());
  const log = async (): Promise<LogLine[]> =>
    (await readFile(logFile, "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as LogLine);
  return { agentProcess, folder, log };
}

async function turn(
  prompt: string,
  options: {
    decide?: (permission: HostedPermission) => HostedDecision;
    /** Stop while the first permission request waits for the User. */
    stopWhenAsked?: boolean;
    modes?: string[];
    stopAfter?: HostedEvent["type"];
  } = {},
) {
  const { agentProcess, folder, log } = await startAgent();
  const asked: HostedPermission[] = [];
  const controller = new AbortController();
  const events: HostedEvent[] = [];
  for await (const event of runHostedTurn({
    process: agentProcess,
    cwd: folder,
    mcpServer: MCP_SERVER,
    modes: options.modes ?? ["read-only"],
    prompt,
    version: "0.0.0-test",
    ask: async (permission, signal) => {
      asked.push(permission);
      if (options.stopWhenAsked) {
        controller.abort();
        expect(signal.aborted).toBe(true);
      }
      return options.decide?.(permission) ?? "deny";
    },
    reportError: (error) => {
      throw error;
    },
    signal: controller.signal,
  })) {
    events.push(event);
    if (event.type === options.stopAfter) controller.abort();
  }
  const text = events
    .flatMap((event) => (event.type === "text-delta" ? [event.text] : []))
    .join("");
  return { events, text, asked, log: await log() };
}

describe("a hosted agent's turn over ACP (#353 spike)", () => {
  test("streams the agent's answer in its most restrictive mode, offered no file system or terminal", async () => {
    const { events, text, log } = await turn("hello");

    expect(events[0]).toEqual({ type: "started", agent: "scripted-agent", mode: "read-only" });
    expect(text).toBe("Revenue grew 12% [cite:k3x9a2b7].");
    expect(events.at(-1)).toEqual({ type: "finished", stopReason: "end_turn" });
    expect(log.find((line) => line.event === "initialize")?.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      auth: { terminal: false },
    });
    expect(log.find((line) => line.event === "session/new")?.mcpServers).toEqual([
      { name: "incarnamind", env: ["INCARNAMIND_AGENT_SOCKET", "INCARNAMIND_AGENT_TOKEN"] },
    ]);
    expect(log.filter((line) => line.event === "set_mode")).toEqual([
      { event: "set_mode", modeId: "read-only" },
    ]);
  });

  test("an agent that doesn't offer the restrictive mode gets no prompt", async () => {
    const { events, log } = await turn("hello", { modes: ["plan"] });

    expect(events).toEqual([
      { type: "failed", problem: "no-restrictive-mode", detail: "full-access, read-only" },
    ]);
    expect(log.some((line) => line.event === "session/new")).toBe(true);
    expect(log.some((line) => line.event === "prompt")).toBe(false);
  });

  test("For this run answers the run's next call of that kind, and never with the agent's always", async () => {
    const { events, text, asked, log } = await turn("run code", {
      decide: () => "allow-for-run",
    });

    expect(asked).toEqual([{ toolCallId: "call-1", title: "Run tests", kind: "execute" }]);
    expect(events.filter((event) => event.type === "permission")).toEqual([
      { type: "permission", id: "call-1", decision: "allow-for-run" },
      { type: "permission", id: "call-2", decision: "allow-for-run" },
    ]);
    expect(log.filter((line) => line.event === "permission").map((line) => line.outcome)).toEqual([
      { outcome: "selected", optionId: "allow-once-id" },
      { outcome: "selected", optionId: "allow-once-id" },
    ]);
    expect(text).toBe("Both ran.");
  });

  test("Deny answers the agent's reject-once, and the call fails", async () => {
    const { events, text, log } = await turn("run code", { decide: () => "deny" });

    expect(log.filter((line) => line.event === "permission").map((line) => line.outcome)).toEqual([
      { outcome: "selected", optionId: "reject-once-id" },
    ]);
    expect(events).toContainEqual({ type: "tool-call-finished", id: "call-1", ok: false });
    expect(text).toBe("Nothing ran.");
  });

  test("Stop cancels the turn, and the agent ends it as cancelled", async () => {
    const { events, text, log } = await turn("wait", { stopAfter: "text-delta" });

    expect(text).toBe("Working on it.");
    expect(log.some((line) => line.event === "cancel")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "finished", stopReason: "cancelled" });
  });

  test("Stop withdraws a permission request still waiting, answered as cancelled", async () => {
    const { events, asked, log } = await turn("run code", {
      decide: () => "allow-once",
      stopWhenAsked: true,
    });

    expect(asked).toEqual([{ toolCallId: "call-1", title: "Run tests", kind: "execute" }]);
    expect(log.filter((line) => line.event === "permission").map((line) => line.outcome)).toEqual([
      { outcome: "cancelled" },
    ]);
    expect(log.some((line) => line.event === "cancel")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "finished", stopReason: "cancelled" });
  });

  test("an agent that exits halfway ends the turn with what it wrote and why", async () => {
    const { events, text } = await turn("crash");

    expect(text).toBe("Half an answer");
    const last = events.at(-1);
    expect(last?.type).toBe("failed");
    expect(last?.type === "failed" ? last.problem : null).toBe("exited");
    expect(last?.type === "failed" ? last.detail : "").toContain(
      "boom: the agent's model went away",
    );
  });
});
