/**
 * A contradiction its confirmation doesn't uphold is Unsupported with something to say (#2184): it
 * keeps the check's own explanation and the quote it rested on, and its card and Word comment say a
 * Passage may say otherwise. Never a bare Unsupported, in English and Chinese, with figures or not.
 */
import { describe, expect, test } from "vitest";
import { exportLabels } from "../../src/core/exports/labels";
import { checkingModel, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";

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
    says: "协议写的是由另一方负责。",
    comment: "无依据：有段落的说法可能与此不同，但检查未能确认。",
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

describe.each(CASES)("a contradiction not upheld ($language)", (example) => {
  // protects=a contradiction the confirmation calls about something else is Unsupported, keeping the check's explanation and its quote for the card (#2184); fails_when=the result has no reason and no quote, or reads Contradicted; no_claim=what a real model says.
  test("keeps the check's words and its quote, without figures and with", async () => {
    for (const [claim, quote] of [
      [example.plain, example.plainQuote],
      [example.figure, example.figureQuote],
    ] as const) {
      const result = await checked(example, claim, quote, "neither");
      expect(result, claim).toMatchObject({
        verdict: "unsupported",
        unsupported: {
          unconfirmed: true,
          found: true,
          reason: example.says,
          quoted: { quote, check: "found" },
        },
      });
    }
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
