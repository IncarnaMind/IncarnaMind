/**
 * A request of a Note's conversation on the User's own Codex, with its own abilities (#3653): its
 * app-server (ADR-0026) in the conversation's own folder, signed in and set up as the User set it
 * up, IncarnaMind's server added beside the User's own. Each approval Codex asks for goes to the
 * User's card and back as they answer; each item it starts is a step; Stop ends it and everything
 * it started. Codex keeps the conversation as a thread of its own, by the id `kept` is told.
 */
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Writable } from "node:stream";
import type { OwnAiAsk, OwnAiEnd, OwnAiFailure, OwnAiModel, OwnAiProgress } from "../core/adapters";
import { SERVER_KEY } from "../core/agents/clients";
import type { AgentLaunch, NoteAction, NoteAnswer } from "../core/api";
import { object, processes, readJsonLines, wholeTree } from "./agentCommand";
import { APP_SERVER_ARGS, appServerWriter, initializeParams } from "./codexAppServer";
import { type Asking, itemActionOf, questionOf, refusalOf } from "./codexAsks";
import { agentSteering, codexHomeOf, type Places } from "./ownPlaces";
import { sayingNow } from "./streamedInput";

/**
 * IncarnaMind's server for the run, by a name no connection writes: Codex merges what the run
 * gives with the User's own table of that name, whose token, if IncarnaMind's connection wrote one,
 * would stand in for the run's grant. The connection's own is turned off for the run.
 */
const SERVER = "incarnamind_note";
/** As long as a Tool of IncarnaMind's may take; Codex's own default is a minute. */
const TOOL_TIMEOUT_SEC = 120;
/**
 * How long one of Codex's own steps, or a compaction, keeps the run from counting as stalled when
 * its end never comes: as long as a run's compaction may take (src/main/ownAi.ts).
 */
const STEP_MS = 10 * 60_000;
const HEARD_EVERY_MS = 1_000;
const SAY_EVERY_MS = 1_000;
const MAX_THOUGHT_CHARS = 4000;
const RAW_TIMES = 8;

/** Notifications that repeat what a whole item says, or say nothing of the request. */
const NOT_COUNTED = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "turn/moderationMetadata",
  "thread/tokenUsage/updated",
  "account/rateLimits/updated",
]);

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Why Codex says a request failed, as IncarnaMind words it; null for a reason it doesn't. */
function failureOf(error: unknown): OwnAiFailure | null {
  const info = object(error).codexErrorInfo;
  if (info === "unauthorized") return "signed-out";
  if (info === "usageLimitExceeded" || info === "sessionBudgetExceeded") return "plan-limit";
  return null;
}

/**
 * Codex's approval policy as a mode: its name, "granular" for one set rule by rule; on its own
 * request, with no sandbox, "dangerFullAccess", since then nothing it does needs asking for.
 */
function modeOf(result: Record<string, unknown>): string | null {
  const policy = result.approvalPolicy;
  if (
    object(result.sandbox).type === "dangerFullAccess" &&
    (policy === "on-request" || policy === "on-failure")
  ) {
    return "dangerFullAccess";
  }
  // A reviewer of Codex's own decides in the User's place: nothing reaches them.
  if (
    policy !== "never" &&
    text(result.approvalsReviewer) !== "" &&
    result.approvalsReviewer !== "user"
  ) {
    return text(result.approvalsReviewer);
  }
  if (typeof policy === "string") return policy;
  return policy !== null && typeof policy === "object" ? (Object.keys(policy)[0] ?? null) : null;
}

/** The models Codex offers, as `model/list` gives them; its hidden ones aren't. */
function modelsOf(result: Record<string, unknown>): OwnAiModel[] {
  const data = Array.isArray(result.data) ? result.data.map(object) : [];
  return data.flatMap((each) => {
    const model = text(each.model);
    if (model === "" || each.hidden === true) return [];
    return [
      {
        value: model,
        resolvedModel: model,
        displayName: text(each.displayName) || model,
        description: text(each.description),
      },
    ];
  });
}

export interface CodexConversation {
  /** Where Codex is, as `findCodex` found it. */
  path: string;
  /** The conversation's own folder, made already. */
  cwd: string;
  server: AgentLaunch;
  tools: readonly string[] | "all";
  instructions: string;
  prompt: string;
  /** The thread Codex keeps the conversation as, to continue; null for a new one. */
  thread: string | null;
  /** Told the thread's id once Codex opened it, before the prompt goes. */
  kept(threadId: string): Promise<void>;
  own: {
    ask(asked: OwnAiAsk, signal: AbortSignal): Promise<NoteAnswer>;
    meanwhile?(send: (id: string, prompt: string) => void): void;
  };
  model?: string;
  listModels?: boolean;
  progress?(step: OwnAiProgress): void;
  started?(): void;
  signal: AbortSignal;
  maxBytes: number;
  maxReplyChars: number;
  stallMs: number;
  /** Where what it starts is noted while it runs, for the next start to end after a crash. */
  processes?: string;
}

/**
 * Runs the request until Codex's turn for it, and each one sent meanwhile, ends; aborting
 * `signal` ends it, and every process it started, at once. A thread to continue that Codex no
 * longer has ends "lost-conversation".
 */
export async function runCodexConversation(run: CodexConversation): Promise<OwnAiEnd> {
  const { progress, own } = run;
  const environment = await processes.environment();
  const places: Places = {
    folders: [run.cwd, await realpath(run.cwd).catch(() => run.cwd)],
    home: environment.HOME || "",
    codexHome: codexHomeOf(environment),
  };
  const asking: Asking = {
    places,
    steering: agentSteering(places),
    files: (item) => fileItems.get(item),
    sandboxed: true,
  };
  const child = await processes.spawn(
    run.path,
    [...APP_SERVER_ARGS, "-c", "check_for_update_on_startup=false"],
    { cwd: run.cwd, env: { ...run.server.env }, processGroup: true },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  const tree = wholeTree(child, closed, run.processes);

  let rpc: ReturnType<typeof appServerWriter<OwnAiEnd>> | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let turning = false;
  let first = true;
  // Requests sent meanwhile (#3765): steered into the turn going, or waiting for the next.
  const queued: { id: string; prompt: string }[] = [];
  const steered = new Map<string, string>();
  // Codex's own steps going, by their item's id, and its file changes, which its question names.
  const ownSteps = new Map<string, NoteAction>();
  const fileItems = new Map<string, Record<string, unknown>>();
  // When each began: one whose end never comes stops keeping the run from stalling (STEP_MS).
  const going = new Map<string, number>();
  const questions = new Map<unknown, AbortController>();
  let compacting: number | null = null;
  // The User said no where Codex offers only "cancel", which ends its turn: the request is over.
  let cancelled = false;
  let failure: OwnAiFailure | null = null;
  let reply = "";
  const written = new Map<string, string>();
  let toldHeard = Number.NEGATIVE_INFINITY;
  let thought = "";
  let thoughtTold = "";
  let thoughtAt = Number.NEGATIVE_INFINITY;
  let thoughtLater: ReturnType<typeof setTimeout> | null = null;
  const tellThought = (saying: string | null) => {
    if (thoughtLater !== null) clearTimeout(thoughtLater);
    thoughtLater = null;
    if (saying === null || saying === "" || saying === thoughtTold) return;
    thoughtAt = performance.now();
    thoughtTold = saying;
    progress?.({ kind: "thinking", text: saying });
  };

  const config = {
    mcp_servers: {
      // Given a command, as a table of Codex's needs one, though it never starts.
      [SERVER_KEY]: { command: run.server.command, enabled: false },
      [SERVER]: {
        command: run.server.command,
        args: run.server.args,
        // The grant reaches the server from Codex's environment, by name.
        env_vars: Object.keys(run.server.env),
        ...(run.tools !== "all" && { enabled_tools: run.tools }),
        default_tools_approval_mode: "approve",
        tool_timeout_sec: TOOL_TIMEOUT_SEC,
      },
    },
    // A project AGENTS.md, as one written in the conversation's folder, steers none of its later
    // requests; Codex's own in its home still does (#3653).
    project_doc_max_bytes: 0,
    // The User's prompt history would keep the Note's words after the conversation is deleted.
    history: { persistence: "none" },
    // Memories Codex makes of a thread outlive the thread; the thread itself is kept out of them
    // too, for a Codex of the User's that has them on (`thread/memoryMode/set`).
    features: { memories: false },
  };

  const startTurn = (prompt: string, id: string | null) => {
    if (!rpc || threadId === null) return;
    if (first) run.started?.();
    first = false;
    turning = true;
    reply = "";
    rpc.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: prompt }],
        ...(id !== null && { clientUserMessageId: id }),
      },
      (message) => {
        const started = object(object(message.result).turn);
        if (message.error !== undefined || typeof started.id !== "string") {
          throw new Error("Codex didn't start its turn.");
        }
        turnId = started.id;
        flush();
        return undefined;
      },
    );
  };

  const steer = (id: string, prompt: string) => {
    if (!rpc || threadId === null || turnId === null) return;
    steered.set(id, prompt);
    rpc.request(
      "turn/steer",
      {
        threadId,
        input: [{ type: "text", text: prompt }],
        expectedTurnId: turnId,
        clientUserMessageId: id,
      },
      (message) => {
        // The turn ended as it was sent, or takes nothing more: it goes as the next one.
        if (message.error !== undefined && steered.delete(id)) queued.push({ id, prompt });
        return undefined;
      },
    );
  };
  /** Steers what waits into the turn going, oldest first, once there is one to steer into. */
  const flush = () => {
    if (!rpc || threadId === null || turnId === null || !turning) return;
    for (const { id, prompt } of queued.splice(0)) steer(id, prompt);
  };
  // One line for every request sent meanwhile: a later one never goes ahead of one still waiting.
  const send = (id: string, prompt: string) => {
    queued.push({ id, prompt });
    flush();
  };

  /** A thread Codex couldn't resume or read: lost where Codex no longer has it. */
  const unopened = (error: unknown): OwnAiEnd => {
    if (missingThread(error, run.thread)) return { kind: "failed", reason: "lost-conversation" };
    console.warn("Codex couldn't open a conversation's thread:", text(object(error).message));
    return { kind: "failed", reason: "service" };
  };

  const opened = (message: Record<string, unknown>): OwnAiEnd | undefined => {
    const result = object(message.result);
    const id = object(result.thread).id;
    if (message.error !== undefined || typeof id !== "string" || id === "") {
      if (run.thread !== null) return unopened(message.error);
      throw new Error("Codex didn't start a thread.");
    }
    threadId = id;
    const sandbox = object(result.sandbox).type;
    asking.sandboxed = sandbox === "readOnly" || sandbox === "workspaceWrite";
    const mode = modeOf(result);
    if (mode) progress?.({ kind: "mode", mode });
    const model = text(result.model);
    if (model !== "") progress?.({ kind: "model", model });
    rpc?.request("thread/memoryMode/set", { threadId: id, mode: "disabled" }, (set) => {
      if (set.error !== undefined)
        throw new Error("Codex didn't keep the thread out of its memories.");
      void run.kept(id).then(
        () => startTurn(run.prompt, null),
        (error: unknown) => {
          console.warn("Could not keep the id of Codex's thread:", error);
          tree.end();
        },
      );
      return undefined;
    });
    return undefined;
  };

  const openThread = () => {
    if (!rpc) return;
    const writer = rpc;
    const params = {
      cwd: run.cwd,
      developerInstructions: run.instructions,
      config,
      ...(run.model && { model: run.model }),
    };
    const thread = run.thread;
    if (thread === null) {
      writer.request("thread/start", params, opened);
      return;
    }
    // The id comes from a file of IncarnaMind's: a thread of another folder is never resumed here.
    writer.request("thread/read", { threadId: thread }, (read) => {
      if (read.error !== undefined) return unopened(read.error);
      const cwd = text(object(object(read.result).thread).cwd);
      if (!ownFolder(cwd, places.folders)) {
        console.warn(
          "A conversation's thread in Codex was of another folder, so it wasn't resumed.",
        );
        return { kind: "failed", reason: "lost-conversation" };
      }
      writer.request("thread/resume", { threadId: thread, ...params }, opened);
      return undefined;
    });
  };

  const ask = (id: unknown, method: string, params: Record<string, unknown>) => {
    if (!rpc) return;
    const writer = rpc;
    const meta = object(params._meta);
    if (
      method === "mcpServer/elicitation/request" &&
      params.serverName === SERVER &&
      meta.codex_approval_kind === "mcp_tool_call"
    ) {
      // IncarnaMind's own Tool: its grant decides what it may do.
      writer.respond(id, { action: "accept", content: {}, _meta: null });
      return;
    }
    const question = questionOf(method, params, asking);
    if (!question) {
      const refusal = refusalOf(method, params);
      if (refusal?.decision === "cancel") cancelled = true;
      if (refusal) writer.respond(id, refusal);
      else writer.unsupported(id, method);
      if (refusal) {
        const step = text(params.itemId) || String(id);
        progress?.({
          kind: "own",
          id: step,
          action: ownSteps.get(step) ?? {
            kind: "other",
            value: text(meta.tool_name) || text(params.reason) || method,
          },
          state: "refused",
        });
      }
      return;
    }
    const waiting = new AbortController();
    questions.set(id, waiting);
    const { answer, ...asked } = question;
    own
      .ask(asked, waiting.signal)
      .then(
        (given) => {
          if (questions.get(id) === waiting && !waiting.signal.aborted) {
            const answered = answer(given);
            if (answered.decision === "cancel") cancelled = true;
            writer.respond(id, answered);
          }
        },
        (error: unknown) => {
          // Withdrawn, or the run ended: Codex waits on nothing.
          if (questions.get(id) !== waiting || waiting.signal.aborted) return;
          console.warn(
            "A question of Codex's couldn't wait on the User, so it was refused:",
            error instanceof Error ? error.message : String(error),
          );
          const refused = answer("deny");
          if (refused.decision === "cancel") cancelled = true;
          writer.respond(id, refused);
        },
      )
      .finally(() => {
        if (questions.get(id) === waiting) questions.delete(id);
      });
  };

  const itemStarted = (item: Record<string, unknown>) => {
    const id = text(item.id);
    if (item.type === "userMessage") {
      const client = text(item.clientId);
      if (client === "") return;
      steered.delete(client);
      progress?.({ kind: "taken", id: client });
      return;
    }
    if (item.type === "agentMessage") {
      written.set(id, "");
      return;
    }
    if (item.type === "reasoning") {
      tellThought(null);
      thought = "";
      thoughtTold = "";
      thoughtAt = Number.NEGATIVE_INFINITY;
      progress?.({ kind: "thinking", text: "" });
      return;
    }
    if (item.type === "contextCompaction") {
      compacting = performance.now();
      progress?.({ kind: "compacting" });
      return;
    }
    if (item.type === "mcpToolCall" && item.server === SERVER) {
      going.set(id, performance.now());
      const name = text(item.tool);
      progress?.({ kind: "tool", name });
      progress?.({ kind: "tool", name, input: object(item.arguments) });
      return;
    }
    if (item.type === "fileChange") fileItems.set(id, item);
    const action = itemActionOf(item, places, asking.steering, SERVER);
    if (!action || id === "") return;
    ownSteps.set(id, action);
    going.set(id, performance.now());
    progress?.({ kind: "own", id, action, state: "going" });
  };

  const itemCompleted = (item: Record<string, unknown>) => {
    const id = text(item.id);
    if (item.type === "agentMessage") {
      written.delete(id);
      const said = text(item.text);
      if (said.trim() === "") return;
      reply = said;
      progress?.({ kind: "said", text: said.slice(0, run.maxReplyChars) });
      return;
    }
    if (item.type === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary.map(text).join("\n") : "";
      tellThought(summary.trim() || null);
      return;
    }
    if (item.type === "contextCompaction") {
      compacting = null;
      progress?.({ kind: "compacted" });
      return;
    }
    going.delete(id);
    fileItems.delete(id);
    const action = ownSteps.get(id);
    if (!action) return;
    ownSteps.delete(id);
    const failed =
      item.status === "failed" ||
      item.status === "declined" ||
      (item.type === "commandExecution" &&
        typeof item.exitCode === "number" &&
        item.exitCode !== 0);
    progress?.({ kind: "own", id, action, state: failed ? "failed" : "done" });
  };

  const turnEnded = (turn: Record<string, unknown>): OwnAiEnd | undefined => {
    if (turnId !== null && turn.id !== turnId) return undefined;
    turning = false;
    turnId = null;
    const end: OwnAiEnd =
      turn.status === "completed"
        ? { kind: "finished", reply: reply.slice(0, run.maxReplyChars) }
        : turn.status === "interrupted" && cancelled
          ? { kind: "finished", reply: reply.slice(0, run.maxReplyChars), endedAtAsk: true }
          : {
              kind: "failed",
              reason:
                failureOf(turn.error) ??
                failure ??
                (turn.status === "failed" ? "service" : "other"),
            };
    failure = null;
    cancelled = false;
    // Steered in as the turn ended, and never taken: it goes as the next turn.
    for (const [id, prompt] of steered) queued.push({ id, prompt });
    steered.clear();
    const next = queued.shift();
    if (!next) return end;
    progress?.({ kind: "answered", end });
    startTurn(next.prompt, next.id);
    return undefined;
  };

  try {
    return await readJsonLines<OwnAiEnd>(child, {
      agent: "Codex",
      signal: run.signal,
      end: tree.end,
      maxBytes: run.maxBytes,
      rawMaxBytes: run.maxBytes * RAW_TIMES,
      counted: (message) => !NOT_COUNTED.has(text(message.method)),
      stallMs: run.stallMs,
      // A question waits on the User for as long as they take; a command of its own, as a long
      // build, runs as long as Codex's own limit for it lets it.
      busy: () => {
        if (questions.size > 0) return true;
        const since = performance.now() - STEP_MS;
        return (
          (compacting !== null && compacting > since) ||
          [...going.values()].some((at) => at > since)
        );
      },
      begin(stdin: Writable) {
        rpc = appServerWriter<OwnAiEnd>(stdin);
        const writer = rpc;
        writer.request("initialize", initializeParams("incarnamind"), (message) => {
          if (message.error !== undefined) throw new Error("Codex didn't take the handshake.");
          writer.notify("initialized");
          if (!run.listModels) {
            openThread();
            return undefined;
          }
          writer.request("model/list", { includeHidden: false }, (models) => {
            const listed = modelsOf(object(models.result));
            if (listed.length > 0) progress?.({ kind: "models", models: listed });
            openThread();
            return undefined;
          });
          return undefined;
        });
        own.meanwhile?.(send);
      },
      onMessage(message) {
        if (performance.now() - toldHeard >= HEARD_EVERY_MS) {
          toldHeard = performance.now();
          progress?.({ kind: "heard" });
        }
        const method = text(message.method);
        if (method !== "" && "id" in message) {
          ask(message.id, method, object(message.params));
          return undefined;
        }
        if (method === "") return rpc?.answered(message)?.value;
        const params = object(message.params);
        // A subagent's thread tells its turns and items on this connection too: they aren't the
        // request's, whose turn they would otherwise end or be steered into.
        const from = params.threadId;
        if (
          (method.startsWith("turn/") || method.startsWith("item/")) &&
          typeof from === "string" &&
          from !== threadId
        ) {
          return undefined;
        }
        if (method === "turn/started") {
          const turn = object(params.turn);
          if (typeof turn.id === "string") turnId = turn.id;
          turning = true;
          flush();
          return undefined;
        }
        if (method === "turn/completed") return turnEnded(object(params.turn));
        if (method === "item/started") itemStarted(object(params.item));
        else if (method === "item/completed") itemCompleted(object(params.item));
        else if (method === "item/agentMessage/delta") {
          const id = text(params.itemId);
          const said = `${written.get(id) ?? ""}${text(params.delta)}`.slice(0, run.maxReplyChars);
          written.set(id, said);
          progress?.({ kind: "said", text: said });
        } else if (method === "item/reasoning/summaryTextDelta") {
          const delta = text(params.delta);
          if (delta === "") return undefined;
          thought = `${thought}${delta}`.slice(-MAX_THOUGHT_CHARS);
          const wait = thoughtAt + SAY_EVERY_MS - performance.now();
          if (wait <= 0) tellThought(sayingNow(thought));
          else thoughtLater ??= setTimeout(() => tellThought(sayingNow(thought)), wait);
        } else if (method === "serverRequest/resolved") {
          // Withdrawn: the turn it belonged to ended, as a Stop of Codex's own does.
          const id = params.requestId;
          questions.get(id)?.abort();
          questions.delete(id);
        } else if (method === "error") {
          failure = failureOf(params.error) ?? failure;
        }
        return undefined;
      },
    });
  } finally {
    for (const waiting of questions.values()) waiting.abort();
    questions.clear();
    if (thoughtLater !== null) clearTimeout(thoughtLater);
  }
}

/**
 * Whether Codex answered that it has no thread `id`, as Codex 0.170 words it: "no rollout found"
 * to `thread/resume` and `thread/delete`, "thread not loaded" to `thread/read`. Any other error,
 * an unknown method's (-32601) among them, says nothing of the thread.
 */
export function missingThread(error: unknown, id: string | null): boolean {
  const { code, message } = object(error);
  return (
    id !== null &&
    code === -32600 &&
    (message === `no rollout found for thread id ${id}` || message === `thread not loaded: ${id}`)
  );
}

/** Whether a thread's folder, as Codex keeps it, is the conversation's own. */
const ownFolder = (cwd: string, folders: readonly string[]) =>
  cwd !== "" && folders.some((folder) => resolve(folder) === resolve(cwd));

/**
 * Deletes the threads Codex keeps a conversation as, by their ids, through its app-server: true
 * when Codex deleted each, or had none of them. A thread Codex keeps of another folder than the
 * conversation's `folders` is never deleted: it isn't the conversation's.
 */
export async function deleteCodexThreads(
  path: string,
  threads: readonly string[],
  folders: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  if (threads.length === 0) return true;
  const child = await processes.spawn(
    path,
    [...APP_SERVER_ARGS, "-c", "check_for_update_on_startup=false"],
    { cwd: dirname(folders[0] ?? ""), processGroup: true },
  );
  let rpc: ReturnType<typeof appServerWriter<boolean>> | null = null;
  let left = threads.length;
  let all = true;
  const settled = (deleted: boolean) => {
    if (!deleted) all = false;
    left--;
    return left === 0 ? all : undefined;
  };
  return readJsonLines<boolean>(child, {
    agent: "Codex",
    signal,
    maxBytes: 1024 * 1024,
    rawMaxBytes: 8 * 1024 * 1024,
    begin(stdin) {
      rpc = appServerWriter<boolean>(stdin);
      const writer = rpc;
      writer.request("initialize", initializeParams("incarnamind"), (message) => {
        if (message.error !== undefined) throw new Error("Codex didn't take the handshake.");
        writer.notify("initialized");
        for (const threadId of threads) {
          writer.request("thread/read", { threadId }, (read) => {
            if (read.error !== undefined) return settled(missingThread(read.error, threadId));
            const cwd = text(object(object(read.result).thread).cwd);
            if (!ownFolder(cwd, folders)) {
              console.warn(
                "A conversation's thread in Codex was of another folder, so it was kept.",
              );
              return settled(true);
            }
            writer.request("thread/delete", { threadId }, (deleted) =>
              settled(deleted.error === undefined || missingThread(deleted.error, threadId)),
            );
            return undefined;
          });
        }
        return undefined;
      });
    },
    onMessage(message) {
      if ("method" in message && "id" in message) {
        rpc?.unsupported(message.id, text(message.method));
        return undefined;
      }
      return rpc?.answered(message)?.value;
    },
  });
}
