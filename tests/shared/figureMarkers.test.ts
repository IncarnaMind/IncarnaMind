/**
 * Where an Answer writes its calculated figures (ADR-0021): a marker such as
 * "[=1]", which every reader of the Answer turns into the figure's shown text,
 * the number the model wrote right before it shown once or kept and flagged.
 */
import { describe, expect, test } from "vitest";
import { markdownToBlocks } from "../../src/core/answers/markdown";
import type { NodeJSON } from "../../src/shared/blockJson";
import {
  numberBefore,
  type PlacedFigure,
  withFigures,
  withFigureText,
} from "../../src/shared/figureMarkers";
import { currencyPrefixStart } from "../../src/shared/figures";
import { formulaText } from "../../src/shared/formula";

const figure = (
  value: number | boolean,
  shown: string,
  language: "en" | "zh-CN" = "en",
): PlacedFigure => ({
  value,
  shown,
  show: { language, as: null, decimals: null, scale: null },
});

const GROWTH = figure(0.204387, "20.4%");
const POINTS = figure(0.023, "2.3 percentage points");
const AMOUNT = figure(251_612_345, "$251.6 million");
const INCREASE = figure(304_573_600, "30,457.36万元", "zh-CN");

describe("the number a model wrote before a figure's marker", () => {
  test("is the figure when it reads as its value to the decimals written, in the same unit", () => {
    expect(numberBefore("Revenue grew 20.4% ", GROWTH)).toMatchObject({
      chars: "20.4%",
      same: true,
    });
    expect(numberBefore("Revenue grew 20% ", GROWTH)).toMatchObject({ same: true });
    expect(numberBefore("Revenue grew 20.44% ", GROWTH)).toMatchObject({ same: true });
    expect(numberBefore("Revenue was $251.6 million ", AMOUNT)).toMatchObject({ same: true });
    // A number with no unit of its own reads as an amount.
    expect(numberBefore("up 251.6 million ", AMOUNT)).toMatchObject({ same: true });
    expect(numberBefore("比上年增加30,457.36万元", INCREASE)).toMatchObject({ same: true });
    expect(numberBefore("约3.05亿元", INCREASE)).toMatchObject({ same: true });
  });

  test("isn't, with another value or unit: a difference of percents written as a percent is flagged", () => {
    expect(numberBefore("Revenue grew 26% ", GROWTH)).toMatchObject({ chars: "26%", same: false });
    expect(numberBefore("margin rose 2.3% ", POINTS)).toMatchObject({ chars: "2.3%", same: false });
    expect(numberBefore("up 3.1亿元", INCREASE)).toMatchObject({ same: false });
    expect(numberBefore("yes ", figure(true, "yes"))).toBeNull();
  });

  test("is none when the text before the marker doesn't end with a number", () => {
    expect(numberBefore("Revenue grew ", GROWTH)).toBeNull();
    expect(numberBefore("Revenue grew in 2025 ", GROWTH)).toBeNull();
    expect(numberBefore("grew 25%[^1] ", GROWTH)).toBeNull();
    expect(numberBefore("", GROWTH)).toBeNull();
  });
});

const textOf = (nodes: readonly NodeJSON[]): string =>
  nodes
    .map((node) => (node.type === "text" ? (node.text ?? "") : textOf(node.content ?? [])))
    .join("");

describe("figure markers in an Answer", () => {
  const figures = new Map([
    [1, GROWTH],
    [2, POINTS],
  ]);
  const figureOf = (marker: number) => figures.get(marker) ?? null;

  test("become the figure's shown text in Blocks, in text and a table's cell, with the marks around them", () => {
    const blocks = withFigures(
      markdownToBlocks("**Revenue grew [=1]**, margin rose [=2].\n\n| A |\n|:--|\n| [=1] |"),
      figureOf,
      (each) => each.shown,
    );
    expect(blocks[0]?.content).toMatchObject([
      { type: "text", text: "Revenue grew 20.4%", marks: [{ type: "bold" }] },
      { type: "text", text: ", margin rose 2.3 percentage points." },
    ]);
    expect(textOf(blocks.slice(1))).toBe("A20.4%");
  });

  test("leave code alone, drop one with no figure with the space before it, and say what the model wrote when it differs", () => {
    const written: (string | null)[] = [];
    const blocks = withFigures(
      markdownToBlocks("Grew 26% [=1], fell [=9]. Write `[=1]`.\n\n```\n[=2]\n```"),
      figureOf,
      (each, _marker, wrote) => {
        written.push(wrote);
        return each.shown;
      },
    );
    expect(textOf(blocks)).toBe("Grew 26% 20.4%, fell. Write [=1].[=2]");
    expect(written).toEqual(["26%"]);
  });

  test("don't show the words around the number twice when the model writes them beside the marker", () => {
    const more = new Map<number, PlacedFigure>([
      [1, POINTS],
      [2, INCREASE],
      [3, AMOUNT],
      [4, figure(1.2e9, "about 1.2 billion")],
      [5, GROWTH],
    ]);
    expect(
      withFigureText(
        "rose [=1] percentage points; 增加[=2]万元; was $[=3] in 2025; about [=4]; grew [=5]% while roundabout [=4] millionaires",
        (marker) => more.get(marker) ?? null,
      ),
    ).toBe(
      "rose 2.3 percentage points; 增加30,457.36万元; was $251.6 million in 2025; about 1.2 billion; grew 20.4% while roundabout about 1.2 billion millionaires",
    );
  });

  // protects=a scale or currency the model writes after a marker never shows beside the figure's own, and one that isn't the figure's is kept as what the Answer wrote (#577); fails_when="万元 亿元" or "billion million" reads in the text, a differing scale isn't flagged, or the text's own words ("people") go; no_claim=units other than a scale or currency.
  test("don't show a scale twice: the model's is left out, and kept as what it wrote when it isn't the figure's", () => {
    const more = new Map<number, PlacedFigure>([
      [1, figure(1_203_456_700, "12.03亿元", "zh-CN")],
      // The figure of #577, worked out as 万元 when the model meant 亿元.
      [2, figure(120_345.67, "12.0346万元", "zh-CN")],
      [3, figure(1_482_600_000, "$1.48 billion")],
      [4, figure(1_234, "1,234")],
      [5, figure(1_200_000, "1.2 million")],
    ]);
    const written: (string | null)[] = [];
    const blocks = withFigures(
      markdownToBlocks(
        "合计为 [=1] 亿元，即 [=1]元，[=1]亿元以上；[=2] 亿元。Revenue was [=3] billion, or [=3] million dollars; [=4] million; [=5] people, [=5] million people.",
      ),
      (marker) => more.get(marker) ?? null,
      (each, _marker, wrote) => {
        written.push(wrote);
        return each.shown;
      },
    );
    expect(textOf(blocks)).toBe(
      "合计为 12.03亿元，即 12.03亿元，12.03亿元以上；12.0346万元。Revenue was $1.48 billion, or $1.48 billion; 1,234; 1.2 million people, 1.2 million people.",
    );
    expect(written).toEqual([
      null,
      null,
      null,
      "亿元",
      null,
      "million dollars",
      "million",
      null,
      null,
    ]);
  });

  test("read the same as text, for Question context, search and outside agents", () => {
    expect(
      withFigureText(
        "Revenue grew 20.4% [=1] and margin rose [=2] [=7].\n\nThen 26% [=1].",
        figureOf,
      ),
    ).toBe("Revenue grew 20.4% and margin rose 2.3 percentage points.\n\nThen 26% 20.4%.");
  });
});

describe("a formula as a person reads it", () => {
  test("names become labels or numbers as written, and operators the signs people write", () => {
    const values: Record<string, string> = {
      rev2025: "$1,482.6 million",
      rev2024: "$1,231.0 million",
    };
    expect(formulaText("rev2025 / rev2024 - 1", (name) => values[name] ?? null)).toBe(
      "$1,482.6 million ÷ $1,231.0 million − 1",
    );
    expect(formulaText("=(end/start)^(1/4)-1", () => null)).toBe("(end ÷ start) ^ (1 ÷ 4) − 1");
    expect(formulaText("SUM(q1,q2)*-x", () => null)).toBe("SUM(q1, q2) × −x");
    expect(formulaText("ROUND(a*5%,2)", () => null)).toBe("ROUND(a × 5%, 2)");
    expect(formulaText("a ++ ) ?", () => null)).toBe("a ++ ) ?");
  });
});

describe("equivalent currency before a calculated figure", () => {
  test.each([
    ["en", "Net debt: GBP [=1] millions", "£310 million", "Net debt: £310 million"],
    ["en", "Net debt: GBP [=1] million", "£310 million", "Net debt: £310 million"],
    ["en", "Net debt: £ [=1]", "£310 million", "Net debt: £310 million"],
    ["en", "Net debt: GBP £ [=1]", "£310 million", "Net debt: £310 million"],
    ["en", "Net debt: GBP GBP [=1]", "£310 million", "Net debt: £310 million"],
    ["en", "Net debt: ＧＢＰ [=1]", "£310 million", "Net debt: £310 million"],
    ["zh-CN", "净负债为GBP [=1]", "3.1亿英镑", "净负债为3.1亿英镑"],
    ["zh-CN", "净负债为英镑[=1]", "3.1亿英镑", "净负债为3.1亿英镑"],
    ["en", "USD [=1]", "£310 million", "USD £310 million"],
    ["en", "NotGBP [=1]", "£310 million", "NotGBP £310 million"],
    ["en", "about GBP [=1]", "£310 million", "about £310 million"],
    ["en", "about GBP [=1]", "about £310 million", "about £310 million"],
    ["en", "Net debt: - GBP [=1]", "£310 million", "Net debt: - £310 million"],
  ] as const)("%s: %s keeps one coherent currency", (language, input, shown, expected) => {
    const own = figure(310_000_000, shown, language);
    expect(withFigureText(input, () => own)).toBe(expected);
    expect(
      textOf(
        withFigures(
          markdownToBlocks(input),
          () => own,
          (each) => each.shown,
        ),
      ),
    ).toBe(expected);
  });

  test("rich text keeps its marks and code keeps its literal marker", () => {
    const own = figure(310_000_000, "£310 million");
    const blocks = withFigures(
      markdownToBlocks("**GBP [=1]** and `GBP [=1]`"),
      () => own,
      (each) => each.shown,
    );
    expect(blocks[0]?.content).toMatchObject([
      { type: "text", text: "£310 million", marks: [{ type: "bold" }] },
      { type: "text", text: " and " },
      { type: "text", text: "GBP [=1]", marks: [{ type: "code" }] },
    ]);
  });
});

test("currency prefixes keep raw boundaries and stop at another unit or a line break", () => {
  expect(currencyPrefixStart("Net: GBP £ ", "GBP")).toBe(5);
  expect(currencyPrefixStart("USD GBP ", "GBP")).toBe(4);
  expect(currencyPrefixStart("GBP USD ", "GBP")).toBeNull();
  expect(currencyPrefixStart("NotGBP ", "GBP")).toBeNull();
  expect(currencyPrefixStart("GBP\n", "GBP")).toBeNull();
  expect(currencyPrefixStart("GBP · ", "GBP")).toBeNull();
  expect(currencyPrefixStart("净负债为英镑", "GBP", { language: "zh-CN" })).toBe(4);
});

test("a long repeated prefix still writes the amount once", () => {
  const own = figure(310_000_000, "£310 million");
  expect(withFigureText(`${"GBP ".repeat(1_000)}[=1]`, () => own)).toBe("£310 million");
});
