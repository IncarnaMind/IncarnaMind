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
    [
      "en",
      "| Month | Revenue |\n| --- | --- |\n| 1 | **1,234.5** |\n| 2 | 567.25 |\n| 3 | 567.25 |",
    ],
    [
      "zh-CN",
      "| 月份 | 收入 |\n| --- | --- |\n| 1 | **1,234.5** |\n| 2 | 567.25 |\n| 3 | 567.25 |",
    ],
  ])(
    "%s: a printed table's cells typed into the reply's table are figures, its row labels not",
    async (language, reply) => {
      const { answer } = await answered(
        language,
        [bash("printf 'Month Revenue\\n1 1234.5\\n2 567.25\\n3 567.25\\n'")],
        () => reply,
      );
      // Each row's figure is the printed line of its own month; its bold stays the Answer's.
      expect(
        answer.figures.map((figure) => [figure.shown, figure.analysis?.result, figure.label]),
      ).toEqual(
        expect.arrayContaining([
          ["1,234.5", "printed@16", "1 1234.5"],
          ["567.25", "printed@25", "2 567.25"],
          ["567.25", "printed@34", "3 567.25"],
        ]),
      );
      // The months name the rows, as the checks read a table: the code printed them too.
      expect(answer.figures).toHaveLength(3);
      expect(answer.text).toMatch(/\| 1 \| \*\*\[=\d+\]\*\* \|/);
      expect(readText(answerBlocks(answer))).toContain("1,234.5");
    },
  );

  test.each<[Language, string]>([
    ["en", "The mean is 12.3 across 3 regions; 12.4 would be wrong, and 777 is another number."],
    ["zh-CN", "3 个地区平均 12.3 次；12.4 不对，777 是另一个数。"],
  ])(
    "%s: a print rounded as the reply writes it is the figure, a whole number only itself; one that matches nothing stays typed",
    async (language, reply) => {
      const { answer } = await answered(
        language,
        [bash("printf 'mean %s\\nsd %s\\n' 12.345 3.4")],
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
    ["en", "The fit gives 10 as its exponent's digits, over 7 rows."],
    ["zh-CN", "拟合的指数位是 10，共 7 行。"],
  ])(
    "%s: a number in scientific notation is one number, not its exponent",
    async (language, reply) => {
      const { answer } = await answered(
        language,
        [bash("printf 'scale %s\\nrows %s\\n' 1.5e+10 7")],
        () => reply,
      );
      expect(answer.figures.map((figure) => figure.value)).toEqual([7]);
      expect(answer.text).toContain("10");
    },
  );

  test("a run's printed figures stop at what a Note keeps of one run, so its record is kept", async () => {
    const printed = Array.from({ length: 105 }, (_, at) => 1001 + at);
    const { answer } = await answered(
      "en",
      [bash("seq 1001 1105")],
      () => `The values are ${printed.join("; ")}.`,
    );
    expect(answer.figures).toHaveLength(100);
    // Marked from the end of the reply: the first five stay as typed.
    expect(answer.text).toContain("are 1001; 1002; 1003; 1004; 1005; [=");
    const blocks = answerBlocks(answer);
    expect(figureRunsOfAnswer(answer, blocks)[0]?.values).toHaveLength(100);
  });

  test.each<[Language, string, string]>([
    ["en", "Revenue is 1,234 [=2].\n\nWe read 3 rows.", "Revenue is 1,234.\nWe read 3 rows."],
    ["zh-CN", "收入为 1,234 [=2]。\n\n共读了 3 行。", "收入为 1,234。\n共读了 3 行。"],
  ])(
    "%s: a figure marker the reply wrote with no figure never takes a printed one",
    async (language, reply, read) => {
      const { answer } = await answered(language, [bash("printf 'rows %s\\n' 3")], () => reply);
      expect(answer.figures.map((figure) => figure.value)).toEqual([3]);
      expect(answer.figures[0]?.marker).toBeGreaterThan(2);
      expect(readText(answerBlocks(answer))).toBe(read);
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
          printed: "total 999.12\nrows 2\n",
          results: [
            {
              kind: "figure",
              name: "total",
              label: "Revenue",
              unit: null,
              value: 999.123,
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
        () => (language === "en" ? "Revenue is 999.12 over 2 rows." : "收入为 999.12，共 2 行。"),
        { analysis },
      );
      expect(answer.analyses[0]?.recalculations).toEqual([
        { result: "total", check: { kind: "differs", value: 3 } },
      ]);
      expect(answer.figures.map((figure) => [figure.value, figure.analysis?.result])).toEqual([
        [2, "printed@18"],
      ]);
      expect(answer.text).toContain("999.12");
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

/** A Pyodide Analysis over the sales sheet, which gives `analysis`. */
const pyodide: Call = (passage) => ({
  tool: "run_analysis",
  input: {
    title: "Revenue",
    inputs: [{ name: "sales", passage: passage("sales") }],
    code: "pass",
  },
});

const printing = (printed: string, results: FakeAnswer["output"] = {}): FakeAnswer => ({
  output: { ...noAnalysisOutput(), printed, ...results },
});

const values = (answer: ConversationAnswer) => answer.figures.map((figure) => figure.value);

describe.skipIf(process.platform === "win32")("numbers code never printed, in the Answer", () => {
  test.each<[Language, string]>([
    ["en", "The total is 12,345 over 7 rows."],
    ["zh-CN", "合计 12,345，共 7 行。"],
  ])(
    "%s: a number cut where the printed output ends was never printed",
    async (language, reply) => {
      const { answer } = await answered(
        language,
        [
          bash(
            "printf 'rows 7\\n'; head -c 19987 /dev/zero | tr '\\\\0' x; printf ' 1234567.89\\n'",
          ),
        ],
        () => reply,
      );
      expect(answer.analyses[0]?.output.printed.endsWith(" 12345")).toBe(true);
      expect(values(answer)).toEqual([7]);
      expect(answer.text).toContain("12,345");
    },
  );

  test.each<[Language, string]>([
    ["en", "The file's total is 12,345 over 7 rows."],
    ["zh-CN", "文件合计 12,345，共 7 行。"],
  ])(
    "%s: a number cut where an out/ file's preview ends was never printed",
    async (language, reply) => {
      const { answer } = await answered(
        language,
        [
          bash(
            "mkdir -p out; { head -c 1994 /dev/zero | tr '\\\\0' x; printf ' 1234567.89\\n'; } > out/t.txt; printf 'rows 7\\n'",
          ),
        ],
        () => reply,
      );
      expect(answer.analyses[0]?.outFiles?.files[0]?.text?.endsWith(" 12345")).toBe(true);
      expect(values(answer)).toEqual([7]);
    },
  );

  test.each<[Language, string, string]>([
    ["en", "%", "The share is 99.9% of 2 rows."],
    ["en", "percent", "The share is 99.9% of 2 rows."],
    ["zh-CN", "%", "占比 99.9%，共 2 行。"],
    ["zh-CN", "percent", "占比 99.9%，共 2 行。"],
  ])(
    "%s: a printed copy of a figure() in %s whose cells differ is refused",
    async (language, unit, reply) => {
      const { answer } = await answered(language, [pyodide], () => reply, {
        analysis: printing("share 99.9%\nrows 2\n", {
          results: [
            {
              kind: "figure",
              name: "share",
              label: "Share",
              unit,
              value: 0.999,
              of: { input: "sales", columns: ["Revenue"], rows: [[2, 3]], count: 2, how: "mean" },
            },
          ],
        }),
      });
      expect(answer.analyses[0]?.recalculations?.[0]?.check.kind).toBe("differs");
      expect(values(answer)).toEqual([2]);
      expect(answer.text).toContain("99.9%");
    },
  );

  test.each<[Language, string]>([
    ["en", "The 3 largest regions are North, South and East; West has 42.7."],
    ["zh-CN", "收入最高的 3 个地区是北区、南区和东区；西区为 42.7。"],
  ])("%s: a printed table's index is no number of the code's", async (language, reply) => {
    const { answer } = await answered(
      language,
      [
        bash(
          "printf '  region  amount\\n0  North  1234.5\\n1  South  567.2\\n2  East  88.1\\n3  West  42.7\\n'",
        ),
      ],
      () => reply,
    );
    expect(values(answer)).toEqual([42.7]);
  });

  test.each<[Language, string]>([
    ["en", "The scale is 1.5e+10 over 10 rows."],
    ["zh-CN", "规模为 1.5e+10，共 10 行。"],
  ])("%s: a number in scientific notation in the reply is one number", async (language, reply) => {
    const { answer } = await answered(
      language,
      [bash("printf 'scale %s\\nrows %s\\n' 1.5e+10 10")],
      () => reply,
    );
    expect(values(answer)).toEqual([10]);
    expect(answer.text).toContain("1.5e+10");
    expect(readText(answerBlocks(answer))).toBe(reply);
  });

  test.each<[Language, string]>([
    ["en", "Orders below 100 average about 635, and roughly 40 customers churned."],
    ["zh-CN", "低于 100 的订单平均约 635，约 40 位客户流失。"],
  ])(
    "%s: an approximate number as loose as its zeros matches only itself",
    async (language, reply) => {
      const { answer } = await answered(
        language,
        [bash("printf 'small %s\\nmean %s\\nchurn %s\\n' 74.5 634.5 41.6")],
        () => reply,
      );
      expect(values(answer)).toEqual([634.5]);
    },
  );
});

describe.skipIf(process.platform === "win32")("what a reply's numbers are not", () => {
  test.each<[Language, string]>([
    ["en", "| Total of 3 runs | Value |\n| --- | --- |\n| North | 1,234.5 |"],
    ["zh-CN", "| 3 次运行合计 | 数值 |\n| --- | --- |\n| 北区 | 1,234.5 |"],
  ])("%s: a table's headings name its columns", async (language, reply) => {
    const { answer } = await answered(
      language,
      [bash("printf 'runs 3\\nNorth 1234.5\\n'")],
      () => reply,
    );
    expect(values(answer)).toEqual([1234.5]);
  });

  test.each<[Language, string]>([
    ["en", "Run `wc -l` for `30`, or see [30](http://x/30); the code counted 4 rows."],
    ["zh-CN", "运行 `wc -l` 得到 `30`，或见 [30](http://x/30)；代码数出 4 行。"],
  ])("%s: code and links keep their numbers", async (language, reply) => {
    const { answer } = await answered(
      language,
      [bash("printf 'count 30\\nrows 4\\n'")],
      () => reply,
    );
    expect(values(answer)).toEqual([4]);
    expect(answer.text).toContain("`30`");
    expect(answer.text).toContain("[30](http://x/30)");
  });

  test.each<[Language, string]>([
    ["en", "The total is 1,234.5 [=1] over 2 rows."],
    ["zh-CN", "合计 1,234.5 [=1]，共 2 行。"],
  ])(
    "%s: a number written before its own figure's marker is that figure",
    async (language, reply) => {
      const { answer } = await answered(language, [pyodide], () => reply, {
        analysis: printing("total 1234.5\nrows 2\n", {
          results: [{ kind: "figure", name: "total", label: "Total", unit: null, value: 1234.5 }],
        }),
      });
      expect(answer.figures.map((figure) => figure.analysis?.result)).toEqual([
        "total",
        "printed@18",
      ]);
      // The figure placement reads the typed number as its own figure's, written twice.
      expect(answer.text).toContain("1,234.5 [=1]");
    },
  );

  test.each<[Language, string]>([
    ["en", "## 3 findings\n\nThe code found 3 issues in 5 rows."],
    ["zh-CN", "## 3 项发现\n\n代码在 5 行中发现 3 个问题。"],
  ])("%s: a heading names what follows", async (language, reply) => {
    const { answer } = await answered(
      language,
      [bash("printf 'found 3\\nrows 5\\n'")],
      () => reply,
    );
    expect(answer.text.split("\n")[0]).not.toContain("[=");
    expect(answer.text.match(/\[=\d+\]/g)).toHaveLength(2);
  });

  test.each<[Language, string]>([
    ["en", "The values are"],
    ["zh-CN", "数值为"],
  ])(
    "%s: the cap on a run's printed figures counts its own result() figures",
    async (language, lead) => {
      const printed = Array.from({ length: 100 }, (_, at) => 1001 + at);
      const { answer } = await answered(
        language,
        [pyodide],
        () => `${lead} ${printed.join("; ")}.`,
        {
          analysis: printing(`${printed.join("\n")}\n`, {
            results: Array.from({ length: 10 }, (_, at) => ({
              kind: "figure" as const,
              name: `r${at}`,
              label: `Result ${at}`,
              unit: null,
              value: 0.5 + at,
            })),
          }),
        },
      );
      expect(answer.figures).toHaveLength(90);
    },
  );
});
