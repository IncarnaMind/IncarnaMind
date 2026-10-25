/**
 * Watches the chat model's requests for the Passages a check's searches hand
 * it, by sentence: a model that was never handed the Passage that settles a
 * sentence can't judge it right, whatever else it does.
 */

import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory } from "../../src/core";

export interface HandedPassage {
  document: string;
  text: string;
}

const PASSAGE = /<passage id="[^"]*" document="([^"]*)"[^>]*>([\s\S]*?)<\/passage>/g;

export function passagesIn(toolOutput: string): HandedPassage[] {
  return [...toolOutput.matchAll(PASSAGE)].map(([, document = "", text = ""]) => ({
    document,
    text,
  }));
}

export interface PassageWatch {
  chatModels(inner: ChatModelFactory): ChatModelFactory;
  /** What the checks of each sentence were handed since the last call, each Passage once. */
  take(): Map<string, HandedPassage[]>;
}

export function watchPassages(sentences: readonly string[]): PassageWatch {
  let handed = new Map<string, HandedPassage[]>();

  function note(prompt: LanguageModelV4Prompt) {
    let asked = "";
    const found: HandedPassage[] = [];
    for (const message of prompt) {
      if (message.role === "user") {
        for (const part of message.content) if (part.type === "text") asked += `${part.text}\n`;
      } else if (message.role === "tool") {
        for (const part of message.content) {
          if (part.type === "tool-result" && part.output.type === "text") {
            found.push(...passagesIn(part.output.value));
          }
        }
      }
    }
    // A request that names two sentences (finding the claims) hands no Passages.
    const named = sentences.filter((sentence) => asked.includes(sentence));
    const [sentence] = named;
    if (named.length === 1 && sentence !== undefined) {
      const known = handed.get(sentence) ?? [];
      for (const passage of found) {
        if (!known.some((each) => each.document === passage.document && each.text === passage.text))
          known.push(passage);
      }
      handed.set(sentence, known);
    }
  }

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params }) => {
      note(params.prompt);
      return doStream();
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      note(params.prompt);
      return doGenerate();
    },
  };

  return {
    chatModels: (inner) => (spec) => wrapLanguageModel({ model: inner(spec), middleware }),
    take() {
      const taken = handed;
      handed = new Map();
      return taken;
    },
  };
}
