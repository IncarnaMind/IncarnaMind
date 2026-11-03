import { between, csv, normal, random, round, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Motor claims 2025.csv";
const SEED = 1005;
const CLAIMS = 900;
const DAY = 86_400_000;

/** 900 claims, log-normal, so a few large ones pull the mean well above the median. */
function claims() {
  const next = random(SEED);
  return Array.from({ length: CLAIMS }, () => ({
    day: between(next, 0, 364),
    amount: round(Math.exp(7.3 + 0.95 * normal(next)), 2),
  }))
    .sort((a, b) => a.day - b.day)
    .map((claim, index) => ({
      id: `CL-${String(25001 + index)}`,
      reported: new Date(Date.UTC(2025, 0, 1) + claim.day * DAY).toISOString().slice(0, 10),
      amount: claim.amount,
    }));
}

function inputs() {
  const rows = claims();
  return {
    files: [
      {
        name: NAME,
        bytes: utf8(
          csv([
            ["Claim", "Date reported", "Amount paid"],
            ...rows.map((row) => [row.id, row.reported, row.amount]),
          ]),
        ),
      },
    ],
    data: { "claims.csv": csv([["amount"], ...rows.map((row) => [row.amount])]) },
  };
}

export const task: Task = {
  id: "S05",
  title: "Bootstrap interval for a median",
  needs: ["P"],
  seed: SEED,
  question: {
    en: "Motor claims 2025.csv lists the 900 motor claims paid in 2025. The amounts are skewed, so I want the median rather than the mean. What is the median amount paid? Give a 95% confidence interval for it by bootstrap: 10,000 resamples of the 900 claims with replacement, a fixed random seed (say which), and the percentile interval of the resampled medians.",
  },
  inputs,
  expect: [
    {
      id: "median",
      kind: "number",
      label: "Median amount paid",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /median|中位数/i,
    },
    {
      id: "ci_low",
      kind: "number",
      label: "Bootstrap 95% interval, lower end",
      unit: "plain",
      // Here and below: each end moves by under 8 over the 40 seeds reference.py tries.
      tolerance: { abs: 12 },
      near: /interval|CI\b|bootstrap|置信区间|自助/i,
    },
    {
      id: "ci_high",
      kind: "number",
      label: "Bootstrap 95% interval, upper end",
      unit: "plain",
      tolerance: { abs: 12 },
      near: /interval|CI\b|bootstrap|置信区间|自助/i,
    },
    {
      id: "seed",
      kind: "mention",
      label: "Says which random seed it used",
      match: /seed|种子/i,
    },
  ],
  sources: { documents: [NAME] },
};
