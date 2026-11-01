/**
 * A workbook's formulas against a real model (#2347, #2372), through the core as the app asks, in
 * English and Chinese. "training": the Questions the Tools' wording was tuned on (a DCF, an LBO,
 * three statements and a SaaS plan, and the store budget #2347 held out, looked at since).
 * "held out": a rental property's Questions, written for #2372 by someone who hadn't read that
 * wording and committed before any run (./../helpers/rentalHeldOut), so its count is the one to
 * trust. Each passes only when the Answer records the figure from the right cell and, for a
 * what-if, with the workbook's own result. It runs only when INCARNAMIND_LIVE_ANTHROPIC_KEY is set
 * (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default), so `npx vitest run` makes no request
 * without one; pick a set with `-t`. INCARNAMIND_LIVE_REPORT keeps each Answer, its Tool calls and
 * figures, and every request's tokens and price. INCARNAMIND_LIVE_MAX_USD stops asking once a set
 * has cost that much; the Questions not asked count as missed.
 */
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { expect, onTestFinished, test } from "vitest";
import type { ConversationAnswer, Core, MarkedFigure } from "../../src/core";

import { costOf } from "../../src/core/cost/price";
import { catalogModel } from "../../src/core/providers/catalog";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { type ChatModelFactory, createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { saasWorkbook, storeBudgetWorkbook } from "../helpers/financeWorkbooks";
import { RENTAL_HELD_OUT, rentalPropertyWorkbook, savedNumber } from "../helpers/rentalHeldOut";
import { libreOfficeFixture } from "../helpers/workbookFixtures";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

/** A figure that answers a Question: its cell, and for a what-if the input's new value and LibreOffice's result. */
interface Accepted {
  cell: string;
  change: { value: number; result: number } | null;
}

interface Asked extends Accepted {
  question: string;
  /** Other figures that answer it as well, where the Question can be read more than one way. */
  also?: Accepted[];
}

const TRAINING: Asked[] = [
  { question: "In the DCF workbook, what drives 2027 EBITDA?", cell: "DCF!E5", change: null },
  {
    question: "In the DCF workbook, what would 2027 EBITDA be if revenue growth were 3%?",
    cell: "DCF!E5",
    change: { value: 0.03, result: 240.39994 },
  },
  { question: "DCF 工作簿里，2027 年的 EBITDA 由什么驱动？", cell: "DCF!E5", change: null },
  {
    question: "DCF 工作簿里，如果收入增长率是 3%，2027 年的 EBITDA 是多少？",
    cell: "DCF!E5",
    change: { value: 0.03, result: 240.39994 },
  },
  {
    question: "Which assumptions does the sponsor's IRR in the LBO model rest on?",
    cell: "LBO!B32",
    change: null,
  },
  {
    question:
      "Say the LBO exits at 9.5 times EBITDA rather than the multiple it assumes now. What IRR does the sponsor make then?",
    cell: "LBO!B32",
    change: { value: 9.5, result: 0.273191900020312 },
  },
  {
    question: "三表模型里，2027 年的净利润是怎么算出来的？取决于哪些假设？",
    cell: "IS!E13",
    change: null,
  },
  {
    question: "三表模型中，假如税率调到 25%，2027 年的净利润会变成多少？",
    cell: "IS!E13",
    change: { value: 0.25, result: 245.532546 },
  },
  {
    question: "How is the LBO's MOIC worked out, and from which inputs?",
    cell: "LBO!B30",
    change: null,
  },
  {
    question: "What would the LBO's term loan payment be if the interest rate were 7%?",
    cell: "LBO!B34",
    change: { value: 0.07, result: 121.945347220687 },
  },
  { question: "三表模型中，2027 年末的现金余额取决于什么？", cell: "BS!E3", change: null },
  {
    question: "如果 2026 年的收入增长率是 10%，三表模型里 2027 年末的现金是多少？",
    cell: "BS!E3",
    change: { value: 0.1, result: 638.780540832877 },
  },

  { question: "In the SaaS plan, what is the ARR built from?", cell: "Plan!B9", change: null },
  { question: "Why is December's MRR in the SaaS plan what it is?", cell: "Plan!M6", change: null },
  { question: "SaaS 计划里，12 月的客户数取决于哪些假设？", cell: "Plan!M4", change: null },
  { question: "SaaS 计划中的年收入是怎么算出来的？", cell: "Plan!B10", change: null },
  {
    question: "If monthly churn in the SaaS plan were 1.5%, what would ARR be?",
    cell: "Plan!B9",
    change: { value: 0.015, result: 6109304.67997897 },
  },
  {
    question: "SaaS 计划里，如果每个席位的价格是 50 美元，年收入会是多少？",
    cell: "Plan!B10",
    change: { value: 50, result: 5389161.29234364 },
  },
];

const MONTH_COLUMNS = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];

/** #2347's held-out store budget, training since #2372 looked at its misses. */
const STORE_BUDGET: Asked[] = [
  { question: "What feeds into December's gross margin?", cell: "Budget!M6", change: null },
  {
    question: "Which inputs move the 2027 operating profit the most?",
    cell: "Budget!N11",
    change: null,
  },
  {
    question: "Where does the rent figure in the budget come from?",
    cell: "Budget!N8",
    change: null,
    also: MONTH_COLUMNS.map((column) => ({ cell: `Budget!${column}8`, change: null })),
  },
  {
    question: "If headcount were 12 instead of 10, what would payroll be?",
    cell: "Budget!N7",
    change: { value: 12, result: 460800 },
    also: MONTH_COLUMNS.map((column) => ({
      cell: `Budget!${column}7`,
      change: { value: 12, result: 38400 },
    })),
  },
  {
    question: "Trace the cash balance at year end back to its assumptions.",
    cell: "Budget!M12",
    change: null,
  },
  { question: "十二月的毛利是由哪些数字算出来的？", cell: "Budget!M6", change: null },
  { question: "年度营业利润主要受哪些假设影响？", cell: "Budget!N11", change: null },
  {
    // Read as the monthly increase, or as each month's rent 5% higher.
    question: "如果租金每月涨5%，全年费用会变成多少？",
    cell: "Budget!N10",
    change: { value: 0.05, result: 589337.012163541 },
    also: [{ cell: "Budget!N10", change: { value: 8400, result: 562800 } }],
  },
];

/** The held-out rental property's Questions, each `also` cell's what-if worked out as its own is. */
const HELD_OUT: Asked[] = RENTAL_HELD_OUT.map(({ question, cell, change, also }) => ({
  question,
  cell,
  change: change && { value: change.value, result: change.result },
  ...(also && {
    also: also.map((other) => ({
      cell: other,
      change: change && {
        value: change.value,
        result: savedNumber(rentalPropertyWorkbook({ [change.input]: change.value }), other),
      },
    })),
  }),
}));

/** Whether an Answer gives the Question's figure from its cell, and a what-if with LibreOffice's result. */
const answersAs = (figure: MarkedFigure, expected: Accepted): boolean => {
  const book = figure.workbook;
  if (!book || `${book.cell.sheet}!${book.cell.ref}` !== expected.cell) return false;
  if (!expected.change) return book.change === null;
  return (
    book.change?.value === expected.change.value &&
    Math.abs((figure.value as number) - expected.change.result) <=
      1e-9 * Math.abs(expected.change.result)
  );
};
const answers = (figure: MarkedFigure, expected: Asked): boolean =>
  [expected, ...(expected.also ?? [])].some((each) => answersAs(figure, each));

/** What one request was billed for, as its provider reported it. */
interface Billed {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface ReportedUsage {
  inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: { total?: number };
}

const billedOf = (usage: ReportedUsage | undefined): Billed => ({
  input: usage?.inputTokens?.total ?? 0,
  cacheRead: usage?.inputTokens?.cacheRead ?? 0,
  cacheWrite: usage?.inputTokens?.cacheWrite ?? 0,
  output: usage?.outputTokens?.total ?? 0,
});

const PRICE = catalogModel("anthropic", MODEL)?.price;

const MAX_USD = Number(process.env.INCARNAMIND_LIVE_MAX_USD ?? Number.POSITIVE_INFINITY);
if (Number.isNaN(MAX_USD)) throw new Error("INCARNAMIND_LIVE_MAX_USD must be a number of dollars.");
if (MAX_USD !== Number.POSITIVE_INFINITY && !PRICE)
  throw new Error(`INCARNAMIND_LIVE_MAX_USD needs a model the catalog prices; ${MODEL} isn't.`);

/** A request's price at its own prompt's tier (src/core/cost/price.ts). */
const priced = (each: Billed): number =>
  PRICE
    ? costOf(
        {
          inputTokens: each.input,
          cachedInputTokens: each.cacheRead,
          cacheWriteTokens: each.cacheWrite,
          outputTokens: each.output,
        },
        PRICE,
        new Date(),
        { cacheWrites: true },
      )
    : Number.NaN;

const tokensLine = (list: readonly Billed[]): string => {
  const sum = (key: keyof Billed) => list.reduce((total, each) => total + each[key], 0);
  const uncached = sum("input") - sum("cacheRead") - sum("cacheWrite");
  const largest = Math.max(0, ...list.map((each) => each.input));
  const cost = list.reduce((total, each) => total + priced(each), 0);
  return `${list.length} requests; uncached input ${uncached}, cache reads ${sum("cacheRead")}, cache writes ${sum("cacheWrite")}, output ${sum("output")}; largest prompt ${largest}; $${cost.toFixed(4)}`;
};

/** Every request the real model made, with what it was billed for once it finished. */
const billed: Billed[] = [];
const counting: ChatModelFactory = (spec) => {
  const model = createAiSdkChatModel(spec);
  return new Proxy(model, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "doGenerate" && typeof value === "function")
        return async (...args: unknown[]) => {
          const result = (await value.apply(target, args)) as { usage?: ReportedUsage };
          billed.push(billedOf(result.usage));
          return result;
        };
      if (property === "doStream" && typeof value === "function")
        return async (...args: unknown[]) => {
          const result = (await value.apply(target, args)) as {
            stream: ReadableStream<{ type: string; usage?: ReportedUsage }>;
          };
          const [given, read] = result.stream.tee();
          const entry = billedOf(undefined);
          billed.push(entry);
          void (async () => {
            const reader = read.getReader();
            for (let part = await reader.read(); !part.done; part = await reader.read())
              if (part.value.type === "finish") Object.assign(entry, billedOf(part.value.usage));
          })();
          return { ...result, stream: given };
        };
      return value;
    },
  });
};

async function ask(core: Core, text: string): Promise<{ answer: ConversationAnswer }> {
  const result = await core.askInConversation({ text });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => {
    const stops = [
      core.on("answer.finished", (finished) => {
        if (finished.answerId !== result.answerId) return;
        done();
      }),
      core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done()),
    ];
    function done() {
      for (const stop of stops) stop();
      resolve();
    }
  });
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return { answer };
}

test.skipIf(KEY === undefined).each([
  {
    set: "training, four models",
    asked: TRAINING,
    files: () => [
      { name: "DCF model.xlsx", contents: libreOfficeFixture("dcf") },
      { name: "LBO model.xlsx", contents: libreOfficeFixture("lbo") },
      { name: "Three statements.xlsx", contents: libreOfficeFixture("three-statements") },
      { name: "SaaS plan.xlsx", contents: new Uint8Array(saasWorkbook().xlsx()) },
    ],
  },
  {
    set: "training, store budget",
    asked: STORE_BUDGET,
    files: () => [
      { name: "Store budget.xlsx", contents: new Uint8Array(storeBudgetWorkbook().xlsx()) },
    ],
  },
  {
    set: "held out",
    asked: HELD_OUT,
    files: () => [
      { name: "Rental property.xlsx", contents: new Uint8Array(rentalPropertyWorkbook().xlsx()) },
    ],
  },
])(
  "$set: a real model traces each figure to its assumptions and works out a what-if from the workbook",
  { timeout: 1_800_000 },
  async ({ set, asked, files }) => {
    const core = startCore(await createTempDataFolder(), { createChatModel: counting });
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
    const folder = await createTempDataFolder();
    const paths = await Promise.all(
      files().map((file) => writeSourceFile(folder, file.name, file.contents)),
    );
    await addAndProcess(core, paths);
    const hashes = async () =>
      Promise.all(
        paths.map(async (path) =>
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        ),
      );
    const before = await hashes();
    const report = [`## Workbook formulas, ${set} · ${MODEL}`];
    onTestFinished(async () => {
      if (process.env.INCARNAMIND_LIVE_REPORT)
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
    });
    const missed: string[] = [];
    const from = billed.length;
    const spent = () => billed.slice(from).reduce((total, each) => total + priced(each), 0);
    for (const expected of asked) {
      if (spent() > MAX_USD) {
        missed.push(expected.question);
        report.push(
          `### ${expected.question}`,
          "not asked: the set's spending limit was reached",
          "",
        );
        continue;
      }
      const first = billed.length;
      const { answer } = await ask(core, expected.question);
      const passed =
        answer.status === "done" && answer.figures.some((figure) => answers(figure, expected));
      if (!passed) missed.push(expected.question);
      report.push(
        `### ${expected.question}`,
        `${passed ? "passed" : "missed"}; ${answer.status}; ${tokensLine(billed.slice(first))}`,
        `Tools: ${answer.toolCalls.map((call) => `${call.tool} ${JSON.stringify(call.input)}`).join("; ")}`,
        `> ${answer.text.replace(/\s+/g, " ")}`,
        ...answer.figures.map(
          (figure) =>
            `- [=${figure.marker}] ${figure.shown}: ${figure.label}${figure.workbook ? ` (${figure.workbook.cell.sheet}!${figure.workbook.cell.ref} = ${figure.workbook.cell.formula}${figure.workbook.change ? `; ${figure.workbook.change.input} → ${figure.workbook.change.shown}` : ""}; ${figure.inputs.length} inputs cited${figure.workbook.kept.length > 0 ? `; kept ${figure.workbook.kept.length}` : ""})` : ` = ${figure.formula}`}`,
        ),
        "",
      );
    }
    report.push(
      `${asked.length - missed.length} of ${asked.length} passed.`,
      `All: ${tokensLine(billed.slice(from))}`,
    );
    expect(missed).toEqual([]);
    expect(await hashes()).toEqual(before);
  },
);
