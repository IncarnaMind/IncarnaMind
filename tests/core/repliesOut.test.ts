/**
 * The record of which providers have an Answer out (src/core/runs/replies.ts), which a write's check
 * waits behind (#2830).
 */
import { describe, expect, test } from "vitest";
import { createRepliesOut } from "../../src/core/runs/replies";

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
