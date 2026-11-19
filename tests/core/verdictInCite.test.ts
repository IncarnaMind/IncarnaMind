/**
 * A check's verdict handed over in `cite` (#3381): the call that records the quotes deciding the
 * sentence may carry the verdict and its explanation, and the check ends with that call.
 */
import { describe, expect, test } from "vitest";
import { SEARCH_AGAIN } from "../../src/core/answers/checks/claimCheck";
import { checkGenerate, isCheckRun, sentenceOf } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    "",
    "Harbours publish the times of high water every year.",
  ].join("\n"),
};

const SUPPORTED = "Spring tides come at new and full moon.";
const SPRING = "Spring tides happen at new moon and at full moon";
const SAYS = "Tides says spring tides happen at new and full moon.";
const CONTRADICTED = "Harbours publish the times of high water every week.";
const HARBOUR = "Harbours publish the times of high water every year.";
const SEARCH_FIRST = "You gave a verdict without reading any Passage.";

type Step = (call: ModelCall, passage: (quote: string) => string) => ScriptedReply;

const search = (query: string): ScriptedReply => ({
  calls: [{ tool: "search_documents", input: { query } }],
});

/** A `cite` call recording `quotes` under markers 1, 2…, with `carried` (a verdict) beside them. */
const cite = (
  passage: (quote: string) => string,
  quotes: readonly string[],
  carried: Record<string, unknown> = {},
  first = 1,
) => ({
  tool: "cite",
  input: {
    citations: quotes.map((quote, at) => ({ marker: first + at, passage: passage(quote), quote })),
    ...carried,
  },
});

/** Checks `claim` beside Tides with a model that answers its check's nth request with the nth step. */
async function check(claim: string, ...steps: Step[]) {
  const runs: ModelCall[] = [];
  const model = scriptedModel(
    (call) => {
      if (!isCheckRun(call)) return { text: "" };
      runs.push(call);
      const found = call.results.filter((result) => result.tool === "search_documents").at(-1);
      const passage = (quote: string) =>
        shownPassages(found?.text ?? "").find((each) => each.text.includes(quote))?.id ?? "P1";
      const step = steps[runs.length - 1];
      return step ? step(call, passage) : { text: "" };
    },
    { generate: checkGenerate({}) },
  );
  const { core } = await setUpWithDocuments(model, [TIDES]);
  const result = await core.checkClaim({ claim });
  return { result, runs };
}

describe("A verdict handed over in cite (#3381)", () => {
  test("ends the check with that call: the verdict, its quote as the evidence and its explanation", async () => {
    const { result, runs } = await check(
      SUPPORTED,
      (call) => search(sentenceOf(call)),
      (_call, passage) => ({
        calls: [cite(passage, [SPRING], { verdict: "supported", explanation: SAYS })],
      }),
    );

    expect(runs).toHaveLength(2);
    expect(result).toMatchObject({
      verdict: "supported",
      says: SAYS,
      evidence: { quote: SPRING, check: "found" },
    });
  });

  test("an overstated verdict keeps its quote, and ends the check with that call", async () => {
    const { result, runs } = await check(
      "Spring tides come at every new moon and every full moon, without fail.",
      (call) => search(sentenceOf(call)),
      (_call, passage) => ({
        calls: [
          cite(passage, [SPRING], {
            verdict: "overstated",
            explanation: "Tides says when spring tides happen, not that they never fail.",
          }),
        ],
      }),
    );

    expect(runs).toHaveLength(2);
    expect(result).toMatchObject({
      verdict: "unsupported",
      unsupported: { word: "overstated", found: true, quoted: { quote: SPRING } },
    });
  });

  test("beside a verdict written in the same turn, the call's is read, and the written Change lines still offer their correction", async () => {
    const { result, runs } = await check(
      CONTRADICTED,
      (call) => search(sentenceOf(call)),
      (_call, passage) => ({
        text: "Verdict: overstated\nExplanation: Harbours publish them.\nEvidence: [1]\nChange 1: every week\nTo 1: every year [^1]",
        calls: [
          cite(passage, [HARBOUR], {
            verdict: "contradicted",
            explanation: "Tides says harbours publish them every year, not every week.",
          }),
        ],
      }),
    );

    expect(runs).toHaveLength(2);
    expect(result).toMatchObject({
      verdict: "contradicted",
      says: "Tides says harbours publish them every year, not every week.",
      evidence: { quote: HARBOUR, check: "found" },
      correction: { from: "every week", choices: [{ wording: "every year" }] },
    });
  });

  test("of two cite calls in one turn, the quotes of both are its evidence", async () => {
    const { result, runs } = await check(
      SUPPORTED,
      (call) => search(sentenceOf(call)),
      (_call, passage) => ({
        calls: [
          cite(passage, [SPRING]),
          cite(
            passage,
            ["when the Sun and the Moon pull together"],
            { verdict: "supported", explanation: SAYS },
            2,
          ),
        ],
      }),
    );

    expect(runs).toHaveLength(2);
    expect(result).toMatchObject({ verdict: "supported", evidence: { quote: SPRING } });
  });

  test("a quote its Document doesn't hold doesn't count: the model is asked to fix it, and with no fix the verdict is hidden", async () => {
    const { result, runs } = await check(
      SUPPORTED,
      (call) => search(sentenceOf(call)),
      (_call, passage) => ({
        calls: [
          cite(passage, ["Spring tides happen twice a day"], {
            verdict: "supported",
            explanation: SAYS,
          }),
        ],
      }),
      () => ({ text: "" }),
    );

    expect(runs).toHaveLength(3);
    expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
  });

  test("a quote fixed in the next call, with the verdict again, ends the check there", async () => {
    const carried = { verdict: "supported", explanation: SAYS };
    const { result, runs } = await check(
      SUPPORTED,
      (call) => search(sentenceOf(call)),
      (_call, passage) => ({
        calls: [cite(passage, ["Spring tides happen twice a day"], carried)],
      }),
      (_call, passage) => ({ calls: [cite(passage, [SPRING], carried)] }),
    );

    expect(runs).toHaveLength(3);
    expect(result).toMatchObject({
      verdict: "supported",
      evidence: { quote: SPRING, check: "found" },
    });
  });

  test("beside another Tool call the check goes on: the model reads that call's result, and its later reply decides", async () => {
    const { result, runs } = await check(
      SUPPORTED,
      (call) => search(sentenceOf(call)),
      (_call, passage) => ({
        calls: [
          { tool: "search_documents", input: { query: "spring tides moon" } },
          cite(passage, [SPRING], {
            verdict: "contradicted",
            explanation: "Tides says otherwise.",
          }),
        ],
      }),
      () => ({ text: `Verdict: supported\nExplanation: ${SAYS} [^1]\nEvidence: [1]` }),
    );

    expect(runs).toHaveLength(3);
    expect(result).toMatchObject({ verdict: "supported", says: SAYS });
  });

  test("handed over before any search, the verdict is sent back to search first", async () => {
    const { result, runs } = await check(
      SUPPORTED,
      () => ({
        calls: [
          { tool: "cite", input: { citations: [], verdict: "supported", explanation: SAYS } },
        ],
      }),
      (call) => search(sentenceOf(call)),
      (_call, passage) => ({
        calls: [cite(passage, [SPRING], { verdict: "supported", explanation: SAYS })],
      }),
    );

    expect(runs[1]?.prompt).toContain(SEARCH_FIRST);
    expect(runs).toHaveLength(3);
    expect(result).toMatchObject({ verdict: "supported", evidence: { quote: SPRING } });
  });

  test("a not-found verdict handed over on no quote still gets its one more search", async () => {
    const { result, runs } = await check(
      SUPPORTED,
      (call) => search(sentenceOf(call)),
      () => ({
        calls: [
          {
            tool: "cite",
            input: { citations: [], verdict: "not found", explanation: "Tides doesn't say." },
          },
        ],
      }),
      () => search("spring tides new moon full moon"),
      (_call, passage) => ({
        calls: [cite(passage, [SPRING], { verdict: "supported", explanation: SAYS })],
      }),
    );

    expect(runs[2]?.prompt).toContain(SEARCH_AGAIN);
    expect(runs).toHaveLength(4);
    expect(result).toMatchObject({ verdict: "supported", evidence: { quote: SPRING } });
  });
});
