import { APICallError, RetryError } from "ai";
import { JevRequestError } from "./jev";
import { classifyProviderError, SignInRouteError } from "./providerErrors";
import { retryAfterMs } from "./retryAfter";

/** The least a rate limit's wait lasts, for a stated wait of 0 or a few milliseconds. */
export const SHORTEST_RATE_LIMIT_WAIT_MS = 1_000;

/**
 * How long a rate limit asks to wait, in ms: the service's `retry-after-ms` or `retry-after`,
 * Jev's own, or when a sign-in route's limit resets. Null when it doesn't say; undefined when
 * `error` isn't a rate limit.
 */
export function statedWaitMs(error: unknown, now: number): number | null | undefined {
  if (classifyProviderError(error).kind !== "rate-limit") return undefined;
  const retried = RetryError.isInstance(error) ? error.lastError : error;
  // The AI SDK wraps the error of a stream's route in its own.
  const cause =
    retried instanceof Error && retried.cause instanceof SignInRouteError ? retried.cause : retried;
  if (APICallError.isInstance(cause) && cause.responseHeaders) {
    return retryAfterMs(new Headers(cause.responseHeaders), now);
  }
  if (cause instanceof JevRequestError) return cause.retryAfterMs;
  if (cause instanceof SignInRouteError && cause.resetsAt !== null) {
    return Math.max(0, cause.resetsAt - now);
  }
  return null;
}
