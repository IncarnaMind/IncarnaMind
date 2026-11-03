import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client as ModernClient } from "@modelcontextprotocol/client";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { MockLanguageModelV4 } from "ai/test";
import { build } from "vite";
import { onTestFinished } from "vitest";
import type { AgentLaunch, CoreAdapters, Logger } from "../../src/core";
import { agentSocketPath } from "../../src/core/agents";
import { legacyAgentClient, modernAgentClient } from "./agentClients";
import { createTempDataFolder, startCore } from "./core";
import { scriptedModels } from "./models";

const root = fileURLToPath(new URL("../..", import.meta.url));
let built: Promise<string> | null = null;

/**
 * The shim an agent starts (src/main/agentShim.ts), built once per test run
 * as the app builds it, to run with this Node as the app's binary runs it.
 */
export function buildAgentShim(): Promise<string> {
  built ??= (async () => {
    const outDir = join(root, `node_modules/.cache/incarnamind-test-agent-shim-${process.pid}`);
    await build({
      configFile: false,
      root,
      logLevel: "warn",
      build: {
        ssr: join(root, "src/main/agentShim.ts"),
        outDir,
        emptyOutDir: true,
        minify: false,
        rollupOptions: { output: { format: "cjs", entryFileNames: "agentShim.cjs" } },
      },
    });
    return join(outDir, "agentShim.cjs");
  })();
  return built;
}

/** Everything the core wrote to its log, one line per entry, to look for what mustn't be there. */
export interface LogCapture extends Logger {
  readonly lines: string[];
}

function captureLog(): LogCapture {
  const lines: string[] = [];
  const keep =
    (level: string) =>
    (event: string, fields?: object): void => {
      lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
    };
  return { lines, info: keep("info"), warn: keep("warn"), error: keep("error") };
}

/** Outside agents for a core on `dataDir`: they start the shim with this Node. */
export async function agentsAdapter(dataDir: string): Promise<CoreAdapters["agents"]> {
  return {
    socketPath: agentSocketPath(dataDir),
    launcher: { command: process.execPath, args: [await buildAgentShim()] },
    version: "0.0.0-test",
  };
}

/**
 * A core whose outside agents start the shim with this Node, on a temporary
 * data folder, with a local chat model (no consent needed) answering from
 * `model`.
 */
export async function startAgentsCore(
  model: MockLanguageModelV4,
  overrides: Partial<CoreAdapters> = {},
) {
  const dataDir = await createTempDataFolder();
  const log = captureLog();
  const models = scriptedModels(model);
  const core = startCore(dataDir, {
    createChatModel: models.createChatModel,
    log,
    agents: await agentsAdapter(dataDir),
    ...overrides,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return { core, dataDir, log, models };
}

/** An agent on the protocol before 2026-07-28 (with `initialize`), as most clients still are. */
export async function connectLegacyAgent(launch: AgentLaunch): Promise<Client> {
  const client = await legacyAgentClient(launch);
  onTestFinished(() => client.close());
  return client;
}

/** An agent on the current protocol, 2026-07-28 (stateless, `server/discover`), and nothing else. */
export async function connectModernAgent(launch: AgentLaunch): Promise<ModernClient> {
  const client = await modernAgentClient(launch);
  onTestFinished(() => client.close());
  return client;
}

/** A Tool call's result text, which is its JSON, or the refusal it gave. */
export function resultText(result: unknown): string {
  const given = (result as { content?: unknown }).content;
  const content = Array.isArray(given) ? given : [];
  return content
    .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : ""))
    .join("");
}
