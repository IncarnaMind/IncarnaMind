/**
 * A request of a Note's conversation on the User's own Codex, with its own abilities (#3653): its
 * app-server (ADR-0026) in the conversation's own folder, signed in and set up as the User set it
 * up, IncarnaMind's server added beside the User's own. Each approval Codex asks for goes to the
 * User's card and back as they answer; each item it starts is a step; Stop ends it and everything
 * it started. Codex keeps the conversation as a thread of its own, by the id `kept` is told.
 */
import { realpath } from "node:fs/promises";
import type { Writable } from "node:stream";
import type { OwnAiAsk, OwnAiEnd, OwnAiFailure, OwnAiModel, OwnAiProgress } from "../core/adapters";
import type { AgentLaunch, NoteAction, NoteAnswer } from "../core/api";
import { object, processes, readJsonLines, wholeTree } from "./agentCommand";
import { APP_SERVER_ARGS, appServerWriter, initializeParams } from "./codexAppServer";
import { codexHomeOf, codexSteering, itemActionOf, questionOf, refusalOf } from "./codexAsks";
import type { Places } from "./ownPlaces";
import { sayingNow } from "./streamedInput";

const SERVER = "incarnamind";
/** As long as a Tool of IncarnaMind's may take; Codex's own default is a minute. */
const TOOL_TIMEOUT_SEC = 120;
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

/** Codex's approval policy as a mode: its name, "granular" for one set rule by rule. */
function modeOf(result: Record<string, unknown>): string | null {
  const policy = result.approvalPolicy;
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
  const steering = codexSteering(() => codexHomeOf(environment));
  const places: Places = {
    folders: [run.cwd, await realpath(run.cwd).catch(() => run.cwd)],
    home: environment.HOME || "",
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
  const ourCalls = new Set<string>();
  const asking = new Map<unknown, AbortController>();
  let compacting = false;
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
        return undefined;
      },
    );
  };

  const send = (id: string, prompt: string) => {
    if (!rpc || threadId === null || turnId === null || !turning) {
      queued.push({ id, prompt });
      return;
    }
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

  const opened = (message: Record<string, unknown>): OwnAiEnd | undefined => {
    const result = object(message.result);
    const id = object(result.thread).id;
    if (message.error !== undefined || typeof id !== "string" || id === "") {
      if (run.thread !== null) return { kind: "failed", reason: "lost-conversation" };
      throw new Error("Codex didn't start a thread.");
    }
    threadId = id;
    const mode = modeOf(result);
    if (mode) progress?.({ kind: "mode", mode });
    const model = text(result.model);
    if (model !== "") progress?.({ kind: "model", model });
    void run.kept(id).then(
      () => startTurn(run.prompt, null),
      (error: unknown) => {
        console.warn("Could not keep the id of Codex's thread:", error);
        tree.end();
      },
    );
    return undefined;
  };

  const openThread = () => {
    if (!rpc) return;
    const params = {
      cwd: run.cwd,
      developerInstructions: run.instructions,
      config,
      ...(run.model && { model: run.model }),
    };
    if (run.thread !== null) {
      rpc.request("thread/resume", { threadId: run.thread, ...params }, opened);
    } else rpc.request("thread/start", params, opened);
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
    const question = questionOf(method, params, places, steering, (item) => fileItems.get(item));
    if (!question) {
      const refusal = refusalOf(method);
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
    asking.set(id, waiting);
    const { answer, ...asked } = question;
    own
      .ask(asked, waiting.signal)
      .then(
        (given) => {
          if (asking.get(id) === waiting && !waiting.signal.aborted) {
            writer.respond(id, answer(given));
          }
        },
        (error: unknown) => {
          // Withdrawn, or the run ended: Codex waits on nothing.
          if (asking.get(id) !== waiting || waiting.signal.aborted) return;
          console.warn(
            "A question of Codex's couldn't wait on the User, so it was refused:",
            error instanceof Error ? error.message : String(error),
          );
          writer.respond(id, answer("deny"));
        },
      )
      .finally(() => {
        if (asking.get(id) === waiting) asking.delete(id);
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
      compacting = true;
      progress?.({ kind: "compacting" });
      return;
    }
    if (item.type === "mcpToolCall" && item.server === SERVER) {
      ourCalls.add(id);
      const name = text(item.tool);
      progress?.({ kind: "tool", name });
      progress?.({ kind: "tool", name, input: object(item.arguments) });
      return;
    }
    if (item.type === "fileChange") fileItems.set(id, item);
    const action = itemActionOf(item, places, steering, SERVER);
    if (!action || id === "") return;
    ownSteps.set(id, action);
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
      compacting = false;
      progress?.({ kind: "compacted" });
      return;
    }
    ourCalls.delete(id);
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
        : {
            kind: "failed",
            reason:
              failureOf(turn.error) ?? failure ?? (turn.status === "failed" ? "service" : "other"),
          };
    failure = null;
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
      busy: () => asking.size > 0 || ourCalls.size > 0 || ownSteps.size > 0 || compacting,
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
        if (method === "turn/started") {
          const turn = object(params.turn);
          if (typeof turn.id === "string") turnId = turn.id;
          turning = true;
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
          asking.get(id)?.abort();
          asking.delete(id);
        } else if (method === "error") {
          failure = failureOf(params.error) ?? failure;
        }
        return undefined;
      },
    });
  } finally {
    for (const waiting of asking.values()) waiting.abort();
    asking.clear();
    if (thoughtLater !== null) clearTimeout(thoughtLater);
  }
}

/**
 * Deletes the threads Codex keeps a conversation as, by their ids, through its app-server: true
 * when Codex deleted each, or had none of them.
 */
export async function deleteCodexThreads(
  path: string,
  threads: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  if (threads.length === 0) return true;
  const child = await processes.spawn(path, [...APP_SERVER_ARGS], { processGroup: true });
  let rpc: ReturnType<typeof appServerWriter<boolean>> | null = null;
  let left = threads.length;
  let all = true;
  return readJsonLines<boolean>(child, {
    agent: "Codex",
    signal,
    maxBytes: 1024 * 1024,
    rawMaxBytes: 8 * 1024 * 1024,
    begin(stdin) {
      rpc = appServerWriter<boolean>(stdin);
      const writer = rpc;
      writer.request("initialize", initializeParams("incarnamind"), () => {
        writer.notify("initialized");
        for (const threadId of threads) {
          writer.request("thread/delete", { threadId }, (message) => {
            // A thread Codex no longer has is deleted already.
            const error = object(message.error);
            if (
              message.error !== undefined &&
              !/not found|no thread|no rollout/i.test(text(error.message))
            ) {
              all = false;
            }
            left--;
            return left === 0 ? all : undefined;
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
