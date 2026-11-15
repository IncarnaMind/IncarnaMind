/**
 * The check of what an Answer wrote sends each new request only while no reply is out on its
 * provider, its own Answer's included (#2830): the reply goes first on the key's allowance, and
 * requests already out finish. The time a request waits there is no part of the check's time
 * limits, nor of its pauses: they count only the time nothing of it waited.
 */
import { wrapLanguageModel } from "ai";
import type { PreparedChatModel } from "../../providers/chat";
import type { RepliesOut } from "../../runs/replies";
import type { PaceTimers } from "../../sources/pace";
import { type HeldTime, heldTime } from "./heldTime";

export interface RepliesFirst {
  /** `prepared`, whose requests wait while a reply is out on its provider, or until their abort. */
  model(prepared: PreparedChatModel): PreparedChatModel;
  /**
   * Settles once no reply is out on `prepared`'s provider, or `stop` aborts: before a sentence's
   * check or the sort begins, so their clocks start once it has, and `timers` never counts it.
   */
  before(prepared: PreparedChatModel, stop: AbortSignal): Promise<void>;
  /** `base`, whose sleeps leave out the time a request of this check waited behind a reply. */
  timers: PaceTimers;
  /** Aborts after `ms` of time nothing of the check waited behind a reply, unless `until` aborts first. */
  timeout(ms: number, until: AbortSignal): AbortSignal;
}

export function repliesFirst(
  replies: RepliesOut | undefined,
  base: PaceTimers,
  held: HeldTime = heldTime(base),
): RepliesFirst {
  const behindReplies = async (provider: string, signal: AbortSignal | undefined) => {
    // Only a request that waits counts: one sent at once leaves the check's clocks as they run.
    if (!replies || !signal || !replies.out(provider)) return;
    const end = held.begin();
    try {
      // A reply may begin between this one's end and the request going out: it goes first too.
      while (replies.out(provider) && !signal.aborted) await replies.none(provider, signal);
    } finally {
      end();
    }
    signal.throwIfAborted();
  };

  return {
    model: (prepared) => ({
      ...prepared,
      model: wrapLanguageModel({
        model: prepared.model,
        middleware: {
          specificationVersion: "v4",
          wrapGenerate: async ({ doGenerate, params }) => {
            await behindReplies(prepared.provider.id, params.abortSignal);
            return doGenerate();
          },
          wrapStream: async ({ doStream, params }) => {
            await behindReplies(prepared.provider.id, params.abortSignal);
            return doStream();
          },
        },
      }),
    }),
    before: (prepared, stop) => replies?.none(prepared.provider.id, stop) ?? Promise.resolve(),
    timers: held.timers,
    timeout: held.timeout,
  };
}
