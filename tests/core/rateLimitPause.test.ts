/**
 * How long a rate limit pauses Tagging, for the errors the pause reads: a wrapped sign-in route's
 * own reset time, and the least a pause lasts.
 */
import { describe, expect, test } from "vitest";
import { SignInRouteError } from "../../src/core/providers/providerErrors";
import { createRateLimitPause, RATE_LIMIT_PAUSE } from "../../src/core/tags/rateLimit";
import { heldClock } from "../helpers/heldClock";

function pauseOn() {
  const clock = heldClock();
  const resumed: string[] = [];
  const pause = createRateLimitPause({
    timers: clock.timers,
    resumed: () => resumed.push("resumed"),
    signal: new AbortController().signal,
  });
  return { clock, pause, resumed };
}

describe("a rate limit's pause", () => {
  test("a sign-in route's reset time is used, though the AI SDK wrapped the error", () => {
    const { clock, pause } = pauseOn();
    const resetsAt = clock.now() + 120_000;
    const wrapped = new Error("The stream failed.", {
      cause: new SignInRouteError("rate-limited", "Too many requests.", resetsAt),
    });

    expect(pause.pause(wrapped)).toBe(resetsAt);
  });

  test("a Retry-After of nothing still pauses for the shortest wait", () => {
    const { clock, pause } = pauseOn();
    const route = new SignInRouteError("rate-limited", "Too many requests.", clock.now());

    expect(pause.pause(route)).toBe(clock.now() + RATE_LIMIT_PAUSE.shortestWaitMs);
  });

  test("a pause restored from before a quit holds until its time, and one already over doesn't", () => {
    const { clock, pause } = pauseOn();
    pause.restore(clock.now() - 1);
    expect(pause.pausedUntil()).toBeNull();

    pause.restore(clock.now() + 5_000);
    expect(pause.pausedUntil()).toBe(clock.now() + 5_000);
    clock.advance(5_000);
    expect(pause.pausedUntil()).toBeNull();
  });

  test("ending it at once lets Documents go on", () => {
    const { clock, pause, resumed } = pauseOn();
    pause.restore(clock.now() + 5_000);

    pause.resumeNow();

    expect(pause.pausedUntil()).toBeNull();
    expect(resumed).toEqual(["resumed"]);
  });
});
