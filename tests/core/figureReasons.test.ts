/**
 * A figure the check finds Unsupported, whose item in the Figures line gives no `says` of its own,
 * takes the reply's own explanation as its reason (#2184): its card was bare though the reply said
 * why. Checked in a Note, as the app checks a sentence with a figure: the figure's own result is
 * the one the sentence shows.
 */
import { describe, expect, test } from "vitest";
import {
  checkedInNote,
  checkGenerate,
  isCheckRun,
  type Plan,
  requestedFigures,
  SAME_DETAIL,
  sentenceOf,
} from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const CASES = [
  {
    language: "en",
    document: {
      name: "Boat rules.md",
      contents: "# Boat rules\n\nMembers may borrow up to 3 boats a week.",
    },
    claim: "Members should borrow up to 3 boats a week.",
    quote: "Members may borrow up to 3 boats a week",
    roles: "Roles: members should borrow / members may borrow, differs",
    explanation: "The rules let members borrow up to 3 boats a week, but don't say they should.",
  },
  {
    language: "zh-CN",
    document: { name: "借船规则.md", contents: "# 借船规则\n\n会员每周最多可借用3条船。" },
    claim: "会员每周最多应借用3条船。",
    quote: "会员每周最多可借用3条船",
    roles: "Roles: 会员应借用 / 会员可借用, differs",
    explanation: "规则允许会员每周最多借用3条船，但没有说会员应当借用。",
  },
] as const;

/**
 * Claude Haiku 5.5's reply in the real-model run of #2184 ("Up to 5 unused days should be carried
 * over"): a Supported verdict whose Roles line differs, and a figure item that calls its number's
 * roles different and gives no `says`.
 */
function replying(example: (typeof CASES)[number]) {
  return (call: ModelCall): ScriptedReply => {
    if (!isCheckRun(call) || sentenceOf(call) !== example.claim) return { text: "" };
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0)
      return { calls: [{ tool: "search_documents", input: { query: example.claim } }] };
    const [passage] = shownPassages(searches.at(-1)?.text ?? "");
    if (!call.results.some((result) => result.tool === "cite"))
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: passage?.id, quote: example.quote }] },
          },
        ],
      };
    const items = requestedFigures(call).map(({ id }) => ({
      id,
      verdict: "supported",
      scope: "same",
      topic: "found",
      roles: "differs",
      measure: { sentence: example.claim, quote: example.quote, match: "same" },
      says: null,
      reading: null,
      relation: "equals",
      source: { citation: 1, number: "3", reading: null, unitQuote: null },
      calculation: null,
    }));
    return {
      text: [
        "Verdict: supported",
        "Absence: no",
        "Scope: none, same",
        "Topic: found",
        example.roles,
        "Time: none / none, same",
        SAME_DETAIL,
        `Explanation: ${example.explanation}`,
        "Evidence: [1]",
        `Figures: ${JSON.stringify({ items, remainder: null })}`,
      ].join("\n"),
    };
  };
}

describe.each(CASES)("a figure with no reason of its own ($language)", (example) => {
  // protects=a figure's Unsupported whose item gives no reason shows the reply's own explanation, never a bare card (#2184); fails_when=the sentence's Unsupported has no reason; no_claim=what a real model writes.
  test("takes the reply's explanation", async () => {
    const plans: Record<string, Plan> = { [example.claim]: { verdict: "supported" } };
    const model = scriptedModel(replying(example), { generate: checkGenerate(plans) });
    const setUp = await setUpWithDocuments(model, [example.document]);
    await setUp.core.updateSettings({ user: { language: example.language } });
    const check = await checkedInNote(setUp, example.claim);
    setUp.core.close();
    expect(check?.figures?.map((figure) => figure.state)).toEqual(["unsupported"]);
    expect(check).toMatchObject({
      state: "unsupported",
      unsupported: { reason: example.explanation },
    });
  });
});
