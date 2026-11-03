import { expect, test } from "vitest";
import { readFigures } from "../../src/shared/figures";

test.each([
  ["23 bps", "en"],
  ["23个基点", "zh-CN"],
])("%s keeps its shown last place in base units", (text, language) => {
  expect(readFigures(text, { language })).toMatchObject([
    {
      value: 0.0023,
      unit: { kind: "points" },
      scale: 1,
      decimals: 0,
      precision: 0.0001,
    },
  ]);
});

test.each([
  {
    text: "2.3 percentage points",
    language: "en",
    expected: { value: 0.023, unit: { kind: "points" }, scale: 1, decimals: 1, precision: 0.001 },
  },
  {
    text: "提高2.3个百分点",
    language: "zh-CN",
    expected: { value: 0.023, unit: { kind: "points" }, scale: 1, decimals: 1, precision: 0.001 },
  },
  {
    text: "2.3%",
    language: "en",
    expected: { value: 0.023, unit: { kind: "percent" }, scale: 1, decimals: 1, precision: 0.001 },
  },
  {
    text: "百分之三点五",
    language: "zh-CN",
    expected: { value: 0.035, unit: { kind: "percent" }, scale: 1, decimals: 1, precision: 0.001 },
  },
  {
    text: "2.3‰",
    language: "en",
    expected: {
      value: 0.0023,
      unit: { kind: "percent" },
      scale: 1,
      decimals: 1,
      precision: 0.0001,
    },
  },
  {
    text: "千分之五",
    language: "zh-CN",
    expected: { value: 0.005, unit: { kind: "percent" }, scale: 1, decimals: 0, precision: 0.001 },
  },
  {
    text: "£1,482.6 million",
    language: "en",
    expected: {
      value: 1482600000,
      unit: { kind: "currency", code: "GBP" },
      scale: 1000000,
      decimals: 1,
      precision: 100000,
    },
  },
  {
    text: "1.2亿元",
    language: "zh-CN",
    expected: {
      value: 120000000,
      unit: { kind: "currency", code: "CNY" },
      scale: 100000000,
      decimals: 1,
      precision: 10000000,
    },
  },
  {
    text: "12.50",
    language: "en",
    expected: { value: 12.5, unit: { kind: "plain" }, scale: 1, decimals: 2, precision: 0.01 },
  },
  {
    text: "-23 bps",
    language: "en",
    expected: {
      value: -0.0023,
      unit: { kind: "points" },
      scale: 1,
      decimals: 0,
      precision: 0.0001,
    },
  },
])("$text retains its value and stated decimal place", ({ text, language, expected }) => {
  expect(readFigures(text, { language })).toMatchObject([expected]);
});

test.each([
  {
    text: "41.2",
    language: "zh-CN",
    header: "单位：%",
    value: 0.412,
    scale: 1,
    precision: 0.001,
    basePrecision: 0.1,
  },
  {
    text: "12.3",
    language: "zh-CN",
    header: "单位：万元",
    value: 123000,
    scale: 10000,
    precision: 1000,
    basePrecision: 0.1,
  },
  {
    text: "34,002.51",
    language: "en",
    header: "100million USD",
    value: 3400251000000,
    scale: 100000000,
    precision: 1000000,
    basePrecision: 0.01,
  },
])(
  "the $header choice keeps its own base-unit precision",
  ({ text, language, header, basePrecision, ...expected }) => {
    const [figure] = readFigures(text, { language, header });
    expect(figure?.ambiguous.find((each) => each.kind === "scale")?.readings.at(-1)).toMatchObject(
      expected,
    );
    expect(figure?.precision).toBe(basePrecision);
  },
);

test("currency choices retain the number's scale and decimal place", () => {
  const [figure] = readFigures("¥1.2bn", { language: "en" });
  expect(figure?.ambiguous.find((each) => each.kind === "currency")?.readings).toMatchObject([
    { value: 1200000000, unit: { kind: "currency", code: "CNY" }, precision: 100000000 },
    { value: 1200000000, unit: { kind: "currency", code: "JPY" }, precision: 100000000 },
  ]);
});

test("alternative separator and points readings keep their own decimal place", () => {
  const [separator] = readFigures("1,234");
  expect(separator?.ambiguous.find((each) => each.kind === "separator")?.readings).toMatchObject([
    { value: 1234, decimals: 0, precision: 1 },
    { value: 1.234, decimals: 3, precision: 0.001 },
  ]);
  const [points] = readFigures("3 points", { language: "en" });
  expect(points?.ambiguous.find((each) => each.kind === "points")?.readings).toMatchObject([
    { value: 3, unit: { kind: "other", word: "points" }, precision: 1 },
    { value: 0.03, unit: { kind: "points" }, precision: 0.01 },
  ]);
});

test("range endpoints and uncertain signs do not share the wrong decimal place", () => {
  const [range] = readFigures("2.0–3.00%", { language: "en" });
  expect(range?.ambiguous.find((each) => each.kind === "range")?.readings).toMatchObject([
    { value: 0.02, decimals: 1, precision: 0.001 },
    { value: 0.03, decimals: 2, precision: 0.0001 },
  ]);
  const [signed] = readFigures("△1,250", { language: "zh-CN" });
  expect(signed?.ambiguous.find((each) => each.kind === "sign")?.readings).toMatchObject([
    { value: 1250, precision: 1 },
    { value: -1250, precision: 1 },
  ]);
});

test("exact fraction notation has no decimal-place quantum", () => {
  expect(readFigures("三分之一", { language: "zh-CN" })).toMatchObject([
    { value: 1 / 3, scale: 1, decimals: 0, precision: null },
  ]);
});

test("an unrepresentable decimal place keeps its value without inventing a quantum", () => {
  const [figure] = readFigures(`0.${"0".repeat(400)}`, { language: "en" });
  expect(figure).toMatchObject({ value: 0, scale: 1, decimals: 400, unit: { kind: "plain" } });
  expect(figure?.precision).toBeUndefined();
});
