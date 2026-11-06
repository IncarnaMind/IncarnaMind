import { describe, expect, test } from "vitest";
import { documentFigureContext } from "../../src/core/answers/calculations";
import { namingHolds } from "../../src/core/answers/checks/analysisNaming";
import type { CheckFigure } from "../../src/core/api";
import { readFigures } from "../../src/shared/figures";

/*
 * The filter on the claim judge's "same" for an Analysis's figure (#2378): it only ever takes
 * Supported away. Each case is a sentence as Check reads it, the figure's shown number in it.
 */

interface Given {
  label: string;
  siblings?: string[];
  how?: "sum" | "mean" | "min" | "max" | "count";
  /** A table cell's row and column headings. */
  headings?: string;
}

function figureIn(
  sentence: string,
  shown: string,
  given: Given,
  id = "f1",
  after = 0,
): CheckFigure {
  const [reading] = readFigures(shown, documentFigureContext([{ text: shown }]));
  if (!reading) throw new Error(`No figure in ${shown}`);
  const at = sentence.indexOf(shown, after);
  return {
    id,
    locator: {
      kind: "text",
      from: { blockId: "b", offset: at },
      to: { blockId: "b", offset: at + 1 },
    },
    reading,
    calculated: null,
    ...(given.headings !== undefined && { label: given.headings }),
    analysisRecord: {
      recalculated: true,
      citations: [],
      label: given.label,
      of: given.how
        ? { input: "orders", columns: ["amount"], rows: [[2, 41]], count: 40, how: given.how }
        : null,
      code: "",
    },
  };
}

const holds = (sentence: string, shown: string, given: Given) => {
  const figure = figureIn(sentence, shown, given);
  return namingHolds(sentence, figure, [figure]);
};

describe("a figure's own clause names it", () => {
  test.each([
    ["Central's total amount is 8,325.", "Total amount, Central"],
    ["The total amount for Central came to 8,325.", "Total amount, Central"],
    ["The revenue by region came to 9,450.", "Revenue by region"],
    ["UK revenue is 9,450.", "Revenue, UK"],
    ["Q3 revenue was 9,450.", "Revenue Q3"],
    ["The total visits came to 48.", "Total visit"],
    ["中部地区金额合计为 8,325。", "中部地区金额合计"],
    ["中部地区的金额合计为 8,325。", "中部地区金额合计"],
  ])("%s, for %s", (sentence, label) => {
    const shown = [...sentence.matchAll(/\d[\d,]*/gu)].map(([each]) => each).at(-1) ?? "";
    expect(holds(sentence, shown, { label })).toBe(true);
  });

  test("in a table, its cell's row and column headings count", () => {
    expect(holds("48 次", "48", { label: "就诊次数", headings: "就诊次数 · 结果" })).toBe(true);
    expect(
      holds("8,325", "8,325", { label: "Total amount", headings: "Total amount · Value" }),
    ).toBe(true);
    expect(holds("48 次", "48", { label: "就诊次数" })).toBe(false);
  });

  test("a group set off by a comma before its figure is still the figure's own", () => {
    expect(
      holds("For Central, the total amount is 8,325.", "8,325", { label: "Total amount, Central" }),
    ).toBe(true);
    expect(holds("中部地区，金额合计为 8,325。", "8,325", { label: "中部地区金额合计" })).toBe(
      true,
    );
  });
});

describe("a label's short words and Han words are read whole", () => {
  test("a word of one or two letters only in its own case, a Han word only as its own two characters", () => {
    expect(holds("UK revenue is 9,450.", "9,450", { label: "Revenue, UK" })).toBe(true);
    expect(holds("uk revenue is 9,450.", "9,450", { label: "Revenue, UK" })).toBe(false);
    expect(holds("东部金额合计为 8,325。", "8,325", { label: "东部金额合计" })).toBe(true);
    expect(holds("部东金额合计为 8,325。", "8,325", { label: "东部金额合计" })).toBe(false);
  });
});

describe("words set off from the figure by a comma are read as its own", () => {
  test.each([
    ["This quarter, the total amount from Central is 8,325.", "Total amount, Central", [], null],
    ["In North, the total amount was 8,325.", "Total amount", ["North"], null],
    ["After discounts, West's average amount is 8,325.", "Average amount, West", [], "mean"],
    ["Central's total amount is 8,325, after refunds.", "Total amount, Central", [], null],
    ["本季度，中部地区金额合计达到 8,325。", "中部地区金额合计", [], null],
    ["北部地区，金额合计为 8,325。", "金额合计", ["北部地区"], null],
  ] as const)("%s", (sentence, label, siblings, how) => {
    expect(holds(sentence, "8,325", { label, siblings: [...siblings], ...(how && { how }) })).toBe(
      false,
    );
  });

  test("between two figures, the words after the first one's break are the second one's", () => {
    const sentence =
      "Central's total amount is 9,450; after refunds, North's total amount is 8,700.";
    const central = figureIn(sentence, "9,450", { label: "Total amount, Central" }, "c");
    const north = figureIn(sentence, "8,700", { label: "Total amount, North" }, "n");
    expect(namingHolds(sentence, central, [central, north])).toBe(true);
    expect(namingHolds(sentence, north, [central, north])).toBe(false);
  });
});

describe("a cell's headings are read as its words are", () => {
  test("a row heading that names another figure of the run, or a word its label lacks", () => {
    const total = { label: "Total amount", siblings: ["North", "South"] };
    expect(holds("8,325", "8,325", { ...total, headings: "North · Total amount" })).toBe(false);
    expect(holds("8,325", "8,325", { ...total, headings: "Change · Total amount" })).toBe(false);
    expect(holds("8,325", "8,325", { ...total, headings: "Total amount" })).toBe(true);
    expect(holds("8,325", "8,325", { label: "金额合计", headings: "变化 · 金额合计" })).toBe(false);
    expect(holds("8,325", "8,325", { label: "金额合计", headings: "金额合计 · 数值" })).toBe(true);
  });
});

describe("a figure is placed among all of its sentence's figures", () => {
  const sentence = "Central's total amount is 600, North's total amount is 600.";
  const label = { label: "Total amount, Central" };

  test("a typed number with the same digits before it never takes its place", () => {
    const typed = { ...figureIn(sentence, "600", label, "typed"), analysisRecord: undefined };
    const analysed = figureIn(sentence, "600", label, "f1", sentence.indexOf("North"));
    expect(namingHolds(sentence, analysed, [typed, analysed])).toBe(false);
    const first = figureIn(sentence, "600", label, "f1");
    const second = {
      ...figureIn(sentence, "600", label, "typed", sentence.indexOf("North")),
      analysisRecord: undefined,
    };
    expect(namingHolds(sentence, first, [first, second])).toBe(true);
  });

  test("a number before it Check doesn't read leaves the figure's own digits in its clause", () => {
    const analysed = figureIn(sentence, "600", label, "f1", sentence.indexOf("North"));
    expect(namingHolds(sentence, analysed, [analysed])).toBe(false);
  });
});

describe("a clause that can't stand as naming the figure", () => {
  test.each([
    ["a word of its label left out", "North's total amount is 9,450.", "Total amount, South"],
    [
      "a word found only inside another",
      "Central's subtotal amount is 8,325.",
      "Total amount, Central",
    ],
    ["another short code", "US revenue is 9,450.", "Revenue, UK"],
    ["another variant", "Variant B's conversion is 9,450.", "Conversion, variant A"],
    ["another quarter", "Q4 revenue was 9,450.", "Revenue Q3"],
    ["another year", "Revenue in 2025 was 9,450.", "Revenue 2026"],
    ["its own digits for a name", "Store four's total amount is 9,450.", "Total amount, store 9"],
    [
      "its label's name said only outside its clause",
      "Unlike South, North's total amount is 9,450.",
      "Total amount, South",
    ],
    ["a Han word inside another", "东南部金额合计为 9,450。", "东部金额合计"],
    ["a region inside another's name", "华中部地区金额合计为 9,450。", "中部地区金额合计"],
    ["a region inside another's name", "东北部地区金额合计为 9,450。", "北部地区金额合计"],
    ["a negation", "North's total amount is not 9,450.", "Total amount, North"],
    ["a comparison", "North's total amount is below 9,450.", "Total amount, North"],
    ["a Chinese negation", "北部地区金额合计不是 9,450。", "北部地区金额合计"],
    ["a Chinese comparison", "北部地区金额合计低于 9,450。", "北部地区金额合计"],
  ])("%s: %s", (_kind, sentence, label) => {
    expect(holds(sentence, "9,450", { label })).toBe(false);
  });

  test("another of the run's figures named in its clause", () => {
    const given = { label: "Total amount, South", siblings: ["Total amount, North"] };
    expect(holds("North's total amount of 9,450 is ahead of South's.", "9,450", given)).toBe(false);
    expect(
      holds("与南部地区相比，北部地区金额合计为 9,450。", "9,450", {
        label: "南部地区金额合计",
        siblings: ["北部地区金额合计"],
      }),
    ).toBe(false);
  });

  test("a word for another way of working it out", () => {
    for (const [sentence, label] of [
      ["North's average revenue is 9,450.", "Revenue, North"],
      ["北部平均收入为 9,450。", "北部收入"],
    ] as const)
      expect(holds(sentence, "9,450", { label, how: "sum" })).toBe(false);
    expect(
      holds("North's total revenue is 9,450.", "9,450", { label: "Revenue, North", how: "sum" }),
    ).toBe(true);
  });

  test("a word that makes it another quantity than its label's", () => {
    for (const [sentence, label] of [
      ["West's total net amount is 9,075.", "Total amount, West"],
      ["West's total amount per order is 9,075.", "Total amount, West"],
      ["West's daily total amount is 9,075.", "Total amount, West"],
      ["西部地区净金额合计为 9,075。", "西部地区金额合计"],
      ["西部地区每笔订单的金额合计为 9,075。", "西部地区金额合计"],
    ] as const)
      expect(holds(sentence, "9,075", { label, how: "sum" })).toBe(false);
    // A word no label, Analysis or linking word accounts for leaves it unchecked, right or not.
    expect(
      holds("West's average amount per order is 907.5.", "907.5", {
        label: "Average amount, West",
        how: "mean",
      }),
    ).toBe(false);
    expect(
      holds("West's average amount is 907.5.", "907.5", {
        label: "Average amount, West",
        how: "mean",
      }),
    ).toBe(true);
  });

  test("any word no label, Analysis or linking word accounts for: a period, a change, a rate", () => {
    for (const [sentence, label, how] of [
      ["Central's total amount in its first week was 8,325.", "Total amount, Central", "sum"],
      ["North's highest amount for a single day was 8,325.", "Highest amount, North", "max"],
      ["West's average amount rose to 8,325.", "Average amount, West", "mean"],
      ["West's total amount fell short of 8,325.", "Total amount, West", "sum"],
      ["中部地区第一周的金额合计为 8,325。", "中部地区金额合计", "sum"],
      ["北部地区单日最高金额为 8,325。", "北部地区最高金额", "max"],
      ["北部地区每位客户的平均金额为 8,325。", "北部地区平均金额", "mean"],
    ] as const)
      expect(holds(sentence, "8,325", { label, how })).toBe(false);
  });

  test("two figures each under the other's words, and each in its own clause", () => {
    const sentence = "South trails North: North's total amount is 9,450, South's is 8,700.";
    const south = figureIn(sentence, "9,450", { label: "Total amount, South" }, "s");
    const north = figureIn(sentence, "8,700", { label: "Total amount, North" }, "n");
    expect(namingHolds(sentence, south, [south, north])).toBe(false);
    expect(namingHolds(sentence, north, [south, north])).toBe(false);
    const right = "North's total amount is 9,450, and South's total amount is 8,700.";
    const n = figureIn(right, "9,450", { label: "Total amount, North" }, "n");
    const s = figureIn(right, "8,700", { label: "Total amount, South" }, "s");
    expect(namingHolds(right, n, [n, s])).toBe(true);
    expect(namingHolds(right, s, [n, s])).toBe(true);
  });

  test("a label with no word to read never stands", () => {
    expect(holds("It came to 9,450.", "9,450", { label: "" })).toBe(false);
  });
});
