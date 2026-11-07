/**
 * The gate for the claim judge's naming of an Analysis's figure (#2378): a held-out set written
 * after the first one was used to build against, and before any run on this one. Other wordings,
 * on the same Orders.csv rows; none is a development probe, the first held-out set or an example
 * the instructions give. Each case runs in a data folder of its own.
 */
import type { NamingCase, NamingFigure } from "./analysisNamingProbes";

type Row = [right: boolean, figure: NamingFigure, sentence: string];

const EN: readonly Row[] = [
  [true, { region: "South", how: "sum" }, "South's total amount came to [=1]."],
  [true, { region: "West", how: "max" }, "The highest amount for West stands at [=1]."],
  [true, { region: "Central", how: "mean" }, "The average amount for Central was [=1]."],
  [true, { region: "North", how: "count" }, "North's number of orders came to [=1]."],
  [true, { region: "Central", how: "sum" }, "The total amount from Central is [=1]."],
  [true, { region: "South", how: "max" }, "South reached a highest amount of [=1]."],
  [true, { region: "West", how: "mean" }, "West has an average amount of [=1]."],
  [true, { region: "South", how: "count" }, "The number of orders for South is [=1]."],
  [true, { region: "North", how: "sum" }, "North's orders had a total amount of [=1]."],
  [true, { region: "Central", how: "max" }, "Central's highest amount was [=1]."],
  [true, { region: "West", how: "count" }, "The number of orders from West was [=1]."],
  [true, { region: "North", how: "mean" }, "The average amount in North came to [=1]."],
  [false, { region: "South", how: "sum" }, "West's total amount came to [=1]."],
  [false, { region: "West", how: "max" }, "The lowest amount for West stands at [=1]."],
  [false, { region: "Central", how: "mean" }, "The total amount for Central was [=1]."],
  [false, { region: "North", how: "count" }, "North's number of customers came to [=1]."],
  [false, { region: "Central", how: "sum" }, "The total amount from Central this quarter is [=1]."],
  [false, { region: "South", how: "max" }, "South's highest amount rose to [=1]."],
  [false, { region: "West", how: "mean" }, "West's average amount after discounts is [=1]."],
  [false, { region: "South", how: "count" }, "The number of returned orders for South is [=1]."],
  [false, { region: "North", how: "sum" }, "North's total amount was well above [=1]."],
  [false, { region: "Central", how: "max" }, "Central's highest amount, like North's, was [=1]."],
  [false, { region: "West", how: "count" }, "Fewer than [=1] orders came from West."],
  [false, { region: "North", how: "mean" }, "The average amount in North was nearly [=1]."],
];

const ZH_ROWS: readonly Row[] = [
  [true, { region: "South", how: "sum" }, "南部地区的金额合计为 [=1]。"],
  [true, { region: "West", how: "max" }, "西部地区的最高金额为 [=1]。"],
  [true, { region: "Central", how: "mean" }, "中部地区平均金额是 [=1]。"],
  [true, { region: "North", how: "count" }, "北部地区订单数是 [=1]。"],
  [true, { region: "Central", how: "sum" }, "中部地区金额合计达到 [=1]。"],
  [true, { region: "South", how: "max" }, "南部地区最高金额是 [=1]。"],
  [true, { region: "West", how: "mean" }, "西部地区的平均金额为 [=1]。"],
  [true, { region: "South", how: "count" }, "南部地区的订单数为 [=1]。"],
  [true, { region: "North", how: "sum" }, "北部地区金额合计是 [=1]。"],
  [true, { region: "Central", how: "max" }, "中部地区最高金额达到 [=1]。"],
  [true, { region: "West", how: "count" }, "西部地区订单数达到 [=1]。"],
  [true, { region: "North", how: "mean" }, "北部地区平均金额达到 [=1]。"],
  [false, { region: "South", how: "sum" }, "西部地区的金额合计为 [=1]。"],
  [false, { region: "West", how: "max" }, "西部地区的最低金额为 [=1]。"],
  [false, { region: "Central", how: "mean" }, "中部地区金额合计是 [=1]。"],
  [false, { region: "North", how: "count" }, "北部地区客户数是 [=1]。"],
  [false, { region: "Central", how: "sum" }, "中部地区本季度金额合计达到 [=1]。"],
  [false, { region: "South", how: "max" }, "南部地区最高金额升至 [=1]。"],
  [false, { region: "West", how: "mean" }, "西部地区折扣后的平均金额为 [=1]。"],
  [false, { region: "South", how: "count" }, "南部地区退回的订单数为 [=1]。"],
  [false, { region: "North", how: "sum" }, "北部地区金额合计远高于 [=1]。"],
  [false, { region: "Central", how: "max" }, "中部地区最高金额与北部地区一样，为 [=1]。"],
  [false, { region: "West", how: "count" }, "来自西部地区的订单不到 [=1] 笔。"],
  [false, { region: "North", how: "mean" }, "北部地区平均金额将近 [=1]。"],
];

const casesOf = (language: "en" | "zh-CN", rows: readonly Row[]): NamingCase[] =>
  rows.map(([right, figure, sentence], at) => ({
    name: `${language} gate ${right ? "right" : "wrong"} ${at + 1}`,
    language,
    kind: right ? "right" : "wrong",
    right,
    figures: [figure],
    sentence,
  }));

export const NAMING_GATE: readonly NamingCase[] = [
  ...casesOf("en", EN),
  ...casesOf("zh-CN", ZH_ROWS),
];
