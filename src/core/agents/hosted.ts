/**
 * One turn of a hosted agent (#353, a spike for the ADR): the User's own
 * agent, started by the host (`AgentProcesses`), driven over the Agent Client
 * Protocol from here. It imports nothing from Node or Electron: the process
 * is two web streams.
 *
 * - Its session gets IncarnaMind's MCP server, and starts in the mode the
 *   caller names as its most restrictive; an agent that doesn't offer it
 *   gets no prompt.
 * - Everything it does outside IncarnaMind's Tools waits for the User, as one
 *   approval with Allow once or Deny: its own Tools' permission requests, and
 *   the file writes and commands it asks IncarnaMind to carry out. The
 *   agent's own "always" options are never chosen, since an agent keeps those
 *   in its own settings, where IncarnaMind can't take them back.
 * - It is offered no file reads (it reads the User's Documents through the
 *   MCP server) and no sign-in.
 */
import {
  type CreateTerminalRequest,
  client,
  type McpServerStdio,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type StopReason,
  type TerminalExitStatus,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import { markersIn } from "../../shared/answerBlocks";
import { withFigures } from "../../shared/figureMarkers";
import type { AgentProcess } from "../adapters";
import { markdownToBlocks } from "../answers/markdown";
import { CITATION_TOKEN } from "./tokens";

/** What the User decided on the approval card. */
export type HostedDecision = "allow-once" | "deny";

/** What the card asks about: what the agent would do outside IncarnaMind's Tools. */
export type HostedPermission =
  /** One of the agent's own Tools, run by the agent. */
  | { kind: "tool"; toolCallId: string; title: string; toolKind: ToolKind | null }
  /** A file the agent asks IncarnaMind to write. */
  | { kind: "write-file"; path: string }
  /** A command the agent asks IncarnaMind to run. */
  | { kind: "command"; command: string; args: readonly string[]; cwd: string | null };

/** A command IncarnaMind started for the agent, once the User allowed it. */
export interface HostedCommand {
  output(): { output: string; truncated: boolean; exitStatus: TerminalExitStatus | null };
  waitForExit(): Promise<TerminalExitStatus>;
  kill(): Promise<void>;
  release(): Promise<void>;
}

/** How the host carries out what the User allowed. */
export interface HostedActions {
  writeTextFile(path: string, content: string): Promise<void>;
  startCommand(request: CreateTerminalRequest): Promise<HostedCommand>;
}

export interface HostedTurnRequest {
  process: AgentProcess;
  /** Absolute: where the agent's session starts. */
  cwd: string;
  /** IncarnaMind's MCP server, as the agent starts it. */
  mcpServer: McpServerStdio;
  /** The agent's most restrictive modes, by id, the first it offers taken. */
  modes: readonly string[];
  prompt: string;
  /** IncarnaMind's version, as it names itself to the agent. */
  version: string;
  ask(permission: HostedPermission, signal: AbortSignal): Promise<HostedDecision>;
  actions: HostedActions;
  /** Told when Stop can't reach the agent; the turn then ends when the agent exits. */
  reportError(error: unknown): void;
  signal: AbortSignal;
}

export type HostedProblem = "exited" | "no-restrictive-mode" | "protocol";

export type HostedEvent =
  | { type: "started"; agent: string | null; mode: string }
  | { type: "text-delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; title: string; kind: ToolKind | null }
  | { type: "tool-call-finished"; id: string; ok: boolean }
  | { type: "permission"; permission: HostedPermission; decision: HostedDecision }
  | { type: "finished"; stopReason: StopReason }
  | { type: "failed"; problem: HostedProblem; detail: string };

class HostedTurnError extends Error {
  readonly problem: HostedProblem;
  constructor(problem: HostedProblem, detail: string) {
    super(detail);
    this.problem = problem;
  }
}

/** Invisible, and never escaped away: right after a "[", it keeps the "[" from starting one of our markers. */
const INERT = "\u2060";

/** A "[" the agent wrote that could start a Citation marker ("[^2]") or a figure marker ("[=1]"), escaped or not. */
const MARKER_START = /\[(?=\\*[\^=])/g;

/** Every "[" made inert, inside code too: the last resort, when the narrow rule above wasn't enough. */
const ANY_BRACKET = /\[/g;

/** The Citation markers and figure markers that `text` shows once it is parsed as an Answer is. */
function parsedMarkers(text: string): { citations: number[]; figures: number[] } {
  const figures: number[] = [];
  withFigures(
    markdownToBlocks(text),
    (marker) => {
      figures.push(marker);
      return null;
    },
    () => "",
  );
  return { citations: markersIn(text), figures };
}

/** Whether every marker `shown` has is one of `placed`, as many times at most (one in code shows none). */
function onlyPlaced(shown: readonly number[], placed: readonly number[]): boolean {
  const left = [...placed];
  return shown.every((marker) => {
    const at = left.indexOf(marker);
    if (at < 0) return false;
    left.splice(at, 1);
    return true;
  });
}

/**
 * The agent's text as a hosted Answer stores it. Nothing the agent wrote can become a
 * Citation or a figure: every "[" that could start one of our markers is made inert, so
 * no escape, emphasis, quote or link the Markdown parser undoes brings one back. Then
 * each token minted for this Run becomes the marker `markerOf` gives it. The result is
 * parsed as an Answer is, and must show none but those markers and no figure; if it
 * doesn't, every "[" is made inert, and if even that doesn't hold, the text keeps no
 * marker at all. Run it on the whole text so far, never chunk by chunk.
 */
export function hostedAnswerText(
  agentText: string,
  markerOf: (token: string) => number | null,
): string {
  const convert = (inert: string) => {
    const placed: number[] = [];
    const text = inert.replace(CITATION_TOKEN, (token: string, id: string) => {
      const marker = markerOf(id);
      if (marker === null) return token;
      placed.push(marker);
      return `[^${marker}]`;
    });
    const shown = parsedMarkers(text);
    return onlyPlaced(shown.citations, placed) && shown.figures.length === 0 ? text : null;
  };
  return (
    convert(agentText.replace(MARKER_START, `[${INERT}`)) ??
    convert(agentText.replace(ANY_BRACKET, `[${INERT}`)) ??
    agentText.replace(ANY_BRACKET, `[${INERT}`)
  );
}

/** JSON-RPC's code for a request the client refused. */
const REFUSED = -32000;

/** The agent's option of `kind`, if it offers one. */
const optionOf = (request: RequestPermissionRequest, kind: "allow_once" | "reject_once") =>
  request.options.find((option) => option.kind === kind)?.optionId ?? null;

export async function* runHostedTurn(request: HostedTurnRequest): AsyncGenerator<HostedEvent> {
  /** What the User decided, read out in order with the agent's updates. */
  const decided: HostedEvent[] = [];
  /**
   * Asks the User. Stop withdraws a waiting request, and one that comes after: ACP has
   * the client answer them as cancelled, here null.
   */
  const decide = async (
    permission: HostedPermission,
    signal: AbortSignal,
  ): Promise<HostedDecision | null> => {
    const either = AbortSignal.any([signal, request.signal]);
    if (either.aborted) return null;
    const decision = await request.ask(permission, either);
    if (either.aborted) return null;
    decided.push({ type: "permission", permission, decision });
    return decision;
  };
  const refused = (what: string) =>
    new RequestError(REFUSED, `The User didn't allow IncarnaMind to ${what}.`);
  const commands = new Map<string, HostedCommand>();
  const command = (terminalId: string): HostedCommand => {
    const started = commands.get(terminalId);
    if (!started) throw RequestError.resourceNotFound(terminalId);
    return started;
  };
  const answer = async (
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> => {
    const decision = await decide(
      {
        kind: "tool",
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? "",
        toolKind: params.toolCall.kind ?? null,
      },
      signal,
    );
    const chosen =
      decision === null
        ? null
        : optionOf(params, decision === "deny" ? "reject_once" : "allow_once");
    return chosen === null
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: chosen } };
  };
  const app = client({ name: "IncarnaMind" })
    .onRequest("session/request_permission", ({ params, signal }) => answer(params, signal))
    .onRequest("fs/write_text_file", async ({ params, signal }) => {
      const decision = await decide({ kind: "write-file", path: params.path }, signal);
      if (decision !== "allow-once") throw refused(`write ${params.path}`);
      await request.actions.writeTextFile(params.path, params.content);
      return {};
    })
    .onRequest("terminal/create", async ({ params, signal }) => {
      const asked: HostedPermission = {
        kind: "command",
        command: params.command,
        args: params.args ?? [],
        cwd: params.cwd ?? null,
      };
      const decision = await decide(asked, signal);
      if (decision !== "allow-once") throw refused(`run ${params.command}`);
      const terminalId = crypto.randomUUID();
      commands.set(terminalId, await request.actions.startCommand(params));
      return { terminalId };
    })
    .onRequest("terminal/output", ({ params }) => {
      const { exitStatus, ...rest } = command(params.terminalId).output();
      return exitStatus ? { ...rest, exitStatus } : rest;
    })
    .onRequest("terminal/wait_for_exit", ({ params }) => command(params.terminalId).waitForExit())
    .onRequest("terminal/kill", async ({ params }) => {
      await command(params.terminalId).kill();
      return {};
    })
    .onRequest("terminal/release", async ({ params }) => {
      await command(params.terminalId).release();
      commands.delete(params.terminalId);
      return {};
    });
  const connection = app.connect(ndJsonStream(request.process.input, request.process.output));
  // Its output has ended: what it wrote before is still read, then what waits fails.
  void request.process.exited.then(() => connection.close());
  let cancel: (() => void) | null = null;
  try {
    const started = await connection.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: true },
        terminal: true,
        // An agent signs in through its own setup, never through a login IncarnaMind runs.
        auth: { terminal: false },
      },
      clientInfo: { name: "IncarnaMind", version: request.version },
    });
    if (started.protocolVersion !== PROTOCOL_VERSION) {
      throw new HostedTurnError("protocol", `ACP version ${started.protocolVersion}`);
    }
    const session = await connection.agent
      .buildSession({ cwd: request.cwd, mcpServers: [request.mcpServer] })
      .start();
    const offered = session.modes?.availableModes.map((mode) => mode.id) ?? [];
    const mode = request.modes.find((id) => offered.includes(id));
    if (mode === undefined) {
      throw new HostedTurnError("no-restrictive-mode", offered.join(", "));
    }
    if (session.modes?.currentModeId !== mode) {
      await connection.agent.request("session/set_mode", {
        sessionId: session.sessionId,
        modeId: mode,
      });
    }
    yield { type: "started", agent: started.agentInfo?.name ?? null, mode };
    const { sessionId } = session;
    cancel = () => {
      connection.agent.notify("session/cancel", { sessionId }).catch(request.reportError);
    };
    request.signal.addEventListener("abort", cancel, { once: true });
    // A failed prompt rejects the next update, below.
    void session.prompt(request.prompt);
    for (;;) {
      const message = await session.nextUpdate();
      yield* decided.splice(0);
      if (message.kind === "stop") {
        yield { type: "finished", stopReason: message.stopReason };
        return;
      }
      const { update } = message;
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (update.content.type === "text")
            yield { type: "text-delta", text: update.content.text };
          break;
        case "agent_thought_chunk":
          if (update.content.type === "text")
            yield { type: "reasoning", text: update.content.text };
          break;
        case "tool_call":
          yield {
            type: "tool-call",
            id: update.toolCallId,
            title: update.title,
            kind: update.kind ?? null,
          };
          break;
        case "tool_call_update":
          if (update.status === "completed" || update.status === "failed") {
            yield {
              type: "tool-call-finished",
              id: update.toolCallId,
              ok: update.status === "completed",
            };
          }
          break;
        default:
          break;
      }
    }
  } catch (error) {
    yield* decided.splice(0);
    if (error instanceof HostedTurnError) {
      yield { type: "failed", problem: error.problem, detail: error.message };
    } else if (connection.signal.aborted) {
      await request.process.stop();
      yield { type: "failed", problem: "exited", detail: request.process.stderrTail() };
    } else {
      yield { type: "failed", problem: "protocol", detail: String(error) };
    }
  } finally {
    if (cancel) request.signal.removeEventListener("abort", cancel);
    connection.close();
    await Promise.all([...commands.values()].map((started) => started.release()));
  }
}
