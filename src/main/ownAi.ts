/**
 * The User's own command-line AI, run once for a job they pressed (ADR-0032): Claude Code, the
 * `claude` the login shell finds, or Codex (./codex), signed in as the User set them up.
 * IncarnaMind reads only the version `--version` prints and the exit code of their sign-in status
 * (and of Codex, the model catalog and the tool list it prints for a folder of the run's own), never
 * the agent's settings or sign-in, and only once the User's consent is given. A run gets
 * IncarnaMind's server with a grant, given only to that run, inside a folder of its own that goes
 * when the run ends; nothing of the run is kept.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { OwnAiFailure, OwnAiRunner, OwnAiStatus } from "../core/adapters";
import { endLeftRuns, object, older, processes, StalledError, short } from "./agentCommand";
import { resolveCommandOnPath } from "./claudeBinary";
import { ClaudeCodeHookError, ClaudeCodeIsolationError, runClaudeCodeTurn } from "./claudeCode";
import { actionOf, allowed, oursIn, type Places, questionOf, REFUSED } from "./claudeCodeAsks";
import { codexStatus, findCodex, runCodex, sweepCodexRuns } from "./codex";
import { modelsIn } from "./ownAiModels";

/** Restricted mode, which the run rests on, came in Claude Code 2.1.248. */
export const LOWEST_CLAUDE_CODE = "2.1.248";
/** As long as a run may take before it is stopped (ADR-0032). */
const RUN_MS = 15 * 60_000;
const MAX_RUN_BYTES = 8 * 1024 * 1024;
/** As much of the agent's last reply as the Note's label and its conversation show. */
const MAX_REPLY_CHARS = 4000;
/**
 * How long a run may send nothing before it is stopped as stalled. While it works it sends a tick
 * about every second as it thinks, and its words and Tool inputs as it writes them; time it waits
 * on a Tool of IncarnaMind's own doesn't count, nor a compaction (`COMPACT_MS` bounds that). Past
 * Claude Code's own 5 minutes with no data, its own watchdog and retry act first (#3677).
 */
const STALL_MS = 6 * 60_000;

/**
 * How long Claude Code may spend compacting a conversation, saying nothing meanwhile, before the
 * run is stopped: generous, as only one compaction was measured, 153,589 tokens to a summary of
 * 1,360 in 11 s (#3677). A longer summary takes longer, more than a larger input does.
 */
const COMPACT_MS = 10 * 60_000;

/**
 * How long Claude Code may take to answer the `initialize` of a Note's conversation, before which
 * nothing is sent: it answered in 0.2 s, new and resumed (Claude Code 2.1.331, #3653).
 */
const INITIALIZE_MS = 60_000;

/** How often the core hears that the run is alive, whatever it sent. */
const HEARD_EVERY_MS = 1_000;

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
  /** A check on Codex (./codex); a kept conversation isn't one it runs (#3639). */
  async function runCodexCheck(
    request: Parameters<OwnAiRunner["run"]>[0],
  ): ReturnType<OwnAiRunner["run"]> {
    const path = await codex();
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
        stallMs,
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

  return {
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
      const version = await short(executable, ["--version"]);
      if (version.kind === "no-answer") return { kind: "unknown" };
      if (version.kind === "absent" || version.code !== 0) return { kind: "missing" };
      const found = version.out.match(/\d+\.\d+\.\d+/)?.[0];
      if (!found || older(found, LOWEST_CLAUDE_CODE)) {
        return { kind: "too-old", found: found ?? "", lowest: LOWEST_CLAUDE_CODE };
      }
      // 0 signed in, 1 not: anything else says nothing about the sign-in.
      const signedIn = await short(executable, ["auth", "status"]);
      if (signedIn.kind === "exited" && signedIn.code === 0) return { kind: "ready" };
      if (signedIn.kind === "exited" && signedIn.code === 1) return { kind: "signed-out" };
      return { kind: "unknown" };
    },

    async run(request) {
      if (request.client === "codex") return runCodexCheck(request);
      if (command === null) return { kind: "failed", reason: "other" };
      request.started?.();
      const compactionOver = new AbortController();
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(runMs),
        compactionOver.signal,
      ]);
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
      // A run with its own abilities (#3653): its own calls as they go, by their ids, and the
      // questions it asked that wait on the User, each stopped by the run's end or its withdrawal.
      const ownCalls = new Map<string, NonNullable<ReturnType<typeof actionOf>>>();
      const asking = new Map<string, AbortController>();
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
              if (asking.get(id) === waiting && !waiting.signal.aborted)
                reply(question.answer(answer));
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
      const heardPart = (event: Record<string, unknown>) => {
        const block = object(event.content_block);
        const delta = object(event.delta);
        if (event.type === "content_block_start" && block.type === "tool_use" && ours(block.name)) {
          request.progress?.({
            kind: "tool",
            name: String(block.name).slice(`mcp__${SERVER}__`.length),
          });
        } else if (event.type === "content_block_start" && block.type === "text") {
          written = "";
        } else if (event.type === "content_block_start" && block.type === "thinking") {
          request.progress?.({ kind: "thinking" });
        } else if (delta.type === "text_delta" && typeof delta.text === "string") {
          written = `${written}${delta.text}`.slice(0, MAX_REPLY_CHARS);
          request.progress?.({ kind: "said", text: written });
        }
      };
      try {
        if (conversation) await mkdir(cwd, { recursive: true, mode: 0o700 });
        if (own) places = { ...places, folders: [cwd, await realpath(cwd).catch(() => cwd)] };
        const configFile = join(scratch, "mcp.json");
        const { command: server, args, env } = request.server;
        await writeFile(
          configFile,
          JSON.stringify({
            mcpServers: { [SERVER]: { type: "stdio", command: server, args, env } },
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
              withdrawn: (id: string) => {
                asking.get(id)?.abort();
                asking.delete(id);
              },
              initializeMs,
              ...(noted && { processes: noted }),
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
          // A question waits on the User for as long as they take; a command of its own, as a
          // long build, runs as long as Claude Code's own limit for it lets it.
          busy: () =>
            running.size > 0 || compacting !== null || asking.size > 0 || ownCalls.size > 0,
          onMessage(message) {
            // A retry's notice says the AI isn't answering, rather than that it is.
            const retry = message.type === "system" && message.subtype === "api_retry";
            if (!retry && performance.now() - toldHeard >= HEARD_EVERY_MS) {
              toldHeard = performance.now();
              request.progress?.({ kind: "heard" });
            }
            if (message.type === "user") {
              const content = object(message.message).content;
              for (const part of Array.isArray(content) ? content.map(object) : []) {
                if (part.type !== "tool_result") continue;
                const id = String(part.tool_use_id);
                running.delete(id);
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
        return result.subtype === "success" && result.is_error === false
          ? { kind: "finished", reply: String(result.result ?? "").slice(0, MAX_REPLY_CHARS) }
          : { kind: "failed", reason: failure ?? "other" };
      } catch (error) {
        if (request.signal.aborted) throw error;
        if (error instanceof ClaudeCodeIsolationError)
          return { kind: "failed", reason: "isolation" };
        if (error instanceof ClaudeCodeHookError) return { kind: "failed", reason: "update" };
        if (error instanceof StalledError) return { kind: "failed", reason: "stalled" };
        if (compactionStuck) return { kind: "failed", reason: failure ?? "compaction" };
        if (signal.aborted) return { kind: "failed", reason: "timeout" };
        console.warn(
          "A run of the User's own AI failed:",
          error instanceof Error ? error.message : "unknown",
        );
        return { kind: "failed", reason: failure ?? "other" };
      } finally {
        for (const waiting of asking.values()) waiting.abort();
        asking.clear();
        if (compacting !== null) clearTimeout(compacting);
        await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() =>
          console.warn("Could not remove the temporary folder of a run of the User's own AI."),
        );
      }
    },
  };
}
