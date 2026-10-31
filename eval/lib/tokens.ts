import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory } from "../../src/core";

/** One model request's tokens as its provider counted them, and what its instructions start with. */
export interface RequestTokens {
  instructions: string;
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

/** Counts every request of the models it wraps, so a report can give each one's tokens. */
export function watchTokens() {
  let requests: RequestTokens[] = [];
  const record = (prompt: LanguageModelV4Prompt, usage: LanguageModelV4Usage) => {
    const total = usage.inputTokens.total ?? 0;
    const cacheRead = usage.inputTokens.cacheRead ?? 0;
    const cacheWrite = usage.inputTokens.cacheWrite ?? 0;
    requests.push({
      instructions: instructionsOf(prompt),
      uncached: usage.inputTokens.noCache ?? Math.max(0, total - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
      output: usage.outputTokens.total ?? 0,
    });
  };
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      record(params.prompt, result.usage);
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const result = await doStream();
      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "finish") record(params.prompt, part.usage);
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
    /** The requests since the last call. */
    take(): RequestTokens[] {
      const taken = requests;
      requests = [];
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
