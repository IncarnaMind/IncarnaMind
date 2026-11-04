/**
 * What a real model does when run_code can't get Python (#2351), held out: written before the
 * words the model reads were measured, and never tuned on. Each case makes Python fail one way,
 * on Documents of its own, and asks in English and Chinese. Counted per case: run_code calls in
 * Python after the first that couldn't get it (each tries the download and the import again), the
 * Tools it went to instead, the numbers its reply typed, and whether the reply gives a reason the
 * failure doesn't (a file it says is fine, a reason of another kind).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dcfWorkbook } from "../../tests/helpers/financeWorkbooks";
import type { EvalDocument } from "../lib/evaluationSet";

/** How Python couldn't be had: as `EmbeddingModelError["kind"]` names it. */
export type Failure = "load" | "network" | "integrity" | "storage";

export type FailureDocuments = "small-sheet" | "log" | "workbook" | "broken-sheet";

export interface FailureCase {
  id: string;
  language: "en" | "zh-CN";
  failure: Failure;
  documents: FailureDocuments;
  question: string;
  /** The right total, where the question asks one. */
  total?: number;
  /** The right count, where the question asks one. */
  count?: number;
}

const ROWS = 40;

/** The small sheet's amounts: 40 rows, an Analysis in Pyodide reads all of them. */
const amount = (row: number) => ((row * 37) % 100) + 0.25;

const SMALL_SHEET = [
  "order,region,amount",
  ...Array.from(
    { length: ROWS },
    (_, row) => `${1001 + row},${["North", "South"][row % 2]},${amount(row)}`,
  ),
  "",
].join("\n");

const SMALL_TOTAL = Array.from({ length: ROWS }, (_, row) => amount(row)).reduce(
  (a, b) => a + b,
  0,
);

/** An application log with an ERROR line every 53rd line, 3,000 lines. */
function serverLog(): string {
  const lines: string[] = [];
  for (let at = 0; at < 3_000; at++) {
    const minute = String(at % 60).padStart(2, "0");
    lines.push(
      at % 53 === 0
        ? `2026-10-01 10:${minute} ERROR upstream timeout after 30s`
        : `2026-10-01 10:${minute} INFO request done`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const ERRORS = Math.ceil(3_000 / 53);

/** A sheet that is broken for real: rows with too many and too few fields, and a quote never closed. */
const BROKEN_SHEET = [
  "order,region,amount",
  "1001,North,12.5",
  "1002,South,7,extra,fields",
  "1003",
  '1004,"East,9.75',
  "1005,West,11",
  "",
].join("\n");

export const FAILURE_CASES: readonly FailureCase[] = [
  {
    id: "load-sheet",
    language: "en",
    failure: "load",
    documents: "small-sheet",
    question: "Using code on the whole file, what do the amounts in orders.csv add up to?",
    total: SMALL_TOTAL,
  },
  {
    id: "load-sheet",
    language: "zh-CN",
    failure: "load",
    documents: "small-sheet",
    question: "用代码处理整个文件，orders.csv 里的金额加起来是多少？",
    total: SMALL_TOTAL,
  },
  {
    id: "load-log",
    language: "en",
    failure: "load",
    documents: "log",
    question: "How many errors are in server.log?",
    count: ERRORS,
  },
  {
    id: "load-log",
    language: "zh-CN",
    failure: "load",
    documents: "log",
    question: "server.log 里有多少条错误？",
    count: ERRORS,
  },
  {
    id: "offline-workbook",
    language: "en",
    failure: "network",
    documents: "workbook",
    question:
      "Open dcf.xlsx itself and tell me which cells its enterprise value is worked out from.",
  },
  {
    id: "offline-workbook",
    language: "zh-CN",
    failure: "network",
    documents: "workbook",
    question: "直接打开 dcf.xlsx 文件，告诉我企业价值是由哪些单元格算出来的。",
  },
  {
    id: "load-broken-sheet",
    language: "en",
    failure: "load",
    documents: "broken-sheet",
    question:
      "Run code over broken.csv: does every row read cleanly, and what is the amount total?",
  },
  {
    id: "load-broken-sheet",
    language: "zh-CN",
    failure: "load",
    documents: "broken-sheet",
    question: "用代码检查 broken.csv：每一行都能正常读取吗？金额合计是多少？",
  },
  {
    id: "integrity-log",
    language: "en",
    failure: "integrity",
    documents: "log",
    question: "Count the ERROR lines in server.log with a Python script.",
    count: ERRORS,
  },
  {
    id: "integrity-log",
    language: "zh-CN",
    failure: "integrity",
    documents: "log",
    question: "用 Python 脚本数一下 server.log 里的 ERROR 行。",
    count: ERRORS,
  },
  {
    id: "storage-log",
    language: "en",
    failure: "storage",
    documents: "log",
    question: "Write a Python script that counts the ERROR lines in server.log.",
    count: ERRORS,
  },
  {
    id: "storage-log",
    language: "zh-CN",
    failure: "storage",
    documents: "log",
    question: "写一个 Python 脚本，统计 server.log 中的 ERROR 行数。",
    count: ERRORS,
  },
];

export async function writeFailureDocuments(
  folder: string,
  set: FailureDocuments,
): Promise<EvalDocument[]> {
  const files: [string, string | Buffer][] =
    set === "small-sheet"
      ? [["orders.csv", SMALL_SHEET]]
      : set === "log"
        ? [["server.log.txt", serverLog()]]
        : set === "workbook"
          ? [["dcf.xlsx", dcfWorkbook().xlsx()]]
          : [["broken.csv", BROKEN_SHEET]];
  const documents: EvalDocument[] = [];
  for (const [name, contents] of files) {
    const path = join(folder, name);
    await writeFile(path, contents);
    documents.push({ key: name, path });
  }
  return documents;
}
