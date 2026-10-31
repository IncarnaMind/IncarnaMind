/**
 * One turn of a hosted agent (#353, a spike for the ADR): the User's own
 * agent, started by the host (`AgentProcesses`), driven over the Agent Client
 * Protocol from here. It imports nothing from Node or Electron: the process
 * is two web streams.
 *
 * - IncarnaMind offers the agent no file system, no terminal and no sign-in,
 *   so nothing of the User's is read or written through IncarnaMind for it.
 * - Its session gets IncarnaMind's MCP server, and starts in the mode the
 *   caller names as its most restrictive; an agent that doesn't offer it
 *   gets no prompt.
 * - Its permission requests are the caller's to decide: Allow once, For this
 *   run or Deny. The agent's own "always" options are never chosen, since an
 *   agent keeps those in its own settings, where IncarnaMind can't take them
 *   back.
 */
import {
  client,
  type McpServerStdio,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type StopReason,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import type { AgentProcess } from "../adapters";

/** What the User decided about one of the agent's own Tool calls. */
export type HostedDecision = "allow-once" | "allow-for-run" | "deny";

export interface HostedPermission {
  toolCallId: string;
  title: string;
  kind: ToolKind | null;
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
  | { type: "permission"; id: string; decision: HostedDecision }
  | { type: "finished"; stopReason: StopReason }
  | { type: "failed"; problem: HostedProblem; detail: string };

class HostedTurnError extends Error {
  constructor(
    readonly problem: HostedProblem,
    detail: string,
  ) {
    super(detail);
  }
}

/** The agent's option of `kind`, if it offers one. */
const optionOf = (request: RequestPermissionRequest, kind: "allow_once" | "reject_once") =>
  request.options.find((option) => option.kind === kind)?.optionId ?? null;

export async function* runHostedTurn(request: HostedTurnRequest): AsyncGenerator<HostedEvent> {
  /** What the permission handler decided, read out in order with the agent's updates. */
  const decided: HostedEvent[] = [];
  const allowedForRun = new Set<ToolKind | null>();
  const answer = async (
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> => {
    const permission: HostedPermission = {
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "",
      kind: params.toolCall.kind ?? null,
    };
    // Stop withdraws a waiting request, and one that comes after: ACP has the client
    // answer them as cancelled.
    const either = AbortSignal.any([signal, request.signal]);
    if (either.aborted) return { outcome: { outcome: "cancelled" } };
    const decision = allowedForRun.has(permission.kind)
      ? "allow-for-run"
      : await request.ask(permission, either);
    if (either.aborted) return { outcome: { outcome: "cancelled" } };
    if (decision === "allow-for-run") allowedForRun.add(permission.kind);
    decided.push({ type: "permission", id: permission.toolCallId, decision });
    const chosen =
      decision === "deny" ? optionOf(params, "reject_once") : optionOf(params, "allow_once");
    return chosen === null
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: chosen } };
  };
  const app = client({ name: "IncarnaMind" }).onRequest(
    "session/request_permission",
    ({ params, signal }) => answer(params, signal),
  );
  const connection = app.connect(ndJsonStream(request.process.input, request.process.output));
  // Its output has ended: what it wrote before is still read, then what waits fails.
  void request.process.exited.then(() => connection.close());
  let cancel: (() => void) | null = null;
  try {
    const started = await connection.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
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
  }
}
