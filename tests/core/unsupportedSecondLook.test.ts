/**
 * The second look at an Unsupported its own reply doesn't hold up (#3019): when the reply's Not
 * covered names none of the part's words, the check's Run is asked once more from its start, with
 * the same sentence, Passages, model and instructions, and never shown its first reply. That later
 * reply is read as a first one, with every guard, and nothing more is asked of it.
 */
import { describe, expect, test } from "vitest";
import { checkingModel, isCheckRun, SAME_DETAIL } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import type { ModelCall, ScriptedReply } from "../helpers/models";

const LINE = "The tide turns twice a day.";
const LINE_ZH = "潮水每天涨落两次。";
const TIDES = { name: "Tides.md", contents: `${LINE}\n\n${LINE_ZH}\n` };
const EN = "Tides turn twice in a day here.";
const ZH = "这里的潮水每天涨落两次。";

const unsupported = (uncovered: string, extra: readonly string[] = []) =>
  [
    "Verdict: unsupported",
    "Absence: no",
    "Topic: found",
    ...extra,
    SAME_DETAIL,
    "Explanation: The Passages don't say all of it.",
    "Evidence: [1]",
    "Covered: the tide",
    `Not covered: ${uncovered}`,
  ].join("\n");

const supported = (extra: readonly string[] = []) =>
  [
    "Verdict: supported",
    "Absence: no",
    "Topic: found",
    ...extra,
    SAME_DETAIL,
    "Explanation: The Document says so [^1].",
    "Evidence: [1]",
  ].join("\n");

/** A Run that cites `quote`, then gives each reply in turn, one a Run. */
function looks(quote: string, replies: readonly string[]) {
  let given = 0;
  return {
    judgement: "neither" as const,
    reply: (call: ModelCall): ScriptedReply => {
      if (!call.results.some((result) => result.tool === "cite")) {
        const searched = call.results.find((result) => result.tool === "search_documents");
        const shown = shownPassages(searched?.text ?? "");
        const passage = shown.find((each) => each.text.includes(quote)) ?? shown[0];
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
          ],
        };
      }
      const text = replies[Math.min(given, replies.length - 1)] ?? "";
      given++;
      return { text };
    },
  };
}

async function checked(claim: string, quote: string, replies: readonly string[]) {
  const calls: ModelCall[] = [];
  const { core } = await setUpWithDocuments(
    checkingModel({ [claim]: looks(quote, replies) }, calls),
    [TIDES],
  );
  const result = await core.checkClaim({ claim });
  const starts = calls.filter((call) => isCheckRun(call) && call.results.length === 0);
  return { result, starts };
}

describe("An Unsupported whose Not covered names none of the part's words (#3019)", () => {
  // protects=such a reply's Run is asked once more from its start with the very request it was first sent, never shown its first reply, and its later Supported is the result, in English and Chinese; fails_when=the second look isn't asked, is sent the first reply or other instructions, or its verdict doesn't replace the first; no_claim=how often a real model's second look is right, which the run reads by hand.
  test.each([
    ["en", EN, LINE, "memory and robustness"],
    ["zh", ZH, LINE_ZH, "内存和稳健性"],
  ])("%s: is asked anew, and its later Supported stands", async (_, claim, quote, uncovered) => {
    const { result, starts } = await checked(claim, quote, [unsupported(uncovered), supported()]);

    expect(starts).toHaveLength(2);
    expect(starts[1]?.system).toBe(starts[0]?.system);
    expect(starts[1]?.prompt).toBe(starts[0]?.prompt);
    expect(starts[1]?.prompt).not.toContain(uncovered);
    expect(result.verdict).toBe("supported");
    if (result.verdict === "supported") expect(result.evidence?.quote).toBe(quote);
  });

  // protects=the negative: a reply whose Not covered names the part's own words is never asked again and stays Unsupported, in English and Chinese, and so is a Chinese part held to an English phrase, which can't be compared; fails_when=a whole Unsupported is asked again, or a cross-language phrase sets off a look; no_claim=none beyond protects.
  test.each([
    ["en, Not covered names its words", EN, LINE, "turning twice in a day here"],
    ["zh, Not covered names its words", ZH, LINE_ZH, "每天涨落两次"],
    ["zh, an English phrase can't be compared", ZH, LINE_ZH, "memory and robustness"],
  ])("%s: is not asked again", async (_, claim, quote, uncovered) => {
    const { result, starts } = await checked(claim, quote, [unsupported(uncovered), supported()]);

    expect(starts).toHaveLength(1);
    expect(result.verdict).toBe("unsupported");
  });

  // protects=the second reply is read as a first one: one that again names none of the part's words contradicts itself and is Not checked, a whole Unsupported stands, and a Supported whose scope is wider loses its ✓ to the guard, in English and Chinese; and no part is looked at a third time; fails_when=a self-contradicting second reply reads Unsupported or asks again, a whole one is dropped, or a guard is skipped on the second look; no_claim=none beyond protects.
  test.each([
    ["en, contradicts itself again", EN, LINE, ["memory and robustness"], "not-checked"],
    ["zh, contradicts itself again", ZH, LINE_ZH, ["内存和稳健性"], "not-checked"],
    ["en, a whole Unsupported", EN, LINE, ["turning twice in a day here"], "unsupported"],
    ["zh, a whole Unsupported", ZH, LINE_ZH, ["每天涨落两次"], "unsupported"],
    ["en, Supported but wider", EN, LINE, null, "unsupported"],
    ["zh, Supported but wider", ZH, LINE_ZH, null, "unsupported"],
  ] as const)("%s", async (_, claim, quote, second, verdict) => {
    const first = unsupported(claim === EN ? "memory and robustness" : "内存和稳健性");
    const later =
      second === null ? supported(["Scope: tides, wider"]) : unsupported(second[0] ?? "");
    const { result, starts } = await checked(claim, quote, [first, later, supported()]);

    expect(starts).toHaveLength(2);
    expect(result.verdict).toBe(verdict);
  });
});
