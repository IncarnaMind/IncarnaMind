/**
 * The record of which providers have an Answer out (src/core/runs/replies.ts), which a write's check
 * waits behind (#2830).
 */
import { generateText } from "ai";
import { describe, expect, test } from "vitest";
import { repliesFirst } from "../../src/core/answers/checks/repliesFirst";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import type { PreparedChatModel } from "../../src/core/providers/chat";
import { createRepliesOut } from "../../src/core/runs/replies";
import { type Clock, heldClock } from "../helpers/heldClock";
import { replyingModel } from "../helpers/models";

const settled = async (promise: Promise<void>) => {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

describe("Replies out on a provider", () => {
  // protects=a check waits only behind replies on its own provider, and only until the last of them ends: two Answers out at once are both waited for (#2830); fails_when=another provider's reply holds it, or the first of two ending lets it go; no_claim=which provider a request goes to.
  test("a wait ends when the last reply on its provider ends, and another provider's reply holds nothing", async () => {
    const replies = createRepliesOut();
    const stop = new AbortController().signal;
    const first = replies.begin("anthropic");
    const second = replies.begin("anthropic");
    replies.begin("deepseek");

    expect(await settled(replies.none("openai", stop))).toBe(true);
    const waiting = replies.none("anthropic", stop);
    first();
    first();
    expect(await settled(waiting)).toBe(false);
    second();
    expect(await settled(waiting)).toBe(true);
    expect(await settled(replies.none("anthropic", stop))).toBe(true);
  });

  // protects=a wait behind a reply ends when its own stop does, the reply still out (#2830); fails_when=a stopped check waits for the reply; no_claim=what the check does then.
  test("a wait ends on its stop while the reply is still out", async () => {
    const replies = createRepliesOut();
    replies.begin("anthropic");
    const stop = new AbortController();
    const waiting = replies.none("anthropic", stop.signal);
    expect(await settled(waiting)).toBe(false);
    stop.abort();
    expect(await settled(waiting)).toBe(true);
  });
});

/** The held clock moved to `at` ms after it started, with what that wakes run. */
const movedTo = async (clock: Clock, start: number, at: number) => {
  clock.advance(start + at - clock.now());
  await new Promise((resolve) => setImmediate(resolve));
};

const prepared: PreparedChatModel = {
  model: replyingModel(),
  provider: {
    id: "anthropic",
    kind: "anthropic",
    catalogId: null,
    endpoint: null,
    baseUrl: null,
    service: null,
    hasApiKey: false,
  },
  modelId: "claude-haiku-5-5",
  summarizesReasoning: false,
  capabilities: resolveCapabilities({ catalog: { tools: true } }),
};

describe("A check's pauses behind a reply", () => {
  // protects=a pause of the check counts only the time none of its requests waited behind a reply: a 100 ms pause during which a request waited 1,000 ms ends after 1,100 ms, not after a second wait's worth more (#2830); fails_when=the time a request waited is added again once it is over, so a long Answer stretches the check's pauses and limits further; no_claim=how long a reply takes.
  test("a pause ends once its own time has passed beside the wait", async () => {
    const replies = createRepliesOut();
    const clock = heldClock();
    const start = clock.now();
    const to = (at: number) => movedTo(clock, start, at);
    const behind = repliesFirst(replies, clock.timers);
    const stop = new AbortController().signal;
    const paused = behind.timers.sleep(100, stop);
    await to(10);
    const replied = replies.begin("anthropic");
    const sent = generateText({
      model: behind.model(prepared).model,
      prompt: "Check",
      abortSignal: stop,
    });
    // The request is waiting from 10 on.
    await to(10);
    await to(100);
    await to(1010);
    replied();
    await sent;
    await to(1099);
    expect(await settled(paused)).toBe(false);
    await to(1100);
    expect(await settled(paused)).toBe(true);
  });

  // protects=a request of the check that waited behind a reply waits again for one that began as the first ended, before it goes (#2830); fails_when=it goes out beside the new reply; no_claim=which reply goes first between two Answers.
  test("a request waits again for a reply that begins as the one before ends", async () => {
    const replies = createRepliesOut();
    const behind = repliesFirst(replies, heldClock().timers);
    const stop = new AbortController().signal;
    const first = replies.begin("anthropic");
    const sent = generateText({
      model: behind.model(prepared).model,
      prompt: "Check",
      abortSignal: stop,
    });
    const done = sent.then(() => undefined);
    expect(await settled(done)).toBe(false);
    first();
    const second = replies.begin("anthropic");
    expect(await settled(done)).toBe(false);
    second();
    expect(await settled(done)).toBe(true);
  });
});
