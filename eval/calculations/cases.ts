/**
 * The calculations set's Questions (#441): 80, half in English and half in
 * Chinese, each with every result it asks for, the inputs each is worked out
 * from (Document, page or slide, the quote and the number in it) and the
 * wrong values a model is known to reach (a restated year read as reported,
 * a stated rate recalculated, 环比 read as 同比). A Question the Documents in
 * its scope can't answer, a conversion with no rate, must be refused.
 * Expected values are worked out here, in plain arithmetic over the inputs'
 * values, never by the app's own formula engine.
 */
import {
  HUATUO,
  KESTREL,
  LIST_PRICES,
  NORTHWIND,
  NORTHWIND_DECK,
  PRODUCTS,
  QINGLAN,
  RATES,
  REGIONS,
  revenueOf,
  SALES,
  SALES_ROWS,
  SURVEY,
  SURVEY_RESPONSES,
  YUNFAN,
} from "./documents";

export type CaseLanguage = "en" | "zh";

/** What a result measures: a share or growth, a difference of percents, or an amount of money. */
export type ExpectedUnit = "percent" | "points" | "USD" | "CNY";

export interface ExpectedInput {
  /** The Document's name. */
  document: string;
  /** The page of a PDF or the slide of a deck; null for a Word file or a workbook. */
  unit: number | null;
  /** A line of the Document holding the number, word for word. */
  quote: string;
  /** The number as the quote writes it. */
  number: string;
  /** Its value with its scale applied: 2,346.8 under "in millions" is 2,346,800,000. */
  value: number;
  /** The line stating the number's scale or currency, when the number has none of its own. */
  unitQuote?: string;
  /** For an exchange rate: the currencies it converts, "CNY per USD". */
  rate?: string;
}

export interface ExpectedResult {
  label: string;
  unit: ExpectedUnit;
  /** Base units: 0.126 for 12.6%, 0.01 for one percentage point, 53,500,000 for $53.5 million. */
  value: number;
  /** How far a figure may be from `value` and still be right, in the same units. */
  tolerance: number;
  /** "derived": worked out from the inputs; "quoted": stated by a Document, and not to be recalculated. */
  kind: "derived" | "quoted";
  /** By the names the formula uses. */
  inputs: Readonly<Record<string, ExpectedInput>>;
  /** Other inputs a right working may read instead: the four quarters for a year's total. */
  alsoAccepted?: readonly ExpectedInput[];
  /** In the calculate Tool's syntax over the inputs' names; empty for a quoted result. */
  formula: string;
  /** Values a model is known to reach by a wrong reading, and why. */
  traps: readonly { value: number; why: string }[];
}

export interface CalculationCase {
  id: string;
  language: CaseLanguage;
  question: string;
  /** The Documents it may search, by name; null: all of them. */
  scope: readonly string[] | null;
  tags: readonly string[];
  results: readonly ExpectedResult[];
  /**
   * For a Question its scope can't answer: why it must be refused, and the amounts the
   * Documents state, which an Answer may still give as they are. It then has no results.
   */
  refuse?: { why: string; stated: readonly ExpectedInput[] };
  /** Over a workbook's or a survey's rows: for the Analysis issues (#447, #448), kept out of the bars. */
  analysis?: boolean;
}

const RATE_TOLERANCE = 0.0006;
const AMOUNT_TOLERANCE = 0.003;

const input = (
  document: string,
  unit: number | null,
  quote: string,
  number: string,
  value: number,
  extra: Pick<ExpectedInput, "unitQuote" | "rate"> = {},
): ExpectedInput => ({ document, unit, quote, number, value, ...extra });

type Inputs = Readonly<Record<string, ExpectedInput>>;

function derived(
  label: string,
  unit: ExpectedUnit,
  inputs: Inputs,
  formula: string,
  compute: (values: Readonly<Record<string, number>>) => number,
  traps: ExpectedResult["traps"] = [],
  alsoAccepted?: readonly ExpectedInput[],
): ExpectedResult {
  const values = Object.fromEntries(
    Object.entries(inputs).map(([name, each]) => [name, each.value]),
  );
  const value = compute(values);
  return {
    label,
    unit,
    value,
    tolerance:
      unit === "percent" || unit === "points" ? RATE_TOLERANCE : AMOUNT_TOLERANCE * Math.abs(value),
    kind: "derived",
    inputs,
    ...(alsoAccepted && { alsoAccepted }),
    formula,
    traps,
  };
}

const v = (values: Readonly<Record<string, number>>, name: string): number => {
  const found = values[name];
  if (found === undefined) throw new Error(`No input named ${name}.`);
  return found;
};

const growth = (
  label: string,
  now: ExpectedInput,
  before: ExpectedInput,
  traps: ExpectedResult["traps"] = [],
) =>
  derived(
    label,
    "percent",
    { now, before },
    "now / before - 1",
    (x) => v(x, "now") / v(x, "before") - 1,
    traps,
  );

const share = (
  label: string,
  part: ExpectedInput,
  whole: ExpectedInput,
  alsoAccepted?: readonly ExpectedInput[],
) =>
  derived(
    label,
    "percent",
    { part, whole },
    "part / whole",
    (x) => v(x, "part") / v(x, "whole"),
    [],
    alsoAccepted,
  );

const difference = (
  label: string,
  unit: ExpectedUnit,
  a: ExpectedInput,
  b: ExpectedInput,
  traps: ExpectedResult["traps"] = [],
) => derived(label, unit, { a, b }, "a - b", (x) => v(x, "a") - v(x, "b"), traps);

/** A margin's change in percentage points: (p1 / r1) − (p0 / r0). */
const marginChange = (
  label: string,
  p1: ExpectedInput,
  r1: ExpectedInput,
  p0: ExpectedInput,
  r0: ExpectedInput,
) =>
  derived(
    label,
    "points",
    { p1, r1, p0, r0 },
    "p1 / r1 - p0 / r0",
    (x) => v(x, "p1") / v(x, "r1") - v(x, "p0") / v(x, "r0"),
  );

const quoted = (
  label: string,
  unit: ExpectedUnit,
  stated: ExpectedInput,
  traps: ExpectedResult["traps"],
): ExpectedResult => ({
  label,
  unit,
  value: stated.value,
  tolerance:
    unit === "percent" || unit === "points"
      ? RATE_TOLERANCE
      : AMOUNT_TOLERANCE * Math.abs(stated.value),
  kind: "quoted",
  inputs: { stated },
  formula: "",
  traps,
});

const M = 1e6;
const WAN = 1e4;
const YI = 1e8;

const NW_IS = "Consolidated income statement (in millions of US dollars)";
const NW_SEG = "Revenue by segment (in millions of US dollars)";
const NW_FIVE = "Five-year summary (in millions of US dollars)";
const NW_REVENUE = "Revenue 2,346.8 2,084.2";
const NW_EPS = "Diluted earnings per share ($) 3.11 2.52";
const NW_FIVE_REVENUE = "Revenue 1,512.3 1,688.9 1,901.6 2,084.2 2,346.8";

const nw = {
  rev25: input(NORTHWIND, 2, NW_REVENUE, "2,346.8", 2346.8 * M, { unitQuote: NW_IS }),
  rev24: input(NORTHWIND, 2, NW_REVENUE, "2,084.2", 2084.2 * M, { unitQuote: NW_IS }),
  rev24Original: input(
    NORTHWIND,
    3,
    "2024 revenue as originally reported $2,112.5 million",
    "$2,112.5 million",
    2112.5 * M,
  ),
  cos25: input(NORTHWIND, 2, "Cost of sales (1,384.6) (1,250.5)", "(1,384.6)", -1384.6 * M, {
    unitQuote: NW_IS,
  }),
  gp25: input(NORTHWIND, 2, "Gross profit 962.2 833.7", "962.2", 962.2 * M, { unitQuote: NW_IS }),
  gp24: input(NORTHWIND, 2, "Gross profit 962.2 833.7", "833.7", 833.7 * M, { unitQuote: NW_IS }),
  op25: input(NORTHWIND, 2, "Operating profit 390.3 310.1", "390.3", 390.3 * M, {
    unitQuote: NW_IS,
  }),
  op24: input(NORTHWIND, 2, "Operating profit 390.3 310.1", "310.1", 310.1 * M, {
    unitQuote: NW_IS,
  }),
  ni25: input(NORTHWIND, 2, "Net income 268.4 214.9", "268.4", 268.4 * M, { unitQuote: NW_IS }),
  ni24: input(NORTHWIND, 2, "Net income 268.4 214.9", "214.9", 214.9 * M, { unitQuote: NW_IS }),
  eps25: input(NORTHWIND, 2, NW_EPS, "3.11", 3.11, { unitQuote: NW_EPS }),
  eps24: input(NORTHWIND, 2, NW_EPS, "2.52", 2.52, { unitQuote: NW_EPS }),
  sensors25: input(NORTHWIND, 3, "Sensors 1,102.4 948.7", "1,102.4", 1102.4 * M, {
    unitQuote: NW_SEG,
  }),
  controls25: input(NORTHWIND, 3, "Controls 821.0 760.3", "821.0", 821.0 * M, {
    unitQuote: NW_SEG,
  }),
  controls24: input(NORTHWIND, 3, "Controls 821.0 760.3", "760.3", 760.3 * M, {
    unitQuote: NW_SEG,
  }),
  services25: input(NORTHWIND, 3, "Services 423.4 375.2", "423.4", 423.4 * M, {
    unitQuote: NW_SEG,
  }),
  services24: input(NORTHWIND, 3, "Services 423.4 375.2", "375.2", 375.2 * M, {
    unitQuote: NW_SEG,
  }),
  rev21: input(NORTHWIND, 4, NW_FIVE_REVENUE, "1,512.3", 1512.3 * M, { unitQuote: NW_FIVE }),
  rev23: input(NORTHWIND, 4, NW_FIVE_REVENUE, "1,901.6", 1901.6 * M, { unitQuote: NW_FIVE }),
  rev24Five: input(NORTHWIND, 4, NW_FIVE_REVENUE, "2,084.2", 2084.2 * M, { unitQuote: NW_FIVE }),
  rev25Five: input(NORTHWIND, 4, NW_FIVE_REVENUE, "2,346.8", 2346.8 * M, { unitQuote: NW_FIVE }),
  organic: input(
    NORTHWIND,
    1,
    "the Telsen acquisition and currency movements, was 9.8%.",
    "9.8%",
    0.098,
  ),
};

const DECK_BOOKINGS = "Bookings by region ($ millions)";
const DECK_CHART = "Quarterly revenue 2025 ($ millions)";
const CHART_LINE = "Q1: 541.2, Q2: 566.9, Q3: 597.3, Q4: 641.4";
const deck = {
  americas24: input(NORTHWIND_DECK, 2, "Americas 812.4 905.1", "812.4", 812.4 * M, {
    unitQuote: DECK_BOOKINGS,
  }),
  americas25: input(NORTHWIND_DECK, 2, "Americas 812.4 905.1", "905.1", 905.1 * M, {
    unitQuote: DECK_BOOKINGS,
  }),
  emea24: input(NORTHWIND_DECK, 2, "EMEA 640.2 702.8", "640.2", 640.2 * M, {
    unitQuote: DECK_BOOKINGS,
  }),
  emea25: input(NORTHWIND_DECK, 2, "EMEA 640.2 702.8", "702.8", 702.8 * M, {
    unitQuote: DECK_BOOKINGS,
  }),
  apac24: input(NORTHWIND_DECK, 2, "APAC 455.9 561.7", "455.9", 455.9 * M, {
    unitQuote: DECK_BOOKINGS,
  }),
  apac25: input(NORTHWIND_DECK, 2, "APAC 455.9 561.7", "561.7", 561.7 * M, {
    unitQuote: DECK_BOOKINGS,
  }),
  q1: input(NORTHWIND_DECK, 3, CHART_LINE, "541.2", 541.2 * M, { unitQuote: DECK_CHART }),
  q2: input(NORTHWIND_DECK, 3, CHART_LINE, "566.9", 566.9 * M, { unitQuote: DECK_CHART }),
  q3: input(NORTHWIND_DECK, 3, CHART_LINE, "597.3", 597.3 * M, { unitQuote: DECK_CHART }),
  q4: input(NORTHWIND_DECK, 3, CHART_LINE, "641.4", 641.4 * M, { unitQuote: DECK_CHART }),
};

const KESTREL_UNIT = "All amounts in US$ millions unless stated otherwise.";
const ks = {
  sales25: input(KESTREL, 1, "Full-year net sales 1,186.4 (2024: 1,092.7)", "1,186.4", 1186.4 * M, {
    unitQuote: KESTREL_UNIT,
  }),
  sales24: input(KESTREL, 1, "Full-year net sales 1,186.4 (2024: 1,092.7)", "1,092.7", 1092.7 * M, {
    unitQuote: KESTREL_UNIT,
  }),
  op25: input(KESTREL, 1, "Full-year operating income 142.9 (2024: 121.6)", "142.9", 142.9 * M, {
    unitQuote: KESTREL_UNIT,
  }),
  q4: input(
    KESTREL,
    1,
    "Fourth-quarter net sales 318.2 (fourth quarter 2024: 296.5)",
    "318.2",
    318.2 * M,
    { unitQuote: KESTREL_UNIT },
  ),
  q4Before: input(
    KESTREL,
    1,
    "Fourth-quarter net sales 318.2 (fourth quarter 2024: 296.5)",
    "296.5",
    296.5 * M,
    { unitQuote: KESTREL_UNIT },
  ),
};

const rate = {
  average: input(RATES, 1, "Average rate for 2025: 1 US dollar = 7.1530 yuan", "7.1530", 7.153, {
    rate: "CNY per USD",
  }),
  yearEnd: input(
    RATES,
    1,
    "Rate at 31 December 2025: 1 US dollar = 7.0986 yuan",
    "7.0986",
    7.0986,
    { rate: "CNY per USD" },
  ),
};

const YF_IS = "单位：万元 币种：人民币";
// The PDF's text runs the table's title and its unit line together, as the app reads it.
const YF_Q = "分季度主要财务数据单位：万元";
const YF_Q25 = "2025年营业收入 78,402.16 86,915.33 91,230.58 100,264.38";
const YF_Q24 = "2024年营业收入 66,105.42 73,880.19 76,412.95 85,221.81";
const yf = {
  rev25: input(YUNFAN, 2, "营业收入 356,812.45 301,620.37", "356,812.45", 356812.45 * WAN, {
    unitQuote: YF_IS,
  }),
  rev24: input(YUNFAN, 2, "营业收入 356,812.45 301,620.37", "301,620.37", 301620.37 * WAN, {
    unitQuote: YF_IS,
  }),
  cost25: input(YUNFAN, 2, "营业成本 241,906.83 209,513.06", "241,906.83", 241906.83 * WAN, {
    unitQuote: YF_IS,
  }),
  cost24: input(YUNFAN, 2, "营业成本 241,906.83 209,513.06", "209,513.06", 209513.06 * WAN, {
    unitQuote: YF_IS,
  }),
  selling25: input(YUNFAN, 2, "销售费用 18,420.11 16,995.40", "18,420.11", 18420.11 * WAN, {
    unitQuote: YF_IS,
  }),
  rd25: input(YUNFAN, 2, "研发费用 28,544.99 22,129.64", "28,544.99", 28544.99 * WAN, {
    unitQuote: YF_IS,
  }),
  np25: input(YUNFAN, 2, "净利润 30,118.26 24,755.03", "30,118.26", 30118.26 * WAN, {
    unitQuote: YF_IS,
  }),
  np24: input(YUNFAN, 2, "净利润 30,118.26 24,755.03", "24,755.03", 24755.03 * WAN, {
    unitQuote: YF_IS,
  }),
  q1: input(YUNFAN, 3, YF_Q25, "78,402.16", 78402.16 * WAN, { unitQuote: YF_Q }),
  q2: input(YUNFAN, 3, YF_Q25, "86,915.33", 86915.33 * WAN, { unitQuote: YF_Q }),
  q3: input(YUNFAN, 3, YF_Q25, "91,230.58", 91230.58 * WAN, { unitQuote: YF_Q }),
  q4: input(YUNFAN, 3, YF_Q25, "100,264.38", 100264.38 * WAN, { unitQuote: YF_Q }),
  q1Before: input(YUNFAN, 3, YF_Q24, "66,105.42", 66105.42 * WAN, { unitQuote: YF_Q }),
  q3Before: input(YUNFAN, 3, YF_Q24, "76,412.95", 76412.95 * WAN, { unitQuote: YF_Q }),
  q4Before: input(YUNFAN, 3, YF_Q24, "85,221.81", 85221.81 * WAN, { unitQuote: YF_Q }),
  comparable: input(
    YUNFAN,
    1,
    "报告期内，按可比口径计算，公司营业收入同比增长百分之十二点四。",
    "百分之十二点四",
    0.124,
  ),
};

const QL_UNIT = "单位：万元";
const ql = {
  rev25: input(QINGLAN, 1, "营业总收入 862,315.40 790,442.18", "862,315.40", 862315.4 * WAN, {
    unitQuote: QL_UNIT,
  }),
  rev24: input(QINGLAN, 1, "营业总收入 862,315.40 790,442.18", "790,442.18", 790442.18 * WAN, {
    unitQuote: QL_UNIT,
  }),
  np25: input(
    QINGLAN,
    1,
    "归属于上市公司股东的净利润 61,208.77 55,130.02",
    "61,208.77",
    61208.77 * WAN,
    { unitQuote: QL_UNIT },
  ),
  np24: input(
    QINGLAN,
    1,
    "归属于上市公司股东的净利润 61,208.77 55,130.02",
    "55,130.02",
    55130.02 * WAN,
    { unitQuote: QL_UNIT },
  ),
};

const ht = {
  rev26: input(HUATUO, null, "营业收入（亿元） 14.86 12.73", "14.86", 14.86 * YI, {
    unitQuote: "营业收入（亿元）",
  }),
  rev25: input(HUATUO, null, "营业收入（亿元） 14.86 12.73", "12.73", 12.73 * YI, {
    unitQuote: "营业收入（亿元）",
  }),
  volume26: input(HUATUO, null, "货运量（万吨） 382.5 351.8", "382.5", 382.5),
  volume25: input(HUATUO, null, "货运量（万吨） 382.5 351.8", "351.8", 351.8),
  other: input(HUATUO, null, "本季度其他收益为1.2亿元¹，主要为政府补助。", "1.2亿元¹", 1.2 * YI),
  oneOff: input(HUATUO, null, "其中一次性搬迁补偿0.45亿元，不具有持续性。", "0.45亿元", 0.45 * YI),
};

const RESTATED = "2024 as originally reported ($2,112.5 million), not as restated";
const REPORTED_GROWTH = "Revenue growth as reported, not on the comparable basis asked for";

const english: CalculationCase[] = [
  {
    id: "en-01",
    language: "en",
    question: "How much did Northwind Instruments' revenue grow in 2025?",
    scope: null,
    tags: ["growth", "restated"],
    results: [
      growth("Revenue growth 2025", nw.rev25, nw.rev24, [
        { value: 2346.8 / 2112.5 - 1, why: RESTATED },
      ]),
    ],
  },
  {
    id: "en-02",
    language: "en",
    question:
      "What was Northwind Instruments' gross margin in 2025, and how many percentage points did it change from 2024?",
    scope: null,
    tags: ["share", "points", "multi-part"],
    results: [
      share("Gross margin 2025", nw.gp25, nw.rev25),
      marginChange("Gross margin change 2025", nw.gp25, nw.rev25, nw.gp24, nw.rev24),
    ],
  },
  {
    id: "en-03",
    language: "en",
    question: "What was Northwind Instruments' operating margin in 2025 and in 2024?",
    scope: null,
    tags: ["share", "multi-part"],
    results: [
      share("Operating margin 2025", nw.op25, nw.rev25),
      share("Operating margin 2024", nw.op24, nw.rev24),
    ],
  },
  {
    id: "en-04",
    language: "en",
    question:
      "What was Northwind Instruments' compound annual growth rate of revenue from 2021 to 2025?",
    scope: null,
    tags: ["cagr"],
    results: [
      derived(
        "Revenue CAGR 2021–2025",
        "percent",
        { start: nw.rev21, end: nw.rev25Five },
        "RRI(4, start, end)",
        (x) => (v(x, "end") / v(x, "start")) ** (1 / 4) - 1,
        [
          {
            value: (2346.8 / 1512.3 - 1) / 4,
            why: "Total growth divided by four years, not compounded",
          },
          { value: 2346.8 / 1512.3 - 1, why: "Total growth over the four years" },
        ],
        [nw.rev25],
      ),
    ],
  },
  {
    id: "en-05",
    language: "en",
    question:
      "What share of Northwind's 2025 revenue came from Sensors, and did Services grow faster than Controls? Give both growth rates.",
    scope: null,
    tags: ["share", "growth", "multi-part"],
    results: [
      share("Sensors share of revenue 2025", nw.sensors25, nw.rev25),
      growth("Services growth 2025", nw.services25, nw.services24),
      growth("Controls growth 2025", nw.controls25, nw.controls24),
    ],
  },
  {
    id: "en-06",
    language: "en",
    question: "What was Northwind Instruments' organic revenue growth in 2025?",
    scope: null,
    tags: ["quoted-trap"],
    results: [
      quoted("Organic revenue growth 2025", "percent", nw.organic, [
        { value: 2346.8 / 2084.2 - 1, why: REPORTED_GROWTH },
      ]),
    ],
  },
  {
    id: "en-07",
    language: "en",
    question:
      "By how much, in dollars and in percent, did Northwind Instruments' net income rise in 2025?",
    scope: null,
    tags: ["change", "growth", "multi-part"],
    results: [
      difference("Net income increase 2025", "USD", nw.ni25, nw.ni24),
      growth("Net income growth 2025", nw.ni25, nw.ni24),
    ],
  },
  {
    id: "en-08",
    language: "en",
    question:
      "How much lower is Northwind's restated 2024 revenue than the figure originally reported?",
    scope: null,
    tags: ["change", "restated"],
    results: [difference("Restatement of 2024 revenue", "USD", nw.rev24Original, nw.rev24)],
  },
  {
    id: "en-09",
    language: "en",
    question: "How much did Northwind's diluted earnings per share grow in 2025?",
    scope: null,
    tags: ["growth"],
    results: [growth("Diluted EPS growth 2025", nw.eps25, nw.eps24)],
  },
  {
    id: "en-10",
    language: "en",
    question: "What was Northwind Instruments' cost of sales as a percentage of revenue in 2025?",
    scope: null,
    tags: ["share", "sign"],
    results: [
      derived(
        "Cost of sales to revenue 2025",
        "percent",
        { cost: nw.cos25, revenue: nw.rev25 },
        "ABS(cost) / revenue",
        (x) => Math.abs(v(x, "cost")) / v(x, "revenue"),
      ),
    ],
  },
  {
    id: "en-11",
    language: "en",
    question: "How much did Northwind's APAC bookings grow from FY2024 to FY2025?",
    scope: null,
    tags: ["growth", "deck"],
    results: [growth("APAC bookings growth FY2025", deck.apac25, deck.apac24)],
  },
  {
    id: "en-12",
    language: "en",
    question:
      "What were Northwind's total bookings across all regions in FY2025, and how much did they grow from FY2024?",
    scope: null,
    tags: ["sum", "growth", "deck", "multi-part"],
    results: [
      derived(
        "Total bookings FY2025",
        "USD",
        { a: deck.americas25, e: deck.emea25, p: deck.apac25 },
        "SUM(a, e, p)",
        (x) => v(x, "a") + v(x, "e") + v(x, "p"),
      ),
      derived(
        "Total bookings growth FY2025",
        "percent",
        {
          a: deck.americas25,
          e: deck.emea25,
          p: deck.apac25,
          a0: deck.americas24,
          e0: deck.emea24,
          p0: deck.apac24,
        },
        "SUM(a, e, p) / SUM(a0, e0, p0) - 1",
        (x) => (v(x, "a") + v(x, "e") + v(x, "p")) / (v(x, "a0") + v(x, "e0") + v(x, "p0")) - 1,
      ),
    ],
  },
  {
    id: "en-13",
    language: "en",
    question:
      "By what percentage did Northwind's revenue grow from the third quarter to the fourth quarter of 2025?",
    scope: null,
    tags: ["growth", "deck", "chart"],
    results: [growth("Revenue growth Q4 on Q3 2025", deck.q4, deck.q3)],
  },
  {
    id: "en-14",
    language: "en",
    question: "What share of Northwind's 2025 revenue was earned in the fourth quarter?",
    scope: null,
    tags: ["share", "deck", "chart"],
    results: [
      share("Q4 share of 2025 revenue", deck.q4, nw.rev25, [
        deck.q1,
        deck.q2,
        deck.q3,
        nw.rev25Five,
      ]),
    ],
  },
  {
    id: "en-15",
    language: "en",
    question:
      "How much larger were Northwind's Americas bookings than its EMEA bookings in FY2025?",
    scope: null,
    tags: ["change", "deck"],
    results: [
      difference("Americas over EMEA bookings FY2025", "USD", deck.americas25, deck.emea25),
    ],
  },
  {
    id: "en-16",
    language: "en",
    question: "How much did Kestrel Foods' net sales grow in 2025?",
    scope: null,
    tags: ["growth"],
    results: [growth("Net sales growth 2025", ks.sales25, ks.sales24)],
  },
  {
    id: "en-17",
    language: "en",
    question: "What was Kestrel Foods' operating margin in 2025?",
    scope: null,
    tags: ["share"],
    results: [share("Operating margin 2025", ks.op25, ks.sales25)],
  },
  {
    id: "en-18",
    language: "en",
    question: "How much did Kestrel Foods' fourth-quarter net sales grow year on year?",
    scope: null,
    tags: ["growth"],
    results: [growth("Q4 net sales growth", ks.q4, ks.q4Before)],
  },
  {
    id: "en-19",
    language: "en",
    question:
      "Were Kestrel Foods' 2025 net sales larger than Qinglan Foods' 2025 revenue, and by how much?",
    scope: [KESTREL, QINGLAN],
    tags: ["cross-currency", "refusal"],
    results: [],
    refuse: {
      why: "The two are in US dollars and in yuan, and no Document in scope gives an exchange rate.",
      stated: [ks.sales25, ks.sales24, ql.rev25, ql.rev24],
    },
  },
  {
    id: "en-20",
    language: "en",
    question:
      "Using the 2025 average rate in the reference exchange rates, what was Qinglan Foods' 2025 revenue in US dollars, and how much larger or smaller was it than Kestrel Foods' 2025 net sales?",
    scope: [KESTREL, QINGLAN, RATES],
    tags: ["cross-currency", "multi-part"],
    results: [
      derived(
        "Qinglan revenue 2025 in USD",
        "USD",
        { yuan: ql.rev25, rate: rate.average },
        "yuan / rate",
        (x) => v(x, "yuan") / v(x, "rate"),
      ),
      derived(
        "Qinglan over Kestrel 2025",
        "USD",
        { yuan: ql.rev25, rate: rate.average, kestrel: ks.sales25 },
        "yuan / rate - kestrel",
        (x) => v(x, "yuan") / v(x, "rate") - v(x, "kestrel"),
        [
          {
            value: 862315.4 * WAN - 1186.4 * M,
            why: "Yuan and dollars subtracted without converting",
          },
        ],
      ),
    ],
  },
  {
    id: "en-21",
    language: "en",
    question:
      "What was Qinglan Foods' 2025 net profit attributable to shareholders in US dollars at the rate on 31 December 2025?",
    scope: [QINGLAN, RATES],
    tags: ["cross-currency", "scale"],
    results: [
      derived(
        "Qinglan net profit 2025 in USD",
        "USD",
        { yuan: ql.np25, rate: rate.yearEnd },
        "yuan / rate",
        (x) => v(x, "yuan") / v(x, "rate"),
        [
          {
            value: (61208.77 * WAN) / 7.153,
            why: "The average rate, not the year-end rate asked for",
          },
        ],
      ),
    ],
  },
  {
    id: "en-22",
    language: "en",
    question: "How much was Yunfan Electronics' 2025 revenue in US dollars?",
    scope: [YUNFAN],
    tags: ["cross-currency", "refusal"],
    results: [],
    refuse: {
      why: "The report is in yuan and no Document in scope gives an exchange rate.",
      stated: [yf.rev25, yf.rev24, yf.q1, yf.q2, yf.q3, yf.q4],
    },
  },
  {
    id: "en-23",
    language: "en",
    question: "How much did Yunfan Electronics' revenue grow in 2025, as reported?",
    scope: null,
    tags: ["growth", "cross-lingual"],
    results: [
      growth("Revenue growth 2025", yf.rev25, yf.rev24, [
        {
          value: 0.124,
          why: "The comparable-basis rate the chair states, not the reported growth",
        },
      ]),
    ],
  },
  {
    id: "en-24",
    language: "en",
    question: "What was Yunfan Electronics' 2025 revenue in billions of yuan?",
    scope: null,
    tags: ["scale", "cross-lingual"],
    results: [
      derived("Revenue 2025", "CNY", { revenue: yf.rev25 }, "revenue", (x) => v(x, "revenue"), [
        { value: 356812.45, why: "The 万元 figure read as yuan" },
        { value: 356812.45 * 1e8, why: "The 万元 figure read as 亿元" },
      ]),
    ],
  },
  {
    id: "en-25",
    language: "en",
    question:
      "By what percentage did Yunfan Electronics' revenue grow from the third to the fourth quarter of 2025?",
    scope: null,
    tags: ["growth", "sequential", "cross-lingual"],
    results: [
      growth("Revenue growth Q4 on Q3 2025", yf.q4, yf.q3, [
        {
          value: 100264.38 / 85221.81 - 1,
          why: "Year on year (同比), not quarter on quarter (环比)",
        },
      ]),
    ],
  },
  {
    id: "en-26",
    language: "en",
    question:
      "What was Yunfan Electronics' research and development expense as a share of revenue in 2025?",
    scope: null,
    tags: ["share", "cross-lingual"],
    results: [share("R&D to revenue 2025", yf.rd25, yf.rev25)],
  },
  {
    id: "en-27",
    language: "en",
    question:
      "How much did Huatuo Logistics' freight volume grow in the third quarter of 2026 year on year?",
    scope: null,
    tags: ["growth", "word", "cross-lingual"],
    results: [growth("Freight volume growth Q3 2026", ht.volume26, ht.volume25)],
  },
  {
    id: "en-28",
    language: "en",
    question:
      "What was Huatuo Logistics' other income in the third quarter of 2026 without the one-off relocation compensation?",
    scope: null,
    tags: ["change", "word", "footnote", "cross-lingual"],
    results: [
      difference("Other income without the one-off item", "CNY", ht.other, ht.oneOff, [
        { value: 1.2 * YI, why: "The footnoted figure as stated, its one-off part left in" },
      ]),
    ],
  },
  {
    id: "en-29",
    language: "en",
    question: "How much did Qinglan Foods' net profit attributable to shareholders grow in 2025?",
    scope: null,
    tags: ["growth", "cross-lingual"],
    results: [growth("Net profit growth 2025", ql.np25, ql.np24)],
  },
  {
    id: "en-30",
    language: "en",
    question: "On a comparable basis, how much did Yunfan Electronics' revenue grow in 2025?",
    scope: null,
    tags: ["quoted-trap", "cross-lingual"],
    results: [
      quoted("Comparable revenue growth 2025", "percent", yf.comparable, [
        { value: 356812.45 / 301620.37 - 1, why: REPORTED_GROWTH },
      ]),
    ],
  },
  {
    id: "en-31",
    language: "en",
    question:
      "By how many percentage points did Northwind Instruments' operating margin improve in 2025?",
    scope: null,
    tags: ["points"],
    results: [
      {
        ...marginChange("Operating margin change 2025", nw.op25, nw.rev25, nw.op24, nw.rev24),
        traps: [
          { value: 390.3 / 310.1 - 1, why: "Operating profit growth, not the margin's change" },
        ],
      },
    ],
  },
  {
    id: "en-32",
    language: "en",
    question: "How fast did Northwind's Services segment grow in 2025?",
    scope: null,
    tags: ["growth"],
    results: [growth("Services growth 2025", nw.services25, nw.services24)],
  },
  {
    id: "en-33",
    language: "en",
    question:
      "How much did Northwind Instruments' revenue grow in 2024, according to its five-year summary?",
    scope: null,
    tags: ["growth"],
    results: [growth("Revenue growth 2024", nw.rev24Five, nw.rev23)],
  },
  {
    id: "en-34",
    language: "en",
    question: "What share of Kestrel Foods' 2025 net sales came in the fourth quarter?",
    scope: null,
    tags: ["share"],
    results: [share("Q4 share of 2025 net sales", ks.q4, ks.sales25)],
  },
  {
    id: "en-35",
    language: "en",
    question: "How much did Northwind Instruments' gross profit grow in 2025?",
    scope: null,
    tags: ["growth"],
    results: [growth("Gross profit growth 2025", nw.gp25, nw.gp24)],
  },
  {
    id: "en-36",
    language: "en",
    question: "How much did Northwind's EMEA bookings grow from FY2024 to FY2025?",
    scope: null,
    tags: ["growth", "deck"],
    results: [growth("EMEA bookings growth FY2025", deck.emea25, deck.emea24)],
  },
];

const chinese: CalculationCase[] = [
  {
    id: "zh-01",
    language: "zh",
    question: "云帆电子2025年营业收入同比增长多少？",
    scope: null,
    tags: ["growth"],
    results: [
      growth("2025年营业收入同比增长", yf.rev25, yf.rev24, [
        { value: 0.124, why: "按可比口径的增速，不是报告的增速" },
      ]),
    ],
  },
  {
    id: "zh-02",
    language: "zh",
    question: "云帆电子2025年营业收入比上年增加了多少万元？",
    scope: null,
    tags: ["change", "scale"],
    results: [
      difference("2025年营业收入增加额", "CNY", yf.rev25, yf.rev24, [
        { value: 356812.45 - 301620.37, why: "万元读成元" },
      ]),
    ],
  },
  {
    id: "zh-03",
    language: "zh",
    question: "云帆电子2025年的毛利率是多少？比2024年变动了多少个百分点？",
    scope: null,
    tags: ["share", "points", "multi-part"],
    results: [
      derived(
        "2025年毛利率",
        "percent",
        { revenue: yf.rev25, cost: yf.cost25 },
        "(revenue - cost) / revenue",
        (x) => (v(x, "revenue") - v(x, "cost")) / v(x, "revenue"),
      ),
      derived(
        "毛利率变动",
        "points",
        { r1: yf.rev25, c1: yf.cost25, r0: yf.rev24, c0: yf.cost24 },
        "(r1 - c1) / r1 - (r0 - c0) / r0",
        (x) => (v(x, "r1") - v(x, "c1")) / v(x, "r1") - (v(x, "r0") - v(x, "c0")) / v(x, "r0"),
      ),
    ],
  },
  {
    id: "zh-04",
    language: "zh",
    question: "云帆电子2025年研发费用占营业收入的比例是多少？",
    scope: null,
    tags: ["share"],
    results: [share("2025年研发费用率", yf.rd25, yf.rev25)],
  },
  {
    id: "zh-05",
    language: "zh",
    question: "云帆电子2025年第四季度营业收入环比增长多少？",
    scope: null,
    tags: ["growth", "sequential"],
    results: [
      growth("第四季度营业收入环比增长", yf.q4, yf.q3, [
        { value: 100264.38 / 85221.81 - 1, why: "算成了同比，不是环比" },
      ]),
    ],
  },
  {
    id: "zh-06",
    language: "zh",
    question: "云帆电子2025年第三季度营业收入同比增长多少？",
    scope: null,
    tags: ["growth", "year-on-year"],
    results: [
      growth("第三季度营业收入同比增长", yf.q3, yf.q3Before, [
        { value: 91230.58 / 86915.33 - 1, why: "算成了环比，不是同比" },
      ]),
    ],
  },
  {
    id: "zh-07",
    language: "zh",
    question: "按可比口径，云帆电子2025年营业收入同比增长多少？",
    scope: null,
    tags: ["quoted-trap"],
    results: [
      quoted("可比口径营业收入同比增长", "percent", yf.comparable, [
        { value: 356812.45 / 301620.37 - 1, why: "报告的增速，不是可比口径" },
      ]),
    ],
  },
  {
    id: "zh-08",
    language: "zh",
    question: "云帆电子2025年净利润同比增长多少？",
    scope: null,
    tags: ["growth"],
    results: [growth("2025年净利润同比增长", yf.np25, yf.np24)],
  },
  {
    id: "zh-09",
    language: "zh",
    question: "云帆电子2025年营业收入合计多少亿元？",
    scope: null,
    tags: ["scale"],
    results: [
      derived("2025年营业收入", "CNY", { revenue: yf.rev25 }, "revenue", (x) => v(x, "revenue"), [
        { value: 356812.45 * YI, why: "万元读成亿元" },
        { value: 356812.45, why: "万元读成元" },
      ]),
    ],
  },
  {
    id: "zh-10",
    language: "zh",
    question: "云帆电子2025年的净利率是多少？",
    scope: null,
    tags: ["share"],
    results: [share("2025年净利率", yf.np25, yf.rev25)],
  },
  {
    id: "zh-11",
    language: "zh",
    question: "华拓物流2026年第三季度营业收入同比增长多少？",
    scope: null,
    tags: ["growth", "word"],
    results: [growth("三季度营业收入同比增长", ht.rev26, ht.rev25)],
  },
  {
    id: "zh-12",
    language: "zh",
    question: "华拓物流2026年第三季度货运量同比增长多少？",
    scope: null,
    tags: ["growth", "word"],
    results: [growth("三季度货运量同比增长", ht.volume26, ht.volume25)],
  },
  {
    id: "zh-13",
    language: "zh",
    question: "华拓物流本季度扣除一次性搬迁补偿后的其他收益是多少？",
    scope: null,
    tags: ["change", "word", "footnote"],
    results: [
      difference("扣除一次性补偿后的其他收益", "CNY", ht.other, ht.oneOff, [
        { value: 1.2 * YI, why: "只引用了带脚注的数字，没有扣除一次性部分" },
      ]),
    ],
  },
  {
    id: "zh-14",
    language: "zh",
    question: "华拓物流本季度其他收益占营业收入的比例是多少？",
    scope: null,
    tags: ["share", "word", "footnote"],
    results: [share("其他收益占营业收入比例", ht.other, ht.rev26)],
  },
  {
    id: "zh-15",
    language: "zh",
    question: "华拓物流2026年第三季度营业收入比上年同期增加了多少亿元？",
    scope: null,
    tags: ["change", "word"],
    results: [difference("三季度营业收入增加额", "CNY", ht.rev26, ht.rev25)],
  },
  {
    id: "zh-16",
    language: "zh",
    question: "青岚食品2025年营业总收入同比增长多少？",
    scope: null,
    tags: ["growth"],
    results: [growth("2025年营业总收入同比增长", ql.rev25, ql.rev24)],
  },
  {
    id: "zh-17",
    language: "zh",
    question: "青岚食品2025年归属于上市公司股东的净利润比上年增加了多少万元？",
    scope: null,
    tags: ["change"],
    results: [difference("净利润增加额", "CNY", ql.np25, ql.np24)],
  },
  {
    id: "zh-18",
    language: "zh",
    question: "青岚食品2025年的净利率（归母净利润除以营业总收入）是多少？",
    scope: null,
    tags: ["share"],
    results: [share("2025年净利率", ql.np25, ql.rev25)],
  },
  {
    id: "zh-19",
    language: "zh",
    question: "青岚食品2025年营业总收入和Kestrel Foods 2025年净销售额哪个大？大多少？",
    scope: [KESTREL, QINGLAN],
    tags: ["cross-currency", "refusal"],
    results: [],
    refuse: {
      why: "一个是人民币，一个是美元，范围内的文档都没有给出汇率。",
      stated: [ks.sales25, ks.sales24, ql.rev25, ql.rev24],
    },
  },
  {
    id: "zh-20",
    language: "zh",
    question:
      "按参考汇率文件中2025年的平均汇率，把Kestrel Foods 2025年的净销售额折算成人民币万元，和青岚食品2025年营业总收入相比，哪个大，大多少万元？",
    scope: [KESTREL, QINGLAN, RATES],
    tags: ["cross-currency", "multi-part"],
    results: [
      derived(
        "Kestrel净销售额折合人民币",
        "CNY",
        { usd: ks.sales25, rate: rate.average },
        "usd * rate",
        (x) => v(x, "usd") * v(x, "rate"),
      ),
      derived(
        "青岚高出Kestrel的金额",
        "CNY",
        { yuan: ql.rev25, usd: ks.sales25, rate: rate.average },
        "yuan - usd * rate",
        (x) => v(x, "yuan") - v(x, "usd") * v(x, "rate"),
        [{ value: 862315.4 * WAN - 1186.4 * M, why: "美元和人民币没有折算就相减" }],
      ),
    ],
  },
  {
    id: "zh-21",
    language: "zh",
    question: "按2025年12月31日的汇率，Kestrel Foods 2025年净销售额折合人民币多少亿元？",
    scope: [KESTREL, RATES],
    tags: ["cross-currency", "scale"],
    results: [
      derived(
        "Kestrel净销售额折合人民币",
        "CNY",
        { usd: ks.sales25, rate: rate.yearEnd },
        "usd * rate",
        (x) => v(x, "usd") * v(x, "rate"),
        [{ value: 1186.4 * M * 7.153, why: "用了平均汇率，不是年末汇率" }],
      ),
    ],
  },
  {
    id: "zh-22",
    language: "zh",
    question: "Northwind Instruments 2025年收入同比增长多少？",
    scope: null,
    tags: ["growth", "restated", "cross-lingual"],
    results: [
      growth("2025年收入增长", nw.rev25, nw.rev24, [
        { value: 2346.8 / 2112.5 - 1, why: "用了2024年原报告数，不是重述后的数" },
      ]),
    ],
  },
  {
    id: "zh-23",
    language: "zh",
    question: "Northwind Instruments 2025年毛利率比2024年变动了多少个百分点？",
    scope: null,
    tags: ["points", "cross-lingual"],
    results: [marginChange("毛利率变动", nw.gp25, nw.rev25, nw.gp24, nw.rev24)],
  },
  {
    id: "zh-24",
    language: "zh",
    question: "Northwind Instruments 2021年至2025年收入的年复合增长率是多少？",
    scope: null,
    tags: ["cagr", "cross-lingual"],
    results: [
      derived(
        "2021—2025年收入复合增长率",
        "percent",
        { start: nw.rev21, end: nw.rev25Five },
        "RRI(4, start, end)",
        (x) => (v(x, "end") / v(x, "start")) ** (1 / 4) - 1,
        [{ value: (2346.8 / 1512.3 - 1) / 4, why: "总增长除以四年，没有复合" }],
        [nw.rev25],
      ),
    ],
  },
  {
    id: "zh-25",
    language: "zh",
    question: "Northwind Instruments 2025年的有机收入增长是多少？",
    scope: null,
    tags: ["quoted-trap", "cross-lingual"],
    results: [
      quoted("2025年有机收入增长", "percent", nw.organic, [
        { value: 2346.8 / 2084.2 - 1, why: "报告的收入增速，不是有机增长" },
      ]),
    ],
  },
  {
    id: "zh-26",
    language: "zh",
    question: "Northwind 2025年第四季度收入环比增长多少？",
    scope: null,
    tags: ["growth", "sequential", "deck", "chart", "cross-lingual"],
    results: [growth("第四季度收入环比增长", deck.q4, deck.q3)],
  },
  {
    id: "zh-27",
    language: "zh",
    question: "Northwind 亚太区（APAC）FY2025的订单额同比增长多少？",
    scope: null,
    tags: ["growth", "deck", "cross-lingual"],
    results: [growth("亚太区订单同比增长", deck.apac25, deck.apac24)],
  },
  {
    id: "zh-28",
    language: "zh",
    question: "Kestrel Foods 2025年的营业利润率是多少？",
    scope: null,
    tags: ["share", "cross-lingual"],
    results: [share("2025年营业利润率", ks.op25, ks.sales25)],
  },
  {
    id: "zh-29",
    language: "zh",
    question: "Kestrel Foods 2025年净销售额比2024年增加了多少百万美元？",
    scope: null,
    tags: ["change", "cross-lingual"],
    results: [difference("净销售额增加额", "USD", ks.sales25, ks.sales24)],
  },
  {
    id: "zh-30",
    language: "zh",
    question: "Northwind Instruments 2025年净利润同比增长多少？",
    scope: null,
    tags: ["growth", "cross-lingual"],
    results: [growth("2025年净利润同比增长", nw.ni25, nw.ni24)],
  },
  {
    id: "zh-31",
    language: "zh",
    question: "云帆电子2025年第一季度营业收入同比增长多少？",
    scope: null,
    tags: ["growth", "year-on-year"],
    results: [growth("第一季度营业收入同比增长", yf.q1, yf.q1Before)],
  },
  {
    id: "zh-32",
    language: "zh",
    question: "云帆电子2025年销售费用占营业收入的比例是多少？",
    scope: null,
    tags: ["share"],
    results: [share("2025年销售费用率", yf.selling25, yf.rev25)],
  },
  {
    id: "zh-33",
    language: "zh",
    question: "云帆电子2025年的毛利是多少万元？",
    scope: null,
    tags: ["change", "scale"],
    results: [difference("2025年毛利", "CNY", yf.rev25, yf.cost25)],
  },
  {
    id: "zh-34",
    language: "zh",
    question: "云帆电子2025年人民币营业收入折合多少美元？",
    scope: [YUNFAN],
    tags: ["cross-currency", "refusal"],
    results: [],
    refuse: {
      why: "报告只有人民币金额，范围内的文档没有给出汇率。",
      stated: [yf.rev25, yf.rev24, yf.q1, yf.q2, yf.q3, yf.q4],
    },
  },
  {
    id: "zh-35",
    language: "zh",
    question: "青岚食品2024年的净利率（归母净利润除以营业总收入）是多少？",
    scope: null,
    tags: ["share"],
    results: [share("2024年净利率", ql.np24, ql.rev24)],
  },
  {
    id: "zh-36",
    language: "zh",
    question: "Northwind Instruments 2025年服务业务（Services）收入占总收入的比例是多少？",
    scope: null,
    tags: ["share", "cross-lingual"],
    results: [share("服务业务收入占比", nw.services25, nw.rev25)],
  },
];

const sumWhere = (keep: (row: (typeof SALES_ROWS)[number]) => boolean) =>
  SALES_ROWS.filter(keep).reduce((total, row) => total + revenueOf(row), 0);
const unitsOf = (product: string) =>
  SALES_ROWS.filter((row) => row.product === product).reduce(
    (total, row) => total + (typeof row.units === "number" ? row.units : 0),
    0,
  );
const listPrice = (product: string) => LIST_PRICES[PRODUCTS.indexOf(product)] as number;
const monthly = (region: string, month: number) =>
  sumWhere((row) => row.region === region && row.month === month);
const valid = SURVEY_RESPONSES;

/** An Analysis result: worked out from every row, so it names no input lines. */
const overRows = (label: string, unit: ExpectedUnit, value: number): ExpectedResult => ({
  label,
  unit,
  value,
  tolerance:
    unit === "percent" || unit === "points" ? RATE_TOLERANCE : AMOUNT_TOLERANCE * Math.abs(value),
  kind: "derived",
  inputs: {},
  formula: "",
  traps: [],
});

const NORTH = REGIONS[0];
const SOUTH = REGIONS[1];
const EAST = REGIONS[2];
const WEST = REGIONS[3];

const analysis: CalculationCase[] = [
  {
    id: "en-a1",
    language: "en",
    question:
      "In the Regional sales 2025 workbook, what was the North region's total revenue for the year?",
    scope: [SALES],
    tags: ["analysis", "total"],
    analysis: true,
    results: [
      overRows(
        "North revenue 2025",
        "USD",
        sumWhere((row) => row.region === NORTH),
      ),
    ],
  },
  {
    id: "en-a2",
    language: "en",
    question:
      "Using the Prices sheet of the Regional sales 2025 workbook, what were all P-007 units sold in 2025 worth at list price, before discounts?",
    scope: [SALES],
    tags: ["analysis", "join"],
    analysis: true,
    results: [overRows("P-007 units at list price", "USD", unitsOf("P-007") * listPrice("P-007"))],
  },
  {
    id: "en-a3",
    language: "en",
    question:
      "In the 2026 customer survey, what share of the valid responses gave a satisfaction score of 4 or 5?",
    scope: [SURVEY],
    tags: ["analysis", "survey"],
    analysis: true,
    results: [
      overRows(
        "Satisfied share",
        "percent",
        valid.filter((each) => each.satisfaction >= 4).length / valid.length,
      ),
    ],
  },
  {
    id: "en-a4",
    language: "en",
    question:
      "By what percentage did the East region's monthly revenue change from January to December 2025, in the Regional sales 2025 workbook?",
    scope: [SALES],
    tags: ["analysis", "trend"],
    analysis: true,
    results: [
      overRows(
        "East revenue December on January",
        "percent",
        monthly(EAST, 12) / monthly(EAST, 1) - 1,
      ),
    ],
  },
  {
    id: "zh-a1",
    language: "zh",
    question: "Regional sales 2025工作簿中，South区域2025年全年收入合计是多少美元？",
    scope: [SALES],
    tags: ["analysis", "total"],
    analysis: true,
    results: [
      overRows(
        "South区域全年收入",
        "USD",
        sumWhere((row) => row.region === SOUTH),
      ),
    ],
  },
  {
    id: "zh-a2",
    language: "zh",
    question:
      "根据Regional sales 2025工作簿的Prices表，P-012在2025年售出的全部数量按标价（不计折扣）计算值多少美元？",
    scope: [SALES],
    tags: ["analysis", "join"],
    analysis: true,
    results: [overRows("P-012按标价的金额", "USD", unitsOf("P-012") * listPrice("P-012"))],
  },
  {
    id: "zh-a3",
    language: "zh",
    question: "2026年客户调查中，有效回答里愿意推荐（recommend为yes）的占比是多少？",
    scope: [SURVEY],
    tags: ["analysis", "survey"],
    analysis: true,
    results: [
      overRows(
        "愿意推荐的占比",
        "percent",
        valid.filter((each) => each.recommend === "yes").length / valid.length,
      ),
    ],
  },
  {
    id: "zh-a4",
    language: "zh",
    question: "Regional sales 2025工作簿中，West区域2025年12月的收入比1月增长了多少？",
    scope: [SALES],
    tags: ["analysis", "trend"],
    analysis: true,
    results: [
      overRows("West区域12月比1月增长", "percent", monthly(WEST, 12) / monthly(WEST, 1) - 1),
    ],
  },
];

export const CALCULATION_CASES: readonly CalculationCase[] = [...english, ...chinese, ...analysis];
