/**
 * One turn of the User's own Claude Code command line, started by IncarnaMind (ADR-0032): for
 * Meetings' requests, with no tools at all, and for a check the User pressed, with IncarnaMind's
 * server and the Tools it may call. The `claude` the login shell finds runs in a folder of its own,
 * with none of its built-in tools, hooks, connectors, slash commands, CLAUDE.md files or memory;
 * anything not allowed is denied, never asked. A turn of a Note's conversation keeps Claude Code's
 * own abilities instead, on the User's own settings, and asks its host what they say to ask (#3653).
 */
import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { object, processes, readJsonLines, wholeTree } from "./agentCommand";
import { STEERING_HOOK, STEERING_HOOKS, steeringAnswer } from "./claudeCodeAsks";

export interface ClaudeCodeTurn {
  /** The command: `claude`, unless a test build gives another. */
  command?: string;
  /** The folder the turn runs in. */
  cwd: string;
  /** A private folder of the turn's own, which its caller removes: the system prompt is written there. */
  scratch: string;
  systemPrompt: string;
  prompt: string;
  signal: AbortSignal;
  /** The most the turn may print; past it, it is stopped. */
  maxResponseBytes: number;
  /**
   * IncarnaMind's server, as a file of MCP settings only the User's account can read, and the
   * Tools of it the turn may call (all of them: "all"); none: no tools at all.
   */
  server?: { configFile: string; name: string; tools: readonly string[] | "all" };
  /**
   * The conversation Claude Code keeps, started with this id or continued; none: it keeps nothing,
   * as a check and Meetings' requests do.
   */
  session?: { id: string; resume: boolean };
  /**
   * Claude Code keeps its own tools, servers, skills, hooks, CLAUDE.md files and memory, on the
   * User's own settings, with IncarnaMind's server beside them and IncarnaMind's instructions
   * added to its own (#3653). Each permission question it asks comes to `asked`, with `reply` to
   * answer it while the turn goes; `withdrawn` hears one it took back. Its `initialize` answer
   * comes to `onModels`. Absent: the sealed turn above.
   */
  own?: {
    asked(
      id: string,
      request: Record<string, unknown>,
      reply: (answer: Record<string, unknown>) => void,
    ): void;
    withdrawn(id: string): void;
    /** Where what the turn starts is noted while it runs, for the next start to end after a crash. */
    processes?: string;
    /** How long Claude Code may take to answer `initialize`, before which nothing is sent. */
    initializeMs: number;
  };
  /** A model alias or name Claude Code offers; absent: its own default. */
  model?: string;
  /** Each message before the result, from the first; one that throws stops the turn. */
  onMessage?(message: Record<string, unknown>): void;
  /**
   * Asks Claude Code, before the prompt goes, which models it offers (its `initialize` answer, no
   * model call), and hears that answer once the isolation check has passed.
   */
  onModels?(answer: Record<string, unknown>): void;
  /** The stream carries the words and each Tool call as they come (`stream_event` messages). */
  partial?: boolean;
  /**
   * How long Claude Code may send nothing before the turn is stopped as stalled. A turn that
   * still works never stays quiet that long: it sends a tick while it thinks, and with `partial`
   * its words as it writes them.
   */
  stallMs?: number;
  /**
   * Whether it waits, without a word meanwhile, on a Tool of IncarnaMind's own, on the User, or on
   * a tool of its own at work: that time doesn't count towards `stallMs`.
   */
  busy?(): boolean;
}

const SYSTEM_PROMPT_FILE = "system-prompt.txt";

function argsOf(turn: ClaudeCodeTurn): string[] {
  const { server } = turn;
  const kept = [
    ...(turn.model ? ["--model", turn.model] : []),
    ...(turn.session
      ? [turn.session.resume ? "--resume" : "--session-id", turn.session.id]
      : ["--no-session-persistence"]),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(turn.partial ? ["--include-partial-messages"] : []),
  ];
  if (turn.own && server) {
    // No permission mode, settings or setting sources of IncarnaMind's: the User's own apply.
    return [
      "-p",
      "--mcp-config",
      server.configFile,
      "--allowedTools",
      `mcp__${server.name}`,
      "--permission-prompt-tool",
      "stdio",
      ...kept,
      // Added to Claude Code's own system prompt, which its tools need, and from a file, as below.
      "--append-system-prompt-file",
      join(turn.scratch, SYSTEM_PROMPT_FILE),
    ];
  }
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
      ? [
          "--allowedTools",
          server.tools === "all"
            ? `mcp__${server.name}`
            : server.tools.map((tool) => `mcp__${server.name}__${tool}`).join(","),
        ]
      : []),
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    ...kept,
    "--settings",
    '{"disableAllHooks":true,"disableClaudeAiConnectors":true}',
    // On Windows an npm-installed `claude.cmd` runs through cmd.exe, where a line break in an
    // argument ends the command: the prompt goes on stdin and the system prompt in a file.
    "--system-prompt-file",
    join(turn.scratch, SYSTEM_PROMPT_FILE),
  ];
}

/** Starts the turn and resolves with its result message, a successful one or not. */
export async function runClaudeCodeTurn(turn: ClaudeCodeTurn): Promise<Record<string, unknown>> {
  await writeFile(join(turn.scratch, SYSTEM_PROMPT_FILE), turn.systemPrompt, { mode: 0o600 });
  const child = await processes.spawn(turn.command ?? "claude", argsOf(turn), {
    cwd: turn.cwd,
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ...(!turn.own && {
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        // The User's CLAUDE.md files and Claude Code's memory are not IncarnaMind's to give the turn.
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      }),
      // A Tool input streams as it is written, so a run writing a long one isn't quiet meanwhile.
      ...(turn.partial && { CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1" }),
    },
    processGroup: true,
  });
  return turn.own ? readOwnTurn(child, turn, turn.own) : readTurn(child, turn);
}

/** How much more than `maxResponseBytes` a turn may print with its words and calls as they come. */
const RAW_TIMES = 8;

function readTurn(child: ChildProcess, turn: ClaudeCodeTurn) {
  const { signal } = turn;
  let sent = false;
  let models: Record<string, unknown> | null = null;
  const hearModels = () => {
    if (!sent || !models) return;
    turn.onModels?.(models);
    models = null;
  };
  return readJsonLines(child, {
    agent: "Claude Code",
    signal,
    maxBytes: turn.maxResponseBytes,
    rawMaxBytes: turn.partial ? turn.maxResponseBytes * RAW_TIMES : turn.maxResponseBytes,
    // Its words and calls as they came repeat what the whole messages say.
    counted: (message) => message.type !== "stream_event",
    ...(turn.stallMs !== undefined && { stallMs: turn.stallMs }),
    ...(turn.busy && { busy: turn.busy }),
    begin(stdin) {
      stdin.write(
        `${JSON.stringify({ type: "control_request", request_id: "settings", request: { subtype: "get_settings" } })}\n`,
      );
      if (turn.onModels) {
        stdin.write(
          `${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } })}\n`,
        );
      }
    },
    onMessage(msg, stdin) {
      if (msg.type === "control_response" && object(msg.response).request_id === "models") {
        models = object(object(msg.response).response);
        hearModels();
        return undefined;
      }
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
        hearModels();
        return undefined;
      }
      // A result ends this turn even when the CLI keeps its stream open. Before the prompt went,
      // Claude Code ended at its start (a conversation it doesn't have, say): nothing of the
      // request was sent, and its result says why.
      if (msg.type === "result") return msg;
      turn.onMessage?.(msg);
      return undefined;
    },
  });
}

const write = (stdin: Writable, message: Record<string, unknown>) => {
  if (stdin.writable) stdin.write(`${JSON.stringify(message)}\n`);
};

/** Claude Code didn't take the `initialize` that registers IncarnaMind's hook: nothing was sent. */
export class ClaudeCodeHookError extends Error {
  constructor() {
    super("Claude Code didn't take IncarnaMind's hook, so the request wasn't sent.");
    this.name = "ClaudeCodeHookError";
  }
}

/**
 * A turn with Claude Code's own abilities (#3653): its `initialize`, which registers IncarnaMind's
 * hook, goes first, and the prompt only once Claude Code has taken it; the input stays open until
 * the result, since each permission question is answered there. A question of another kind than a
 * tool's gets an error, so it never waits on a host that can't answer it. It ends with everything
 * it started.
 */
function readOwnTurn(
  child: ChildProcess,
  turn: ClaudeCodeTurn,
  own: NonNullable<ClaudeCodeTurn["own"]>,
) {
  const closed = new Promise((resolve) => child.once("close", resolve));
  const tree = wholeTree(child, closed, own.processes);
  let prompted = false;
  // Nothing goes before Claude Code takes the hook, so a wait on it ends well before the stall.
  const unanswered = new AbortController();
  const waiting = setTimeout(() => unanswered.abort(), own.initializeMs);
  return readJsonLines(child, {
    agent: "Claude Code",
    signal: AbortSignal.any([turn.signal, unanswered.signal]),
    end: tree.end,
    maxBytes: turn.maxResponseBytes,
    rawMaxBytes: turn.partial ? turn.maxResponseBytes * RAW_TIMES : turn.maxResponseBytes,
    counted: (message) => message.type !== "stream_event",
    ...(turn.stallMs !== undefined && { stallMs: turn.stallMs }),
    ...(turn.busy && { busy: turn.busy }),
    begin(stdin) {
      write(stdin, {
        type: "control_request",
        request_id: "models",
        request: { subtype: "initialize", hooks: STEERING_HOOKS },
      });
    },
    onMessage(msg, stdin) {
      if (msg.type === "control_response") {
        const control = object(msg.response);
        if (control.request_id === "models" && !prompted) {
          const answer = object(control.response);
          // Without its hook a steering file would be written unasked: the prompt never goes. Claude
          // Code says it registered the hook, and that a failed answer blocks; one too old to know
          // either answers without saying so, as its own SDK reads it.
          if (
            control.subtype !== "success" ||
            answer.hooks_applied !== true ||
            answer.hook_on_failure_supported !== true
          )
            throw new ClaudeCodeHookError();
          clearTimeout(waiting);
          turn.onModels?.(answer);
          turn.signal.throwIfAborted();
          prompted = true;
          write(stdin, {
            type: "user",
            message: { role: "user", content: turn.prompt },
            parent_tool_use_id: null,
            session_id: "",
          });
        }
        return undefined;
      }
      if (msg.type === "control_request") {
        const id = typeof msg.request_id === "string" ? msg.request_id : "";
        const request = object(msg.request);
        if (request.subtype === "hook_callback" && request.callback_id === STEERING_HOOK) {
          write(stdin, {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: id,
              response: steeringAnswer(object(request.input)),
            },
          });
        } else if (request.subtype === "can_use_tool" && id !== "") {
          own.asked(id, request, (answer) =>
            write(stdin, {
              type: "control_response",
              response: { subtype: "success", request_id: id, response: answer },
            }),
          );
        } else {
          write(stdin, {
            type: "control_response",
            response: {
              subtype: "error",
              request_id: id,
              error: "IncarnaMind doesn't answer this.",
            },
          });
        }
        return undefined;
      }
      if (msg.type === "control_cancel_request") {
        if (typeof msg.request_id === "string") own.withdrawn(msg.request_id);
        return undefined;
      }
      if (msg.type === "result") return msg;
      turn.onMessage?.(msg);
      return undefined;
    },
  })
    .catch((error: unknown) => {
      if (unanswered.signal.aborted && !turn.signal.aborted) throw new ClaudeCodeHookError();
      throw error;
    })
    .finally(() => clearTimeout(waiting));
}

/** Claude Code's effective settings hold a hook or an enabled plugin, which nothing here can turn off. */
export class ClaudeCodeIsolationError extends Error {
  constructor() {
    super("Claude Code could not isolate this request from external hooks.");
    this.name = "ClaudeCodeIsolationError";
  }
}
