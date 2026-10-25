/**
 * Harness (c): Codex CLI, `codex exec --json` (README.md).
 *
 * - No user config or rules (`--ignore-user-config`, `--ignore-rules`), a
 *   temporary home and CODEX_HOME holding the session, so the second turn
 *   resumes it (`codex exec resume`).
 * - Its built-in Tools off: the shell and its kin, images, the web, plugins,
 *   apps, subagents and the rest (`CODEX_OFF`), and the read-only sandbox
 *   besides. The Tools each request offers are logged by the model proxy,
 *   so a Tool left on shows in the run's record.
 * - Its model provider is the bake-off's proxy (./modelProxy) on
 *   127.0.0.1, reached with a token for the run: Codex never sees a key.
 */
import {
  childEnv,
  jsonLine,
  lastLines,
  NO_TOKENS,
  type OutsideRunOptions,
  type OutsideTurn,
  runLines,
} from "./outside";

export const CODEX_SERVER = "incarnamind";

/** Codex features a run turns off, so no built-in Tool reaches the model. */
export const CODEX_OFF = [
  "shell_tool",
  "unified_exec",
  "unified_exec_tty",
  "shell_snapshot",
  "view_image",
  "image_generation",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "plugins",
  "apps",
  "remote_plugin",
  "hooks",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "tool_suggest",
  "goals",
  "skill_search",
  "skill_mcp_dependency_install",
  "sleep_tool",
  "workspace_dependencies",
  "worktrees",
  "realtime_conversation",
  "api_key_model_discovery",
] as const;

const toml = (value: string) => JSON.stringify(value);
const tomlTable = (entries: Record<string, string>) =>
  `{${Object.entries(entries)
    .map(([key, value]) => `${key}=${toml(value)}`)
    .join(",")}}`;

const PROVIDER = "incarnamind_eval";
const MODEL_TOKEN_ENV = "INCARNAMIND_HARNESS_MODEL_TOKEN";

/** The `-c` settings every turn of a run takes. */
export function codexSettings(options: OutsideRunOptions, proxyBaseUrl: string): string[] {
  const server = options.server;
  return [
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'web_search="disabled"',
    "analytics.enabled=false",
    "check_for_update_on_startup=false",
    `model_reasoning_effort=${toml(options.effort)}`,
    `developer_instructions=${toml(options.instructions)}`,
    `model_provider=${toml(PROVIDER)}`,
    `model_providers.${PROVIDER}=${tomlTable({
      name: "IncarnaMind evaluation",
      base_url: proxyBaseUrl,
      env_key: MODEL_TOKEN_ENV,
      wire_api: "responses",
    })}`,
    `mcp_servers.${CODEX_SERVER}.command=${toml(server.command)}`,
    `mcp_servers.${CODEX_SERVER}.args=${JSON.stringify(server.args)}`,
    `mcp_servers.${CODEX_SERVER}.env=${tomlTable(server.env)}`,
    `mcp_servers.${CODEX_SERVER}.env_vars=${JSON.stringify(Object.keys(server.secretEnv))}`,
    // Codex otherwise starts the turn before the server's Tools are listed, and the model calls
    // Tools it can only guess the names of.
    `mcp_servers.${CODEX_SERVER}.required=true`,
    `mcp_servers.${CODEX_SERVER}.startup_timeout_sec=30`,
    `mcp_servers.${CODEX_SERVER}.tool_timeout_sec=120`,
  ];
}

const number = (value: unknown) => (typeof value === "number" ? value : 0);

type Usage = Required<typeof NO_TOKENS>;

/**
 * A turn's own usage from what `codex exec` reported for it: a resumed session reports the
 * thread's running total, so the turns before are taken off. A turn that ended before Codex
 * reported anything used nothing it can count.
 */
export function ownUsage(reported: Usage, thread: Usage): { usage: Usage; thread: Usage } {
  if (reported.inputTokens === 0 || reported.inputTokens < thread.inputTokens) {
    return { usage: { ...NO_TOKENS }, thread };
  }
  return {
    usage: {
      inputTokens: reported.inputTokens - thread.inputTokens,
      cachedInputTokens: reported.cachedInputTokens - thread.cachedInputTokens,
      cacheWriteTokens: 0,
      outputTokens: reported.outputTokens - thread.outputTokens,
    },
    thread: reported,
  };
}

export async function runCodex(
  bin: string,
  proxy: { baseUrl: string; token: string },
  options: OutsideRunOptions,
): Promise<OutsideTurn[]> {
  const env = childEnv(options, { CODEX_HOME: options.configDir, [MODEL_TOKEN_ENV]: proxy.token });
  const settings = codexSettings(options, proxy.baseUrl).flatMap((setting) => ["-c", setting]);
  const off = CODEX_OFF.flatMap((feature) => ["--disable", feature]);
  const turns: OutsideTurn[] = [];
  const session: { thread: string | null } = { thread: null };
  let threadUsage: Usage = { ...NO_TOKENS };
  for (const [index, prompt] of options.turns.entries()) {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      ...(index === 0 ? ["-C", options.workDir] : ["resume", session.thread ?? ""]),
      "-m",
      options.model,
      ...settings,
      ...off,
      prompt,
    ];
    const seen: {
      startupMs: number | null;
      reply: string;
      error: string | null;
      usage: Required<typeof NO_TOKENS>;
    } = { startupMs: null, reply: "", error: null, usage: { ...NO_TOKENS } };
    const calls: string[] = [];
    const spawned = await runLines({
      bin,
      args,
      env,
      cwd: options.workDir,
      stdin: null,
      eventsFile: options.eventsFile,
      timeoutMs: options.timeoutMs,
      onLine(line, atMs) {
        const event = jsonLine(line);
        if (!event) return;
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          session.thread = event.thread_id;
        } else if (event.type === "turn.started") {
          seen.startupMs ??= atMs;
        } else if (event.type === "turn.completed") {
          const used = (event.usage ?? {}) as Record<string, unknown>;
          seen.usage = {
            ...NO_TOKENS,
            inputTokens: seen.usage.inputTokens + number(used.input_tokens),
            cachedInputTokens: seen.usage.cachedInputTokens + number(used.cached_input_tokens),
            outputTokens: seen.usage.outputTokens + number(used.output_tokens),
          };
        } else if (event.type === "turn.failed") {
          const failure = (event.error ?? {}) as { message?: string };
          seen.error = failure.message ?? "The turn failed.";
        } else if (event.type === "error" && typeof event.message === "string") {
          seen.error = event.message;
        } else if (event.type === "item.completed") {
          const item = (event.item ?? {}) as Record<string, unknown>;
          if (item.type === "agent_message" && typeof item.text === "string")
            seen.reply = item.text;
          else if (item.type === "mcp_tool_call")
            calls.push(`${String(item.server)}.${String(item.tool)}`);
          else if (!["reasoning", "todo_list", "error"].includes(String(item.type)))
            calls.push(String(item.type));
        }
      },
    });
    const failed =
      !spawned.timedOut && (spawned.code !== 0 || (seen.error !== null && !seen.reply));
    const own = ownUsage(seen.usage, threadUsage);
    threadUsage = own.thread;
    const turnUsage = own.usage;
    turns.push({
      reply: seen.reply,
      status: spawned.timedOut ? "timed-out" : failed ? "failed" : "done",
      error: spawned.timedOut
        ? `Stopped after ${options.timeoutMs / 1000} s.`
        : failed
          ? (seen.error ?? (lastLines(spawned.stderr) || `Codex exited with ${spawned.code}.`))
          : null,
      usage: turnUsage,
      reportedCostUsd: null,
      toolsOffered: null,
      calls,
      startupMs: seen.startupMs ?? 0,
      totalMs: spawned.totalMs,
    });
    if (spawned.timedOut || failed || session.thread === null) break;
  }
  return turns;
}
