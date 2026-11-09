/**
 * A contradiction its confirmation doesn't uphold is Unsupported with something to say (#2184): it
 * keeps the check's own explanation and the quote it rested on, and its card and Word comment say a
 * Passage may say otherwise. Never a bare Unsupported, in English and Chinese, with figures or not.
 */
import { describe, expect, test } from "vitest";
import { exportLabels } from "../../src/core/exports/labels";
import {
  checkedInNote,
  checkingModel,
  type Plan,
  requestedFigures,
  SAME_DETAIL,
} from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
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
    comment: "Unsupported: a Passage may say otherwise, but the check couldn’t confirm it.",
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
    comment: "无依据：有段落的说法可能与此不同，但核对未能确认。",
  },
] as const;

async function checked(
  example: (typeof CASES)[number],
  claim: string,
  quote: string,
  judgement: Plan["judgement"],
) {
  const plans: Record<string, Plan> = {
    [claim]: { verdict: "contradicted", quote, says: example.says, judgement },
  };
  const { core } = await setUpWithDocuments(checkingModel(plans), [example.document]);
  await core.updateSettings({ user: { language: example.language } });
  return core.checkClaim({ claim });
}

/** Its figure agrees with the quote's number; the sentence is contradicted for its parties. */
function figureReply(example: (typeof CASES)[number]) {
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
      verdict: "supported",
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
        "Verdict: contradicted",
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

describe.each(CASES)("a contradiction not upheld ($language)", (example) => {
  // protects=a contradiction the confirmation calls about something else is Unsupported, keeping the check's explanation and its quote for the card (#2184); fails_when=the result has no reason and no quote, or reads Contradicted; no_claim=what a real model says.
  test("keeps the check's words and its quote", async () => {
    const result = await checked(example, example.plain, example.plainQuote, "neither");
    expect(result).toMatchObject({
      verdict: "unsupported",
      unsupported: {
        unconfirmed: true,
        found: true,
        reason: example.says,
        quoted: { quote: example.plainQuote, check: "found" },
      },
    });
  });

  // protects=checked figure by figure in a Note, a contradiction of the sentence's other words that the confirmation doesn't uphold is Unsupported with the check's explanation and its quote (#2184); fails_when=the sentence's card is bare or reads Contradicted; no_claim=what a real model says.
  test("with a figure, in a Note", async () => {
    const plans: Record<string, Plan> = {
      [example.figure]: { judgement: "neither", reply: figureReply(example) },
    };
    const setUp = await setUpWithDocuments(checkingModel(plans), [example.document]);
    await setUp.core.updateSettings({ user: { language: example.language } });
    const check = await checkedInNote(setUp, example.figure);
    setUp.core.close();
    expect(check?.figures?.map((figure) => figure.state)).toEqual(["supported"]);
    expect(check).toMatchObject({
      state: "unsupported",
      unsupported: {
        unconfirmed: true,
        reason: example.says,
        quoted: { quote: example.figureQuote },
      },
    });
  });

  // protects=an upheld contradiction stays Contradicted and is never marked as not confirmed (#2184); fails_when=a confirmed conflict reads Unsupported; no_claim=what a real model says.
  test("upheld, stays Contradicted", async () => {
    const result = await checked(example, example.plain, example.plainQuote, "conflict");
    expect(result).toMatchObject({
      verdict: "contradicted",
      evidence: { quote: example.plainQuote },
    });
  });

  // protects=the Word comment of a contradiction not upheld says a Passage may say otherwise, then the check's words, or the line alone with none (#2184); fails_when=it is the bare "Unsupported by your Documents."; no_claim=how Word shows it.
  test("its Word comment says so", () => {
    const labels = exportLabels(example.language);
    const sentence = {
      id: "s1",
      check: "unsupported" as const,
      scope: null,
      nearest: null,
      covers: null,
      citations: null,
      notFound: false,
      unconfirmed: true,
    };
    const separator = example.language === "en" ? " " : "";
    expect(labels.failedSentence({ ...sentence, reason: example.says })).toBe(
      `${example.comment}${separator}${example.says}`,
    );
    expect(labels.failedSentence({ ...sentence, reason: null })).toBe(example.comment);
  });
});
