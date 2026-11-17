import { wrapLanguageModel } from "ai";
import { createAiSdkChatModel } from "../../src/core";
import { questionOf } from "../../src/core/answers/judge";
import type { ChatModelFactory } from "../../src/core/providers/models";

export interface Recorded {
  via: "stream" | "generate";
  question: string | null;
  text: string;
  tools: { name: string; input: string }[];
  finish: string;
}

/** The model the core builds, with each request's reply kept in `into`, in the order they began. */
export function recording(into: Recorded[]): ChatModelFactory {
  return (spec) =>
    wrapLanguageModel({
      model: createAiSdkChatModel(spec),
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate, params }) => {
          const entry: Recorded = {
            via: "generate",
            question: questionOf(params) ?? null,
            text: "",
            tools: [],
            finish: "",
          };
          into.push(entry);
          const result = await doGenerate();
          for (const part of result.content) {
            if (part.type === "text") entry.text += part.text;
            else if (part.type === "tool-call")
              entry.tools.push({ name: part.toolName, input: part.input });
          }
          entry.finish = result.finishReason.unified;
          return result;
        },
        wrapStream: async ({ doStream, params }) => {
          const entry: Recorded = {
            via: "stream",
            question: questionOf(params) ?? null,
            text: "",
            tools: [],
            finish: "",
          };
          into.push(entry);
          const result = await doStream();
          const stream = result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type === "text-delta") entry.text += part.delta;
                else if (part.type === "tool-call")
                  entry.tools.push({ name: part.toolName, input: part.input });
                else if (part.type === "finish") entry.finish = part.finishReason.unified;
                controller.enqueue(part);
              },
            }),
          );
          return { ...result, stream };
        },
      },
    });
}
