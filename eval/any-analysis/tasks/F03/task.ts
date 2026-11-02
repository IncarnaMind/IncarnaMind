import { csv, xlsx } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Loan terms.xlsx";

/** A fixed-rate mortgage, paid monthly, and the extra the borrower adds to each payment. */
const TERMS = [
  ["Principal", 350_000],
  ["Annual interest rate", 0.0625],
  ["Term in years", 30],
  ["Payments per year", 12],
  ["Extra monthly payment", 250],
] as const;

export const task: Task = {
  id: "F03",
  title: "Loan amortisation",
  needs: ["P"],
  seed: 3,
  question: {
    en: "Using the loan terms in Loan terms.xlsx, build the full monthly amortisation schedule. What is the monthly payment, the interest in the first payment, and the total interest over all the payments? If the extra monthly payment is also made every month from the first payment, in which month is the loan paid off, and how much interest does that save?",
  },
  inputs: () => ({
    files: [
      {
        name: NAME,
        bytes: xlsx([{ name: "Loan", rows: [["Term", "Value"], ...TERMS.map((row) => [...row])] }]),
      },
    ],
    data: { "terms.csv": csv([["term", "value"], ...TERMS.map((row) => [...row])]) },
  }),
  expect: [
    {
      id: "payment",
      kind: "number",
      label: "Monthly payment",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /monthly payment|payment|月供|每月/i,
    },
    {
      id: "first_interest",
      kind: "number",
      label: "Interest in the first payment",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /first|month 1\b|首期|第一/i,
    },
    {
      id: "total_interest",
      kind: "number",
      label: "Total interest over the term",
      unit: "plain",
      tolerance: { abs: 1 },
      near: /total interest|总利息/i,
    },
    {
      id: "payoff_month",
      kind: "number",
      label: "Month paid off with the extra payment",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /paid off|pays? off|payoff|month|还清|第/i,
    },
    {
      id: "interest_saved",
      kind: "number",
      label: "Interest saved by the extra payment",
      unit: "plain",
      tolerance: { abs: 2 },
      near: /sav|less interest|节省|少付/i,
    },
  ],
  sources: { documents: [NAME] },
};
