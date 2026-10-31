/**
 * The Run engine seam (docs/designs/agent-extensibility.md §4.5, ADR-0013):
 * the Tool-calling loop of one Run behind a small interface, so the library
 * that runs it can change without anything above it. AI SDK 7 implements it
 * today (see ./aiSdkEngine); the engine bake-off on `prototype/engine-bakeoff`
 * ran its contestants behind this same interface (ADR-0007), and every engine
 * must pass the contract suite (tests/core/runEngine.test.ts).
 *
 * Nothing here imports an agent library. The only library type that crosses
 * is the model layer's `ChatLanguageModel`. Above the engine stay the kinds
 * of Run (an Answer today), Tools and their providers, Effects and approvals
 * (decided in `gate`), the window's policy, storage and the UI.
 */
import type { ProviderError } from "../api";
import type { ChatLanguageModel } from "../providers/models";
import type { Tool } from "../tools";

/** Runs the Tool-calling loop for one Run. */
export interface RunEngine {
  /**
   * Streams one Run. Never throws: failures, and refusals before any output,
   * are events. When `signal` aborts, the stream ends at once, with neither
   * "finished" nor "failed".
   */
  run(request: RunRequest): AsyncIterable<RunEvent>;
}

/**
 * What an engine needs of a Tool (CONTEXT.md): its name, description and JSON
 * Schema, and its call. Its provider and Effects stay above the engine.
 *
 * A call's arguments are checked against `inputSchema` first, leniently,
 * taken as a small model meant them (a number or true/false sent as text, an
 * array or an object sent as JSON text, null for an optional one, one object
 * for an array); the Tool gets them as the model sent them, but for that object,
 * which it gets as the array's only item. Arguments that don't match never reach
 * `gate` or the Tool: the call fails, and the model reads why.
 */
export type RunTool = Pick<Tool, "name" | "description" | "inputSchema" | "call" | "streamInput">;

/** A call of a Tool, under the id the model gave it. */
export interface RunToolCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

/**
 * What `gate` decided. "run": the Tool is called. Otherwise `result` is what
 * the model reads instead, e.g. that the User denied the call: an ordinary
 * Tool result, not an error (its event and message have `ok: true`; whoever
 * denied it knows, and records that).
 */
export type GateDecision = { run: true } | { run: false; result: string };

/**
 * A model's context window (see ../answers/window): how a Run is kept within
 * it. Its policy is the caller's; the engine only applies it.
 */
export interface RunWindow {
  /**
   * Fits what the model will read of a call of `tool` (a Tool's result, or
   * what `gate` gave instead) to the room left, before it enters the history.
   */
  fitResult(text: string, tool: string): string;
  /** Asked before each model call: false offers it no Tools, so it must write. */
  canCallTools(): boolean;
  /** A model call ended, with what its provider counted; before its "step-finished" event. */
  stepFinished(usage: TokenUsage): void;
  /**
   * Before each model call after the first: the history to send instead of
   * `history` (e.g. old Tool results elided, or a summary). The Run's own
   * history is unchanged ("finished" has it whole), so each call is compacted
   * afresh from it. A window that compacts restarts its account of the room
   * left from what it returns. Left out, the history goes as it is (v1).
   */
  compact?(history: readonly RunMessage[]): readonly RunMessage[];
}

export interface RunRequest {
  /** From the model layer (`Core.prepareChatModel`): consent already handled. */
  model: ChatLanguageModel;
  instructions: string;
  /**
   * The history, oldest first, in IncarnaMind's own form. It may end in a
   * Tool result (a resumed Run): the engine continues from it.
   */
  messages: readonly RunMessage[];
  /** Offered by name, in this order; each name once. */
  tools: readonly RunTool[];
  /**
   * Model calls at most. The last one must write: it is told so, capped, and may call no Tool
   * (`lastStep`). One that calls one anyway has it refused, and gets one more call; a Run whose
   * model calls a Tool then too ends there, with no text.
   */
  maxSteps: number;
  /**
   * How the last step is made. It writes at most `tokens` (the model's own most, where that is
   * under the engine's cap). `keepTools`: the provider refuses a changed tool list (Anthropic, with
   * thinking), so the Tools stay in its request, and the note tells the model to call none.
   */
  lastStep?: { tokens?: number; keepTools?: boolean };
  /** The Tool the first step must call, by name: one a check's ask said to call. */
  firstTool?: string;
  /**
   * Awaited before every Tool call, while the User may be asked: the Run's
   * approvals decide here, from the call's Effects (see ../approvals). Each
   * call is gated as it arrives, so the calls of one step can wait at once.
   * The engine stops waiting when `signal` aborts, and the Tool isn't called.
   * Rejecting fails the call as if the Tool had thrown: the model reads why.
   */
  gate(call: RunToolCall): Promise<GateDecision>;
  /**
   * Whether a Tool hears a call's input as the model writes it
   * (`RunTool.streamInput`), and so acts before its gate: only one whose
   * calls the gate lets through whatever their input, so nothing happens
   * that the User would have been asked about. Without it, none does.
   */
  streamsInput?(tool: string): boolean;
  /**
   * Messages added while the Run goes on (e.g. the User's), asked for before
   * each model call after the first, so after the current Tool calls. Each is
   * sent once, where it was taken, and stays in the history after.
   */
  steering?(): readonly RunMessage[];
  /** The model's window, when it is known (a local model's, or a cloud model's own). */
  window?: RunWindow;
  /** Left out: the provider's default. A refusal comes back as a "refused" event. */
  temperature?: number;
  /**
   * Asked after each model call whose Tool calls have returned: true ends the
   * Run there, with no further model call. Left out, the Run goes on until the
   * model calls no Tool or `maxSteps` is reached.
   */
  endsAfter?(step: RunStep): boolean;
  /** Names the conversation, for providers that route requests to a prompt cache by a key (see ../providers/promptCache). */
  cacheKey?: string;
  signal: AbortSignal;
}

/** A model call of a Run, once its Tool calls have returned. */
export interface RunStep {
  /** The text it wrote. */
  text: string;
  /** The Tools it called. */
  calls: readonly { id: string; tool: string }[];
}

/**
 * A message of a Run, in IncarnaMind's form, whichever engine ran it: what a
 * later Task's journal stores. A Tool result with `ok: false` was read by the
 * model as an error: the call failed.
 */
/** A picture a Question sends with it (#1937): its bytes, a type a model reads, and its alt text. */
export interface RunPicture {
  data: Uint8Array;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  alt: string;
}

export type RunMessage =
  | {
      role: "user";
      text: string;
      /** The length of the start of `text` the next Run repeats as it is, for the prompt cache (see ../providers/promptCache). */
      stablePrefix?: number;
      /** Pictures the User selected to ask about, read with the Question and no other message. */
      pictures?: readonly RunPicture[];
    }
  | { role: "assistant"; text: string; toolCalls: readonly RunToolCall[] }
  | { role: "tool"; id: string; tool: string; result: string; ok: boolean };

/**
 * What a Run streams. A model call's text, Tool calls and their results come
 * before its "step-finished", so whoever reads them knows what the call did
 * (an Answer takes text before a search as a preamble) when it ends.
 */
export type RunEvent =
  | { type: "text-delta"; text: string }
  /**
   * The model's reasoning as its provider streams it, a summary or raw chain
   * of thought: the caller decides whether to keep it. An empty `text` starts
   * a block of reasoning. It is never in `messages`.
   */
  | { type: "reasoning"; text: string }
  /**
   * The model began writing a call of a Tool, before its input is whole, when
   * its provider streams Tool inputs: the Tool hears the input as it comes
   * (`RunTool.streamInput`), and "tool-call" follows with all of it.
   */
  | { type: "tool-input-started"; id: string; tool: string }
  /**
   * The model asked for a Tool. Its `gate`, then its call, run alongside the
   * stream, so they may begin before this event is read.
   */
  | ({ type: "tool-call" } & RunToolCall)
  /** What the model read of the call: `ok: false` if it failed (see `RunMessage`). */
  | { type: "tool-result"; id: string; ok: boolean }
  /** A model call ended; the text since the last one belongs to it. */
  | { type: "step-finished"; usage: TokenUsage }
  /** Done: the messages this Run added, oldest first, steering included. Nothing follows. */
  | { type: "finished"; messages: readonly RunMessage[] }
  /**
   * Before any output, the provider refused the Tools offered, the temperature
   * sent, or (with a `window`) a request too long for it, with the request's
   * size when the provider said. The caller decides whether to try again
   * otherwise. Nothing follows.
   */
  | { type: "refused"; what: "tools" | "temperature" | "too-long"; promptTokens?: number }
  /** The model or its provider failed. Nothing follows. */
  | { type: "failed"; error: ProviderError };

/** What a provider counted of a model call. */
export interface TokenUsage {
  /** All input tokens, the cached ones too. */
  inputTokens?: number;
  outputTokens?: number;
  /** Of the input tokens, those the provider read from its prompt cache (billed at a fraction). */
  cachedInputTokens?: number;
  /** Of the input tokens, those the provider wrote to its prompt cache (Anthropic bills these above the base price). */
  cacheWriteTokens?: number;
}
