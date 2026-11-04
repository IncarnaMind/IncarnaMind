import { between, columnName, random, type SheetCell, xlsx } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Regional sales tracker 2025.xlsx";
const SEED = 202;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const REGIONS = ["North", "South", "East", "West", "Central", "Online"];

/** Sales cells typed as text ("12,480"), which SUM leaves out. */
const AS_TEXT: readonly string[] = ["E4", "J6"];
/** The month whose total stops a row short, at Online. */
const SHORT_TOTAL = "H";

/** Each defect's cell, as the question asks the Answer to write it. */
const DEFECTS = ["Summary!B4", "Sales!H8", "Sales!E4", "Sales!J6", "Summary!B5"] as const;

const withComma = (amount: number) =>
  `${Math.floor(amount / 1000)},${String(amount % 1000).padStart(3, "0")}`;

function sales(): number[][] {
  const next = random(SEED);
  return REGIONS.map(() => MONTHS.map(() => between(next, 8_000, 26_000)));
}

function inputs() {
  const amounts = sales();
  const typedAsText = (column: number, row: number) =>
    AS_TEXT.includes(`${columnName(column + 1)}${row + 2}`);
  const counted = (column: number, row: number) =>
    typedAsText(column, row) ? 0 : (amounts[row]?.[column] ?? 0);
  const regionRows: SheetCell[][] = REGIONS.map((region, row) => {
    const months = MONTHS.map((_, column): SheetCell => {
      const amount = amounts[row]?.[column] ?? 0;
      return typedAsText(column, row) ? withComma(amount) : amount;
    });
    const total = MONTHS.reduce((sum, _, column) => sum + counted(column, row), 0);
    return [region, ...months, { formula: `SUM(B${row + 2}:M${row + 2})`, value: total }];
  });
  const monthTotals = MONTHS.map((_, column) => {
    const letter = columnName(column + 1);
    const last = letter === SHORT_TOTAL ? REGIONS.length : REGIONS.length + 1;
    const value = REGIONS.slice(0, last - 1).reduce((sum, _, row) => sum + counted(column, row), 0);
    return { formula: `SUM(${letter}2:${letter}${last})`, value };
  });
  const grand = monthTotals.reduce((sum, cell) => sum + cell.value, 0);
  const totalRow: SheetCell[] = ["Total", ...monthTotals, { formula: "SUM(B8:M8)", value: grand }];
  return {
    files: [
      {
        name: NAME,
        bytes: xlsx([
          { name: "Sales", rows: [["Region", ...MONTHS, "Year"], ...regionRows, totalRow] },
          {
            name: "Summary",
            rows: [
              ["Measure", "Value"],
              ["Total sales", { formula: "Sales!N8", value: grand }],
              ["Number of regions", { formula: "COUNTA(Sales!A2:A7)", value: REGIONS.length }],
              // A deleted row left the divisor as #REF!: the value Excel saved is the error.
              ["Average sales per region", { formula: "Sales!N8/Sales!#REF!", value: "#REF!" }],
              // Refers to itself; with iteration off, Excel saves 0 for it.
              ["Bonus pool (2% of sales after the bonus)", { formula: "0.02*(B2-B5)", value: 0 }],
              ["Sales after the bonus", { formula: "B2-B5", value: grand }],
            ],
          },
        ]),
      },
    ],
    data: {
      "cells.json": JSON.stringify({
        regions: REGIONS,
        months: MONTHS,
        sales: amounts,
        typed_as_text: AS_TEXT,
        formulas: {
          ...Object.fromEntries(
            MONTHS.map((_, column) => [
              `Sales!${columnName(column + 1)}8`,
              monthTotals[column]?.formula,
            ]),
          ),
          "Sales!N8": "SUM(B8:M8)",
          "Summary!B4": "Sales!N8/Sales!#REF!",
          "Summary!B5": "0.02*(B2-B5)",
        },
        saved_total: grand,
      }),
    },
  };
}

export const task: Task = {
  id: "E02",
  title: "Find a workbook's defects",
  needs: ["F", "N"],
  seed: SEED,
  question: {
    en: `Check ${NAME} for errors before I send it on. Look for broken references, formulas that don't follow the pattern of their row, numbers stored as text, and circular references. For each defect give its cell as Sheet!Cell (for example Sales!B2), what is wrong and how to fix it. Once everything is fixed, what are the total sales for the year and the average sales per region?`,
  },
  inputs,
  expect: [
    {
      id: "defects",
      kind: "rows",
      label: "Each defect, by its cell",
      key: new RegExp(`\\b(?:${DEFECTS.join("|")})\\b`, "gi"),
      columns: [],
    },
    {
      id: "fixed_total",
      kind: "number",
      label: "Total sales for the year once fixed",
      unit: "plain",
      tolerance: { abs: 0.5 },
      near: /total|合计|总/i,
    },
    {
      id: "fixed_average",
      kind: "number",
      label: "Average sales per region once fixed",
      unit: "plain",
      tolerance: { abs: 0.5 },
      near: /average|per region|平均/i,
    },
  ],
  sources: { documents: [NAME] },
};
