import { csv, random, round, type SheetData, xlsx } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Arvelle group trial balances FY2025.xlsx";
const SEED = 107;

/** USD per unit: the P&L is translated at the year's average; the closing rate is there to be left alone. */
const RATES = [
  { currency: "EUR", average: 1.0827, closing: 1.1702 },
  { currency: "GBP", average: 1.2693, closing: 1.3361 },
  { currency: "USD", average: 1, closing: 1 },
] as const;

/** The fee the parent charges each subsidiary, in the subsidiary's currency, invoiced at the average rate. */
const FEES = { EUR: 1_150_000, GBP: 640_000 } as const;
const average = (currency: string) =>
  RATES.find((rate) => rate.currency === currency)?.average ?? 1;

type Line = "Revenue" | "Cost of sales" | "Operating expenses" | "Finance costs" | "Income tax";

interface Row {
  code: string;
  name: string;
  line: Line | "Balance sheet";
  debit: number;
  credit: number;
}

interface Entity {
  name: string;
  sheet: string;
  currency: "USD" | "EUR" | "GBP";
  /** Each P&L account: its code, name, P&L line and amount in the entity's currency. */
  accounts: [string, string, Line, number][];
}

const ENTITIES: Entity[] = [
  {
    name: "Arvelle Holdings Inc.",
    sheet: "TB Holdings (USD)",
    currency: "USD",
    accounts: [
      ["4000", "Sales", "Revenue", 38_450_000],
      [
        "4900",
        "Management fee income - intercompany (Arvelle GmbH, Arvelle UK Ltd)",
        "Revenue",
        round(FEES.EUR * average("EUR") + FEES.GBP * average("GBP"), 2),
      ],
      ["5000", "Cost of goods sold", "Cost of sales", 21_300_000],
      ["6100", "Salaries", "Operating expenses", 6_420_000],
      ["6200", "Rent and facilities", "Operating expenses", 2_150_000],
      ["6300", "Marketing", "Operating expenses", 1_300_000],
      ["6800", "Depreciation", "Operating expenses", 1_240_000],
      ["7100", "Interest expense", "Finance costs", 610_000],
      ["8100", "Income tax expense", "Income tax", 1_690_000],
    ],
  },
  {
    name: "Arvelle GmbH",
    sheet: "TB GmbH (EUR)",
    currency: "EUR",
    accounts: [
      ["4000", "Sales", "Revenue", 14_800_000],
      ["5000", "Cost of goods sold", "Cost of sales", 8_120_000],
      ["6100", "Salaries", "Operating expenses", 2_380_000],
      ["6200", "Rent and facilities", "Operating expenses", 760_000],
      ["6400", "Management fee - Arvelle Holdings (intercompany)", "Operating expenses", FEES.EUR],
      ["6800", "Depreciation", "Operating expenses", 310_000],
      ["7100", "Interest expense", "Finance costs", 180_000],
      ["8100", "Income tax expense", "Income tax", 520_000],
    ],
  },
  {
    name: "Arvelle UK Ltd",
    sheet: "TB UK (GBP)",
    currency: "GBP",
    accounts: [
      ["4000", "Sales", "Revenue", 9_600_000],
      ["5000", "Cost of goods sold", "Cost of sales", 5_200_000],
      ["6100", "Salaries", "Operating expenses", 1_640_000],
      ["6200", "Rent and facilities", "Operating expenses", 510_000],
      ["6400", "Management fee - Arvelle Holdings (intercompany)", "Operating expenses", FEES.GBP],
      ["6800", "Depreciation", "Operating expenses", 150_000],
      ["7100", "Interest expense", "Finance costs", 95_000],
      ["8100", "Income tax expense", "Income tax", 370_000],
    ],
  },
];

/** A trial balance's rows: its P&L accounts, nudged off round figures, and balance-sheet accounts that make it balance. */
function trialBalance(entity: Entity, next: () => number): Row[] {
  const rows = entity.accounts.map(([code, name, line, amount]): Row => {
    const intercompany = name.includes("intercompany");
    const value = intercompany ? amount : round(amount * (1 + (next() - 0.5) * 0.02), 2);
    const credit = line === "Revenue";
    return { code, name, line, debit: credit ? 0 : value, credit: credit ? value : 0 };
  });
  const income = rows.reduce((sum, row) => sum + row.credit - row.debit, 0);
  const scale = entity.accounts[0]?.[3] ?? 0;
  const balance = [
    ["1000", "Cash at bank", round(scale * (0.08 + 0.04 * next()), 2), 0],
    ["1100", "Trade receivables", round(scale * (0.15 + 0.05 * next()), 2), 0],
    ["1500", "Property, plant and equipment", round(scale * (0.4 + 0.1 * next()), 2), 0],
    ["2000", "Trade payables", 0, round(scale * (0.1 + 0.04 * next()), 2)],
    ["3000", "Share capital", 0, round(scale * 0.1, 2)],
  ] as const;
  const debits = balance.reduce((sum, row) => sum + row[2], 0);
  const credits = balance.reduce((sum, row) => sum + row[3], 0);
  const retained = round(debits - credits - income, 2);
  return [
    ...balance.map(
      ([code, name, debit, credit]): Row => ({
        code,
        name,
        line: "Balance sheet",
        debit,
        credit,
      }),
    ),
    {
      code: "3100",
      name: "Retained earnings brought forward",
      line: "Balance sheet",
      debit: 0,
      credit: retained,
    },
    ...rows,
  ];
}

const total = (rows: readonly Row[], side: "debit" | "credit") =>
  round(
    rows.reduce((sum, row) => sum + row[side], 0),
    2,
  );

function inputs() {
  const next = random(SEED);
  const balances = ENTITIES.map((entity) => ({ entity, rows: trialBalance(entity, next) }));
  const sheets: SheetData[] = [
    ...balances.map(({ entity, rows }) => ({
      name: entity.sheet,
      rows: [
        [`${entity.name}: trial balance at 31 December 2025 (${entity.currency})`],
        [],
        ["Account", "Name", "P&L line", "Debit", "Credit"],
        ...rows.map((row) => [row.code, row.name, row.line, row.debit || null, row.credit || null]),
        [null, "Total", null, total(rows, "debit"), total(rows, "credit")],
      ],
    })),
    {
      name: "Rates",
      rows: [
        [
          "Currency",
          "Average rate FY2025 (USD per unit)",
          "Closing rate 31 Dec 2025 (USD per unit)",
        ],
        ...RATES.map((rate) => [rate.currency, rate.average, rate.closing]),
      ],
    },
  ];
  return {
    files: [{ name: NAME, bytes: xlsx(sheets) }],
    data: {
      "trial_balances.csv": csv([
        ["entity", "currency", "account", "name", "line", "debit", "credit"],
        ...balances.flatMap(({ entity, rows }) =>
          rows.map((row) => [
            entity.name,
            entity.currency,
            row.code,
            row.name,
            row.line,
            row.debit,
            row.credit,
          ]),
        ),
      ]),
      "rates.csv": csv([
        ["currency", "average", "closing"],
        ...RATES.map((rate) => [rate.currency, rate.average, rate.closing]),
      ]),
    },
  };
}

export const task: Task = {
  id: "F07",
  title: "Group consolidation",
  needs: ["P"],
  seed: SEED,
  question: {
    en: `${NAME} has the trial balances of Arvelle Holdings Inc. (USD), Arvelle GmbH (EUR) and Arvelle UK Ltd (GBP), and a Rates sheet. Prepare the group's consolidated P&L for 2025 in USD, by P&L line: translate each entity's P&L accounts at the year's average rate, and eliminate the intercompany management fee the parent charges the two subsidiaries. Show the elimination as its own line. What are the consolidated revenue and the consolidated profit for the year (after income tax)? What is the elimination amount? State each rate you used and the cell of the Rates sheet it came from.`,
  },
  inputs,
  expect: [
    {
      id: "revenue",
      kind: "number",
      label: "Consolidated revenue, USD",
      unit: "plain",
      tolerance: { abs: 1 },
      near: /revenue|sales|营业收入|收入/i,
    },
    {
      id: "profit",
      kind: "number",
      label: "Consolidated profit for the year, USD",
      unit: "plain",
      tolerance: { abs: 1 },
      near: /profit|net income|利润/i,
    },
    {
      id: "elimination",
      kind: "number",
      label: "Intercompany elimination, USD",
      unit: "plain",
      tolerance: { abs: 1 },
      near: /eliminat|intercompany|management fee|抵销|抵消|内部/i,
      signless: true,
    },
    {
      id: "eur_rate",
      kind: "number",
      label: "EUR average rate used",
      unit: "plain",
      tolerance: { abs: 0.00005 },
      near: /EUR|euro|欧元/i,
    },
    {
      id: "gbp_rate",
      kind: "number",
      label: "GBP average rate used",
      unit: "plain",
      tolerance: { abs: 0.00005 },
      near: /GBP|sterling|pound|英镑/i,
    },
    {
      id: "rate_cells",
      kind: "mention",
      label: "Names the cells the two average rates came from",
      match: /^(?=[\s\S]*\bB2\b)(?=[\s\S]*\bB3\b)/,
    },
  ],
  sources: { documents: [NAME] },
};
