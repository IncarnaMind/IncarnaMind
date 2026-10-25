/**
 * A rate limit (HTTP 429) from the model that tags pauses all of Tagging,
 * automatic tagging's and Organize's alike. While it holds nothing is sent:
 * Documents wait and say when it ends. It ends by itself, at the provider's
 * `Retry-After` when it gives one, otherwise after a wait that doubles each
 * time the limit is still reached, or at once when the User asks. It never
 * retries in a loop: one Document tries first when the wait is over.
 *
 * A key the provider refuses (HTTP 401 or 403) stops them the same way, with no end of its
 * own: it holds until a key or model changes (#1505), as `resumeNow` says.
 */
import { APICallError, RetryError } from "ai";
import type { ProviderError } from "../api";
import { JevRequestError } from "../providers/jev";
import { classifyProviderError, SignInRouteError } from "../providers/providerErrors";
import { retryAfterMs } from "../providers/retryAfter";
import type { PaceTimers } from "../sources/pace";

export const RATE_LIMIT_PAUSE = {
  firstWaitMs: 30_000,
  longestWaitMs: 60 * 60_000,
  /** The least a pause lasts, for a `Retry-After` of 0 or a few milliseconds. */
  shortestWaitMs: 1_000,
};

export type RateLimitPause = ReturnType<typeof createRateLimitPause>;

/** What Documents say while the pause holds: the provider's own words when a request met the limit. */
export function rateLimitError(until: number, error?: unknown): ProviderError {
  const found = error === undefined ? null : classifyProviderError(error);
  return {
    kind: "rate-limit",
    message: found?.message ?? "Tagging waits for the model's rate limit to end.",
    resetsAt: new Date(until).toISOString(),
  };
}

export function createRateLimitPause(options: {
  timers: PaceTimers;
  /** The pause is over, or the User ended it: Documents that waited go on. */
  resumed(): void;
  signal: AbortSignal;
}) {
  const { timers } = options;
  let until: number | null = null;
  let refused: ProviderError | null = null;
  let wake: AbortController | null = null;
  let nextWait = RATE_LIMIT_PAUSE.firstWaitMs;

  const paused = () => until !== null && timers.now() < until;

  /** How long a rate limit asks to wait (null: it doesn't say), or undefined when `error` isn't one. */
  function limitOf(error: unknown): number | null | undefined {
    if (classifyProviderError(error).kind !== "rate-limit") return undefined;
    const retried = RetryError.isInstance(error) ? error.lastError : error;
    // The AI SDK wraps the error of a stream's route in its own.
    const cause =
      retried instanceof Error && retried.cause instanceof SignInRouteError
        ? retried.cause
        : retried;
    if (APICallError.isInstance(cause) && cause.responseHeaders) {
      return retryAfterMs(new Headers(cause.responseHeaders), timers.now());
    }
    if (cause instanceof JevRequestError) return cause.retryAfterMs;
    if (cause instanceof SignInRouteError && cause.resetsAt !== null) {
      return Math.max(0, cause.resetsAt - timers.now());
    }
    return null;
  }

  function hold(ends: number): void {
    wake?.abort();
    const mine = new AbortController();
    wake = mine;
    until = ends;
    timers.sleep(ends - timers.now(), AbortSignal.any([options.signal, mine.signal])).then(
      () => {
        if (wake !== mine) return;
        until = null;
        wake = null;
        options.resumed();
      },
      () => undefined,
    );
  }

  return {
    /** When the pause ends (epoch milliseconds), or null while nothing is paused. */
    pausedUntil: (): number | null => (paused() ? until : null),

    /**
     * Pauses after a request met a rate limit: for the provider's `Retry-After` when it gives one,
     * otherwise for the next backoff step. Returns when the pause ends, or null when `error`
     * isn't a rate limit.
     */
    pause(error: unknown): number | null {
      const asked = limitOf(error);
      if (asked === undefined) return null;
      const stated = asked !== null;
      const wait = Math.min(
        stated ? Math.max(asked, RATE_LIMIT_PAUSE.shortestWaitMs) : nextWait,
        RATE_LIMIT_PAUSE.longestWaitMs,
      );
      if (!stated) nextWait = Math.min(nextWait * 2, RATE_LIMIT_PAUSE.longestWaitMs);
      const ends = timers.now() + wait;
      if (until !== null && until >= ends) return until;
      hold(ends);
      return ends;
    },

    /** The refusal that holds, or null: nothing is sent while it does. */
    refusal: (): ProviderError | null => refused,

    /** Stops everything after a request was refused for its key. Returns what to say, or null when `error` isn't a refusal. */
    refuse(error: unknown): ProviderError | null {
      const found = classifyProviderError(error);
      if (found.kind !== "auth") return null;
      refused = found;
      return found;
    },

    /** A request went through: the next rate limit starts the backoff again. */
    succeeded(): void {
      nextWait = RATE_LIMIT_PAUSE.firstWaitMs;
    },

    /** Picks up a pause a quit interrupted, so a limited key isn't asked again at once. */
    restore(ends: number): void {
      if (ends > timers.now()) hold(ends);
    },

    /** The pause and a refusal end now, for a new model or key or when the User asks, and Documents go on. */
    resumeNow(): void {
      const held = refused !== null;
      refused = null;
      if (until === null) {
        if (held) options.resumed();
        return;
      }
      wake?.abort();
      wake = null;
      until = null;
      options.resumed();
    },
  };
}
