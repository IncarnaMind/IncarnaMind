/**
 * Harness (b): Claude Code, headless (`claude --bare -p`), README.md.
 *
 * - `--bare` takes Anthropic's credentials only from ANTHROPIC_API_KEY, never
 *   a sign-in or the keychain, and skips hooks, plugins and CLAUDE.md.
 * - `--tools ""` turns every built-in Tool off; `--strict-mcp-config` keeps
 *   every MCP server but IncarnaMind's out, and `--allowedTools` lets its
 *   Tools run without asking. Anything else would ask, and nobody answers
 *   (`--permission-prompts none`).
 * - A temporary home and CLAUDE_CONFIG_DIR hold the session, so the second
 *   turn resumes it (`--resume`).
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  childEnv,
  jsonLine,
  lastLines,
  NO_TOKENS,
  type OutsideRunOptions,
  type OutsideTurn,
  runLines,
} from "./outside";

export const CLAUDE_SERVER = "incarnamind";

const number = (value: unknown) => (typeof value === "number" ? value : 0);

/** The MCP config Claude Code reads: the token comes from its environment, which it expands. */
export function claudeMcpConfig(options: OutsideRunOptions): object {
  const secrets = Object.fromEntries(
    Object.keys(options.server.secretEnv).map((name) => [name, `\${${name}}`]),
  );
  return {
    mcpServers: {
      [CLAUDE_SERVER]: {
        command: options.server.command,
        args: options.server.args,
        env: { ...options.server.env, ...secrets },
      },
    },
  };
}

export async function runClaudeCode(
  bin: string,
  apiKey: string,
  options: OutsideRunOptions,
): Promise<OutsideTurn[]> {
  const mcpConfig = join(options.configDir, "mcp.json");
  await writeFile(mcpConfig, JSON.stringify(claudeMcpConfig(options)), { mode: 0o600 });
  const session = randomUUID();
  const env = childEnv(options, {
    CLAUDE_CONFIG_DIR: options.configDir,
    ANTHROPIC_API_KEY: apiKey,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  const turns: OutsideTurn[] = [];
  for (const [index, prompt] of options.turns.entries()) {
    const args = [
      "--bare",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      options.model,
      "--effort",
      options.effort,
      ...(index === 0 ? ["--session-id", session] : ["--resume", session]),
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      options.tools.map((tool) => `mcp__${CLAUDE_SERVER}__${tool}`).join(","),
      "--permission-prompts",
      "none",
      "--append-system-prompt",
      options.instructions,
    ];
    const seen: {
      startupMs: number | null;
      toolsOffered: string[] | null;
      result: Record<string, unknown> | null;
      lastText: string;
    } = { startupMs: null, toolsOffered: null, result: null, lastText: "" };
    const calls: string[] = [];
    const spawned = await runLines({
      bin,
      args,
      env,
      cwd: options.workDir,
      stdin: prompt,
      eventsFile: options.eventsFile,
      timeoutMs: options.timeoutMs,
      onLine(line, atMs) {
        const event = jsonLine(line);
        if (!event) return;
        if (event.type === "system" && event.subtype === "init") {
          seen.startupMs ??= atMs;
          if (Array.isArray(event.tools)) seen.toolsOffered = event.tools.map(String);
        } else if (event.type === "assistant") {
          const message = event.message as {
            content?: { type?: string; text?: string; name?: string }[];
          };
          for (const part of message?.content ?? []) {
            if (part.type === "text" && part.text) seen.lastText = part.text;
            if (part.type === "tool_use") calls.push(part.name ?? "");
          }
        } else if (event.type === "result") {
          seen.result = event;
        }
      },
    });
    const ended = seen.result;
    const usage = (ended?.usage ?? {}) as Record<string, unknown>;
    const cached = number(usage.cache_read_input_tokens);
    const written = number(usage.cache_creation_input_tokens);
    const failed = !spawned.timedOut && (spawned.code !== 0 || !ended || ended.is_error === true);
    const reply = typeof ended?.result === "string" ? ended.result : seen.lastText;
    turns.push({
      reply,
      status: spawned.timedOut ? "timed-out" : failed ? "failed" : "done",
      error: spawned.timedOut
        ? `Stopped after ${options.timeoutMs / 1000} s.`
        : failed
          ? lastLines(spawned.stderr) ||
            `Claude Code ended: ${String(ended?.subtype ?? spawned.code)}.`
          : null,
      usage: {
        ...NO_TOKENS,
        inputTokens: number(usage.input_tokens) + cached + written,
        cachedInputTokens: cached,
        cacheWriteTokens: written,
        outputTokens: number(usage.output_tokens),
      },
      reportedCostUsd: typeof ended?.total_cost_usd === "number" ? ended.total_cost_usd : null,
      toolsOffered: seen.toolsOffered,
      calls,
      startupMs: seen.startupMs ?? 0,
      totalMs: spawned.totalMs,
    });
    if (spawned.timedOut || failed) break;
  }
  return turns;
}
