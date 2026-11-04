import { csv, normal, random, round, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Delivery times by depot.csv";
const SEED = 1004;

/**
 * Each depot's deliveries, mean hours and spread: Cedar's spread is several times the others',
 * so the variances are plainly unequal, and only Alder and Birch are close.
 */
const DEPOTS = [
  ["Alder", 48, 26.0, 2.5],
  ["Birch", 60, 26.6, 4.0],
  ["Cedar", 72, 31.5, 9.0],
  ["Elm", 40, 22.5, 3.0],
] as const;

function deliveries() {
  const next = random(SEED);
  const rows = DEPOTS.flatMap(([depot, count, mean, spread]) =>
    Array.from({ length: count }, () => ({
      depot,
      hours: round(Math.max(2, mean + spread * normal(next)), 1),
      order: next(),
    })),
  );
  return rows
    .sort((a, b) => a.order - b.order)
    .map((row, index) => ({ ...row, id: `D${String(index + 1).padStart(4, "0")}` }));
}

function inputs() {
  const rows = deliveries();
  return {
    files: [
      {
        name: NAME,
        bytes: utf8(
          csv([
            ["Delivery", "Depot", "Hours to deliver"],
            ...rows.map((row) => [row.id, row.depot, row.hours]),
          ]),
        ),
      },
    ],
    data: {
      "deliveries.csv": csv([["depot", "hours"], ...rows.map((row) => [row.depot, row.hours])]),
    },
  };
}

export const task: Task = {
  id: "S04",
  title: "Four groups, unequal variances",
  needs: ["P"],
  seed: SEED,
  question: {
    en: "Delivery times by depot.csv lists each delivery's depot and the hours it took. Do the four depots differ in mean delivery time? Check first whether their variances are equal. Then run a Welch ANOVA and give its F statistic, both degrees of freedom and the p-value. Follow it with a post-hoc test that fits unequal variances and unequal group sizes (Games-Howell): give each pair's mean difference and p-value, and say how many of the six pairs differ at the 5% level.",
  },
  inputs,
  expect: [
    {
      id: "unequal_variances",
      kind: "mention",
      label: "Checks the variances",
      match:
        /levene|brown[- ]forsythe|bartlett|unequal variances|variances (?:are not equal|differ)|方差不齐|方差不等|方差齐性/i,
    },
    {
      id: "welch_f",
      kind: "number",
      label: "Welch ANOVA F statistic",
      unit: "plain",
      tolerance: { abs: 0.05 },
      near: /\bF\b|F-stat|F 统计|F统计|F值|welch/i,
    },
    {
      id: "welch_df2",
      kind: "number",
      label: "Welch ANOVA denominator degrees of freedom",
      unit: "plain",
      tolerance: { abs: 0.1 },
      near: /degrees of freedom|\bdf|自由度|\bF\s*\(|welch/i,
    },
    {
      id: "welch_p",
      kind: "number",
      label: "Welch ANOVA p-value",
      unit: "plain",
      // Far under 0.001: "p < 0.001" is as right as the value itself.
      tolerance: { abs: 0.0008 },
      near: /welch|anova|方差分析/i,
    },
    {
      id: "games_howell",
      kind: "mention",
      label: "Uses the Games-Howell test",
      match: /games[- ]?howell/i,
    },
    {
      id: "pairs_differing",
      kind: "number",
      label: "Pairs that differ at the 5% level",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /pairs?|significant|显著|两两|成对/i,
    },
    {
      id: "alder_birch_p",
      kind: "number",
      label: "Games-Howell p-value, Alder against Birch",
      unit: "plain",
      tolerance: { abs: 0.02 },
      near: /alder[\s\S]{0,12}birch|birch[\s\S]{0,12}alder/i,
    },
  ],
  sources: { documents: [NAME] },
};
