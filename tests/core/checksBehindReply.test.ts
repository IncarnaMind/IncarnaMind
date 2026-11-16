/**
 * A check that isn't part of a reply sends each new request only while no reply is out on its
 * key (#2944), as a write's check does (#2830): requests already out finish, the wait counts
 * against neither the check's time limit nor its pauses, and Stop ends it. The checks that start
 * by themselves (the watch in the background, what the assistant wrote) go through the run these
 * tests drive (src/core/answers/checks/runCheck.ts) with `behindReplies`; one the User pressed
 * Check for doesn't.
 */
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { ClaimCheckRequest } from "../../src/core/answers/checks/claimCheck";
import { checkRunOf, runClaimChecks } from "../../src/core/answers/checks/runCheck";
import type { ClaimCheckResult } from "../../src/core/api";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import type { PreparedChatModel } from "../../src/core/providers/chat";
import { createRepliesOut, type RepliesOut } from "../../src/core/runs/replies";
import { heldClock } from "../helpers/heldClock";

const SUPPORTED: ClaimCheckResult = {
  verdict: "supported",
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  versions: [],
  excluded: [],
};

/** A model that notes each request it is sent, and replies once `release` lets that request's reply go. */
function recordingModel() {
  const sent: string[] = [];
  const releases = new Map<string, () => void>();
  let held = false;
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const text = JSON.stringify(prompt);
      const claim = /"text":"(\d+)"/.exec(text)?.[1] ?? "?";
      sent.push(claim);
      if (held) await new Promise<void>((resolve) => releases.set(claim, resolve));
      return {
        content: [{ type: "text", text: "OK" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return {
    model,
    sent,
    /** From now on, a request's reply waits until `release(claim)`. */
    hold: () => {
      held = true;
    },
    release: (claim: string) => releases.get(claim)?.(),
  };
}

const prepared = (model: MockLanguageModelV4): PreparedChatModel => ({
  model,
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
});

const flush = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
};

/** A run of checks, one claim each, on a clock the test moves, whose requests the model records. */
function checks(
  items: readonly number[],
  {
    repliesOut,
    limitMs,
    behindReplies = true,
  }: { repliesOut?: RepliesOut; limitMs?: number; behindReplies?: boolean } = {},
) {
  const clock = heldClock();
  const mock = recordingModel();
  const stop = new AbortController();
  const run = checkRunOf(
    {
      timers: clock.timers,
      ...(repliesOut && { repliesOut }),
      ...(limitMs !== undefined && { claimTimeLimitMs: limitMs }),
      recordAiUse: () => undefined,
      now: () => new Date(clock.now()),
    },
    prepared(mock.model),
    stop.signal,
    null,
    { behindReplies },
  );
  const requestOf = (item: number): ClaimCheckRequest => ({
    claim: String(item),
    scope: { documentIds: null, excluded: new Map() },
    model: run.model,
    signal: stop.signal,
  });
  const claimCheck = async (request: ClaimCheckRequest): Promise<ClaimCheckResult> => {
    await generateText({
      model: request.model.model,
      prompt: request.claim,
      abortSignal: request.signal,
    });
    return SUPPORTED;
  };
  const done = runClaimChecks(items, (item, check) => check(claimCheck, requestOf(item)), {
    ...run,
    concurrency: 1,
  });
  return { clock, mock, stop, done };
}

describe("Checks behind a reply (#2944)", () => {
  // protects=a run's checks start no request while a reply is out on their key, and every verdict lands once it ends (#2944: the check sends no new request until the reply's stream ends, then every verdict lands); fails_when=a request goes out beside the reply, or a verdict never lands; no_claim=how long a reply takes.
  test("no new request goes while a reply is out, and every verdict lands once it ends", async () => {
    const replies = createRepliesOut();
    const reply = replies.begin("anthropic");
    const { mock, done } = checks([1, 2, 3], { repliesOut: replies });

    await flush();
    expect(mock.sent).toEqual([]);
    reply();
    const run = await done;

    expect(mock.sent).toEqual(["1", "2", "3"]);
    expect(run.outcomes.map((each) => each && "result" in each && each.result.verdict)).toEqual([
      "supported",
      "supported",
      "supported",
    ]);
  });

  // protects=a request already out when a reply begins finishes, and the next waits for the reply (#2944: requests already out finish); fails_when=the request out is cut off, or the next goes out beside the reply; no_claim=how the provider counts the request out.
  test("a request already out finishes, and the next waits for the reply", async () => {
    const replies = createRepliesOut();
    const { mock, done } = checks([1, 2], { repliesOut: replies });
    mock.hold();
    await flush();
    expect(mock.sent).toEqual(["1"]);

    const reply = replies.begin("anthropic");
    mock.release("1");
    await flush();
    expect(mock.sent).toEqual(["1"]);

    reply();
    await flush();
    mock.release("2");
    const run = await done;

    expect(mock.sent).toEqual(["1", "2"]);
    expect(run.outcomes.every((each) => each && "result" in each)).toBe(true);
  });

  // protects=the time a check waits behind a reply counts against neither its time limit nor its pauses: held for ten times its limit, it doesn't end as timed out (#2944); fails_when=the check ends timed out while it waits, or right after; no_claim=the length of the limit.
  test("a check held behind a reply for longer than its time limit doesn't end as timed out", async () => {
    const replies = createRepliesOut();
    const reply = replies.begin("anthropic");
    const { clock, mock, done } = checks([1], { repliesOut: replies, limitMs: 1_000 });

    await flush();
    clock.advance(10_000);
    await flush();
    expect(mock.sent).toEqual([]);
    reply();
    const run = await done;

    expect(mock.sent).toEqual(["1"]);
    expect(run.outcomes[0]).toMatchObject({ result: { verdict: "supported" } });
  });

  // protects=Stop during the wait ends it, and nothing is sent after it, though the reply goes on (#2944); fails_when=a stopped check waits for the reply, or sends a request once it ends; no_claim=what a stopped check records.
  test("Stop during the wait ends it, and nothing is sent afterwards", async () => {
    const replies = createRepliesOut();
    const reply = replies.begin("anthropic");
    const { mock, stop, done } = checks([1, 2], { repliesOut: replies });

    await flush();
    stop.abort();
    const run = await done;
    reply();
    await flush();

    expect(mock.sent).toEqual([]);
    // A stopped check is Not checked, stopped; the claim after it is never started.
    expect(run.outcomes[0]).toMatchObject({
      result: { verdict: "not-checked", reason: "stopped" },
    });
    expect(run.outcomes[1] ?? null).toBeNull();
  });

  // protects=a turn with no reply out sends the same requests in the same order as a run that never listens for replies (#2944: path identity); fails_when=listening changes what is sent, or its order; no_claim=the verdicts.
  test("with no reply out the requests are the same, in the same order", async () => {
    const plain = checks([1, 2, 3, 4]);
    await plain.done;
    const listening = checks([1, 2, 3, 4], { repliesOut: createRepliesOut() });
    await listening.done;

    expect(listening.mock.sent).toEqual(plain.mock.sent);
    expect(plain.mock.sent).toEqual(["1", "2", "3", "4"]);
  });

  // protects=a check the User pressed Check for sends its requests beside a reply, as it always has (#2944: only the checks that start by themselves wait); fails_when=a pressed check is held behind a reply; no_claim=which flows press.
  test("a check the User pressed Check for isn't held", async () => {
    const replies = createRepliesOut();
    replies.begin("anthropic");
    const { mock, done } = checks([1, 2], { repliesOut: replies, behindReplies: false });

    await done;

    expect(mock.sent).toEqual(["1", "2"]);
  });

  // protects=another provider's reply holds nothing (#2944); fails_when=a reply on one key holds a check on another; no_claim=which key a provider is.
  test("a reply on another key holds nothing", async () => {
    const replies = createRepliesOut();
    replies.begin("openai");
    const { mock, done } = checks([1], { repliesOut: replies });

    await done;

    expect(mock.sent).toEqual(["1"]);
  });
});
