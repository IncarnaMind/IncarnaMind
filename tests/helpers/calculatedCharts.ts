/** A chart of calculated figures (#2307): a workbook's quarters, and figures calculated from them. */
import type { CalculatedFigure, Citation, FigureInput } from "../../src/core/api";
import type { NodeJSON } from "../../src/shared/blockJson";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { type ChartAttributes, chartFromTable, gridOfTable } from "../../src/shared/charts";
import { FORMULA_VERSION } from "../../src/shared/formula";

const rowCitation = (sheet: string, row: number, quote: string): Citation => ({
  passageId: `passage-${sheet}`,
  documentId: "sales",
  documentName: "Regional sales 2026",
  contentHash: "hash",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "rows", sheet, from: row, to: row },
  quote,
  check: "found",
  checkReason: null,
});

const input = (name: string, sheet: string, row: number, revenue: number): FigureInput => {
  const chars = String(revenue);
  const quote = `West\t760\t${chars}`;
  return {
    name,
    label: `West revenue ${sheet}`,
    citation: rowCitation(sheet, row, quote),
    number: {
      chars,
      at: quote.indexOf(chars),
      value: revenue,
      scale: 1,
      scaleWord: null,
      unit: { kind: "plain" },
      decimals: 0,
      approximate: false,
      reading: null,
    },
    cell: { sheet, ref: `C${row}`, stored: null },
    unitStatement: null,
  };
};

export const Q1 = input("q1", "Q1 2026", 5, 14590);
export const Q2 = input("q2", "Q2 2026", 5, 17330);
export const Q3 = input("q3", "Q3 2026", 5, 20610);

const figure = (
  label: string,
  formula: string,
  inputs: FigureInput[],
  value: number,
  shown: string,
): CalculatedFigure => ({
  label,
  formula,
  inputs,
  value,
  unit: { kind: "plain" },
  approximate: false,
  shown,
  show: { language: "en", as: null, decimals: null, scale: null },
  literals: [],
  engine: FORMULA_VERSION,
  written: null,
});

export const TOTAL = figure("West total", "q1 + q2 + q3", [Q1, Q2, Q3], 52530, "52,530");
export const GROWTH = figure("West growth", "q3 / q1 - 1", [Q1, Q3], 0.4126, "41.3%");

export const text = (value: string): NodeJSON => ({ type: "text", text: value });
export const citation = (cited: Citation): NodeJSON => ({ type: "citation", attrs: { ...cited } });
export const paragraph = (...content: NodeJSON[]): NodeJSON => ({ type: "paragraph", content });
export const tableCell = (...content: NodeJSON[]): NodeJSON => ({
  type: "tableCell",
  content: [paragraph(...content)],
});
export const header = (value: string): NodeJSON => ({
  type: "tableHeader",
  content: [paragraph(text(value))],
});
export const row = (...cells: NodeJSON[]): NodeJSON => ({ type: "tableRow", content: cells });

/** The table a model writes: each figure with its rows' Citations beside it. */
export const TABLE: NodeJSON = {
  type: "table",
  content: [
    row(header("Region"), header("Total revenue"), header("Growth")),
    row(
      tableCell(text("West")),
      tableCell(
        calculatedFigureNode(TOTAL, "figure-total"),
        text(" "),
        citation(Q1.citation),
        citation(Q2.citation),
        citation(Q3.citation),
      ),
      tableCell(
        calculatedFigureNode(GROWTH, "figure-growth"),
        text(" "),
        citation(Q1.citation),
        citation(Q3.citation),
      ),
    ),
    row(tableCell(text("North")), tableCell(text("70,460 "), citation(Q1.citation)), tableCell()),
  ],
};

export const chartOf = (table: NodeJSON): ChartAttributes => {
  const chart = chartFromTable(gridOfTable(table), {
    blockId: "table-1",
    title: "Total revenue by region",
    language: "en",
  });
  if (!chart) throw new Error("No chart was drawn.");
  return chart;
};
