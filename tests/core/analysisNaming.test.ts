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
      siblings: given.siblings ?? [],
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
    ["Revenue for each region is 9,450.", "Revenue by region"],
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
    expect(holds("48 次", "48", { label: "就诊次数" })).toBe(false);
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
