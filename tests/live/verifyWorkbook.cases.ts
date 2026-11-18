import { WorkbookBuilder } from "../helpers/financeWorkbooks";

/** How a row's typed-in numbers stand against the Documents' words. */
export type RowKind = "match" | "differs" | "none";

export interface WorkbookRow {
  label: string;
  /** The typed-in numbers, one a column. */
  values: [number, number];
  kind: RowKind;
  /** What the Documents say of it: with the same numbers for "match", another number for "differs", nothing for "none". */
  said?: string;
}

export interface WorkbookCase {
  id: string;
  language: "English" | "Chinese";
  file: string;
  sheet: string;
  heading: [string, string];
  rowLabel: string;
  totalLabel: string;
  rows: WorkbookRow[];
  source: { name: string; title: string };
}

/** Invented workbooks: rows with a typed-in number a year, and a total row of formulas whose second saved result is wrong. */
export const WORKBOOK_CASES: WorkbookCase[] = [
  {
    id: "office-costs",
    language: "English",
    file: "Office costs.xlsx",
    sheet: "Costs",
    heading: ["2026", "2027"],
    rowLabel: "Item",
    totalLabel: "Total",
    source: { name: "Finance notes.md", title: "Finance notes" },
    rows: [
      {
        label: "Rent",
        values: [14000, 14000],
        kind: "match",
        said: "Office rent is 14,000 pounds a year, in both 2026 and 2027.",
      },
      {
        label: "Insurance",
        values: [2200, 2300],
        kind: "differs",
        said: "Insurance costs 2,200 pounds in 2026 and 2,500 pounds in 2027.",
      },
      {
        label: "Software",
        values: [5400, 5400],
        kind: "match",
        said: "Software licences cost 5,400 pounds in each of 2026 and 2027.",
      },
      {
        label: "Cleaning",
        values: [3100, 3100],
        kind: "differs",
        said: "Cleaning costs 2,800 pounds in each of 2026 and 2027.",
      },
      { label: "Travel", values: [6000, 6500], kind: "none" },
      {
        label: "Training",
        values: [1800, 1800],
        kind: "match",
        said: "The training budget is 1,800 pounds in 2026 and again in 2027.",
      },
      { label: "Broadband", values: [960, 960], kind: "none" },
      {
        label: "Utilities",
        values: [4200, 4400],
        kind: "differs",
        said: "Utilities cost 4,200 pounds in 2026 and 4,900 pounds in 2027.",
      },
    ],
  },
  {
    id: "clinic-visits",
    language: "English",
    file: "Clinic visits.xlsx",
    sheet: "Visits",
    heading: ["North", "South"],
    rowLabel: "Month",
    totalLabel: "Total",
    source: { name: "Clinic report.md", title: "Clinic report" },
    rows: [
      {
        label: "January",
        values: [412, 388],
        kind: "match",
        said: "In January the north clinic saw 412 patients and the south clinic saw 388.",
      },
      {
        label: "February",
        values: [397, 401],
        kind: "differs",
        said: "In February the north clinic saw 397 patients and the south clinic saw 410.",
      },
      {
        label: "March",
        values: [455, 430],
        kind: "match",
        said: "In March the north clinic saw 455 patients and the south clinic saw 430.",
      },
      { label: "April", values: [420, 415], kind: "none" },
      {
        label: "May",
        values: [468, 442],
        kind: "differs",
        said: "In May the north clinic saw 486 patients and the south clinic saw 442.",
      },
      {
        label: "June",
        values: [391, 377],
        kind: "match",
        said: "In June the north clinic saw 391 patients and the south clinic saw 377.",
      },
      { label: "July", values: [350, 340], kind: "none" },
      {
        label: "August",
        values: [362, 358],
        kind: "match",
        said: "In August the north clinic saw 362 patients and the south clinic saw 358.",
      },
    ],
  },
  {
    id: "shop-budget-zh",
    language: "Chinese",
    file: "门店预算.xlsx",
    sheet: "预算",
    heading: ["2026年", "2027年"],
    rowLabel: "项目",
    totalLabel: "合计",
    source: { name: "财务说明.md", title: "财务说明" },
    rows: [
      {
        label: "房租",
        values: [96000, 96000],
        kind: "match",
        said: "门店房租2026年和2027年都是每年96,000元。",
      },
      {
        label: "人工",
        values: [310000, 325000],
        kind: "differs",
        said: "人工成本2026年是310,000元，2027年是338,000元。",
      },
      {
        label: "水电",
        values: [18000, 18500],
        kind: "match",
        said: "水电费2026年是18,000元，2027年是18,500元。",
      },
      { label: "广告", values: [42000, 45000], kind: "none" },
      {
        label: "保险",
        values: [7200, 7200],
        kind: "differs",
        said: "保险费用2026年和2027年都是每年6,800元。",
      },
      { label: "装修", values: [25000, 0], kind: "none" },
      {
        label: "培训",
        values: [9000, 9000],
        kind: "match",
        said: "培训预算2026年和2027年都是9,000元。",
      },
      {
        label: "物流",
        values: [51000, 53000],
        kind: "match",
        said: "物流费用2026年是51,000元，2027年是53,000元。",
      },
    ],
  },
  {
    id: "school-roll-zh",
    language: "Chinese",
    file: "学校人数.xlsx",
    sheet: "人数",
    heading: ["秋季", "春季"],
    rowLabel: "年级",
    totalLabel: "合计",
    source: { name: "学校概况.md", title: "学校概况" },
    rows: [
      {
        label: "一年级",
        values: [120, 118],
        kind: "match",
        said: "一年级秋季有120名学生，春季有118名学生。",
      },
      {
        label: "二年级",
        values: [115, 113],
        kind: "differs",
        said: "二年级秋季有115名学生，春季有119名学生。",
      },
      {
        label: "三年级",
        values: [108, 108],
        kind: "match",
        said: "三年级秋季和春季都是108名学生。",
      },
      { label: "四年级", values: [101, 99], kind: "none" },
      {
        label: "五年级",
        values: [97, 96],
        kind: "differs",
        said: "五年级秋季有79名学生，春季有96名学生。",
      },
      {
        label: "六年级",
        values: [92, 90],
        kind: "match",
        said: "六年级秋季有92名学生，春季有90名学生。",
      },
      { label: "七年级", values: [88, 85], kind: "none" },
      { label: "八年级", values: [84, 84], kind: "match", said: "八年级秋季和春季都是84名学生。" },
    ],
  },
];

/** The workbook of a case: its rows typed in, and a total row of formulas, the second one's saved result wrong. */
export function workbookOf(each: WorkbookCase): Buffer {
  const book = new WorkbookBuilder();
  const sheet = book.sheet(each.sheet);
  sheet.text("A1", each.rowLabel).text("B1", each.heading[0]).text("C1", each.heading[1]);
  each.rows.forEach((row, index) => {
    const at = index + 2;
    sheet.text(`A${at}`, row.label).number(`B${at}`, row.values[0]).number(`C${at}`, row.values[1]);
  });
  const last = each.rows.length + 1;
  const total = each.rows.reduce<[number, number]>(
    (sum, row) => [sum[0] + row.values[0], sum[1] + row.values[1]],
    [0, 0],
  );
  sheet
    .text(`A${last + 1}`, each.totalLabel)
    .formula(`B${last + 1}`, `SUM(B2:B${last})`, total[0])
    .formula(`C${last + 1}`, `SUM(C2:C${last})`, total[1] + 1000);
  return book.xlsx();
}

/** What the Documents say, one paragraph a sentence. */
export const sourceOf = (each: WorkbookCase): string =>
  `# ${each.source.title}\n\n${each.rows.flatMap((row) => (row.said ? [row.said] : [])).join("\n\n")}\n`;
