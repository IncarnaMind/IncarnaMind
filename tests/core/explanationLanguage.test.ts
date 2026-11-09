import { describe, expect, test } from "vitest";
import { explanationIn, explanationLanguage } from "../../src/core/answers/checks/explanations";

describe("The language a check's explanation is written in (#2081)", () => {
  test.each([
    // The issue's sentences: English grammar around Chinese labels and units is English.
    "The Document's table gives 2023 财年收入 as 1,180.4 百万英镑, i.e. 11.804 亿英镑, not 12.104 亿英镑.",
    "The document shows 哈尔登's 2024 财年营业利润 as 171.6 百万英镑 (即1.716亿英镑), not 1.786亿英镑.",
    "The Q3 results say gross margin was 38.6%, not 36.8%.",
    "The lease names 华信公司 as the tenant.",
    "The lease names 和记黄埔 as the tenant, not the guarantor.",
    "Net debt to EBITDA was 3.1 times, under the 3.5x cap.",
    "Not stated.",
  ])("English: %s", (text) => {
    expect(explanationLanguage(text)).toBe("en");
  });

  test.each([
    "哈尔登文件显示，2024 财年营业利润为 171.6 百万英镑，即 1.716 亿英镑，而非 1.786 亿英镑。",
    "第三季度业绩写的是毛利率 38.6%，不是 36.8%。",
    "Northwind Retail 第三季度的毛利率为 38.6%。",
    "季末净债务与 EBITDA 之比为 3.1 倍。",
    "文档写的是“The project budget was raised to 2.6 million pounds”，不是 240 万英镑。",
    "文件显示，项目预算已于2026年10月14日提高至260万英镑，而句子称预算为240万英镑。",
    "Bank of China 的贷款额度为 5 亿元。",
  ])("Chinese: %s", (text) => {
    expect(explanationLanguage(text)).toBe("zh-CN");
  });

  test.each([
    "171.6",
    "GBP 1,180.4m",
    "38.6%（Q3）",
    "",
    // A clause of each, as Claude Haiku 5.5 wrote one on main: no card's language.
    ", because the Document gives 2024 财年营业利润 as 171.6 百万英镑, not 1.786 亿英镑. 文件显示2024财年营业利润为171.6百万英镑，与句子所称1.786亿英镑不符。",
  ])("neither, when its grammar says nothing: %j", (text) => {
    expect(explanationLanguage(text)).toBeNull();
  });
});

describe("What a card shows of an explanation without asking again (#2081)", () => {
  test("a label before it is left out, and its language is the interface's", () => {
    expect(explanationIn("Sentence-level note: 文档显示收入为 1,180.4 百万英镑。", "zh-CN")).toBe(
      "文档显示收入为 1,180.4 百万英镑。",
    );
    expect(
      explanationIn("Simplified Chinese explanation: 文件称预算为 260 万英镑。", "zh-CN"),
    ).toBe("文件称预算为 260 万英镑。");
    expect(explanationIn("Document: The lease gives the rent as $14,250.", "en")).toBe(
      "The lease gives the rent as $14,250.",
    );
    expect(explanationIn("Then, for the Document: the lease gives $14,250.", "en")).toBe(
      "The lease gives $14,250.",
    );
    expect(explanationIn("Then, the lease gives the rent as $14,250.", "en")).toBe(
      "The lease gives the rent as $14,250.",
    );
    expect(explanationIn("Verdict note: 文件称预算为 260 万英镑。", "zh-CN")).toBe(
      "文件称预算为 260 万英镑。",
    );
  });

  test("one in the other language, or that names the check's workings, is none", () => {
    expect(
      explanationIn("The Document's table gives 2023 财年收入 as 1,180.4 百万英镑.", "zh-CN"),
    ).toBeNull();
    expect(explanationIn("第三季度业绩写的是毛利率 38.6%，不是 36.8%。", "en")).toBeNull();
    expect(
      explanationIn('Citation 1 (P1, §哈尔登年度数据): "2022 财年 | 1,142.0 | 151.2"', "zh-CN"),
    ).toBeNull();
    expect(explanationIn("Reason kind: none", "en")).toBeNull();
  });

  test("one with a clause of each is none", () => {
    expect(
      explanationIn(
        "文件显示营业利润为 171.6 百万英镑, because the Document gives it as 171.6, not 178.6.",
        "zh-CN",
      ),
    ).toBeNull();
  });

  test("one whose grammar says nothing is shown as it is", () => {
    expect(explanationIn("GBP 1,180.4m", "zh-CN")).toBe("GBP 1,180.4m");
  });
});
