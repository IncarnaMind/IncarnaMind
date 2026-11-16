/**
 * A request a rate limit refused with a stated wait is sent again once that wait is over (#2944):
 * the check's, as `runItems` does for its items (./stop), an Answer's sentence check's, and a
 * reply's, each with its own bound. Tags wait the same way (../tags/rateLimit), on the one reading
 * of what a limit says (../providers/rateLimitWait).
 */
import { APICallError, wrapLanguageModel } from "ai";
import type { PreparedChatModel } from "../providers/chat";
import { SHORTEST_RATE_LIMIT_WAIT_MS, statedWaitMs } from "../providers/rateLimitWait";
import { wrappedWhenUsed } from "../providers/wrappedWhenUsed";

/** The longest stated wait a check's request is sent again after (#2944): a longer one gives it up. */
export const REQUEST_WAIT_LIMIT_MS = 2 * 60_000;

/** The longest stated wait a reply's request is sent again after; a reply waits once. */
export const REPLY_WAIT_LIMIT_MS = 60_000;

/** What a sender of requests hears and keeps: the clock it waits by, and what it says of the waits. */
export interface WaitHooks {
  now(): number;
  /** Waits `ms`, or until `signal` aborts. */
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  /**
   * Whether a request refused with a stated wait of `asks` ms is sent again after it. Left out:
   * while `asks` is no more than `REQUEST_WAIT_LIMIT_MS`.
   */
  allows?(asks: number): boolean;
  /** A rate limit was met, with or without a stated wait. */
  met?(): void;
  /** A wait begins (until when, ms since the epoch) or ends. */
  waiting?(until: number, on: boolean): void;
  /** A request is given up for a stated wait it won't wait: its limit is thrown, marked not to be sent again. */
  gaveUp?(error: unknown): void;
}

/** `error`, so the AI SDK doesn't send its request again sooner than a wait allows. */
export const notRetried = (error: unknown): unknown =>
  APICallError.isInstance(error) && error.isRetryable
    ? new APICallError({
        message: error.message,
        url: error.url,
        requestBodyValues: error.requestBodyValues,
        ...(error.statusCode !== undefined && { statusCode: error.statusCode }),
        ...(error.responseHeaders && { responseHeaders: error.responseHeaders }),
        ...(error.responseBody !== undefined && { responseBody: error.responseBody }),
        cause: error.cause,
        isRetryable: false,
        data: error.data,
      })
    : error;

/**
 * Sends `request`. A rate limit that says how long to wait has it sent again once that wait is
 * over, never sooner and at least a second later, once: a request waits on the key's stated time,
 * and one refused again after it is thrown, marked not to be sent again by the AI SDK, for what
 * answers a limit that holds on (the run's pauses, a reply's failure). A stated wait that
 * `hooks.allows` refuses is given up at once. A limit that doesn't say is thrown as it came, for
 * the AI SDK's own retries. `signal` ends a wait and throws, unsent.
 *
 * A key that counts its refused requests (OpenAI's "unsuccessful requests contribute to your
 * per-minute limit") is never gone back to at each stated time by every request at once: that
 * kept it refusing, and lost marks the pauses land (eval/speed/gates/new-account-limits.md).
 */
export async function sendWaiting<R>(
  request: () => PromiseLike<R>,
  hooks: WaitHooks,
  options: { signal?: AbortSignal; sleep?: WaitHooks["wait"] } = {},
): Promise<R> {
  const { signal } = options;
  let waited = false;
  for (;;) {
    try {
      return await request();
    } catch (error) {
      const stated = statedWaitMs(error, hooks.now());
      if (stated === undefined || signal?.aborted) throw error;
      hooks.met?.();
      if (stated === null) throw error;
      if (waited) throw notRetried(error);
      const asks = Math.max(stated, SHORTEST_RATE_LIMIT_WAIT_MS);
      if (!(hooks.allows ? hooks.allows(asks) : asks <= REQUEST_WAIT_LIMIT_MS)) {
        const given = notRetried(error);
        hooks.gaveUp?.(given);
        throw given;
      }
      const until = hooks.now() + asks;
      hooks.waiting?.(until, true);
      try {
        await (options.sleep ?? hooks.wait)(asks, signal);
      } finally {
        hooks.waiting?.(until, false);
      }
      waited = true;
      signal?.throwIfAborted();
    }
  }
}

/** `prepared`, each of whose requests goes through `sendWaiting`, its own abort ending a wait. */
export const waitingOnLimits = (prepared: PreparedChatModel, hooks: WaitHooks): PreparedChatModel =>
  wrappedWhenUsed(prepared, (model) =>
    wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: ({ doGenerate, params }) =>
          sendWaiting(doGenerate, hooks, { signal: params.abortSignal }),
        wrapStream: ({ doStream, params }) =>
          sendWaiting(doStream, hooks, { signal: params.abortSignal }),
      },
    }),
  );

/**
 * The latest end of the waits under way, told as it changes: when it ends (ms since the epoch),
 * or null once no wait is under way. `waiting` is for `WaitHooks.waiting`.
 */
export function pendingWaits(told: (until: number | null) => void) {
  const ends: number[] = [];
  let heard: number | null = null;
  return {
    waiting(until: number, on: boolean): void {
      if (on) ends.push(until);
      else {
        const at = ends.indexOf(until);
        if (at >= 0) ends.splice(at, 1);
      }
      const latest = ends.length > 0 ? Math.max(...ends) : null;
      if (latest === heard) return;
      heard = latest;
      told(latest);
    },
  };
}
