import { between, csv, fullWidth, random, xlsx } from "../../inputs";
import type { Task, TaskLanguage } from "../../task";

const NAMES = { en: "Cost centre budget 2025.xlsx", zh: "2025年成本中心预算.xlsx" } as const;
const SHEETS = { en: ["Budget", "Actual"], zh: ["预算", "实际"] } as const;
const HEADINGS = {
  en: [
    "Cost centre",
    "Department",
    ...["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
    ...["Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ],
  zh: ["成本中心", "部门", ...Array.from({ length: 12 }, (_, month) => `${month + 1}月`)],
};
const DEPARTMENTS = {
  en: [
    "Finance",
    "Marketing",
    "Sales",
    "Operations",
    "IT",
    "HR",
    "Legal",
    "Facilities",
    "Logistics",
    "R&D",
  ],
  zh: [
    "财务部",
    "市场部",
    "销售部",
    "运营部",
    "信息技术部",
    "人力资源部",
    "法务部",
    "行政部",
    "物流部",
    "研发部",
  ],
};

/**
 * The five cost centres planted most over budget, by index, and their full-year overspend in
 * cents: far above what the others' month-to-month noise adds up to, so the five are clear.
 */
const OVERSPENT = new Map([
  [6, 8_641_237],
  [18, 7_125_080],
  [22, 5_890_315],
  [30, 4_731_642],
  [11, 3_980_466],
]);

interface Centre {
  code: string;
  department: number;
  /** By month, in cents. */
  budget: number[];
  actual: number[];
}

function centres(): Centre[] {
  const next = random(101);
  return Array.from({ length: 40 }, (_, index) => {
    const base = between(next, 200, 1200) * 10_000;
    const budget = Array.from(
      { length: 12 },
      (_, month) => Math.round((base * (1 + 0.05 * Math.sin(month / 2))) / 10_000) * 10_000,
    );
    const actual = budget.map((cents) => Math.round(cents * (1 + (next() - 0.5) * 0.08)));
    const target = OVERSPENT.get(index);
    if (target !== undefined) {
      const missing =
        target - actual.reduce((sum, cents, month) => sum + cents - (budget[month] ?? 0), 0);
      const each = Math.trunc(missing / 12);
      for (let month = 0; month < 12; month++) {
        actual[month] = (actual[month] ?? 0) + (month === 11 ? missing - each * 11 : each);
      }
    }
    return {
      code: `CC${String(index + 1).padStart(2, "0")}`,
      department: index % 10,
      budget,
      actual,
    };
  });
}

const dollars = (cents: number) => cents / 100;

function inputs(language: TaskLanguage) {
  const all = centres();
  const sheet = (name: string, of: (centre: Centre) => number[]) => ({
    name,
    rows: [
      HEADINGS[language],
      ...all.map((centre) => [
        language === "zh" ? fullWidth(centre.code) : centre.code,
        DEPARTMENTS[language][centre.department] ?? "",
        ...of(centre).map(dollars),
      ]),
    ],
  });
  const plain = (of: (centre: Centre) => number[]) =>
    csv([
      ["code", ...Array.from({ length: 12 }, (_, month) => `m${month + 1}`)],
      ...all.map((centre) => [centre.code, ...of(centre).map(dollars)]),
    ]);
  return {
    files: [
      {
        name: NAMES[language],
        bytes: xlsx([
          sheet(SHEETS[language][0], (centre) => centre.budget),
          sheet(SHEETS[language][1], (centre) => centre.actual),
        ]),
      },
    ],
    data: {
      "budget.csv": plain((centre) => centre.budget),
      "actual.csv": plain((centre) => centre.actual),
    },
  };
}

export const task: Task = {
  id: "F01",
  title: "Budget against actual",
  needs: ["P"],
  seed: 101,
  question: {
    en: "Cost centre budget 2025.xlsx has a Budget sheet and an Actual sheet, each with 40 cost centres by month. For the full year, work out each cost centre's variance (actual minus budget) in dollars and as a percent of its full-year budget, and the total variance of all 40. Which five cost centres are most over budget by amount? List them worst first, each with its variance in dollars and in percent.",
    zh: "“2025年成本中心预算.xlsx”中有“预算”和“实际”两张表，各列出 40 个成本中心每月的金额。请按全年计算每个成本中心的差异（实际减预算）金额，以及差异占其全年预算的百分比，并给出 40 个成本中心的差异合计。按金额算，超支最多的五个成本中心是哪些？请从超支最多的开始列出，并写出每个的差异金额和百分比。",
  },
  inputs,
  expect: [
    {
      id: "worst",
      kind: "rows",
      label: "The five cost centres most over budget, worst first",
      key: /\bCC\d{2}\b/g,
      columns: [
        { id: "amount", unit: "plain", tolerance: { abs: 0.01 }, signless: true },
        { id: "share", unit: "percent", tolerance: { abs: 0.0005 }, signless: true },
      ],
      ordered: true,
    },
    {
      id: "total_variance",
      kind: "number",
      label: "Total variance of all 40 cost centres",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /total|overall|all 40|合计|总/i,
      signless: true,
    },
  ],
  sources: { documents: [NAMES.en] },
};
