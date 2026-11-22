/**
 * One turn of the User's own Claude Code command line, started by IncarnaMind (ADR-0032): for
 * Meetings' requests, with no tools at all, and for a check the User pressed, with IncarnaMind's
 * server and the Tools it may call. The `claude` the login shell finds runs in a folder of its own,
 * with none of its built-in tools, hooks, connectors, slash commands, CLAUDE.md files or memory;
 * anything not allowed is denied, never asked.
 */
import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stopProcessTree } from "../core/execution";
import { createLoginShellProcesses } from "./processes";

const processes = createLoginShellProcesses();

export interface ClaudeCodeTurn {
  /** The command: `claude`, unless a test build gives another. */
  command?: string;
  /** A folder of the turn's own, which its caller removes: the system prompt is written there. */
  cwd: string;
  systemPrompt: string;
  prompt: string;
  signal: AbortSignal;
  /** The most the turn may print; past it, it is stopped. */
  maxResponseBytes: number;
  /**
   * IncarnaMind's server, as a file of MCP settings only the User's account can read, and the
   * Tools of it the turn may call; none: no tools at all.
   */
  server?: { configFile: string; name: string; tools: readonly string[] };
  /** Whether Claude Code keeps the turn's session, to be continued later; a check keeps none. */
  persist: boolean;
  /** Each message before the result, from the first; one that throws stops the turn. */
  onMessage?(message: Record<string, unknown>): void;
}

const SYSTEM_PROMPT_FILE = "system-prompt.txt";

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseLine(line: string): Record<string, unknown> {
  try {
    return object(JSON.parse(line));
  } catch {
    throw new Error("Claude Code returned an unreadable result.");
  }
}

function argsOf(turn: ClaudeCodeTurn): string[] {
  const { server } = turn;
  return [
    "-p",
    // Safe mode drops every MCP server, the one given on the command line too.
    ...(server ? [] : ["--safe-mode"]),
    "--restricted",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    server?.configFile ?? '{"mcpServers":{}}',
    ...(server
      ? ["--allowedTools", server.tools.map((tool) => `mcp__${server.name}__${tool}`).join(",")]
      : []),
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    ...(turn.persist ? [] : ["--no-session-persistence"]),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    '{"disableAllHooks":true,"disableClaudeAiConnectors":true}',
    // On Windows an npm-installed `claude.cmd` runs through cmd.exe, where a line break in an
    // argument ends the command: the prompt goes on stdin and the system prompt in a file.
    "--system-prompt-file",
    join(turn.cwd, SYSTEM_PROMPT_FILE),
  ];
}

/** Starts the turn and resolves with its result message, a successful one or not. */
export async function runClaudeCodeTurn(turn: ClaudeCodeTurn): Promise<Record<string, unknown>> {
  await writeFile(join(turn.cwd, SYSTEM_PROMPT_FILE), turn.systemPrompt, { mode: 0o600 });
  const child = await processes.spawn(turn.command ?? "claude", argsOf(turn), {
    cwd: turn.cwd,
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // The User's CLAUDE.md files and Claude Code's memory are not IncarnaMind's to give the turn.
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
    processGroup: true,
  });
  return readTurn(child, turn);
}

/** How long a stopped turn's output may take to close before IncarnaMind stops reading it. */
const STOP_WAIT_MS = 5_000;

async function readTurn(child: ChildProcess, turn: ClaudeCodeTurn) {
  const { signal } = turn;
  let open = true;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      open = false;
      resolve();
    }),
  );
  // The whole group, whatever its leader's own state: a process it started can hold the output
  // after the leader exits. A group's id isn't reused while any member of it lives.
  const kill = () => {
    if (open) stopProcessTree(child);
  };
  child.on("error", kill);
  child.stdin?.on("error", kill);
  child.stderr?.resume();
  if (!child.stdin || !child.stdout) {
    kill();
    await drained(child, closed);
    throw new Error("Claude Code input or output is unavailable.");
  }
  const stdin = child.stdin;
  const lines = createInterface({ input: child.stdout });
  // Stopped: the reading ends now, not once every holder of the output lets it go.
  const stop = () => {
    kill();
    lines.close();
  };
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > turn.maxResponseBytes) stop();
  });
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    stdin.write(
      `${JSON.stringify({ type: "control_request", request_id: "settings", request: { subtype: "get_settings" } })}\n`,
    );
    let sent = false;
    for await (const line of lines) {
      signal.throwIfAborted();
      const msg = parseLine(line);
      if (msg.type === "control_response" && !sent) {
        const control = object(msg.response);
        const settings = object(control.response);
        const effective = object(settings.effective);
        // Managed hooks and managed plugins can override the flags and receive what is sent.
        if (
          control.subtype !== "success" ||
          control.request_id !== "settings" ||
          effective.disableAllHooks !== true ||
          !Array.isArray(settings.sources) ||
          [effective, ...settings.sources.map((source) => object(object(source).settings))].some(
            (value) =>
              Object.keys(object(value.hooks)).length > 0 ||
              Object.values(object(value.enabledPlugins)).some(Boolean),
          )
        )
          throw new ClaudeCodeIsolationError();
        signal.throwIfAborted();
        sent = true;
        stdin.end(
          `${JSON.stringify({ type: "user", message: { role: "user", content: turn.prompt } })}\n`,
        );
        continue;
      }
      if (msg.type === "result") {
        if (!sent || bytes > turn.maxResponseBytes) {
          throw new Error("Claude Code could not complete the request.");
        }
        // A result ends this turn even when the CLI keeps its stream open.
        return msg;
      }
      turn.onMessage?.(msg);
    }
    signal.throwIfAborted();
    throw new Error("Claude Code could not complete the request.");
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    await drained(child, closed);
  }
}

/** Waits for a stopped turn's output to close, up to `STOP_WAIT_MS`; past that, stops reading it. */
async function drained(child: ChildProcess, closed: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), STOP_WAIT_MS);
  });
  const tooLate = await Promise.race([closed.then(() => false), late]);
  clearTimeout(timer);
  if (!tooLate) return;
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
  console.warn(
    "Claude Code's output stayed open after it was stopped, so IncarnaMind stopped reading it.",
  );
}

/** Claude Code's effective settings hold a hook or an enabled plugin, which nothing here can turn off. */
export class ClaudeCodeIsolationError extends Error {
  constructor() {
    super("Claude Code could not isolate this request from external hooks.");
    this.name = "ClaudeCodeIsolationError";
  }
}
