/**
 * Assistant turns that said nothing (#2701): a reply with no text and no Tool call that still left a
 * turn behind, as Claude's does (its `message_start` part) and Gemini's of thoughts alone. A re-ask
 * sends that turn back before its note, and it carries nothing to read. Anthropic refuses the cache
 * mark it would get there (./promptCache), and Gemini refuses it as a model turn with no parts, so
 * every provider leaves it out; the note then joins the message before it, so no provider reads two
 * user turns in a row, which the one-pass Answers already join (`asMessages`).
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

/** The prompt with each run of user messages joined into one, a blank line between their text. */
function joinedUserTurns(prompt: Prompt): Prompt {
  const out: Prompt = [];
  for (const message of prompt) {
    const last = out.at(-1);
    if (message.role === "user" && last?.role === "user") {
      out[out.length - 1] = {
        ...last,
        content: [...last.content, { type: "text" as const, text: "\n\n" }, ...message.content],
      };
    } else out.push(message);
  }
  return out;
}

/** A model whose requests leave out the assistant turns that said nothing. */
export function withoutEmptyTurns(model: ChatLanguageModel): ChatLanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        prompt: joinedUserTurns(params.prompt.filter((message) => !saysNothing(message))),
      }),
    },
  });
}
