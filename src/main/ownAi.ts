/**
 * The User's own command-line AI, run once for a check they pressed (ADR-0032): Claude Code, the
 * `claude` the login shell finds, signed in as the User set it up. IncarnaMind reads only the
 * version `--version` prints and the exit code of `auth status`, never the agent's settings or
 * sign-in, and only once the User's consent is given. A run gets
 * IncarnaMind's server with a grant, in a settings file only the User's account can read, inside
 * a folder of its own that goes when the run ends; nothing of the run is kept.
 */
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { OwnAiFailure, OwnAiRunner, OwnAiStatus } from "../core/adapters";
import { stopProcessTree } from "../core/execution";
import { ClaudeCodeIsolationError, drained, object, runClaudeCodeTurn } from "./claudeCode";
import { createLoginShellProcesses } from "./processes";

const processes = createLoginShellProcesses();

/** Restricted mode, which the run rests on, came in Claude Code 2.1.248. */
export const LOWEST_CLAUDE_CODE = "2.1.248";
/** As long as a run may take before it is stopped (ADR-0032). */
const RUN_MS = 15 * 60_000;
const MAX_RUN_BYTES = 8 * 1024 * 1024;
/** As much of the agent's last reply as the Note's label and its conversation show. */
const MAX_REPLY_CHARS = 4000;
const STATUS_MS = 15_000;

/** What `claude purge` 2.1.330 prints, exiting 1, for a folder it holds nothing of. */
const NOTHING_TO_PURGE = /No Claude Code project data found/;
const SERVER = "incarnamind";

/**
 * The CLI's own categories of a failed request, for words IncarnaMind says; others say nothing.
 * A request it retries gives one in `system/api_retry`, one it doesn't on its assistant message's
 * `error`, as a signed-out `claude -p` shows.
 */
const FAILURE_OF: Record<string, OwnAiFailure> = {
  authentication_failed: "signed-out",
  rate_limit: "plan-limit",
  billing_error: "billing",
};

const failureOf = (category: unknown): OwnAiFailure | null =>
  typeof category === "string" ? (FAILURE_OF[category] ?? null) : null;

/**
 * The run showed something no check run should: a flag didn't hold. The flags are what hold the
 * run to IncarnaMind's Tools; this only notices when they didn't, so anything it can't read stops.
 */
class StrayRunError extends Error {
  constructor(what: string) {
    super(`A check run on Claude Code showed ${what}, so it was stopped.`);
    this.name = "StrayRunError";
  }
}

const older = (found: string, lowest: string) => {
  const [a, b] = [found, lowest].map((each) => each.split(".").map(Number));
  for (let at = 0; at < 3; at++) {
    const one = a?.[at] ?? 0;
    const two = b?.[at] ?? 0;
    if (one !== two) return one < two;
  }
  return false;
};

type Short =
  | { kind: "exited"; code: number | null; out: string }
  /** The command isn't there. */
  | { kind: "absent" }
  /** It couldn't be started for another reason, or took too long: it says nothing. */
  | { kind: "no-answer" };

/** A short command's exit code and what it printed. */
async function short(command: string, args: string[]): Promise<Short> {
  let child: Awaited<ReturnType<typeof processes.spawn>>;
  try {
    child = await processes.spawn(command, args, { processGroup: true });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") console.warn(`Could not start ${command} ${args.join(" ")} (${code}).`);
    return code === "ENOENT" ? { kind: "absent" } : { kind: "no-answer" };
  }
  let out = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      if (out.length < 4096) out += chunk.toString("utf8");
    });
  }
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), STATUS_MS);
  });
  const code = await Promise.race([closed, deadline]);
  clearTimeout(timer);
  if (code !== "late") return { kind: "exited", code, out };
  stopProcessTree(child);
  await drained(child, closed);
  return { kind: "no-answer" };
}

/** A file the User's account may run. */
const runnable = async (path: string) =>
  (await stat(path).catch(() => null))?.isFile() === true &&
  (await access(path, constants.X_OK).then(
    () => true,
    () => false,
  ));

/** Whether the login shell's PATH holds `command`, as a terminal would find it, looked up without starting it. */
async function onPath(command: string): Promise<boolean> {
  if (isAbsolute(command)) return runnable(command);
  const environment = await processes.environment();
  const value = (name: string) =>
    Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1] ?? "";
  const names =
    process.platform === "win32"
      ? (value("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => `${command}${ext}`)
      : [command];
  for (const folder of value("PATH").split(delimiter).filter(Boolean)) {
    for (const name of names) if (await runnable(join(folder, name))) return true;
  }
  return false;
}

/**
 * `conversations`: the folder of IncarnaMind's own that holds each kept conversation's working
 * folder, one per conversation, so Claude Code files its transcript under that folder's name and
 * `claude purge` deletes it alone (ADR-0034).
 */
export function createOwnAi({
  command = "claude",
  conversations,
}: {
  command?: string;
  conversations?: string;
} = {}): OwnAiRunner {
  const folderOf = (key: string) => {
    if (!conversations || !/^[A-Za-z0-9-]{1,64}$/.test(key)) {
      throw new Error("A conversation needs a folder of IncarnaMind's own.");
    }
    return join(conversations, key);
  };
  return {
    installed: () => onPath(command),

    async purge(key) {
      const folder = folderOf(key);
      const purged = await short(command, ["purge", folder, "--yes"]);
      await rm(folder, { recursive: true, force: true, maxRetries: 3 });
      if (purged.kind !== "exited") return false;
      // No transcript for the folder is an error to `claude purge`, and nothing to delete.
      return purged.code === 0 || (purged.code === 1 && NOTHING_TO_PURGE.test(purged.out));
    },

    async status(): Promise<OwnAiStatus> {
      const version = await short(command, ["--version"]);
      if (version.kind === "no-answer") return { kind: "unknown" };
      if (version.kind === "absent" || version.code !== 0) return { kind: "missing" };
      const found = version.out.match(/\d+\.\d+\.\d+/)?.[0];
      if (!found || older(found, LOWEST_CLAUDE_CODE)) {
        return { kind: "too-old", found: found ?? "", lowest: LOWEST_CLAUDE_CODE };
      }
      // 0 signed in, 1 not: anything else says nothing about the sign-in.
      const signedIn = await short(command, ["auth", "status"]);
      if (signedIn.kind === "exited" && signedIn.code === 0) return { kind: "ready" };
      if (signedIn.kind === "exited" && signedIn.code === 1) return { kind: "signed-out" };
      return { kind: "unknown" };
    },

    async run(request) {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(RUN_MS)]);
      const { conversation } = request;
      const scratch = await mkdtemp(join(tmpdir(), "incarnamind-check-"));
      const cwd = conversation ? folderOf(conversation.key) : scratch;
      const ours = (tool: unknown) =>
        typeof tool === "string" && tool.startsWith(`mcp__${SERVER}__`);
      // The category of the request that failed last, if Claude Code named one IncarnaMind words.
      let failure: OwnAiFailure | null = null;
      let begun = false;
      try {
        if (conversation) await mkdir(cwd, { recursive: true, mode: 0o700 });
        const configFile = join(scratch, "mcp.json");
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
          scratch,
          systemPrompt: request.instructions,
          prompt: request.prompt,
          signal,
          maxResponseBytes: MAX_RUN_BYTES,
          server: { configFile, name: SERVER, tools: request.tools },
          ...(conversation && {
            session: { id: conversation.sessionId, resume: conversation.resume },
          }),
          permissionMode: request.permissionMode,
          onMessage(message) {
            if (message.type === "system" && message.subtype === "init") {
              const { tools, mcp_servers: servers } = message;
              // Only IncarnaMind's server, connected, and its Tools: anything else, a flag didn't hold.
              if (!Array.isArray(tools) || !tools.every(ours)) {
                throw new StrayRunError("a tool of its own, or no list of its tools");
              }
              if (
                !Array.isArray(servers) ||
                servers.length !== 1 ||
                object(servers[0]).name !== SERVER ||
                object(servers[0]).status !== "connected"
              ) {
                throw new StrayRunError("another server, or IncarnaMind's not connected");
              }
              begun = true;
              return;
            }
            if (message.type === "system" && message.subtype === "api_retry") {
              failure = failureOf(message.error);
              return;
            }
            if (message.type !== "assistant") return;
            if (!begun) throw new StrayRunError("a reply before its start");
            // A reply that came back ends whatever an earlier retry was about.
            failure = failureOf(message.error);
            const content = object(message.message).content;
            for (const part of Array.isArray(content) ? content.map(object) : []) {
              // A call to one of IncarnaMind's other Tools is denied by Claude Code and refused by
              // the server; any other call, of a tool of its own or one its servers run, stops it.
              const call = typeof part.type === "string" && part.type.endsWith("tool_use");
              if (call && !(part.type === "tool_use" && ours(part.name))) {
                throw new StrayRunError("a call to a tool of its own");
              }
            }
          },
        });
        if (!begun) {
          // A resume that finds no conversation ends before the session starts, with this subtype.
          const lost = conversation?.resume && result.subtype === "error_during_execution";
          return { kind: "failed", reason: lost ? "lost-conversation" : "other" };
        }
        return result.subtype === "success" && result.is_error === false
          ? { kind: "finished", reply: String(result.result ?? "").slice(0, MAX_REPLY_CHARS) }
          : { kind: "failed", reason: failure ?? "other" };
      } catch (error) {
        if (request.signal.aborted) throw error;
        if (error instanceof ClaudeCodeIsolationError)
          return { kind: "failed", reason: "isolation" };
        if (error instanceof StrayRunError) console.warn(error.message);
        if (signal.aborted) return { kind: "failed", reason: "timeout" };
        return { kind: "failed", reason: failure ?? "other" };
      } finally {
        await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() =>
          console.warn("Could not remove the temporary folder of a run of the User's own AI."),
        );
      }
    },
  };
}
