/**
 * Assistant turns that said nothing (#2701): a reply with no text and no Tool call that still left a
 * turn behind, as Claude's does (its `message_start` part) and Gemini's of thoughts alone. A re-ask
 * sends that turn back before its note. Anthropic refuses the cache mark it gets there
 * (./promptCache), and Gemini refuses it as a model turn with no parts.
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatLanguageModel } from "./models";

type Params = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];
type Prompt = Params["prompt"];

/** An assistant turn holding no text but blank text, beside the provider's own parts at most. */
export const saysNothing = (message: Prompt[number]): boolean =>
  message.role === "assistant" &&
  message.content.every(
    (part) => part.type === "custom" || (part.type === "text" && part.text.trim() === ""),
  );

/** A model whose requests leave out the assistant turns that said nothing. */
export function withoutEmptyTurns(model: ChatLanguageModel): ChatLanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        prompt: params.prompt.filter((message) => !saysNothing(message)),
      }),
    },
  });
}
