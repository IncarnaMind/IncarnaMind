/**
 * How many times a run of repeated checks sorts its Note's sentences (#2964): a bar about a mark or
 * a verdict gets a sort of its own for every check, a bar about time or cost may reuse the first
 * one's, and a verdict bar asked to reuse one is refused before any request. The sorts are counted
 * from the requests the scripted model receives.
 */
import { describe, expect, test } from "vitest";
import {
  barOf,
  type RepeatOptions,
  type RepeatResult,
  repeatChecks,
  sortsAsked,
  sortsOf,
} from "../../eval/repeats/repeat";
import { report, summarise } from "../../eval/repeats/score";
import { checkGenerate, checkReply, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { scriptedModel } from "../helpers/models";

const AGREEMENT = {
  name: "Agreement.md",
  contents:
    "# Agreement\n\nThe Employee may work from home two days a week.\n\n员工每周可以在家办公两天。\n",
};
const ENGLISH = "The Employee may work from home two days a week.";
const CHINESE = "员工每周可以在家办公两天。";
const PLANS: Record<string, Plan> = {
  [ENGLISH]: { verdict: "supported", quote: "The Employee may work from home two days a week" },
  [CHINESE]: { verdict: "supported", quote: "员工每周可以在家办公两天" },
};

/** A core whose scripted model checks both sentences Supported and counts its requests and sorts. */
async function counted() {
  const received = { requests: 0, sorts: 0 };
  const generate = checkGenerate(PLANS);
  const model = scriptedModel(
    (call) => {
      received.requests++;
      return checkReply(call, PLANS);
    },
    {
      generate: (call) => {
        received.requests++;
        if (call.question === "find-claims") received.sorts++;
        return generate(call);
      },
    },
  );
  const { core } = await setUpWithDocuments(model, [AGREEMENT]);
  const provider = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  // Saving the chat provider has the model tag the Documents: only a run's own requests are counted.
  received.requests = 0;
  const run = (
    options: Pick<RepeatOptions, "bar" | "sorts" | "repeats"> & { stopAfter?: number },
  ) =>
    repeatChecks(core, {
      mind: "Home working",
      sentences: [ENGLISH, CHINESE],
      model: { providerId: provider.id, modelId: "local-model" },
      ...options,
      onRepeat: (done) => done[0]?.repeat !== options.stopAfter,
    });
  return { received, run };
}

const sortsOfRun = (results: readonly RepeatResult[]) =>
  results.filter((each) => each.sentence === ENGLISH).map((each) => each.sort);

const rowsOf = (results: readonly RepeatResult[]) =>
  results.map((each) => ({
    ...each,
    set: "home",
    model: "scripted",
    key: each.sentence === ENGLISH ? "en" : "zh",
    kind: "paraphrase" as const,
    expected: "supported" as const,
  }));

describe("a run's sorts", () => {
  // protects=a bar about a mark or a verdict sorts afresh for every check, counted from its requests (#2964); fails_when=a later check reuses the first one's sort; no_claim=what a real model says.
  test("a verdict bar's run of 5 checks makes 5 sorts, one a check", async () => {
    const { received, run } = await counted();
    const results = await run({ bar: "verdict", repeats: 5 });
    expect(received.sorts).toBe(5);
    expect(sortsOfRun(results)).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((each) => each.outcome)).toEqual(Array(10).fill("supported"));
  });

  // protects=a bar about time or cost may reuse one sort, and its report says so (#2964); fails_when=it sorts again, or its report reads as fresh sorts; no_claim=what a real model says.
  test("a speed bar's run of 5 checks makes 1 sort, and its report says it was reused", async () => {
    const { received, run } = await counted();
    const results = await run({ bar: "speed", repeats: 5 });
    expect(received.sorts).toBe(1);
    expect(sortsOfRun(results)).toEqual([1, 1, 1, 1, 1]);
    const shown = report(summarise(rowsOf(results)), { commit: "abc", spent: 0, repeats: 5 });
    expect(shown).toContain("· 5 checks, 1 sort");
    expect(shown).toContain("One sort reused by every check");
  });

  // protects=a verdict bar over a reused sort is refused with a worded error before any request, beside the same run accepted under a speed bar and with fresh sorts (#2964); fails_when=it runs, or sends a request first; no_claim=what a real model says.
  test("a verdict bar asked to reuse one sort is refused before any request; a speed bar's is run", async () => {
    const { received, run } = await counted();
    await expect(run({ bar: "verdict", sorts: "reused", repeats: 5 })).rejects.toThrow(
      "A bar about a mark or a verdict can't reuse one sort",
    );
    expect(received.requests).toBe(0);
    await run({ bar: "speed", sorts: "reused", repeats: 2 });
    expect(received.sorts).toBe(1);
    await run({ bar: "verdict", sorts: "fresh", repeats: 2 });
    expect(received.sorts).toBe(3);
  });

  // protects=a run of one check, and a run stopped early, count the sorts they made (#2964); fails_when=the sorts don't match the checks run; no_claim=what a real model says.
  test("a run of one check makes 1 sort, and a run stopped after 2 of 5 makes 2", async () => {
    const one = await counted();
    expect(sortsOfRun(await one.run({ bar: "verdict", repeats: 1 }))).toEqual([1]);
    expect(one.received.sorts).toBe(1);
    const stopped = await counted();
    const results = await stopped.run({ bar: "verdict", repeats: 5, stopAfter: 2 });
    expect(sortsOfRun(results)).toEqual([1, 2]);
    expect(stopped.received.sorts).toBe(2);
    expect(report(summarise(rowsOf(results)), { commit: "abc", spent: 0, repeats: 5 })).toContain(
      "· 2 checks, 2 sorts",
    );
  });
});

describe("a run's bar and sorts as asked for", () => {
  // protects=a run's bar is a mark or a verdict unless it says speed, and an unknown word is refused (#2964); fails_when=a run reads speed by default or takes any word; no_claim=what a real model says.
  test("read from the run's variables, an unknown word refused", () => {
    expect(barOf(undefined)).toBe("verdict");
    expect(barOf(" speed ")).toBe("speed");
    expect(() => barOf("fast")).toThrow('INCARNAMIND_EVAL_REPEATS_BAR is "fast"');
    expect(sortsAsked("")).toBeUndefined();
    expect(sortsAsked("reused")).toBe("reused");
    expect(() => sortsAsked("sometimes")).toThrow('INCARNAMIND_EVAL_REPEATS_SORTS is "sometimes"');
  });

  // protects=a verdict bar sorts afresh and a speed bar reuses unless asked otherwise; only a verdict bar over a reused sort is refused (#2964); fails_when=the defaults swap, or a speed bar is refused; no_claim=what a real model says.
  test("default to fresh for a verdict bar and reused for a speed bar", () => {
    expect(sortsOf("verdict")).toBe("fresh");
    expect(sortsOf("speed")).toBe("reused");
    expect(sortsOf("speed", "fresh")).toBe("fresh");
    expect(sortsOf("speed", "reused")).toBe("reused");
    expect(() => sortsOf("verdict", "reused")).toThrow(
      "Run it with a fresh sort for each check (INCARNAMIND_EVAL_REPEATS_SORTS=fresh, or unset)",
    );
  });
});
