import { csv, normal, random, round, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Customer churn.csv";

/**
 * Each column's mean and its true effect on the log-odds of churning: three clear drivers, the
 * rest small. Every column has a standard deviation of 1, so the three lead whether or not the
 * model standardises them.
 */
const COLUMNS: readonly (readonly [string, number, number])[] = [
  ["tenure", 4, -0.18],
  ["charges", 6, 0.12],
  ["logins", 5, -0.21],
  ["devices", 2, 0.05],
  ["discount", 1, -0.09],
  ["referrals", 1, -0.14],
  ["arrears", 2, 1.6],
  ["usage", 7, -0.2],
  ["downloads", 3, 0.03],
  ["sessions", 6, -0.11],
  ["satisfaction", 7, -1.3],
  ["upgrades", 1, -0.07],
  ["outages", 2, 0.16],
  ["refunds", 1, 0.08],
  ["emails", 4, -0.02],
  ["complaints", 2, 1.1],
  ["surveys", 2, -0.06],
  ["reviews", 3, 0.1],
  ["credits", 2, -0.04],
  ["seats", 5, 0.02],
  ["invoices", 8, 0.06],
  ["renewals", 3, -0.15],
  ["tickets", 3, 0.13],
  ["pageviews", 9, -0.01],
];

/** 19,999 customers under one heading row: 20,000 rows of 25 columns, the 500,000 cells an Analysis reads at most. */
const CUSTOMERS = 19_999;
const INTERCEPT = -2.8;

function customers(): string {
  const next = random(2101);
  const rows: (string | number)[][] = [[...COLUMNS.map(([name]) => name), "churned"]];
  for (let row = 0; row < CUSTOMERS; row++) {
    let logit = INTERCEPT;
    const values = COLUMNS.map(([, mean, effect]) => {
      const value = round(mean + normal(next), 2);
      logit += effect * (value - mean);
      return value;
    });
    const churned = next() < 1 / (1 + Math.exp(-logit)) ? 1 : 0;
    rows.push([...values, churned]);
  }
  return csv(rows);
}

export const task: Task = {
  id: "M01",
  title: "Churn by logistic regression",
  needs: ["P"],
  seed: 2101,
  question: {
    en: "Customer churn.csv has one row per customer: 24 numeric columns, and churned, which is 1 if the customer left. What share of customers churned? Fit a logistic regression that predicts churned from the 24 columns: hold out 25% of the rows at random as a test set, with a fixed random seed, and give the test AUC and the confusion matrix at a 0.5 threshold. Which three columns have the largest coefficients in absolute value, and what are their coefficients?",
  },
  inputs: () => {
    const text = customers();
    return { files: [{ name: NAME, bytes: utf8(text) }], data: { "customers.csv": text } };
  },
  expect: [
    {
      id: "churn_rate",
      kind: "number",
      label: "Share of customers who churned",
      unit: "percent",
      tolerance: { abs: 0.0005 },
      near: /churn rate|churned|class balance|流失率|流失/i,
    },
    {
      id: "auc",
      kind: "number",
      label: "Test AUC",
      unit: "plain",
      // reference.py's spread over 40 random 25% splits is about ±0.01: this covers it with room.
      tolerance: { abs: 0.02 },
      near: /AUC|ROC/i,
    },
    {
      id: "top_columns",
      kind: "rows",
      label: "The three columns with the largest coefficients",
      key: /\b(?:tenure|charges|logins|devices|discount|referrals|arrears|usage|downloads|sessions|satisfaction|upgrades|outages|refunds|emails|complaints|surveys|reviews|credits|seats|invoices|renewals|tickets|pageviews)\b/gi,
      columns: [{ id: "coefficient", unit: "plain", tolerance: { abs: 0.15 } }],
    },
  ],
  sources: { documents: [NAME] },
};
