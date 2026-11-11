import { describe, expect, test } from "vitest";
import { figuresInClaim } from "../../src/core/answers/checks/calculated";

const cases: { name: string; language: string; text: string; values: number[] }[] = [
  {
    name: "English citation list",
    language: "en",
    text: "See [2024] UKSC 5, 60; [2023] EWCA Civ 2, 10.",
    values: [],
  },
  {
    name: "Chinese citation list",
    language: "zh-CN",
    text: "参见 [2024] UKSC 5, 60；[2023] EWCA Civ 2, 10。",
    values: [],
  },
  {
    name: "English fact after the later reference",
    language: "en",
    text: "See [2024] UKSC 5, 60; [2023] EWCA Civ 2, 10 appeals succeeded.",
    values: [10],
  },
  {
    name: "Chinese fact after the later reference",
    language: "zh-CN",
    text: "参见 [2024] UKSC 5, 60；[2023] EWCA Civ 2, 10宗上诉获支持。",
    values: [10],
  },
  {
    name: "English fact before the later reference",
    language: "en",
    text: "Under [2024] UKSC 5, 60 appeals succeeded; see [2023] EWCA Civ 2, 10.",
    values: [60],
  },
  {
    name: "Chinese fact before the later reference",
    language: "zh-CN",
    text: "根据 [2024] UKSC 5, 60宗上诉获支持；参见 [2023] EWCA Civ 2, 10。",
    values: [60],
  },
  {
    name: "English facts after both references",
    language: "en",
    text: "Under [2024] UKSC 5, 60 appeals succeeded; under [2023] EWCA Civ 2, 10 appeals succeeded.",
    values: [60, 10],
  },
  {
    name: "Chinese facts after both references",
    language: "zh-CN",
    text: "根据 [2024] UKSC 5, 60宗上诉获支持；根据 [2023] EWCA Civ 2, 10宗上诉获支持。",
    values: [60, 10],
  },
  {
    name: "English decimal and integer facts",
    language: "en",
    text: "Under [2024] UKSC 5, 60.2 appeals succeeded; under [2023] EWCA Civ 2, 9 appeals succeeded.",
    values: [60.2, 9],
  },
  {
    name: "Chinese decimal and integer facts",
    language: "zh-CN",
    text: "根据 [2024] UKSC 5, 60.2宗上诉获支持；根据 [2023] EWCA Civ 2, 9宗上诉获支持。",
    values: [60.2, 9],
  },
  {
    name: "single closed pinpoint",
    language: "en",
    text: "See [2024] UKSC 5, 60.",
    values: [],
  },
  {
    name: "single factual quantity",
    language: "en",
    text: "Under [2024] UKSC 5, 60 of the appeals succeeded.",
    values: [60],
  },
];

describe("figures in a claim with case citations", () => {
  test.each(cases)("$name", ({ language, text, values }) => {
    const figures = figuresInClaim(text, { language });
    expect(figures.map((figure) => figure.value)).toEqual(values);
    for (const figure of figures) {
      expect(text.slice(figure.start, figure.end)).toBe(figure.chars);
    }
  });
});

describe("a count of periods is read whole, with the separators the figure reader follows (#2943)", () => {
  test.each([
    ["en", "It ran for 2,000 days.", "2,000 days", 2000, "day"],
    [undefined, "It ran for 2,000 days.", "2,000 days", 2000, "day"],
    ["en", "It ran for 1,250 weeks.", "1,250 weeks", 1250, "week"],
    ["en", "It ran for 12,000,000 years.", "12,000,000 years", 12_000_000, "year"],
    ["en", "It ran for 90 days.", "90 days", 90, "day"],
    ["en", "It ran for two thousand days.", "two thousand days", 2000, "day"],
    ["en", "It ran for 10 consecutive days.", "10 consecutive days", 10, "day"],
    ["en", "A 2,000-day ramp.", "2,000-day", 2000, "day"],
    ["en", "In 2,000 days it ended.", "2,000 days", 2000, "day"],
    ["en", "It ran for 2\u00a0000 days.", "2\u00a0000 days", 2000, "day"],
    ["en", "It ran for ２，０００ days.", "２，０００ days", 2000, "day"],
    ["en", "It ran for 2.5 years.", "2.5 years", 2.5, "year"],
    ["zh-CN", "它运行了2,000天。", "2,000天", 2000, "day"],
    ["zh-CN", "它运行了２，０００天。", "２，０００天", 2000, "day"],
    ["zh-CN", "它运行了2.5年。", "2.5年", 2.5, "year"],
  ])("%s: %s", (language, text, chars, value, word) => {
    expect(figuresInClaim(text, language ? { language } : {})).toMatchObject([
      { chars, value, unit: { kind: "other", word } },
    ]);
  });

  test("a year that is not a count is no count", () => {
    expect(figuresInClaim("In 2000 it ended.", { language: "en" })).toEqual([]);
  });
});

describe("the other ways of writing a count of periods (#2953)", () => {
  const read = (text: string, language: string) =>
    figuresInClaim(text, { language }).map(({ chars, value, unit }) => ({
      chars,
      value,
      word: unit.kind === "other" ? unit.word : unit.kind,
    }));

  /** A range as two figures: its last number first, then its first number, which only another range's first number matches. */
  const ends = (chars: string, values: number[], word: string) =>
    values.map((value, at) => ({ chars, value, word: at === 0 ? word : `${word} (near end)` }));

  test.each([
    ["en", "It ran for 3-5 days.", [5, 3], "3-5 days"],
    ["en", "It ran for 3 to 5 days.", [5, 3], "3 to 5 days"],
    ["en", "It ran for between 3 and 5 days.", [5, 3], "3 and 5 days"],
    ["en", "It ran for three to five days.", [5, 3], "three to five days"],
    ["en", "It ran for between three and five days.", [5, 3], "three and five days"],
    [
      "en",
      "It ran for between three hundred and four hundred days.",
      [400, 300],
      "three hundred and four hundred days",
    ],
    ["zh-CN", "它运行了3-5天。", [5, 3], "3-5天"],
    ["zh-CN", "它运行了三到五天。", [5, 3], "三到五天"],
  ])("a range is both its ends: %s: %s", (language, text, values, chars) => {
    expect(read(text, language)).toEqual(ends(chars, values, "day"));
  });

  test.each([
    ["zh-CN", "年龄22至59周岁的员工自动加入。", [59, 22], "22至59周岁", "year"],
    ["zh-CN", "公司成立5周年。", [5], "5周年", "year"],
    ["zh-CN", "项目历时3周。", [3], "3周", "week"],
  ])("周岁 and 周年 count years, not weeks: %s: %s", (language, text, values, chars, word) => {
    expect(read(text, language)).toEqual(ends(chars, values, word));
  });

  test.each([
    ["en", "It ran for between one and two years.", "one and two years"],
    ["en", "It ran for between 1 and 2 years.", "1 and 2 years"],
    ["zh-CN", "它运行了一到两年。", "一到两年"],
    ["zh-CN", "它运行了1到2年。", "1到2年"],
  ])("a range of years is both its ends: %s: %s", (language, text, chars) => {
    expect(read(text, language)).toEqual(ends(chars, [2, 1], "year"));
  });

  test.each([
    ["en", "You must reply within ten (10) days.", 10, "ten (10) days"],
    ["en", "You must reply within 30 (thirty) days.", 30, "30 (thirty) days"],
    ["en", "You must reply within ten (20) days.", Number.NaN, "ten (20) days"],
    ["zh-CN", "你须在三十（30）天内答复。", 30, "三十（30）天"],
    ["zh-CN", "你须在30（三十）天内答复。", 30, "30（三十）天"],
    ["zh-CN", "你须在三十（20）天内答复。", Number.NaN, "三十（20）天"],
  ])("words and figures: %s: %s", (language, text, value, chars) => {
    expect(read(text, language)).toEqual([{ chars, value, word: "day" }]);
  });

  test.each([
    ["en", "It ran for 2 000 days.", 2000, "2 000 days"],
    ["en", "It ran for 2 000 000 days.", 2_000_000, "2 000 000 days"],
  ])("a plain-space group: %s: %s", (language, text, value, chars) => {
    expect(read(text, language)).toEqual([{ chars, value, word: "day" }]);
  });

  test("a count beside a number that is not its own keeps both", () => {
    expect(read("Reply within 5 working days or 10 days.", "en")).toEqual([
      { chars: "5", value: 5, word: "plain" },
      { chars: "10 days", value: 10, word: "day" },
    ]);
  });

  test.each([
    ["en", "It lasted 1½ years.", 1.5, "1½ years", "year"],
    ["en", "It lasted 1 ½ years.", 1.5, "1 ½ years", "year"],
    ["en", "It lasted 1/2 year.", 0.5, "1/2 year", "year"],
    ["en", "It lasted 1 1/2 years.", 1.5, "1 1/2 years", "year"],
    ["en", "It lasted two and a half years.", 2.5, "two and a half years", "year"],
    ["en", "It lasted one-and-a-half years.", 1.5, "one-and-a-half years", "year"],
    ["zh-CN", "它持续了一年半。", 1.5, "一年半", "year"],
    ["zh-CN", "它持续了两年半。", 2.5, "两年半", "year"],
    ["zh-CN", "它持续了三个半月。", 3.5, "三个半月", "month"],
    ["zh-CN", "它持续了1½年。", 1.5, "1½年", "year"],
  ])("a fraction: %s: %s", (language, text, value, chars, word) => {
    expect(read(text, language)).toEqual([{ chars, value, word }]);
  });

  test.each([
    ["他有5年半导体行业经验。", "5年", 5],
    ["夜班有3天半夜里不能休息。", "3天", 3],
  ])("a 半 that starts a longer word is no half: %s", (text, chars, value) => {
    expect(read(text, "zh-CN")).toEqual([
      { chars, value, word: chars.endsWith("年") ? "year" : "day" },
    ]);
  });

  test.each([
    ["en", "Revenue grew in the 2024 year."],
    ["en", "Revenue grew in the 2024 year end."],
    ["en", "Revenue grew in the 2024 year-end results."],
    ["en", "Revenue grew in the Q3 2024 quarter."],
    ["en", "Revenue grew after a 2019 month-end close."],
    ["en", "Revenue grew at the twenty twenty-four year end."],
    ["en", "Revenue grew at the nineteen ninety-nine year-end."],
    ["en", "Revenue grew at the two thousand and twenty-four year end."],
  ])("a year that names a period is no count: %s: %s", (language, text) => {
    expect(read(text, language)).toEqual([]);
  });

  test("a count of years that is not a year stays a count", () => {
    expect(read("It ran for 2,024 years.", "en")).toEqual([
      { chars: "2,024 years", value: 2024, word: "year" },
    ]);
  });

  test.each([
    ["en", "It ran for a hundred days.", 100, "a hundred days", "day"],
    ["en", "It ran for a thousand years.", 1000, "a thousand years", "year"],
    ["en", "It ran for a hundred and twenty days.", 120, "a hundred and twenty days", "day"],
    ["en", "It ran for a dozen years.", 12, "a dozen years", "year"],
  ])("a round number in words: %s: %s", (language, text, value, chars, word) => {
    expect(read(text, language)).toEqual([{ chars, value, word }]);
  });

  test.each([
    "It ran for several hundred years.",
    "It followed the Hundred Days.",
    "It ran for a Hundred Days.",
  ])("an inexact or named one is no count: %s", (text) => {
    expect(read(text, "en")).toEqual([]);
  });

  test.each([[""], ["days"], ["The days ran on."], ["It ran for several days."]])(
    "a text with no count has none: %j",
    (text) => {
      expect(read(text, "en")).toEqual([]);
    },
  );

  test("a count too big for a double has no value", () => {
    expect(read("It ran for 99999999999999999999 days.", "en")).toEqual([
      { chars: "99999999999999999999 days", value: Number.NaN, word: "day" },
    ]);
  });

  test.each([
    ["zh-CN", "你须在三十（３０）天内答复。", [30], "三十（３０）天"],
    ["en", "You must reply within ten（10） days.", [10], "ten（10） days"],
    ["zh-CN", "它运行了３-５天。", [5, 3], "３-５天"],
  ])("full-width digits and brackets: %s: %s", (language, text, values, chars) => {
    expect(read(text, language)).toEqual(ends(chars, values, "day"));
  });

  test("a sentence with two periods reads each", () => {
    expect(read("It ran for 3-5 days and 2 months, then ten (10) days.", "en")).toEqual([
      ...ends("3-5 days", [5, 3], "day"),
      { chars: "2 months", value: 2, word: "month" },
      { chars: "ten (10) days", value: 10, word: "day" },
    ]);
    expect(read("Reply within 30 (thirty) days or 60 (sixty) days.", "en")).toEqual([
      { chars: "30 (thirty) days", value: 30, word: "day" },
      { chars: "60 (sixty) days", value: 60, word: "day" },
    ]);
  });

  test.each(["It ran for 1e3 days.", "It ran for 1.5E+3 days."])(
    "a count in scientific notation has no value: %s",
    (text) => {
      expect(read(text, "en")).toEqual([
        { chars: text.slice(11, -1), value: Number.NaN, word: "day" },
      ]);
    },
  );

  test.each([
    [
      "en",
      "Days sales outstanding rose 20% to 45 days.",
      [
        ["20%", 0.2, "percent"],
        ["45 days", 45, "day"],
      ],
    ],
    ["en", "The notice period was reduced in 2023 to 30 days.", [["30 days", 30, "day"]]],
    [
      "zh-CN",
      "应收账款周转天数增加5%至60天。",
      [
        ["5%", 0.05, "percent"],
        ["60天", 60, "day"],
      ],
    ],
    [
      "zh-CN",
      "它运行了3至5天。",
      [
        ["3至5天", 5, "day"],
        ["3至5天", 3, "day (near end)"],
      ],
    ],
  ])(
    'a number before a range\'s "to" that is no count stays what it is: %s: %s',
    (language, text, expected) => {
      expect(read(text, language)).toEqual(
        expected.map(([chars, value, word]) => ({ chars, value, word })),
      );
    },
  );

  test.each([
    ["en", "It lasted two years and a half.", 2.5, "two years and a half", "year"],
    ["en", "It lasted 2 years and a half.", 2.5, "2 years and a half", "year"],
    ["en", "It lasted one year and a half.", 1.5, "one year and a half", "year"],
    ["en", "It lasted a year and a half.", 1.5, "a year and a half", "year"],
    ["en", "It lasted a day and a half.", 1.5, "a day and a half", "day"],
  ])('"and a half" after the unit: %s: %s', (language, text, value, chars, word) => {
    expect(read(text, language)).toEqual([{ chars, value, word }]);
  });

  test.each([
    ["zh-CN", "5/6月销售额增长。", []],
    ["zh-CN", "3/4季度业绩好转。", []],
    ["zh-CN", "第3季度增长。", []],
    ["zh-CN", "它持续了3/4个月。", [["3/4个月", 0.75, "month"]]],
    ["zh-CN", "连续3季度增长。", [["3季度", 3, "quarter"]]],
  ])("a slash before 月 or 季度 names months or quarters: %s: %s", (language, text, expected) => {
    expect(read(text, language)).toEqual(
      expected.map(([chars, value, word]) => ({ chars, value, word })),
    );
  });

  test.each([
    ["近三年半数以上的收入来自海外。", "三年", 3],
    ["公司有3年半成品生产经验。", "3年", 3],
  ])("a 半 that starts 半数 or 半成品 is no half: %s", (text, chars, value) => {
    expect(read(text, "zh-CN")).toEqual([{ chars, value, word: "year" }]);
  });

  test.each([
    ["乙方应在30日内付款。", "30日", 30],
    ["乙方应在30日以内付款。", "30日", 30],
    ["乙方应在30日之内付款。", "30日", 30],
    ["乙方应在三十日内付款。", "三十日", 30],
    ["乙方应在5月1日起30日内付款。", "30日", 30],
    ["乙方逾期超过三十日的，甲方有权解除合同。", "三十日", 30],
    ["通知期不少于30日。", "30日", 30],
    ["通知期不超过30日。", "30日", 30],
    ["合同满30日后自动终止。", "30日", 30],
    ["期限为30日以上。", "30日", 30],
    ["期限为30日以下。", "30日", 30],
    ["乙方应在30天内付款。", "30天", 30],
  ])("a number and 日 before 内 is a count of days: %s", (text, chars, value) => {
    expect(read(text, "zh-CN")).toEqual([{ chars, value, word: "day" }]);
  });

  test.each([
    ["它持续了三个季度。", "三个季度", 3],
    ["它持续了3个季度。", "3个季度", 3],
    ["前两个季度收入增长。", "两个季度", 2],
  ])("a number before 个季度 is a count of quarters: %s", (text, chars, value) => {
    expect(read(text, "zh-CN")).toEqual([{ chars, value, word: "quarter" }]);
  });

  test("the third quarter by its position is no count", () => {
    expect(read("第3个季度收入增长。", "zh-CN")).toEqual([]);
  });

  test.each([
    "乙方应在5月30日内付款。",
    "乙方应在每月5日内付款。",
    "乙方应于30日付款。",
    "乙方应在每月30日前付款。",
    "乙方应在30个工作日内付款。",
  ])("a day of a month, and working days, are no count of days: %s", (text) => {
    expect(read(text, "zh-CN")).toEqual([]);
  });

  test.each([
    ["zh-CN", "金额单位为人民币千元，买方须在30日内支付每张发票。", "30日", 30, "day"],
    ["zh-CN", "单位：万元。按这两个季度数据计算。", "两个季度", 2, "quarter"],
    [
      "en",
      "Amounts are in thousands of pounds. Payment is due within 30 days.",
      "30 days",
      30,
      "day",
    ],
  ])(
    "a unit the sentence states for its amounts does not make a count unreadable: %s",
    (language, text, chars, value, word) => {
      expect(read(text, language)).toEqual([{ chars, value, word }]);
    },
  );

  test.each([
    ["en", "The city has a 2000 year history.", "2000 year", 2000],
    ["en", "The city has a two thousand year history.", "two thousand year", 2000],
    ["en", "The dynasty had a 2000-year reign.", "2000-year", 2000],
    ["en", "It is a 2000 year old tree.", "2000 year", 2000],
    ["en", "Revenue grew in the 2024 year results.", "2024 year", 2024],
  ])(
    'a year before "year" that describes what follows is a count: %s: %s',
    (language, text, chars, value) => {
      expect(read(text, language)).toEqual([{ chars, value, word: "year" }]);
    },
  );
});

describe.each([
  {
    language: "en",
    conjunctions: ["and", "or", "&", "and/or"],
    prefix: "See",
    factual: " appeals succeeded",
  },
  {
    language: "zh-CN",
    conjunctions: ["与", "及", "和", "或"],
    prefix: "参见",
    factual: "宗上诉获支持",
  },
])("$language citation-list conjunctions", ({ language, conjunctions, prefix, factual }) => {
  const linked = conjunctions.flatMap((conjunction) => [
    {
      name: `${conjunction}: closed pinpoints`,
      text: `${prefix} [2024] UKSC 5, 60 ${conjunction} [2023] EWCA Civ 2, 10.`,
      values: [],
    },
    {
      name: `${conjunction}: fact before the later reference`,
      text: `${prefix} [2024] UKSC 5, 60${factual} ${conjunction} [2023] EWCA Civ 2, 10.`,
      values: [60],
    },
    {
      name: `${conjunction}: fact after the later reference`,
      text: `${prefix} [2024] UKSC 5, 60 ${conjunction} [2023] EWCA Civ 2, 10${factual}.`,
      values: [10],
    },
    {
      name: `${conjunction}: facts after both references`,
      text: `${prefix} [2024] UKSC 5, 60${factual} ${conjunction} [2023] EWCA Civ 2, 10${factual}.`,
      values: [60, 10],
    },
  ]);

  test.each(linked)("$name", ({ text, values }) => {
    expect(figuresInClaim(text, { language }).map((figure) => figure.value)).toEqual(values);
  });
});
