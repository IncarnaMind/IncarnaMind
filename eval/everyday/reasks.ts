/**
 * Watches the chat model's requests for the app's own asks inside one Answer
 * (#1226): the end-of-turn checks asking again, and the one request for
 * Citations. It can also put a reply of its own in place of the model's first,
 * so a request meets an ask every time, not only when the model slips.
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory } from "../../src/core";
import { CITE_RETRY_INSTRUCTIONS } from "../../src/core/answers/prompt";
import { streamedReply } from "../../tests/helpers/models";

/** How many times the app asked in one Answer. */
export interface Asks {
  /** A check of the end of the turn asked the model again with the record of what its Tools did. */
  again: number;
  /** The one request for the Answer's Citations. */
  citations: number;
}

export interface ReaskWatch {
  chatModels(inner: ChatModelFactory): ChatModelFactory;
  /** Starts watching an Answer; `firstReply` is what the model's first request gets instead of its own reply. */
  begin(firstReply: string | null): void;
  end(): Asks;
}

/** Opens the note an end-of-turn check asks again with (see `thisAnswersRecord` in src/core/answers/claimedChanges.ts). */
export const ASKED_AGAIN = "What the Tools of this Answer really did";

type Message = { content: string | readonly { type: string }[] };

const textOf = ({ content }: Message): string =>
  typeof content === "string"
    ? content
    : content
        .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
        .join("");

export function watchReasks(): ReaskWatch {
  let asks: Asks = { again: 0, citations: 0 };
  let pending: string | null = null;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params }) => {
      const last = params.prompt.at(-1);
      if (last?.role === "user" && textOf(last).includes(ASKED_AGAIN)) asks.again++;
      if (
        params.prompt.some(
          (message) => message.role === "system" && message.content === CITE_RETRY_INSTRUCTIONS,
        )
      ) {
        asks.citations++;
      }
      if (pending !== null && (params.tools?.length ?? 0) > 0) {
        const reply = pending;
        pending = null;
        return { stream: streamedReply(reply, params.abortSignal, { chunkSize: 40 }) };
      }
      return doStream();
    },
  };
  return {
    chatModels: (inner) => (spec) => wrapLanguageModel({ model: inner(spec), middleware }),
    begin(firstReply) {
      asks = { again: 0, citations: 0 };
      pending = firstReply;
    },
    end: () => asks,
  };
}
