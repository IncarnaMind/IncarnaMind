/**
 * An Unsupported claim says why on its card and in its Word comment (#2184). A check that found a
 * contradiction its confirmation didn't uphold, or whose figure's item gave no words of its own,
 * showed an Unsupported card with no reason and went out as the bare "Unsupported by your
 * Documents." Through the core, as the app checks a sentence in a Note, in English and Chinese.
 */
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkingModel, type Plan, requestedFigures, SAME_DETAIL } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { part, textOf, unzip } from "../helpers/docx";
import { note, readMind, writeMind } from "../helpers/minds";
import type { ModelCall, ScriptedReply } from "../helpers/models";

const CASES = [
  {
    language: "en",
    document: {
      name: "Tenancy.md",
      contents:
        "# Tenancy\n\nThe Tenant pays the Council a rent of 85 per year. The Council supplies water to the plot.",
    },
    plain: "The Tenant supplies water to the plot.",
    plainQuote: "The Council supplies water to the plot",
    figure: "The Council pays the Tenant a rent of 85 per year.",
    figureQuote: "The Tenant pays the Council a rent of 85 per year",
    roles: "Roles: the Council pays the Tenant / the Tenant pays the Council, differs",
    number: "85",
    says: "The tenancy gives that to the other party.",
    bare: "Unsupported by your Documents.",
    reasoned: "Unsupported: ",
    notConfirmed: "Unsupported: a passage may say otherwise, but the check couldn’t confirm it. ",
  },
  {
    language: "zh-CN",
    document: {
      name: "租用协议.md",
      contents: "# 租用协议\n\n乙方每年向甲方支付租金人民币八百五十元。甲方向地块供水。",
    },
    plain: "乙方向地块供水。",
    plainQuote: "甲方向地块供水",
    figure: "甲方每年向乙方支付租金人民币八百五十元。",
    figureQuote: "乙方每年向甲方支付租金人民币八百五十元",
    roles: "Roles: 甲方向乙方支付 / 乙方向甲方支付, differs",
    number: "八百五十",
    says: "协议写的是由另一方负责。",
    bare: "无依据。",
    reasoned: "无依据：",
    notConfirmed: "无依据：有段落的说法可能与此不同，但核对未能确认。",
  },
] as const;

type Example = (typeof CASES)[number];

/**
 * A reply whose sentence has a figure: the figure's item gives no words of its own, and the reply
 * is the verdict it says (`contradicted` for the parties reversed, `unsupported` when its item is).
 */
function figureReply(example: Example, verdict: "contradicted" | "unsupported") {
  return (call: ModelCall): ScriptedReply => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    const [passage] = shownPassages(searches.at(-1)?.text ?? "");
    if (!call.results.some((result) => result.tool === "cite"))
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: passage?.id, quote: example.figureQuote }] },
          },
        ],
      };
    const items = requestedFigures(call).map(({ id }) => ({
      id,
      verdict: verdict === "unsupported" ? "unsupported" : "supported",
      scope: "same",
      topic: "found",
      roles: "same",
      measure: null,
      says: null,
      reading: null,
      relation: "equals",
      source: { citation: 1, number: example.number, reading: null, unitQuote: null },
      calculation: null,
    }));
    return {
      text: [
        `Verdict: ${verdict}`,
        "Absence: no",
        "Scope: none, same",
        "Topic: found",
        example.roles,
        "Time: none / none, same",
        SAME_DETAIL,
        `Explanation: ${example.says} [^1]`,
        "Evidence: [1]",
        `Figures: ${JSON.stringify({ items, remainder: null })}`,
      ].join("\n"),
    };
  };
}

async function checkedInNote(example: Example, sentence: string, plan: Plan, word = false) {
  const setUp = await setUpWithDocuments(checkingModel({ [sentence]: plan }), [example.document]);
  await setUp.core.updateSettings({ user: { language: example.language } });
  const { core, mind, client } = setUp;
  const block = note(sentence);
  const blockId = String(block.attrs?.id);
  writeMind(client, [block]);
  await client.settled();
  await core.checkSentences({
    requestId: "check",
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId, offset: 0 },
    to: { blockId, offset: sentence.length },
  });
  await client.settled();
  const check = claimSpans(readMind(client)).find(
    (each) => each.sentence.text.trim() === sentence,
  )?.check;
  const exported = word
    ? await core.exportMind(mind.id, { format: "docx", commentFailedChecks: true })
    : null;
  const comments = exported ? textOf(part(unzip(exported.data), "word/comments.xml")) : "";
  core.close();
  return { check, comments };
}

const SCENARIOS = (example: Example) =>
  [
    {
      name: "a contradiction its confirmation calls about something else",
      sentence: example.plain,
      quote: example.plainQuote,
      card: "framed",
      word: "framed",
      plan: {
        verdict: "contradicted",
        quote: example.plainQuote,
        says: example.says,
        judgement: "neither",
      } satisfies Plan,
    },
    {
      name: "a contradiction its strict judgement doesn't uphold, whose parts can't be read",
      sentence: example.plain,
      quote: example.plainQuote,
      card: "nearest",
      word: "nearest",
      plan: {
        verdict: "contradicted",
        quote: example.plainQuote,
        says: example.says,
        judgement: "conflict",
        strict: { text: "neither" },
      } satisfies Plan,
    },
    {
      name: "a sentence with a figure whose other words the confirmation doesn't uphold",
      sentence: example.figure,
      quote: example.figureQuote,
      card: "framed",
      word: "framed",
      plan: { judgement: "neither", reply: figureReply(example, "contradicted") } satisfies Plan,
    },
    {
      name: "a sentence with a figure whose item is Unsupported and gives no words of its own",
      sentence: example.figure,
      quote: null,
      card: "plain",
      word: "reason",
      plan: { reply: figureReply(example, "unsupported") } satisfies Plan,
    },
  ] as const;

describe.each(CASES)("an Unsupported claim says why ($language)", (example) => {
  // protects=an Unsupported card carries the check's own explanation, a contradiction its confirmation didn't uphold says so first and quotes what it rested on, and a figure item without words of its own takes the reply's (#2184); fails_when=the explanation is dropped and the card has no reason, or the not-confirmed line shows on a card that isn't one
  test.each(SCENARIOS(example))(
    "$name: its card says why",
    async ({ sentence, plan, quote, card }) => {
      const { check } = await checkedInNote(example, sentence, plan);
      expect(check).toMatchObject({
        state: "unsupported",
        unsupported: { reason: example.says, found: true },
      });
      if (card === "framed")
        expect(check?.unsupported).toMatchObject({ unconfirmed: true, quoted: { quote } });
      // A nearest line the check found shows instead, as "your Documents say something different".
      else if (card === "nearest") {
        expect(check?.unsupported?.unconfirmed).toBe(true);
        expect(check?.evidence).not.toBeNull();
      } else expect(check?.unsupported?.unconfirmed).toBeUndefined();
    },
  );

  // protects=the Word comment of an Unsupported claim is never the bare line: a contradiction not upheld says a passage may say otherwise and gives the check's words, another reason gives its words, or the nearest line the check found (#2184); fails_when=the comment is "Unsupported by your Documents." or the not-confirmed line leads another reason
  test.each(SCENARIOS(example))(
    "$name: its Word comment says why",
    async ({ sentence, plan, word }) => {
      const { comments } = await checkedInNote(example, sentence, plan, true);
      expect(comments).not.toBe(example.bare);
      if (word === "framed") expect(comments).toBe(`${example.notConfirmed}${example.says}`);
      if (word === "reason") expect(comments).toBe(`${example.reasoned}${example.says}`);
      if (word === "nearest") expect(comments.startsWith(example.reasoned)).toBe(true);
    },
  );
});
