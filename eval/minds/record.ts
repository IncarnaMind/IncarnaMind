/**
 * What one run asked of the models: every request's tokens (the rewrites that
 * edit_mind asks for included, which an Answer's own count leaves out) and a
 * transcript of what the model said, called and was told.
 */
import type { LanguageModelV4, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory } from "../../src/core";

export interface Tokens {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export const noTokens = (): Tokens => ({
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
});

type Usage = Awaited<ReturnType<LanguageModelV4["doGenerate"]>>["usage"];
type Part =
  Awaited<ReturnType<LanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer P>
    ? P
    : never;

const SHOWN = 700;
const cut = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SHOWN ? `${flat.slice(0, SHOWN)}…` : flat;
};

function add(tokens: Tokens, usage: Usage): void {
  tokens.requests++;
  tokens.inputTokens += usage.inputTokens.total ?? 0;
  tokens.cachedInputTokens += usage.inputTokens.cacheRead ?? 0;
  tokens.cacheWriteTokens += usage.inputTokens.cacheWrite ?? 0;
  tokens.outputTokens += usage.outputTokens.total ?? 0;
}

function toldIn(prompt: LanguageModelV4Prompt): string[] {
  const told: string[] = [];
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index];
    if (!message || message.role === "assistant") break;
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const output = part.output;
      const text =
        output.type === "text" || output.type === "error-text"
          ? output.value
          : JSON.stringify(
              output.type === "content" ? output.value : (output as { value?: unknown }).value,
            );
      told.unshift(`told by ${part.toolName}: ${cut(text)}`);
    }
  }
  return told;
}

export interface Recorder {
  chatModels(inner: ChatModelFactory): ChatModelFactory;
  /** A model whose requests are counted into `judging`. */
  counted(model: Parameters<typeof wrapLanguageModel>[0]["model"]): LanguageModel;
  chat: Tokens;
  judging: Tokens;
  transcript: string[];
}

/** `onChat` hears each chat request once its tokens are counted. */
export function createRecorder(options: { onChat?: () => void } = {}): Recorder {
  const chat = noTokens();
  const judging = noTokens();
  const transcript: string[] = [];

  const speaking = (prompt: LanguageModelV4Prompt, tools: readonly { name: string }[]) => {
    if (tools.length === 0) {
      transcript.push("(a rewrite asked for by edit_mind)");
      return;
    }
    if (transcript.length === 0)
      transcript.push(`offered: ${tools.map((tool) => tool.name).join(", ")}`);
    transcript.push(...toldIn(prompt));
  };

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params }) => {
      speaking(params.prompt, params.tools ?? []);
      const done = await doStream();
      let said = "";
      const calls: string[] = [];
      const watching = new TransformStream<Part, Part>({
        transform(part, controller) {
          if (part.type === "text-delta") said += part.delta;
          else if (part.type === "tool-call")
            calls.push(`calls ${part.toolName} ${cut(part.input)}`);
          else if (part.type === "finish") {
            add(chat, part.usage);
            options.onChat?.();
          }
          controller.enqueue(part);
        },
        flush() {
          if (said.trim() !== "") transcript.push(`says: ${cut(said)}`);
          transcript.push(...calls);
        },
      });
      return { ...done, stream: done.stream.pipeThrough(watching) };
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      speaking(params.prompt, params.tools ?? []);
      const done = await doGenerate();
      add(chat, done.usage);
      options.onChat?.();
      return done;
    },
  };

  const counting: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream }) => {
      const done = await doStream();
      const watching = new TransformStream<Part, Part>({
        transform(part, controller) {
          if (part.type === "finish") add(judging, part.usage);
          controller.enqueue(part);
        },
      });
      return { ...done, stream: done.stream.pipeThrough(watching) };
    },
    wrapGenerate: async ({ doGenerate }) => {
      const done = await doGenerate();
      add(judging, done.usage);
      return done;
    },
  };

  return {
    chatModels: (inner) => (spec) => wrapLanguageModel({ model: inner(spec), middleware }),
    counted: (model) => wrapLanguageModel({ model, middleware: counting }),
    chat,
    judging,
    transcript,
  };
}
