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
