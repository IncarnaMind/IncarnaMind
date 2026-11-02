import { csv, fullWidth, normal, random, round, utf8 } from "../../inputs";
import type { Task, TaskLanguage } from "../../task";

const NAMES = { en: "Onboarding experiment.csv", zh: "新手引导实验.csv" } as const;
const HEADINGS = {
  en: ["User", "Group", "Minutes in first week"],
  zh: ["用户编号", "组别", "首周使用时长（分钟）"],
} as const;
const GROUPS = { en: ["A", "B"], zh: ["Ａ组", "Ｂ组"] } as const;

/** 600 users a group; minutes are log-normal, so skewed, with group B a little higher. */
function users() {
  const next = random(1001);
  return Array.from({ length: 1200 }, (_, index) => {
    const group = index % 2;
    const minutes = Math.exp(2.0 + group * 0.05 + 0.6 * normal(next));
    return { id: `U${String(index + 1).padStart(4, "0")}`, group, minutes: round(minutes, 1) };
  });
}

function inputs(language: TaskLanguage) {
  const rows = users();
  const shown = rows.map((row) => [
    language === "zh" ? fullWidth(row.id) : row.id,
    GROUPS[language][row.group] ?? "",
    row.minutes,
  ]);
  return {
    files: [{ name: NAMES[language], bytes: utf8(csv([[...HEADINGS[language]], ...shown])) }],
    data: {
      "users.csv": csv([
        ["group", "minutes"],
        ...rows.map((row) => [row.group === 0 ? "A" : "B", row.minutes]),
      ]),
    },
  };
}

export const task: Task = {
  id: "S01",
  title: "Two groups compared",
  needs: ["P"],
  seed: 1001,
  question: {
    en: "In Onboarding experiment.csv, did group B spend more minutes in the first week than group A, or could the difference be chance? Test it with a Welch t-test and give the difference in means (B minus A) with its 95% confidence interval, the t statistic, the p-value and Cohen's d. Check whether the minutes are normally distributed in each group; if they are not, also run a rank test (Mann-Whitney) and give its p-value, and say why that test fits.",
    zh: "在《新手引导实验.csv》中，Ｂ组用户首周使用时长是否比Ａ组更长，还是差异可能只是偶然？请用 Welch t 检验，给出均值差（Ｂ减Ａ）及其 95% 置信区间、t 统计量、p 值和 Cohen's d。检查每组的使用时长是否服从正态分布；如果不服从，再做秩检验（Mann-Whitney），给出其 p 值，并说明为什么用这个检验。",
  },
  inputs,
  expect: [
    {
      id: "mean_difference",
      kind: "number",
      label: "Difference in means, B minus A",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /differ|mean|均值|平均/i,
      signless: true,
    },
    {
      id: "ci_low",
      kind: "number",
      label: "95% interval, lower end",
      unit: "plain",
      tolerance: { abs: 0.02 },
      near: /interval|CI\b|置信区间/i,
      signless: true,
    },
    {
      id: "ci_high",
      kind: "number",
      label: "95% interval, upper end",
      unit: "plain",
      tolerance: { abs: 0.02 },
      near: /interval|CI\b|置信区间/i,
      signless: true,
    },
    {
      id: "welch_t",
      kind: "number",
      label: "Welch t statistic",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /\bt\b|t-stat|t统计|t 统计|t值/i,
      signless: true,
    },
    {
      id: "welch_p",
      kind: "number",
      label: "Welch p-value",
      unit: "plain",
      tolerance: { abs: 0.002 },
      near: /welch|t-test|t 检验|t检验/i,
    },
    {
      id: "cohens_d",
      kind: "number",
      label: "Cohen's d",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /cohen|effect size|效应量/i,
      signless: true,
    },
    {
      id: "rank_p",
      kind: "number",
      label: "Mann-Whitney p-value",
      unit: "plain",
      tolerance: { abs: 0.003 },
      near: /mann|whitney|rank|秩/i,
    },
    {
      id: "not_normal",
      kind: "mention",
      label: "Says the minutes are not normal",
      match:
        /not (?:normally distributed|normal)|non-?normal|skew|不服从正态|非正态|偏态|不符合正态|不是正态/i,
    },
  ],
  sources: { documents: [NAMES.en] },
};
