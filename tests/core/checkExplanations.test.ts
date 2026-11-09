import { describe, expect, test } from "vitest";
import type { ClaimCheckResult, ClaimJudgment } from "../../src/core";
import { explainedIn } from "../../src/core/answers/checks/explanations";
import { readVerdict } from "../../src/core/answers/checks/prompt";
import type { PreparedChatModel } from "../../src/core/providers/chat";
import { emptyFigureFinding } from "../../src/shared/figureChecks";
import { readFigures } from "../../src/shared/figures";
import { checkingModel, type Plan } from "../helpers/checks";
import { type SourceFile, setUpWithDocuments } from "../helpers/citations";
import { restatedAsQuoted, scriptedModel } from "../helpers/models";

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

describe("A bare figure in the Document is worth what its Document says (#2081)", () => {
  const wordings = (result: ClaimCheckResult) =>
    result.verdict === "contradicted"
      ? result.correction?.choices.map((choice) => choice.wording)
      : undefined;

  test("a bare figure takes no scale from the sentence", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "Operating profit was 151.2.",
        says: "报告写的营业利润是 151.2 百万英镑，不是 1.402 亿英镑。\nChange 1: 1.402 亿英镑\nTo 1: Operating profit was 151.2",
      },
      "zh-CN",
      "营业利润为 1.402 亿英镑。",
      [
        {
          name: "Annual report.md",
          contents: "All figures in £ million.\nOperating profit was 151.2.\n营业利润见上。\n",
        },
      ],
    );
    // Its Document states £ million: 151.2 is £151.2 million, which is 1.512 亿英镑.
    expect(wordings(result)).toEqual(["1.512 亿英镑"]);
  });

  test("and none the other way", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "营业利润为 151.2。",
        says: "The report gives operating profit as 151.2 in £ million, not £140.2 million.\nChange 1: £140.2 million\nTo 1: 营业利润为 151.2",
      },
      "en",
      "Operating profit was £140.2 million.",
      [
        {
          name: "年报.md",
          contents: "单位：百万英镑。\n营业利润为 151.2。\nOperating profit is above.\n",
        },
      ],
    );
    expect(wordings(result)).toEqual(["£151.2 million"]);
  });

  test.each([
    {
      language: "zh-CN" as const,
      claim: "营业利润为 1.402 亿英镑。",
      to: "Operating profit was 151.2",
      contents: "Operating profit was 151.2.\n营业利润见上。\n",
    },
    {
      language: "en" as const,
      claim: "Operating profit was £140.2 million.",
      to: "151.2",
      contents: "Operating profit was 151.2.\n",
    },
  ])(
    "a bare figure whose Document states no scale is no fix, in $language",
    async ({ language, claim, to, contents }) => {
      const { result } = await checked(
        {
          verdict: "contradicted",
          quote: "Operating profit was 151.2.",
          says: `The report gives operating profit as 151.2.\nChange 1: ${claim.includes("亿") ? "1.402 亿英镑" : "£140.2 million"}\nTo 1: ${to}`,
        },
        language,
        claim,
        [{ name: "Annual report.md", contents }],
      );
      expect(result.verdict).toBe("contradicted");
      // Never the sentence's unit dropped ("营业利润为 151.2。") or a millionth of the amount.
      expect(wordings(result)).toBeUndefined();
    },
  );

  test("a bare figure in the sentence's language under a stated scale keeps the sentence's unit", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "Operating profit was 151.2.",
        says: "The report gives operating profit as £151.2 million.\nChange 1: £140.2 million\nTo 1: 151.2",
      },
      "en",
      "Operating profit was £140.2 million.",
      [
        {
          name: "Annual report.md",
          contents: "All figures in £ million.\nOperating profit was 151.2.\n",
        },
      ],
    );
    expect(wordings(result)).toEqual(["£151.2 million"]);
  });

  test("a table's cell under a heading that states its scale is written in the sentence's", async () => {
    const { result } = await checked(
      {
        verdict: "contradicted",
        quote: "2024 财年 | 1,226.7 | 171.6",
        says: "哈尔登表格写的 2024 财年营业利润是 171.6 百万英镑。\nChange 1: 1.786 亿英镑\nTo 1: 171.6",
      },
      "zh-CN",
      "2024 财年营业利润增至 1.786 亿英镑。",
      [
        {
          name: "哈尔登.md",
          contents:
            "# 哈尔登年度数据\n\n| 年度 | 收入（百万英镑） | 营业利润（百万英镑） |\n|---|---|---|\n| 2023 财年 | 1,180.4 | 160.9 |\n| 2024 财年 | 1,226.7 | 171.6 |\n",
        },
      ],
    );
    expect(wordings(result)).toEqual(["1.716 亿英镑"]);
  });
});

describe("A sentence checked figure by figure (#2081)", () => {
  const judged = (verdict: "contradicted" | "unsupported", said: string): ClaimJudgment => ({
    verdict,
    evidence: null,
    says: verdict === "contradicted" ? said : null,
    unsupported:
      verdict === "unsupported" ? { reason: said, covered: null, uncovered: null } : null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    versions: [],
    excluded: [],
  });
  // The rewrite a model on this computer gives, quoted inside a Chinese sentence.
  const model = {
    model: scriptedModel(() => ({ text: "" }), {
      generate: (call) => ({ text: restatedAsQuoted(call) }),
    }),
    capabilities: { facts: { temperature: 0 } },
  } as unknown as PreparedChatModel;

  test("has each figure's and the rest's explanation in the interface's language, as its card shows one in its place", async () => {
    const [reading] = readFigures("营业利润为 1.786 亿英镑。");
    if (!reading) throw new Error("No figure read.");
    const figure = emptyFigureFinding({
      id: "F1",
      locator: {
        kind: "text",
        from: { blockId: "b", offset: 6 },
        to: { blockId: "b", offset: 15 },
      },
      reading,
      calculated: null,
    });
    const result: ClaimCheckResult = {
      ...judged("contradicted", "报告写的营业利润是 1.716 亿英镑。"),
      figures: [
        { ...figure, result: judged("contradicted", "The table gives 171.6 million, not 178.6.") },
      ],
      remainder: judged("unsupported", "The report says nothing of the trend."),
    };
    const explained = await explainedIn(result, {
      language: "zh-CN",
      model,
      signal: new AbortController().signal,
    });
    expect(saysOf(explained)).toBe("报告写的营业利润是 1.716 亿英镑。");
    expect(explained.figures?.[0]?.result).toMatchObject({
      says: "文档写的是：“The table gives 171.6 million, not 178.6.”",
    });
    expect(explained.remainder).toMatchObject({
      unsupported: { reason: "文档写的是：“The report says nothing of the trend.”" },
    });
  });
});
