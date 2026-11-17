/**
 * Checks started before a run's queue is made (#2532, src/core/answers/checks/runChecks.ts): only
 * into the run's free places, taken by the run only when it would send the same, and stopped at
 * once when it won't.
 */
import { expect, test, vi } from "vitest";
import type { ClaimCheckRequest } from "../../src/core/answers/checks/claimCheck";
import type { DecisionReader } from "../../src/core/answers/checks/decisionFirst";
import type { DecisionLines } from "../../src/core/answers/checks/decisionLines";
import {
  type ChecksRun,
  checkRequestOf,
  earlyChecks,
  type QueuedClaim,
  readingsFirst,
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

const LINES: DecisionLines = { firstReading: { supported: 0.8, contradicted: 0.5 } };

function setUp(
  places: number,
  read?: Parameters<typeof readingsFirst>[0],
  reader?: DecisionReader,
) {
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
    ...(read && reader && { readFirst: readingsFirst(read, reader, "note-1") }),
    signal: new AbortController().signal,
  };
  const limit = slots(places);
  const sent: ClaimCheckRequest[] = [];
  const finish: (() => void)[] = [];
  const claimCheck = (request: ClaimCheckRequest) => {
    sent.push(request);
    return new Promise<ClaimCheckResult>((resolve) => {
      finish.push(() => resolve(RESULT));
    });
  };
  return { run, limit, sent, finish, early: earlyChecks(claimCheck, run, limit) };
}

/** What a check reads besides its request, never changing. */
const unchanged = () => "library 1";

const claim = (words: string, context = words): QueuedClaim => ({
  id: words,
  claim: words,
  context,
});

// protects=a check starts early only into a place the run's limit has free, so none waits outside the run, where a provider's rate limit wouldn't slow it (#1618, #2532); fails_when=an early check is started while every place is taken; no_claim=how the run lowers the number after a rate limit.
test("starts a check early only while the run has a free place", () => {
  const { early, sent } = setUp(2);

  early.start(claim("Spring tides come at new moon."), unchanged);
  early.start(claim("Neap tides come at the quarter moons."), unchanged);
  early.start(claim("High water comes twice a day."), unchanged);

  expect(sent.map((request) => request.claim)).toEqual([
    "Spring tides come at new moon.",
    "Neap tides come at the quarter moons.",
  ]);
});

// protects=the run takes an early check only when it would send the same request, and stops the others as soon as its queue is made (#2532); fails_when=a check sent with other words is taken, or one the run won't take goes on; no_claim=what the checks find.
test("the run takes an early check that sends the same, and the others stop at once", async () => {
  const { early, sent, finish, run } = setUp(3);
  const same = claim("Spring tides come at new moon.");
  const changed = claim("Neap tides come at the quarter moons.");
  early.start(same, unchanged);
  early.start(changed, unchanged);
  const [kept, stopped] = sent;

  const now = { ...changed, context: `${changed.context} Their range is smallest then.` };
  early.keep([same, now]);

  expect(kept?.signal.aborted).toBe(false);
  expect(stopped?.signal.aborted).toBe(true);
  const taken = early.claimCheck(checkRequestOf(same, run, run.signal));
  const fresh = early.claimCheck(checkRequestOf(now, run, run.signal));
  expect(sent).toHaveLength(3);
  expect(sent[2]?.context).toBe(now.context);
  for (const done of finish) done();
  expect(await taken).toBe(RESULT);
  expect(await fresh).toBe(RESULT);
});

// protects=an early check whose request is the same but whose sources changed meanwhile (a Document renamed so a record cite's source is no longer one, a source chosen in the Note) is stopped and checked again, not taken (#2532); fails_when=only the request decides what is taken; no_claim=which changes count, which the core's Library state and the Note's record-cite inputs say.
test("an early check is stopped, not taken, when what it reads besides its request changed", async () => {
  const { early, sent, finish, run } = setUp(3);
  let library = 1;
  const reads = () => `library ${library}`;
  const tides = claim("Spring tides come at new moon. Ex. 7 at 2.");
  early.start(tides, reads);
  const [first] = sent;

  library = 2;
  early.keep([tides]);

  expect(first?.signal.aborted).toBe(true);
  const again = early.claimCheck(checkRequestOf(tides, run, run.signal));
  expect(sent).toHaveLength(2);
  for (const done of finish) done();
  expect(await again).toBe(RESULT);
});

// protects=a sentence checked early is read by the run's decision model first and once, one that reading marks never reaches its check (#3118), and one it leaves to its check is checked with the Passages the reading found to be about it (#2532); fails_when=an early check asks the model before the reading ends, a marked sentence is checked all the same, the run reads again what an early check read, or the check is sent without what the reading found; no_claim=what the run writes on the Mark.
test("an early check waits for its sentence's reading, made once, and a marked sentence has no check", async () => {
  const marked = claim("Spring tides come at new moon.");
  const leaning = claim("Neap tides come at the quarter moons.");
  const supported = { verdict: "supported", providerId: null, modelId: "decision" } as const;
  const leans = { firstReading: supported, about: new Map([["passage-1", 0.9]]) };
  const read: string[] = [];
  const ends: (() => void)[] = [];
  const reader: DecisionReader = { model: supported, lines: LINES, ask: async () => null };
  const { early, sent, finish, run } = setUp(
    2,
    (request) => {
      read.push(request.claim);
      return new Promise((resolve) => {
        ends.push(() => resolve(request.claim === marked.claim ? { result: RESULT } : leans));
      });
    },
    reader,
  );

  early.start(marked, unchanged);
  early.start(leaning, unchanged);
  expect(read).toEqual([marked.claim, leaning.claim]);
  expect(sent).toHaveLength(0);
  early.keep([marked, leaning]);
  const again = run.readFirst?.(checkRequestOf(leaning, run, run.signal));
  for (const end of ends) end();

  expect(await again?.read).toBe(leans);
  expect(read).toHaveLength(2);
  expect(sent.map((request) => [request.claim, request.about])).toEqual([
    [leaning.claim, leans.about],
  ]);
  for (const done of finish) done();
});

// protects=a check waiting for its sentence's reading counts as one of the run's places, so with a decision model chosen no more checks start early than without one (#1618, #3118); fails_when=every claim named starts a check because none waiting on a reading has taken a place yet; no_claim=the order the readings end in.
test("no more checks start early behind their readings than the run has places", async () => {
  const read: string[] = [];
  const ends: (() => void)[] = [];
  const reader: DecisionReader = {
    model: { providerId: null, modelId: "decision" },
    lines: LINES,
    ask: async () => null,
  };
  const { early, sent } = setUp(
    2,
    (request) => {
      read.push(request.claim);
      return new Promise((resolve) => ends.push(() => resolve(null)));
    },
    reader,
  );

  expect(early.start(claim("Spring tides come at new moon."), unchanged)).toBe(true);
  expect(early.start(claim("Neap tides come at the quarter moons."), unchanged)).toBe(true);
  expect(early.start(claim("High water comes twice a day."), unchanged)).toBe(false);
  expect(read).toHaveLength(2);

  for (const end of ends) end();
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  expect(early.start(claim("High water comes twice a day."), unchanged)).toBe(false);
});
