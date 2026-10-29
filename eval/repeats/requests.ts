/**
 * Watches the chat model's requests by sentence: what each check asked, the
 * searches it made, the Passages it was handed, what came back, the tokens
 * and the time. A check's cost and the cause of a wrong verdict are read from
 * these, not guessed.
 */

import type { LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory } from "../../src/core";
import { SEARCH_AGAIN } from "../../src/core/answers/checks/searchAgain";
import { type HandedPassage, passagesIn } from "./passagesHanded";

export interface WatchedRequest {
  /** What the request is for, by its instructions: the check's Run, or a judgement after it. */
  kind: string;
  /** The searches the Run made before this request, in order. */
  queries: string[];
  handed: HandedPassage[];
  reply: string;
  /** The searches this request asked for. */
  asked: string[];
  /** The check was asked to search again before it says the sentence isn't found (#1608). */
  searchAgain: boolean;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

const KINDS: readonly [string, string][] = [
  ["You sort the sentences of", "claims"],
  ["You check one sentence", "check"],
  ["and gave a verdict without recording", "evidence"],
  ["found it unsupported, and named the part", "covered-evidence"],
  ["A sentence the User wrote says more", "parts"],
  ["Reply in exactly three lines", "strict"],
  ["both state a figure, date, name or outcome", "nearest"],
  ["Compare a sentence the User wrote", "confirm"],
];

function kindOf(system: string): string {
  return KINDS.find(([words]) => system.includes(words))?.[1] ?? "other";
}

function read(prompt: LanguageModelV4Prompt) {
  let system = "";
  let asked = "";
  const queries: string[] = [];
  const handed: HandedPassage[] = [];
  for (const message of prompt) {
    if (message.role === "system") system += message.content;
    else if (message.role === "user") {
      for (const part of message.content) if (part.type === "text") asked += `${part.text}\n`;
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call" && part.toolName === "search_documents") {
          const input = part.input as { query?: unknown } | undefined;
          queries.push(String(input?.query ?? ""));
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result" && part.output.type === "text") {
          handed.push(...passagesIn(part.output.value));
        }
      }
    }
  }
  return { system, asked, queries, handed };
}

/** A search's query as the model wrote it; its raw input when that isn't JSON, as a model may write. */
function queryOf(input: string): string {
  try {
    const parsed = JSON.parse(input || "{}") as { query?: unknown };
    return String(parsed.query ?? "");
  } catch {
    return input;
  }
}

/** A request that names the claims among a Mind's sentences (#1682): what it was shown and what came back. */
export interface ClaimsRequest {
  asked: string;
  reply: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export interface RequestWatch {
  chatModels(inner: ChatModelFactory): ChatModelFactory;
  /** Each sentence's requests since the last call, in order. */
  take(): Map<string, WatchedRequest[]>;
  /** The requests that named claims since the last call, in order. */
  takeClaims(): ClaimsRequest[];
}

export function watchRequests(sentences: readonly string[]): RequestWatch {
  let watched = new Map<string, WatchedRequest[]>();
  let claims: { request: WatchedRequest; asked: string }[] = [];

  function start(prompt: LanguageModelV4Prompt) {
    const { system, asked, queries, handed } = read(prompt);
    // A request that names several sentences (finding the claims) is no sentence's. Two sets may
    // share a sentence: it is one sentence here.
    const named = [...new Set(sentences)].filter((sentence) => asked.includes(sentence));
    const [sentence] = named;
    const request: WatchedRequest = {
      kind: kindOf(system),
      queries,
      handed,
      reply: "",
      asked: [],
      searchAgain: asked.includes(SEARCH_AGAIN),
      inputTokens: 0,
      outputTokens: 0,
      ms: 0,
    };
    if (request.kind === "claims") claims.push({ request, asked });
    else if (named.length === 1 && sentence !== undefined) {
      watched.set(sentence, [...(watched.get(sentence) ?? []), request]);
    }
    return { request, began: performance.now() };
  }

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params }) => {
      const { request, began } = start(params.prompt);
      const result = await doStream();
      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "text-delta") request.reply += part.delta;
            else if (part.type === "tool-call" && part.toolName === "search_documents") {
              request.asked.push(queryOf(part.input));
            } else if (part.type === "finish") {
              request.inputTokens = part.usage.inputTokens.total ?? 0;
              request.outputTokens = part.usage.outputTokens.total ?? 0;
              request.ms = performance.now() - began;
            }
            controller.enqueue(part);
          },
        }),
      );
      return { ...result, stream };
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const { request, began } = start(params.prompt);
      const result = await doGenerate();
      for (const part of result.content) if (part.type === "text") request.reply += part.text;
      request.inputTokens = result.usage.inputTokens.total ?? 0;
      request.outputTokens = result.usage.outputTokens.total ?? 0;
      request.ms = performance.now() - began;
      return result;
    },
  };

  return {
    chatModels: (inner) => (spec) => wrapLanguageModel({ model: inner(spec), middleware }),
    take() {
      const taken = watched;
      watched = new Map();
      return taken;
    },
    takeClaims() {
      const taken = claims.map(({ request, asked }) => ({
        asked,
        reply: request.reply,
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        ms: request.ms,
      }));
      claims = [];
      return taken;
    },
  };
}
