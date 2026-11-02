import { csv, normal, random, round, xlsx } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Fund prices 2015-2024.xlsx";
const SEED = 106;
const RISK_FREE = 0.02;
/** 2,501 closes a fund: 2,500 daily returns, 2,500 / 252 years. */
const CLOSES = 2501;

/** Each fund's yearly drift and volatility, and its first close. */
const ASSETS = [
  { name: "Halvard Equity", drift: 0.12, volatility: 0.17, first: 100 },
  { name: "Merrow Bond", drift: 0.025, volatility: 0.05, first: 50 },
  { name: "Quinlan Gold", drift: 0.09, volatility: 0.15, first: 1250 },
] as const;

/**
 * The daily returns' correlations, equity with bond, equity with gold, bond with gold: apart from
 * each other and from 0, so each is clear in a matrix. Its Cholesky factor makes them.
 */
const CORRELATION = { equityBond: -0.3, equityGold: 0.1, bondGold: 0.45 } as const;

function cholesky(): number[][] {
  const { equityBond: ab, equityGold: ac, bondGold: bc } = CORRELATION;
  const bb = Math.sqrt(1 - ab * ab);
  const cb = (bc - ab * ac) / bb;
  return [
    [1, 0, 0],
    [ab, bb, 0],
    [ac, cb, Math.sqrt(1 - ac * ac - cb * cb)],
  ];
}

/** Weekdays from Friday 2 January 2015, as the funds trade. */
function tradingDays(): string[] {
  const days: string[] = [];
  for (let offset = 0; days.length < CLOSES; offset++) {
    const date = new Date(Date.UTC(2015, 0, 2 + offset));
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
      days.push(date.toISOString().slice(0, 10));
  }
  return days;
}

function prices(): { date: string; asset: string; close: number }[] {
  const next = random(SEED);
  const factor = cholesky();
  const days = tradingDays();
  const level: number[] = ASSETS.map((asset) => asset.first);
  const rows: { date: string; asset: string; close: number }[] = [];
  for (const [index, date] of days.entries()) {
    if (index > 0) {
      const draws = [normal(next), normal(next), normal(next)];
      for (const [column, asset] of ASSETS.entries()) {
        const shock = (factor[column] ?? []).reduce(
          (sum, weight, each) => sum + weight * (draws[each] ?? 0),
          0,
        );
        const daily = asset.drift / 252 + (asset.volatility / Math.sqrt(252)) * shock;
        level[column] = (level[column] ?? 0) * (1 + daily);
      }
    }
    for (const [column, asset] of ASSETS.entries()) {
      rows.push({ date, asset: asset.name, close: round(level[column] ?? 0, 2) });
    }
  }
  return rows;
}

const statistic = { tolerance: { abs: 0.0005 } } as const;

export const task: Task = {
  id: "F06",
  title: "Fund risk and return",
  needs: ["P"],
  seed: SEED,
  question: {
    en: `${NAME} has the daily closing prices of three funds on its Prices sheet (one row per date and fund) and the annual risk-free rate on its Parameters sheet. For each fund, from its daily simple returns close to close: the annual return as the compound annual growth rate from the first close to the last, over (number of daily returns / 252) years; the volatility as the sample standard deviation of the daily returns times the square root of 252; the Sharpe ratio as (annual return minus the risk-free rate) divided by the volatility; and the maximum drawdown, the largest fall of a close from the highest close before it. Give these four for each fund in a table, and the correlation matrix of the three funds' daily returns.`,
  },
  inputs: () => {
    const rows = prices();
    return {
      files: [
        {
          name: NAME,
          bytes: xlsx([
            {
              name: "Prices",
              rows: [
                ["Date", "Asset", "Close"],
                ...rows.map((row) => [row.date, row.asset, row.close]),
              ],
            },
            {
              name: "Parameters",
              rows: [
                ["Parameter", "Value"],
                ["Risk-free rate (annual)", RISK_FREE],
              ],
            },
          ]),
        },
      ],
      data: {
        "prices.csv": csv([
          ["date", "asset", "close"],
          ...rows.map((row) => [row.date, row.asset.split(" ")[0] ?? "", row.close]),
        ]),
        "parameters.csv": csv([
          ["name", "value"],
          ["risk_free", RISK_FREE],
        ]),
      },
    };
  },
  expect: [
    {
      id: "funds",
      kind: "rows",
      label: "Each fund's annual return, volatility, Sharpe ratio and maximum drawdown",
      key: /\b(?:Halvard|Merrow|Quinlan)\b/gi,
      columns: [
        { id: "annual_return", unit: "percent", ...statistic },
        { id: "volatility", unit: "percent", ...statistic },
        { id: "sharpe", unit: "plain", tolerance: { abs: 0.005 } },
        { id: "max_drawdown", unit: "percent", ...statistic, signless: true },
      ],
    },
    {
      id: "correlation_equity_bond",
      kind: "number",
      label: "Correlation of Halvard Equity with Merrow Bond",
      unit: "plain",
      tolerance: { abs: 0.005 },
      near: /Halvard|Merrow/i,
    },
    {
      id: "correlation_equity_gold",
      kind: "number",
      label: "Correlation of Halvard Equity with Quinlan Gold",
      unit: "plain",
      tolerance: { abs: 0.005 },
      near: /Halvard|Quinlan/i,
    },
    {
      id: "correlation_bond_gold",
      kind: "number",
      label: "Correlation of Merrow Bond with Quinlan Gold",
      unit: "plain",
      tolerance: { abs: 0.005 },
      near: /Merrow|Quinlan/i,
    },
  ],
  sources: { documents: [NAME] },
};
