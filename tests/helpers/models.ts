import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ChatModelFactory, ChatModelSpec } from "../../src/core";
import { CITE_RETRY_INSTRUCTIONS } from "../../src/core/answers/prompt";

/** A chat model that answers "OK" to every request. */
export function replyingModel(text = "OK"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

/** A chat model whose provider answers every request with an HTTP error. */
export function failingModel(statusCode: number, message: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({
        message,
        url: "https://api.example.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode,
        isRetryable: false,
      });
    },
  });
}

/** A chat model that can't reach its server. */
export function unreachableModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({
        message: "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:1",
        url: "http://127.0.0.1:1/v1/chat/completions",
        requestBodyValues: {},
        cause: new TypeError("fetch failed"),
        isRetryable: true,
      });
    },
  });
}

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

/** The tokens a provider reports for a request. */
export type ReportedUsage = Extract<StreamPart, { type: "finish" }>["usage"];

const STREAM_USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const finishParts = (): StreamPart[] => [
  { type: "text-end", id: "answer" },
  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: STREAM_USAGE },
];

/** A reply as a provider streams it: chunks of `chunkSize` characters, sent `delayMs` apart. */
export function streamedReply(
  reply: string,
  abortSignal: AbortSignal | undefined,
  { chunkSize = 4, delayMs = 0 }: { chunkSize?: number; delayMs?: number } = {},
): ReadableStream<StreamPart> {
  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "answer" },
  ];
  for (let at = 0; at < reply.length; at += chunkSize) {
    parts.push({ type: "text-delta", id: "answer", delta: reply.slice(at, at + chunkSize) });
  }
  parts.push(...finishParts());
  return new ReadableStream<StreamPart>({
    async pull(controller) {
      const part = parts.shift();
      if (!part) {
        controller.close();
        return;
      }
      if (delayMs > 0 && part.type === "text-delta") {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (abortSignal?.aborted) {
        controller.error(new DOMException("The request was aborted.", "AbortError"));
        return;
      }
      controller.enqueue(part);
    },
  });
}

/**
 * A chat model that streams each reply in turn, one per request (the last one
 * again after that), split into chunks of `chunkSize` characters sent
 * `delayMs` apart.
 */
export function streamingModel(
  replies: string | readonly string[],
  chunks: { chunkSize?: number; delayMs?: number } = {},
): MockLanguageModelV4 {
  const all = typeof replies === "string" ? [replies] : replies;
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: streamedReply(all[Math.min(calls++, all.length - 1)] ?? "", abortSignal, chunks),
    }),
  });
}

export interface ControlledModel {
  model: MockLanguageModelV4;
  /** Resolves once the model has been asked to answer (the nth time, from 1). */
  requested(count?: number): Promise<void>;
  /** Streams more text of the current Answer. */
  push(text: string): void;
  finish(): void;
  /** Whether the current request was aborted. */
  readonly aborted: boolean;
}

/** A chat model whose Answer the test streams by hand: `push` text, then `finish`. */
export function controlledModel(): ControlledModel {
  let controller: ReadableStreamDefaultController<StreamPart> | null = null;
  let aborted = false;
  let requests = 0;
  const waiting: { count: number; resolve: () => void }[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      aborted = false;
      const stream = new ReadableStream<StreamPart>({
        start(started) {
          controller = started;
          started.enqueue({ type: "stream-start", warnings: [] });
          started.enqueue({ type: "text-start", id: "answer" });
        },
      });
      abortSignal?.addEventListener("abort", () => {
        aborted = true;
        try {
          controller?.error(new DOMException("The request was aborted.", "AbortError"));
        } catch {
          // Already closed.
        }
      });
      requests++;
      for (const wait of waiting.filter((each) => each.count <= requests)) wait.resolve();
      return { stream };
    },
  });
  const current = () => {
    if (!controller) throw new Error("The model hasn't been asked yet.");
    return controller;
  };
  return {
    model,
    requested: (count = 1) =>
      requests >= count
        ? Promise.resolve()
        : new Promise((resolve) => waiting.push({ count, resolve })),
    push(text) {
      current().enqueue({ type: "text-delta", id: "answer", delta: text });
    },
    finish() {
      const stream = current();
      for (const part of finishParts()) stream.enqueue(part);
      stream.close();
    },
    get aborted() {
      return aborted;
    },
  };
}

/** A chat model whose provider refuses to stream, with an HTTP status, or with no connection (no status). */
export function failingStreamModel(statusCode: number | undefined, message: string) {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw new APICallError({
        message,
        url: "https://api.example.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode,
        cause: statusCode === undefined ? new TypeError("fetch failed") : undefined,
        isRetryable: false,
      });
    },
  });
}

/** What a model was asked, simplified: the instructions, then each message's role and text. */
/** The index of the model's last request in an Answer itself, not the one request for its Citations (#760). */
export function lastAnswerCall(model: MockLanguageModelV4): number {
  return model.doStreamCalls.findLastIndex(
    (call) =>
      !call.prompt.some(
        (message) => message.role === "system" && message.content === CITE_RETRY_INSTRUCTIONS,
      ),
  );
}

export function promptOf(model: MockLanguageModelV4, call = 0): { role: string; text: string }[] {
  const options = model.doStreamCalls[call];
  if (!options) throw new Error(`The model wasn't asked ${call + 1} time(s).`);
  return options.prompt.map((message) => ({
    role: message.role,
    text:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
  }));
}

type CallOptions = Parameters<MockLanguageModelV4["doStream"]>[0];

/** One request to a scripted model, as its script sees it. */
export interface ModelCall {
  /** Which request this is, from 0. */
  index: number;
  /** The names of the Tools offered. */
  tools: string[];
  /** Whether the request asks for a JSON object (structured output). */
  json: boolean;
  /** The system prompt. */
  system: string;
  /** The rest of the prompt's text: each message's, a blank line apart. */
  prompt: string;
  /** The results of the Tool calls so far, oldest first: their Tool's name and text. */
  results: { tool: string; text: string }[];
  options: CallOptions;
}

/** A request that isn't streamed (e.g. rewriting a Question into a search query), as its script sees it. */
export interface GenerateCall {
  /** The system prompt. */
  system: string;
  /** The text of the other messages, in order. */
  prompt: string;
  options: Parameters<MockLanguageModelV4["doGenerate"]>[0];
}

/** What a scripted model replies to a request that isn't streamed: text, or an HTTP error. */
export type GeneratedReply =
  /**
   * `cutOff`: the reply ran out of output tokens, as one does when the model's thinking takes them all.
   * `usage`: the tokens this reply reports instead of the model's.
   */
  | { text: string; cutOff?: boolean; usage?: ReportedUsage }
  | { error: { status: number; message: string } };

/** What a scripted model replies to one request. */
export type ScriptedReply =
  | {
      /** What the model reasons before it replies, as its provider streams it. */
      reasoning?: string;
      text?: string;
      /** With `streamInput`, the call's input streams in chunks first, as a provider that streams Tool inputs sends it. */
      calls?: { tool: string; input: unknown; streamInput?: boolean }[];
      /**
       * Stops streaming once `after` characters of the text, or of a streamed
       * input, are out, until `until` resolves.
       */
      pause?: { after: number; until: Promise<void> };
    }
  /** The provider refuses the request with an HTTP error. */
  | { error: { status: number; message: string } };

/** A prompt's text but the system prompt: each message's, a blank line apart. */
function promptText(prompt: CallOptions["prompt"]): string {
  return prompt
    .filter((message) => message.role !== "system")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n\n");
}

function resultsOf(options: CallOptions): ModelCall["results"] {
  const results: ModelCall["results"] = [];
  for (const message of options.prompt) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const output = part.output;
      const text =
        output.type === "text" || output.type === "error-text"
          ? output.value
          : output.type === "json" || output.type === "error-json"
            ? JSON.stringify(output.value)
            : "";
      results.push({ tool: part.toolName, text });
    }
  }
  return results;
}

type Prompt = CallOptions["prompt"];

const systemOf = (prompt: Prompt) =>
  prompt
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");

/** The provider's refusal of a request, as an HTTP error. */
const providerError = ({ status, message }: { status: number; message: string }) =>
  new APICallError({
    message,
    url: "http://127.0.0.1:11434/v1/chat/completions",
    requestBodyValues: {},
    statusCode: status,
    responseBody: JSON.stringify({ error: { message } }),
    isRetryable: false,
  });

/**
 * A chat model whose every reply comes from `script`, given the request: text
 * (streamed in chunks of `chunkSize`), Tool calls, or a provider error. For
 * scripting the Tool-calling loop: search, cite, then answer. Requests that
 * aren't streamed get `generate`'s reply; without it, they fail. `modelId`:
 * the id the model reports; `usage`: the tokens each request reports.
 */
export function scriptedModel(
  script: (call: ModelCall) => ScriptedReply,
  {
    chunkSize = 8,
    modelId,
    generate,
    usage = STREAM_USAGE,
  }: {
    chunkSize?: number;
    modelId?: string;
    generate?: (call: GenerateCall) => GeneratedReply;
    usage?: ReportedUsage;
  } = {},
): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async (options) => {
      if (!generate) throw new Error("This scripted model only streams.");
      const reply = generate({
        system: systemOf(options.prompt),
        prompt: promptText(options.prompt),
        options,
      });
      if ("error" in reply) throw providerError(reply.error);
      return {
        content: [{ type: "text", text: reply.text }],
        finishReason: { unified: reply.cutOff ? "length" : "stop", raw: undefined },
        usage: reply.usage ?? usage,
        warnings: [],
      };
    },
    doStream: async (options) => {
      const call: ModelCall = {
        index: index++,
        tools: (options.tools ?? []).map((each) => each.name),
        json: options.responseFormat?.type === "json",
        system: systemOf(options.prompt),
        prompt: promptText(options.prompt),
        results: resultsOf(options),
        options,
      };
      const reply = script(call);
      if ("error" in reply) throw providerError(reply.error);
      const parts: StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (reply.reasoning) {
        parts.push({ type: "reasoning-start", id: "thinking" });
        for (let at = 0; at < reply.reasoning.length; at += chunkSize) {
          parts.push({
            type: "reasoning-delta",
            id: "thinking",
            delta: reply.reasoning.slice(at, at + chunkSize),
          });
        }
        parts.push({ type: "reasoning-end", id: "thinking" });
      }
      const text = reply.text ?? "";
      if (text) {
        parts.push({ type: "text-start", id: "answer" });
        for (let at = 0; at < text.length; at += chunkSize) {
          parts.push({ type: "text-delta", id: "answer", delta: text.slice(at, at + chunkSize) });
        }
        parts.push({ type: "text-end", id: "answer" });
      }
      (reply.calls ?? []).forEach((each, number) => {
        const toolCallId = `call-${call.index}-${number}`;
        const input = JSON.stringify(each.input);
        if (each.streamInput) {
          parts.push({ type: "tool-input-start", id: toolCallId, toolName: each.tool });
          for (let at = 0; at < input.length; at += chunkSize) {
            parts.push({
              type: "tool-input-delta",
              id: toolCallId,
              delta: input.slice(at, at + chunkSize),
            });
          }
          parts.push({ type: "tool-input-end", id: toolCallId });
        }
        parts.push({ type: "tool-call", toolCallId, toolName: each.tool, input });
      });
      parts.push({
        type: "finish",
        finishReason: {
          unified: reply.calls?.length ? "tool-calls" : "stop",
          raw: undefined,
        },
        usage,
      });
      const { pause } = reply;
      let streamed = 0;
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          const part = parts.shift();
          if (!part) {
            controller.close();
            return;
          }
          if (pause && streamed >= pause.after && part.type !== "stream-start") {
            await pause.until;
          }
          if (part.type === "text-delta" || part.type === "tool-input-delta") {
            streamed += part.delta.length;
          }
          if (options.abortSignal?.aborted) {
            controller.error(new DOMException("The request was aborted.", "AbortError"));
            return;
          }
          controller.enqueue(part);
        },
      });
      return { stream };
    },
  });
}

/** A model factory that always returns `model` and records what it was asked to build. */
export function scriptedModels(model: MockLanguageModelV4) {
  const specs: ChatModelSpec[] = [];
  const createChatModel: ChatModelFactory = (spec) => {
    specs.push(spec);
    return model;
  };
  return { createChatModel, specs, model };
}
