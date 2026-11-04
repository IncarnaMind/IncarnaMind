import { csv, normal, random, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Garden furniture sales 2019-2025.csv";
const SEED = 1007;
const MONTHS = 84;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Seven years of monthly sales: growth of about 8% a year, a season that peaks in July, and noise
 * of about 2.5%, so the season-naive forecast lags the trend and a model with a trend beats it.
 */
function months() {
  const next = random(SEED);
  return Array.from({ length: MONTHS }, (_, index) => {
    const month = index % 12;
    const level = 84_000 * 1.08 ** (index / 12);
    const season = 1 + 0.38 * Math.cos((2 * Math.PI * (month - 6)) / 12);
    return {
      month: `${2019 + Math.floor(index / 12)}-${String(month + 1).padStart(2, "0")}`,
      label: `${MONTH_NAMES[month]} ${2019 + Math.floor(index / 12)}`,
      sales: Math.round(level * season * (1 + 0.025 * normal(next))),
    };
  });
}

function inputs() {
  const rows = months();
  return {
    files: [
      {
        name: NAME,
        bytes: utf8(
          csv([["Month", "Net sales (GBP)"], ...rows.map((row) => [row.label, row.sales])]),
        ),
      },
    ],
    data: {
      "sales.csv": csv([["month", "sales"], ...rows.map((row) => [row.month, row.sales])]),
    },
  };
}

export const task: Task = {
  id: "S07",
  title: "Monthly sales forecast",
  needs: ["P"],
  seed: SEED,
  question: {
    en: "Garden furniture sales 2019-2025.csv has our net sales for each month from January 2019 to December 2025. Decompose the series into trend and seasonality, and say which month sales peak in. Hold out the last 12 months (2025): fit a forecasting model of your choice on 2019-2024, forecast 2025, and compare its mean absolute percentage error (MAPE) with a seasonal naive forecast that repeats each month of 2024. Then refit the model on all seven years and forecast the 12 months of 2026 with 95% prediction intervals. What is the forecast total for 2026?",
  },
  inputs,
  expect: [
    {
      id: "naive_mape",
      kind: "number",
      label: "Seasonal naive MAPE on 2025",
      unit: "percent",
      tolerance: { abs: 0.0005 },
      near: /naive|朴素/i,
    },
    {
      id: "model_mape",
      kind: "number",
      label: "The model's MAPE on 2025",
      unit: "percent",
      // Any model that grows the season with the level: reference.py fits seven, from 1.1% to 4.8%.
      tolerance: { abs: 0.01 },
      near: /MAPE|percentage error|百分比误差/i,
    },
    {
      id: "forecast_total",
      kind: "number",
      label: "Forecast total for 2026",
      unit: "plain",
      // The same seven models' totals, 1.73 to 1.81 million.
      tolerance: { rel: 0.02 },
      near: /2026|total|合计|总计|总额/i,
    },
    {
      id: "peak",
      kind: "mention",
      label: "Says sales peak in July",
      match: /\bJuly\b|\bJul\b|7月|七月/i,
    },
    {
      id: "intervals",
      kind: "mention",
      label: "Gives prediction intervals",
      match: /interval|区间/i,
    },
  ],
  sources: { documents: [NAME] },
};
