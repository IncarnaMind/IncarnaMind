/**
 * Real headers' scale lines, quoted for two rows under them, through the core: the A-share,
 * Hong Kong, US, UK and Indian forms, and a currency named after "of", scale as their Document
 * states, and a line that names a measure never scales an amount (#2365).
 */
import { describe, expect, test } from "vitest";
import { pdf, pdfZh, record } from "../helpers/scaleCases";

type Rows = "zh" | "zh ¥" | "en" | `en ${string}`;

const ZH_ROWS = {
  zh: { lines: ["营业收入 1,200", "营业成本 300"], numbers: ["1,200", "300"] },
  "zh ¥": { lines: ["营业收入 ¥1,200", "营业成本 ¥300"], numbers: ["1,200", "300"] },
} as const;

type TwoRows = { lines: readonly [string, string]; numbers: readonly [string, string] };

/** "en" rows write no currency; "en NT$" and "en JPY" rows write theirs before each number. */
function rowsOf(rows: Rows): TwoRows {
  if (rows === "zh" || rows === "zh ¥") return ZH_ROWS[rows];
  const sign = rows.slice(3);
  const before = /[A-Z]$/.test(sign) ? `${sign} ` : sign;
  return {
    lines: [`Revenue ${before}1,234.5`, `Costs ${before}334.5`],
    numbers: ["1,234.5", "334.5"],
  };
}

interface Header {
  line: string;
  rows: Rows;
  /** The difference recorded, or null for a refusal. */
  value: number | null;
  /** The unit the first row is recorded in, where the test asks. */
  unit?: { kind: "plain" } | { kind: "currency"; code: string };
  /** Read from a plain-text Document: the PDF test font has no "₹". */
  text?: true;
}

const HEADERS: Header[] = [
  // A-share annual and quarterly reports.
  { line: "单位：元 币种：人民币", rows: "zh", value: 900 },
  { line: "单位：万元 币种：人民币", rows: "zh", value: 9_000_000 },
  { line: "单位：千元 币种：人民币", rows: "zh", value: 900_000 },
  { line: "单位：百万元 币种：人民币", rows: "zh", value: 900_000_000 },
  { line: "单位：亿元 币种：人民币", rows: "zh", value: 90_000_000_000 },
  { line: "单位：元，币种：人民币", rows: "zh", value: 900 },
  { line: "单位：万元，币种：人民币", rows: "zh", value: 9_000_000 },
  { line: "单位：百万元，币种：人民币", rows: "zh", value: 900_000_000 },
  { line: "单位：元", rows: "zh", value: 900 },
  { line: "单位：万元", rows: "zh", value: 9_000_000 },
  { line: "单位：千元 币种：人民币 审计类型：未经审计", rows: "zh", value: 900_000 },
  { line: "单位：万元（未经审计）", rows: "zh", value: 9_000_000 },
  { line: "金额单位：人民币万元", rows: "zh", value: 9_000_000 },
  { line: "单位：人民币千元", rows: "zh", value: 900_000 },
  { line: "编制单位：甲乙股份有限公司 单位：元 币种：人民币", rows: "zh", value: 900 },
  { line: "2024年12月31日 单位：元 币种：人民币", rows: "zh", value: 900 },
  { line: "单位：万元 币种：人民币", rows: "zh ¥", value: 9_000_000 },
  { line: "单位：百万元，币种：人民币", rows: "zh ¥", value: 900_000_000 },
  { line: "单位：千元 币种：人民币 审计类型：未经审计", rows: "zh ¥", value: 900_000 },
  { line: "单位：万元（未经审计）", rows: "zh ¥", value: 9_000_000 },
  { line: "（单位：人民币千元，除每股数据外）", rows: "zh", value: 900_000 },
  // Hong Kong filings.
  { line: "HK$'000", rows: "zh", value: 900_000 },
  { line: "人民幣千元", rows: "zh", value: 900_000 },
  { line: "港幣百萬元", rows: "zh", value: 900_000_000 },
  { line: "RMB'000", rows: "zh", value: 900_000 },
  { line: "(HK$ million)", rows: "en", value: 900_000_000 },
  // US 10-K and 10-Q.
  { line: "(in millions, except per share data)", rows: "en", value: 900_000_000 },
  { line: "(in millions, except per share data)", rows: "en $", value: 900_000_000 },
  { line: "(Dollars in thousands)", rows: "en", value: 900_000 },
  { line: "(Dollars in thousands)", rows: "en $", value: 900_000 },
  { line: "(in thousands, unaudited)", rows: "en $", value: 900_000 },
  { line: "(Unaudited, in thousands)", rows: "en $", value: 900_000 },
  { line: "In thousands (unaudited)", rows: "en $", value: 900_000 },
  { line: "(in thousands of dollars, unaudited)", rows: "en $", value: 900_000 },
  { line: "(in millions, as restated)", rows: "en $", value: 900_000_000 },
  { line: "(In thousands, except share and per share amounts)", rows: "en $", value: 900_000 },
  {
    line: "CONSOLIDATED STATEMENTS OF OPERATIONS (In thousands, except per share data)",
    rows: "en $",
    value: 900_000,
  },
  { line: "Three months ended March 31, (in thousands)", rows: "en $", value: 900_000 },
  { line: "(in thousands; unaudited)", rows: "en $", value: 900_000 },
  { line: "All amounts in thousands unless otherwise stated", rows: "en $", value: 900_000 },
  { line: "(In millions) Q3 2024", rows: "en $", value: 900_000_000 },
  { line: "($ in millions)", rows: "en $", value: 900_000_000 },
  { line: "(Amounts in thousands)", rows: "en", value: 900_000 },
  { line: "(in thousands)", rows: "en $", value: 900_000 },
  // UK.
  { line: "£m", rows: "en", value: 900_000_000 },
  { line: "£'000", rows: "en", value: 900_000 },
  { line: "£m", rows: "en £", value: 900_000_000 },
  { line: "(£'000)", rows: "en £", value: 900_000 },
  // India.
  { line: "(INR in lakhs)", rows: "en", value: 90_000_000 },
  { line: "(₹ in crores)", rows: "en", value: 9_000_000_000, text: true },
  { line: "(Rs. in thousands)", rows: "en", value: 900_000 },
  { line: "(Rs. in lakhs)", rows: "en", value: 90_000_000 },
  // Taiwanese, Japanese, Korean, Brazilian, Mexican, Nordic and other filings name their currency
  // after "of": an amount in it takes the scale, with its own sign's currency or none.
  {
    line: "(In thousands of New Taiwan dollars)",
    rows: "en NT$",
    value: 900_000,
    unit: { kind: "currency", code: "TWD" },
  },
  {
    line: "(in thousands of Japanese yen)",
    rows: "en JPY",
    value: 900_000,
    unit: { kind: "currency", code: "JPY" },
  },
  {
    line: "(in thousands of Brazilian reais)",
    rows: "en R$",
    value: 900_000,
    unit: { kind: "currency", code: "BRL" },
  },
  {
    line: "(in millions of Korean won)",
    rows: "en KRW",
    value: 900_000_000,
    unit: { kind: "currency", code: "KRW" },
  },
  {
    line: "(in thousands of Swedish kronor)",
    rows: "en SEK",
    value: 900_000,
    unit: { kind: "currency", code: "SEK" },
  },
  {
    line: "(In thousands of Mexican pesos)",
    rows: "en MXN",
    value: 900_000,
    unit: { kind: "currency", code: "MXN" },
  },
  {
    line: "(in thousands of South African rand)",
    rows: "en ZAR",
    value: 900_000,
    unit: { kind: "currency", code: "ZAR" },
  },
  {
    line: "(in thousands of Thai baht)",
    rows: "en THB",
    value: 900_000,
    unit: { kind: "currency", code: "THB" },
  },
  {
    line: "(Amounts in thousands of Philippine pesos)",
    rows: "en PHP",
    value: 900_000,
    unit: { kind: "currency", code: "PHP" },
  },
  {
    line: "(in thousands of Turkish lira)",
    rows: "en TRY",
    value: 900_000,
    unit: { kind: "currency", code: "TRY" },
  },
  {
    line: "(IN THOUSANDS OF NEW TAIWAN DOLLARS)",
    rows: "en NT$",
    value: 900_000,
    unit: { kind: "currency", code: "TWD" },
  },
  {
    line: "(in thousands of New Taiwan dollars)",
    rows: "en",
    value: 900_000,
    unit: { kind: "plain" },
  },
  { line: "(in thousands of Japanese yen)", rows: "en", value: 900_000, unit: { kind: "plain" } },
  { line: "(in millions of Korean won)", rows: "en", value: 900_000_000, unit: { kind: "plain" } },
  {
    line: "(Expressed in thousands of Polish zlotys)",
    rows: "en",
    value: 900_000,
    unit: { kind: "plain" },
  },
  {
    line: "(in thousands of Canadian dollars)",
    rows: "en",
    value: 900_000,
    unit: { kind: "currency", code: "CAD" },
  },
  // A line that names a measure, a rate or another word beside its scale, which main scaled.
  { line: "Unit: million tonnes", rows: "en $", value: null },
  { line: "(in thousands of tonnes)", rows: "en $", value: null },
  { line: "(in millions of shares)", rows: "en $", value: null },
  { line: "In millions of barrels", rows: "en $", value: null },
  { line: "(thousand barrels per day)", rows: "en $", value: null },
  { line: "(in thousands of tonnes CO2e)", rows: "en $", value: null },
  { line: "In thousands of tonnes (kt)", rows: "en $", value: null },
  { line: "(in thousands of tonnes – unaudited)", rows: "en $", value: null },
  { line: "(tonnes, in thousands)", rows: "en $", value: null },
  { line: "(in millions, tonnes)", rows: "en $", value: null },
  { line: "(in US$ thousands per tonne)", rows: "en $", value: null },
  { line: "(in thousands of contracts won)", rows: "en $", value: null },
  { line: "(in thousands of units and dollars)", rows: "en $", value: null },
  { line: "(in thousands of Japanese yen per share)", rows: "en JPY", value: null },
  { line: "单位：万吨", rows: "zh ¥", value: null },
  { line: "单位：万平方米", rows: "zh ¥", value: null },
  { line: "单位：万桶/日", rows: "zh ¥", value: null },
  { line: "单位：万头", rows: "zh ¥", value: null },
  { line: "单位：万亩", rows: "zh ¥", value: null },
  { line: "单位万平方米", rows: "zh ¥", value: null },
  { line: "单位：万吨 币种：人民币", rows: "zh ¥", value: null },
];

describe("Real headers' scale lines (#2365)", { timeout: 300_000 }, () => {
  test.each(HEADERS.map((each, index) => ({ ...each, index })))(
    "$index: $line over $rows rows",
    async (each) => {
      const rows = rowsOf(each.rows);
      const chinese = each.rows.startsWith("zh");
      const recorded = await record({
        file: each.text
          ? { name: `Table ${each.index}.txt`, contents: [each.line, ...rows.lines].join("\n") }
          : chinese
            ? pdfZh(`表${each.index}`, [each.line, ...rows.lines])
            : pdf(`Table ${each.index}`, [each.line, ...rows.lines]),
        cites: rows.lines,
        numbers: rows.numbers,
        unitQuote: each.line,
        query: chinese ? "营业收入 营业成本" : "revenue costs",
      });
      expect(recorded.value).toBe(each.value);
      if (each.unit) expect(recorded.unit).toEqual(each.unit);
    },
  );
});
