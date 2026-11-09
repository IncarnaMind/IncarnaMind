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

  test("is never a Reason kind line, whatever it gives", () => {
    const read = readVerdict(
      [
        "Verdict: contradicted",
        "Topic: found",
        "Reason kind: none",
        "报告写的比率是 38.6%，不是 36.8%。 [^1]",
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

describe("A figure contradicted by a quote in another language (#2081)", () => {
  const NOTES: SourceFile = {
    name: "Steering group notes.md",
    contents:
      "The project budget was raised to 2.6 million pounds on 14 October 2026.\n海港项目的预算见上。\n",
  };
  test("is corrected with the Document's amount, written as the sentence writes its own", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "The project budget was raised to 2.6 million pounds on 14 October 2026.",
        says: "文件显示，项目预算提高到了 260 万英镑，不是 240 万英镑。\nChange 1: 二百四十万英镑\nTo 1: 2.6 million pounds",
      },
      "zh-CN",
      "海港项目的预算为二百四十万英镑。",
      [NOTES],
    );
    expect(result.verdict).toBe("contradicted");
    expect(result.verdict === "contradicted" && result.correction).toMatchObject({
      from: "二百四十万英镑",
      choices: [{ wording: "260万英镑", evidence: { documentName: "Steering group notes" } }],
    });
  });

  test("is corrected in English from a Chinese quote", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "项目预算于 2026 年 10 月 14 日提高到 260 万英镑。",
        says: "The notes give the budget as 2.6 million pounds, not 2.4 million.\nChange 1: £2.4 million\nTo 1: 260 万英镑",
      },
      "en",
      "The harbour project's budget is £2.4 million.",
      [
        {
          name: "督导组纪要.md",
          contents:
            "项目预算于 2026 年 10 月 14 日提高到 260 万英镑。\nThe harbour project's budget is above.\n",
        },
      ],
    );
    expect(result.verdict).toBe("contradicted");
    expect(result.verdict === "contradicted" && result.correction?.choices).toMatchObject([
      { wording: "£2.6 million" },
    ]);
  });

  test("has no correction when the quote's figure is of another unit", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "The harbour moved 2.6 million tonnes in 2026.",
        says: "文件写的是 260 万吨。\nChange 1: 二百四十万英镑\nTo 1: 2.6 million tonnes",
      },
      "zh-CN",
      "海港项目的预算为二百四十万英镑。",
      [
        {
          name: "Harbour notes.md",
          contents: "The harbour moved 2.6 million tonnes in 2026.\n海港项目的预算见上。\n",
        },
      ],
    );
    expect(result.verdict === "contradicted" && result.correction).toBeFalsy();
  });
});
