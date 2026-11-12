/**
 * Watches the chat model's requests by sentence: what each check asked, the
 * Tool calls it made, the Passages it was handed, what came back, the tokens
 * and the time. A check's cost and the cause of a wrong verdict are read from
 * these, not guessed.
 */

import type { LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory } from "../../src/core";
import { checkNow } from "../../src/core/answers/checks/checkedText";
import { SEARCH_AGAIN } from "../../src/core/answers/checks/searchAgain";
import { DOCUMENT_TOOLS } from "../../src/core/tools";
import { type HandedPassage, passagesIn } from "./passagesHanded";

/** A Tool call the model made: its input as the model wrote it, and what the app told it back. */
export interface WatchedCall {
  id: string;
  tool: string;
  input: string;
  /**
   * What `cite` and `calculate` answered, the app's own words; null for a search, whose Passages
   * are in `handed`, and until a later request carries the answer.
   */
  result: string | null;
}

export interface WatchedRequest {
  /** What the request is for, by its instructions: the check's Run, or a judgement after it. */
  kind: string;
  /** The sentence's part the request checks, as the check named it; null for the whole sentence. */
  part: string | null;
  /** The searches the Run made before this request, in order. */
  queries: string[];
  handed: HandedPassage[];
  reply: string;
  /** The searches this request asked for. */
  asked: string[];
  /** Every Tool call it made, in order. */
  calls: WatchedCall[];
  /** The check was asked to search again before it says the sentence isn't found (#1608). */
  searchAgain: boolean;
  /** The check was sent back to calculate before it gives its verdict. */
  calculateAsked: boolean;
  inputTokens: number;
  /** Of `inputTokens`, those read from the provider's prompt cache and those written to it. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
  ["Write one sentence in", "restate"],
];

function kindOf(system: string): string {
  return KINDS.find(([words]) => system.includes(words))?.[1] ?? "other";
}

/** How the check's "calculate-first" turn check starts its note (src/core/answers/checks/claimCheck.ts). */
const CALCULATE_FIRST = "The numerical check is incomplete.";

/** The Tools whose answer is the app's own words about the model's records. */
const KEPT_ANSWERS: ReadonlySet<string> = new Set([DOCUMENT_TOOLS.cite, DOCUMENT_TOOLS.calculate]);

function read(prompt: LanguageModelV4Prompt) {
  let system = "";
  let asked = "";
  const queries: string[] = [];
  const handed: HandedPassage[] = [];
  const answers = new Map<string, string>();
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
        if (
          part.type === "tool-result" &&
          KEPT_ANSWERS.has(part.toolName) &&
          (part.output.type === "text" || part.output.type === "error-text")
        ) {
          answers.set(part.toolCallId, part.output.value);
        }
      }
    }
  }
  return { system, asked, queries, handed, answers };
}

/** The app's answer to a call reaches the model in the next request's prompt, so it is read from there. */
function answered(earlier: readonly WatchedRequest[], answers: ReadonlyMap<string, string>) {
  for (const call of earlier.flatMap((request) => request.calls)) {
    call.result ??= answers.get(call.id) ?? null;
  }
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
    const { system, asked, queries, handed, answers } = read(prompt);
    // The check tags every request it makes with its sentence and part; one that names
    // sentences itself (finding the claims) is no sentence's, and is read from its words.
    const checked = checkNow();
    const named = [...new Set(sentences)].filter((sentence) => asked.includes(sentence));
    const [sentence] = named;
    const request: WatchedRequest = {
      kind: kindOf(system),
      part: checked?.part ?? null,
      queries,
      handed,
      reply: "",
      asked: [],
      calls: [],
      searchAgain: asked.includes(SEARCH_AGAIN),
      calculateAsked: asked.includes(CALCULATE_FIRST),
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      ms: 0,
    };
    const owner =
      checked?.sentence ?? (request.kind !== "claims" && named.length === 1 ? sentence : undefined);
    if (owner !== undefined) {
      const earlier = watched.get(owner) ?? [];
      answered(earlier, answers);
      watched.set(owner, [...earlier, request]);
    } else if (request.kind === "claims") claims.push({ request, asked });
    return { request, began: performance.now() };
  }

  const called = (request: WatchedRequest, id: string, tool: string, input: string) => {
    request.calls.push({ id, tool, input, result: null });
    if (tool === "search_documents") request.asked.push(queryOf(input));
  };

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params }) => {
      const { request, began } = start(params.prompt);
      const result = await doStream();
      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "text-delta") request.reply += part.delta;
            else if (part.type === "tool-call")
              called(request, part.toolCallId, part.toolName, part.input);
            else if (part.type === "finish") {
              request.inputTokens = part.usage.inputTokens.total ?? 0;
              request.cacheReadTokens = part.usage.inputTokens.cacheRead ?? 0;
              request.cacheWriteTokens = part.usage.inputTokens.cacheWrite ?? 0;
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
      for (const part of result.content) {
        if (part.type === "text") request.reply += part.text;
        else if (part.type === "tool-call")
          called(request, part.toolCallId, part.toolName, part.input);
      }
      request.inputTokens = result.usage.inputTokens.total ?? 0;
      request.cacheReadTokens = result.usage.inputTokens.cacheRead ?? 0;
      request.cacheWriteTokens = result.usage.inputTokens.cacheWrite ?? 0;
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
