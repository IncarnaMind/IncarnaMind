import { between, csv, normal, random, round, utf8 } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Wage survey 2025.csv";
const SEED = 1002;
const REGIONS = ["North", "South", "East", "West"] as const;
const REGION_EFFECT = [0, -1.8, 2.4, 0.9] as const;

/**
 * 5,000 people: experience falls as education rises, so the two are correlated, and the wage's
 * noise grows with both, so robust standard errors differ clearly from the plain ones.
 */
function people() {
  const next = random(SEED);
  return Array.from({ length: 5000 }, (_, index) => {
    const education = between(next, 10, 20);
    const experience = Math.min(
      40,
      Math.max(0, Math.round(30 - 1.5 * (education - 14) + 7 * normal(next))),
    );
    const region = between(next, 0, REGIONS.length - 1);
    const noise = normal(next) * (1 + 0.15 * experience + 0.3 * (education - 10));
    const wage = 6 + 2.15 * education + 0.42 * experience + (REGION_EFFECT[region] ?? 0) + noise;
    return {
      id: `P${String(index + 1).padStart(4, "0")}`,
      region: REGIONS[region] ?? "North",
      education,
      experience,
      wage: round(Math.max(wage, 7.5), 2),
    };
  });
}

function inputs() {
  const rows = people();
  return {
    files: [
      {
        name: NAME,
        bytes: utf8(
          csv([
            ["Person", "Region", "Years of education", "Years of experience", "Hourly wage"],
            ...rows.map((row) => [row.id, row.region, row.education, row.experience, row.wage]),
          ]),
        ),
      },
    ],
    data: {
      "people.csv": csv([
        ["region", "education", "experience", "wage"],
        ...rows.map((row) => [row.region, row.education, row.experience, row.wage]),
      ]),
    },
  };
}

export const task: Task = {
  id: "S02",
  title: "Wage regression",
  needs: ["P"],
  seed: SEED,
  question: {
    en: "Using Wage survey 2025.csv, fit an ordinary least squares regression of the hourly wage on years of education, years of experience and region, with North as the base region and heteroscedasticity-robust (HC1) standard errors. Give the coefficients on education and on experience with their robust standard errors, the R-squared, and the variance inflation factor (VIF) of education. Check the residuals, and say in plain words what the model means.",
  },
  inputs,
  expect: [
    {
      id: "education",
      kind: "number",
      label: "Coefficient on education",
      unit: "plain",
      tolerance: { abs: 0.005 },
      near: /educat|教育/i,
    },
    {
      id: "education_se",
      kind: "number",
      label: "Robust standard error of education",
      unit: "plain",
      tolerance: { abs: 0.001 },
      near: /educat|教育/i,
    },
    {
      id: "experience",
      kind: "number",
      label: "Coefficient on experience",
      unit: "plain",
      tolerance: { abs: 0.002 },
      near: /experience|经验|工龄/i,
    },
    {
      id: "experience_se",
      kind: "number",
      label: "Robust standard error of experience",
      unit: "plain",
      tolerance: { abs: 0.0005 },
      near: /experience|经验|工龄/i,
    },
    {
      id: "r_squared",
      kind: "number",
      label: "R-squared",
      unit: "plain",
      tolerance: { abs: 0.002 },
      near: /R-?squared|R²|R\^2|\bR2\b|决定系数|拟合优度/i,
    },
    {
      // With or without the region dummies in the auxiliary regression: reference.py gives both.
      id: "vif_education",
      kind: "number",
      label: "VIF of education",
      unit: "plain",
      tolerance: { abs: 0.03 },
      near: /VIF|variance inflation|方差膨胀/i,
    },
    {
      id: "residual_check",
      kind: "mention",
      label: "Says how the residuals were checked",
      match: /residual|heterosced|Breusch|White(?:'s)? test|残差|异方差/i,
    },
  ],
  sources: { documents: [NAME] },
};
