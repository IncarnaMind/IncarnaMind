import { describe, expect, test, vi } from "vitest";
import { documentFigureContext } from "../../src/core/answers/calculations";
import { namingHolds } from "../../src/core/answers/checks/analysisNaming";
import type { CheckFigure } from "../../src/core/api";
import { readFigures } from "../../src/shared/figures";

vi.mock(import("../../src/shared/figures"), async (importOriginal) => {
  const reader = await importOriginal();
  return {
    ...reader,
    readFigures: (text, context) => {
      if (text.includes("GARBLED"))
        throw new reader.FiguresNotRead(text, new RangeError("Maximum call stack size exceeded"));
      return reader.readFigures(text, context);
    },
  };
});

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
  /** The figure's unit as the Analysis gave it, and its words for its input and columns. */
  unit?: string;
  vocabulary?: readonly string[];
  /** The heading above the sentence, and the lines above it in its section. */
  heading?: string;
  above?: string;
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
      ...(given.vocabulary && { vocabulary: [...given.vocabulary] }),
      ...(given.unit !== undefined && { unit: given.unit }),
      ...(given.heading !== undefined && { heading: given.heading }),
      ...(given.above !== undefined && { above: given.above }),
    },
  };
}

const holds = (sentence: string, shown: string, given: Given, paragraph = sentence) => {
  const figure = figureIn(sentence, shown, given);
  return namingHolds(sentence, figure, [figure], paragraph);
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

describe("what a sentence says of its figure besides its name (#2544)", () => {
  const vocabulary = ["orders", "amount"];
  const north = { label: "Total amount, North", how: "sum", vocabulary } as const;
  const zhNorth = { label: "北部地区金额合计", how: "sum", vocabulary } as const;

  test("a sign or symbol the Analysis's words don't hold, in the clause or a cell's headings", () => {
    for (const sentence of [
      "North's total amount is -9,450.",
      "North's total amount: +9,450.",
      "North's total amount is < 9,450.",
      "North's total amount ≥ 9,450.",
      "North's total amount ≠ 9,450.",
      "North's total amount is 9,450%.",
      "North's total amount is €9,450.",
      "North's total amount is $9,450.",
      "North's total amount is 9,450/order.",
      "North's total amount is ~9,450.",
    ])
      expect(holds(sentence, "9,450", north), sentence).toBe(false);
    expect(holds("北部地区金额合计为 9,450%。", "9,450", zhNorth)).toBe(false);
    expect(holds("南部地区金额合计为 -8,700。", "8,700", { label: "南部地区金额合计" })).toBe(
      false,
    );
    expect(holds("9,450", "9,450", { ...north, headings: "North · Total amount %" })).toBe(false);
    expect(holds("9,450", "9,450", { ...zhNorth, headings: "北部地区 · 金额合计（%）" })).toBe(
      false,
    );
    // "=" says what "equals" does; a dash inside a word joins it; the label's own symbol is its own.
    expect(holds("North's total amount = 9,450.", "9,450", north)).toBe(true);
    expect(
      holds("North-West's total amount is 9,450.", "9,450", { label: "Total amount, North West" }),
    ).toBe(true);
    expect(holds("North's share (%) is 26.6.", "26.6", { label: "Share (%), North" })).toBe(true);
    expect(
      holds("North's amount/order is 236.", "236", { label: "Amount/order, North", how: "mean" }),
    ).toBe(true);
    expect(holds("9,450", "9,450", { ...north, headings: "North · Total amount" })).toBe(true);
  });

  test("what the figure must be or was to be, never what it is", () => {
    for (const sentence of [
      "North's total amount has to reach 9,450.",
      "North had to reach a total amount of 9,450.",
      "North's total amount is to reach 9,450.",
      "North's total amount was to be 9,450.",
      "North's total amount was to have reached 9,450.",
    ])
      expect(holds(sentence, "9,450", north), sentence).toBe(false);
    for (const sentence of [
      "North had a total amount of 9,450.",
      "North has a total amount of 9,450.",
      "North reached a total amount of 9,450.",
      "North's total amount came to 9,450.",
      "North's total amount amounted to 9,450.",
    ])
      expect(holds(sentence, "9,450", north), sentence).toBe(true);
  });

  test("closed or placed orders are some of them", () => {
    expect(holds("North's closed orders had a total amount of 9,450.", "9,450", north)).toBe(false);
    expect(holds("Orders placed in North had a total amount of 9,450.", "9,450", north)).toBe(
      false,
    );
    expect(holds("North's orders had a total amount of 9,450.", "9,450", north)).toBe(true);
  });

  test("one item of its input's total, or a total per item; an average of one is its own", () => {
    expect(holds("A North order's total amount is 9,450.", "9,450", north)).toBe(false);
    expect(holds("An order's total amount for North is 9,450.", "9,450", north)).toBe(false);
    expect(holds("North recorded a total amount of 9,450.", "9,450", north)).toBe(true);
    const mean = { label: "Average amount, North", how: "mean", vocabulary } as const;
    expect(holds("An order from North has an average amount of 945.", "945", mean)).toBe(true);
  });

  test("a scale, currency or percent said in its paragraph, the heading or the lines above", () => {
    const said = "North's total amount is 9,450.";
    for (const before of [
      "All amounts below are in thousands.",
      "Usage is given as thousands of litres.",
      "Amounts are in euros.",
      "Prices below are in €.",
      "All figures are in USD.",
      "Figures are in '000s.",
      "Values are shown in percent.",
      "The figures below are percentages.",
    ])
      expect(holds(said, "9,450", north, `${before} ${said}`), before).toBe(false);
    expect(holds(said, "9,450", { ...north, heading: "Amounts (in thousands)" })).toBe(false);
    expect(holds(said, "9,450", { ...north, heading: "Amounts (000)" })).toBe(false);
    expect(holds(said, "9,450", { ...north, above: "Figures below are in USD millions." })).toBe(
      false,
    );
    const zh = "北部地区金额合计为 9,450。";
    expect(holds(zh, "9,450", zhNorth, `以下金额单位为万元。${zh}`)).toBe(false);
    expect(holds(zh, "9,450", { ...zhNorth, heading: "金额（单位：千元）" })).toBe(false);
    expect(holds(zh, "9,450", { ...zhNorth, above: "以下数字以千为单位。" })).toBe(false);
    expect(holds(zh, "9,450", zhNorth, `金额以欧元计。${zh}`)).toBe(false);
    // A number's own currency or scale is its own, and so is a name with 万 or 千 in it.
    expect(
      holds(said, "9,450", north, `Last year it was £8,000, or 1.2 million in all. ${said}`),
    ).toBe(true);
    expect(holds(zh, "9,450", { ...zhNorth, heading: "万和路门店" })).toBe(true);
    expect(holds(said, "9,450", north)).toBe(true);
  });

  test("one its shown number, its unit or the Analysis's words back stands", () => {
    const pounds = { label: "Total amount, North", how: "sum", unit: "GBP" } as const;
    expect(
      holds("North's total amount is £9.45 thousand.", "£9.45 thousand", {
        ...pounds,
        heading: "Amounts (GBP thousands)",
      }),
    ).toBe(true);
    expect(
      holds("North's total amount is £9.45 thousand.", "£9.45 thousand", {
        ...pounds,
        heading: "Amounts (EUR)",
      }),
    ).toBe(false);
    expect(
      holds("North's total amount is £9.45 thousand.", "£9.45 thousand", {
        ...pounds,
        heading: "Amounts (in millions)",
      }),
    ).toBe(false);
    expect(holds(said(), "9,450", { ...north, heading: "Weight (kg)", unit: "kg" })).toBe(true);
    expect(
      holds("北部地区重量合计为 9,450.00 kg。", "9,450.00 kg", {
        label: "北部地区重量合计",
        unit: "kg",
        heading: "重量（千克）",
      }),
    ).toBe(true);
    expect(
      holds(said(), "9,450", {
        ...north,
        vocabulary: ["orders", "amount (USD thousands)"],
        above: "Amounts in USD thousands.",
      }),
    ).toBe(true);
    expect(holds(said(), "9,450", { ...north, unit: "%", heading: "Growth (%)" })).toBe(true);
    expect(holds(said(), "9,450", { ...north, unit: "GBP", heading: "Amounts (GBP)" })).toBe(true);
    expect(holds(said(), "9,450", { ...north, unit: "kg", heading: "Amounts (GBP)" })).toBe(false);
    // The shown number's own currency backs one said around it, whatever the Analysis's words say.
    const inPounds = "North's total amount is £9.45 thousand.";
    expect(holds(inPounds, "£9.45 thousand", { ...north, heading: "Amounts (GBP)" })).toBe(true);
    expect(holds(inPounds, "£9.45 thousand", { ...north, heading: "Amounts (EUR)" })).toBe(false);
  });

  test("any symbol, the accounts' minus and a dash or bracket that touches the figure; never one that only punctuates", () => {
    for (const sentence of [
      "North's total amount is ▼9,450.",
      "North's total amount is △9,450.",
      "North's total amount is ˗9,450.",
      "North's total amount is 〜9,450.",
      "North's total amount is 9,450٪.",
      "North's total amount is (9,450).",
      "North's total amount is – 9,450.",
      "North's total amount is 9,450–9,800.",
    ])
      expect(holds(sentence, "9,450", north), sentence).toBe(false);
    expect(holds("北部地区金额合计为▼9,450。", "9,450", zhNorth)).toBe(false);
    expect(holds("北部地区金额合计为（9,450）。", "9,450", zhNorth)).toBe(false);
    expect(holds("北部地区金额合计——9,450。", "9,450", zhNorth)).toBe(true);
    for (const sentence of [
      "North — total amount: 9,450.",
      "Total amount – North: 9,450.",
      "Total amount, North – 9,450.",
      "Total amount, North — 9,450.",
      "The total amount for North (9,450).",
      "North's total amount (all orders) is 9,450.",
    ])
      expect(holds(sentence, "9,450", north), sentence).toBe(true);
    // A range's dash after the figure, up to the typed number that ends it, makes it one end.
    const range = "North's total amount is 9,450–9,800.";
    const first = figureIn(range, "9,450", north);
    const end = { ...figureIn(range, "9,800", north, "typed"), analysisRecord: undefined };
    expect(namingHolds(range, first, [first, end])).toBe(false);
    const both = "North's total amount is 9,450, against 9,800.";
    const alone = figureIn(both, "9,450", north);
    const other = { ...figureIn(both, "9,800", north, "typed"), analysisRecord: undefined };
    expect(namingHolds(both, alone, [alone, other])).toBe(true);
    // A dash in one of the Analysis's own words is no sign for the figure.
    const dated = { ...north, vocabulary: [...vocabulary, "2025-26"] };
    expect(holds("North's total amount is -9,450.", "9,450", dated)).toBe(false);
  });

  test("the figure's own currency's sign is its own, in a cell's headings too", () => {
    const euros = { label: "Total amount, North", how: "sum", unit: "EUR", vocabulary } as const;
    const shown = "€9.45 thousand";
    expect(holds(shown, shown, { ...euros, headings: "North · Total amount (€)" })).toBe(true);
    expect(holds(shown, shown, { ...euros, headings: "North · Total amount ($)" })).toBe(false);
    expect(holds("9,450", "9,450", { ...north, headings: "North · Total amount (€)" })).toBe(false);
  });

  test("a target in any verb, and one item's total only where the item stands for one", () => {
    expect(holds("North's total amount is to total 9,450.", "9,450", north)).toBe(false);
    // "reach" links a figure to its name until a "to" makes it a target.
    expect(holds("North's orders reach a total amount of 9,450.", "9,450", north)).toBe(true);
    for (const [sentence, given] of [
      ["North recorded an order total amount of 9,450.", north],
      ["North had a sales total amount of 9,450.", { ...north, vocabulary: ["sales", "amount"] }],
      [
        "North had an order count of 40.",
        { label: "Order count, North", how: "count", vocabulary },
      ],
    ] as const)
      expect(holds(sentence, sentence.match(/\d[\d,]*/u)?.[0] ?? "", given), sentence).toBe(true);
  });

  test("more ways a text says its scale or currency, and words that only look like one", () => {
    const zh = "北部地区金额合计为 9,450。";
    for (const before of [
      "Amounts are in units of 1,000.",
      "Figures ×1,000.",
      "Amounts are in US dollar terms.",
      "Fares are in cents.",
      "Changes are in basis points.",
      "Figures are in hundreds.",
    ])
      expect(holds(said(), "9,450", north, `${before} ${said()}`), before).toBe(false);
    for (const before of [
      "以下金额以 1,000 元为单位。",
      "单位：10,000元",
      "以下金额以美金计。",
      "金额单位为分。",
    ])
      expect(holds(zh, "9,450", zhNorth, `${before}${zh}`), before).toBe(false);
    for (const before of [
      "Currency: EUR",
      "USD figures follow.",
      "The amounts are USD.",
      "All figures below are percent.",
    ])
      expect(holds(said(), "9,450", north, `${before} ${said()}`), before).toBe(false);
    expect(holds(said(), "9,450", { ...north, heading: "Totals, EUR" })).toBe(false);
    const dollars = { ...north, unit: "USD" };
    expect(holds(said(), "9,450", dollars, `Thousands of USD below. ${said()}`)).toBe(false);
    expect(holds(said(), "9,450", dollars, `Amounts are in USD. ${said()}`)).toBe(true);
    for (const before of [
      "Thousands of customers ordered.",
      "Margins rose by a few percent.",
      "Our PHP storefront and CAD team moved.",
      "We track percentages elsewhere.",
      "North has units of 1,000 staff.",
      "The bus fare is 99 cents.",
      "Prices end in 99 cents.",
      "The Dollar Lane branch opened.",
    ])
      expect(holds(said(), "9,450", north, `${before} ${said()}`), before).toBe(true);
    for (const before of [
      "数以万计的客户下了单。",
      "上千人下单。",
      "以万和店为例，",
      "北部（千禧店）成为千万用户的选择。",
    ])
      expect(holds(zh, "9,450", zhNorth, `${before}${zh}`), before).toBe(true);
  });

  test("a text the figure reader gives up on never keeps a Supported", () => {
    expect(holds(said(), "9,450", north, `GARBLED. ${said()}`)).toBe(false);
    expect(holds(said(), "9,450", north, `Read with care. ${said()}`)).toBe(true);
  });

  test("a scale said of a count, in any counting unit; a unit's own prefix is no scale of it", () => {
    const orders = { label: "Number of orders, North", how: "count", vocabulary } as const;
    const zhOrders = { label: "北部地区订单数", how: "count", vocabulary } as const;
    const en = "North's number of orders is 40.";
    const zh = "北部地区订单数为 40。";
    for (const before of [
      "Counts above are in thousands.",
      "Order numbers are shown in thousands of orders.",
    ])
      expect(holds(en, "40", orders, `${before} ${en}`), before).toBe(false);
    for (const before of [
      "以上数量单位为千人。",
      "客户数以万户计。",
      "订单数单位：千笔",
      "门店数以千家计。",
      "设备数量单位为万台。",
      "以下条目单位为千条。",
      "以下数字单位为千项。",
      "以下人数单位为万位。",
    ])
      expect(holds(zh, "40", zhOrders, `${before}${zh}`), before).toBe(false);
    for (const before of [
      "重量以千克计。",
      "距离单位为千米。",
      "用电量以千瓦时计。",
      "上千人下单。",
      "这项服务已走进千家万户。",
      "万家路店本月开业。",
      "千户街店本月开业。",
      "千台村门店本月开业。",
      "万名街店本月开业。",
      "成千上万的客户下了单。",
    ])
      expect(holds(zh, "40", zhOrders, `${before}${zh}`), before).toBe(true);
    expect(holds(en, "40", orders, `Parcels are weighed in kilograms. ${en}`)).toBe(true);
  });
});

const said = () => "North's total amount is 9,450.";
