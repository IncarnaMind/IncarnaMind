/**
 * The User's own command-line AI, run once for a job they pressed (ADR-0032): Claude Code, the
 * `claude` the login shell finds, or Codex (./codex), signed in as the User set them up.
 * IncarnaMind reads only the version `--version` prints and the exit code of their sign-in status
 * (and of Codex, the model catalog and the tool list it prints for a folder of the run's own), never
 * the agent's settings or sign-in, and only once the User's consent is given. A run gets
 * IncarnaMind's server with a grant, given only to that run, inside a folder of its own that goes
 * when the run ends; nothing of the run is kept.
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { OwnAiEnd, OwnAiFailure, OwnAiRunner, OwnAiStatus } from "../core/adapters";
import { endLeftRuns, object, older, processes, StalledError, short } from "./agentCommand";
import { resolveCommandOnPath } from "./claudeBinary";
import { ClaudeCodeHookError, ClaudeCodeIsolationError, runClaudeCodeTurn } from "./claudeCode";
import { actionOf, allowed, oursIn, type Places, questionOf, REFUSED } from "./claudeCodeAsks";
import { codexStatus, findCodex, runCodex, sweepCodexRuns } from "./codex";
import { deleteCodexThreads, runCodexConversation } from "./codexConversation";
import { modelsIn } from "./ownAiModels";
import { codexHomeOf } from "./ownPlaces";
import { quotingNow, sayingNow, writingNow } from "./streamedInput";

/** Restricted mode, which the run rests on, came in Claude Code 2.1.248. */
export const LOWEST_CLAUDE_CODE = "2.1.248";
/**
 * As long as a run may work before it is stopped (ADR-0032); the time a question of the AI's waits
 * on the User doesn't count (#3677).
 */
const RUN_MS = 15 * 60_000;
const MAX_RUN_BYTES = 8 * 1024 * 1024;
/** As much of the agent's last reply as the Note's label and its conversation show. */
const MAX_REPLY_CHARS = 4000;
/**
 * How long a run may send nothing that shows it getting anywhere before it is stopped as stalled
 * (#3677). While it works it sends a tick about every second as it thinks, and its words and Tool
 * inputs as it writes them; time it waits on a Tool of IncarnaMind's own, on the User, or on a
 * command of its own within that command's time doesn't count, nor a compaction (`COMPACT_MS`
 * bounds that). Its heartbeats, retries and status lines don't count as getting anywhere. The
 * longest honest silence measured on Claude Code 2.1.332 was 30 s, its own wait for tool servers
 * before its first line, else 6.3 s; it gives Anthropic's API 3 minutes for a first byte itself.
 */
const STALL_MS = 3 * 60_000;
/** A check on Codex keeps ADR-0035's six minutes: its silences weren't measured (#3677). */
const CODEX_STALL_MS = 6 * 60_000;

/**
 * Claude Code's own time for a command of its Bash or PowerShell tool: two minutes unless the call
 * asks for more, ten at most (2.1.332's defaults). A run waiting on one longer is stuck.
 */
const COMMAND_MS = 2 * 60_000;
const COMMAND_MAX_MS = 10 * 60_000;

/**
 * Whether a line of Claude Code's stream shows the run getting somewhere: not its liveness
 * heartbeat (`keep_alive`), a tool's heartbeat or a subagent's retry (`tool_progress`), a retry of
 * its own or a status line, which it sends on while nothing moves (#3677).
 */
const progressed = (message: Record<string, unknown>): boolean =>
  message.type !== "keep_alive" &&
  message.type !== "tool_progress" &&
  !(message.type === "system" && (message.subtype === "api_retry" || message.subtype === "status"));

/** How long a call of Claude Code's own tool may keep the run waiting silently, by its input. */
function waitOf(name: string, given: unknown): number {
  const input = object(given);
  if ((name !== "Bash" && name !== "PowerShell") || input.run_in_background === true) return 0;
  const asked = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : COMMAND_MS;
  return Math.min(asked, COMMAND_MAX_MS);
}

/**
 * Aborts once a run has worked for `ms`, left out the time `waiting` says it waits on the User,
 * on a clock that stands still while the computer sleeps.
 */
function workingTime(ms: number, waiting: () => boolean) {
  const over = new AbortController();
  let left = ms;
  let at = performance.now();
  const watch = setInterval(
    () => {
      const now = performance.now();
      if (!waiting()) left -= now - at;
      at = now;
      if (left > 0) return;
      clearInterval(watch);
      over.abort();
    },
    Math.min(1_000, ms / 4),
  );
  watch.unref?.();
  return { signal: over.signal, end: () => clearInterval(watch) };
}

/**
 * How long Claude Code may spend compacting a conversation, saying nothing meanwhile, before the
 * run is stopped: generous, as only one compaction was measured, 153,589 tokens to a summary of
 * 1,360 in 11 s (#3677). A longer summary takes longer, more than a larger input does.
 */
const COMPACT_MS = 10 * 60_000;

/**
 * How long Claude Code may take to answer the `initialize` of a Note's conversation, before which
 * nothing is sent: it answered in 0.2 s, new and resumed, and without waiting for the User's own
 * servers (0.4 s with one that took 20 s to start; Claude Code 2.1.331, #3653).
 */
const INITIALIZE_MS = 60_000;

/** How often the core hears that the run is alive, whatever it sent. */
const HEARD_EVERY_MS = 1_000;

/**
 * How often the line above a Note's input may take the next words of what the AI thinks or
 * writes at most (#3677): a quote takes a fifth of a second to write, too fast to read.
 */
const SAY_EVERY_MS = 1_000;
/** As much of the AI's thinking as its latest heading or sentence needs. */
const MAX_THOUGHT_CHARS = 4000;

/** An executable as it is on disk (its real path, size and time), or null when it can't be read. */
async function identityOf(executable: string): Promise<string | null> {
  try {
    const real = await realpath(executable);
    const { size, mtimeMs } = await stat(real);
    return `${real}\u0000${size}\u0000${mtimeMs}`;
  } catch {
    return null;
  }
}

/** A call's input once it is written whole, or null for one that isn't an object. */
function parsedInput(json: string): Record<string, unknown> | null {
  try {
    const input: unknown = JSON.parse(json === "" ? "{}" : json);
    return typeof input === "object" && input !== null && !Array.isArray(input)
      ? object(input)
      : null;
  } catch {
    return null;
  }
}

/** Whether a path is gone: only the system's own word for it counts, so an error it can't be told by (EIO, ELOOP) is null. */
const gone = (path: string): Promise<boolean | null> =>
  stat(path).then(
    () => false,
    (error: unknown) => {
      const code = errorCode(error);
      return code === "ENOENT" || code === "ENOTDIR" ? true : null;
    },
  );

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : "unknown";

/** What `claude purge` 2.1.330 prints, exiting 1, for a folder it holds nothing of. */
const NOTHING_TO_PURGE = /No Claude Code project data found/;
/** How long deleting a conversation's threads may take Codex. */
const PURGE_MS = 30_000;
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

/** Resolves `command` on the login shell's PATH first, falling back to `~/.local/bin/claude`. */
function resolveCommand(command: string): Promise<string | null> {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return resolveCommandOnPath(command, {
    environment: () => processes.environment(),
    home,
  });
}
/**
 * `command`, `codexCommand`: Claude Code's and Codex's, or null where this copy runs none (a test
 * build with a stand-in for only one). `conversations`: the folder of IncarnaMind's own that holds
 * each kept conversation's working folder, one per conversation, so Claude Code files its
 * transcript under that folder's name and `claude purge` deletes it alone (ADR-0034).
 */
export function createOwnAi({
  command = "claude",
  codexCommand = "codex",
  conversations,
  runMs = RUN_MS,
  stallMs = STALL_MS,
  codexStallMs = CODEX_STALL_MS,
  compactMs = COMPACT_MS,
  initializeMs = INITIALIZE_MS,
}: {
  command?: string | null;
  codexCommand?: string | null;
  conversations?: string;
  /** How long a run may take before it is stopped. */
  runMs?: number;
  /** How long a run may send nothing before it is stopped as stalled. */
  stallMs?: number;
  /** The same for a check on Codex. */
  codexStallMs?: number;
  /** How long a compaction may last before the run is stopped. */
  compactMs?: number;
  /** How long a Note's conversation waits for Claude Code to take its hook before it stops. */
  initializeMs?: number;
} = {}): OwnAiRunner {
  const folderOf = (key: string) => {
    if (!conversations || !/^[A-Za-z0-9-]{1,64}$/.test(key)) {
      throw new Error("A conversation needs a folder of IncarnaMind's own.");
    }
    return join(conversations, key);
  };
  /**
   * The threads Codex keeps each conversation as, newest last, by its key: in a file of
   * IncarnaMind's own beside the conversations' folders, out of reach of what Codex writes in one.
   */
  const threadsFolder = () => join(conversations ?? "", ".codex-threads");
  const threadsFile = (key: string) => join(threadsFolder(), `${basename(folderOf(key))}.json`);
  /** None only where no file is kept; one that can't be read throws, so nothing writes over it. */
  const threadsOf = async (key: string): Promise<string[]> => {
    let kept: unknown;
    try {
      kept = JSON.parse(await readFile(threadsFile(key), "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw new Error(
        `The ids of a conversation's threads in Codex couldn't be read (${errorCode(error)}).`,
      );
    }
    if (!Array.isArray(kept) || !kept.every((id) => typeof id === "string")) {
      throw new Error("The ids of a conversation's threads in Codex weren't a list of ids.");
    }
    return kept;
  };
  const keepThread = async (key: string, id: string) => {
    const threads = await threadsOf(key);
    if (threads.includes(id)) return;
    await mkdir(threadsFolder(), { recursive: true, mode: 0o700 });
    // Written aside and moved over it: a write cut short never leaves the ids kept before lost.
    const aside = join(threadsFolder(), `.${randomUUID()}.tmp`);
    try {
      await writeFile(aside, JSON.stringify([...threads, id]), { mode: 0o600 });
      await rename(aside, threadsFile(key));
    } finally {
      await rm(aside, { force: true });
    }
  };
  /**
   * Deletes a conversation's threads in Codex, by the ids kept of them, and then the file of
   * them: false, the file kept, when Codex couldn't be asked or didn't delete each.
   */
  const deleteThreads = async (key: string, threads: readonly string[]): Promise<boolean> => {
    const path = await codex();
    const folder = folderOf(key);
    const folders = [folder, join(await realpath(conversations ?? "").catch(() => ""), key)];
    const deleted =
      path !== null &&
      (await deleteCodexThreads(path, threads, folders, AbortSignal.timeout(PURGE_MS)).catch(
        (error: unknown) => {
          console.warn(
            "Codex couldn't delete a conversation's threads:",
            error instanceof Error ? error.message : "unknown",
          );
          return false;
        },
      ));
    if (deleted) await rm(threadsFile(key), { force: true });
    return deleted;
  };
  let sweeping: Promise<void> | null = null;
  /**
   * Deletes, in Codex, the threads of each conversation that is gone, its folder deleted, whose
   * threads Codex didn't delete with it (#3653): at start-up and after each request, as the Check's
   * folders left behind are.
   */
  const sweepThreads = () => {
    sweeping ??= (async () => {
      const names = await readdir(threadsFolder()).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") {
          console.warn("Could not look for Codex threads left behind:", errorCode(error));
        }
        return [];
      });
      for (const name of names) {
        const key = name.replace(/\.json$/, "");
        if (key === name || !/^[A-Za-z0-9-]{1,64}$/.test(key)) continue;
        const folderGone = await gone(folderOf(key));
        if (folderGone === null) {
          console.warn(
            "Could not tell whether a conversation's folder is gone; its Codex threads stay.",
          );
        }
        if (folderGone !== true) continue;
        const threads = await threadsOf(key).catch((error: unknown) => {
          console.warn("Could not read a gone conversation's Codex threads:", error);
          return null;
        });
        if (threads === null) continue;
        if (threads.length === 0) await rm(threadsFile(key), { force: true });
        else if (!(await deleteThreads(key, threads))) {
          console.warn(
            "Codex didn't delete a gone conversation's threads; they're tried again later.",
          );
        }
      }
    })()
      .catch((error: unknown) => console.warn("Could not delete Codex threads left behind:", error))
      .finally(() => {
        sweeping = null;
      });
    return sweeping;
  };

  /** A request of a Note's conversation on Codex, with its own abilities (#3653). */
  async function runCodexOwn(
    request: Parameters<OwnAiRunner["run"]>[0],
    path: string,
    conversation: NonNullable<Parameters<OwnAiRunner["run"]>[0]["conversation"]>,
    own: NonNullable<Parameters<OwnAiRunner["run"]>[0]["own"]>,
  ): ReturnType<OwnAiRunner["run"]> {
    const cwd = folderOf(conversation.key);
    let thread: string | null = null;
    try {
      thread = conversation.resume ? ((await threadsOf(conversation.key)).at(-1) ?? null) : null;
    } catch (error) {
      console.warn("A request of a Note's conversation on Codex couldn't continue:", error);
      return { kind: "failed", reason: "other" };
    }
    if (conversation.resume && thread === null)
      return { kind: "failed", reason: "lost-conversation" };
    // The time a question waits on the User isn't the run's, as on Claude Code.
    let waiting = 0;
    const worked = workingTime(runMs, () => waiting > 0);
    const signal = AbortSignal.any([request.signal, worked.signal]);
    const asking: typeof own = {
      ...own,
      ask: (question, until) => {
        waiting++;
        return own.ask(question, until).finally(() => {
          waiting--;
        });
      },
    };
    try {
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      return await runCodexConversation({
        path,
        cwd,
        server: request.server,
        tools: request.tools,
        instructions: request.instructions,
        prompt: request.prompt,
        thread,
        kept: (id) => keepThread(conversation.key, id),
        own: asking,
        ...(request.model && { model: request.model }),
        ...(request.listModels && { listModels: true }),
        ...(request.progress && { progress: request.progress }),
        ...(request.started && { started: request.started }),
        signal,
        maxBytes: MAX_RUN_BYTES,
        maxReplyChars: MAX_REPLY_CHARS,
        stallMs,
        ...(noted && { processes: noted }),
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof StalledError) return { kind: "failed", reason: "stalled" };
      if (signal.aborted) return { kind: "failed", reason: "timeout" };
      console.warn(
        "A request of a Note's conversation on Codex failed:",
        error instanceof Error ? error.message : "unknown",
      );
      return { kind: "failed", reason: "other" };
    } finally {
      worked.end();
      void sweepThreads();
    }
  }

  /** A check on Codex (./codex), or a request of a Note's conversation on it. */
  async function runOnCodex(
    request: Parameters<OwnAiRunner["run"]>[0],
  ): ReturnType<OwnAiRunner["run"]> {
    const path = await codex();
    if (path !== null && request.conversation && request.own) {
      return runCodexOwn(request, path, request.conversation, request.own);
    }
    if (path === null || request.conversation || request.tools === "all") {
      return { kind: "failed", reason: "unsupported" };
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(runMs)]);
    try {
      const end = await runCodex({
        path,
        server: request.server,
        tools: request.tools,
        instructions: request.instructions,
        prompt: request.prompt,
        signal,
        maxBytes: MAX_RUN_BYTES,
        stallMs: codexStallMs,
        ...(request.progress && { progress: request.progress }),
        ...(request.started && { started: request.started }),
      });
      if (end.kind === "finished") {
        return { kind: "finished", reply: end.reply.slice(0, MAX_REPLY_CHARS) };
      }
      if (end.cause) console.warn("A check run on Codex ended with:", end.cause);
      return { kind: "failed", reason: end.reason };
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof StalledError) return { kind: "failed", reason: "stalled" };
      if (signal.aborted) return { kind: "failed", reason: "timeout" };
      console.warn(
        "A run of the User's own Codex failed:",
        error instanceof Error ? error.message : "unknown",
      );
      return { kind: "failed", reason: "other" };
    }
  }

  // A run's folder that outlived its app holds what Codex logged of a Note.
  sweepCodexRuns().catch((error: unknown) =>
    console.warn("Could not look for Codex runs' folders left behind:", error),
  );
  // What a conversation's run started, noted while it ran, still running after a crash (#3653).
  const noted = conversations ? join(conversations, ".running") : undefined;
  if (noted) {
    endLeftRuns(noted).catch((error: unknown) =>
      console.warn("Could not end what a run left running:", error),
    );
  }
  const codex = () => (codexCommand === null ? Promise.resolve(null) : findCodex(codexCommand));
  if (conversations && codexCommand !== null) void sweepThreads();
  // The executable whose version last passed: it is asked again only once Claude Code is replaced,
  // as an update does, so a request starts it only for its sign-in first (#3677).
  let versionPassed: string | null = null;

  return {
    // Codex's approval policy is the User's own: the input chooses Claude Code's modes alone.
    choosesModes: (client) => client === "claude-code",

    async installed(client) {
      if (client === "codex") return (await codex()) !== null;
      return command !== null && (await resolveCommand(command)) !== null;
    },

    async folder(key) {
      if (!conversations) return null;
      // Its parent, made already: the folder itself is made as its first run starts.
      await mkdir(conversations, { recursive: true });
      return join(await realpath(conversations), basename(folderOf(key)));
    },

    async purge(key) {
      const folder = folderOf(key);
      const threads = await threadsOf(key).catch((error: unknown) => {
        console.warn("Could not read a conversation's Codex threads to delete them:", error);
        return null;
      });
      // With its folder gone, the sweep tries its threads again.
      if (threads === null) {
        await rm(folder, { recursive: true, force: true, maxRetries: 3 });
        return false;
      }
      if (threads.length > 0) {
        const deleted = await deleteThreads(key, threads);
        await rm(folder, { recursive: true, force: true, maxRetries: 3 });
        return deleted;
      }
      if (command === null) {
        await rm(folder, { recursive: true, force: true, maxRetries: 3 });
        return false;
      }
      const executable = (await resolveCommand(command)) ?? command;
      const purged = await short(executable, ["purge", folder, "--yes"]);
      await rm(folder, { recursive: true, force: true, maxRetries: 3 });
      if (purged.kind !== "exited") return false;
      // No transcript for the folder is an error to `claude purge`, and nothing to delete.
      return purged.code === 0 || (purged.code === 1 && NOTHING_TO_PURGE.test(purged.out));
    },

    async status(client): Promise<OwnAiStatus> {
      if (client === "codex") {
        const path = await codex();
        return path === null ? { kind: "missing" } : codexStatus(path);
      }
      if (command === null) return { kind: "missing" };
      const executable = (await resolveCommand(command)) ?? command;
      const identity = await identityOf(executable);
      if (identity === null || identity !== versionPassed) {
        const version = await short(executable, ["--version"]);
        if (version.kind === "no-answer") return { kind: "unknown" };
        if (version.kind === "absent" || version.code !== 0) return { kind: "missing" };
        const found = version.out.match(/\d+\.\d+\.\d+/)?.[0];
        if (!found || older(found, LOWEST_CLAUDE_CODE)) {
          return { kind: "too-old", found: found ?? "", lowest: LOWEST_CLAUDE_CODE };
        }
        versionPassed = identity;
      }
      // 0 signed in, 1 not: anything else says nothing about the sign-in.
      const signedIn = await short(executable, ["auth", "status"]);
      if (signedIn.kind === "exited" && signedIn.code === 0) return { kind: "ready" };
      if (signedIn.kind === "exited" && signedIn.code === 1) return { kind: "signed-out" };
      return { kind: "unknown" };
    },

    async run(request) {
      if (request.client === "codex") return runOnCodex(request);
      if (command === null) return { kind: "failed", reason: "other" };
      request.started?.();
      const compactionOver = new AbortController();
      // The questions it asked that wait on the User, each stopped by the run's end or its
      // withdrawal: the time they wait isn't the run's.
      const asking = new Map<string, AbortController>();
      const worked = workingTime(runMs, () => asking.size > 0);
      const signal = AbortSignal.any([request.signal, worked.signal, compactionOver.signal]);
      const { conversation } = request;
      const scratch = await mkdtemp(join(tmpdir(), "incarnamind-check-"));
      const cwd = conversation ? folderOf(conversation.key) : scratch;
      const ours = (tool: unknown) =>
        typeof tool === "string" && tool.startsWith(`mcp__${SERVER}__`);
      const { own } = request;
      // A call to one of IncarnaMind's other Tools is denied by Claude Code and refused by the
      // server; any other call, of a tool of its own or one its servers run, stops a sealed run.
      const stray = (part: Record<string, unknown>) =>
        !own &&
        typeof part.type === "string" &&
        part.type.endsWith("tool_use") &&
        !(part.type === "tool_use" && ours(part.name));
      // A run with its own abilities (#3653): its own calls as they go, by their ids, and until when
      // each command of them may run silently, as Claude Code's own time for it.
      const ownCalls = new Map<string, NonNullable<ReturnType<typeof actionOf>>>();
      const commands = new Map<string, { wait: number; until: number }>();
      let places: Places = { folders: [cwd], home: process.env.HOME || homedir() };
      const mode = (value: unknown) => {
        if (own && typeof value === "string" && value !== "") {
          request.progress?.({ kind: "mode", mode: value });
        }
      };
      const ask = (
        id: string,
        asked: Record<string, unknown>,
        reply: (answer: Record<string, unknown>) => void,
      ) => {
        if (!own) return;
        if (oursIn(SERVER)(asked.tool_name)) {
          reply(allowed(asked));
          return;
        }
        const question = questionOf(asked, places);
        if (!question) {
          reply(REFUSED);
          const step = typeof asked.tool_use_id === "string" ? asked.tool_use_id : id;
          request.progress?.({
            kind: "own",
            id: step,
            action: ownCalls.get(step) ?? {
              kind: "other",
              value: typeof asked.tool_name === "string" ? asked.tool_name : "",
            },
            state: "refused",
          });
          return;
        }
        const waiting = new AbortController();
        asking.set(id, waiting);
        own
          .ask(
            { step: question.step, action: question.action, suggested: question.suggested },
            waiting.signal,
          )
          .then(
            (answer) => {
              if (asking.get(id) !== waiting || waiting.signal.aborted) return;
              reply(question.answer(answer));
              // A command's own time starts when it may run, not while it waited on the User.
              const command = commands.get(String(asked.tool_use_id));
              if (command) command.until = performance.now() + command.wait;
            },
            (error: unknown) => {
              // Taken back, or the run ended: Claude Code waits on nothing.
              if (asking.get(id) !== waiting || waiting.signal.aborted) return;
              console.warn(
                "A question of Claude Code's couldn't wait on the User, so it was refused:",
                error instanceof Error ? error.message : String(error),
              );
              reply(REFUSED);
            },
          )
          .finally(() => {
            if (asking.get(id) === waiting) asking.delete(id);
          });
      };
      // The category of the request that failed last, if Claude Code named one IncarnaMind words.
      let failure: OwnAiFailure | null = null;
      let begun = false;
      let written = "";
      const endOf = (result: Record<string, unknown>): OwnAiEnd =>
        result.subtype === "success" && result.is_error === false
          ? { kind: "finished", reply: String(result.result ?? "").slice(0, MAX_REPLY_CHARS) }
          : { kind: "failed", reason: failure ?? "other" };
      let toldHeard = 0;
      // The calls of IncarnaMind's Tools sent and not yet answered: the run waits on them silently.
      const running = new Set<string>();
      // A compaction, which Claude Code works through silently: between its own status lines that
      // start and end it, in the session its start names, and no longer than `compactMs`.
      let session: string | null = null;
      let compacting: ReturnType<typeof setTimeout> | null = null;
      let compactionStuck = false;
      const compactionEnds = () => {
        if (compacting === null) return;
        clearTimeout(compacting);
        compacting = null;
        request.progress?.({ kind: "compacted" });
      };
      const compactionStarts = () => {
        if (compacting !== null) return;
        compacting = setTimeout(() => {
          compactionStuck = true;
          compactionOver.abort();
        }, compactMs);
        request.progress?.({ kind: "compacting" });
      };
      // Each call of IncarnaMind's server whose input is streaming, by its block in the message.
      const writing = new Map<number, { name: string; json: string; told: string; at: number }>();
      let thought = "";
      let thoughtTold = "";
      let thoughtAt = 0;
      let thinkingBlock = -1;
      // A summary comes in bursts: what the limit held back of one is told once the limit allows,
      // not when the next burst comes, seconds later.
      let thoughtLater: ReturnType<typeof setTimeout> | null = null;
      const tellThought = (saying: string | null) => {
        if (thoughtLater !== null) clearTimeout(thoughtLater);
        thoughtLater = null;
        if (saying === null || saying === "" || saying === thoughtTold) return;
        thoughtAt = performance.now();
        thoughtTold = saying;
        request.progress?.({ kind: "thinking", text: saying });
      };
      const heardPart = (event: Record<string, unknown>) => {
        const block = object(event.content_block);
        const delta = object(event.delta);
        const index = typeof event.index === "number" ? event.index : -1;
        if (event.type === "message_start") writing.clear();
        if (event.type === "content_block_start" && block.type === "tool_use" && ours(block.name)) {
          const name = String(block.name).slice(`mcp__${SERVER}__`.length);
          writing.set(index, { name, json: "", told: "", at: Number.NEGATIVE_INFINITY });
          request.progress?.({ kind: "tool", name });
        } else if (event.type === "content_block_start" && block.type === "text") {
          written = "";
        } else if (event.type === "content_block_start" && block.type === "thinking") {
          tellThought(null);
          thought = "";
          thoughtTold = "";
          thoughtAt = Number.NEGATIVE_INFINITY;
          thinkingBlock = index;
          request.progress?.({ kind: "thinking", text: "" });
        } else if (event.type === "content_block_stop") {
          // Its last words, whole, before the calls it led to start.
          if (index === thinkingBlock) {
            thinkingBlock = -1;
            tellThought(thought.trim());
          }
          const call = writing.get(index);
          writing.delete(index);
          const input = call ? parsedInput(call.json) : null;
          if (call && input) request.progress?.({ kind: "tool", name: call.name, input });
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          if (delta.thinking === "") return;
          thought = `${thought}${delta.thinking}`.slice(-MAX_THOUGHT_CHARS);
          const wait = thoughtAt + SAY_EVERY_MS - performance.now();
          if (wait <= 0) tellThought(sayingNow(thought));
          else thoughtLater ??= setTimeout(() => tellThought(sayingNow(thought)), wait);
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const call = writing.get(index);
          if (!call || call.json.length > MAX_RUN_BYTES) return;
          call.json += delta.partial_json;
          if (performance.now() - call.at < SAY_EVERY_MS) return;
          const text = writingNow(call.name, call.json);
          const passageId = text === null ? quotingNow(call.name, call.json) : null;
          const told = text ?? passageId ?? "";
          if (told === "" || told === call.told) return;
          call.told = told;
          call.at = performance.now();
          request.progress?.(
            text !== null
              ? { kind: "writing", tool: call.name, text }
              : { kind: "quoting", passageId: told },
          );
        } else if (delta.type === "text_delta" && typeof delta.text === "string") {
          written = `${written}${delta.text}`.slice(0, MAX_REPLY_CHARS);
          request.progress?.({ kind: "said", text: written });
        }
      };
      try {
        if (conversation) await mkdir(cwd, { recursive: true, mode: 0o700 });
        if (own) {
          places = {
            ...places,
            folders: [cwd, await realpath(cwd).catch(() => cwd)],
            codexHome: codexHomeOf(await processes.environment()),
          };
        }
        const configFile = join(scratch, "mcp.json");
        const { command: server, args, env } = request.server;
        // A Note's conversation has its Tools in its first turn: deferred, they cost each request a
        // tool search with no content first (#3753). Only this run pays for their definitions in
        // each call; a sealed check has no tool search, and the agents the User runs keep their own.
        await writeFile(
          configFile,
          JSON.stringify({
            mcpServers: {
              [SERVER]: {
                type: "stdio",
                command: server,
                args,
                env,
                ...(own && { alwaysLoad: true }),
              },
            },
          }),
          { mode: 0o600 },
        );
        const executable = (await resolveCommand(command)) ?? command;
        const result = await runClaudeCodeTurn({
          command: executable,
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
          ...(own && {
            own: {
              asked: ask,
              places: () => places,
              withdrawn: (id: string) => {
                asking.get(id)?.abort();
                asking.delete(id);
              },
              initializeMs,
              ...(noted && { processes: noted }),
              ...(request.modes && {
                modes: {
                  ...(request.modes.start && { start: request.modes.start }),
                  hear: request.modes.hear,
                  refused: (mode: string, reason: string) =>
                    request.progress?.({ kind: "modeRefused", mode, reason }),
                },
              }),
              ...(own.meanwhile && { meanwhile: own.meanwhile }),
              taken: (id: string) => request.progress?.({ kind: "taken", id }),
              answered: (result: Record<string, unknown>) => {
                const end = endOf(result);
                failure = null;
                written = "";
                request.progress?.({ kind: "answered", end });
              },
            },
          }),
          ...(request.model && { model: request.model }),
          ...((request.listModels || own) && {
            onModels: (answer: Record<string, unknown>) => {
              if (request.listModels) {
                request.progress?.({ kind: "models", models: modelsIn(answer) });
              }
              mode(answer.current_permission_mode);
            },
          }),
          partial: true,
          stallMs,
          progressed,
          // A question waits on the User for as long as they take; a command of its own, as a
          // long build, as long as Claude Code's own time for it lets it, and no longer.
          busy: () =>
            running.size > 0 ||
            compacting !== null ||
            asking.size > 0 ||
            [...commands.values()].some(({ until }) => until > performance.now()),
          onMessage(message) {
            // A heartbeat or a retry's notice says the AI isn't getting anywhere, rather than that it is.
            if (progressed(message) && performance.now() - toldHeard >= HEARD_EVERY_MS) {
              toldHeard = performance.now();
              request.progress?.({ kind: "heard" });
            }
            if (message.type === "user") {
              const content = object(message.message).content;
              for (const part of Array.isArray(content) ? content.map(object) : []) {
                if (part.type !== "tool_result") continue;
                const id = String(part.tool_use_id);
                running.delete(id);
                commands.delete(id);
                const action = ownCalls.get(id);
                if (action) {
                  ownCalls.delete(id);
                  request.progress?.({
                    kind: "own",
                    id,
                    action,
                    state: part.is_error === true ? "failed" : "done",
                  });
                }
              }
              return;
            }
            if (message.type === "stream_event") {
              const event = object(message.event);
              // Claude Code asks the model again only once each call it sent is answered or dropped,
              // and once a compaction is over.
              if (event.type === "message_start") {
                running.clear();
                compactionEnds();
              }
              // A call stops the run as it starts, not once it has been written whole.
              if (event.type === "content_block_start") {
                if (!begun) throw new StrayRunError("a reply before its start");
                if (stray(object(event.content_block))) {
                  throw new StrayRunError("a call to a tool of its own");
                }
              }
              if (begun) heardPart(event);
              return;
            }
            if (
              message.type === "system" &&
              (message.subtype === "status" || message.subtype === "compact_boundary")
            ) {
              // As Claude Code 2.1.330 says it: "compacting", then the next status (with how it went)
              // and the boundary. A line of another session, or before the start, counts for nothing.
              if (session === null || message.session_id !== session) return;
              mode(message.permissionMode);
              if (message.subtype === "status" && message.status === "compacting")
                compactionStarts();
              else compactionEnds();
              return;
            }
            if (message.type === "system" && message.subtype === "thinking_tokens") {
              compactionEnds();
              request.progress?.({ kind: "thinking" });
              return;
            }
            if (message.type === "system" && message.subtype === "init") {
              const { tools, mcp_servers: servers } = message;
              // Only IncarnaMind's server, connected, and its Tools: anything else, a flag didn't hold.
              if (!own && (!Array.isArray(tools) || !tools.every(ours))) {
                throw new StrayRunError("a tool of its own, or no list of its tools");
              }
              if (
                !own &&
                (!Array.isArray(servers) ||
                  servers.length !== 1 ||
                  object(servers[0]).name !== SERVER ||
                  object(servers[0]).status !== "connected")
              ) {
                throw new StrayRunError("another server, or IncarnaMind's not connected");
              }
              mode(message.permissionMode);
              session = typeof message.session_id === "string" ? message.session_id : null;
              begun = true;
              if (typeof message.model === "string" && message.model !== "")
                request.progress?.({ kind: "model", model: message.model });
              return;
            }
            if (message.type === "system" && message.subtype === "api_retry") {
              failure = failureOf(message.error);
              return;
            }
            if (message.type !== "assistant") return;
            if (!begun) throw new StrayRunError("a reply before its start");
            compactionEnds();
            // A reply that came back ends whatever an earlier retry was about.
            failure = failureOf(message.error);
            written = "";
            const content = object(message.message).content;
            for (const part of Array.isArray(content) ? content.map(object) : []) {
              if (
                part.type === "text" &&
                typeof part.text === "string" &&
                part.text.trim() !== ""
              ) {
                request.progress?.({ kind: "said", text: part.text.slice(0, MAX_REPLY_CHARS) });
              }
              if (stray(part)) throw new StrayRunError("a call to a tool of its own");
              if (part.type !== "tool_use") continue;
              if (ours(part.name) || !own) {
                running.add(String(part.id));
                continue;
              }
              const wait = waitOf(String(part.name ?? ""), part.input);
              if (wait > 0)
                commands.set(String(part.id), { wait, until: performance.now() + wait });
              const action = actionOf(String(part.name ?? ""), part.input, places);
              if (action) {
                ownCalls.set(String(part.id), action);
                request.progress?.({ kind: "own", id: String(part.id), action, state: "going" });
              }
            }
          },
        });
        if (!begun) {
          // A resume that finds no conversation ends before the session starts, with this subtype.
          const lost = conversation?.resume && result.subtype === "error_during_execution";
          return { kind: "failed", reason: lost ? "lost-conversation" : "other" };
        }
        return endOf(result);
      } catch (error) {
        if (request.signal.aborted) throw error;
        if (error instanceof ClaudeCodeIsolationError)
          return { kind: "failed", reason: "isolation" };
        if (error instanceof ClaudeCodeHookError) return { kind: "failed", reason: "update" };
        // Stuck retrying a limit Claude Code named, the User reads that limit.
        if (error instanceof StalledError) return { kind: "failed", reason: failure ?? "stalled" };
        if (compactionStuck) return { kind: "failed", reason: failure ?? "compaction" };
        if (signal.aborted) return { kind: "failed", reason: "timeout" };
        console.warn(
          "A run of the User's own AI failed:",
          error instanceof Error ? error.message : "unknown",
        );
        return { kind: "failed", reason: failure ?? "other" };
      } finally {
        worked.end();
        for (const waiting of asking.values()) waiting.abort();
        asking.clear();
        if (compacting !== null) clearTimeout(compacting);
        if (thoughtLater !== null) clearTimeout(thoughtLater);
        await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() =>
          console.warn("Could not remove the temporary folder of a run of the User's own AI."),
        );
      }
    },
  };
}
