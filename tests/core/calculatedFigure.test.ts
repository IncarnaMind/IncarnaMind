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
