/**
 * A number an Answer types that its code printed (#2351) reaches the User as a figure calculated
 * by code and not checked, as a `result()` figure does, in the Answer and in what it writes into a
 * Note; a number its Citation quotes stays the Citation's, and one that matches nothing stays as
 * typed. The Executor runs bash on this computer and only says it is the OS sandbox's.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { ConversationAnswer, Core } from "../../src/core";
import type { Executor } from "../../src/core/adapters";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { nodeOf } from "../../src/core/answers/blocks";
import { CALCULATED_FIGURE_NODE } from "../../src/core/api";
import { createLocalExecutor } from "../../src/core/execution";
import { createProcessLauncher } from "../../src/main/processes";
import { programMeter } from "../../src/main/programMeter";
import { createCodeHost } from "../../src/main/runCode/host";
import { noAnalysisOutput } from "../../src/shared/analysis";
import { answerBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import {
  calculatedFiguresIn,
  figureRunsFor,
  figureRunsOfAnswer,
} from "../../src/shared/figureRuns";
import { askAssistant } from "../helpers/assistant";
import { type ShownPassage, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { codeToolOn, scriptedModel, scriptedModels } from "../helpers/models";

type Language = "en" | "zh-CN";

const LOG = ["GET /a 200", "GET /b 500", "GET /c 500", "POST /d 201", ""].join("\n");
const SUMMARY = "Annual summary.\n\nThe North region earned 1234.5 in 2025.\n";

type Call = (passage: (name: string) => string) => { tool: string; input: unknown };

const bash =
  (code: string): Call =>
  (passage) => ({
    tool: "run_code",
    input: { title: "Totals", language: "bash", documents: [passage("server")], code },
  });

/** A model that searches, makes `calls` with the Passages it found, then answers `reply`. */
function replyingModel(calls: readonly Call[], reply: (passages: ShownPassage[]) => string) {
  return scriptedModel(
    (call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return {
          calls: [
            { tool: "search_documents", input: { query: "GET 500" } },
            { tool: "search_documents", input: { query: "North region" } },
          ],
        };
      const shown = searches.flatMap((each) => shownPassages(each.text));
      const passage = (name: string) =>
        shown.find((each) => each.document.startsWith(name))?.id ?? "P1";
      const done = call.results.filter((result) => result.tool !== "search_documents").length;
      const next = calls[done];
      return next ? { calls: [next(passage)] } : { text: reply(shown) };
    },
    { judgesItsAnswers: true },
  );
}

async function executor(): Promise<Executor> {
  const local = createLocalExecutor({
    processes: createProcessLauncher(async () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" })),
    tempDir: await createTempDataFolder(),
    reportError: (error) => {
      throw error;
    },
    meter: programMeter,
  });
  return { level: "os", run: (request) => local.run(request) };
}

async function setUp(model: MockLanguageModelV4, language: Language, analysis?: FakeAnswer) {
  const core: Core = startCore(await createTempDataFolder(), {
    ...codeToolOn(),
    createChatModel: scriptedModels(model).createChatModel,
    analysisRuntime: createFakeAnalysisRuntime({ answer: () => analysis ?? {} }),
    executor: await executor(),
    codeRuntime: createCodeHost({ python: null, font: null, appVersion: "0.0.0-test" }),
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  if (language === "zh-CN") await core.updateSettings({ user: { language } });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(sources, "server.log.txt", LOG),
    await writeSourceFile(sources, "sales.csv", "Region,Revenue\nNorth,1\nSouth,2\n"),
    await writeSourceFile(sources, "summary.txt", SUMMARY),
  ]);
  return core;
}

const QUESTION: Record<Language, string> = {
  en: "What do the orders come to, and how many rows are there?",
  "zh-CN": "订单合计多少，一共多少行？",
};

async function answered(
  language: Language,
  calls: readonly Call[],
  reply: (passages: ShownPassage[]) => string,
  { analysis, inNote = false }: { analysis?: FakeAnswer; inNote?: boolean } = {},
): Promise<{ core: Core; answer: ConversationAnswer }> {
  const core = await setUp(replyingModel(calls, reply), language, analysis);
  const note = inNote ? await core.createMind({ title: "Questions" }) : null;
  const answer = await askAssistant(core, {
    text: QUESTION[language],
    ...(note && { mindId: note.id }),
  });
  return { core, answer };
}

/** What the User reads of Blocks: their text, each figure as its shown text. */
function readText(blocks: readonly NodeJSON[]): string {
  const of = (node: NodeJSON): string =>
    node.type === "text"
      ? (node.text ?? "")
      : node.type === CALCULATED_FIGURE_NODE
        ? String((node.attrs?.figure as { shown?: unknown } | undefined)?.shown ?? "")
        : (node.content ?? []).map(of).join(node.type === "tableRow" ? " | " : "");
  return blocks.map(of).join("\n");
}

const shownFigures = (answer: ConversationAnswer) =>
  answer.figures.map((figure) => [figure.shown, figure.value, figure.analysis?.result]);

describe.skipIf(process.platform === "win32")("numbers code printed, in the Answer", () => {
  test.each<[Language, string]>([
    ["en", "The orders come to $1,234,567.89 over 3,500 rows."],
    ["zh-CN", "订单合计 123.46万元，共三千五百行。"],
  ])(
    "%s: a printed total typed into the reply is a figure calculated by code",
    async (language, reply) => {
      const { answer } = await answered(
        language,
        [bash("printf 'total %s\\nrows %s\\n' 1234567.89 3500")],
        () => reply,
      );
      const [total, rows] =
        language === "en" ? ["$1,234,567.89", "3,500"] : ["123.46万元", "三千五百"];
      expect(shownFigures(answer)).toEqual(
        expect.arrayContaining([
          [total, 1234567.89, "printed@6"],
          [rows, 3500, "printed@22"],
        ]),
      );
      expect(answer.figures).toHaveLength(2);
      expect(answer.text).not.toContain(total);
      const blocks = answerBlocks(answer);
      expect(readText(blocks)).toBe(reply);
      expect(calculatedFiguresIn(blocks).map((node) => node.figure.shown)).toEqual([total, rows]);
      // Never recalculated: its card shows the saved run, as a result() figure's does.
      expect(answer.analyses[0]?.recalculations).toBeUndefined();
    },
  );

  test.each<[Language, string]>([
    ["en", "| Month | Revenue |\n| --- | --- |\n| 1 | 1,234.5 |\n| 2 | 567.25 |"],
    ["zh-CN", "| 月份 | 收入 |\n| --- | --- |\n| 1 | 1,234.5 |\n| 2 | 567.25 |"],
  ])(
    "%s: a printed table's cells typed into the reply's table are figures, its row labels not",
    async (language, reply) => {
      const { answer } = await answered(
        language,
        [bash("printf 'Month Revenue\\n1 1234.5\\n2 567.25\\n'")],
        () => reply,
      );
      expect(shownFigures(answer)).toEqual(
        expect.arrayContaining([
          ["1,234.5", 1234.5, "printed@16"],
          ["567.25", 567.25, "printed@25"],
        ]),
      );
      // The months name the rows, as the checks read a table: the code printed them too.
      expect(answer.figures).toHaveLength(2);
      expect(answer.text).toContain("| 1 | [=");
      expect(readText(answerBlocks(answer))).toContain("1,234.5");
    },
  );

  test.each<[Language, string]>([
    ["en", "The mean is 12.3 per hour; 12.4 would be wrong, and 777 is another number."],
    ["zh-CN", "平均每小时 12.3 次；12.4 不对，777 是另一个数。"],
  ])(
    "%s: a print rounded as the reply writes it is the figure; one that matches nothing stays typed",
    async (language, reply) => {
      const { answer } = await answered(
        language,
        [bash("printf 'mean %s\\n' 12.345")],
        () => reply,
      );
      // The figure check reads 12.3 as 12.345 rounded to one decimal, and 12.4 as another number.
      expect(shownFigures(answer)).toEqual([
        [language === "en" ? "12.3" : "12.3 次", 12.345, "printed@5"],
      ]);
      expect(answer.text).toContain("12.4");
      expect(answer.text).toContain("777");
      expect(readText(answerBlocks(answer))).toBe(reply);
    },
  );

  test.each<[Language, string]>([
    ["en", "Before it stopped, the code had counted 42 rows."],
    ["zh-CN", "代码在出错前已数出 42 行。"],
  ])(
    "%s: a number printed by a run that then failed is a figure calculated by code too",
    async (language, reply) => {
      const { answer } = await answered(
        language,
        [bash("printf 'rows %s\\n' 42; exit 3")],
        () => reply,
      );
      expect(answer.analyses[0]?.end.kind).toBe("error");
      expect(answer.figures.map((figure) => [figure.value, figure.analysis?.result])).toEqual([
        [42, "printed@5"],
      ]);
      const blocks = answerBlocks(answer);
      expect(readText(blocks)).toBe(reply);
      expect(figureRunsOfAnswer(answer, blocks)).toEqual([
        expect.objectContaining({
          language: "bash",
          values: [expect.objectContaining({ value: 42 })],
        }),
      ]);
    },
  );

  test.each<[Language, string]>([
    ["en", "The North region earned 1,234.5 in 2025.[^1] The code read 3 rows."],
    ["zh-CN", "北区在 2025 年收入 1,234.5。[^1]代码读了 3 行。"],
  ])(
    "%s: a number its Citation quotes stays the Citation's, though code printed it too",
    async (language, reply) => {
      const { answer } = await answered(
        language,
        [
          bash("printf 'north %s\\nrows %s\\n' 1234.5 3"),
          (passage) => ({
            tool: "cite",
            input: {
              citations: [
                {
                  marker: 1,
                  passage: passage("summary"),
                  quote: "The North region earned 1234.5 in 2025.",
                },
              ],
            },
          }),
        ],
        () => reply,
      );
      expect(answer.figures.map((figure) => [figure.value, figure.analysis?.result])).toEqual([
        [3, "printed@18"],
      ]);
      expect(answer.text).toContain("1,234.5");
      expect(answer.citations.map((citation) => citation.marker)).toEqual([1]);
    },
  );

  test.each<[Language, string]>([
    ["en", "Both runs printed 12.3 12.3."],
    ["zh-CN", "两次都打印了 12.3 12.3。"],
  ])(
    "%s: a number that would read differently as a figure stays as it is",
    async (language, reply) => {
      const { answer } = await answered(language, [bash("printf 'mean %s\\n' 12.3")], () => reply);
      // Made a figure, the second would hide the first: a figure leaves out its own number written just before it.
      expect(answer.figures.map((figure) => figure.shown)).toEqual(["12.3"]);
      expect(answer.text).toMatch(/\[=1\] 12\.3/);
      expect(readText(answerBlocks(answer))).toBe(reply);
    },
  );

  test.each<Language>(["en", "zh-CN"])(
    "%s: a number equal to a figure() figure whose cells come to another isn't made a figure",
    async (language) => {
      const analysis: FakeAnswer = {
        output: {
          ...noAnalysisOutput(),
          printed: "total 999\nrows 2\n",
          results: [
            {
              kind: "figure",
              name: "total",
              label: "Revenue",
              unit: null,
              value: 999,
              of: { input: "sales", columns: ["Revenue"], rows: [[2, 3]], count: 2, how: "sum" },
            },
          ],
        },
      };
      const { answer } = await answered(
        language,
        [
          (passage) => ({
            tool: "run_analysis",
            input: {
              title: "Revenue",
              inputs: [{ name: "sales", passage: passage("sales") }],
              code: 'figure("total", inputs["sales"]["Revenue"], "sum", "Revenue")',
            },
          }),
        ],
        () => (language === "en" ? "Revenue is 999 over 2 rows." : "收入为 999，共 2 行。"),
        { analysis },
      );
      expect(answer.analyses[0]?.recalculations).toEqual([
        { result: "total", check: { kind: "differs", value: 3 } },
      ]);
      expect(answer.figures.map((figure) => [figure.value, figure.analysis?.result])).toEqual([
        [2, "printed@15"],
      ]);
      expect(answer.text).toContain("999");
    },
  );

  test.each<[Language, string]>([
    ["en", "The log has 2 errors."],
    ["zh-CN", "日志里有 2 个错误。"],
  ])(
    "%s: what the Answer writes into a Note keeps the printed figure and its bash run",
    async (language, sentence) => {
      const { core, answer } = await answered(
        language,
        [
          bash("grep -c ' 500' ../inputs/server.log.txt"),
          // Asked once for Citations, it writes the same text: nothing in it is the Documents'.
          ...[1, 2].map(() => () => ({
            tool: "create_mind",
            input: { title: language === "en" ? "Errors" : "错误", content: sentence },
          })),
        ],
        () => (language === "en" ? "Written." : "已写入。"),
        { inNote: true },
      );
      const madeId = answer.toolCalls.find((call) => call.tool === "create_mind" && call.mindChange)
        ?.mindChange?.mindId;
      if (!madeId) throw new Error("The Answer made no Note.");
      const client = await connectToMind(core, madeId);
      await client.settled();
      const blocks = client.blocks
        .toArray()
        .flatMap((node) => (node instanceof Y.XmlElement ? [nodeOf(node)] : []));
      expect(readText(blocks)).toContain(sentence);
      const figures = calculatedFiguresIn(blocks);
      expect(figures.map((node) => [node.figure.shown, node.figure.value])).toEqual([
        [language === "en" ? "2" : "2 个", 2],
      ]);
      const [run] = figureRunsFor(client.doc, blocks);
      expect(run).toMatchObject({
        language: "bash",
        values: [{ kind: "figure", name: "printed@0", value: 2 }],
      });
      expect(run?.values[0]).not.toHaveProperty("check");
    },
  );

  test("Add to note keeps the printed figure with the run that printed it", async () => {
    const { core, answer } = await answered(
      "en",
      [bash("grep -c ' 500' ../inputs/server.log.txt")],
      () => "The log has 2 errors.",
    );
    const mind = await core.createMind({ title: "Errors" });
    const blocks = answerBlocks(answer);
    await core.addToNote({
      mindId: mind.id,
      blocks,
      figureRuns: figureRunsOfAnswer(answer, blocks),
      model: answer.model,
      origin: null,
    });
    const client = await connectToMind(core, mind.id);
    const kept = client.blocks
      .toArray()
      .flatMap((node) => (node instanceof Y.XmlElement ? [nodeOf(node)] : []));
    expect(readText(kept)).toContain("The log has 2 errors.");
    expect(figureRunsFor(client.doc, kept)).toEqual([
      expect.objectContaining({
        language: "bash",
        code: "grep -c ' 500' ../inputs/server.log.txt",
        values: [{ kind: "figure", name: "printed@0", label: "2", unit: null, value: 2 }],
      }),
    ]);
  });
});
