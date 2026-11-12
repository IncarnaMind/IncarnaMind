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

/** Settles after `ms` on the computer's clock, or rejects once `signal` aborts; never keeps the host up. */
const sleepHere = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    timer.unref?.();
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });

export function repliesFirst(replies: RepliesOut | undefined, base: PaceTimers): RepliesFirst {
  let waitingNow = 0;
  let since = 0;
  let waited = 0;
  // The same on the computer's own clock, for the limits a check keeps apart from `base`.
  let sinceHere = 0;
  let waitedHere = 0;
  const resumed = new Set<() => void>();
  const waitedSoFar = () => waited + (waitingNow > 0 ? base.now() - since : 0);
  const waitedHereSoFar = () => waitedHere + (waitingNow > 0 ? Date.now() - sinceHere : 0);

  const free = (signal: AbortSignal) =>
    waitingNow === 0
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          const resume = () => {
            signal.removeEventListener("abort", stop);
            resolve();
          };
          const stop = () => {
            resumed.delete(resume);
            reject(signal.reason);
          };
          resumed.add(resume);
          signal.addEventListener("abort", stop, { once: true });
        });

  const behindReplies = async (provider: string, signal: AbortSignal | undefined) => {
    // Only a request that waits counts: one sent at once leaves the check's clocks as they run.
    if (!replies || !signal || !replies.out(provider)) return;
    if (waitingNow++ === 0) {
      since = base.now();
      sinceHere = Date.now();
    }
    try {
      await replies.none(provider, signal);
    } finally {
      if (--waitingNow === 0) {
        waited += base.now() - since;
        waitedHere += Date.now() - sinceHere;
        for (const resume of [...resumed]) resume();
        resumed.clear();
      }
    }
    signal.throwIfAborted();
  };

  const timers: PaceTimers = {
    now: base.now,
    async sleep(ms, signal) {
      let left = ms;
      while (left > 0) {
        const from = waitedSoFar();
        await base.sleep(left, signal);
        await free(signal);
        left = waitedSoFar() - from;
      }
    },
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
    timers,
    timeout(ms, until) {
      const timedOut = new AbortController();
      const run = async () => {
        let left = ms;
        while (left > 0) {
          const from = waitedHereSoFar();
          await sleepHere(left, until);
          await free(until);
          left = waitedHereSoFar() - from;
        }
        timedOut.abort(new DOMException("The check's time limit passed.", "TimeoutError"));
      };
      run().catch(() => undefined);
      return timedOut.signal;
    },
  };
}
