import { csv, xlsx } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Mortgage offer terms.xlsx";

/** A fixed-rate repayment mortgage, paid monthly: 360 payments, so 360 schedule rows. */
const TERMS = [
  ["Principal", 280_000],
  ["Annual interest rate", 0.054],
  ["Term in years", 30],
  ["Payments per year", 12],
] as const;

export const task: Task = {
  id: "E07",
  title: "Loan schedule as a live workbook",
  needs: ["X"],
  seed: 207,
  question: {
    en: `Using the loan terms in ${NAME}, build me an Excel workbook (.xlsx) with the full monthly amortisation schedule: one row per payment with its payment, interest, principal and closing balance as live formulas that recalculate to the same figures in Excel and in LibreOffice, with no errors. Put the loan terms, and the file and cells they came from, on a sheet of their own called Sources, and have the schedule refer to them there. Save the workbook, and tell me the monthly payment and the total interest over the loan.`,
  },
  inputs: () => ({
    files: [
      {
        name: NAME,
        bytes: xlsx([
          { name: "Terms", rows: [["Term", "Value"], ...TERMS.map((row) => [...row])] },
        ]),
      },
    ],
    data: { "terms.csv": csv([["term", "value"], ...TERMS.map((row) => [...row])]) },
  }),
  expect: [
    {
      id: "schedule",
      kind: "file",
      label: "A workbook of the schedule with a live formula on each payment's row",
      extension: "xlsx",
      formulas: 360,
    },
    {
      id: "payment",
      kind: "number",
      label: "Monthly payment",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /monthly payment|payment|月供|每月/i,
    },
    {
      id: "total_interest",
      kind: "number",
      label: "Total interest over the loan",
      unit: "plain",
      tolerance: { abs: 1 },
      near: /total interest|总利息/i,
    },
  ],
  sources: { documents: [NAME] },
};
