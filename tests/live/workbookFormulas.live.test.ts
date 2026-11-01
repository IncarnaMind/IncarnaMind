/**
 * A workbook's formulas against a real model (#2347), on Questions held out
 * from everything the Tools and their steer were written against: an LBO's
 * IRR and three statements' net income, asked in other words, in English and
 * in Chinese, through the core as the app asks. It runs only when
 * INCARNAMIND_LIVE_ANTHROPIC_KEY is set (INCARNAMIND_LIVE_ANTHROPIC_MODEL,
 * Haiku by default), so `npx vitest run` makes no request without one.
 * INCARNAMIND_LIVE_REPORT keeps each Answer, its Tool calls and figures, and
 * the tokens and requests it took.
 */
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { expect, onTestFinished, test } from "vitest";
import type { AnswerUsage, ConversationAnswer, Core, MarkedFigure } from "../../src/core";

import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { type ChatModelFactory, createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { libreOfficeFixture } from "../helpers/financeWorkbooks";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

/** Each Question, the cell its figure is, and for a what-if the input's new value and LibreOffice's result. */
const QUESTIONS: {
  question: string;
  cell: string;
  change: { value: number; result: number } | null;
}[] = [
  {
    question: "Which assumptions does the sponsor's IRR in the LBO model rest on?",
    cell: "LBO!B32",
    change: null,
  },
  {
    question:
      "Say the LBO exits at 9.5 times EBITDA rather than the multiple it assumes now. What IRR does the sponsor make then?",
    cell: "LBO!B32",
    change: { value: 9.5, result: 0.2731919000203173 },
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
];

/** Whether an Answer gives the Question's figure from its cell, and a what-if with LibreOffice's result. */
const answers = (figure: MarkedFigure, expected: (typeof QUESTIONS)[number]): boolean => {
  const book = figure.workbook;
  if (!book || `${book.cell.sheet}!${book.cell.ref}` !== expected.cell) return false;
  if (!expected.change) return book.change === null;
  return (
    book.change?.value === expected.change.value &&
    Math.abs((figure.value as number) - expected.change.result) <=
      1e-9 * Math.abs(expected.change.result)
  );
};

let requests = 0;
/** The real model, counting each request it makes. */
const counting: ChatModelFactory = (spec) => {
  const model = createAiSdkChatModel(spec);
  return new Proxy(model, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === "doStream" || property === "doGenerate") && typeof value === "function")
        return (...args: unknown[]) => {
          requests++;
          return value.apply(target, args);
        };
      return value;
    },
  });
};

async function ask(
  core: Core,
  text: string,
): Promise<{ answer: ConversationAnswer; usage: AnswerUsage | null }> {
  const result = await core.askInConversation({ text });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  let usage: AnswerUsage | null = null;
  await new Promise<void>((resolve) => {
    const stops = [
      core.on("answer.finished", (finished) => {
        if (finished.answerId !== result.answerId) return;
        usage = finished.usage;
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
  return { answer, usage };
}

test.skipIf(KEY === undefined)(
  "a real model traces an LBO's IRR and three statements' net income to their assumptions, and works out a what-if on each, in English and Chinese",
  { timeout: 1_200_000 },
  async () => {
    const core = startCore(await createTempDataFolder(), { createChatModel: counting });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
    const folder = await createTempDataFolder();
    const files = [
      await writeSourceFile(folder, "LBO model.xlsx", libreOfficeFixture("lbo")),
      await writeSourceFile(
        folder,
        "Three statements.xlsx",
        libreOfficeFixture("three-statements"),
      ),
    ];
    await addAndProcess(core, files);
    const hashes = async () =>
      Promise.all(
        files.map(async (file) =>
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        ),
      );
    const before = await hashes();
    const report = [`## Workbook formulas, held-out Questions · ${MODEL}`];
    onTestFinished(async () => {
      if (process.env.INCARNAMIND_LIVE_REPORT)
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
    });
    const missed: string[] = [];
    for (const expected of QUESTIONS) {
      const from = requests;
      const { answer, usage } = await ask(core, expected.question);
      const passed =
        answer.status === "done" && answer.figures.some((figure) => answers(figure, expected));
      if (!passed) missed.push(expected.question);
      report.push(
        `### ${expected.question}`,
        `${passed ? "passed" : "missed"}; ${answer.status}; ${requests - from} requests; input ${usage?.inputTokens} (cache reads ${usage?.cachedInputTokens}, cache writes ${usage?.cacheWriteTokens}), output ${usage?.outputTokens}`,
        `Tools: ${answer.toolCalls.map((call) => `${call.tool} ${JSON.stringify(call.input)}`).join("; ")}`,
        `> ${answer.text.replace(/\s+/g, " ")}`,
        ...answer.figures.map(
          (figure) =>
            `- [=${figure.marker}] ${figure.shown}: ${figure.label}${figure.workbook ? ` (${figure.workbook.cell.sheet}!${figure.workbook.cell.ref} = ${figure.workbook.cell.formula}${figure.workbook.change ? `; ${figure.workbook.change.input} → ${figure.workbook.change.shown}` : ""}; ${figure.inputs.length} inputs cited${figure.workbook.kept.length > 0 ? `; kept ${figure.workbook.kept.length}` : ""})` : ` = ${figure.formula}`}`,
        ),
        "",
      );
    }
    expect(missed).toEqual([]);
    expect(await hashes()).toEqual(before);
  },
);
