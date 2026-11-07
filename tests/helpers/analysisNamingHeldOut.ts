/**
 * The held-out set the claim judge's naming of an Analysis's figure is gated on (#2378), written
 * before any run and apart from the development probes (`analysisNamingProbes.ts`): other wordings
 * and other sentence shapes, on the same Orders.csv rows. Each case runs in a data folder of its own.
 */
import type { NamingCase, NamingFigure } from "./analysisNamingProbes";

type Row = [right: boolean, figure: NamingFigure, sentence: string];

const EN: readonly Row[] = [
  [
    true,
    { region: "Central", how: "max" },
    "Central's single largest order, at its highest amount, came to [=1].",
  ],
  [true, { region: "West", how: "max" }, "West's highest amount reached [=1]."],
  [
    true,
    { region: "Central", how: "max" },
    "The highest amount any Central order reached was [=1].",
  ],
  [true, { region: "West", how: "count" }, "West's number of orders came to [=1]."],
  [true, { region: "Central", how: "count" }, "The number of orders placed in Central was [=1]."],
  [
    true,
    { region: "West", how: "sum" },
    "Taken together, West's orders reach a total amount of [=1].",
  ],
  [
    true,
    { region: "Central", how: "sum" },
    "Central brought in a total amount of [=1] across its orders.",
  ],
  [true, { region: "West", how: "mean" }, "West's average amount works out at [=1]."],
  [true, { region: "North", how: "mean" }, "Measured per order, North's average amount is [=1]."],
  [true, { region: "South", how: "max" }, "South's highest amount, [=1], came from one order."],
  [true, { region: "North", how: "count" }, "North logged a number of orders equal to [=1]."],
  [true, { region: "South", how: "sum" }, "South closes with a total amount of [=1]."],
  [true, { region: "West", how: "sum" }, "The total amount West took in was [=1]."],
  [true, { region: "Central", how: "mean" }, "Central's orders came to an average amount of [=1]."],
  [true, { region: "North", how: "max" }, "North's highest amount stood at [=1]."],
  [true, { region: "South", how: "count" }, "South's orders number [=1], its number of orders."],
  [false, { region: "Central", how: "max" }, "West's highest amount reached [=1]."],
  [false, { region: "Central", how: "max" }, "Central's lowest amount was [=1]."],
  [false, { region: "Central", how: "count" }, "The number of customers in Central was [=1]."],
  [
    false,
    { region: "Central", how: "max" },
    "West's highest amount, where Central's trailed, reached [=1].",
  ],
  [false, { region: "Central", how: "max" }, "Central's highest amount never reached [=1]."],
  [false, { region: "West", how: "sum" }, "West's total amount fell short of [=1]."],
  [false, { region: "Central", how: "mean" }, "Central's median amount was [=1]."],
  [false, { region: "Central", how: "sum" }, "Central's total amount in its first week was [=1]."],
  [false, { region: "North", how: "mean" }, "North's average amount per customer is [=1]."],
  [false, { region: "South", how: "sum" }, "South's gross margin came to [=1]."],
  [false, { region: "North", how: "count" }, "North's number of returns was [=1]."],
  [false, { region: "South", how: "max" }, "South's highest amount, a figure West beat, was [=1]."],
  [false, { region: "West", how: "mean" }, "West's average amount rose to [=1]."],
  [false, { region: "Central", how: "sum" }, "Central's total amount after tax is [=1]."],
  [false, { region: "North", how: "max" }, "North's highest amount for a single day was [=1]."],
  [false, { region: "South", how: "count" }, "Fewer than [=1] orders came from South."],
];

const ZH_ROWS: readonly Row[] = [
  [true, { region: "Central", how: "max" }, "中部地区最大的一笔订单，其最高金额为 [=1]。"],
  [true, { region: "West", how: "max" }, "西部地区最高金额达到 [=1]。"],
  [true, { region: "Central", how: "max" }, "中部地区任一订单的最高金额为 [=1]。"],
  [true, { region: "West", how: "count" }, "西部地区的订单数达到 [=1]。"],
  [true, { region: "Central", how: "count" }, "中部地区下单的订单数是 [=1]。"],
  [true, { region: "West", how: "sum" }, "西部地区各笔订单的金额合计达到 [=1]。"],
  [true, { region: "Central", how: "sum" }, "中部地区所有订单的金额合计为 [=1]。"],
  [true, { region: "West", how: "mean" }, "西部地区平均金额约为 [=1]。"],
  [true, { region: "North", how: "mean" }, "按订单计，北部地区平均金额为 [=1]。"],
  [true, { region: "South", how: "max" }, "南部地区最高金额 [=1] 来自一笔订单。"],
  [true, { region: "North", how: "count" }, "北部地区录得的订单数为 [=1]。"],
  [true, { region: "South", how: "sum" }, "南部地区最终金额合计为 [=1]。"],
  [true, { region: "West", how: "sum" }, "西部地区收到的金额合计为 [=1]。"],
  [true, { region: "Central", how: "mean" }, "中部地区订单的平均金额达到 [=1]。"],
  [true, { region: "North", how: "max" }, "北部地区最高金额停在 [=1]。"],
  [true, { region: "South", how: "count" }, "南部地区订单数一共是 [=1]。"],
  [false, { region: "Central", how: "max" }, "西部地区最高金额达到 [=1]。"],
  [false, { region: "Central", how: "max" }, "中部地区最低金额为 [=1]。"],
  [false, { region: "Central", how: "count" }, "中部地区的客户数为 [=1]。"],
  [false, { region: "Central", how: "max" }, "中部地区落在后面，西部地区最高金额达到 [=1]。"],
  [false, { region: "Central", how: "max" }, "中部地区最高金额从未达到 [=1]。"],
  [false, { region: "West", how: "sum" }, "西部地区金额合计不足 [=1]。"],
  [false, { region: "Central", how: "mean" }, "中部地区金额中位数为 [=1]。"],
  [false, { region: "Central", how: "sum" }, "中部地区第一周的金额合计为 [=1]。"],
  [false, { region: "North", how: "mean" }, "北部地区每位客户的平均金额为 [=1]。"],
  [false, { region: "South", how: "sum" }, "南部地区毛利合计为 [=1]。"],
  [false, { region: "North", how: "count" }, "北部地区退货数为 [=1]。"],
  [false, { region: "South", how: "max" }, "南部地区最高金额被西部地区超过，为 [=1]。"],
  [false, { region: "West", how: "mean" }, "西部地区平均金额上升到 [=1]。"],
  [false, { region: "Central", how: "sum" }, "中部地区税后金额合计为 [=1]。"],
  [false, { region: "North", how: "max" }, "北部地区单日最高金额为 [=1]。"],
  [false, { region: "South", how: "count" }, "来自南部地区的订单少于 [=1] 笔。"],
];

const casesOf = (language: "en" | "zh-CN", rows: readonly Row[]): NamingCase[] =>
  rows.map(([right, figure, sentence], at) => ({
    name: `${language} held-out ${right ? "right" : "wrong"} ${at + 1}`,
    language,
    kind: right ? "right" : "wrong",
    right,
    figures: [figure],
    sentence,
  }));

export const NAMING_HELD_OUT: readonly NamingCase[] = [
  ...casesOf("en", EN),
  ...casesOf("zh-CN", ZH_ROWS),
];
