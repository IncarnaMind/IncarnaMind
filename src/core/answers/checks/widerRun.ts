/**
 * Check this Note checks twice as many sentences at once where the AI service's own replies state
 * that the key has room for the whole Note (#2532). It starts as wide as every check does, so a
 * key that states nothing, or too little, is sent no more than before; and it goes back for good
 * once the service refuses one of the run's requests.
 *
 * A key can state a minute's room and still refuse a burst, so the run widens only after the
 * service has answered as many requests carrying a search's results, the large ones, as it sends
 * at once: a key that refuses those refuses them before it is sent any more.
 */
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { PreparedChatModel } from "../../providers/chat";
import type { ChatLanguageModel } from "../../providers/models";
import { statedRoom } from "../../providers/statedRoom";
import { wrappedWhenUsed } from "../../providers/wrappedWhenUsed";
import type { Slots } from "../../runs/stop";

export const WIDE_CLAIMS_AT_ONCE = 12;

type Prompt = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["params"]["prompt"];

/**
 * What one sentence's check can take from a key's minute. A Note of 24 took up to 720,000 input
 * tokens on a Library of 100 files (#2944), and no sentence took more than 9 requests when the
 * check was timed (#2532).
 */
const A_SENTENCE = { inputTokens: 30_000, requests: 9 };

export interface WiderRun {
  /** `prepared`, its replies read for what they state of the key's room. */
  prepared: PreparedChatModel;
  /** `RunItemsOptions.wider`, for the run that shares `limit`. */
  wider(resize: (concurrency: number) => void): void;
  /** The service refused one of the run's requests. */
  onLimit(): void;
}

/** `limit` holds `atOnce` places, for a Note of `sentences` sentences to check. */
export function widerRun(
  prepared: PreparedChatModel,
  limit: Slots,
  atOnce: number,
  sentences: number,
): WiderRun {
  let width = atOnce;
  let refused = false;
  /** Requests carrying a search's results that the service answered. */
  let answered = 0;
  let resizeRun: ((concurrency: number) => void) | null = null;
  const resize = (next: number) => {
    if (next === width) return;
    width = next;
    limit.resize(next);
    resizeRun?.(next);
  };
  const read = (headers: Readonly<Record<string, string>> | undefined, prompt: Prompt) => {
    if (refused || width !== atOnce) return;
    if (prompt.some((message) => message.role === "tool")) answered++;
    const room = statedRoom(headers);
    if (
      room &&
      answered >= atOnce &&
      room.requests >= sentences * A_SENTENCE.requests &&
      room.inputTokens >= sentences * A_SENTENCE.inputTokens
    ) {
      resize(WIDE_CLAIMS_AT_ONCE);
    }
  };
  const reading = (model: ChatLanguageModel) =>
    wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate, params }) => {
          const result = await doGenerate();
          read(result.response?.headers, params.prompt);
          return result;
        },
        wrapStream: async ({ doStream, params }) => {
          const result = await doStream();
          read(result.response?.headers, params.prompt);
          return result;
        },
      },
    });
  return {
    // Wrapped when a request first asks for it, as a check's own listener is (./runCheck), the
    // model asked to think too: the step that judges is the one whose replies state the room.
    prepared: wrappedWhenUsed(prepared, reading),
    wider(resizeTo) {
      resizeRun = resizeTo;
      if (width !== atOnce) resizeTo(width);
    },
    onLimit() {
      refused = true;
      resize(atOnce);
    },
  };
}
