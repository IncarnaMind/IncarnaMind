import { describe, expect, test } from "vitest";
import type { ClaimCheckResult } from "../../src/core";
import { readVerdict } from "../../src/core/answers/checks/prompt";
import { checkingModel, type Plan } from "../helpers/checks";
import { type SourceFile, setUpWithDocuments } from "../helpers/citations";

// Each Document has a line in the other language, so that either sentence's search finds it.
const REPORT: SourceFile = {
  name: "Report.md",
  contents: "The rate is 38.6%.\n比率是报告的比率。\n",
};
const CLAIM = "比率是 36.8%。";
const change = "Change 1: 36.8%\nTo 1: 38.6%";

async function checked(
  plan: Plan,
  language: "en" | "zh-CN",
  claim = CLAIM,
  files: readonly SourceFile[] = [REPORT],
): Promise<{ result: ClaimCheckResult }> {
  const { core } = await setUpWithDocuments(checkingModel({ [claim]: plan }), files);
  await core.updateSettings({ user: { language } });
  return { result: await core.checkClaim({ claim }) };
}

const saysOf = (result: ClaimCheckResult) =>
  result.verdict === "not-checked" ? undefined : result.says;

describe("A check reply's explanation (#2081)", () => {
  test("is its Explanation line, whatever line comes before it", () => {
    const read = readVerdict(
      [
        "Verdict: contradicted",
        "Topic: found",
        "Citation for marker 1: Passage P1, quote “The rate is 38.6%.”",
        "Explanation: 报告写的比率是 38.6%，不是 36.8%。 [^1]",
        "Evidence: [1]",
      ].join("\n"),
    );
    expect(read?.says).toBe("报告写的比率是 38.6%，不是 36.8%。");
  });
});

describe("A Contradicted card's explanation in the interface's language (#2081)", () => {
  test("one in another language is written again in the interface's, keeping its figures", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "The rate is 38.6%.",
        says: `The report gives the rate as 38.6%, not 36.8%.\n${change}`,
        restated: "报告写的比率是 38.6%，不是 36.8%。",
      },
      "zh-CN",
    );
    expect(result.verdict).toBe("contradicted");
    expect(saysOf(result)).toBe("报告写的比率是 38.6%，不是 36.8%。");
  });

  test("a rewrite that changes a figure is never shown: the correction's two values are", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "The rate is 38.6%.",
        says: `The report gives the rate as 38.6%, not 36.8%.\n${change}`,
        restated: "报告写的比率是 36.8%，不是 38.6%，约为 40%。",
      },
      "zh-CN",
    );
    expect(result.verdict).toBe("contradicted");
    expect(saysOf(result)).toBe("文档写的是“38.6%”，不是“36.8%”。");
  });

  test("a rewrite that swaps the Document's figure and the sentence's is never shown", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "The rate is 38.6%.",
        says: `The report gives the rate as 38.6%, not 36.8%.\n${change}`,
        restated: "报告写的比率是 36.8%，不是 38.6%。",
      },
      "zh-CN",
    );
    expect(saysOf(result)).toBe("文档写的是“38.6%”，不是“36.8%”。");
  });

  test("an unsupported reason rewritten with its figures swapped is none", async () => {
    const { result } = await checked(
      {
        verdict: "unsupported",
        says: "The report gives 38.6% for the first quarter, not for the second's 36.8%.",
        restated: "报告给出的是第二季度的 36.8%，不是第一季度的 38.6%。",
      },
      "zh-CN",
      "第二季度的比率是 36.8%。",
    );
    expect(result.verdict === "unsupported" && result.unsupported?.reason).toBeNull();
  });

  test("one in the interface's language is shown as it is, with no request", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "The rate is 38.6%.",
        says: `报告写的比率是 38.6%，不是 36.8%。\n${change}`,
      },
      "zh-CN",
    );
    expect(saysOf(result)).toBe("报告写的比率是 38.6%，不是 36.8%。");
  });

  test("one that names the check's workings gives way to the correction's two values", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "The rate is 38.6%.",
        says: `Citation 1 (P1): "The rate is 38.6%."\n${change}`,
      },
      "zh-CN",
    );
    expect(saysOf(result)).toBe("文档写的是“38.6%”，不是“36.8%”。");
  });

  test("an English card's Chinese explanation is written again in English", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "The rate is 38.6%.",
        says: `报告写的比率是 38.6%，不是 36.8%。\n${change}`,
        restated: "The report gives the rate as 38.6%, not 36.8%.",
      },
      "en",
      "The rate is 36.8%.",
    );
    expect(saysOf(result)).toBe("The report gives the rate as 38.6%, not 36.8%.");
  });
});

describe("An Unsupported card's reason in the interface's language (#2081)", () => {
  test("one in another language is written again in the interface's", async () => {
    const { result } = await checked(
      {
        verdict: "unsupported",
        says: "The report gives no rate for the second quarter.",
        restated: "报告没有写第二季度的比率。",
      },
      "zh-CN",
      "第二季度的比率是 36.8%。",
    );
    expect(result.verdict).toBe("unsupported");
    expect(result.verdict === "unsupported" && result.unsupported?.reason).toBe(
      "报告没有写第二季度的比率。",
    );
  });
});
