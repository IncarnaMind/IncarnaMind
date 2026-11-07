/**
 * The figure reader (#434): a golden set of figures as English and Chinese
 * Documents write them, each read as a calculation needs it, and everything
 * the text alone can't settle flagged rather than read one way.
 *
 * Each case names every figure the text holds, in order: its characters as
 * written, its value with the scale applied, and whatever else it has (unit,
 * scale word, approximation, range, footnote, and what is ambiguous). A
 * figure that isn't expected, or an ambiguity that isn't, fails the case.
 */
import { describe, expect, test } from "vitest";
import { figuresInClaim, statedFigure } from "../../src/core/answers/checks/calculated";
import {
  type AmbiguityKind,
  currencyOnItsFigure,
  currencyScaleMarker,
  type Figure,
  type FigureContext,
  type FigureUnit,
  figureContextOf,
  readFigures,
  readStatedUnits,
  statesForWholeDocument,
  unsettledScales,
} from "../../src/shared/figures";

/**
 * What a case expects of one figure. `unit`: "%" a percent, "pp" points, "x"
 * times, an ISO 4217 code, or another unit's word; plain when left out.
 */
interface Expected {
  chars: string;
  value: number;
  unit?: string;
  scale?: string;
  approx?: true;
  to?: number;
  footnote?: string;
  ambiguous?: AmbiguityKind[];
}

const f = (
  chars: string,
  value: number,
  more: Omit<Expected, "chars" | "value"> = {},
): Expected => ({
  chars,
  value,
  ...more,
});

type Case = [text: string, figures: Expected[]];

const unitOf = (unit: FigureUnit): string | undefined => {
  switch (unit.kind) {
    case "plain":
      return undefined;
    case "percent":
      return "%";
    case "points":
      return "pp";
    case "times":
      return "x";
    case "currency":
      return unit.code;
    case "other":
      return unit.word;
  }
};

/** A figure in the shape cases are written in. */
const shape = (figure: Figure): Expected => ({
  chars: figure.chars,
  value: figure.value,
  unit: unitOf(figure.unit),
  scale: figure.scaleWord ?? undefined,
  approx: figure.approximate ? true : undefined,
  to: figure.rangeTo ?? undefined,
  footnote: figure.footnote ?? undefined,
  ambiguous: figure.ambiguous.length > 0 ? figure.ambiguous.map((each) => each.kind) : undefined,
});

const EN: FigureContext = { language: "en" };
const ZH: FigureContext = { language: "zh-CN" };

/** The golden set: groups of cases, each read with its group's context. */
const GOLDEN: { name: string; context: FigureContext; cases: Case[] }[] = [
  {
    name: "separators in an English Document",
    context: EN,
    cases: [
      ["1,234", [f("1,234", 1234)]],
      ["1,234.56", [f("1,234.56", 1234.56)]],
      ["12,345,678", [f("12,345,678", 12345678)]],
      ["1.234", [f("1.234", 1.234)]],
      ["0.5", [f("0.5", 0.5)]],
      ["1,234.5 and 2,000", [f("1,234.5", 1234.5), f("2,000", 2000)]],
      ["1,2,3", [f("1", 1), f("2", 2), f("3", 3)]],
      ["1.2.3", []],
      ["12 345", [f("12", 12), f("345", 345)]],
      ["12\u00a0345", [f("12\u00a0345", 12345)]],
      ["1,5", [f("1,5", 1.5, { ambiguous: ["separator"] })]],
      ["0,123", [f("0,123", 0.123, { ambiguous: ["separator"] })]],
      [".5%", [f(".5%", 0.005, { unit: "%" })]],
      ["12,34,567", [f("12,34,567", 1234567)]],
    ],
  },
  {
    name: "separators in a German Document",
    context: { language: "de" },
    cases: [
      ["1.234,56", [f("1.234,56", 1234.56)]],
      ["1.234", [f("1.234", 1234)]],
      ["1,234", [f("1,234", 1.234)]],
      ["3,5 %", [f("3,5 %", 0.035, { unit: "%" })]],
      ["1.234.567", [f("1.234.567", 1234567)]],
      ["1.5", [f("1.5", 1.5, { ambiguous: ["separator"] })]],
      ["1.234 €", [f("1.234 €", 1234, { unit: "EUR" })]],
      ["€1,234", [f("€1,234", 1.234, { unit: "EUR" })]],
    ],
  },
  {
    name: "separators in a French Document",
    context: { language: "fr" },
    cases: [
      ["1 234,5", [f("1 234,5", 1234.5)]],
      ["1 234 567", [f("1 234 567", 1234567)]],
      ["1\u202f234,5 €", [f("1\u202f234,5 €", 1234.5, { unit: "EUR" })]],
      ["12\t345", [f("12", 12), f("345", 345)]],
    ],
  },
  {
    name: "separators in Swiss and Indian Documents",
    context: { language: "de-CH" },
    cases: [
      ["1'234.50", [f("1'234.50", 1234.5)]],
      ["CHF 1'234'567", [f("CHF 1'234'567", 1234567, { unit: "CHF" })]],
      ["1’234", [f("1’234", 1234)]],
    ],
  },
  {
    name: "German scale words",
    context: { language: "de" },
    cases: [
      ["1,2 Mio. €", [f("1,2 Mio. €", 1200000, { unit: "EUR", scale: "Mio." })]],
      ["3,4 Mrd. €", [f("3,4 Mrd. €", 3400000000, { unit: "EUR", scale: "Mrd." })]],
      ["250 Tsd. EUR", [f("250 Tsd. EUR", 250000, { unit: "EUR", scale: "Tsd." })]],
    ],
  },
  {
    name: "Indian grouping and scales",
    context: { language: "en-IN" },
    cases: [
      ["₹1,23,45,678", [f("₹1,23,45,678", 12345678, { unit: "INR" })]],
      ["Rs. 12,34,567", [f("Rs. 12,34,567", 1234567, { unit: "INR" })]],
      ["1.5 lakh", [f("1.5 lakh", 150000, { scale: "lakh" })]],
      ["2 crore", [f("2 crore", 20000000, { scale: "crore" })]],
      ["12,34,567.89", [f("12,34,567.89", 1234567.89)]],
    ],
  },
  {
    name: "separators where nothing says how the Document writes numbers",
    context: {},
    cases: [
      ["1,234", [f("1,234", 1234, { ambiguous: ["separator"] })]],
      ["1.234", [f("1.234", 1.234, { ambiguous: ["separator"] })]],
      ["1,234.5", [f("1,234.5", 1234.5)]],
      ["1.234,5", [f("1.234,5", 1234.5)]],
      ["1,234,567", [f("1,234,567", 1234567)]],
      ["3,5", [f("3,5", 3.5)]],
      ["12.5", [f("12.5", 12.5)]],
      ["(1,250)", [f("(1,250)", -1250, { ambiguous: ["separator"] })]],
      ["￥1,234", [f("￥1,234", 1234, { unit: "CNY", ambiguous: ["separator", "currency"] })]],
    ],
  },
  {
    name: "full-width digits and spacing, read through NFKC",
    context: ZH,
    cases: [
      ["１２３", [f("１２３", 123)]],
      ["１，２３４．５", [f("１，２３４．５", 1234.5)]],
      [
        "营收３，５\uff10\uff10万元",
        [f("３，５\uff10\uff10万元", 35000000, { unit: "CNY", scale: "万" })],
      ],
      ["增长２５％", [f("２５％", 0.25, { unit: "%" })]],
      ["（１，２５\uff10）", [f("（１，２５\uff10）", -1250)]],
      ["含 1750 亿参数", [f("1750 亿", 175000000000, { scale: "亿" })]],
      ["收入为 1.2 亿元", [f("1.2 亿元", 120000000, { unit: "CNY", scale: "亿" })]],
      ["１２３４５６７８\uff19\uff10", [f("１２３４５６７８\uff19\uff10", 1234567890)]],
    ],
  },
  {
    name: "Chinese scales: 万, 亿, 千万, 百万, 万亿",
    context: ZH,
    cases: [
      ["1.2亿", [f("1.2亿", 120000000, { scale: "亿" })]],
      ["1.1亿", [f("1.1亿", 110000000, { scale: "亿" })]],
      ["3,500万", [f("3,500万", 35000000, { scale: "万" })]],
      ["4.35万", [f("4.35万", 43500, { scale: "万" })]],
      ["0.29亿", [f("0.29亿", 29000000, { scale: "亿" })]],
      ["12.5千万元", [f("12.5千万元", 125000000, { unit: "CNY", scale: "千万" })]],
      ["5百万", [f("5百万", 5000000, { scale: "百万" })]],
      ["3千", [f("3千", 3000, { scale: "千" })]],
      ["2万亿元", [f("2万亿元", 2000000000000, { unit: "CNY", scale: "万亿" })]],
      ["1.5万亿", [f("1.5万亿", 1500000000000, { scale: "万亿" })]],
      ["12亿元", [f("12亿元", 1200000000, { unit: "CNY", scale: "亿" })]],
      ["1.2亿元人民币", [f("1.2亿元人民币", 120000000, { unit: "CNY", scale: "亿" })]],
      ["營收1.2億元", [f("1.2億元", 120000000, { unit: "CNY", scale: "億" })]],
      ["5千克", [f("5千克", 5, { unit: "千克" })]],
      ["3万吨", [f("3万吨", 30000, { unit: "吨", scale: "万" })]],
      ["1,234万股", [f("1,234万股", 12340000, { unit: "股", scale: "万" })]],
      ["10万人", [f("10万人", 100000, { unit: "人", scale: "万" })]],
    ],
  },
  {
    name: "Chinese numerals",
    context: ZH,
    cases: [
      ["一百二十", [f("一百二十", 120)]],
      ["两千", [f("两千", 2000)]],
      ["三点五", [f("三点五", 3.5)]],
      ["零点五", [f("零点五", 0.5)]],
      ["一千零五", [f("一千零五", 1005)]],
      ["一万零五", [f("一万零五", 10005)]],
      ["一百零五万", [f("一百零五万", 1050000, { scale: "万" })]],
      ["三十五万", [f("三十五万", 350000, { scale: "万" })]],
      ["一亿五千万", [f("一亿五千万", 150000000)]],
      ["五千万", [f("五千万", 50000000, { scale: "万" })]],
      ["十亿元", [f("十亿元", 1000000000, { unit: "CNY", scale: "亿" })]],
      ["一万五", [f("一万五", 15000)]],
      ["三千五", [f("三千五", 3500)]],
      ["两百五", [f("两百五", 250)]],
      ["十二", [f("十二", 12)]],
      ["二十", [f("二十", 20)]],
      ["一〇〇", [f("一〇〇", 100)]],
      ["三点零五", [f("三点零五", 3.05)]],
      ["两万三千", [f("两万三千", 23000)]],
      ["九百九十九万", [f("九百九十九万", 9990000, { scale: "万" })]],
      ["三点五亿", [f("三点五亿", 350000000, { scale: "亿" })]],
      ["一点二亿元", [f("一点二亿元", 120000000, { unit: "CNY", scale: "亿" })]],
      ["负三十", [f("负三十", -30)]],
      ["百分之二十五", [f("百分之二十五", 0.25, { unit: "%" })]],
      ["百分之三点五", [f("百分之三点五", 0.035, { unit: "%" })]],
      ["百分之百", [f("百分之百", 1, { unit: "%" })]],
      ["百分之一百二十", [f("百分之一百二十", 1.2, { unit: "%" })]],
      ["百分之25", [f("百分之25", 0.25, { unit: "%" })]],
      ["负百分之三", [f("负百分之三", -0.03, { unit: "%" })]],
      ["千分之五", [f("千分之五", 0.005, { unit: "%" })]],
      ["万分之三", [f("万分之三", 0.0003, { unit: "%" })]],
      ["三分之一", [f("三分之一", 1 / 3)]],
      ["四分之三", [f("四分之三", 0.75)]],
      ["十分之一", [f("十分之一", 0.1)]],
      ["两倍", [f("两倍", 2, { unit: "x" })]],
      ["三成", [f("三成", 0.3, { unit: "%" })]],
      ["两成", [f("两成", 0.2, { unit: "%" })]],
      ["3成", [f("3成", 0.3, { unit: "%" })]],
      ["五吨", [f("五吨", 5, { unit: "吨" })]],
      ["三个百分点", [f("三个百分点", 0.03, { unit: "pp" })]],
      ["十二家", [f("十二家", 12, { unit: "家" })]],
      ["一百多家", [f("一百多家", 100, { unit: "家", approx: true })]],
      ["三十多万", [f("三十多万", 300000, { scale: "万", approx: true })]],
    ],
  },
  {
    name: "financial capitals",
    context: ZH,
    cases: [
      ["壹佰贰拾万元整", [f("壹佰贰拾万元整", 1200000, { unit: "CNY", scale: "万" })]],
      ["人民币叁仟伍佰元整", [f("人民币叁仟伍佰元整", 3500, { unit: "CNY" })]],
      ["叁仟伍佰元伍角陆分", [f("叁仟伍佰元伍角陆分", 3500.56, { unit: "CNY" })]],
      ["壹拾万元", [f("壹拾万元", 100000, { unit: "CNY", scale: "万" })]],
      ["玖佰玖拾玖元", [f("玖佰玖拾玖元", 999, { unit: "CNY" })]],
      ["贰万叁仟元整", [f("贰万叁仟元整", 23000, { unit: "CNY" })]],
      ["參仟伍佰元整", [f("參仟伍佰元整", 3500, { unit: "CNY" })]],
    ],
  },
  {
    name: "Chinese words that aren't figures",
    context: ZH,
    cases: [
      ["一个问题", []],
      ["十分重要", []],
      ["万一出现问题", []],
      ["千万不要忘记", []],
      ["一些公司", []],
      ["唯一的选择", []],
      ["统一标准", []],
      ["主要客户之一", []],
      ["第一", []],
      ["三三两两", []],
      ["五一假期", []],
      ["十一五规划", []],
      ["三家公司", []],
      ["一成不变", []],
      ["翻一番", []],
      ["数百万", []],
      ["几十亿", []],
      ["十几个", []],
      ["一般来说", []],
      ["一直", []],
      ["零增长", []],
      ["两家", []],
      ["九九归一", []],
      ["一定", []],
      ["百万富翁", []],
    ],
  },
  {
    name: "negatives in an English Document",
    context: EN,
    cases: [
      ["(1,250)", [f("(1,250)", -1250)]],
      ["(12.5)", [f("(12.5)", -12.5)]],
      ["($1,250)", [f("($1,250)", -1250, { unit: "USD" })]],
      ["$(1,250)", [f("$(1,250)", -1250, { unit: "USD" })]],
      ["-1,250", [f("-1,250", -1250)]],
      ["−1,250", [f("−1,250", -1250)]],
      ["–1,250", [f("–1,250", -1250)]],
      ["-0.5%", [f("-0.5%", -0.005, { unit: "%" })]],
      ["(1,250)¹", [f("(1,250)¹", -1250, { footnote: "¹" })]],
      ["(250)", [f("(250)", 250, { ambiguous: ["sign"] })]],
      ["(38.9%)", [f("(38.9%)", 0.389, { unit: "%", ambiguous: ["sign"] })]],
      ["(1)", []],
      ["(2025)", []],
      ["(US$170 million)", [f("US$170 million", 170000000, { unit: "USD", scale: "million" })]],
      [
        "revenue of RMB 1.2 billion (US$170 million)",
        [
          f("RMB 1.2 billion", 1200000000, { unit: "CNY", scale: "billion" }),
          f("US$170 million", 170000000, { unit: "USD", scale: "million" }),
        ],
      ],
      ["1,234 -1,100", [f("1,234", 1234), f("-1,100", -1100)]],
      ["+5%", [f("+5%", 0.05, { unit: "%" })]],
      ["-$1.2bn", [f("-$1.2bn", -1200000000, { unit: "USD", scale: "bn" })]],
      ["$-1.2bn", [f("$-1.2bn", -1200000000, { unit: "USD", scale: "bn" })]],
      ["COVID-19", []],
      ["net cash of £(12.3)m", [f("£(12.3)m", -12300000, { unit: "GBP", scale: "m" })]],
    ],
  },
  {
    name: "negatives in a Chinese Document",
    context: ZH,
    cases: [
      ["（1,250）", [f("（1,250）", -1250)]],
      ["负3%", [f("负3%", -0.03, { unit: "%" })]],
      ["△1,250", [f("△1,250", 1250, { ambiguous: ["sign"] })]],
      ["▲3.5%", [f("▲3.5%", 0.035, { unit: "%", ambiguous: ["sign"] })]],
      ["-1,250万元", [f("-1,250万元", -12500000, { unit: "CNY", scale: "万" })]],
    ],
  },
  {
    name: "currencies in an English Document",
    context: EN,
    cases: [
      ["$1.2bn", [f("$1.2bn", 1200000000, { unit: "USD", scale: "bn" })]],
      ["US$1.2 billion", [f("US$1.2 billion", 1200000000, { unit: "USD", scale: "billion" })]],
      ["USD 1.2 billion", [f("USD 1.2 billion", 1200000000, { unit: "USD", scale: "billion" })]],
      ["USD1.2bn", [f("USD1.2bn", 1200000000, { unit: "USD", scale: "bn" })]],
      ["1.2 billion USD", [f("1.2 billion USD", 1200000000, { unit: "USD", scale: "billion" })]],
      ["USD 1.2m", [f("USD 1.2m", 1200000, { unit: "USD", scale: "m" })]],
      ["HK$3.5bn", [f("HK$3.5bn", 3500000000, { unit: "HKD", scale: "bn" })]],
      ["A$2.1m", [f("A$2.1m", 2100000, { unit: "AUD", scale: "m" })]],
      ["S$500k", [f("S$500k", 500000, { unit: "SGD", scale: "k" })]],
      ["€3.5m", [f("€3.5m", 3500000, { unit: "EUR", scale: "m" })]],
      ["£350k", [f("£350k", 350000, { unit: "GBP", scale: "k" })]],
      ["£4,812.50", [f("£4,812.50", 4812.5, { unit: "GBP" })]],
      ["¥1.2bn", [f("¥1.2bn", 1200000000, { unit: "CNY", scale: "bn", ambiguous: ["currency"] })]],
      ["¥3,500元", [f("¥3,500元", 3500, { unit: "CNY" })]],
      ["RMB 120 million", [f("RMB 120 million", 120000000, { unit: "CNY", scale: "million" })]],
      ["Rmb120m", [f("Rmb120m", 120000000, { unit: "CNY", scale: "m" })]],
      [
        "1.2 billion dollars",
        [f("1.2 billion dollars", 1200000000, { unit: "USD", scale: "billion" })],
      ],
      ["1.2 million yuan", [f("1.2 million yuan", 1200000, { unit: "CNY", scale: "million" })]],
      ["1,234 RMB", [f("1,234 RMB", 1234, { unit: "CNY" })]],
      ["$ 1,234", [f("$ 1,234", 1234, { unit: "USD" })]],
    ],
  },
  {
    name: "currencies in a Chinese Document",
    context: ZH,
    cases: [
      ["¥1.2亿", [f("¥1.2亿", 120000000, { unit: "CNY", scale: "亿" })]],
      ["人民币1.2亿元", [f("人民币1.2亿元", 120000000, { unit: "CNY", scale: "亿" })]],
      ["1.2亿美元", [f("1.2亿美元", 120000000, { unit: "USD", scale: "亿" })]],
      ["3.5亿港元", [f("3.5亿港元", 350000000, { unit: "HKD", scale: "亿" })]],
      ["100日元", [f("100日元", 100, { unit: "JPY" })]],
      ["50万欧元", [f("50万欧元", 500000, { unit: "EUR", scale: "万" })]],
      ["3,500元", [f("3,500元", 3500, { unit: "CNY" })]],
      ["每股收益0.85元", [f("0.85元", 0.85, { unit: "CNY" })]],
    ],
  },
  {
    name: "scale words in English",
    context: EN,
    cases: [
      ["1.2 million", [f("1.2 million", 1200000, { scale: "million" })]],
      ["1.2 Million", [f("1.2 Million", 1200000, { scale: "Million" })]],
      ["3.4bn", [f("3.4bn", 3400000000, { scale: "bn" })]],
      ["3.4 bn", [f("3.4 bn", 3400000000, { scale: "bn" })]],
      ["5m", [f("5m", 5000000, { scale: "m" })]],
      ["350k", [f("350k", 350000, { scale: "k" })]],
      ["35 thousand", [f("35 thousand", 35000, { scale: "thousand" })]],
      ["2 trillion", [f("2 trillion", 2000000000000, { scale: "trillion" })]],
      ["$1.5tn", [f("$1.5tn", 1500000000000, { unit: "USD", scale: "tn" })]],
      ["7.5mn", [f("7.5mn", 7500000, { scale: "mn" })]],
      ["$5MM", [f("$5MM", 5000000, { unit: "USD", scale: "MM" })]],
      ["$5mm", [f("$5mm", 5000000, { unit: "USD", scale: "mm" })]],
      ["5mm", []],
      ["120 billion", [f("120 billion", 120000000000, { scale: "billion" })]],
    ],
  },
  {
    name: "percent, percentage points and basis points in English",
    context: EN,
    cases: [
      ["25%", [f("25%", 0.25, { unit: "%" })]],
      ["25 %", [f("25 %", 0.25, { unit: "%" })]],
      ["41.2%", [f("41.2%", 0.412, { unit: "%" })]],
      ["25 per cent", [f("25 per cent", 0.25, { unit: "%" })]],
      ["25 percent", [f("25 percent", 0.25, { unit: "%" })]],
      ["25pct", [f("25pct", 0.25, { unit: "%" })]],
      ["5‰", [f("5‰", 0.005, { unit: "%" })]],
      ["2.3 pp", [f("2.3 pp", 0.023, { unit: "pp" })]],
      ["2.3pp", [f("2.3pp", 0.023, { unit: "pp" })]],
      ["2.3 percentage points", [f("2.3 percentage points", 0.023, { unit: "pp" })]],
      ["2.3% points", [f("2.3% points", 0.023, { unit: "pp" })]],
      ["2.3 ppts", [f("2.3 ppts", 0.023, { unit: "pp" })]],
      ["300 bps", [f("300 bps", 0.03, { unit: "pp" })]],
      ["25bp", [f("25bp", 0.0025, { unit: "pp" })]],
      ["50 basis points", [f("50 basis points", 0.005, { unit: "pp" })]],
      ["3 points", [f("3 points", 3, { unit: "points", ambiguous: ["points"] })]],
      ["3 pts", [f("3 pts", 3, { unit: "pts", ambiguous: ["points"] })]],
      [
        "Gross margin rose 2.3 percentage points to 41.2%",
        [f("2.3 percentage points", 0.023, { unit: "pp" }), f("41.2%", 0.412, { unit: "%" })],
      ],
    ],
  },
  {
    name: "percent, percentage points and basis points in Chinese",
    context: ZH,
    cases: [
      ["提高2.3个百分点", [f("2.3个百分点", 0.023, { unit: "pp" })]],
      ["下降2.3百分点", [f("2.3百分点", 0.023, { unit: "pp" })]],
      ["下降50个基点", [f("50个基点", 0.005, { unit: "pp" })]],
      ["上涨了3个点", [f("3个点", 3, { unit: "个点", ambiguous: ["points"] })]],
      [
        "市占率提升至15.3%（+2.1pct）",
        [
          f("15.3%", 0.153, { unit: "%" }),
          f("+2.1pct", 0.021, { unit: "%", ambiguous: ["points"] }),
        ],
      ],
      [
        "毛利率41.2%，同比提高2.3个百分点",
        [f("41.2%", 0.412, { unit: "%" }), f("2.3个百分点", 0.023, { unit: "pp" })],
      ],
      ["增长25%", [f("25%", 0.25, { unit: "%" })]],
    ],
  },
  {
    name: "times",
    context: EN,
    cases: [
      ["2.5x", [f("2.5x", 2.5, { unit: "x" })]],
      ["2.5X", [f("2.5X", 2.5, { unit: "x" })]],
      ["2.5×", [f("2.5×", 2.5, { unit: "x" })]],
      ["1.5 times", [f("1.5 times", 1.5, { unit: "x" })]],
      ["10x", [f("10x", 10, { unit: "x" })]],
      ["2.5倍", [f("2.5倍", 2.5, { unit: "x" })]],
      ["市盈率25.3倍", [f("25.3倍", 25.3, { unit: "x" })]],
      ["4x4", []],
    ],
  },
  {
    name: "approximations in Chinese",
    context: ZH,
    cases: [
      ["约1.2亿", [f("1.2亿", 120000000, { scale: "亿", approx: true })]],
      ["约为1.2亿元", [f("1.2亿元", 120000000, { unit: "CNY", scale: "亿", approx: true })]],
      ["大约3,000人", [f("3,000人", 3000, { unit: "人", approx: true })]],
      ["近1.2亿元", [f("1.2亿元", 120000000, { unit: "CNY", scale: "亿", approx: true })]],
      ["逾100万", [f("100万", 1000000, { scale: "万", approx: true })]],
      ["超过3,000家", [f("3,000家", 3000, { unit: "家", approx: true })]],
      ["超3成", [f("3成", 0.3, { unit: "%", approx: true })]],
      ["不到5%", [f("5%", 0.05, { unit: "%", approx: true })]],
      ["1.2亿元左右", [f("1.2亿元左右", 120000000, { unit: "CNY", scale: "亿", approx: true })]],
      ["5%以上", [f("5%以上", 0.05, { unit: "%", approx: true })]],
      ["100多万", [f("100多万", 1000000, { scale: "万", approx: true })]],
      ["1000余万元", [f("1000余万元", 10000000, { unit: "CNY", scale: "万", approx: true })]],
      ["近三年", []],
    ],
  },
  {
    name: "approximations in English",
    context: EN,
    cases: [
      ["about 1.2 million", [f("1.2 million", 1200000, { scale: "million", approx: true })]],
      [
        "approximately $1.2bn",
        [f("$1.2bn", 1200000000, { unit: "USD", scale: "bn", approx: true })],
      ],
      ["c. 1.2bn", [f("1.2bn", 1200000000, { scale: "bn", approx: true })]],
      ["c.1.2bn", [f("1.2bn", 1200000000, { scale: "bn", approx: true })]],
      ["circa 300", [f("300", 300, { approx: true })]],
      ["~1.2", [f("1.2", 1.2, { approx: true })]],
      ["≈ 1.2%", [f("1.2%", 0.012, { unit: "%", approx: true })]],
      ["more than 300 staff", [f("300 staff", 300, { unit: "staff", approx: true })]],
      ["over 5%", [f("5%", 0.05, { unit: "%", approx: true })]],
      ["up to 20%", [f("20%", 0.2, { unit: "%", approx: true })]],
      ["nearly 40%", [f("40%", 0.4, { unit: "%", approx: true })]],
      ["100+ users", [f("100+", 100, { approx: true })]],
      ["30-odd stores", [f("30-odd", 30, { approx: true })]],
      ["some 300 people", [f("300 people", 300, { unit: "people", approx: true })]],
      ["at least 3x", [f("3x", 3, { unit: "x", approx: true })]],
    ],
  },
  {
    name: "ranges in English",
    context: EN,
    cases: [
      ["2–3%", [f("2–3%", 0.02, { unit: "%", to: 0.03, ambiguous: ["range"] })]],
      ["2-3%", [f("2-3%", 0.02, { unit: "%", to: 0.03, ambiguous: ["range"] })]],
      ["2%-3%", [f("2%-3%", 0.02, { unit: "%", to: 0.03, ambiguous: ["range"] })]],
      ["2% to 3%", [f("2% to 3%", 0.02, { unit: "%", to: 0.03, ambiguous: ["range"] })]],
      [
        "3 to 5 million",
        [f("3 to 5 million", 3000000, { scale: "million", to: 5000000, ambiguous: ["range"] })],
      ],
      [
        "$1.2–1.5bn",
        [
          f("$1.2–1.5bn", 1200000000, {
            unit: "USD",
            scale: "bn",
            to: 1500000000,
            ambiguous: ["range"],
          }),
        ],
      ],
      ["-5% to -3%", [f("-5% to -3%", -0.05, { unit: "%", to: -0.03, ambiguous: ["range"] })]],
      ["10-15 users", [f("10-15 users", 10, { unit: "users", to: 15, ambiguous: ["range"] })]],
      ["1,234 - 1,100", [f("1,234", 1234), f("1,100", 1100)]],
      ["Revenue increased by 1,234 to 5,678", [f("1,234", 1234), f("5,678", 5678)]],
      ["Margin rose from 2% to 3%", [f("2%", 0.02, { unit: "%" }), f("3%", 0.03, { unit: "%" })]],
      [
        "expects growth of 2% to 3%",
        [f("2% to 3%", 0.02, { unit: "%", to: 0.03, ambiguous: ["range"] })],
      ],
      ["5–10 years", []],
    ],
  },
  {
    name: "ranges in Chinese",
    context: ZH,
    cases: [
      [
        "1.2-1.5亿",
        [f("1.2-1.5亿", 120000000, { scale: "亿", to: 150000000, ambiguous: ["range"] })],
      ],
      [
        "1.2亿至1.5亿元",
        [
          f("1.2亿至1.5亿元", 120000000, {
            unit: "CNY",
            scale: "亿",
            to: 150000000,
            ambiguous: ["range"],
          }),
        ],
      ],
      ["2至3成", [f("2至3成", 0.2, { unit: "%", to: 0.3, ambiguous: ["range"] })]],
      ["二至三成", [f("二至三成", 0.2, { unit: "%", to: 0.3, ambiguous: ["range"] })]],
      ["100~200万", [f("100~200万", 1000000, { scale: "万", to: 2000000, ambiguous: ["range"] })]],
      ["约2-3%", [f("2-3%", 0.02, { unit: "%", to: 0.03, approx: true, ambiguous: ["range"] })]],
      ["从10%到15%", [f("10%", 0.1, { unit: "%" }), f("15%", 0.15, { unit: "%" })]],
      ["3-5年", []],
    ],
  },
  {
    name: "footnote marks stuck to a figure",
    context: EN,
    cases: [
      ["1.2亿¹", [f("1.2亿¹", 120000000, { scale: "亿", footnote: "¹" })]],
      ["12.3²", [f("12.3²", 12.3, { footnote: "²" })]],
      ["12.3(a)", [f("12.3(a)", 12.3, { footnote: "(a)" })]],
      ["1,234*", [f("1,234*", 1234, { footnote: "*" })]],
      ["1,234**", [f("1,234**", 1234, { footnote: "**" })]],
      ["12.3†", [f("12.3†", 12.3, { footnote: "†" })]],
      ["12.3[1]", [f("12.3[1]", 12.3, { footnote: "[1]" })]],
      ["12.3\u2460", [f("12.3\u2460", 12.3, { footnote: "\u2460" })]],
      ["45%¹ of revenue", [f("45%¹", 0.45, { unit: "%", footnote: "¹" })]],
      ["(1,250)(a)", [f("(1,250)(a)", -1250, { footnote: "(a)" })]],
      ["$1.2bn¹", [f("$1.2bn¹", 1200000000, { unit: "USD", scale: "bn", footnote: "¹" })]],
      ["100 m²", [f("100 m²", 100, { unit: "m²" })]],
    ],
  },
  {
    name: "years, dates, periods, references and names in English aren't figures",
    context: EN,
    cases: [
      ["In 2025", []],
      ["FY2025", []],
      ["FY 2025", []],
      ["Q3 2025", []],
      ["3Q25", []],
      ["1H25", []],
      ["H1 2025", []],
      ["2025E", []],
      ["June 30, 2025", []],
      ["30 June 2025", []],
      ["Jun-25", []],
      ["2025-06-30", []],
      ["30/06/2025", []],
      ["6/30", []],
      ["10:30", []],
      ["3pm", []],
      ["5 years", []],
      ["10-year bonds", []],
      ["3 months", []],
      ["2020-2025", []],
      ["2024/25", []],
      ["1st", []],
      ["the 3rd quarter", []],
      ["Note 12", []],
      ["IFRS 16", []],
      ["p. 12", []],
      ["pp. 3–5", []],
      ["Table 3", []],
      ["Tier 1 capital", []],
      ["Scope 3 emissions", []],
      ["S&P 500", []],
      ["1. Revenue", []],
      ["(1) revenue", []],
      ["5G", []],
      ["3D", []],
      ["CO2", []],
      ["600519.SH", []],
      ["10-K", []],
    ],
  },
  {
    name: "years, dates, periods, references and list numbers in Chinese aren't figures",
    context: ZH,
    cases: [
      ["2025年", []],
      ["2025年6月30日", []],
      ["6月30日", []],
      ["1-6月", []],
      ["第三季度", []],
      ["一季度", []],
      ["前三季度", []],
      ["3个月", []],
      ["30天", []],
      ["二〇二五年", []],
      ["2025年度", []],
      ["90年代", []],
      ["第3页", []],
      ["第十二条", []],
      ["附注3", []],
      ["沪深300", []],
      ["1、营业收入", []],
    ],
  },
  {
    name: "years and dates, when asked for",
    context: { language: "zh-CN", dates: true },
    cases: [
      ["2025年6月30日", [f("2025", 2025), f("6", 6), f("30", 30)]],
      ["In 2025", [f("2025", 2025)]],
      ["FY2025", [f("2025", 2025)]],
    ],
  },
  {
    name: "a scale stated in the text, not beside the figures",
    context: ZH,
    cases: [
      ["单位：万元\n营业收入 152,340.56", [f("152,340.56", 152340.56, { ambiguous: ["scale"] })]],
      ["金额单位：人民币千元\n12,345", [f("12,345", 12345, { ambiguous: ["scale"] })]],
      ["单位：%\n毛利率 41.2", [f("41.2", 41.2, { ambiguous: ["scale"] })]],
      ["单位：元 币种：人民币\n1,234.56", [f("1,234.56", 1234.56, { ambiguous: ["scale"] })]],
      ["（百万元）\n营业收入 1,234", [f("1,234", 1234, { ambiguous: ["scale"] })]],
      ["RMB 百万元 1,234", [f("1,234", 1234, { ambiguous: ["scale"] })]],
      [
        "单位：万元\n营业收入 1.2亿 增长 25%",
        [f("1.2亿", 120000000, { scale: "亿" }), f("25%", 0.25, { unit: "%" })],
      ],
    ],
  },
  {
    name: "a scale stated in English, not beside the figures",
    context: EN,
    cases: [
      [
        "(in millions, except per share data)\nRevenue 1,482.6",
        [f("1,482.6", 1482.6, { ambiguous: ["scale"] })],
      ],
      ["Revenue (USD m) 1,234", [f("1,234", 1234, { ambiguous: ["scale"] })]],
      ["RMB'000\n12,345", [f("12,345", 12345, { ambiguous: ["scale"] })]],
      ["$ in thousands\nNet sales 4,812", [f("4,812", 4812, { ambiguous: ["scale"] })]],
    ],
  },
  {
    name: "a table's header, given apart from its rows",
    context: { language: "zh-CN", header: "单位：万元" },
    cases: [
      [
        "营业收入 152,340.56 121,883.20",
        [
          f("152,340.56", 152340.56, { ambiguous: ["scale"] }),
          f("121,883.20", 121883.2, { ambiguous: ["scale"] }),
        ],
      ],
      ["1.2亿", [f("1.2亿", 120000000, { scale: "亿" })]],
      ["41.2%", [f("41.2%", 0.412, { unit: "%" })]],
      ["一万二", [f("一万二", 12000)]],
      ["租金三千五百元", [f("三千五百元", 3500, { unit: "CNY" })]],
      // A bare 138亿 cell: the header's stated scale keeps its digits an amount (#2215).
      ["13800138000", [f("13800138000", 13800138000, { ambiguous: ["scale"] })]],
    ],
  },
  {
    name: "a Chinese amount, in words or mixed, read as one amount (#2189)",
    context: ZH,
    cases: [
      ["两万", [f("两万", 20000, { scale: "万" })]],
      ["三千五百", [f("三千五百", 3500)]],
      ["一万二", [f("一万二", 12000)]],
      ["十二万", [f("十二万", 120000, { scale: "万" })]],
      ["两千万", [f("两千万", 20000000, { scale: "万" })]],
      ["人民币两万元", [f("人民币两万元", 20000, { unit: "CNY", scale: "万" })]],
      ["贰万元整", [f("贰万元整", 20000, { unit: "CNY", scale: "万" })]],
      ["二〇〇", [f("二〇〇", 200)]],
      ["2万5千元", [f("2万5千元", 25000, { unit: "CNY", scale: "万" })]],
      ["1万2千5百元", [f("1万2千5百元", 12500, { unit: "CNY", scale: "万" })]],
      ["人民币2亿5000万元", [f("人民币2亿5000万元", 250000000, { unit: "CNY", scale: "亿" })]],
      ["3.5万元", [f("3.5万元", 35000, { unit: "CNY", scale: "万" })]],
      ["2万5千米", [f("2万", 20000, { scale: "万" }), f("5千米", 5, { unit: "千米" })]],
      ["两万半", [f("两万半", 25000, { scale: "万" })]],
      ["一亿半。", [f("一亿半", 150000000, { scale: "亿" })]],
      ["三千半", [f("三千半", 3500)]],
      ["两千半导体", [f("两千", 2000)]],
      ["两万半元", [f("两万半元", 25000, { unit: "CNY", scale: "万" })]],
      ["两万半人民币", [f("两万半人民币", 25000, { unit: "CNY", scale: "万" })]],
      ["两万半左右", [f("两万半左右", 25000, { scale: "万", approx: true })]],
      ["负两万元", [f("负两万元", -20000, { unit: "CNY", scale: "万" })]],
    ],
  },
  {
    name: "a number in an address, a room or a clause is no amount (#2189)",
    context: ZH,
    cases: [
      ["明川路14号2室", [f("2室", 2, { unit: "室" })]],
      ["5号楼2单元301室", [f("2单元", 2, { unit: "单元" }), f("301室", 301, { unit: "室" })]],
      ["住在3楼", [f("3楼", 3, { unit: "楼" })]],
      ["共20层", [f("20层", 20, { unit: "层" })]],
      ["见3章", [f("3章", 3, { unit: "章" })]],
      ["第3条第2款", []],
      ["第三章", []],
      ["两室一厅", []],
    ],
  },
  {
    name: "a digit amount that goes on in Chinese numerals (#2215)",
    context: ZH,
    cases: [
      ["2万三千元", [f("2万三千元", 23000, { unit: "CNY", scale: "万" })]],
      ["2万3千元", [f("2万3千元", 23000, { unit: "CNY", scale: "万" })]],
      ["两万三千元", [f("两万三千元", 23000, { unit: "CNY" })]],
      ["2万，三千元", [f("2万", 20000, { scale: "万" }), f("三千元", 3000, { unit: "CNY" })]],
    ],
  },
  {
    name: "a mobile or ID number written bare is no amount (#2215)",
    context: ZH,
    cases: [
      ["13800138000", []],
      ["电话13800138000", []],
      ["身份证号110101199003071234", []],
      ["身份证号11010119900307123X", []],
      // Not a mobile's pattern, and an 18-digit run with no birth date in it, stay figures.
      ["23800138000", [f("23800138000", 23800138000)]],
      ["123456789012345678", [f("123456789012345678", 123456789012345680)]],
      ["13,800,138,000元", [f("13,800,138,000元", 13800138000, { unit: "CNY" })]],
      ["人民币13800138000元", [f("人民币13800138000元", 13800138000, { unit: "CNY" })]],
    ],
  },
  {
    name: "半 after a numeral of more than one place (#2215)",
    context: ZH,
    cases: [
      ["一万二千半", [f("一万二千半", 12500)]],
      ["十二万半", [f("十二万半", 125000)]],
      ["一百五十万半", [f("一百五十万半", 1505000)]],
      ["一万亿半", [f("一万亿半", 1000050000000)]],
      ["1万2千半", [f("1万2千半", 12500, { scale: "万" })]],
      ["2万半", [f("2万半", 25000, { scale: "万" })]],
      ["两万半", [f("两万半", 25000, { scale: "万" })]],
      ["两千半导体", [f("两千", 2000)]],
    ],
  },
  {
    name: "sentences from English reports",
    context: EN,
    cases: [
      [
        "Revenue was $1,482.6 million in 2025, compared with $1,231.0 million in 2024.",
        [
          f("$1,482.6 million", 1482600000, { unit: "USD", scale: "million" }),
          f("$1,231.0 million", 1231000000, { unit: "USD", scale: "million" }),
        ],
      ],
      [
        "Gross margin 41.2% 38.9%",
        [f("41.2%", 0.412, { unit: "%" }), f("38.9%", 0.389, { unit: "%" })],
      ],
      [
        "EBITDA rose 12% to $1.2bn (2024: $1.07bn).",
        [
          f("12%", 0.12, { unit: "%" }),
          f("$1.2bn", 1200000000, { unit: "USD", scale: "bn" }),
          f("$1.07bn", 1070000000, { unit: "USD", scale: "bn" }),
        ],
      ],
      [
        "Net debt/EBITDA of 2.1x, down from 2.4x",
        [f("2.1x", 2.1, { unit: "x" }), f("2.4x", 2.4, { unit: "x" })],
      ],
      [
        "Headcount: 12,450 employees across 37 countries",
        [f("12,450 employees", 12450, { unit: "employees" }), f("37", 37)],
      ],
      [
        "Q3 2025 revenue grew 8% to £350.2 million",
        [
          f("8%", 0.08, { unit: "%" }),
          f("£350.2 million", 350200000, { unit: "GBP", scale: "million" }),
        ],
      ],
      [
        "Net profit of RMB 1.2 billion (US$170 million) rose 5.6%.",
        [
          f("RMB 1.2 billion", 1200000000, { unit: "CNY", scale: "billion" }),
          f("US$170 million", 170000000, { unit: "USD", scale: "million" }),
          f("5.6%", 0.056, { unit: "%" }),
        ],
      ],
    ],
  },
  {
    name: "sentences from Chinese reports",
    context: ZH,
    cases: [
      [
        "营业收入 152,340.56 121,883.20 98,765.43",
        [f("152,340.56", 152340.56), f("121,883.20", 121883.2), f("98,765.43", 98765.43)],
      ],
      [
        "公司2025年营业收入为1.52亿元，同比增长24.99%，净利润3,045.74万元。",
        [
          f("1.52亿元", 152000000, { unit: "CNY", scale: "亿" }),
          f("24.99%", 0.2499, { unit: "%" }),
          f("3,045.74万元", 30457400, { unit: "CNY", scale: "万" }),
        ],
      ],
      [
        "截至2025年6月30日，公司员工约3,000人，门店超过1,200家。",
        [
          f("3,000人", 3000, { unit: "人", approx: true }),
          f("1,200家", 1200, { unit: "家", approx: true }),
        ],
      ],
      [
        "每股收益0.85元，同比下降5.6%",
        [f("0.85元", 0.85, { unit: "CNY" }), f("5.6%", 0.056, { unit: "%" })],
      ],
      [
        "研发投入占营业收入的比例为12.5%，较上年提高1.3个百分点",
        [f("12.5%", 0.125, { unit: "%" }), f("1.3个百分点", 0.013, { unit: "pp" })],
      ],
      [
        "2025年前三季度实现营收3.5亿元，同比增长20%-30%",
        [
          f("3.5亿元", 350000000, { unit: "CNY", scale: "亿" }),
          f("20%-30%", 0.2, { unit: "%", to: 0.3, ambiguous: ["range"] }),
        ],
      ],
      ["增长3。5月份收入回升", [f("3", 3)]],
      ["分别为3，5，7", [f("3", 3), f("5", 5), f("7", 7)]],
    ],
  },
  {
    name: "headings, lists, names and lines in English Documents",
    context: EN,
    cases: [
      ["1 Introduction", []],
      ["2.1 Methods", []],
      ["1. Revenue\n2. Costs", []],
      ["Revenue grew to\n116. The next year", [f("116", 116)]],
      ["daed_a_01905", []],
      ["ISO 8601", []],
      ["tree cover at 31\nper cent", [f("31\nper cent", 0.31, { unit: "%" })]],
      ["$30\ntrillion", [f("$30\ntrillion", 30000000000000, { unit: "USD", scale: "trillion" })]],
      ["50 km/h", [f("50 km/h", 50, { unit: "km/h" })]],
      ["300 metres", [f("300 metres", 300, { unit: "metres" })]],
      ["40 centimetres", [f("40 centimetres", 40, { unit: "centimetres" })]],
      ["7,600 mAh", [f("7,600 mAh", 7600, { unit: "mAh" })]],
      ["386 megawatt hours", [f("386 megawatt hours", 386, { unit: "megawatt hours" })]],
    ],
  },
  {
    name: "headings, lists, names and times in Chinese Documents",
    context: ZH,
    cases: [
      ["1 引言", []],
      ["数据提交流程\n1. 实验结束后上传", []],
      ["零下18度", [f("零下18度", -18, { unit: "度" })]],
      ["早上7点30分前", []],
      ["晚上10点至次日凌晨5点", []],
      ["11点至12点半", []],
      ["以下 17 点目标", [f("17", 17)]],
      ["1路 42 18,600", [f("42", 42), f("18,600", 18600)]],
      ["2号线", []],
      ["60岁以上", [f("60岁以上", 60, { unit: "岁", approx: true })]],
      ["如表3所示", []],
      ["如图1所示", []],
      ["代表3名员工", [f("3名", 3, { unit: "名" })]],
      ["每100元收入", [f("100元", 100, { unit: "CNY" })]],
    ],
  },
];

/** Cases read with a context of their own. */
const OWN_CONTEXT: [text: string, context: FigureContext, figures: Expected[]][] = [
  ["1,234", { separators: { decimal: ",", group: "." } }, [f("1,234", 1.234)]],
  [
    "1,234",
    { language: "en", separators: { decimal: ",", group: "." } },
    [f("1,234", 1234, { ambiguous: ["separator"] })],
  ],
  ["1,234", figureContextOf("Revenue of 12,345.6 and costs of 9,876.5"), [f("1,234", 1234)]],
  ["1.234", figureContextOf("Umsatz 12.345,6 und Kosten 9.876,5"), [f("1.234", 1234)]],
  [
    "1.234",
    figureContextOf("1,234.5 and 1.234,5"),
    [f("1.234", 1.234, { ambiguous: ["separator"] })],
  ],
  ["¥1,200", { language: "ja" }, [f("¥1,200", 1200, { unit: "JPY" })]],
  [
    "13800138000",
    { language: "zh-CN", header: "单位：元" },
    [f("13800138000", 13800138000, { ambiguous: ["scale"] })],
  ],
  [
    "13800138000",
    { language: "zh-CN", header: "金额单位：人民币元" },
    [f("13800138000", 13800138000, { ambiguous: ["scale"] })],
  ],
  [
    "¥1.2bn",
    { language: "en", yen: "CNY" },
    [f("¥1.2bn", 1200000000, { unit: "CNY", scale: "bn" })],
  ],
  [
    "¥1.2bn",
    figureContextOf("Revenue was RMB 8.1bn in 2025.", "en"),
    [f("¥1.2bn", 1200000000, { unit: "CNY", scale: "bn" })],
  ],
  ["3,500元", { language: "zh-TW" }, [f("3,500元", 3500, { unit: "TWD" })]],
  ["$1,234", { language: "en-AU" }, [f("$1,234", 1234, { unit: "AUD" })]],
  ["$1,234", { language: "zh-HK" }, [f("$1,234", 1234, { unit: "HKD" })]],
  [
    "$1,234",
    { language: "en", header: "(in millions)" },
    [f("$1,234", 1234, { unit: "USD", ambiguous: ["scale"] })],
  ],
];

describe("the golden set", () => {
  for (const group of GOLDEN) {
    describe(group.name, () => {
      test.each(group.cases)("%s", (text, figures) => {
        const read = readFigures(text, group.context);
        expect(read.map(shape)).toEqual(figures);
        for (const figure of read) expect(text.slice(figure.start, figure.end)).toBe(figure.chars);
      });
    });
  }
  describe("cases with a context of their own", () => {
    test.each(OWN_CONTEXT)("%s with %j", (text, context, figures) => {
      expect(readFigures(text, context).map(shape)).toEqual(figures);
    });
  });
});

describe("a period a Chinese sentence counts (#2215)", () => {
  const year = { kind: "other", word: "year" };

  test.each([
    "在这一年里",
    "那一年",
    "每一年",
    "当一年",
    "这一个月里",
    "那一天",
    "每一季度",
    "同一年",
    "另一年",
    "哪一年",
  ])("%s states no count", (text) => {
    expect(figuresInClaim(text, ZH)).toEqual([]);
  });

  test.each([
    ["一年内", "一年", 1],
    ["三年", "三年", 3],
    ["连续两年", "两年", 2],
    ["应当一年内完成", "一年", 1],
    ["前后一年", "一年", 1],
  ])("%s still counts", (text, chars, value) => {
    expect(figuresInClaim(text, ZH)).toEqual([
      {
        start: text.indexOf(chars),
        end: text.indexOf(chars) + chars.length,
        chars,
        value,
        scale: 1,
        scaleWord: null,
        unit: year,
        decimals: 0,
        currency: null,
        approximate: false,
        rangeTo: null,
        footnote: null,
        ambiguous: [],
      },
    ]);
  });

  test("a stated calculation figure names no quantity for a period that says which one", () => {
    expect(statedFigure("净负债在这一年里大幅下降", "一年", ZH)).toBeNull();
    expect(statedFigure("应当在一年内完成", "一年", ZH)).toMatchObject({
      chars: "一年",
      value: 1,
      unit: year,
    });
  });
});

describe("what an ambiguous figure could be", () => {
  const readings = (text: string, context: FigureContext, kind: AmbiguityKind) =>
    readFigures(text, context)[0]?.ambiguous.find((each) => each.kind === kind)?.readings;

  test("a separator the context doesn't settle reads both ways", () => {
    expect(readings("1,234", {}, "separator")?.map((each) => each.value)).toEqual([1234, 1.234]);
    expect(readings("1.234", {}, "separator")?.map((each) => each.value)).toEqual([1.234, 1234]);
  });

  test("a decimal mark the Document doesn't use is flagged with its one reading", () => {
    expect(readings("1,5", EN, "separator")?.map((each) => each.value)).toEqual([1.5]);
  });

  test("¥ is yuan or yen", () => {
    expect(readings("¥1.2bn", EN, "currency")?.map((each) => each.unit)).toEqual([
      { kind: "currency", code: "CNY" },
      { kind: "currency", code: "JPY" },
    ]);
  });

  test("a header's scale gives the reading with it, and the one without", () => {
    const [plain, stated] = readings("152,340.56", { ...ZH, header: "单位：万元" }, "scale") ?? [];
    expect(plain).toEqual({
      value: 152340.56,
      scale: 1,
      scaleWord: null,
      unit: { kind: "plain" },
      decimals: 2,
      precision: 0.01,
    });
    expect(stated).toEqual({
      value: 1523405600,
      scale: 10000,
      scaleWord: "万",
      unit: { kind: "currency", code: "CNY" },
      decimals: 2,
      precision: 100,
      statedIn: "header",
    });
    expect(readings("41.2", { ...ZH, header: "单位：%" }, "scale")?.at(-1)).toEqual({
      value: 0.412,
      scale: 1,
      scaleWord: null,
      unit: { kind: "percent" },
      decimals: 1,
      precision: 0.001,
      statedIn: "header",
    });
    expect(
      readings("1,482.6", { ...EN, header: "(in millions of U.S. dollars)" }, "scale")?.at(-1),
    ).toEqual({
      value: 1482600000,
      scale: 1000000,
      scaleWord: "millions",
      unit: { kind: "currency", code: "USD" },
      decimals: 1,
      precision: 100000,
      statedIn: "header",
    });
  });

  test("a header written as a power of ten and a scale word, '100million USD', gives the reading with it (#1444)", () => {
    const stated = readings("34,002.51", { ...EN, header: "100million USD" }, "scale")?.at(-1);
    expect(stated).toEqual({
      value: 3400251000000,
      scale: 100000000,
      scaleWord: "100million",
      unit: { kind: "currency", code: "USD" },
      decimals: 2,
      precision: 1000000,
      statedIn: "header",
    });
    expect(
      readings("1.5", { ...EN, header: "Unit: 10 thousand yuan" }, "scale")?.at(-1)?.value,
    ).toBe(15000);
    // Anywhere else it is a figure, so a "100 million" in a sentence states no unit.
    expect(
      readings("34,002.51", { ...EN, header: "raised 3 million dollars" }, "scale"),
    ).toBeUndefined();
    expect(
      readings("34,002.51", { ...EN, header: "Revenue was 10 million" }, "scale"),
    ).toBeUndefined();
  });

  test("△ and a whole number in brackets may be negative or not", () => {
    expect(readings("△1,250", ZH, "sign")?.map((each) => each.value)).toEqual([1250, -1250]);
    expect(readings("(250)", EN, "sign")?.map((each) => each.value)).toEqual([250, -250]);
  });

  test("a range is two values, not one", () => {
    expect(readings("2–3%", EN, "range")?.map((each) => each.value)).toEqual([0.02, 0.03]);
    expect(readings("1.2亿至1.5亿元", ZH, "range")?.map((each) => each.value)).toEqual([
      120000000, 150000000,
    ]);
  });

  test("points may be percentage points or an index's", () => {
    expect(readings("3 points", EN, "points")).toEqual([
      {
        value: 3,
        scale: 1,
        scaleWord: null,
        unit: { kind: "other", word: "points" },
        decimals: 0,
        precision: 1,
      },
      {
        value: 0.03,
        scale: 1,
        scaleWord: null,
        unit: { kind: "points" },
        decimals: 0,
        precision: 0.01,
      },
    ]);
  });
});

describe("decimals as written", () => {
  test("are counted from the digits, trailing zeros included", () => {
    const decimals = (text: string, context: FigureContext = EN) =>
      readFigures(text, context).map((figure) => figure.decimals);
    expect(decimals("$1,231.0 million")).toEqual([1]);
    expect(decimals("41.25%")).toEqual([2]);
    expect(decimals("3,500万元 1.2亿元 三点五", ZH)).toEqual([0, 1, 1]);
    expect(
      readFigures("1,234")[0]?.ambiguous[0]?.readings.map((reading) => reading.decimals),
    ).toEqual([0, 3]);
  });
});

describe("values are the doubles a spreadsheet reads from the same digits", () => {
  test("percents and scales are exact decimals, not products of floating-point arithmetic", () => {
    const value = (text: string) => readFigures(text, EN)[0]?.value;
    expect(value("41.2%")).toBe(Number("0.412"));
    expect(value("1.1亿")).toBe(110000000);
    expect(value("29%")).toBe(Number("0.29"));
    expect(value("4.35万")).toBe(43500);
    expect(value("$1,482.6 million")).toBe(1482600000);
  });
});

describe("stated units", () => {
  const stated = (text: string, context: FigureContext = {}) =>
    readStatedUnits(text, context).map(({ chars, scale, scaleWord, unit }) => ({
      chars,
      scale,
      scaleWord,
      unit,
    }));

  test("a line given as a header may state its scale as a power of ten and a scale word, which in a sentence is a figure", () => {
    const asHeader = (text: string) =>
      readStatedUnits(text, EN, true).map(({ scale, scaleWord, unit }) => ({
        scale,
        scaleWord,
        unit,
      }));
    expect(asHeader("100million USD")).toEqual([
      { scale: 100000000, scaleWord: "100million", unit: { kind: "currency", code: "USD" } },
    ]);
    expect(asHeader("官方储备资产 Official reserve assets")).toEqual([]);
    expect(asHeader("3 million dollars")).toEqual([]);
    expect(asHeader("Unit: 10 thousand yuan")).toHaveLength(1);
    // A sentence that happens to hold a power of ten states no unit, however it is asked.
    expect(asHeader("The company raised 100 million dollars in 2025")).toEqual([]);
    expect(asHeader("Revenue was 10 million")).toEqual([]);
    expect(asHeader("a total of 100 million shares")).toEqual([]);
    expect(stated("100million USD", EN)).toEqual([]);
  });

  test("a line says it holds for the whole Document only in so many words (#2365)", () => {
    for (const line of [
      "All amounts in £'000",
      "All figures are in thousands",
      "Every amount is stated in millions",
      "Unless otherwise stated, all amounts are in £m",
      "所有金额单位：千元",
      "所有金額單位：千元",
      "本报告金额单位：万元",
      "本報告金額單位：萬元",
      "全文金额均以千元列示",
      "除另有说明外，金额单位：万元",
      "Figures throughout this document are in £m",
      "Amounts throughout this report are in thousands",
      "All amounts in the consolidated financial statements are in £m",
      "All amounts are in £m except where stated in the notes",
      "本文件中所有金额单位均为百万英镑",
      "本报告所有金额单位：千元",
      "合并财务报表中所有金额单位：万元",
      "所有金额单位：万元，但附注另有说明者除外",
      "All amounts of the Group are in thousands",
      "All amounts in the Group's financial statements are in thousands",
      "Unless otherwise stated, all amounts for the year ended 31 December 2024 are in thousands",
      "All amounts in this document are in £'000",
      "All amounts in this annual report are in £'000",
      "All amounts in the Group's financial statements are in £'000",
      "Unless otherwise stated, all amounts for the period ended 30 June 2024 are in thousands",
      "All amounts in US dollars are in millions",
      "All amounts in this annual report are in US$ millions",
      "All amounts for the Group are in £m",
      "All amounts in the year ended 31 December 2024 are in £'000",
      "All amounts in £m unless otherwise stated",
      "除另有注明外，所有金额单位均为人民币千元",
    ])
      expect([line, statesForWholeDocument(line)]).toEqual([line, true]);
    for (const line of [
      "Amounts in £'000",
      "Figures in 000s",
      "All amounts in this table are in £'000",
      "All figures in the section below are in thousands",
      "All figures in Note 5 are in £m",
      "All amounts in the consolidated financial statements' notes are in £m",
      "Unless otherwise stated, amounts in the remuneration report are in £'000",
      "All amounts in the parent company balance sheet are in £'000",
      "All amounts in segment reporting are in £m",
      "All figures for 2024 are in thousands",
      "All amounts in the directors' report are in £'000",
      "合并财务报表附注金额单位：万元",
      "合并财务报表中本表金额单位：万元",
      "金额单位：千元",
      "金額單位：千元",
      "本表金额单位：万元",
      "本表金額單位：萬元",
      "本报表金额单位：万元",
      "下列金额单位：万元",
      "附注五金额单位：万元",
      "All amounts in this remuneration report are in £'000",
      "Unless otherwise stated, all amounts in this Directors' Remuneration Report are in £'000",
      "All amounts in this segment are in £'000",
      "All amounts in the Group's remuneration report are in £'000",
      "All amounts on this page are in £'000",
      "All amounts below are in £'000",
      "All amounts within this report are in £'000",
      "All amounts following are in £'000",
      "所有分部信息金额单位：百万元",
      "All amounts relating to the parent company are in £'000",
      "All amounts attributable to discontinued operations are in $ thousands",
      "All amounts excluding the US business are in £m",
      "All amounts in £m, apart from the Company balance sheet",
      "All amounts except those in Note 12 are in £m",
      "All amounts, other than those of the joint venture, are in £'000",
      "All amounts in the year ended 31 December 2024 column are in £'000",
      "所有金额单位：人民币千元，境外子公司除外",
      "所有金额单位：千元（不含香港业务）",
      "所有金额单位：千元（附录除外）",
    ])
      expect([line, statesForWholeDocument(line)]).toEqual([line, false]);
  });

  // protects=#2365; fails_when=a bracket's currency is dropped once its tail's scale is read, so
  // "(in £, thousands)" reads a plain thousand, or "(in £ and $ thousands)" picks one of its two
  // currencies instead of refusing.
  test("a bracket's tail is read whole: its currency and the scale after it", () => {
    for (const line of [
      "(in $US thousands)",
      "(in £ and $ thousands)",
      "(in US dollars millions)",
      "(in dollars thousands)",
    ])
      expect([line, stated(line)]).toEqual([line, []]);
    for (const [line, scale, code] of [
      ["(in £, thousands)", 1000, "GBP"],
      ["(in £, '000)", 1000, "GBP"],
      ["(in US$, millions)", 1000000, "USD"],
      ["(in euros, millions)", 1000000, "EUR"],
      ["(in dollars, in thousands)", 1000, "USD"],
      ["(in HK$, figures in millions)", 1000000, "HKD"],
    ] as const)
      expect([line, stated(line)]).toMatchObject([
        line,
        [{ scale, unit: { kind: "currency", code } }],
      ]);
    for (const line of ["(in £ and pence)", "(in £, GBP)", "(in £, see note 3)"])
      expect([line, stated(line)]).toEqual([
        line,
        [{ chars: line, scale: 1, scaleWord: null, unit: { kind: "currency", code: "GBP" } }],
      ]);
  });

  test("an amount's own compound scale states nothing: “4,979.6百万元” holds “万元” but is a figure", () => {
    expect(stated("营业收入为人民币4,979.6百万元，上年同期为人民币4,860.0百万元。", ZH)).toEqual(
      [],
    );
    expect(stated("分部收入（单位：人民币百万元）", ZH)).toMatchObject([
      { scale: 1000000, unit: { kind: "currency", code: "CNY" } },
    ]);
  });

  test("a heading's currency alone in brackets states it: “2026 sales (£)”, “Amount (USD)”", () => {
    expect(stated("Region\t2026 sales (£)", EN)).toEqual([
      { chars: "(£)", scale: 1, scaleWord: null, unit: { kind: "currency", code: "GBP" } },
    ]);
    expect(stated("Amount (USD)", EN)).toMatchObject([
      { chars: "(USD)", scale: 1, unit: { kind: "currency", code: "USD" } },
    ]);
    expect(stated("Revenue (£m)", EN)).toMatchObject([{ scale: 1000000, unit: { code: "GBP" } }]);
    expect(stated("Sales (see note 3)", EN)).toEqual([]);
  });

  test("a heading's or a row's own scale and unit words state them: “Unit: million tonnes”, “thousand tonnes”", () => {
    const tonnes = (scale: number, chars: string) => ({
      chars,
      scale,
      scaleWord: chars.split(" ")[0],
      unit: { kind: "other", word: "tonnes" },
    });
    expect(stated("Unit: million tonnes", EN)).toEqual([tonnes(1000000, "million tonnes")]);
    expect(stated("Cost\t70\t78\tthousand tonnes", EN)).toEqual([tonnes(1000, "thousand tonnes")]);
    expect(stated("Cost | 70 | 78 | million tonnes", EN)).toEqual([
      tonnes(1000000, "million tonnes"),
    ]);
    expect(stated("Output (thousand tonnes)", EN)).toEqual([tonnes(1000, "thousand tonnes")]);
    expect(stated("Output reached 78 million tonnes", EN)).toEqual([]);
    expect(stated("A million people came", EN)).toEqual([]);
  });

  // protects=#2365; fails_when=a currency the reader doesn't know by name ("in thousands of New Taiwan dollars", "of Japanese yen") is read as a unit of measure, so an amount in it is refused where its own sign settles the currency; or a count that ends with a currency's word ("of contracts won") reads as money.
  test("“in thousands of” a currency's name states money, and any other “of” a measure", () => {
    const thousands = (name: string) => stated(`(in thousands of ${name})`, EN);
    for (const name of [
      "New Taiwan dollars",
      "NT dollars",
      "NEW TAIWAN DOLLARS",
      "Japanese yen",
      "Brazilian reais",
      "Korean won",
      "Swedish kronor",
      "Mexican pesos",
      "South African rand",
      "Norwegian kroner",
      "Danish kroner",
      "Russian rubles",
      "Turkish lira",
      "Philippine pesos",
      "Chilean pesos",
      "Indonesian rupiah",
      "Malaysian ringgit",
      "Thai baht",
      "Chinese yuan",
      "Chinese renminbi",
      "New Zealand dollars",
      "Saudi riyals",
      "UAE dirhams",
      "Israeli shekels",
      "Polish zlotys",
      "won",
    ]) {
      expect([name, thousands(name)]).toEqual([
        name,
        [
          {
            chars: `in thousands of ${name}`,
            scale: 1000,
            scaleWord: "thousands",
            unit: { kind: "plain" },
          },
        ],
      ]);
      expect(readStatedUnits(`(in thousands of ${name})`, EN)[0]?.unplacedCurrency).toBe(name);
    }
    for (const [name, code] of [
      ["Indian rupees", "INR"],
      ["Swiss francs", "CHF"],
      ["Australian dollars", "AUD"],
      ["Singapore dollars", "SGD"],
      ["Canadian dollars", "CAD"],
      ["euro", "EUR"],
      ["United States dollars", "USD"],
      ["US dollars", "USD"],
    ] as const)
      expect([name, thousands(name)]).toMatchObject([
        name,
        [{ scale: 1000, unit: { kind: "currency", code } }],
      ]);
    for (const [name, word] of [
      ["tonnes", "tonnes"],
      ["barrels of oil equivalent", "barrels of oil equivalent"],
      ["contracts won", "contracts won"],
      ["units and dollars", "units and dollars"],
      ["Japanese yen per share", "Japanese yen per share"],
      ["Korean won and US dollars", "Korean won and US dollars"],
    ] as const)
      expect([name, thousands(name)]).toMatchObject([
        name,
        [{ scale: 1000, unit: { kind: "other", word } }],
      ]);
    for (const name of ["Canadian dollars", "contracts won", "tonnes"])
      expect([name, readStatedUnits(`(in thousands of ${name})`, EN)[0]?.unplacedCurrency]).toEqual(
        [name, undefined],
      );
  });

  test("a Chinese header states a scale and a currency", () => {
    expect(stated("单位：万元")).toEqual([
      {
        chars: "单位：万元",
        scale: 10000,
        scaleWord: "万",
        unit: { kind: "currency", code: "CNY" },
      },
    ]);
    expect(stated("金额单位：人民币千元")).toEqual([
      {
        chars: "金额单位：人民币千元",
        scale: 1000,
        scaleWord: "千",
        unit: { kind: "currency", code: "CNY" },
      },
    ]);
    expect(stated("RMB 百万元")).toEqual([
      {
        chars: "RMB 百万元",
        scale: 1000000,
        scaleWord: "百万",
        unit: { kind: "currency", code: "CNY" },
      },
    ]);
    expect(stated("单位：%")).toEqual([
      { chars: "单位：%", scale: 1, scaleWord: null, unit: { kind: "percent" } },
    ]);
    expect(stated("单位：万股")).toEqual([
      { chars: "单位：万股", scale: 10000, scaleWord: "万", unit: { kind: "other", word: "股" } },
    ]);
  });

  test("an English header states a scale, with a currency or without", () => {
    expect(stated("(in millions, except per share data)")).toEqual([
      { chars: "in millions", scale: 1000000, scaleWord: "millions", unit: { kind: "plain" } },
    ]);
    expect(stated("USD m")).toEqual([
      { chars: "USD m", scale: 1000000, scaleWord: "m", unit: { kind: "currency", code: "USD" } },
    ]);
    expect(stated("RMB'000")).toEqual([
      { chars: "RMB'000", scale: 1000, scaleWord: "'000", unit: { kind: "currency", code: "CNY" } },
    ]);
    expect(stated("£m")).toEqual([
      { chars: "£m", scale: 1000000, scaleWord: "m", unit: { kind: "currency", code: "GBP" } },
    ]);
  });

  test("a figure's own scale isn't a statement", () => {
    expect(stated("$1.2m and 3,500万元")).toEqual([]);
  });
});

describe("a currency written next to a scale", () => {
  test.each([
    "(£'000)",
    "£000s",
    "€ Mio.",
    "Tsd. €",
    "TEUR",
    "T€",
    "k€",
    "$K",
    "MEUR",
    "$MM",
    "USD MM",
    "新台幣仟元",
    "港幣百萬",
    "金额：人民币万元",
  ])("is found in %s", (text) => {
    expect(currencyScaleMarker(text)).not.toBeNull();
  });

  test.each([
    "In 2026 the sale completed.",
    "Unit 4, 12 Mill Lane",
    "I'm the seller's agent.",
    "M. Smith",
    "Room 000",
    "万栖",
    "一千",
    "工作单位",
    "Sale price £385,000.00",
    "Less: agent's fee (4,620.00)",
    "Deposit $12,000.00",
  ])("is not found in %s", (text) => {
    expect(currencyScaleMarker(text)).toBeNull();
  });
});

describe("a currency a line writes on its own figure", () => {
  test("is the line's statement when no other figure on it writes another", () => {
    expect(currencyOnItsFigure("Sale price £385,000.00", EN)).toEqual({
      chars: "£",
      code: "GBP",
      at: 11,
    });
    expect(currencyOnItsFigure("成交价 ¥3,850,000.00", ZH)).toEqual({
      chars: "¥",
      code: "CNY",
      at: 4,
    });
    expect(currencyOnItsFigure("Sale price 385,000.00", EN)).toBeNull();
    expect(currencyOnItsFigure("Less: agent's fee (4,620.00)", EN)).toBeNull();
    expect(currencyOnItsFigure("Sale price £385,000.00 deposit $12,000.00", EN)).toBeNull();
  });

  test("leaves a “¥” the Document doesn't settle unstated", () => {
    expect(currencyOnItsFigure("Sale price ¥385,000.00", EN)).toBeNull();
    expect(currencyOnItsFigure("Sale price ¥385,000.00", { language: "ja" })).toEqual({
      chars: "¥",
      code: "JPY",
      at: 11,
    });
  });
});

describe("how a Document writes its numbers", () => {
  test("is read from the numbers that can be read only one way", () => {
    expect(
      figureContextOf("Revenue of 12,345.6, costs of 9,876.5 and 1,234,567 units").separators,
    ).toEqual({
      decimal: ".",
      group: ",",
    });
    expect(figureContextOf("Umsatz 12.345,6 und Kosten 9.876,5").separators).toEqual({
      decimal: ",",
      group: ".",
    });
    expect(figureContextOf("Chiffre d'affaires 12 345,6 et coûts 9 876,5").separators).toEqual({
      decimal: ",",
      group: " ",
    });
  });

  test("says nothing when its numbers disagree or none tells", () => {
    expect(figureContextOf("12,345.6 and 9.876,5").separators).toBeNull();
    expect(figureContextOf("1,234 and 5.6").separators).toBeNull();
  });

  test("says what ¥ is when only yuan or only yen are named", () => {
    expect(figureContextOf("营业收入人民币1.2亿元").yen).toBe("CNY");
    expect(figureContextOf("売上高は1,200億円").yen).toBe("JPY");
    expect(figureContextOf("RMB 1.2bn and JPY 3bn").yen).toBeNull();
  });

  // protects=#2226; fails_when=a Chinese Document's ¥ is read as the yen because a line names 日元, or a Japanese one's isn't the yen.
  // protects=#2226; fails_when=a Chinese Document that names 日元 reads its ¥ as the yuan or the yen, or a Japanese one's ¥ isn't the yen.
  test("leaves ¥ unsettled when the Document names the other currency", () => {
    expect(figureContextOf("日本子公司（以日元列示）\n收入 ¥120,000,000", "zh-CN").yen).toBe(
      "unsure",
    );
    expect(figureContextOf("营业成本 1,200", "zh-CN").yen).toBe("CNY");
    expect(figureContextOf("料金は54,000円。売上高 ¥3,850,000", "ja").yen).toBe("JPY");
    expect(figureContextOf("Fee is 54,000 yen. Sale price ¥3,850,000", "en").yen).toBe("JPY");
  });
});

describe("A number at the start of a quote (#1969)", () => {
  const read = (text: string, context: FigureContext) =>
    readFigures(text, context).map((each) => [each.chars, each.value]);

  // protects=a number joined to the next one ("88.0 和 91.5") is a figure at a line's start, in Chinese and English, and so is any number at the start of a quote taken from the middle of a line, while a real heading's and list's numbers stay theirs; fails_when=88.0 is read as a heading number and calculate says the quote has no 88.0, or "3.1 收入" and "1. Revenue" give figures; no_claim=none beyond protects.
  test("is a figure unless it is a heading's or a list's", () => {
    expect(read("88.0 和 91.5（单位：百万元）", ZH)).toEqual([
      ["88.0", 88],
      ["91.5", 91.5],
    ]);
    expect(read("88.0 and 91.5 (GBP million)", EN).map(([chars]) => chars)).toEqual([
      "88.0",
      "91.5",
    ]);
    expect(read("3.1 收入", ZH)).toEqual([]);
    expect(read("3.1 收入\n收入为400.0", ZH)).toEqual([["400.0", 400]]);
    expect(read("2.1 Methods", EN)).toEqual([]);
    expect(read("1. Revenue rose 5%", EN)).toEqual([["5%", 0.05]]);
    expect(read("3.1 收入", { ...ZH, midLine: true })).toEqual([["3.1", 3.1]]);
    expect(read("88.0 起（2025年上半年）", { ...ZH, midLine: true })).toEqual([["88.0", 88]]);
  });
});

// protects=#2365; fails_when=a Document's scale in a form the reader didn't know ("'000", "000s", "(000 omitted)", "TEUR", "$MM", "金额（万）", "新台幣仟元") is missed, so its figures are read 1,000 or 10,000 times too small, or ordinary text ("order 000123", "1,000s of users", "万一", "(K)") is read as a scale.
describe("the scale forms a Document states apart from its figures (#2365)", () => {
  /** [text, what it states as "chars scale unit" (unit: an ISO code, or plain), what it leaves unsettled]. */
  const CASES: [string, string[], string[]][] = [
    // Thousands written with zeros.
    ["£'000", ["£'000 1000 GBP"], []],
    ["All amounts in '000", ["'000 1000 plain"], []],
    ["Figures in 000s", ["000s 1000 plain"], []],
    ["(000 omitted)", ["(000 omitted) 1000 plain"], []],
    ["(000's omitted)", ["(000's omitted) 1000 plain"], []],
    ["Dollar amounts, 000 omitted", ["000 omitted 1000 plain"], []],
    ["(in 000s)", ["000s 1000 plain"], []],
    ["('000)", ["'000 1000 plain"], []],
    ["(in 000)", ["(in 000) 1000 plain"], []],
    ["£000", ["£000 1000 GBP"], []],
    ["(thousands)", ["thousands 1000 plain"], []],
    ["Segment\tThousands", ["Thousands 1000 plain"], []],
    ["Unit: thousand", ["thousand 1000 plain"], []],
    ["Group £m\t2025", ["£m 1000000 GBP"], []],
    ["Loans (bn)", ["(bn) 1000000000 plain"], []],
    ["Loans (mn)", ["(mn) 1000000 plain"], []],
    ["Loans (bln)", ["(bln) 1000000000 plain"], []],
    ["Length (m)", [], []],
    ["Amounts in USD m", ["USD m 1000000 USD"], []],
    ["Amounts in USD bn", ["USD bn 1000000000 USD"], []],
    ["Amounts in $B", ["$B 1000000000 USD"], []],
    // A currency joined to a scale.
    ["Angaben in TEUR", ["TEUR 1000 EUR"], []],
    ["T€", ["T€ 1000 EUR"], []],
    ["k€", ["k€ 1000 EUR"], []],
    ["kEUR", ["kEUR 1000 EUR"], []],
    ["MEUR", ["MEUR 1000000 EUR"], []],
    ["€ Mio.", ["€ Mio. 1000000 EUR"], []],
    ["Tsd. €", ["Tsd. € 1000 EUR"], []],
    ["Amounts in $K", ["$K 1000 USD"], []],
    ["(in $MM)", ["$MM 1000000 USD"], []],
    ["($ in MM)", ["$ in MM 1000000 USD"], []],
    ["USD MM", ["USD MM 1000000 USD"], []],
    ["Rs. in lakhs", ["Rs. in lakhs 100000 INR"], []],
    // Simplified and Traditional Chinese.
    ["金额（万）", ["（万） 10000 plain"], []],
    ["单位：万", ["单位：万 10000 plain"], []],
    ["單位：新台幣仟元", ["單位：新台幣仟元 1000 TWD"], []],
    ["（新台幣仟元）", ["（新台幣仟元） 1000 TWD"], []],
    ["港幣百萬", ["港幣百萬 1000000 HKD"], []],
    ["（港幣百萬）", ["（港幣百萬） 1000000 HKD"], []],
    ["金額（億元）", ["（億元） 100000000 CNY"], []],
    // Not a scale: a figure, a code, a phone number, a clause, a name or a unit of measure.
    ["Share class USD B Acc", [], []],
    ["EUR M Dist", [], []],
    ["USD M&A advisory fees", [], []],
    ["Series M USD notes", [], []],
    ["Millions", [], []],
    ["Thousands", [], []],
    ["Fees were £19.8\nmillion, paid in 2025", [], []],
    ["Thousands of 000s of users", [], []],
    ["Vintage 000s", [], []],
    ["#000s", [], []],
    ["£m 2025", [], []],
    ["美元B类份额", [], []],
    ["账户尾号000", [], []],
    ["order 000123", [], []],
    ["Room 000", [], []],
    ["(000) 123-4567", [], []],
    ["1,000s of users", [], []],
    ["1 000s of users", [], []],
    ["Thousands of people attended.", [], []],
    ["1,2 M€", [], []],
    ["万一", [], []],
    ["一万人", [], []],
    ["约3（万）人", [], []],
    ["人民币千万不要", [], []],
    ["所以千元以下的产品", [], []],
    ["今欠到吴梅废书款伍拾肆万捌仟元整", [], []],
    ["他是村里的万元户", [], []],
    ["(K) the Seller's costs", [], []],
    ["Temperature (K)", [], []],
    ["Length (in mm)", [], []],
    ["Date (DD/MM)", [], []],
    ["Country B", [], []],
    ["in M&A", [], []],
    // A form that reads more than one way is refused, never guessed.
    ["Revenue (in MM)", [], ["in MM"]],
    ["(MM)", [], ["(MM)"]],
    ["Amounts in K", [], ["in K"]],
    ["Amounts in M", [], ["in M"]],
    ["Amounts in $T", [], ["$T"]],
    ["Accounts ending in 000", [], ["in 000"]],
    ["Call (000)", [], ["(000)"]],
    ["Revenue (000)", [], ["(000)"]],
    ["Holdings of TUSD stablecoin", [], ["TUSD"]],
    ["Fund (USD B)", [], ["USD B"]],
    ["Ticker GBP M:", [], ["GBP M"]],
    ["Units held: USD K", [], ["USD K"]],
    ["We hold Class USD B", [], ["USD B"]],
  ];

  test.each(CASES)("%s", (text, statements, unsettled) => {
    expect(
      readStatedUnits(text).map(
        ({ chars, scale, unit }) =>
          `${chars} ${scale} ${unit.kind === "currency" ? unit.code : unit.kind}`,
      ),
    ).toEqual(statements);
    expect(unsettledScales(text)).toEqual(unsettled);
  });

  test("a scale statement says which figures it leaves out", () => {
    const except = (text: string) => readStatedUnits(text).map((each) => [each.chars, each.except]);
    expect(except("Results (in millions, except per share data)")).toEqual([
      ["in millions", "per-share"],
    ]);
    expect(except("(In thousands of dollars, except share and per-share amounts)")).toEqual([
      ["In thousands of dollars", "shares"],
    ]);
    expect(except("单位：千元（除每股数据外）")).toEqual([["单位：千元", "per-share"]]);
    expect(except("（除股数及每股数据外，单位：百万元）")).toEqual([["单位：百万元", "shares"]]);
    expect(except("Results (in millions)")).toEqual([["in millions", undefined]]);
    expect(except("In millions of dollars, except where noted")).toEqual([
      ["In millions of dollars", "noted"],
    ]);
    expect(except("单位：百万元（除另有说明外）")).toEqual([["单位：百万元", "noted"]]);
  });

  test("a figure written in 仟 is read at its scale, as 萬 and 億 are", () => {
    expect(readFigures("新台幣5,000仟元").map((each) => [each.value, each.unit])).toEqual([
      [5_000_000, { kind: "currency", code: "TWD" }],
    ]);
  });
});

// protects=#2341; fails_when=a bracket that gives the amount just before it again in figures, as
// contracts write "人民币九万八千元（¥98,000）" and "Seventy-Five Thousand Dollars ($75,000.00)", is read
// as an accounting negative, so a correct sentence is Contradicted; or a bracket that is a real
// minus, or that disagrees with the words before it, stops being one.
describe("a bracket right after an amount (#2341)", () => {
  const cases: [text: string, context: FigureContext, figures: Expected[]][] = [
    [
      "人民币九万八千元（¥98,000）",
      ZH,
      [f("人民币九万八千元", 98000, { unit: "CNY" }), f("¥98,000", 98000, { unit: "CNY" })],
    ],
    [
      "壹拾万元整（¥100,000.00）",
      ZH,
      [
        f("壹拾万元整", 100000, { unit: "CNY", scale: "万" }),
        f("¥100,000.00", 100000, { unit: "CNY" }),
      ],
    ],
    [
      "USD 1.2 million ($1,200,000)",
      EN,
      [
        f("USD 1.2 million", 1200000, { unit: "USD", scale: "million" }),
        f("$1,200,000", 1200000, { unit: "USD" }),
      ],
    ],
    [
      "首付款为人民币叁万伍仟元整（¥35,000.00）。",
      ZH,
      [f("人民币叁万伍仟元整", 35000, { unit: "CNY" }), f("¥35,000.00", 35000, { unit: "CNY" })],
    ],
    [
      "保证金为人民币7.5万元（¥75,000）",
      ZH,
      [
        f("人民币7.5万元", 75000, { unit: "CNY", scale: "万" }),
        f("¥75,000", 75000, { unit: "CNY" }),
      ],
    ],
    [
      "保证金为人民币7.5万元 （¥75,000）",
      ZH,
      [
        f("人民币7.5万元", 75000, { unit: "CNY", scale: "万" }),
        f("¥75,000", 75000, { unit: "CNY" }),
      ],
    ],
    [
      "总价为人民币2.4亿元（¥240,000,000）",
      ZH,
      [
        f("人民币2.4亿元", 240000000, { unit: "CNY", scale: "亿" }),
        f("¥240,000,000", 240000000, { unit: "CNY" }),
      ],
    ],
    [
      "服务费为人民币三千元（¥3,000）",
      ZH,
      [f("人民币三千元", 3000, { unit: "CNY" }), f("¥3,000", 3000, { unit: "CNY" })],
    ],
    ["租金为八千五百元（8,500）", ZH, [f("八千五百元", 8500, { unit: "CNY" }), f("8,500", 8500)]],
    ["租金为八千五百元(8,500)", ZH, [f("八千五百元", 8500, { unit: "CNY" }), f("8,500", 8500)]],
    ["租金为八千五百元（8500）", ZH, [f("八千五百元", 8500, { unit: "CNY" }), f("8500", 8500)]],
    ["共计四万二千（42,000）", ZH, [f("四万二千", 42000), f("42,000", 42000)]],
    ["共计四万二千（¥42,000）", ZH, [f("四万二千", 42000), f("¥42,000", 42000, { unit: "CNY" })]],
    [
      "增幅为百分之十五（15%）",
      ZH,
      [f("百分之十五", 0.15, { unit: "%" }), f("15%", 0.15, { unit: "%" })],
    ],
    [
      "乙方负责支付人民币六万四千元（¥64,000）",
      ZH,
      [f("人民币六万四千元", 64000, { unit: "CNY" }), f("¥64,000", 64000, { unit: "CNY" })],
    ],
    [
      "本期收入人民币六万四千元（¥64,000）",
      ZH,
      [f("人民币六万四千元", 64000, { unit: "CNY" }), f("¥64,000", 64000, { unit: "CNY" })],
    ],
    [
      "尾款为人民币六万四千元整（¥64,000.00）。",
      ZH,
      [f("人民币六万四千元", 64000, { unit: "CNY" }), f("¥64,000.00", 64000, { unit: "CNY" })],
    ],
    [
      "人民币6.4万元整（¥64,000）",
      ZH,
      [
        f("人民币6.4万元", 64000, { unit: "CNY", scale: "万" }),
        f("¥64,000", 64000, { unit: "CNY" }),
      ],
    ],
    [
      "The Tenant shall pay Seventy-Five Thousand Dollars ($75,000.00) each quarter.",
      EN,
      [f("$75,000.00", 75000, { unit: "USD" })],
    ],
    [
      "a fee of one hundred and twenty thousand pounds (£120,000)",
      EN,
      [f("£120,000", 120000, { unit: "GBP" })],
    ],
    [
      "Two Million Four Hundred Thousand US Dollars (US$2,400,000)",
      EN,
      [f("US$2,400,000", 2400000, { unit: "USD" })],
    ],
    [
      "Twelve Thousand Five Hundred and 50/100 Dollars ($12,500.50)",
      EN,
      [f("$12,500.50", 12500.5, { unit: "USD" })],
    ],
    ["SIXTY-TWO THOUSAND ONE HUNDRED TEN (62,110)", EN, [f("62,110", 62110)]],
    [
      "The balance is sixty-four thousand dollars ($64,000.00).",
      EN,
      [f("$64,000.00", 64000, { unit: "USD" })],
    ],
    [
      "The position was Forty-One Thousand Dollars ($41,000.00) at year end.",
      EN,
      [f("$41,000.00", 41000, { unit: "USD" })],
    ],
    [
      "The fair value was $3.4 million ($3,400,000).",
      EN,
      [
        f("$3.4 million", 3400000, { unit: "USD", scale: "million" }),
        f("$3,400,000", 3400000, { unit: "USD" }),
      ],
    ],
    [
      "3.4 million (3,400,000)",
      EN,
      [f("3.4 million", 3400000, { scale: "million" }), f("3,400,000", 3400000)],
    ],
    [
      "not less than sixty-four thousand dollars ($64,000)",
      EN,
      [f("$64,000", 64000, { unit: "USD" })],
    ],
    ["Total three thousand seven hundred ($3,700.00)", EN, [f("$3,700.00", 3700, { unit: "USD" })]],
    [
      "a hundred and sixty thousand dollars ($160,000)",
      EN,
      [f("$160,000", 160000, { unit: "USD" })],
    ],
    ["a thousand dollars ($1,000)", EN, [f("$1,000", 1000, { unit: "USD" })]],
    [
      "Eight Thousand Two Hundred Dollars and 25/100 ($8,200.25)",
      EN,
      [f("$8,200.25", 8200.25, { unit: "USD" })],
    ],
    ["Seven Thousand, Three Hundred Dollars ($7,300)", EN, [f("$7,300", 7300, { unit: "USD" })]],
    [
      "Sixty-Four Thousand Australian Dollars ($64,000)",
      EN,
      [f("$64,000", 64000, { unit: "AUD" })],
    ],
    [
      "¥9.8 million (¥9,800,000)",
      EN,
      [
        f("¥9.8 million", 9800000, { unit: "CNY", scale: "million", ambiguous: ["currency"] }),
        f("¥9,800,000", 9800000, { unit: "CNY", ambiguous: ["currency"] }),
      ],
    ],
    [
      "港币六万四千元（$64,000）",
      ZH,
      [f("港币六万四千元", 64000, { unit: "HKD" }), f("$64,000", 64000, { unit: "HKD" })],
    ],
    [
      "The balance fell from 98,000 to ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("98,000", 98000), f("$95,000.00", 95000, { unit: "USD" })],
    ],
    [
      "余额从8,000元增至人民币九万五千元（¥95,000）。",
      ZH,
      [
        f("8,000元", 8000, { unit: "CNY" }),
        f("人民币九万五千元", 95000, { unit: "CNY" }),
        f("¥95,000", 95000, { unit: "CNY" }),
      ],
    ],
    [
      "余额由1.5万元变为人民币九万五千元（¥95,000）",
      ZH,
      [
        f("1.5万元", 15000, { unit: "CNY", scale: "万" }),
        f("人民币九万五千元", 95000, { unit: "CNY" }),
        f("¥95,000", 95000, { unit: "CNY" }),
      ],
    ],
    [
      "The balance moved from $1.5 million to $1.2 million ($1,200,000).",
      EN,
      [
        f("$1.5 million", 1500000, { unit: "USD", scale: "million" }),
        f("$1.2 million", 1200000, { unit: "USD", scale: "million" }),
        f("$1,200,000", 1200000, { unit: "USD" }),
      ],
    ],
    [
      "The movement recorded over the full year for the combined portfolio of the Group's subsidiaries in all of its regions after all adjustments was seventy-five thousand dollars ($75,000.00).",
      EN,
      [f("$75,000.00", 75000, { unit: "USD" })],
    ],
    [
      `Paid: ${"the deposit held for the tenant ".repeat(6)}four thousand dollars ($4,000.00)`,
      EN,
      [f("$4,000.00", 4000, { unit: "USD" })],
    ],
    [
      "公司负债总额为人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("¥62,000", 62000, { unit: "CNY" })],
    ],
    [
      "负面清单项目金额为人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("¥62,000", 62000, { unit: "CNY" })],
    ],
    [
      "由乙方负担的费用为人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("¥62,000", 62000, { unit: "CNY" })],
    ],
    [
      "The negative pledge covers debt of ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("$95,000.00", 95000, { unit: "USD" })],
    ],
    [
      "The nonnegative balance was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("$95,000.00", 95000, { unit: "USD" })],
    ],
    [
      "The fund's net position, sixty-two thousand dollars ($62,000.00), turned positive in March.",
      EN,
      [f("$62,000.00", 62000, { unit: "USD" })],
    ],
    [
      "现金净流量为人民币六万二千元（¥62,000），属于正数。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("¥62,000", 62000, { unit: "CNY" })],
    ],
    [
      "The subsidiary posted a net profit for the year. Its result was sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("$62,000.00", 62000, { unit: "USD" })],
    ],
    [
      "该子公司本年度实现盈利，经营成果为人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("¥62,000", 62000, { unit: "CNY" })],
    ],
    [
      "A minuscule share of the fund, sixty-two thousand dollars ($62,000.00), was paid out.",
      EN,
      [f("$62,000.00", 62000, { unit: "USD" })],
    ],
    [
      "Income statement\nRevenue $1.2m ($1,200,000)",
      EN,
      [f("$1.2m", 1200000, { unit: "USD", scale: "m" }), f("$1,200,000", 1200000, { unit: "USD" })],
    ],
    [
      "Revenue $1.2m ($1,200,000)",
      { ...EN, header: "Revenue" },
      [f("$1.2m", 1200000, { unit: "USD", scale: "m" }), f("$1,200,000", 1200000, { unit: "USD" })],
    ],
    [
      "利润表\n营业收入 2.5万 （25,000）",
      ZH,
      [f("2.5万", 25000, { scale: "万" }), f("25,000", 25000)],
    ],
    [
      "The lease runs from 1 March 2026 to 28 February 2027.\nThe rent is $1.2m ($1,200,000).",
      EN,
      [f("$1.2m", 1200000, { unit: "USD", scale: "m" }), f("$1,200,000", 1200000, { unit: "USD" })],
    ],
    [
      "The rent shall be not less than sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("$62,000.00", 62000, { unit: "USD" })],
    ],
    [
      "幸亏账户余额充足，租金人民币六万二千元（¥62,000）已付。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("¥62,000", 62000, { unit: "CNY" })],
    ],
    [
      "多亏及时还款，账户余额人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("¥62,000", 62000, { unit: "CNY" })],
    ],
    [
      "投资风险自负，认购金额为人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("¥62,000", 62000, { unit: "CNY" })],
    ],
    [
      `Cash came to sixty-two thousand dollars ($62,000.00). ${"x".repeat(389)} negative`,
      EN,
      [f("$62,000.00", 62000, { unit: "USD" })],
    ],
    [
      `Cash came to sixty-two thousand dollars ($62,000.00). ${"The Tenant shall keep the premises in good repair. ".repeat(9)}That balance is negative.`,
      EN,
      [f("$62,000.00", 62000, { unit: "USD" })],
    ],
    [
      `${"x".repeat(399)} sixty-two thousand dollars ($62,000.00)`,
      EN,
      [f("$62,000.00", 62000, { unit: "USD" })],
    ],
    [
      "| Deposit | Four Thousand Dollars ($4,000.00) |",
      EN,
      [f("$4,000.00", 4000, { unit: "USD" })],
    ],
    [
      "The account had a balance, after all adjustments, of seventy-five thousand dollars ($75,000.00).",
      EN,
      [f("$75,000.00", 75000, { unit: "USD" })],
    ],
    [
      "The balance, which was settled, was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("$95,000.00", 95000, { unit: "USD" })],
    ],
    [
      "The Group held a U.S. dollar balance of ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("$95,000.00", 95000, { unit: "USD" })],
    ],
    [
      "账户为正余额，经调整后为人民币九万五千元（¥95,000）。",
      ZH,
      [f("人民币九万五千元", 95000, { unit: "CNY" }), f("¥95,000", 95000, { unit: "CNY" })],
    ],
    [
      "余额为3.5万元，即人民币三万五千元（¥35,000）。",
      ZH,
      [
        f("3.5万元", 35000, { unit: "CNY", scale: "万" }),
        f("人民币三万五千元", 35000, { unit: "CNY" }),
        f("¥35,000", 35000, { unit: "CNY" }),
      ],
    ],
    [
      "The account had a balance of sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("$62,000.00", 62000, { unit: "USD" })],
    ],
    [
      "The fund reported net cash of $2.6 million ($2,600,000).",
      EN,
      [
        f("$2.6 million", 2600000, { unit: "USD", scale: "million" }),
        f("$2,600,000", 2600000, { unit: "USD" }),
      ],
    ],
    [
      "账户余额人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("¥62,000", 62000, { unit: "CNY" })],
    ],
    [
      "金额为人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("¥62,000", 62000, { unit: "CNY" })],
    ],
    [
      "Change: $2.6 million ($2,600,000)",
      EN,
      [
        f("$2.6 million", 2600000, { unit: "USD", scale: "million" }),
        f("$2,600,000", 2600000, { unit: "USD" }),
      ],
    ],
    ["sixty-two thousand dollars ($62,000)", EN, [f("$62,000", 62000, { unit: "USD" })]],
    [
      "已付定金人民币四千元（¥4,000）",
      ZH,
      [f("人民币四千元", 4000, { unit: "CNY" }), f("¥4,000", 4000, { unit: "CNY" })],
    ],
    ["Deposit paid four thousand dollars ($4,000.00)", EN, [f("$4,000.00", 4000, { unit: "USD" })]],
    [
      "括号内为负责人签字的金额。\n本期金额人民币2.7万元（¥27,000）",
      ZH,
      [
        f("人民币2.7万元", 27000, { unit: "CNY", scale: "万" }),
        f("¥27,000", 27000, { unit: "CNY" }),
      ],
    ],
    ["Sixty Thousand Dollars (60,000)", EN, [f("60,000", 60000)]],
    ["the sum of Forty-Two Thousand ($42,000)", EN, [f("$42,000", 42000, { unit: "USD" })]],
    ["ninety-eight thousand yuan (¥98,000)", EN, [f("¥98,000", 98000, { unit: "CNY" })]],
    ["a notice period of one hundred twenty (120) days", EN, [f("120", 120)]],
    [
      "£1.5m (£1,500,000)",
      EN,
      [f("£1.5m", 1500000, { unit: "GBP", scale: "m" }), f("£1,500,000", 1500000, { unit: "GBP" })],
    ],
    [
      "$2.4 million (2,400,000)",
      EN,
      [f("$2.4 million", 2400000, { unit: "USD", scale: "million" }), f("2,400,000", 2400000)],
    ],
    [
      "$98,000 (98,000 USD)",
      EN,
      [f("$98,000", 98000, { unit: "USD" }), f("98,000 USD", 98000, { unit: "USD" })],
    ],
  ];
  test.each(cases)("%s gives the same amount twice", (text, context, figures) => {
    const read = readFigures(text, context);
    expect(read.map(shape)).toEqual(figures);
    for (const figure of read) expect(text.slice(figure.start, figure.end)).toBe(figure.chars);
  });

  const disagreeing: [text: string, context: FigureContext, figures: Expected[]][] = [
    [
      "人民币三万五千元（¥53,000）",
      ZH,
      [f("人民币三万五千元", 35000, { unit: "CNY" }), f("（¥53,000）", -53000, { unit: "CNY" })],
    ],
    [
      "人民币七千五百元（¥75,000）",
      ZH,
      [f("人民币七千五百元", 7500, { unit: "CNY" }), f("（¥75,000）", -75000, { unit: "CNY" })],
    ],
    [
      "人民币7.5万元（¥7,500）",
      ZH,
      [
        f("人民币7.5万元", 75000, { unit: "CNY", scale: "万" }),
        f("（¥7,500）", -7500, { unit: "CNY" }),
      ],
    ],
    [
      "USD 2.4 million ($240,000)",
      EN,
      [
        f("USD 2.4 million", 2400000, { unit: "USD", scale: "million" }),
        f("($240,000)", -240000, { unit: "USD" }),
      ],
    ],
    ["Seventy-Five Thousand Dollars ($57,000)", EN, [f("($57,000)", -57000, { unit: "USD" })]],
    [
      "人民币七万五千元（US$75,000）",
      ZH,
      [f("人民币七万五千元", 75000, { unit: "CNY" }), f("（US$75,000）", -75000, { unit: "USD" })],
    ],
    ["Seventy-Five Thousand Pounds ($75,000)", EN, [f("($75,000)", -75000, { unit: "USD" })]],
    [
      "人民币六万四千元整（¥46,000.00）",
      ZH,
      [f("人民币六万四千元", 64000, { unit: "CNY" }), f("（¥46,000.00）", -46000, { unit: "CNY" })],
    ],
  ];
  test.each(disagreeing)(
    "%s writes two amounts, and the bracket is not the words' amount",
    (text, context, figures) => {
      expect(readFigures(text, context).map(shape)).toEqual(figures);
    },
  );

  const negatives: [text: string, context: FigureContext, figures: Expected[]][] = [
    ["Finance costs (2,750)", EN, [f("(2,750)", -2750)]],
    ["财务费用（2,750）", ZH, [f("（2,750）", -2750)]],
    ["Revenue\t3,000\nCost of sales\t(1,250)", EN, [f("3,000", 3000), f("(1,250)", -1250)]],
    ["Net loss\t(4,321)", EN, [f("(4,321)", -4321)]],
    ["净亏损\t（4,321）", ZH, [f("（4,321）", -4321)]],
    ["Eliminations 3,600 (3,600)", EN, [f("3,600", 3600), f("(3,600)", -3600)]],
    ["抵销\t3,600\t（3,600）", ZH, [f("3,600", 3600), f("（3,600）", -3600)]],
    [
      "营业收入\t1.2亿元\t（120,000,000）",
      ZH,
      [f("1.2亿元", 120000000, { unit: "CNY", scale: "亿" }), f("（120,000,000）", -120000000)],
    ],
    ["Amounts in brackets are negative.\nOperating loss (6,480)", EN, [f("(6,480)", -6480)]],
    ["括号内金额为负数。\n营业亏损（6,480）", ZH, [f("（6,480）", -6480)]],
    [
      "Revenue was £1.2m and the impairment (£1,200,000)",
      EN,
      [
        f("£1.2m", 1200000, { unit: "GBP", scale: "m" }),
        f("(£1,200,000)", -1200000, { unit: "GBP" }),
      ],
    ],
    [
      "保证金人民币7.5万元\n（75,000）",
      ZH,
      [f("人民币7.5万元", 75000, { unit: "CNY", scale: "万" }), f("（75,000）", -75000)],
    ],
    ["负1,234", ZH, [f("负1,234", -1234)]],
    [
      "利润为负 三万五千元（¥35,000）",
      ZH,
      [f("负 三万五千元", -35000, { unit: "CNY" }), f("（¥35,000）", -35000, { unit: "CNY" })],
    ],
    [
      "净亏损人民币三万五千元（¥35,000）",
      ZH,
      [f("人民币三万五千元", 35000, { unit: "CNY" }), f("（¥35,000）", -35000, { unit: "CNY" })],
    ],
    [
      "本期亏损人民币六万四千元（¥64,000）",
      ZH,
      [f("人民币六万四千元", 64000, { unit: "CNY" }), f("（¥64,000）", -64000, { unit: "CNY" })],
    ],
    [
      "收入减少人民币6.4万元（¥64,000）",
      ZH,
      [
        f("人民币6.4万元", 64000, { unit: "CNY", scale: "万" }),
        f("（¥64,000）", -64000, { unit: "CNY" }),
      ],
    ],
    [
      "本期亏损为人民币六万四千元（¥64,000）",
      ZH,
      [f("人民币六万四千元", 64000, { unit: "CNY" }), f("（¥64,000）", -64000, { unit: "CNY" })],
    ],
    [
      "收入减少了人民币6.4万元（¥64,000）",
      ZH,
      [
        f("人民币6.4万元", 64000, { unit: "CNY", scale: "万" }),
        f("（¥64,000）", -64000, { unit: "CNY" }),
      ],
    ],
    [
      "本年赤字人民币六万四千元（¥64,000）",
      ZH,
      [f("人民币六万四千元", 64000, { unit: "CNY" }), f("（¥64,000）", -64000, { unit: "CNY" })],
    ],
    [
      "利润下降人民币6.4万元（¥64,000）",
      ZH,
      [
        f("人民币6.4万元", 64000, { unit: "CNY", scale: "万" }),
        f("（¥64,000）", -64000, { unit: "CNY" }),
      ],
    ],
    [
      "本期损失人民币六万四千元（¥64,000）",
      ZH,
      [f("人民币六万四千元", 64000, { unit: "CNY" }), f("（¥64,000）", -64000, { unit: "CNY" })],
    ],
    [
      "The balance is minus sixty-four thousand dollars ($64,000.00).",
      EN,
      [f("($64,000.00)", -64000, { unit: "USD" })],
    ],
    [
      "a loss of sixty-four thousand dollars ($64,000)",
      EN,
      [f("($64,000)", -64000, { unit: "USD" })],
    ],
    [
      "Revenue decreased by sixty-four thousand dollars ($64,000)",
      EN,
      [f("($64,000)", -64000, { unit: "USD" })],
    ],
    [
      "The position was negative Forty-One Thousand Dollars ($41,000.00) at year end.",
      EN,
      [f("($41,000.00)", -41000, { unit: "USD" })],
    ],
    [
      "The fair value was negative $3.4 million ($3,400,000).",
      EN,
      [
        f("$3.4 million", 3400000, { unit: "USD", scale: "million" }),
        f("($3,400,000)", -3400000, { unit: "USD" }),
      ],
    ],
    [
      "minus 3.4 million (3,400,000)",
      EN,
      [f("3.4 million", 3400000, { scale: "million" }), f("(3,400,000)", -3400000)],
    ],
    [
      "(negative) sixty-four thousand dollars ($64,000)",
      EN,
      [f("($64,000)", -64000, { unit: "USD" })],
    ],
    ["−sixty-four thousand dollars ($64,000)", EN, [f("($64,000)", -64000, { unit: "USD" })]],
    ["less sixty-four thousand dollars ($64,000)", EN, [f("($64,000)", -64000, { unit: "USD" })]],
    [
      "a deficit of sixty-four thousand dollars ($64,000)",
      EN,
      [f("($64,000)", -64000, { unit: "USD" })],
    ],
    [
      "Total three thousand\tseven hundred ($3,700.00)",
      EN,
      [f("($3,700.00)", -3700, { unit: "USD" })],
    ],
    [
      "Total three thousand | seven hundred ($3,700.00)",
      EN,
      [f("($3,700.00)", -3700, { unit: "USD" })],
    ],
    [
      "Figures in brackets are negative amounts.\nNet cash £2.7m (£2,700,000)",
      EN,
      [
        f("£2.7m", 2700000, { unit: "GBP", scale: "m" }),
        f("(£2,700,000)", -2700000, { unit: "GBP" }),
      ],
    ],
    [
      "括号内数字为负数。\n本期净额人民币2.7万元（¥27,000）",
      ZH,
      [
        f("人民币2.7万元", 27000, { unit: "CNY", scale: "万" }),
        f("（¥27,000）", -27000, { unit: "CNY" }),
      ],
    ],
    [
      "Negative amounts are shown in parentheses.\nNet cash £2.7m (£2,700,000)",
      EN,
      [
        f("£2.7m", 2700000, { unit: "GBP", scale: "m" }),
        f("(£2,700,000)", -2700000, { unit: "GBP" }),
      ],
    ],
    [
      "括号内的数字是负数。\n本期净额人民币2.7万元（¥27,000）",
      ZH,
      [
        f("人民币2.7万元", 27000, { unit: "CNY", scale: "万" }),
        f("（¥27,000）", -27000, { unit: "CNY" }),
      ],
    ],
    ["Sixty-Two\nThousand Dollars ($62,000)", EN, [f("($62,000)", -62000, { unit: "USD" })]],
    [
      "括号内金额为负。\n本期净额人民币2.7万元（¥27,000）",
      ZH,
      [
        f("人民币2.7万元", 27000, { unit: "CNY", scale: "万" }),
        f("（¥27,000）", -27000, { unit: "CNY" }),
      ],
    ],
    [
      "The account had a negative balance of sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The fund reported negative net cash of $2.6 million ($2,600,000).",
      EN,
      [
        f("$2.6 million", 2600000, { unit: "USD", scale: "million" }),
        f("($2,600,000)", -2600000, { unit: "USD" }),
      ],
    ],
    [
      "The negative balance fell from 98,000 to ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("98,000", 98000), f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "负数余额从8,000元增至人民币九万五千元（¥95,000）。",
      ZH,
      [
        f("8,000元", 8000, { unit: "CNY" }),
        f("人民币九万五千元", 95000, { unit: "CNY" }),
        f("（¥95,000）", -95000, { unit: "CNY" }),
      ],
    ],
    [
      "负余额由1.5万元变为人民币九万五千元（¥95,000）",
      ZH,
      [
        f("1.5万元", 15000, { unit: "CNY", scale: "万" }),
        f("人民币九万五千元", 95000, { unit: "CNY" }),
        f("（¥95,000）", -95000, { unit: "CNY" }),
      ],
    ],
    [
      "The negative balance moved from $1.5 million to $1.2 million ($1,200,000).",
      EN,
      [
        f("$1.5 million", 1500000, { unit: "USD", scale: "million" }),
        f("$1.2 million", 1200000, { unit: "USD", scale: "million" }),
        f("($1,200,000)", -1200000, { unit: "USD" }),
      ],
    ],
    [
      "The negative movement recorded over the full year for the combined portfolio of the Group's subsidiaries in all of its regions after all adjustments was seventy-five thousand dollars ($75,000.00).",
      EN,
      [f("($75,000.00)", -75000, { unit: "USD" })],
    ],
    [
      `The amount ${"of the fund held for the tenant ".repeat(14)}is ninety-five thousand dollars ($95,000.00)`,
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      `Less: ${"the deposit held for the tenant ".repeat(6)}four thousand dollars ($4,000.00)`,
      EN,
      [f("($4,000.00)", -4000, { unit: "USD" })],
    ],
    [
      "Item\tAmount\nLess\tdeposit paid four thousand dollars ($4,000.00)",
      EN,
      [f("($4,000.00)", -4000, { unit: "USD" })],
    ],
    [
      "| Less | Four Thousand Dollars ($4,000.00) |",
      EN,
      [f("($4,000.00)", -4000, { unit: "USD" })],
    ],
    [
      "The negative balance owed by Party A Inc. was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance of Party B Ltd. stood at ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance due to Mr. A was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance due to Mrs. B was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance due to Ms. C was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance due to Dr. D was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance in Account No. 5 was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance was approx. ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance (see Note 5.) was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance... was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance at the St. Louis branch was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance of Party C Jr. Holdings was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance due to Prof. E was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance of Party D Corp. Treasury was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance of Party B Co. Ltd. was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance at the Mt. Alder branch was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance (Dept. Finance) was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance in Account No. A12 was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance of the U.S. Treasury was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance in each fund, e.g. Fund A, was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance of Alpha vs. Beta was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance (fees, rent, etc. Included) was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The balance was negative for Party A Inc. The fee was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance in acct. A12 was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance in vol. II was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance under sec. B was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance under art. IV was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance, est. March, was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance for the 40 ft. Container was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("40", 40), f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance at 17:00 hrs. GMT was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance in the finance dept. Ledger was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance in acct. No. 12 was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "账户为负余额，见 vol. II，金额为人民币九万五千元（¥95,000）。",
      ZH,
      [f("人民币九万五千元", 95000, { unit: "CNY" }), f("（¥95,000）", -95000, { unit: "CNY" })],
    ],
    [
      "负余额（见 acct. A12）为人民币九万五千元（¥95,000）。",
      ZH,
      [f("人民币九万五千元", 95000, { unit: "CNY" }), f("（¥95,000）", -95000, { unit: "CNY" })],
    ],
    [
      "The negative balance of the... Group was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance of the fund… Group was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance in Section 4. Part B was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance\nwas ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative balance at the St.\nLouis branch was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The balance was negative. It was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The account went negative at year end. The balance was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "期末现金余额为负。其金额为人民币九万五千元（¥95,000）。",
      ZH,
      [f("人民币九万五千元", 95000, { unit: "CNY" }), f("（¥95,000）", -95000, { unit: "CNY" })],
    ],
    [
      `The amount ${"of the fund held for the tenant ".repeat(14)}was set. The rent is ninety-five thousand dollars ($95,000.00)`,
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "Party A had a negative result. Party A Inc. paid a fee of ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The result was negative. Party B Ltd. paid ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The outlook was negative. Mr. A paid ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The balance was negative. Account 5 then held ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("5", 5), f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The rate was negative. Approx. ninety-five thousand dollars ($95,000.00) was paid.",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The balance was negative (see Note 5). The fee was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The balance was negative... The fee was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "There was a negative outlook. The rent is sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The balance was negative; the fee was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "前景为负．租金为人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "前景为负。租金为人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "The fund's net position, sixty-two thousand dollars ($62,000.00), turned negative in March.",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Cash at the branch came to sixty-two thousand dollars ($62,000.00); this figure is negative.",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The adjustment was sixty-two thousand dollars ($62,000.00), shown with a minus sign.",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Net position | sixty-two thousand dollars ($62,000.00) | negative",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "现金净流量为人民币六万二千元（¥62,000），属于负数。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "期末未分配利润人民币六万二千元（¥62,000）系负值。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "The subsidiary posted a net loss for the year. Its result was sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The company reported an operating loss. Operating income was sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The current account is overdrawn by sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The division slipped into the red; its operating result was sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The scheme ran a deficit, and its funding level was sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Overdraft balance: sixty-two thousand dollars ($62,000.00)",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Net result (−): sixty-two thousand dollars ($62,000.00)",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "该子公司本年度出现亏损，经营成果为人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "公司账户透支人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "公司由盈转亏，净利润为人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "财政出现赤字，差额为人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      `The negative ${"result for the region ".repeat(11)}was sixty-two thousand dollars ($62,000.00)`,
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      `${"x".repeat(400)} sixty-two thousand dollars ($62,000.00)`,
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The pension scheme remains in deficit; its funding position is sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The group recorded a small net loss. Its earnings were sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The loss-making unit's result was sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Net cash at year end: - sixty-two thousand dollars ($62,000.00)",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The movement was – sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Net debt movement: − USD 6.2 million ($6,200,000)",
      EN,
      [
        f("USD 6.2 million", 6200000, { unit: "USD", scale: "million" }),
        f("($6,200,000)", -6200000, { unit: "USD" }),
      ],
    ],
    [
      "The account stood below zero, at sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Retained earnings fell under zero: sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Its equity, sixty-two thousand dollars ($62,000.00), was less than zero.",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The ledger shows the account in debit, sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Cash position -ve: sixty-two thousand dollars ($62,000.00)",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Current account OD sixty-two thousand dollars ($62,000.00)",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The figure, sixty-two thousand dollars ($62,000.00), is printed in red.",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The project is under water by sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "期末现金余额低于零，为人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "账户余额小于零：人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "该项目以红字列示人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "本年净利润为亏，金额人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "本期净亏人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "应付款项扣减人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "抵扣人民币六万二千元（¥62,000）后的余额",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "减去人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "减除人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "Deduct: retention of sixty-two thousand dollars ($62,000.00)",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Less — retention of sixty-two thousand dollars ($62,000.00)",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      `Cash came to sixty-two thousand dollars ($62,000.00). ${"x".repeat(388)} negative`,
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Its result is shown in red: sixty-two thousand dollars ($62,000.00)",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The underwater loan stood at sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "本月亏了人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "Income statement\n 2025 2024\nRevenue $1.2m ($1,200,000)",
      EN,
      [
        f("$1.2m", 1200000, { unit: "USD", scale: "m" }),
        f("($1,200,000)", -1200000, { unit: "USD" }),
      ],
    ],
    [
      "Balance sheet\nItem 31 December 2025 31 December 2024\nCash $1.2m ($1,200,000)",
      EN,
      [
        f("$1.2m", 1200000, { unit: "USD", scale: "m" }),
        f("($1,200,000)", -1200000, { unit: "USD" }),
      ],
    ],
    [
      "Revenue $1.2m ($1,200,000)",
      { ...EN, header: "2025 2024" },
      [
        f("$1.2m", 1200000, { unit: "USD", scale: "m" }),
        f("($1,200,000)", -1200000, { unit: "USD" }),
      ],
    ],
    [
      "利润表\n项目 本期 上期\n营业收入 2.5万 （25,000）",
      ZH,
      [f("2.5万", 25000, { scale: "万" }), f("（25,000）", -25000)],
    ],
    [
      "营业收入 2.5万 （25,000）",
      { ...ZH, header: "本期 上期" },
      [f("2.5万", 25000, { scale: "万" }), f("（25,000）", -25000)],
    ],
    [
      "The loss was sixty-four thousand dollars ($64,000)",
      EN,
      [f("($64,000)", -64000, { unit: "USD" })],
    ],
    [
      "实行自负盈亏的项目预算为人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "The net loss for the period came to sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Losses on disposal: sixty-two thousand dollars ($62,000.00)",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The funding deficit was sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Rent of sixty-two thousand dollars ($62,000.00), less the deposit.",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The invoice, after deducting a discount, came to sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "Less:\nDeposit paid sixty-two thousand dollars ($62,000.00)",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "减：\n已付定金人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "本期贸易逆差为人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "项目资金缺口人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "资产损失合计为人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "Income statement\nFY2025 FY2024\nRevenue $1.2m ($1,200,000)",
      EN,
      [
        f("$1.2m", 1200000, { unit: "USD", scale: "m" }),
        f("($1,200,000)", -1200000, { unit: "USD" }),
      ],
    ],
    [
      "Income statement\nItem Current year Prior year\nRevenue $1.2m ($1,200,000)",
      EN,
      [
        f("$1.2m", 1200000, { unit: "USD", scale: "m" }),
        f("($1,200,000)", -1200000, { unit: "USD" }),
      ],
    ],
    [
      "利润表\n项目 2025年度 2024年度\n营业收入 2.5万 （25,000）",
      ZH,
      [f("2.5万", 25000, { scale: "万" }), f("（25,000）", -25000)],
    ],
    [
      "利润表\n项目 本年 上年\n营业收入 2.5万 （25,000）",
      ZH,
      [f("2.5万", 25000, { scale: "万" }), f("（25,000）", -25000)],
    ],
    [
      "资产负债表\n项目 期末 期初\n货币资金 2.5万 （25,000）",
      ZH,
      [f("2.5万", 25000, { scale: "万" }), f("（25,000）", -25000)],
    ],
    [
      "资产负债表\n项目 年末 年初\n货币资金 2.5万 （25,000）",
      ZH,
      [f("2.5万", 25000, { scale: "万" }), f("（25,000）", -25000)],
    ],
    [
      "Revenue $1.2m ($1,200,000)",
      { ...EN, header: "２０２５ ２０２４" },
      [
        f("$1.2m", 1200000, { unit: "USD", scale: "m" }),
        f("($1,200,000)", -1200000, { unit: "USD" }),
      ],
    ],
    [
      "营业收入 2.5万 （25,000）",
      { ...ZH, header: "２０２５年度 ２０２４年度" },
      [f("2.5万", 25000, { scale: "万" }), f("（25,000）", -25000)],
    ],
    [
      "Despite a negative outlook, the rent is sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "尽管前景为负，租金为人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      `The amount ${"of the fund held for the tenant ".repeat(14)}in total, is ninety-five thousand dollars ($95,000.00)`,
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The account had a negative balance, after all adjustments, of seventy-five thousand dollars ($75,000.00).",
      EN,
      [f("($75,000.00)", -75000, { unit: "USD" })],
    ],
    [
      "The fund showed a negative position, net of fees, of sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "The balance, which was negative, was ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The reserve, then negative, stood at forty-one thousand dollars ($41,000.00).",
      EN,
      [f("($41,000.00)", -41000, { unit: "USD" })],
    ],
    [
      "The Group held a negative U.S. dollar balance of ninety-five thousand dollars ($95,000.00).",
      EN,
      [f("($95,000.00)", -95000, { unit: "USD" })],
    ],
    [
      "The negative U.K. sterling position was sixty-two thousand pounds (£62,000).",
      EN,
      [f("(£62,000)", -62000, { unit: "GBP" })],
    ],
    [
      "账户为负余额，经调整后为人民币九万五千元（¥95,000）。",
      ZH,
      [f("人民币九万五千元", 95000, { unit: "CNY" }), f("（¥95,000）", -95000, { unit: "CNY" })],
    ],
    [
      "该科目出现负值，调整后为人民币六万二千元（¥62,000）。",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "负余额为3.5万元，即人民币三万五千元（¥35,000）。",
      ZH,
      [
        f("3.5万元", 35000, { unit: "CNY", scale: "万" }),
        f("人民币三万五千元", 35000, { unit: "CNY" }),
        f("（¥35,000）", -35000, { unit: "CNY" }),
      ],
    ],
    [
      "负现金流为6.2万元，即人民币六万二千元（¥62,000）。",
      ZH,
      [
        f("6.2万元", 62000, { unit: "CNY", scale: "万" }),
        f("人民币六万二千元", 62000, { unit: "CNY" }),
        f("（¥62,000）", -62000, { unit: "CNY" }),
      ],
    ],
    [
      "减\t已付定金人民币四千元（¥4,000）",
      ZH,
      [f("人民币四千元", 4000, { unit: "CNY" }), f("（¥4,000）", -4000, { unit: "CNY" })],
    ],
    [
      "The account had a negative closing cash balance of sixty-two thousand dollars ($62,000.00).",
      EN,
      [f("($62,000.00)", -62000, { unit: "USD" })],
    ],
    [
      "账户出现负的期末余额人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "账户出现负余额人民币六万二千元（¥62,000）",
      ZH,
      [f("人民币六万二千元", 62000, { unit: "CNY" }), f("（¥62,000）", -62000, { unit: "CNY" })],
    ],
    [
      "金额为△人民币六万二千元（¥62,000）。",
      ZH,
      [
        f("△人民币六万二千元", 62000, { unit: "CNY", ambiguous: ["sign"] }),
        f("（¥62,000）", -62000, { unit: "CNY" }),
      ],
    ],
    [
      "Change: △$2.6 million ($2,600,000)",
      EN,
      [
        f("△$2.6 million", 2600000, { unit: "USD", scale: "million", ambiguous: ["sign"] }),
        f("($2,600,000)", -2600000, { unit: "USD" }),
      ],
    ],
    ["△ sixty-two thousand dollars ($62,000)", EN, [f("($62,000)", -62000, { unit: "USD" })]],
    [
      "减：已付定金人民币四千元（¥4,000）",
      ZH,
      [f("人民币四千元", 4000, { unit: "CNY" }), f("（¥4,000）", -4000, { unit: "CNY" })],
    ],
    [
      "扣除人民币四千元（¥4,000）",
      ZH,
      [f("人民币四千元", 4000, { unit: "CNY" }), f("（¥4,000）", -4000, { unit: "CNY" })],
    ],
    [
      "Less: deposit paid four thousand dollars ($4,000.00)",
      EN,
      [f("($4,000.00)", -4000, { unit: "USD" })],
    ],
    [
      "负数以括号表示。\n本期净额人民币2.7万元（¥27,000）",
      ZH,
      [
        f("人民币2.7万元", 27000, { unit: "CNY", scale: "万" }),
        f("（¥27,000）", -27000, { unit: "CNY" }),
      ],
    ],
    [
      "利润为负三万五千元（¥35,000）",
      ZH,
      [f("负三万五千元", -35000, { unit: "CNY" }), f("（¥35,000）", -35000, { unit: "CNY" })],
    ],
    ["净亏损1,234万元", ZH, [f("1,234万元", 12340000, { unit: "CNY", scale: "万" })]],
  ];
  test.each(negatives)("%s keeps its sign", (text, context, figures) => {
    expect(readFigures(text, context).map(shape)).toEqual(figures);
  });

  const asides: [text: string, context: FigureContext, figures: Expected[]][] = [
    [
      "Revenue was $4.3 million (2025)",
      EN,
      [f("$4.3 million", 4300000, { unit: "USD", scale: "million" })],
    ],
    [
      "Revenue was $4.3 million (12%)",
      EN,
      [
        f("$4.3 million", 4300000, { unit: "USD", scale: "million" }),
        f("(12%)", 0.12, { unit: "%", ambiguous: ["sign"] }),
      ],
    ],
    [
      "人民币三万五千元（1）",
      ZH,
      [f("人民币三万五千元（1）", 35000, { unit: "CNY", footnote: "（1）" })],
    ],
    ["payable within thirty (30) days", EN, []],
    [
      "收入为人民币4.3亿元（注释12）",
      ZH,
      [f("人民币4.3亿元", 430000000, { unit: "CNY", scale: "亿" }), f("12", 12)],
    ],
    [
      "合同价款人民币三万五千元（合同编号35000）",
      ZH,
      [f("人民币三万五千元", 35000, { unit: "CNY" }), f("35000", 35000)],
    ],
  ];
  test.each(asides)(
    "%s: a year, percent, note or number of another kind is read as before",
    (text, context, figures) => {
      expect(readFigures(text, context).map(shape)).toEqual(figures);
    },
  );

  test("a note elsewhere in the Document that brackets are negative keeps the minus", () => {
    const line = "Net cash £2.7m (£2,700,000)";
    const note = "Amounts in brackets are negative.";
    expect(readFigures(line, figureContextOf(`${note}\n${line}`, "en")).map(shape)).toEqual([
      f("£2.7m", 2700000, { unit: "GBP", scale: "m" }),
      f("(£2,700,000)", -2700000, { unit: "GBP" }),
    ]);
    expect(readFigures(line, figureContextOf(line, "en")).map(shape)).toEqual([
      f("£2.7m", 2700000, { unit: "GBP", scale: "m" }),
      f("£2,700,000", 2700000, { unit: "GBP" }),
    ]);
  });
});
