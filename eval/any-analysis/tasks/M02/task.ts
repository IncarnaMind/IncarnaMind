import { between, csv, normal, random, round, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Repair jobs 2025.csv";
const SEED = 2102;
const JOBS = 8000;

/**
 * 8,000 repair jobs: the cost is driven by labour hours, with overtime past six hours, and by the
 * parts fitted; the other six columns move it a little or not at all, so two features dominate.
 */
function jobs(): string {
  const next = random(SEED);
  const rows: (string | number)[][] = [
    ["labour", "parts", "age", "mileage", "distance", "weekday", "rating", "courtesy", "cost"],
  ];
  for (let job = 0; job < JOBS; job++) {
    const labour = round(Math.min(14, Math.max(0.5, 3.5 + 2.2 * normal(next))), 1);
    const parts = between(next, 0, 12);
    const age = between(next, 0, 15);
    const mileage = round(Math.max(1, 70 + 40 * normal(next)), 1);
    const distance = round(Math.max(0.5, 12 + 6 * normal(next)), 1);
    const weekday = between(next, 1, 6);
    const rating = between(next, 1, 5);
    const courtesy = next() < 0.3 ? 1 : 0;
    const cost =
      90 +
      62 * labour +
      110 * Math.max(0, labour - 6) +
      27 * parts +
      3 * age +
      0.25 * mileage +
      80 * normal(next);
    rows.push([
      labour,
      parts,
      age,
      mileage,
      distance,
      weekday,
      rating,
      courtesy,
      round(Math.max(40, cost), 2),
    ]);
  }
  return csv(rows);
}

export const task: Task = {
  id: "M02",
  title: "Repair cost by gradient boosting",
  needs: ["P"],
  seed: SEED,
  question: {
    en: "Repair jobs 2025.csv has one row per repair job: eight numeric columns about the job and cost, what it cost in pounds. Fit a gradient-boosted regression model that predicts cost from the eight columns: hold out 25% of the rows at random as a test set, with a fixed random seed, and give the test R-squared. Which features matter most? Use permutation importance on the test set (the mean drop in test R-squared over 10 shuffles of each column) and give each feature's importance. Draw a partial-dependence plot for the most important feature and say what it shows.",
  },
  inputs: () => {
    const text = jobs();
    return { files: [{ name: NAME, bytes: utf8(text) }], data: { "jobs.csv": text } };
  },
  expect: [
    {
      id: "r_squared",
      kind: "number",
      label: "Test R-squared",
      unit: "plain",
      // Here and below: covers reference.py's spread over 10 random splits and two boosting models.
      tolerance: { abs: 0.025 },
      near: /R-?squared|R²|R\^2|\bR2\b|决定系数|拟合优度/i,
    },
    {
      id: "labour_importance",
      kind: "number",
      label: "Permutation importance of labour",
      unit: "plain",
      tolerance: { abs: 0.1 },
      near: /\blabou?r\b|工时/i,
    },
    {
      id: "parts_importance",
      kind: "number",
      label: "Permutation importance of parts",
      unit: "plain",
      tolerance: { abs: 0.06 },
      near: /\bparts\b|零件|配件/i,
    },
    {
      id: "permutation",
      kind: "mention",
      label: "Uses permutation importance",
      match: /permutation|置换/i,
    },
    {
      id: "partial_dependence",
      kind: "picture",
      label: "Partial-dependence plot",
      count: 1,
    },
  ],
  sources: { documents: [NAME] },
};
