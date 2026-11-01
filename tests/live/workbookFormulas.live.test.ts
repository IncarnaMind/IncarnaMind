/**
 * A workbook's formulas against a real model (#2347): "what drives 2027
 * EBITDA?" and "what if growth is 3%?", in English and in Chinese, over a
 * test DCF, asked through the core as the app asks. It runs only when
 * INCARNAMIND_LIVE_ANTHROPIC_KEY is set (INCARNAMIND_LIVE_ANTHROPIC_MODEL,
 * Haiku by default), so `npx vitest run` makes no request without one.
 * INCARNAMIND_LIVE_REPORT keeps each Answer, its Tool calls and figures, and
 * the tokens and requests it took.
 */
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { expect, onTestFinished, test } from "vitest";
import type { AnswerUsage, ConversationAnswer, Core } from "../../src/core";

import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { type ChatModelFactory, createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { dcfWorkbook } from "../helpers/financeWorkbooks";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

const QUESTIONS = [
  { question: "In the DCF workbook, what drives 2027 EBITDA?", whatIf: false },
  {
    question: "In the DCF workbook, what would 2027 EBITDA be if revenue growth were 3%?",
    whatIf: true,
  },
  { question: "DCF 工作簿里，2027 年的 EBITDA 由什么驱动？", whatIf: false },
  { question: "DCF 工作簿里，如果收入增长率是 3%，2027 年的 EBITDA 是多少？", whatIf: true },
];

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
  "a real model traces 2027 EBITDA to its assumptions and works out growth at 3%, in English and Chinese",
  { timeout: 1_200_000 },
  async () => {
    const core = startCore(await createTempDataFolder(), { createChatModel: counting });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
    const file = await writeSourceFile(
      await createTempDataFolder(),
      "DCF model.xlsx",
      new Uint8Array(dcfWorkbook().xlsx()),
    );
    await addAndProcess(core, [file]);
    const before = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    const report = [`## Workbook formulas · ${MODEL}`];
    onTestFinished(async () => {
      if (process.env.INCARNAMIND_LIVE_REPORT)
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
    });
    for (const { question, whatIf } of QUESTIONS) {
      const from = requests;
      const { answer, usage } = await ask(core, question);
      report.push(
        `### ${question}`,
        `${answer.status}; ${requests - from} requests; input ${usage?.inputTokens} (cache reads ${usage?.cachedInputTokens}, cache writes ${usage?.cacheWriteTokens}), output ${usage?.outputTokens}`,
        `Tools: ${answer.toolCalls.map((call) => `${call.tool} ${JSON.stringify(call.input)}`).join("; ")}`,
        `> ${answer.text.replace(/\s+/g, " ")}`,
        ...answer.figures.map(
          (figure) =>
            `- [=${figure.marker}] ${figure.shown}: ${figure.label}${figure.workbook ? ` (${figure.workbook.cell.sheet}!${figure.workbook.cell.ref} = ${figure.workbook.cell.formula}${figure.workbook.change ? `; ${figure.workbook.change.input} → ${figure.workbook.change.shown}` : ""}; ${figure.inputs.length} inputs cited${figure.workbook.kept.length > 0 ? `; kept ${figure.workbook.kept.length}` : ""})` : ` = ${figure.formula}`}`,
        ),
        "",
      );
      expect(answer.status, answer.errorMessage ?? "").toBe("done");
      const fromWorkbook = answer.figures.filter((figure) => figure.workbook);
      expect(fromWorkbook.length).toBeGreaterThan(0);
      if (whatIf)
        expect(
          fromWorkbook.some(
            (figure) =>
              figure.workbook?.change?.value === 0.03 &&
              Math.abs((figure.value as number) - 240.39994) < 1e-6,
          ),
        ).toBe(true);
    }
    expect(
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    ).toBe(before);
  },
);
