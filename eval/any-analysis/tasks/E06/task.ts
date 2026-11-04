import { between, csv, fullWidth, random, round, xlsx } from "../../inputs";
import type { Task, TaskLanguage } from "../../task";

const SEED = 206;
const NAMES = { en: "Orders and customers 2025.xlsx", zh: "2025年订单与客户.xlsx" } as const;
const SHEETS = { en: ["Orders", "Customers"], zh: ["订单", "客户"] } as const;
const HEADINGS = {
  orders: {
    en: ["Order", "Order date", "Customer ID", "Amount"],
    zh: ["订单号", "下单日期", "客户编号", "金额"],
  },
  customers: {
    en: ["Customer ID", "Customer", "Segment"],
    zh: ["客户编号", "客户名称", "客户类型"],
  },
} as const;
const SEGMENTS = { en: ["Retail", "Wholesale", "Online"], zh: ["零售", "批发", "线上"] } as const;
/** Made-up customer names from syllables, in each language's own script. */
const FIRST = {
  en: [
    "Varn",
    "Quel",
    "Ostr",
    "Brim",
    "Tull",
    "Hesk",
    "Mor",
    "Calv",
    "Dren",
    "Ilsa",
    "Pell",
    "Yarr",
  ],
  zh: ["瓦", "奎", "奥", "布", "图", "赫", "莫", "卡", "德", "伊", "佩", "亚"],
} as const;
const LAST = {
  en: ["ell", "ane", "ick", "ow", "ston", "ard", "ley", "mont", "ith", "worth"],
  zh: ["尔", "安", "克", "欧", "斯", "朗", "利", "蒙", "思", "沃"],
} as const;
const KINDS = {
  en: ["Trading", "Supplies", "& Co", "Goods", "Partners"],
  zh: ["贸易", "供应", "商行", "百货", "合伙"],
} as const;

const ORDERS = 12_000;
const CUSTOMERS = 2_995;
/** Customers entered a second time under the same ID, written differently: the duplicates. */
const DUPLICATED = 5;
/** Orders whose customer ID is in no row of Customers, however it is written. */
const ORPHANS = 23;

/** An ID as a person typed it: now and then with a stray space, or in lower or mixed case. */
function typed(id: string, next: () => number, messy: number): string {
  const draw = next();
  if (draw < messy * 0.4) return `${id} `;
  if (draw < messy * 0.6) return ` ${id}`;
  if (draw < messy * 0.85) return id.toLowerCase();
  if (draw < messy) return `${id.slice(0, 1)}${id.slice(1).toLowerCase()}`;
  return id;
}

function tables() {
  const next = random(SEED);
  const ids = Array.from(
    { length: CUSTOMERS },
    (_, index) => `CU-${String(10_001 + index * 3).padStart(5, "0")}`,
  );
  const customers = ids.map((id) => ({
    id: typed(id, next, 0.05),
    first: between(next, 0, FIRST.en.length - 1),
    last: between(next, 0, LAST.en.length - 1),
    kind: between(next, 0, KINDS.en.length - 1),
    segment: between(next, 0, SEGMENTS.en.length - 1),
  }));
  const picked = new Set<number>();
  while (picked.size < DUPLICATED) picked.add(between(next, 0, CUSTOMERS - 1));
  for (const index of picked) {
    const original = customers[index];
    if (!original) continue;
    const id = original.id.trim();
    const variant = original.id === id ? (next() < 0.5 ? `${id} ` : id.toLowerCase()) : id;
    customers.splice(between(next, 0, customers.length), 0, { ...original, id: variant });
  }
  const days = Array.from({ length: ORDERS }, () => between(next, 0, 364)).sort((a, b) => a - b);
  const orders = days.map((day, index) => {
    const id = ids[between(next, 0, CUSTOMERS - 1)] ?? "";
    return {
      order: `SO-${String(500_001 + index)}`,
      day,
      customer: typed(id, next, 0.14),
      amount: round(Math.exp(Math.log(250) + next() * Math.log(80)), 2),
    };
  });
  const orphaned = new Set<number>();
  while (orphaned.size < ORPHANS) orphaned.add(between(next, 0, ORDERS - 1));
  for (const [index, place] of [...orphaned].entries()) {
    const order = orders[place];
    if (order) order.customer = typed(`CU-${String(20_002 + index * 7)}`, next, 0.14);
  }
  return { customers, orders };
}

const iso = (day: number) => new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10);

function inputs(language: TaskLanguage) {
  const { customers, orders } = tables();
  const shown = (text: string) => (language === "zh" ? fullWidth(text) : text);
  const name = (customer: (typeof customers)[number]) =>
    language === "zh"
      ? `${FIRST.zh[customer.first]}${LAST.zh[customer.last]}${KINDS.zh[customer.kind]}`
      : `${FIRST.en[customer.first]}${LAST.en[customer.last]} ${KINDS.en[customer.kind]}`;
  return {
    files: [
      {
        name: NAMES[language],
        bytes: xlsx([
          {
            name: SHEETS[language][0],
            rows: [
              [...HEADINGS.orders[language]],
              ...orders.map((order) => [
                shown(order.order),
                iso(order.day),
                shown(order.customer),
                order.amount,
              ]),
            ],
          },
          {
            name: SHEETS[language][1],
            rows: [
              [...HEADINGS.customers[language]],
              ...customers.map((customer) => [
                shown(customer.id),
                name(customer),
                SEGMENTS[language][customer.segment] ?? "",
              ]),
            ],
          },
        ]),
      },
    ],
    data: {
      "orders.csv": csv([
        ["order", "customer", "amount"],
        ...orders.map((order) => [order.order, order.customer, order.amount]),
      ]),
      "customers.csv": csv([
        ["sheet_row", "customer"],
        ...customers.map((customer, index) => [index + 2, customer.id]),
      ]),
    },
  };
}

const sheetRow = { unit: "plain", tolerance: { abs: 0 } } as const;

export const task: Task = {
  id: "E06",
  title: "Join on untidy keys",
  needs: ["P"],
  seed: SEED,
  question: {
    en: `${NAMES.en} has an Orders sheet and a Customers sheet. Join each order to its customer on Customer ID, after trimming spaces and ignoring upper and lower case. First, list every Customer ID that appears on more than one row of Customers, with the sheet rows it is on (row 1 is the heading); for the join keep the first of those rows. How many orders join to a customer? How many orders have no customer, and what is their total amount?`,
    zh: `“${NAMES.zh}”中有“订单”和“客户”两张表。请按客户编号把每个订单关联到客户：先去掉首尾空格，并且不区分大小写。首先，列出在“客户”表中出现在多行的每个客户编号，以及它所在的行号（第 1 行是表头）；关联时只保留其中的第一行。有多少个订单关联到了客户？有多少个订单找不到客户，这些订单的金额合计是多少？`,
  },
  inputs,
  expect: [
    {
      id: "duplicates",
      kind: "rows",
      label: "Each Customer ID on more than one row, with its rows",
      key: /\bCU-\d{5}\b/gi,
      columns: [
        { id: "first_row", ...sheetRow },
        { id: "second_row", ...sheetRow },
      ],
    },
    {
      id: "joined",
      kind: "number",
      label: "Orders joined to a customer",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /join|match|关联|匹配/i,
    },
    {
      id: "orphan_count",
      kind: "number",
      label: "Orders with no customer",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /no customer|orphan|unmatched|without|找不到|没有|未关联|孤立/i,
    },
    {
      id: "orphan_amount",
      kind: "number",
      label: "Total amount of the orders with no customer",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /amount|total|sum|金额|合计/i,
    },
  ],
  sources: { documents: [NAMES.en] },
};
