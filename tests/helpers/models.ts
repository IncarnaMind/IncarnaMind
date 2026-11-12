import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ChatModelFactory, ChatModelSpec, ClaimedChange, CoreAdapters } from "../../src/core";
import { restateInstructions } from "../../src/core/answers/checks/explanations";
import { type JudgeQuestion, questionOf } from "../../src/core/answers/judge";
import { listedSentences } from "./claimSentences";

export { questionOf } from "../../src/core/answers/judge";

/**
 * Each judge's question a scripted model had no reply for, since the test began: the judge would
 * read its failure as Not checked, so the test fails instead (tests/setup/judges.ts).
 */
export const UNSCRIPTED: string[] = [];
(globalThis as { unscriptedJudges?: string[] }).unscriptedJudges = UNSCRIPTED;

/**
 * A judge for a test of something else, which names it rather than leave a judge's question
 * unscripted: it sorts each sentence as one fact, as a model with no script does, claims no change,
 * judges none of an Answer's sentences, and finds no nearest line different. Any other request is
 * refused, as a model that only streams refuses it. An explanation asked for again in the
 * interface's language comes back quoted inside one of that language's.
 */
export function judgesNothing(call: GenerateCall): GeneratedReply {
  switch (call.question) {
    case "find-claims": {
      const sentences = listedSentences(call.prompt).map(({ number, text }) => ({
        number,
        parts: [{ kind: "fact", text }],
      }));
      return { text: JSON.stringify({ sentences }) };
    }
    case "sentence-batch":
      return { text: JSON.stringify({ sentences: [] }) };
    case "nearest":
      return { text: "neither" };
    case "claimed-changes":
      return { text: JSON.stringify({ claims: [] }) };
    case "restate":
      return { text: restatedAsQuoted(call) };
    case undefined:
      throw new Error("This scripted model only streams.");
    default:
      return unscripted(call.question, call.system);
  }
}

/**
 * A check's explanation asked for again in the interface's language (#2081), as a scripted model
 * writes it with no plan for it: the sentence it was given, quoted inside one of that language's.
 */
export function restatedAsQuoted(call: Pick<GenerateCall, "prompt" | "system">): string {
  const said = /<reply>\n([\s\S]*?)\n<\/reply>/.exec(call.prompt)?.[1] ?? "";
  return call.system === restateInstructions("zh-CN")
    ? `文档写的是：“${said}”`
    : `The Document says: “${said}”`;
}

/** A judge's question that compares a sentence with one quote and its Passage. */
export const comparesAQuote = (call: { question: JudgeQuestion | undefined }): boolean =>
  call.question === "confirm" ||
  call.question === "strict" ||
  call.question === "strict-figure" ||
  call.question === "nearest" ||
  call.question === "record-cite";

/** Fails a request whose question no script answers, and keeps it for the test to fail. */
export function unscripted(question: JudgeQuestion | undefined, system: string): never {
  const asked = `${question ?? "a request that names no question"} (${system.slice(0, 60)}…)`;
  UNSCRIPTED.push(asked);
  throw new Error(`No reply is scripted for ${asked}.`);
}

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

const finishParts = (finished: "stop" | "length" = "stop"): StreamPart[] => [
  { type: "text-end", id: "answer" },
  { type: "finish", finishReason: { unified: finished, raw: undefined }, usage: STREAM_USAGE },
];

/**
 * A reply as a provider streams it: chunks of `chunkSize` characters, sent `delayMs` apart.
 * `finished: "length"`: it ends at its output limit, cut off.
 */
export function streamedReply(
  reply: string,
  abortSignal: AbortSignal | undefined,
  {
    chunkSize = 4,
    delayMs = 0,
    finished = "stop",
  }: { chunkSize?: number; delayMs?: number; finished?: "stop" | "length" } = {},
): ReadableStream<StreamPart> {
  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "answer" },
  ];
  for (let at = 0; at < reply.length; at += chunkSize) {
    parts.push({ type: "text-delta", id: "answer", delta: reply.slice(at, at + chunkSize) });
  }
  parts.push(...finishParts(finished));
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
type StreamCall = MockLanguageModelV4["doStreamCalls"][number];

/** A request that checks one of an Answer's sentences against what it cites, before it ends (#2311). */
const checksASentence = (call: StreamCall) =>
  call.prompt.some(
    (message) => message.role === "system" && message.content.startsWith("You check one sentence"),
  );

/** The requests an Answer itself sent, without the checks of its sentences (#2311). */
export const answerRequests = (model: MockLanguageModelV4): StreamCall[] =>
  model.doStreamCalls.filter((call) => !checksASentence(call));

/** Where an Answer's own request `nth` (from the end when negative) is among all the model's requests. */
export function answerRequestIndex(model: MockLanguageModelV4, nth: number): number {
  const call = answerRequests(model).at(nth);
  if (!call) throw new Error(`No Answer sent request ${nth}.`);
  return model.doStreamCalls.indexOf(call);
}

/**
 * The index of the model's last request in an Answer itself: not the one request for its
 * Citations (#760), nor a check of its sentences (#2311).
 */
export function lastAnswerCall(model: MockLanguageModelV4): number {
  return model.doStreamCalls.findLastIndex(
    (call) => !checksASentence(call) && questionOf(call) !== "unmarked-quotes",
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
  /** The judge's question it asks (src/core/answers/judge.ts); undefined for an Answer's or a check's Run. */
  question: JudgeQuestion | undefined;
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
  /** The judge's question it asks (src/core/answers/judge.ts); undefined for any other request. */
  question: JudgeQuestion | undefined;
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
  | {
      text: string;
      cutOff?: boolean;
      usage?: ReportedUsage;
      /** It replies once this resolves, or fails once its request is aborted. */
      until?: Promise<void>;
    }
  | { error: ScriptedRefusal };

export function claimCheckReply(
  call: GenerateCall,
  unbacked:
    | readonly { sentence: string; kind: ClaimedChange }[]
    | ((prompt: string) => readonly { sentence: string; kind: ClaimedChange }[]),
): GeneratedReply {
  if (call.question && call.question !== "claimed-changes") {
    return unscripted(call.question, call.system);
  }
  const candidates = typeof unbacked === "function" ? unbacked(call.prompt) : unbacked;
  const reply = /<reply>\n([\s\S]*)\n<\/reply>/.exec(call.prompt)?.[1] ?? "";
  return {
    text: JSON.stringify({
      claims: candidates
        .filter((claim) => reply.includes(claim.sentence))
        .map((claim) => ({ about: "mind", ...claim, backed: false })),
    }),
  };
}

/** What a scripted model replies to one request. */
export type ScriptedReply =
  | {
      /** What the model reasons before it replies, as its provider streams it. */
      reasoning?: string;
      text?: string;
      /**
       * With `streamInput`, the call's input streams in chunks first, as a provider that streams
       * Tool inputs sends it. `raw` is the input's JSON text as the model writes it, which may not
       * be valid JSON: in place of `input`'s.
       */
      calls?: { tool: string; input: unknown; streamInput?: boolean; raw?: string }[];
      /**
       * Stops streaming once `after` characters of the text, or of a streamed
       * input, are out, until `until` resolves; `reached` hears when it has.
       */
      pause?: { after: number; until: Promise<void>; reached?: () => void };
      /** The reply reached the request's output limit: it ends there, cut off. */
      cutOff?: boolean;
      /** The tokens this reply reports instead of the model's. */
      usage?: ReportedUsage;
    }
  /** The provider refuses the request with an HTTP error. */
  | { error: ScriptedRefusal };

/** A prompt's text but the system prompt: each message's, a blank line apart. */
export function promptText(prompt: CallOptions["prompt"]): string {
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

/**
 * A provider's refusal of a request. `retryable`: refused as a service refuses a rate limit, which
 * the AI SDK sends again itself; `retryAfter`: the seconds its `retry-after` header asks to wait.
 */
export interface ScriptedRefusal {
  status: number;
  message: string;
  retryable?: boolean;
  retryAfter?: string;
}

/** The provider's refusal of a request, as an HTTP error. */
const providerError = ({ status, message, retryable, retryAfter }: ScriptedRefusal) =>
  new APICallError({
    message,
    url: "http://127.0.0.1:11434/v1/chat/completions",
    requestBodyValues: {},
    statusCode: status,
    ...(retryAfter !== undefined && { responseHeaders: { "retry-after": retryAfter } }),
    responseBody: JSON.stringify({ error: { message } }),
    isRetryable: retryable === true,
  });

/**
 * A chat model whose every reply comes from `script`, given the request: text
 * (streamed in chunks of `chunkSize`), Tool calls, or a provider error. For
 * scripting the Tool-calling loop: search, cite, then answer. Requests that
 * aren't streamed get `generate`'s reply; without it, they fail. A judge's
 * question that streams (the retries of an Answer's quotes and figures) fails
 * the test unless `script` reads its `question` or `json`, as it must to
 * answer it; the one for the Citations an Answer left out finds none then.
 * `modelId`:
 * the id the model reports; `usage`: the tokens each request reports.
 */
export function scriptedModel(
  script: (call: ModelCall) => ScriptedReply,
  {
    chunkSize = 8,
    modelId,
    generate,
    usage = STREAM_USAGE,
    judgesItsAnswers = false,
  }: {
    chunkSize?: number;
    modelId?: string;
    generate?: (call: GenerateCall) => GeneratedReply;
    usage?: ReportedUsage;
    /**
     * Whether a batch of an Answer's sentences, judged once the Answer ends (#2311), is answered
     * each supported by what it cites, as an Answer that keeps to its quotes is, instead of as
     * `generate` says: for a test of something other than that judgement.
     */
    judgesItsAnswers?: boolean;
  } = {},
): MockLanguageModelV4 {
  let index = 0;
  const generated = async (
    options: GenerateCall["options"],
  ): Promise<Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>> => {
    const question = questionOf(options);
    if (judgesItsAnswers && question === "sentence-batch") {
      return {
        content: [{ type: "text", text: allSupported(promptText(options.prompt)) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    }
    if (!generate && question === "find-claims") {
      const sentences = listedSentences(promptText(options.prompt)).map(({ number, text }) => ({
        number,
        parts: [{ kind: "fact", text }],
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ sentences }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    }
    if (!generate && question === "claimed-changes") {
      return {
        content: [{ type: "text", text: '{"claims":[]}' }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    }
    if (!generate) {
      if (question) unscripted(question, systemOf(options.prompt));
      throw new Error("This scripted model only streams.");
    }
    const reply = generate({
      question,
      system: systemOf(options.prompt),
      prompt: promptText(options.prompt),
      options,
    });
    if ("error" in reply) throw providerError(reply.error);
    if (reply.until) await heldUntil(reply.until, options.abortSignal);
    return {
      content: [{ type: "text", text: reply.text }],
      finishReason: { unified: reply.cutOff ? "length" : "stop", raw: undefined },
      usage: reply.usage ?? usage,
      warnings: [],
    };
  };
  return new MockLanguageModelV4({
    modelId,
    doGenerate: generated,
    doStream: async (options) => {
      // A Note's sort streams its reply (#2532): it is answered as when it was generated.
      if (questionOf(options) === "find-claims") {
        const reply = await generated(options);
        const text = reply.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        return {
          stream: streamedReply(text.join(""), options.abortSignal, {
            chunkSize,
            finished: reply.finishReason.unified === "length" ? "length" : "stop",
          }),
        };
      }
      const question = questionOf(options);
      let told = false;
      const call: ModelCall = {
        index: index++,
        get question() {
          told = true;
          return question;
        },
        tools: (options.tools ?? []).map((each) => each.name),
        get json() {
          told = true;
          return options.responseFormat?.type === "json";
        },
        system: systemOf(options.prompt),
        prompt: promptText(options.prompt),
        results: resultsOf(options),
        options,
      };
      const scripted = script(call);
      // A script that never looks at which question a request asks, or whether it wants JSON, has
      // no reply for a judge's question that streams: what it answers is not scripted (#2895). The
      // Citations an Answer left out are asked after most Answers, so a model with no script finds
      // none, as it claims no change and sorts every sentence as one fact.
      const blind = question !== undefined && !told;
      if (blind && question !== "unmarked-quotes") unscripted(question, call.system);
      const reply: ScriptedReply = blind ? { text: '{"citations":[]}' } : scripted;
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
        const input = each.raw ?? JSON.stringify(each.input);
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
          unified: reply.cutOff ? "length" : reply.calls?.length ? "tool-calls" : "stop",
          raw: undefined,
        },
        usage: reply.usage ?? usage,
      });
      const { pause } = reply;
      let streamed = 0;
      let paused = false;
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          const part = parts.shift();
          if (!part) {
            controller.close();
            return;
          }
          if (pause && streamed >= pause.after && part.type !== "stream-start") {
            if (!paused) pause.reached?.();
            paused = true;
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

/** Waits for `until`, or fails as an aborted request does once `signal` aborts. */
function heldUntil(until: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    until.then(resolve, reject);
  });
}

/** A batch of an Answer's sentences judged, each supported by what it cites (#2311). */
function allSupported(prompt: string): string {
  const numbers = [...prompt.matchAll(/<sentence number="(\d+)">/g)].map((match) =>
    Number(match[1]),
  );
  return JSON.stringify({
    sentences: numbers.map((number) => ({
      number,
      kind: "fact",
      verdict: "supported",
      roles: "same",
      time: "same",
      quoted: "states",
      says: "The Document says so.",
    })),
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

/** Offers run_code to whichever model a test uses: the shipped catalog offers it only where it was measured (#2351). */
export const codeToolOn = (): Pick<CoreAdapters, "modelFacts"> => ({
  modelFacts: () => ({ codeTool: true }),
});
