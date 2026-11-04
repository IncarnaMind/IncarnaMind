import { csv, xlsx } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Product P&L model.xlsx";

/** The inputs in B2:B6, in this order. */
const INPUTS = [
  ["Units sold", 48_000],
  ["Unit price", 32.5],
  ["Variable cost per unit", 18.4],
  ["Commission, share of revenue", 0.06],
  ["Fixed costs", 310_000],
] as const;

const [units, price, variable, commission, fixed] = INPUTS.map(([, value]) => value);

function model() {
  const revenue = (units ?? 0) * (price ?? 0);
  const variableCosts = (units ?? 0) * (variable ?? 0);
  const commissionCost = revenue * (commission ?? 0);
  const profit = revenue - variableCosts - commissionCost - (fixed ?? 0);
  return [
    ["Revenue", { formula: "B2*B3", value: revenue }],
    ["Variable costs", { formula: "B2*B4", value: variableCosts }],
    ["Commission", { formula: "B9*B5", value: commissionCost }],
    ["Fixed costs", { formula: "B6", value: fixed ?? 0 }],
    ["Operating profit", { formula: "B9-B10-B11-B12", value: profit }],
    ["Operating margin", { formula: "B13/B9", value: profit / revenue }],
  ] as const;
}

export const task: Task = {
  id: "E04",
  title: "Price for a target margin",
  needs: ["F", "N"],
  seed: 204,
  question: {
    en: `In ${NAME}, what is the operating margin at today's unit price? What unit price gives an operating margin of exactly 20%, with every other input as it is? Put that price into the unit price cell and show the model's own revenue, operating profit and margin with it, to prove the margin is then 20%.`,
  },
  inputs: () => ({
    files: [
      {
        name: NAME,
        bytes: xlsx([
          {
            name: "Model",
            rows: [
              ["Input", "Value"],
              ...INPUTS.map((row) => [...row]),
              [],
              ["P&L", null],
              ...model().map(([label, cell]) => [label, { ...cell }]),
            ],
          },
        ]),
      },
    ],
    data: { "inputs.csv": csv([["name", "value"], ...INPUTS.map((row) => [...row])]) },
  }),
  expect: [
    {
      id: "margin_now",
      kind: "number",
      label: "Operating margin at today's price",
      unit: "percent",
      tolerance: { abs: 0.0005 },
      near: /today|current|at \$?32\.50|目前|当前/i,
    },
    {
      id: "price",
      kind: "number",
      label: "Unit price for a 20% margin",
      unit: "plain",
      tolerance: { abs: 0.005 },
      near: /price|单价|价格/i,
    },
    {
      // A price rounded to the cent moves the profit by up to 0.005 x 48,000 x 0.94, about 226.
      id: "profit_at_price",
      kind: "number",
      label: "Operating profit with that price in the model",
      unit: "plain",
      tolerance: { abs: 230 },
      near: /operating profit|profit|营业利润|利润/i,
    },
  ],
  sources: { documents: [NAME] },
};
