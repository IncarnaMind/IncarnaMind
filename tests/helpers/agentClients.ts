import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentLaunch } from "../../src/core/api";
import { isRecord } from "../../src/core/errors";

export function agentSocketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(5_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function legacyAgentClient(launch: AgentLaunch): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
  return client;
}

export async function modernAgentClient(launch: AgentLaunch): Promise<ModernClient> {
  const client = new ModernClient(
    { name: "test-agent", version: "2.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(new ModernTransport({ ...launch, stderr: "pipe" }));
  return client;
}

export function cursorLaunch(settings: unknown): AgentLaunch {
  if (!isRecord(settings) || !isRecord(settings.mcpServers)) throw new Error("Missing mcpServers.");
  const entry = settings.mcpServers.incarnamind;
  if (
    !isRecord(entry) ||
    typeof entry.command !== "string" ||
    !Array.isArray(entry.args) ||
    !entry.args.every((arg: unknown) => typeof arg === "string") ||
    !isRecord(entry.env)
  )
    throw new Error("Invalid Cursor server entry.");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.env)) {
    if (typeof value !== "string") throw new Error("Invalid Cursor environment.");
    env[key] = value;
  }
  return { command: entry.command, args: entry.args, env };
}

export async function cursorSettingsFromGuide(launch: AgentLaunch): Promise<string> {
  const guide = await readFile(join(process.cwd(), "docs", "cursor.md"), "utf8");
  const block = /```json\r?\n([\s\S]*?)\r?\n```/.exec(guide)?.[1];
  if (!block) throw new Error("The Cursor guide has no JSON settings.");
  const placeholders: Record<string, string> = {
    "<app executable>": launch.command,
    "<shipped agentShim.js>": launch.args[0] ?? "",
    "<socket>": launch.env.INCARNAMIND_AGENT_SOCKET ?? "",
    "<pairing key>": launch.env.INCARNAMIND_AGENT_TOKEN ?? "",
  };
  let filled = block;
  for (const [placeholder, value] of Object.entries(placeholders))
    filled = filled.replace(JSON.stringify(placeholder), JSON.stringify(value));
  const settings: unknown = JSON.parse(filled);
  cursorLaunch(settings);
  return filled;
}

export function redactAgentKeys(text: string): string {
  return text.replace(/im_[A-Za-z0-9_-]{43}/g, "[redacted]");
}
