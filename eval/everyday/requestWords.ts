import type { LanguageModelMiddleware } from "ai";
import { questionOf, replyJson } from "../../src/core/answers/judge";
import { isRecord } from "../../src/shared/record";
import { type ReplyPart, replyTextOf } from "../lib/replyText";

/**
 * The two words the question of whether a reply says the request is done gave (#2878), as the
 * model gave them, kept beside each probe's check so a miss can be read: a word that is missing or
 * isn't a string is null, and a reply with no JSON object keeps its first 200 characters.
 */
export interface RequestWords {
  asks_change: string | null;
  request: string | null;
  text?: string;
}

export function requestWordsOf(content: readonly ReplyPart[]): RequestWords {
  const text = replyTextOf(content);
  const value = replyJson(text);
  const word = (key: string) => {
    const found = isRecord(value) ? value[key] : undefined;
    return typeof found === "string" ? found : null;
  };
  return {
    asks_change: word("asks_change"),
    request: word("request"),
    ...(!isRecord(value) && { text: text.slice(0, 200) }),
  };
}

/** A middleware that keeps the words of the last such question its model answered, until taken. */
export function keepRequestWords() {
  let kept: RequestWords | undefined;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      if (questionOf(params) === "request-done") kept = requestWordsOf(result.content);
      return result;
    },
  };
  const take = () => {
    const words = kept;
    kept = undefined;
    return words;
  };
  return { middleware, take };
}
