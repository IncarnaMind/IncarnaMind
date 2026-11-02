import { csv, xlsx } from "../../inputs";
import type { ExpectedNumber, Task } from "../../task";

const NAME = "Checkout test plan.xlsx";

const PARAMETERS = [
  ["Baseline conversion rate", 0.08],
  ["Smallest effect worth detecting (absolute)", 0.01],
  ["Significance level (two-sided)", 0.05],
  ["Power", 0.8],
] as const;

/** Absolute lifts in the conversion rate, the smallest worth detecting among them. */
const EFFECTS = [0.005, 0.01, 0.015, 0.02] as const;

const near =
  /per (?:arm|group|variant)|each (?:arm|group|variant)|sample size|users|每组|每个组|样本量/i;

const sampleSize = (id: string, label: string): ExpectedNumber => ({
  id,
  kind: "number",
  label,
  unit: "plain",
  // reference.py gives each size by the pooled, the unpooled and Cohen's h formulas, a few users apart.
  tolerance: { abs: 1 },
  near,
});

export const task: Task = {
  id: "S06",
  title: "Sample size for an A/B test",
  needs: ["P"],
  seed: 1006,
  question: {
    en: "Checkout test plan.xlsx has the parameters for an A/B test of the checkout page. How many users does each arm need to detect the smallest effect worth detecting? Use a two-sided test of two proportions at the significance level and power on the sheet, two equal arms, and the normal approximation without a continuity correction, and round up to whole users. Then make a table of the users each arm needs for each of the effect sizes listed below the parameters, and say how the sample size moves as the effect grows.",
  },
  inputs: () => ({
    files: [
      {
        name: NAME,
        bytes: xlsx([
          {
            name: "Plan",
            rows: [
              ["Checkout redesign: test plan"],
              [],
              ["Parameter", "Value"],
              ...PARAMETERS.map((row) => [...row]),
              [],
              ["Effect sizes to compare (absolute)"],
              ...EFFECTS.map((effect) => [effect]),
            ],
          },
        ]),
      },
    ],
    data: {
      "parameters.csv": csv([["parameter", "value"], ...PARAMETERS.map((row) => [...row])]),
      "effects.csv": csv([["effect"], ...EFFECTS.map((effect) => [effect])]),
    },
  }),
  expect: [
    sampleSize("per_arm", "Users per arm for the smallest effect worth detecting"),
    sampleSize("per_arm_0_5", "Users per arm for a 0.5-point effect"),
    sampleSize("per_arm_1_5", "Users per arm for a 1.5-point effect"),
    sampleSize("per_arm_2_0", "Users per arm for a 2-point effect"),
  ],
  sources: { documents: [NAME] },
};
