/**
 * The User's own command-line AI, run once for a check they pressed (ADR-0032): Claude Code, the
 * `claude` the login shell finds, signed in as the User set it up. IncarnaMind reads only the exit
 * codes of `--version` and `auth status`, never the agent's settings or sign-in. A run gets
 * IncarnaMind's server with a grant, in a settings file only the User's account can read, inside
 * a folder of its own that goes when the run ends; nothing of the run is kept.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnAiFailure, OwnAiRunner, OwnAiStatus } from "../core/adapters";
import { stopProcessTree } from "../core/execution";
import { ClaudeCodeIsolationError, object, runClaudeCodeTurn } from "./claudeCode";
import { createLoginShellProcesses } from "./processes";

const processes = createLoginShellProcesses();

/** Restricted mode, which the run rests on, came in Claude Code 2.1.248. */
export const LOWEST_CLAUDE_CODE = "2.1.248";
/** As long as a run may take before it is stopped (ADR-0032). */
const RUN_MS = 15 * 60_000;
const MAX_RUN_BYTES = 8 * 1024 * 1024;
const STATUS_MS = 15_000;
const SERVER = "incarnamind";

/** The CLI's own categories of a failed request, for words IncarnaMind says; others say nothing. */
const FAILURE_OF: Record<string, OwnAiFailure> = {
  authentication_failed: "signed-out",
  rate_limit: "plan-limit",
  billing_error: "billing",
};

const older = (found: string, lowest: string) => {
  const [a, b] = [found, lowest].map((each) => each.split(".").map(Number));
  for (let at = 0; at < 3; at++) {
    const one = a?.[at] ?? 0;
    const two = b?.[at] ?? 0;
    if (one !== two) return one < two;
  }
  return false;
};

/** A short command's exit code and what it printed, or null when it can't be started. */
async function short(command: string, args: string[]) {
  let child: Awaited<ReturnType<typeof processes.spawn>>;
  try {
    child = await processes.spawn(command, args, { processGroup: true });
  } catch {
    return null;
  }
  let out = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    if (out.length < 4096) out += chunk.toString("utf8");
  });
  child.stderr?.resume();
  const timer = setTimeout(() => stopProcessTree(child), STATUS_MS);
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  return { code, out };
}

export function createOwnAi({ command = "claude" }: { command?: string } = {}): OwnAiRunner {
  return {
    async status(): Promise<OwnAiStatus> {
      const version = await short(command, ["--version"]);
      if (version?.code !== 0) return { kind: "missing" };
      const found = version.out.match(/\d+\.\d+\.\d+/)?.[0];
      if (!found || older(found, LOWEST_CLAUDE_CODE)) {
        return { kind: "too-old", found: found ?? "", lowest: LOWEST_CLAUDE_CODE };
      }
      const signedIn = await short(command, ["auth", "status"]);
      return signedIn?.code === 0 ? { kind: "ready" } : { kind: "signed-out" };
    },

    async run(request) {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(RUN_MS)]);
      const cwd = await mkdtemp(join(tmpdir(), "incarnamind-check-"));
      const allowed = new Set(request.tools.map((tool) => `mcp__${SERVER}__${tool}`));
      let failure: OwnAiFailure | null = null;
      try {
        const configFile = join(cwd, "mcp.json");
        const { command: server, args, env } = request.server;
        await writeFile(
          configFile,
          JSON.stringify({
            mcpServers: { [SERVER]: { type: "stdio", command: server, args, env } },
          }),
          { mode: 0o600 },
        );
        const result = await runClaudeCodeTurn({
          command,
          cwd,
          systemPrompt: request.instructions,
          prompt: request.prompt,
          signal,
          maxResponseBytes: MAX_RUN_BYTES,
          server: { configFile, name: SERVER, tools: request.tools },
          persist: false,
          onMessage(message) {
            if (message.type === "system" && message.subtype === "init") {
              const tools = Array.isArray(message.tools) ? message.tools : [];
              const servers = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
              // Only IncarnaMind's server, connected, and its Tools: anything else, a flag didn't hold.
              if (
                tools.some(
                  (tool) => typeof tool !== "string" || !tool.startsWith(`mcp__${SERVER}__`),
                ) ||
                servers.length !== 1 ||
                object(servers[0]).name !== SERVER ||
                object(servers[0]).status !== "connected"
              ) {
                throw new ClaudeCodeIsolationError();
              }
            }
            if (message.type === "system" && message.subtype === "api_retry") {
              failure = FAILURE_OF[String(message.error)] ?? failure;
            }
            const content = object(message.message).content;
            if (message.type === "assistant" && Array.isArray(content)) {
              for (const part of content.map(object)) {
                if (part.type === "tool_use" && !allowed.has(String(part.name))) {
                  throw new ClaudeCodeIsolationError();
                }
              }
            }
          },
        });
        return result.subtype === "success" && result.is_error === false
          ? { kind: "finished" }
          : { kind: "failed", reason: failure ?? "other" };
      } catch (error) {
        if (request.signal.aborted) throw error;
        if (error instanceof ClaudeCodeIsolationError)
          return { kind: "failed", reason: "isolation" };
        if (signal.aborted) return { kind: "failed", reason: "timeout" };
        return { kind: "failed", reason: failure ?? "other" };
      } finally {
        await rm(cwd, { recursive: true, force: true, maxRetries: 3 }).catch(() =>
          console.warn("Could not remove the temporary folder of a check run."),
        );
      }
    },
  };
}
