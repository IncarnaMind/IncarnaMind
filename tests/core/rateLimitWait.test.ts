/**
 * How long a rate limit asks to wait (#2944), as Tags and the checks both read it: the service's
 * `retry-after-ms` or `retry-after`, Jev's own, or when a sign-in route's limit resets.
 */
import { APICallError, RetryError } from "ai";
import { describe, expect, test } from "vitest";
import { JevRequestError } from "../../src/core/providers/jev";
import { SignInRouteError } from "../../src/core/providers/providerErrors";
import { statedWaitMs } from "../../src/core/providers/rateLimitWait";

const refused = (headers?: Record<string, string>) =>
  new APICallError({
    message: "Rate limit reached.",
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode: 429,
    ...(headers && { responseHeaders: headers }),
    isRetryable: true,
  });

describe("How long a rate limit asks to wait", () => {
  test("is read from the service's retry-after, in seconds or milliseconds", () => {
    expect(statedWaitMs(refused({ "retry-after": "40" }), 0)).toBe(40_000);
    expect(statedWaitMs(refused({ "retry-after-ms": "2500" }), 0)).toBe(2_500);
  });

  test("is null when the limit doesn't say, and undefined for an error that isn't a limit", () => {
    expect(statedWaitMs(refused(), 0)).toBeNull();
    const notLimited = new APICallError({
      message: "Overloaded.",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode: 500,
      isRetryable: true,
    });
    expect(statedWaitMs(notLimited, 0)).toBeUndefined();
    expect(statedWaitMs(new Error("No route to host."), 0)).toBeUndefined();
  });

  test("is read through the AI SDK's own retries and the wrapper it puts round a route's error", () => {
    const retried = new RetryError({
      message: "Failed after 3 attempts.",
      reason: "maxRetriesExceeded",
      errors: [refused({ "retry-after": "10" }), refused({ "retry-after": "20" })],
    });
    expect(statedWaitMs(retried, 0)).toBe(20_000);

    const route = new SignInRouteError("rate-limited", "Too many requests.", 90_000);
    expect(statedWaitMs(new Error("The stream failed.", { cause: route }), 30_000)).toBe(60_000);
  });

  test("is Jev's own", () => {
    const jev = new JevRequestError("rate-limit", "Slow down.", 429, 12_000);
    expect(statedWaitMs(jev, 0)).toBe(12_000);
  });
});
