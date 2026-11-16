/**
 * A reply's request that a rate limit refused (#2944): with a stated wait of a minute or less it
 * waits once, says so, and goes again; a longer wait, none stated or a second refusal fails the
 * Answer as it always has. The model is scripted and the clock is the test's own.
 */
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core, CoreEvents } from "../../src/core";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { scriptedModels, streamingModel } from "../helpers/models";
import { virtualClock } from "../helpers/writeChecked";

/** A service's rate limit, `retryAfter` seconds when it says how long. */
const limited = (retryAfter?: string) =>
  new APICallError({
    message: "Rate limit reached.",
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {},
    statusCode: 429,
    ...(retryAfter !== undefined && { responseHeaders: { "retry-after": retryAfter } }),
    isRetryable: false,
  });

/** A model that refuses its first requests as `refusals` say, then answers; it notes when each came. */
function refusingModel(refusals: readonly APICallError[], now: () => number) {
  const inner = streamingModel("A notebook.");
  const sent: number[] = [];
  const left = [...refusals];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      sent.push(now());
      const refusal = left.shift();
      if (refusal) throw refusal;
      return inner.doStream(options);
    },
  });
  return { model, sent };
}

async function asking(refusals: readonly APICallError[]) {
  const clock = virtualClock();
  const mock = refusingModel(refusals, clock.now);
  const core: Core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(mock.model).createChatModel,
    paceTimers: clock.timers,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-test" });
  const waits: (string | null)[] = [];
  core.on("rateLimit.waiting", (event: CoreEvents["rateLimit.waiting"]) =>
    waits.push(event.resumesAt),
  );
  return {
    core,
    clock,
    sent: mock.sent,
    waits,
    async ask() {
      const started = await core.askInConversation({ text: "What is a Mind?" });
      if (!started.asked) throw new Error(`Not asked: ${JSON.stringify(started)}`);
      return started;
    },
  };
}

describe("A reply refused by a rate limit (#2944)", () => {
  // protects=a reply's request refused once with a stated wait of 60 s or less waits it, says when it resumes, goes again after it and the reply lands (#2944); fails_when=the Answer fails, the request goes sooner than the wait, or the line never says; no_claim=how a real service words its wait.
  test("refused once for 30 s, the reply waits, says so, and lands", async () => {
    const { clock, sent, waits, ask, core } = await asking([limited("30")]);

    const started = await ask();
    const ended = await clock.until(() => answerEnded(core, started.answerId));

    expect(ended.event).toBe("finished");
    expect(sent).toHaveLength(2);
    expect((sent[1] ?? 0) - (sent[0] ?? 0)).toBeGreaterThanOrEqual(30_000);
    // Said while it waits, to the second it resumes at, and said no more once it has.
    expect(waits).toEqual([new Date((sent[0] ?? 0) + 30_000).toISOString(), null]);
  });

  // protects=a reply refused with a wait over a minute fails at once with the rate limit's problem, and sends nothing again (#2944); fails_when=it waits, or its problem is another; no_claim=what the problem says.
  test("refused for longer than a minute, it fails at once", async () => {
    const { clock, sent, waits, ask, core } = await asking([limited("120")]);

    const started = await ask();
    const ended = await clock.until(() => answerEnded(core, started.answerId));

    expect(ended.event).toBe("failed");
    if (ended.event === "failed") expect(ended.payload.error.kind).toBe("rate-limit");
    expect(sent).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  // protects=a reply refused with no stated wait fails at once with the rate limit's problem (#2944); fails_when=it waits for a time nobody stated; no_claim=what the problem says.
  test("refused with no wait stated, it fails at once", async () => {
    const { clock, sent, ask, core } = await asking([limited()]);

    const started = await ask();
    const ended = await clock.until(() => answerEnded(core, started.answerId));

    expect(ended.event).toBe("failed");
    expect(sent).toHaveLength(1);
  });

  // protects=a reply waits once: refused again after its wait it fails with the rate limit's problem (#2944); fails_when=it waits again, or is sent a third time; no_claim=the length of the wait.
  test("refused again after its wait, it fails", async () => {
    const { clock, sent, ask, core } = await asking([limited("20"), limited("20")]);

    const started = await ask();
    const ended = await clock.until(() => answerEnded(core, started.answerId));

    expect(ended.event).toBe("failed");
    if (ended.event === "failed") expect(ended.payload.error.kind).toBe("rate-limit");
    expect(sent).toHaveLength(2);
  });

  // protects=Stop during the wait ends it with nothing sent again (#2944); fails_when=the request goes after the Stop, or the wait goes on; no_claim=how the stopped Answer reads.
  test("Stop during the wait ends it, and nothing is sent afterwards", async () => {
    const { clock, sent, waits, ask, core } = await asking([limited("30")]);

    const started = await ask();
    for (let turn = 0; turn < 20 && sent.length === 0; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    await core.stopConversationAnswer({
      conversationId: started.conversation.id,
      answerId: started.answerId,
    });
    await clock.until(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(sent).toHaveLength(1);
    expect(waits.at(-1)).toBeNull();
  });
});
