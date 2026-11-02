import { between, csv, random, xlsx } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Three statements 2021-2025.xlsx";
const SEED = 108;
const YEARS = [2021, 2022, 2023, 2024, 2025] as const;

/**
 * One planted failure per check, each in its own year: inventory typed too high in 2022, so the
 * balance sheet doesn't balance; a property revaluation credited straight to retained earnings in
 * 2023 (and carried on), so they don't roll forward that year only; and the change in payables
 * overstated on the 2024 cash flow, so its closing cash isn't the balance sheet's.
 */
const PLANTED = {
  balance: { year: 2022, amount: 18_350 },
  retained: { year: 2023, amount: 64_125 },
  cash: { year: 2024, amount: 2_736 },
} as const;

interface Year {
  revenue: number;
  cogs: number;
  opex: number;
  depreciation: number;
  interest: number;
  tax: number;
  receivables: number;
  inventory: number;
  ppe: number;
  payables: number;
  debt: number;
  capital: number;
  retained: number;
  cash: number;
  capex: number;
  borrowing: number;
  dividends: number;
}

const netIncome = (year: Year) =>
  year.revenue - year.cogs - year.opex - year.depreciation - year.interest - year.tax;

/** The true statements, opening position first: they tie out in every year. */
function model(): Year[] {
  const next = random(SEED);
  const share = (from: number, to: number) => from + (to - from) * next();
  const opening: Year = {
    revenue: 8_420_000,
    cogs: 0,
    opex: 0,
    depreciation: 0,
    interest: 0,
    tax: 0,
    receivables: 1_096_300,
    inventory: 512_800,
    ppe: 3_870_000,
    payables: 563_400,
    debt: 2_100_000,
    capital: 1_000_000,
    retained: 0,
    cash: 684_500,
    capex: 0,
    borrowing: 0,
    dividends: 0,
  };
  opening.retained =
    opening.cash +
    opening.receivables +
    opening.inventory +
    opening.ppe -
    opening.payables -
    opening.debt -
    opening.capital;
  const years = [opening];
  for (let index = 0; index < YEARS.length; index++) {
    const last = years[years.length - 1] ?? opening;
    const revenue = Math.round(last.revenue * share(1.06, 1.12));
    const cogs = Math.round(revenue * share(0.58, 0.62));
    const opex = Math.round(revenue * share(0.2, 0.23));
    const depreciation = Math.round(last.ppe * 0.1);
    const interest = Math.round(last.debt * 0.06);
    const tax = Math.round((revenue - cogs - opex - depreciation - interest) * 0.25);
    const capex = Math.round(depreciation + revenue * share(0.03, 0.05));
    const borrowing = between(next, -40, 60) * 5_000;
    const year: Year = {
      revenue,
      cogs,
      opex,
      depreciation,
      interest,
      tax,
      receivables: Math.round(revenue * share(0.12, 0.14)),
      inventory: Math.round(cogs * share(0.09, 0.11)),
      ppe: last.ppe + capex - depreciation,
      payables: Math.round(cogs * share(0.1, 0.12)),
      debt: last.debt + borrowing,
      capital: last.capital,
      retained: 0,
      cash: 0,
      capex,
      borrowing,
      dividends: 0,
    };
    year.dividends = Math.round((netIncome(year) * share(0.3, 0.4)) / 1_000) * 1_000;
    year.retained = last.retained + netIncome(year) - year.dividends;
    year.cash = last.cash + operating(year, last) - capex + borrowing - year.dividends;
    years.push(year);
  }
  return years;
}

function operating(year: Year, last: Year): number {
  return (
    netIncome(year) +
    year.depreciation -
    (year.receivables - last.receivables) -
    (year.inventory - last.inventory) +
    (year.payables - last.payables)
  );
}

type Row = [string, ...number[]];

function statements() {
  const years = model();
  const shown = years.map((year, index) => {
    const calendar = index === 0 ? 2020 : (YEARS[index - 1] ?? 2020);
    const revalued = calendar >= PLANTED.retained.year ? PLANTED.retained.amount : 0;
    return {
      ...year,
      inventory: year.inventory + (calendar === PLANTED.balance.year ? PLANTED.balance.amount : 0),
      ppe: year.ppe + revalued,
      retained: year.retained + revalued,
    };
  });
  const each = (of: (year: Year, index: number) => number) =>
    shown.slice(1).map((year, index) => of(year, index + 1));
  const income: Row[] = [
    ["Revenue", ...each((year) => year.revenue)],
    ["Cost of sales", ...each((year) => -year.cogs)],
    ["Gross profit", ...each((year) => year.revenue - year.cogs)],
    ["Operating expenses", ...each((year) => -year.opex)],
    ["Depreciation", ...each((year) => -year.depreciation)],
    [
      "Operating profit",
      ...each((year) => year.revenue - year.cogs - year.opex - year.depreciation),
    ],
    ["Interest expense", ...each((year) => -year.interest)],
    ["Profit before tax", ...each((year) => netIncome(year) + year.tax)],
    ["Income tax", ...each((year) => -year.tax)],
    ["Net income", ...each((year) => netIncome(year))],
  ];
  const all = (of: (year: Year) => number) => shown.map(of);
  const assets = (year: Year) => year.cash + year.receivables + year.inventory + year.ppe;
  const liabilities = (year: Year) => year.payables + year.debt;
  const equity = (year: Year) => year.capital + year.retained;
  const balance: Row[] = [
    ["Cash", ...all((year) => year.cash)],
    ["Trade receivables", ...all((year) => year.receivables)],
    ["Inventory", ...all((year) => year.inventory)],
    ["Property, plant and equipment", ...all((year) => year.ppe)],
    ["Total assets", ...all(assets)],
    ["Trade payables", ...all((year) => year.payables)],
    ["Borrowings", ...all((year) => year.debt)],
    ["Total liabilities", ...all(liabilities)],
    ["Share capital", ...all((year) => year.capital)],
    ["Retained earnings", ...all((year) => year.retained)],
    ["Total equity", ...all(equity)],
    ["Total liabilities and equity", ...all((year) => liabilities(year) + equity(year))],
  ];
  const truth = years;
  const flows = YEARS.map((calendar, index) => {
    const year = truth[index + 1] ?? truth[0];
    const last = truth[index] ?? truth[0];
    if (!year || !last) throw new Error("F08's model has a year missing.");
    const overstated = calendar === PLANTED.cash.year ? PLANTED.cash.amount : 0;
    const payables = year.payables - last.payables + overstated;
    const fromOperations = operating(year, last) + overstated;
    const change = fromOperations - year.capex + year.borrowing - year.dividends;
    return {
      netIncome: netIncome(year),
      depreciation: year.depreciation,
      receivables: -(year.receivables - last.receivables),
      inventory: -(year.inventory - last.inventory),
      payables,
      fromOperations,
      capex: -year.capex,
      borrowing: year.borrowing,
      dividends: -year.dividends,
      change,
      opening: last.cash,
      closing: last.cash + change,
    };
  });
  const flow = (of: (each: (typeof flows)[number]) => number) => flows.map(of);
  const cashFlow: Row[] = [
    ["Net income", ...flow((each) => each.netIncome)],
    ["Depreciation", ...flow((each) => each.depreciation)],
    ["(Increase)/decrease in trade receivables", ...flow((each) => each.receivables)],
    ["(Increase)/decrease in inventory", ...flow((each) => each.inventory)],
    ["Increase/(decrease) in trade payables", ...flow((each) => each.payables)],
    ["Cash from operating activities", ...flow((each) => each.fromOperations)],
    ["Capital expenditure", ...flow((each) => each.capex)],
    ["Cash from investing activities", ...flow((each) => each.capex)],
    ["Borrowings raised/(repaid)", ...flow((each) => each.borrowing)],
    ["Dividends paid", ...flow((each) => each.dividends)],
    ["Cash from financing activities", ...flow((each) => each.borrowing + each.dividends)],
    ["Net change in cash", ...flow((each) => each.change)],
    ["Cash at beginning of year", ...flow((each) => each.opening)],
    ["Cash at end of year", ...flow((each) => each.closing)],
  ];
  return { income, balance, cashFlow };
}

const long = (statement: string, rows: Row[], years: readonly number[]) =>
  rows.flatMap(([line, ...values]) =>
    values.map((value, index) => [statement, line, years[index] ?? 0, value]),
  );

function inputs() {
  const { income, balance, cashFlow } = statements();
  const withOpening = [2020, ...YEARS];
  return {
    files: [
      {
        name: NAME,
        bytes: xlsx([
          { name: "Income statement", rows: [["USD", ...YEARS], ...income] },
          { name: "Balance sheet", rows: [["USD, at 31 December", ...withOpening], ...balance] },
          { name: "Cash flow", rows: [["USD", ...YEARS], ...cashFlow] },
        ]),
      },
    ],
    data: {
      "statements.csv": csv([
        ["statement", "line", "year", "value"],
        ...long("income", income, YEARS),
        ...long("balance", balance, withOpening),
        ...long("cash", cashFlow, YEARS),
      ]),
    },
  };
}

/** The failing year and its difference on one line, the difference with or without its thousands comma. */
function sameLine({ year, amount }: { year: number; amount: number }): RegExp {
  const digits = String(amount);
  const written = `(?<!\\d[.,]?)${digits.slice(0, -3)},?${digits.slice(-3)}(?!,?\\d)`;
  return new RegExp(`\\b${year}\\b[^\\n]*${written}|${written}[^\\n]*\\b${year}\\b`);
}

export const task: Task = {
  id: "F08",
  title: "Three statements tie out",
  needs: ["P"],
  seed: SEED,
  question: {
    en: `${NAME} has the income statement, balance sheet and cash flow statement for 2021 to 2025; the balance sheet also has 2020, the opening position. For each year from 2021 to 2025, check that: (1) the balance sheet balances, total assets equal to total liabilities and equity; (2) the cash flow statement's cash at the end of the year equals the balance sheet's cash; (3) retained earnings roll forward: last year's closing retained earnings plus this year's net income less the dividends paid on the cash flow statement equal this year's closing retained earnings. List every year that fails a check, with the check and the size of its difference, and say which years pass.`,
  },
  inputs,
  expect: [
    {
      id: "balance_difference",
      kind: "number",
      label: "Balance sheet difference in the failing year",
      unit: "plain",
      tolerance: { abs: 0.5 },
      near: /balanc|assets|liabilit|资产负债|资产|负债/i,
      signless: true,
    },
    {
      id: "balance_year",
      kind: "mention",
      label: "The balance sheet fails in 2022 by that difference",
      match: sameLine(PLANTED.balance),
    },
    {
      id: "cash_difference",
      kind: "number",
      label: "Cash difference in the failing year",
      unit: "plain",
      tolerance: { abs: 0.5 },
      near: /cash|现金/i,
      signless: true,
    },
    {
      id: "cash_year",
      kind: "mention",
      label: "The cash check fails in 2024 by that difference",
      match: sameLine(PLANTED.cash),
    },
    {
      id: "retained_difference",
      kind: "number",
      label: "Retained earnings difference in the failing year",
      unit: "plain",
      tolerance: { abs: 0.5 },
      near: /retained|roll|留存|未分配/i,
      signless: true,
    },
    {
      id: "retained_year",
      kind: "mention",
      label: "Retained earnings fail to roll forward in 2023 by that difference",
      match: sameLine(PLANTED.retained),
    },
  ],
  sources: { documents: [NAME] },
};
