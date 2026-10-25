import { APICallError, RetryError } from "ai";

/** The wait before a request's one retry after a passing error: 1 to 2 seconds, with jitter. */
export const RETRY_WAIT_MS = { least: 1_000, jitter: 1_000 };

/**
 * A passing error worth one quick retry: the server failed (5xx) or timed out (408), or couldn't
 * be reached. A rate limit isn't one: its pause owns it (see ./rateLimit).
 */
export function isTransient(error: unknown): boolean {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(cause)) return false;
  const status = cause.statusCode;
  return status === undefined || status === 408 || status >= 500;
}
