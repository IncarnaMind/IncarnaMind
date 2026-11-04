import { between, csv, fullWidth, normal, random, round, utf8, xlsx } from "../../inputs";
import type { Task, TaskLanguage } from "../../task";

const SEED = 105;
const NAMES = {
  en: { invoices: "Receivables invoices.xlsx", payments: "Customer receipts.csv" },
  zh: { invoices: "应收账款发票.xlsx", payments: "收款记录.csv" },
} as const;
const SHEET = { en: "Invoices", zh: "发票" } as const;
const INVOICE_HEADINGS = {
  en: ["Invoice", "Customer code", "Customer", "Invoice date", "Due date", "Amount"],
  zh: ["发票号", "客户编号", "客户名称", "开票日期", "到期日", "金额"],
} as const;
const PAYMENT_HEADINGS = {
  en: ["Receipt", "Invoice", "Date received", "Amount received"],
  zh: ["收款编号", "发票号", "收款日期", "收款金额"],
} as const;

/** Days from 1 January 2024: the ageing is as at 30 September 2025, and receipts run on to 31 October. */
const AS_AT = 638;
const EXPORTED = 669;
const INVOICES = 15_000;

/**
 * Each customer's share of the invoices, payment terms, mean and spread of days paid after the
 * due date, chance of paying in two parts, and chance of never paying (a dispute): so every
 * customer has something in every bucket, and the late payers stand out in "over 90".
 */
const CUSTOMERS = [
  {
    en: "Quorlan Interiors",
    zh: "启澜装饰",
    weight: 14,
    terms: 30,
    late: 4,
    spread: 6,
    split: 0.04,
    never: 0.002,
  },
  {
    en: "Brindlemark Foods",
    zh: "柏铭食品",
    weight: 18,
    terms: 30,
    late: 12,
    spread: 10,
    split: 0.08,
    never: 0.004,
  },
  {
    en: "Corvane Systems",
    zh: "科闻系统",
    weight: 9,
    terms: 45,
    late: 25,
    spread: 18,
    split: 0.1,
    never: 0.008,
  },
  {
    en: "Dunveth Hospitality",
    zh: "顿维酒店",
    weight: 11,
    terms: 30,
    late: 48,
    spread: 25,
    split: 0.15,
    never: 0.015,
  },
  {
    en: "Emberly Fasteners",
    zh: "恩博紧固件",
    weight: 7,
    terms: 60,
    late: 8,
    spread: 8,
    split: 0.05,
    never: 0.003,
  },
  {
    en: "Faldrow Medical",
    zh: "法卓医疗",
    weight: 10,
    terms: 30,
    late: 70,
    spread: 35,
    split: 0.2,
    never: 0.03,
  },
  {
    en: "Glimmerton Textiles",
    zh: "格曼纺织",
    weight: 8,
    terms: 30,
    late: 18,
    spread: 14,
    split: 0.06,
    never: 0.006,
  },
  {
    en: "Hollowmere Builders",
    zh: "鸿湖建筑",
    weight: 6,
    terms: 60,
    late: 35,
    spread: 30,
    split: 0.25,
    never: 0.02,
  },
  {
    en: "Ivelcourt Media",
    zh: "艺珂传媒",
    weight: 12,
    terms: 30,
    late: 2,
    spread: 4,
    split: 0.03,
    never: 0.002,
  },
  {
    en: "Jasperine Labs",
    zh: "佳珀实验室",
    weight: 5,
    terms: 45,
    late: 95,
    spread: 40,
    split: 0.12,
    never: 0.05,
  },
] as const;

interface Invoice {
  number: string;
  customer: number;
  day: number;
  due: number;
  cents: number;
}

interface Receipt {
  invoice: string;
  day: number;
  cents: number;
}

const code = (customer: number) => `C${101 + customer}`;
const iso = (day: number) => new Date(Date.UTC(2024, 0, 1 + day)).toISOString().slice(0, 10);

/** The customer a draw in [0, total weight) falls on. */
function weighted(draw: number): number {
  let left = draw;
  for (const [index, customer] of CUSTOMERS.entries()) {
    left -= customer.weight;
    if (left < 0) return index;
  }
  return CUSTOMERS.length - 1;
}

function ledger() {
  const next = random(SEED);
  const total = CUSTOMERS.reduce((sum, customer) => sum + customer.weight, 0);
  const invoices: Invoice[] = [];
  const receipts: Receipt[] = [];
  const days = Array.from({ length: INVOICES }, () => between(next, 0, AS_AT)).sort(
    (a, b) => a - b,
  );
  for (const [index, day] of days.entries()) {
    const customer = weighted(next() * total);
    const profile = CUSTOMERS[customer] ?? CUSTOMERS[0];
    const due = day + profile.terms;
    const cents = Math.round(Math.exp(Math.log(20_000) + next() * Math.log(150)));
    const number = `INV${String(240_001 + index)}`;
    invoices.push({ number, customer, day, due, cents });
    if (next() < profile.never) continue;
    const paid = Math.max(day + 3, due + Math.round(profile.late + profile.spread * normal(next)));
    if (next() < profile.split) {
      const first = Math.round(cents * (0.3 + 0.4 * next()));
      receipts.push({ invoice: number, day: paid, cents: first });
      const rest = paid + between(next, 30, 120);
      if (next() < 0.8) receipts.push({ invoice: number, day: rest, cents: cents - first });
    } else {
      receipts.push({ invoice: number, day: paid, cents });
    }
  }
  const kept = receipts.filter((receipt) => receipt.day <= EXPORTED);
  kept.sort((a, b) => a.day - b.day);
  return { invoices, receipts: kept };
}

function inputs(language: TaskLanguage) {
  const { invoices, receipts } = ledger();
  const shown = (text: string) => (language === "zh" ? fullWidth(text) : text);
  const dollars = (cents: number) => round(cents / 100, 2);
  return {
    files: [
      {
        name: NAMES[language].invoices,
        bytes: xlsx([
          {
            name: SHEET[language],
            rows: [
              [...INVOICE_HEADINGS[language]],
              ...invoices.map((invoice) => [
                shown(invoice.number),
                shown(code(invoice.customer)),
                CUSTOMERS[invoice.customer]?.[language] ?? "",
                iso(invoice.day),
                iso(invoice.due),
                dollars(invoice.cents),
              ]),
            ],
          },
        ]),
      },
      {
        name: NAMES[language].payments,
        bytes: utf8(
          csv([
            [...PAYMENT_HEADINGS[language]],
            ...receipts.map((receipt, index) => [
              shown(`R${String(500_001 + index)}`),
              shown(receipt.invoice),
              iso(receipt.day),
              dollars(receipt.cents),
            ]),
          ]),
        ),
      },
    ],
    data: {
      "invoices.csv": csv([
        ["invoice", "customer", "due", "amount"],
        ...invoices.map((invoice) => [
          invoice.number,
          code(invoice.customer),
          iso(invoice.due),
          dollars(invoice.cents),
        ]),
      ]),
      "receipts.csv": csv([
        ["invoice", "date", "amount"],
        ...receipts.map((receipt) => [receipt.invoice, iso(receipt.day), dollars(receipt.cents)]),
      ]),
      "parameters.csv": csv([
        ["name", "value"],
        ["as_at", iso(AS_AT)],
      ]),
    },
  };
}

const bucket = { unit: "plain", tolerance: { abs: 0.01 } } as const;

export const task: Task = {
  id: "F05",
  title: "Receivables ageing",
  needs: ["P"],
  seed: SEED,
  question: {
    en: `${NAMES.en.invoices} lists every invoice to our customers and ${NAMES.en.payments} every receipt against them up to 31 October 2025. Age the receivables as at 30 September 2025. An invoice's balance is its amount less the receipts dated on or before 30 September 2025; its days past due are 30 September 2025 minus its due date. Put each balance in one bucket: 0-30 days (including invoices not yet due), 31-60, 61-90, or over 90 days. Give a table with one row per customer code and the four buckets, and the total outstanding.`,
    zh: `“${NAMES.zh.invoices}”列出了开给客户的每张发票，“${NAMES.zh.payments}”列出了截至 2025 年 10 月 31 日的每笔对应收款。请按 2025 年 9 月 30 日编制应收账款账龄表。每张发票的余额等于发票金额减去 2025 年 9 月 30 日及之前收到的款项；逾期天数等于 2025 年 9 月 30 日减去到期日。每笔余额只归入一个区间：0-30 天（含尚未到期的发票）、31-60 天、61-90 天、90 天以上。请按客户编号每行列出四个区间的金额，并给出应收余额合计。`,
  },
  inputs,
  expect: [
    {
      id: "ageing",
      kind: "rows",
      label: "Each customer's balance in the four buckets",
      key: /\bC1(?:0[1-9]|10)\b/g,
      columns: [
        { id: "days_0_30", ...bucket, heading: /\b0\s*[-–至]\s*30\b|current|未到期/i },
        { id: "days_31_60", ...bucket, heading: /\b31\s*[-–至]\s*60\b/ },
        { id: "days_61_90", ...bucket, heading: /\b61\s*[-–至]\s*90\b/ },
        {
          id: "over_90",
          ...bucket,
          heading: /over\s*90|90\s*\+|>\s*90|91\s*\+|90\s*天以上|超过\s*90|90以上/i,
        },
      ],
    },
    {
      id: "total",
      kind: "number",
      label: "Total outstanding",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /total|合计|总/i,
    },
  ],
  sources: { documents: [NAMES.en.invoices, NAMES.en.payments] },
};
