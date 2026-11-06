/**
 * Checks started before a run's queue is made (#2532, src/core/answers/checks/runChecks.ts): only
 * into the run's free places, taken by the run only when it would send the same, and stopped at
 * once when it won't.
 */
import { expect, test } from "vitest";
import type { ClaimCheckRequest } from "../../src/core/answers/checks/claimCheck";
import {
  type ChecksRun,
  checkRequestOf,
  earlyChecks,
  type QueuedClaim,
} from "../../src/core/answers/checks/runChecks";
import type { ClaimCheckResult } from "../../src/core/api";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import { slots } from "../../src/core/runs/stop";
import { scriptedModel } from "../helpers/models";

const RESULT: ClaimCheckResult = {
  verdict: "not-checked",
  reason: "empty",
  detail: null,
  versions: [],
  excluded: [],
};

function setUp(places: number) {
  const run: ChecksRun = {
    mindId: "note-1",
    scope: { documentIds: null, excluded: new Map() },
    prepared: {
      model: scriptedModel(() => ({ text: "" })),
      provider: {
        id: "test",
        kind: "anthropic",
        catalogId: null,
        endpoint: null,
        baseUrl: null,
        service: null,
        hasApiKey: false,
      },
      modelId: "scripted-check",
      support: "tools",
      summarizesReasoning: false,
      capabilities: resolveCapabilities({ catalog: { tools: true } }),
    },
    signal: new AbortController().signal,
  };
  const limit = slots(places);
  const sent: ClaimCheckRequest[] = [];
  const finish: (() => void)[] = [];
  const claimCheck = (request: ClaimCheckRequest) => {
    sent.push(request);
    return limit.run(
      () =>
        new Promise<ClaimCheckResult>((resolve) => {
          finish.push(() => resolve(RESULT));
        }),
    );
  };
  return { run, limit, sent, finish, early: earlyChecks(claimCheck, run, limit) };
}

const claim = (words: string, context = words): QueuedClaim => ({
  id: words,
  claim: words,
  context,
});

// protects=a check starts early only into a place the run's limit has free, so none waits outside the run, where a provider's rate limit wouldn't slow it (#1618, #2532); fails_when=an early check is started while every place is taken; no_claim=how the run lowers the number after a rate limit.
test("starts a check early only while the run has a free place", () => {
  const { early, sent } = setUp(2);

  early.start(claim("Spring tides come at new moon."));
  early.start(claim("Neap tides come at the quarter moons."));
  early.start(claim("High water comes twice a day."));

  expect(sent.map((request) => request.claim)).toEqual([
    "Spring tides come at new moon.",
    "Neap tides come at the quarter moons.",
  ]);
});

// protects=the run takes an early check only when it would send the same request, and stops the others as soon as its queue is made (#2532); fails_when=a check sent with other words is taken, or one the run won't take goes on; no_claim=what the checks find.
test("the run takes an early check that sends the same, and the others stop at once", async () => {
  const { early, sent, finish, run, limit } = setUp(3);
  const same = claim("Spring tides come at new moon.");
  const changed = claim("Neap tides come at the quarter moons.");
  early.start(same);
  early.start(changed);
  const [kept, stopped] = sent;

  const now = { ...changed, context: `${changed.context} Their range is smallest then.` };
  early.keep([same, now]);

  expect(kept?.signal.aborted).toBe(false);
  expect(stopped?.signal.aborted).toBe(true);
  const taken = early.claimCheck(checkRequestOf(same, run, limit, run.signal));
  const fresh = early.claimCheck(checkRequestOf(now, run, limit, run.signal));
  expect(sent).toHaveLength(3);
  expect(sent[2]?.context).toBe(now.context);
  for (const done of finish) done();
  expect(await taken).toBe(RESULT);
  expect(await fresh).toBe(RESULT);
});
