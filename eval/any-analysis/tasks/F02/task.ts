import { between, csv, random, utf8, xlsx } from "../../inputs";
import type { Task } from "../../task";

const LEDGER = "GL cash export 2025.xlsx";
const BANK = "Bank statement 2025.csv";
const SEED = 102;

const MATCHED = 4132;
/** Payments still to clear and deposits still in transit at the year's end, and a few left out of the bank. */
const OUTSTANDING_PAYMENTS = 40;
const DEPOSITS_IN_TRANSIT = 15;
const LEDGER_ONLY_MIDYEAR = 8;
/** The same amount on both sides, 5 to 9 days apart: outside the 3 days, so neither may match. */
const NEAR_MISSES = 5;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const PAYEES = [
  "Harrowgate Paper Co",
  "Quillmere Freight",
  "Brackenridge Utilities",
  "Tamsworth Office Supply",
  "Velloran Software",
  "Ormsby & Vale Legal",
  "Kestrelholm Cleaning",
  "Pellucid Print Works",
  "Draymoor Logistics",
  "Fennick Catering",
];
const PAYERS = [
  "Calloway Hollis Ltd",
  "Minstrel Bay Traders",
  "Orchardine Retail",
  "Sablewood Clinics",
  "Gristle & Lark",
  "Upperfold Hotels",
  "Wenlow Engineering",
  "Thistlecombe Farms",
];

interface Line {
  /** Days from 1 January 2025. */
  day: number;
  /** Money in positive, in cents. */
  cents: number;
  ledgerText: string;
  bankText: string;
}

const date = (day: number) => new Date(Date.UTC(2025, 0, 1 + day));
const iso = (day: number) => date(day).toISOString().slice(0, 10);
const dayFirst = (day: number) => {
  const [year, month, dayOfMonth] = iso(day).split("-");
  return `${dayOfMonth}/${month}/${year}`;
};

function lines() {
  const next = random(SEED);
  const used = new Set<number>();
  const amount = (from: number, to: number) => {
    for (;;) {
      const cents = Math.round(Math.exp(Math.log(from) + next() * (Math.log(to) - Math.log(from))));
      if (!used.has(cents)) {
        used.add(cents);
        return cents;
      }
    }
  };
  const pick = (names: readonly string[]) => names[between(next, 0, names.length - 1)] ?? "";
  let cheque = 104_210;
  const described = (cents: number) => {
    const reference = between(next, 100_000, 999_999);
    if (cents > 0) {
      return {
        ledgerText: `Receipt from ${pick(PAYERS)}`,
        bankText: `BACS CREDIT REF ${reference}`,
      };
    }
    if (next() < 0.3) {
      cheque += 1;
      return { ledgerText: `Cheque ${cheque} to ${pick(PAYEES)}`, bankText: `CHQ ${cheque}` };
    }
    return { ledgerText: `Payment to ${pick(PAYEES)}`, bankText: `FASTER PAYMENT ${reference}` };
  };

  const ledger: Line[] = [];
  const bank: Line[] = [];
  const both = (ledgerDay: number, bankDay: number, cents: number) => {
    const text = described(cents);
    ledger.push({ day: ledgerDay, cents, ...text });
    bank.push({ day: bankDay, cents, ...text });
  };
  for (let index = 0; index < MATCHED; index++) {
    const cents = next() < 0.42 ? amount(5_000, 4_000_000) : -amount(5_000, 2_500_000);
    const day = between(next, 3, 356);
    const lag = next() < 0.12 ? -between(next, 1, 3) : between(next, 0, 3);
    both(day, day + lag, cents);
  }
  for (let index = 0; index < NEAR_MISSES; index++) {
    const day = between(next, 30, 330);
    const gap = between(next, 5, 9) * (index % 2 === 0 ? 1 : -1);
    both(day, day + gap, -amount(20_000, 900_000));
  }
  const ledgerOnly = (day: number, cents: number) =>
    ledger.push({ day, cents, ...described(cents) });
  for (let index = 0; index < OUTSTANDING_PAYMENTS; index++) {
    ledgerOnly(between(next, 349, 364), -amount(20_000, 1_500_000));
  }
  for (let index = 0; index < DEPOSITS_IN_TRANSIT; index++) {
    ledgerOnly(between(next, 361, 364), amount(50_000, 1_200_000));
  }
  for (let index = 0; index < LEDGER_ONLY_MIDYEAR; index++) {
    ledgerOnly(between(next, 40, 300), -amount(10_000, 400_000));
  }
  const monthEnds = [30, 58, 89, 119, 150, 180, 211, 242, 272, 303, 333, 364];
  for (const [month, day] of monthEnds.entries()) {
    const label = MONTHS[month] ?? "";
    bank.push({
      day,
      cents: -amount(3_500, 6_500),
      ledgerText: "",
      bankText: `ACCOUNT FEE ${label}`,
    });
    if (month === 11) {
      bank.push({
        day,
        cents: amount(110_000, 160_000),
        ledgerText: "",
        bankText: "CREDIT INTEREST",
      });
    }
  }
  const byDay = (a: Line, b: Line) => a.day - b.day;
  return { ledger: ledger.sort(byDay), bank: bank.sort(byDay) };
}

function inputs() {
  const { ledger, bank } = lines();
  const dollars = (cents: number) => cents / 100;
  let balance = 120_425_000;
  const statement = bank.map((line) => {
    balance += line.cents;
    return [dayFirst(line.day), line.bankText, dollars(line.cents), dollars(balance)];
  });
  return {
    files: [
      {
        name: LEDGER,
        bytes: xlsx([
          {
            name: "Cash ledger",
            rows: [
              ["Entry", "Date", "Account", "Description", "Debit", "Credit"],
              ...ledger.map((line, index) => [
                `JE${String(index + 1).padStart(6, "0")}`,
                iso(line.day),
                "1010 Cash at bank",
                line.ledgerText,
                line.cents > 0 ? dollars(line.cents) : null,
                line.cents < 0 ? dollars(-line.cents) : null,
              ]),
            ],
          },
        ]),
      },
      {
        name: BANK,
        bytes: utf8(csv([["Date", "Description", "Amount", "Balance"], ...statement])),
      },
    ],
    data: {
      "ledger.csv": csv([
        ["date", "amount"],
        ...ledger.map((line) => [iso(line.day), dollars(line.cents)]),
      ]),
      "bank.csv": csv([
        ["date", "amount"],
        ...bank.map((line) => [iso(line.day), dollars(line.cents)]),
      ]),
    },
  };
}

export const task: Task = {
  id: "F02",
  title: "Bank reconciliation",
  needs: ["P"],
  seed: SEED,
  question: {
    en: `Reconcile the cash ledger in ${LEDGER} with ${BANK} for 2025. In the ledger a debit is money in and a credit is money out; on the bank statement a negative amount is money out, and dates are day/month/year. Match a ledger entry to a bank line when the amounts are equal to the cent and the dates are no more than 3 calendar days apart, either way; each entry and each line can match only once. How many pairs match? List the ledger entries and the bank lines left unmatched, and give the count and the net sum (money in positive) of each side's unmatched items. What is the ledger's net total minus the bank's net total for the year, and do the unmatched sums explain that difference?`,
  },
  inputs,
  expect: [
    {
      id: "matched",
      kind: "number",
      label: "Pairs matched",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /match|pair|配对|匹配/i,
    },
    {
      id: "ledger_unmatched_count",
      kind: "number",
      label: "Unmatched ledger entries",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /ledger|\bGL\b|books?\b|总账|账簿/i,
    },
    {
      id: "ledger_unmatched_sum",
      kind: "number",
      label: "Net sum of the unmatched ledger entries",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /ledger|\bGL\b|books?\b|总账|账簿/i,
      signless: true,
    },
    {
      id: "bank_unmatched_count",
      kind: "number",
      label: "Unmatched bank lines",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /bank|statement|银行|对账单/i,
    },
    {
      id: "bank_unmatched_sum",
      kind: "number",
      label: "Net sum of the unmatched bank lines",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /bank|statement|银行|对账单/i,
      signless: true,
    },
    {
      id: "difference",
      kind: "number",
      label: "Ledger total minus bank total",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /differ|gap|差额|差异/i,
      signless: true,
    },
  ],
  sources: { documents: [LEDGER, BANK] },
};
