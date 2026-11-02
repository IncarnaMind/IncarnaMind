import { between, csv, random, type SheetCell, xlsx } from "../../inputs";
import type { Task, TaskLanguage } from "../../task";

const SEED = 205;
const NAMES = { en: "Regional cost report FY2025.xlsx", zh: "2025财年区域成本报表.xlsx" } as const;
const SHEET = { en: "Report", zh: "报表" } as const;
const WORDS = {
  en: {
    title: "Operating costs by region, FY2025",
    region: "Region",
    line: "Cost line",
    quarters: "Quarter ($000)",
    year: "Full year ($000)",
    quarter: ["Q1", "Q2", "Q3", "Q4"],
    subtotal: "subtotal",
    total: "Total",
  },
  zh: {
    title: "2025 财年各区域运营成本",
    region: "区域",
    line: "成本项目",
    quarters: "季度（千美元）",
    year: "全年（千美元）",
    quarter: ["一季度", "二季度", "三季度", "四季度"],
    subtotal: "小计",
    total: "合计",
  },
} as const;
const REGIONS = [
  { en: "North", zh: "北区", lines: 6 },
  { en: "South", zh: "南区", lines: 5 },
  { en: "East", zh: "东区", lines: 6 },
  { en: "West", zh: "西区", lines: 4 },
  { en: "Central", zh: "中区", lines: 6 },
] as const;
/** Each cost line and the range of its quarterly cost, in tenths of $000. */
const LINES = [
  { en: "Salaries", zh: "工资", from: 3_000, to: 6_000 },
  { en: "Rent", zh: "租金", from: 800, to: 1_500 },
  { en: "Utilities", zh: "水电费", from: 200, to: 450 },
  { en: "Travel", zh: "差旅费", from: 150, to: 600 },
  { en: "IT", zh: "信息技术", from: 400, to: 1_200 },
  { en: "Marketing", zh: "市场推广", from: 300, to: 1_500 },
] as const;

interface Row {
  region: number;
  line: number;
  /** In tenths of $000, so every sum is exact. */
  quarters: number[];
}

function report(): Row[] {
  const next = random(SEED);
  return REGIONS.flatMap((region, regionIndex) => {
    const dropped = new Set<number>();
    while (dropped.size < LINES.length - region.lines)
      dropped.add(between(next, 1, LINES.length - 1));
    return LINES.flatMap((line, lineIndex) =>
      dropped.has(lineIndex)
        ? []
        : [
            {
              region: regionIndex,
              line: lineIndex,
              quarters: [0, 1, 2, 3].map(() => between(next, line.from, line.to)),
            },
          ],
    );
  });
}

const thousands = (tenths: number) => tenths / 10;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

function inputs(language: TaskLanguage) {
  const rows = report();
  const words = WORDS[language];
  const sheet: SheetCell[][] = [
    [words.title],
    [],
    [words.region, words.line, words.quarters, null, null, null, words.year],
    [null, null, ...words.quarter, null],
  ];
  const merges = ["A1:G1", "A3:A4", "B3:B4", "C3:F3", "G3:G4"];
  const totals = (of: readonly Row[]) =>
    [0, 1, 2, 3].map((quarter) => sum(of.map((row) => row.quarters[quarter] ?? 0)));
  for (const [index, region] of REGIONS.entries()) {
    const own = rows.filter((row) => row.region === index);
    const first = sheet.length + 1;
    for (const [place, row] of own.entries()) {
      sheet.push([
        place === 0 ? region[language] : null,
        LINES[row.line]?.[language] ?? "",
        ...row.quarters.map(thousands),
        thousands(sum(row.quarters)),
      ]);
    }
    merges.push(`A${first}:A${first + own.length - 1}`);
    const subtotal = totals(own);
    const label =
      language === "zh" ? `${region.zh}${words.subtotal}` : `${region.en} ${words.subtotal}`;
    sheet.push([label, null, ...subtotal.map(thousands), thousands(sum(subtotal))]);
    sheet.push([]);
  }
  const grand = totals(rows);
  sheet.push([words.total, null, ...grand.map(thousands), thousands(sum(grand))]);
  return {
    files: [
      { name: NAMES[language], bytes: xlsx([{ name: SHEET[language], rows: sheet, merges }]) },
    ],
    data: {
      "costs.csv": csv([
        ["region", "line", "q1", "q2", "q3", "q4"],
        ...rows.map((row) => [
          REGIONS[row.region]?.en ?? "",
          LINES[row.line]?.en ?? "",
          ...row.quarters.map(thousands),
        ]),
      ]),
      "report_total.csv": csv([
        ["name", "value"],
        ["full_year_total", thousands(sum(grand))],
      ]),
    },
  };
}

export const task: Task = {
  id: "E05",
  title: "Tidy an untidy report",
  needs: ["P"],
  seed: SEED,
  question: {
    en: `${NAMES.en} is a report laid out for printing: a title, merged headings, the amounts in $000, a subtotal under each region and blank rows between them. Turn it into a tidy table with one row per region and cost line, and columns for the region, the cost line, the four quarters and the full year, leaving out the subtotals, the total and the blank rows. How many rows does the tidy table have? What is its full-year total, and does it equal the report's own Total row? What is the East region's full-year total?`,
    zh: `“${NAMES.zh}”是一张为打印排版的报表：有标题、合并的表头，金额单位为千美元，每个区域下有小计，区域之间有空行。请把它整理成规范的明细表：每个区域的每个成本项目一行，列为区域、成本项目、四个季度和全年，不要包含小计、合计和空行。整理后的表有多少行？全年合计是多少，是否等于报表自己的“合计”行？东区的全年合计是多少？`,
  },
  inputs,
  expect: [
    {
      id: "rows",
      kind: "number",
      label: "Rows in the tidy table",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /\brows?\b|\blines\b|行/i,
    },
    {
      // In $000 as the report shows it, or in dollars.
      id: "full_year_total",
      kind: "number",
      label: "Full-year total of the tidy table",
      unit: "plain",
      tolerance: { abs: 0.05 },
      near: /total|合计|总/i,
    },
    {
      // In $000 as the report shows it, or in dollars.
      id: "east_total",
      kind: "number",
      label: "East's full-year total",
      unit: "plain",
      tolerance: { abs: 0.05 },
      near: /East|东区/i,
    },
  ],
  sources: { documents: [NAMES.en] },
};
