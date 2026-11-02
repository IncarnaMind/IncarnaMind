import { between, csv, fullWidth, random } from "../../inputs";
import type { Task, TaskLanguage } from "../../task";

const NAMES = { en: "Store takings October.csv", zh: "10月门店营业额.csv" } as const;
const HEADINGS = {
  en: ["Date", "Store", "Takings (CNY)"],
  zh: ["日期", "门店", "营业额（元）"],
} as const;
const STORES = ["朝阳门店", "望京门店", "国贸门店", "中关村门店", "五道口门店", "西单门店"];
const ROWS = 310;

/** GBK's bytes for each character, from Node's own GBK decoder run over every two-byte code. */
function gbkEncoder(): (text: string) => Uint8Array {
  const decoder = new TextDecoder("gbk");
  const codes = new Map<string, readonly [number, number]>();
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      const char = decoder.decode(new Uint8Array([lead, trail]));
      if (char.length === 1 && char !== "�" && !codes.has(char)) codes.set(char, [lead, trail]);
    }
  }
  return (text) => {
    const bytes: number[] = [];
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x80) bytes.push(code);
      else {
        const pair = codes.get(char);
        if (!pair) throw new Error(`GBK has no ${char}.`);
        bytes.push(...pair);
      }
    }
    return new Uint8Array(bytes);
  };
}

/**
 * How each amount is written, as tills and hand-typed sheets mix them: plain, with thousands
 * commas, with full-width digits, with a full-width comma, with a yuan sign and with spaces
 * around it. None of them is ambiguous about its decimal point.
 */
const FORMATS: readonly ((cents: number) => string)[] = [
  (cents) => (cents / 100).toFixed(2),
  (cents) => (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }),
  (cents) => fullWidth((cents / 100).toFixed(2)),
  (cents) => fullWidth((cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })),
  (cents) => `￥${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
  (cents) => ` ${(cents / 100).toFixed(2)} `,
];

function takings() {
  const next = random(5601);
  return Array.from({ length: ROWS }, (_, index) => ({
    day: (index % 31) + 1,
    store: STORES[index % STORES.length] ?? "朝阳门店",
    cents: between(next, 180_000, 2_400_000),
    format: between(next, 0, FORMATS.length - 1),
  }));
}

function inputs(language: TaskLanguage) {
  const rows = takings();
  const encode = gbkEncoder();
  const text = csv([
    [...HEADINGS[language]],
    ...rows.map((row) => [
      `2026-10-${String(row.day).padStart(2, "0")}`,
      row.store,
      (FORMATS[row.format] ?? FORMATS[0])?.(row.cents) ?? "",
    ]),
  ]);
  return {
    files: [{ name: NAMES[language], bytes: encode(text) }],
    data: {
      "takings.csv": csv([["cents", "format"], ...rows.map((row) => [row.cents, row.format])]),
    },
  };
}

export const task: Task = {
  id: "L06",
  title: "A GBK file with full-width digits",
  needs: ["P"],
  seed: 5601,
  question: {
    en: "Store takings October.csv is an export from our tills: one row per store per day, with the takings in yuan. Some amounts were typed with full-width digits, thousands separators or a yuan sign. What is the total takings and how many rows are there? List what you had to normalise to add the amounts up.",
    zh: "《10月门店营业额.csv》是收银系统导出的数据：每家门店每天一行，营业额单位是元。有些金额是用全角数字、千分位分隔符或人民币符号录入的。营业额合计是多少？一共有多少行？请列出为了相加金额做了哪些规范化处理。",
  },
  inputs,
  expect: [
    {
      id: "total",
      kind: "number",
      label: "Total takings",
      unit: "plain",
      tolerance: { abs: 0.005 },
      near: /total|sum|合计|总计|总额/i,
    },
    {
      id: "rows",
      kind: "number",
      label: "Rows",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /rows?|records?|entries|count|行|条/i,
    },
    {
      id: "full_width",
      kind: "mention",
      label: "Says full-width digits were normalised",
      match: /full[- ]width|全角/i,
    },
  ],
  sources: { documents: [NAMES.en] },
};
