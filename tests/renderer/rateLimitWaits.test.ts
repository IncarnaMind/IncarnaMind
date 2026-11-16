import { beforeEach, expect, test, vi } from "vitest";
import type { CoreEvents } from "../../src/core";
import { formatDateTime } from "../../src/shared/dates";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * What waits on the model's rate limit says so in Tags' words, with when it resumes (#2944): the
 * store the Answer's line, the Note's check line and the written check's line read.
 */

const heard = vi.hoisted(() => ({
  handler: null as null | ((event: CoreEvents["rateLimit.waiting"]) => void),
}));
vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: (name: string, handler: (event: CoreEvents["rateLimit.waiting"]) => void) => {
      if (name === "rateLimit.waiting") heard.handler = handler;
      return () => undefined;
    },
  },
}));

const { installRateLimitWaits, useRateLimitWaits } = await import(
  "../../src/renderer/src/rateLimitWaits"
);
const { selfCheckLines } = await import("../../src/renderer/src/selfChecks");

beforeEach(() => {
  useRateLimitWaits.setState({ resumes: {} });
  installRateLimitWaits();
});

const RESUMES = "2026-11-11T15:20:00.000Z";

// protects=what waits is told apart by its id: it holds the time it resumes while it waits and nothing once it doesn't, and another's wait is none of its own (#2944); fails_when=a wait outlives its end, or one id's wait shows under another; no_claim=the words.
test("a wait is kept by its id until its end is heard", () => {
  heard.handler?.({ id: "answer-1", resumesAt: RESUMES });
  heard.handler?.({ id: "check-2", resumesAt: "2026-11-11T15:21:00.000Z" });
  expect(useRateLimitWaits.getState().resumes).toEqual({
    "answer-1": RESUMES,
    "check-2": "2026-11-11T15:21:00.000Z",
  });

  heard.handler?.({ id: "answer-1", resumesAt: null });
  expect(useRateLimitWaits.getState().resumes).toEqual({ "check-2": "2026-11-11T15:21:00.000Z" });
});

// protects=while the check of what the assistant wrote waits on a rate limit its line says when it resumes, in Tags' words, in English and Chinese, and says its count again once it doesn't (#2944); fails_when=the line keeps its count while waiting, or keeps the wait after; no_claim=how long it waits.
test("the written check's line says when it resumes while it waits, then counts again", () => {
  const running = {
    mindId: "mind-1",
    request: "w",
    checkable: 40,
    cited: 30,
    sent: 40,
    checked: 0,
    failed: 0,
    running: true as const,
  };
  const say =
    (language: "en" | "zh-CN") =>
    (key: MessageKey, params?: MessageParams): string =>
      translate(language, key, params);
  const line = (language: "en" | "zh-CN", limitedUntil: string | null) =>
    selfCheckLines(running, say(language), language, new Date(), null, true, {
      done: 5,
      total: 40,
      limitedUntil,
    })[0]?.text;

  expect(line("en", RESUMES)).toBe(
    `Rate limit reached · resumes at ${formatDateTime(RESUMES, "en")}`,
  );
  expect(line("zh-CN", RESUMES)).toBe(`已达到速率上限 · ${formatDateTime(RESUMES, "zh-CN")} 继续`);
  expect(line("en", null)).toBe("Checking: 5 of 40 sentences done");
});
