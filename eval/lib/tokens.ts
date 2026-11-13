import { AsyncLocalStorage } from "node:async_hooks";
import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory } from "../../src/core";

/** A request made inside `hear`: what the model was sent, and the text of its reply. */
export interface HeardRequest {
  prompt: LanguageModelV4Prompt;
  text: string;
}

export type Hear = <T>(run: () => Promise<T>) => Promise<{ result: T; requests: HeardRequest[] }>;

/** One model request's tokens as its provider counted them, and what its instructions start with. */
export interface RequestTokens {
  instructions: string;
  /** What the model replied, its text and Tool calls. */
  reply: string;
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

type Model = Parameters<typeof wrapLanguageModel>[0]["model"];

const instructionsOf = (prompt: LanguageModelV4Prompt) =>
  prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n")
    .slice(0, 80);

/** A failed try by its error's name and HTTP status: never the provider's own words. */
function failureOf(error: unknown): string | null {
  if (!(error instanceof Error)) return "a failure that is no Error";
  // A stop the app asked for, such as a check's first turn that named its parts, is no failure.
  if (error.name === "AbortError" || error.name === "ResponseAborted") return null;
  const status = "statusCode" in error ? error.statusCode : undefined;
  return typeof status === "number" ? `${error.name} ${status}` : error.name;
}

/** Counts every request of the models it wraps, so a report can give each one's tokens. */
export function watchTokens() {
  let requests: RequestTokens[] = [];
  let failures: string[] = [];
  const hearing = new AsyncLocalStorage<HeardRequest[]>();
  const failed = (prompt: LanguageModelV4Prompt, error: unknown) => {
    const failure = failureOf(error);
    if (failure) failures.push(`${failure}, asked with “${instructionsOf(prompt)}”`);
  };
  const record = (prompt: LanguageModelV4Prompt, usage: LanguageModelV4Usage, reply: string) => {
    const total = usage.inputTokens.total ?? 0;
    const cacheRead = usage.inputTokens.cacheRead ?? 0;
    const cacheWrite = usage.inputTokens.cacheWrite ?? 0;
    requests.push({
      instructions: instructionsOf(prompt),
      reply,
      uncached: usage.inputTokens.noCache ?? Math.max(0, total - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
      output: usage.outputTokens.total ?? 0,
    });
  };
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const heard = hearing.getStore();
      let result: Awaited<ReturnType<typeof doGenerate>>;
      try {
        result = await doGenerate();
      } catch (error) {
        failed(params.prompt, error);
        throw error;
      }
      const reply = result.content
        .map((part) =>
          part.type === "text"
            ? part.text
            : part.type === "tool-call"
              ? `${part.toolName} ${part.input}`
              : "",
        )
        .join("");
      record(params.prompt, result.usage, reply);
      heard?.push({
        prompt: params.prompt,
        text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      });
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      // Taken as the request starts: the stream's parts may arrive in another async context.
      const heard = hearing.getStore();
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (error) {
        failed(params.prompt, error);
        throw error;
      }
      let reply = "";
      let text = "";
      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "error") failed(params.prompt, part.error);
            else if (part.type === "text-delta") {
              reply += part.delta;
              text += part.delta;
            } else if (part.type === "tool-call") reply += `${part.toolName} ${part.input}`;
            else if (part.type === "finish") {
              record(params.prompt, part.usage, reply);
              heard?.push({ prompt: params.prompt, text });
            }
            controller.enqueue(part);
          },
        }),
      );
      return { ...result, stream };
    },
  };
  return {
    wrap: <M extends Model>(model: M) => wrapLanguageModel({ model, middleware }),
    chatModels:
      (inner: ChatModelFactory): ChatModelFactory =>
      (spec) =>
        wrapLanguageModel({ model: inner(spec), middleware }),
    /**
     * `run`, and every request it makes through these models, in the order their replies end;
     * requests from work it didn't start aren't among them.
     */
    async hear<T>(run: () => Promise<T>): Promise<{ result: T; requests: HeardRequest[] }> {
      const heard: HeardRequest[] = [];
      const result = await hearing.run(heard, run);
      return { result, requests: heard };
    },
    /** The requests since the last call. */
    take(): RequestTokens[] {
      const taken = requests;
      requests = [];
      return taken;
    },
    /** Each try the provider refused or failed since the last call, a retry's earlier tries included. */
    takeFailures(): string[] {
      const taken = failures;
      failures = [];
      return taken;
    },
  };
}

/** Requests, then each kind of token, summed: what a reviewer needs to price them again. */
export function tokenLine(requests: readonly RequestTokens[]): string {
  const sum = (field: "uncached" | "cacheRead" | "cacheWrite" | "output") =>
    requests.reduce((total, each) => total + each[field], 0).toLocaleString("en-US");
  return `${requests.length} requests: uncached input ${sum("uncached")}, cache reads ${sum("cacheRead")}, cache writes ${sum("cacheWrite")}, output ${sum("output")}`;
}
