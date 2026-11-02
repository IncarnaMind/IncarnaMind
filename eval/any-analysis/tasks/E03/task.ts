import { columnName, csv, type FormulaCell, type SheetCell, xlsx } from "../../inputs";
import type { ExpectedNumber, Task } from "../../task";

const NAME = "Harbourline valuation model.xlsx";
const YEARS = 5;

interface Inputs {
  revenue: number;
  growth: number;
  margin: number;
  depreciation: number;
  capex: number;
  workingCapital: number;
  tax: number;
  wacc: number;
  terminal: number;
}

/** The model's inputs, in $000 and shares, with their labels: on its Inputs sheet from B2 down, in this order. */
const GIVEN: Inputs = {
  revenue: 120_000,
  growth: 0.07,
  margin: 0.22,
  depreciation: 0.04,
  capex: 0.05,
  workingCapital: 0.1,
  tax: 0.25,
  wacc: 0.09,
  terminal: 0.02,
};
const LABELS: Record<keyof Inputs, string> = {
  revenue: "Revenue, last year ($000)",
  growth: "Revenue growth, years 1-5",
  margin: "EBITDA margin",
  depreciation: "Depreciation, share of revenue",
  capex: "Capital expenditure, share of revenue",
  workingCapital: "Working capital, share of the revenue increase",
  tax: "Tax rate",
  wacc: "WACC",
  terminal: "Terminal growth",
};
const KEYS: readonly (keyof Inputs)[] = [
  "revenue",
  "growth",
  "margin",
  "depreciation",
  "capex",
  "workingCapital",
  "tax",
  "wacc",
  "terminal",
];

/** A formula cell whose saved value is a number, as every cell of the DCF is. */
interface Worked extends FormulaCell {
  value: number;
}

/** The DCF sheet's rows, as formulas with the values Excel saves, at the model's own inputs. */
function dcf(inputs: Inputs): { rows: SheetCell[][]; value: number } {
  const year = (make: (column: string, index: number) => Worked): Worked[] =>
    Array.from({ length: YEARS }, (_, index) => make(columnName(index + 1), index));
  const at = (cells: Worked[], index: number) => cells[index]?.value ?? 0;
  const previous = (column: string) => String.fromCharCode(column.charCodeAt(0) - 1);
  const revenue: Worked[] = [];
  for (let index = 0; index < YEARS; index++) {
    const column = columnName(index + 1);
    revenue.push(
      index === 0
        ? { formula: "Inputs!$B$2*(1+Inputs!$B$3)", value: inputs.revenue * (1 + inputs.growth) }
        : {
            formula: `${previous(column)}2*(1+Inputs!$B$3)`,
            value: at(revenue, index - 1) * (1 + inputs.growth),
          },
    );
  }
  const ebitda = year((c, i) => ({
    formula: `${c}2*Inputs!$B$4`,
    value: at(revenue, i) * inputs.margin,
  }));
  const depreciation = year((c, i) => ({
    formula: `${c}2*Inputs!$B$5`,
    value: at(revenue, i) * inputs.depreciation,
  }));
  const ebit = year((c, i) => ({
    formula: `${c}3-${c}4`,
    value: at(ebitda, i) - at(depreciation, i),
  }));
  const tax = year((c, i) => ({ formula: `${c}5*Inputs!$B$8`, value: at(ebit, i) * inputs.tax }));
  const nopat = year((c, i) => ({ formula: `${c}5-${c}6`, value: at(ebit, i) - at(tax, i) }));
  const capex = year((c, i) => ({
    formula: `${c}2*Inputs!$B$6`,
    value: at(revenue, i) * inputs.capex,
  }));
  const workingCapital = year((c, i) =>
    i === 0
      ? {
          formula: `(${c}2-Inputs!$B$2)*Inputs!$B$7`,
          value: (at(revenue, i) - inputs.revenue) * inputs.workingCapital,
        }
      : {
          formula: `(${c}2-${previous(c)}2)*Inputs!$B$7`,
          value: (at(revenue, i) - at(revenue, i - 1)) * inputs.workingCapital,
        },
  );
  const flow = year((c, i) => ({
    formula: `${c}7+${c}4-${c}8-${c}9`,
    value: at(nopat, i) + at(depreciation, i) - at(capex, i) - at(workingCapital, i),
  }));
  const factor = year((c, i) => ({
    formula: `1/(1+Inputs!$B$9)^${c}$1`,
    value: 1 / (1 + inputs.wacc) ** (i + 1),
  }));
  const present = year((c, i) => ({
    formula: `${c}10*${c}11`,
    value: at(flow, i) * at(factor, i),
  }));
  const last = YEARS - 1;
  const sum = present.reduce((total, cell) => total + cell.value, 0);
  const terminal = (at(flow, last) * (1 + inputs.terminal)) / (inputs.wacc - inputs.terminal);
  const terminalPresent = terminal * at(factor, last);
  const value = sum + terminalPresent;
  const rows: SheetCell[][] = [
    ["Year", ...Array.from({ length: YEARS }, (_, index) => index + 1)],
    ["Revenue", ...revenue],
    ["EBITDA", ...ebitda],
    ["Depreciation", ...depreciation],
    ["EBIT", ...ebit],
    ["Tax on EBIT", ...tax],
    ["NOPAT", ...nopat],
    ["Capital expenditure", ...capex],
    ["Increase in working capital", ...workingCapital],
    ["Free cash flow", ...flow],
    ["Discount factor", ...factor],
    ["Present value of free cash flow", ...present],
    [],
    ["Sum of present values", { formula: "SUM(B12:F12)", value: sum }],
    [
      "Terminal value at year 5",
      { formula: "F10*(1+Inputs!$B$10)/(Inputs!$B$9-Inputs!$B$10)", value: terminal },
    ],
    ["Present value of terminal value", { formula: "B15*F11", value: terminalPresent }],
    ["Enterprise value ($000)", { formula: "B14+B16", value }],
  ];
  return { rows, value };
}

/** The grid's cells the Answer is held to: its four corners, as (terminal growth, WACC). */
const CORNERS = [
  [0, 0.07],
  [0.06, 0.07],
  [0, 0.12],
  [0.06, 0.12],
] as const;

const percent = (share: number) => `${Math.round(share * 100)}`;

const corner = ([growth, wacc]: (typeof CORNERS)[number]): ExpectedNumber => ({
  id: `value_g${percent(growth)}_w${percent(wacc)}`,
  kind: "number",
  label: `Enterprise value at ${percent(growth)}% terminal growth and ${percent(wacc)}% WACC`,
  unit: "plain",
  // A sheet or table shows $000 to a decimal or none: 5e-6 of 156,378 is 0.78.
  tolerance: { rel: 5e-6 },
});

export const task: Task = {
  id: "E03",
  title: "DCF sensitivity grid",
  needs: ["F", "N"],
  seed: 203,
  question: {
    en: `${NAME} values the business by discounted cash flow; its result is the enterprise value on the DCF sheet, in $000. Build a sensitivity grid of that enterprise value with terminal growth from 0% to 6% in steps of 1% down the side and WACC from 7% to 12% in steps of 1% across the top, recalculating the workbook's own formulas for each pair (every other input as it is). Give the grid in $000. Check that the cell at the workbook's own terminal growth and WACC equals the enterprise value the workbook shows.`,
  },
  inputs: () => {
    const { rows, value } = dcf(GIVEN);
    return {
      files: [
        {
          name: NAME,
          bytes: xlsx([
            {
              name: "Inputs",
              rows: [["Input", "Value"], ...KEYS.map((key) => [LABELS[key], GIVEN[key]])],
            },
            { name: "DCF", rows },
          ]),
        },
      ],
      data: {
        "inputs.csv": csv([["name", "value"], ...KEYS.map((key) => [key, GIVEN[key]])]),
        "workbook.csv": csv([
          ["name", "value"],
          ["enterprise_value", value],
        ]),
      },
    };
  },
  expect: [
    ...CORNERS.map(corner),
    {
      id: "base_case",
      kind: "number",
      label: "The grid's cell at the workbook's own inputs (its own enterprise value)",
      unit: "plain",
      tolerance: { rel: 5e-6 },
      near: /base|workbook|model's own|own inputs|current|as it is|基准|当前/i,
    },
  ],
  sources: { documents: [NAME] },
};
