import { createHash } from "node:crypto";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { nodeOf } from "../../src/core/answers/blocks";
import { plainText } from "../../src/core/mindText";
import type { AnalysisJob } from "../../src/shared/analysis";
import { answerBlocks } from "../../src/shared/answerBlocks";
import {
  calculatedFiguresIn,
  figureRunsFor,
  figureRunsOfAnswer,
} from "../../src/shared/figureRuns";
import { askAssistant } from "../helpers/assistant";
import { answerEnded, type ShownPassage, shownPassages } from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { answerIn, question, readMind, writeMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { xlsxOf } from "../helpers/office";

const SALES_CSV = [
  "Region,Quarter,Revenue",
  "North,2026Q1,120",
  "North,2026Q2,150.5",
  "South,2026Q1,80",
  "South,2026Q2,n/a",
].join("\n");

type Call = { tool: string; input: unknown };

function analysingModel(plan: {
  query: string;
  runs: ((passages: ShownPassage[]) => Call)[];
  answer: string;
}): MockLanguageModelV4 {
  return scriptedModel((call) => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query: plan.query } }] };
    }
    const ran = call.results.filter((result) => result.tool === "run_analysis").length;
    const next = plan.runs[ran];
    if (next) return { calls: [next(searches.flatMap((each) => shownPassages(each.text)))] };
    return { text: plan.answer };
  });
}

const passageOf = (passages: readonly ShownPassage[], name: string): string => {
  const found = passages.find((passage) => passage.document.startsWith(name));
  if (!found) throw new Error(`No Passage of ${name} was shown.`);
  return found.id;
};

const salesRun =
  (code = 'result("total", inputs["sales"]["Revenue"].sum(), "Total revenue", "USD")') =>
  (passages: ShownPassage[]): Call => ({
    tool: "run_analysis",
    input: {
      title: "Revenue by region",
      inputs: [{ name: "sales", passage: passageOf(passages, "sales") }],
      code,
    },
  });

function told(model: MockLanguageModelV4, tool: string): string[] {
  const last = model.doStreamCalls.at(-1);
  if (!last) throw new Error("The model wasn't asked anything.");
  const texts: string[] = [];
  for (const message of last.prompt) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === tool && part.output.type === "text") {
        texts.push(part.output.value);
      }
    }
  }
  return texts;
}

async function setUp(
  model: MockLanguageModelV4,
  answer: (job: AnalysisJob) => FakeAnswer,
  files: readonly { name: string; contents: string | Uint8Array }[] = [
    { name: "sales.csv", contents: SALES_CSV },
  ],
) {
  const runtime = createFakeAnalysisRuntime({ answer });
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(model).createChatModel,
    analysisRuntime: runtime,
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const sources = await createTempDataFolder();
  await addAndProcess(
    core,
    await Promise.all(files.map((file) => writeSourceFile(sources, file.name, file.contents))),
  );
  return { core, runtime, dataDir, sources };
}

async function askAndRead(core: Core, text: string, analyse?: boolean) {
  const asked = await core.askInConversation({ text, ...(analyse && { analyse }) });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const read = async () => {
    const content = await core.getConversation(asked.conversation.id);
    const answer = content.messages.find((message) => message.id === asked.answerId);
    if (answer?.kind !== "answer") throw new Error("No Answer.");
    return answer;
  };
  return { answer: await read(), read };
}

const totalOf = (): FakeAnswer => ({
  output: {
    results: [{ kind: "figure", name: "total", label: "Total revenue", unit: "USD", value: 350.5 }],
  },
});

describe("an Analysis an Answer runs", () => {
  test.each(["error", "out-of-memory"] as const)(
    "%s after giving results publishes no figure, table or chart",
    async (kind) => {
      const model = analysingModel({
        query: "revenue",
        runs: [salesRun()],
        answer: "Revenue [=1].\n\n[=table 1]\n\n[=chart 1]",
      });
      const table = {
        columns: ["Region", "Revenue"],
        rows: [["North", 120]],
        rowCount: 1,
        columnCount: 2,
      };
      const { core } = await setUp(model, () => ({
        end: kind === "error" ? { kind, line: 4, message: "Stopped after result()." } : { kind },
        output: {
          results: [
            { kind: "figure", name: "partial", label: "Unfinished total", unit: "USD", value: 200 },
            { kind: "table", name: "partial_table", label: "Unfinished table", unit: null, table },
          ],
          charts: [{ kind: "bar", title: "Unfinished chart", x: "Region", y: ["Revenue"], table }],
        },
      }));
      const { answer } = await askAndRead(core, "What was the total revenue?");
      expect(answer.figures).toEqual([]);
      expect(answer.analyses[0]?.markers).toEqual({ figures: [], tables: [], charts: [] });
      expect(answer.text).not.toContain("| Region | Revenue |");
      const report = told(model, "run_analysis").join("\n");
      expect(report).not.toContain("Unfinished total");
      expect(report).not.toContain("Unfinished table");
      expect(report).not.toContain("Unfinished chart");
      expect(report).toContain("can't be used");
    },
  );

  test("a percent figure keeps its fraction and shows 0.081 as 8.1%", async () => {
    const model = analysingModel({
      query: "revenue",
      runs: [
        salesRun(
          'result("growth", inputs["sales"]["Revenue"].iloc[1] / inputs["sales"]["Revenue"].iloc[0] - 1, "Growth", "%")',
        ),
      ],
      answer: "Revenue grew [=1].",
    });
    const { core } = await setUp(
      model,
      () => ({
        output: {
          results: [{ kind: "figure", name: "growth", label: "Growth", unit: "%", value: 0.081 }],
        },
      }),
      [{ name: "sales.csv", contents: "Revenue\n1000\n1081" }],
    );
    const { answer } = await askAndRead(core, "What was revenue growth?");
    expect(answer.figures).toEqual([
      expect.objectContaining({
        value: 0.081,
        shown: "8.1%",
        unit: { kind: "percent" },
        analysis: { analysis: 1, result: "growth" },
      }),
    ]);
  });

  test.each([
    ["en", "Which year does the sheet cover?"],
    ["zh-CN", "这张表覆盖哪一年？"],
  ])("%s keeps a figure result labelled Year raw", async (_language, asked) => {
    const model = analysingModel({
      query: "revenue",
      runs: [salesRun('result("year", 2026, "Year")')],
      answer: "The sheet covers [=1].",
    });
    const { core } = await setUp(model, () => ({
      output: {
        results: [{ kind: "figure", name: "year", label: "Year", unit: null, value: 2026 }],
      },
    }));
    const { answer } = await askAndRead(core, asked);
    expect(answer.figures).toEqual([
      expect.objectContaining({
        value: 2026,
        shown: "2026",
        analysis: { analysis: 1, result: "year" },
      }),
    ]);
    expect(told(model, "run_analysis")[0]).toContain("Year: 2026");
  });

  test("calculate cannot replace an Analysis marker and can use a new marker", async () => {
    const model = scriptedModel((call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
      const passages = searches.flatMap((each) => shownPassages(each.text));
      if (!call.results.some((result) => result.tool === "run_analysis"))
        return { calls: [salesRun()(passages)] };
      if (!call.results.some((result) => result.tool === "cite"))
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: [
                  {
                    marker: 1,
                    passage: passageOf(passages, "sales"),
                    location: "rows 2",
                    quote: "120",
                  },
                ],
              },
            },
          ],
        };
      const calculated = call.results.filter((result) => result.tool === "calculate").length;
      if (calculated < 2)
        return {
          calls: [
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: calculated + 1,
                    inputs: [{ name: "a", citation: 1, number: "120" }],
                    formula: "a",
                  },
                ],
              },
            },
          ],
        };
      return { text: "The Analysis gives [=1]. A separate calculation gives [=2]." };
    });
    const { core } = await setUp(model, totalOf);
    const { answer, read } = await askAndRead(core, "What was the total revenue?");
    expect(answer.figures).toEqual([
      expect.objectContaining({
        marker: 1,
        value: 350.5,
        analysis: { analysis: 1, result: "total" },
      }),
      expect.objectContaining({ marker: 2, value: 120 }),
    ]);
    expect(told(model, "calculate")[0]).toContain("belongs to an Analysis");
    expect((await read()).figures).toEqual(answer.figures);
  });

  test("reads the whole sheet into the sandbox, records each input's hash, and gives a figure the Answer shows, also when the conversation is reopened", async () => {
    const model = analysingModel({
      query: "revenue",
      runs: [salesRun()],
      answer: "Revenue came to [=1] in total.",
    });
    const { core, runtime, dataDir, sources } = await setUp(model, totalOf);

    const { answer, read } = await askAndRead(core, "What was the total revenue?");

    const [job] = runtime.jobs;
    const sales = job?.inputs[0];
    expect(sales).toMatchObject({
      kind: "table",
      name: "sales",
      columns: ["Region", "Quarter", "Revenue"],
      rows: [
        ["North", "2026Q1", 120],
        ["North", "2026Q2", 150.5],
        ["South", "2026Q1", 80],
        ["South", "2026Q2", "n/a"],
      ],
      rowNumbers: [2, 3, 4, 5],
    });
    const [analysis] = answer.analyses;
    expect(analysis).toMatchObject({ number: 1, title: "Revenue by region" });
    expect(analysis?.inputs[0]).toMatchObject({
      kind: "range",
      name: "sales",
      range: "A1:C5",
      rows: 4,
      columns: 3,
      cut: false,
      citation: {
        documentName: "sales",
        location: { kind: "rows", sheet: null, from: 1, to: 5 },
      },
    });
    const values = sales?.kind === "table" ? JSON.stringify([sales.columns, sales.rows]) : "";
    expect(analysis?.inputs[0]?.sha256).toBe(createHash("sha256").update(values).digest("hex"));
    expect(analysis?.codeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(answer.figures).toEqual([
      expect.objectContaining({
        marker: 1,
        value: 350.5,
        analysis: { analysis: 1, result: "total" },
      }),
    ]);
    expect(answer.toolCalls.find((call) => call.tool === "run_analysis")).toMatchObject({
      source: "analysis",
      status: "done",
      analysis: { number: 1, documents: ["sales"], end: "done" },
    });
    expect((await read()).analyses).toEqual(answer.analyses);
    const before = await core.getConversation(answer.conversationId);
    const [document] = await core.listDocuments();
    if (!document) throw new Error("No sales Document.");
    await writeSourceFile(sources, "sales.csv", SALES_CSV.replace("120", "999"));
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);
    core.close();

    const reopened = startCore(dataDir);
    expect(await reopened.getConversation(answer.conversationId)).toEqual(before);
    const old = analysis?.inputs[0];
    if (old?.kind !== "range") throw new Error("No range input.");
    const kept = queryDatabase<{ pages: number }>(
      dataDir,
      "SELECT count(*) AS pages FROM document_pages WHERE content_hash = ? AND deleted_at IS NULL",
      [old.citation.contentHash],
    );
    expect(kept[0]?.pages).toBeGreaterThan(0);
  });

  test("Add to note owns the Analysis figure and its used run after its conversation is purged", async () => {
    const model = analysingModel({
      query: "revenue",
      runs: [salesRun()],
      answer: "Revenue came to [=1] in total.",
    });
    const { core } = await setUp(model, totalOf);
    const { answer } = await askAndRead(core, "What was the total revenue?");
    const mind = await core.createMind({ title: "Revenue" });

    const blocks = answerBlocks(answer);
    await core.addToNote({
      mindId: mind.id,
      blocks,
      figureRuns: figureRunsOfAnswer(answer, blocks),
      model: answer.model,
      origin: null,
    });
    const reader = await connectToMind(core, mind.id);
    const read = readMind(reader);
    expect(
      reader.blocks
        .toArray()
        .flatMap((node) =>
          node instanceof Y.XmlElement || node instanceof Y.XmlText ? [plainText(node)] : [],
        )
        .join("\n"),
    ).toContain("350.5");
    const figures = calculatedFiguresIn(read.toJSON().content ?? []);
    expect(figures).toHaveLength(1);
    expect(figures[0]?.figure).toMatchObject({
      value: 350.5,
      analysis: { analysis: 1, result: "total" },
    });
    const retained = () =>
      figureRunsFor(
        reader.doc,
        reader.blocks
          .toArray()
          .flatMap((node) => (node instanceof Y.XmlElement ? [nodeOf(node)] : [])),
      );
    expect(retained()).toEqual([
      expect.objectContaining({
        code: answer.analyses[0]?.code,
        inputs: answer.analyses[0]?.inputs,
        values: [
          { kind: "figure", name: "total", label: "Total revenue", unit: "USD", value: 350.5 },
        ],
      }),
    ]);
    expect(retained()[0]).not.toHaveProperty("output");
    expect(figures[0]?.figure).not.toHaveProperty("code");
    expect((await core.getConversation(answer.conversationId)).messages).toContainEqual(answer);
    await core.deleteConversation(answer.conversationId);
    await core.deletePermanently([{ kind: "conversation", id: answer.conversationId }]);
    expect(retained()[0]?.values[0]?.value).toBe(350.5);
  });

  test("an Analysis figure the assistant writes into a Note is a figure there, with its used run (#439)", async () => {
    const model = scriptedModel((call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
      if (!call.results.some((result) => result.tool === "run_analysis"))
        return { calls: [salesRun()(searches.flatMap((each) => shownPassages(each.text)))] };
      if (!call.results.some((result) => result.tool === "add_to_mind"))
        return {
          calls: [{ tool: "add_to_mind", input: { content: "Revenue came to [=1] in total." } }],
        };
      return { text: "" };
    });
    const { core } = await setUp(model, totalOf);
    const mind = await core.createMind({ title: "Revenue" });
    await askAssistant(core, { text: "Add the total revenue to the note", mindId: mind.id });

    const reader = await connectToMind(core, mind.id);
    const blocks = reader.blocks
      .toArray()
      .flatMap((node) => (node instanceof Y.XmlElement ? [nodeOf(node)] : []));
    const figures = calculatedFiguresIn(blocks);
    expect(figures).toHaveLength(1);
    expect(figures[0]?.figure).toMatchObject({ value: 350.5, analysis: { result: "total" } });
    expect(figureRunsFor(reader.doc, blocks)).toEqual([
      expect.objectContaining({
        values: [
          { kind: "figure", name: "total", label: "Total revenue", unit: "USD", value: 350.5 },
        ],
      }),
    ]);
  });

  test("a follow-up that writes the last Answer into a Note brings that Answer's Analysis run with its figure", async () => {
    const model = scriptedModel((call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (call.prompt.includes("Put that in the note")) {
        if (!call.results.some((result) => result.tool === "add_to_mind"))
          return { calls: [{ tool: "add_to_mind", input: { answer: true } }] };
        return { text: "Added." };
      }
      if (searches.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
      if (!call.results.some((result) => result.tool === "run_analysis"))
        return { calls: [salesRun()(searches.flatMap((each) => shownPassages(each.text)))] };
      return { text: "Revenue came to [=1] in total." };
    });
    const { core } = await setUp(model, totalOf);
    const mind = await core.createMind({ title: "Revenue" });
    const first = await askAssistant(core, {
      text: "What was the total revenue?",
      mindId: mind.id,
    });
    expect(first.analyses).toHaveLength(1);
    const added = await askAssistant(core, {
      text: "Put that in the note",
      mindId: mind.id,
      conversationId: first.conversationId,
    });
    expect(added.analyses).toHaveLength(0);

    const reader = await connectToMind(core, mind.id);
    const blocks = reader.blocks
      .toArray()
      .flatMap((node) => (node instanceof Y.XmlElement ? [nodeOf(node)] : []));
    expect(calculatedFiguresIn(blocks)).toHaveLength(1);
    expect(figureRunsFor(reader.doc, blocks)).toEqual([
      expect.objectContaining({
        values: [
          { kind: "figure", name: "total", label: "Total revenue", unit: "USD", value: 350.5 },
        ],
      }),
    ]);
  });

  test("an Analysis call survives the unchanged Mind editor schema's serialization", async () => {
    const model = analysingModel({
      query: "revenue",
      runs: [salesRun()],
      answer: "Revenue came to [=1] in total.",
    });
    const { core } = await setUp(model, totalOf);
    const mind = await core.createMind({ title: "Revenue" });
    const client = await connectToMind(core, mind.id);
    const asked = question("What was the total revenue?");
    writeMind(client, [asked]);
    await client.settled();
    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("The Question wasn't asked.");
    await answerEnded(core, result.answerId);
    await client.settled();
    const stored = answerIn(client, result.answerId).attrs.toolCalls;
    expect(JSON.parse(stored)).toContainEqual(
      expect.objectContaining({
        source: "analysis",
        analysis: expect.objectContaining({ number: 1, end: "done" }),
      }),
    );

    writeMind(client, readMind(client).toJSON().content ?? []);
    await client.settled();

    expect(answerIn(client, result.answerId).attrs.toolCalls).toBe(stored);
  });

  test("a sparse sheet cites its actual heading row rather than the row before its first value", async () => {
    const model = analysingModel({
      query: "Revenue",
      runs: [salesRun()],
      answer: "Revenue is [=1].",
    });
    const { core } = await setUp(model, totalOf, [
      {
        name: "sales.xlsx",
        contents: xlsxOf([
          { name: "Sales", rows: [["Region", "Revenue"], [], [], [], ["North", 120]] },
        ]),
      },
    ]);

    const { answer } = await askAndRead(core, "What was the total revenue?");

    expect(answer.analyses[0]?.inputs[0]).toMatchObject({
      kind: "range",
      range: "A1:B5",
      rows: 1,
      citation: {
        location: { kind: "rows", sheet: "Sales", from: 1, to: 5 },
        quote: "Region\tRevenue",
      },
    });
  });

  test.each(["Region", "", '"1,240"'])(
    "column heading %j keeps a Citation to its original text",
    async (heading) => {
      const model = analysingModel({
        query: "Revenue",
        runs: [salesRun()],
        answer: "Revenue is [=1].",
      });
      const { core } = await setUp(model, totalOf, [
        { name: "sales.csv", contents: `${heading},Revenue\nNorth,120\nSouth,80` },
      ]);

      const { answer } = await askAndRead(core, "What was the total revenue?");
      const input = answer.analyses[0]?.inputs[0];
      if (input?.kind !== "range") throw new Error("No range input.");

      expect(await core.recheckCitation(input.citation)).toMatchObject({ check: "found" });
    },
  );

  test("a result table written as [=table 1] on a line of its own is in the Answer as a table, its numbers as a report shows them", async () => {
    const model = analysingModel({
      query: "revenue",
      runs: [salesRun('result("by_region", inputs["sales"].groupby("Region")["Revenue"].sum())')],
      answer: "By region:\n\n[=table 1]\n\nNorth sold most.",
    });
    const { core } = await setUp(model, () => ({
      output: {
        results: [
          {
            kind: "table",
            name: "by_region",
            label: "Revenue by region",
            unit: null,
            table: {
              columns: ["Region", "Revenue", "Share"],
              rows: [
                ["North", 270.5, 0.7717546362339514],
                ["South", 80.00000000000001, 0.22824536376604851],
              ],
              rowCount: 2,
              columnCount: 3,
            },
          },
        ],
      },
    }));

    const { answer } = await askAndRead(core, "Revenue by region?");

    expect(answer.text).toContain("| Region | Revenue | Share |");
    expect(answer.text).toContain("| North | 270.5 | 0.7718 |");
    expect(answer.text).toContain("| South | 80 | 0.2282 |");
    expect(answer.text).not.toContain("[=table");
    expect(told(model, "run_analysis")[0]).toContain("[=table 1] Revenue by region");
  });

  test("the model is told the numbers written in the code, the cells that aren't numbers, and an error's own message", async () => {
    const traceback =
      "Traceback (most recent call last):\n  File \"<analysis>\", line 2, in <module>\nKeyError: 'Revnue'";
    const model = analysingModel({
      query: "revenue",
      runs: [salesRun("rate = 0.2\nprint(inputs['sales']['Revnue'])"), salesRun()],
      answer: "Revenue came to [=1].",
    });
    let runs = 0;
    const { core } = await setUp(model, () =>
      ++runs === 1
        ? {
            end: { kind: "error", message: traceback, line: 2 },
            output: {
              literals: [{ value: 0.2, line: 1, text: "0.2" }],
              notNumbers: [
                { input: "sales", column: "Revenue", count: 1, cells: [{ row: 5, value: "n/a" }] },
              ],
            },
          }
        : totalOf(),
    );

    await askAndRead(core, "What was the total revenue?");

    const [first] = told(model, "run_analysis");
    expect(first).toContain("Numbers written in the code: 0.2 (line 1)");
    expect(first).toContain("1 cell of sales's column Revenue isn't a number");
    expect(first).toContain("KeyError: 'Revnue'");
    expect(first).toContain("Fix the code and run it again");
  });

  test("a seventh run in one Answer is refused, in words the model acts on", async () => {
    const model = analysingModel({
      query: "revenue",
      runs: Array.from({ length: 7 }, () => salesRun()),
      answer: "Revenue came to [=1].",
    });
    const { core, runtime } = await setUp(model, totalOf);

    const { answer } = await askAndRead(core, "What was the total revenue?");

    expect(runtime.jobs).toHaveLength(6);
    expect(answer.analyses).toHaveLength(6);
    expect(told(model, "run_analysis").at(-1)).toContain(
      "You have run 6 analyses for this Question",
    );
  });

  test("parallel analysis calls still run at most six times and keep distinct Analysis numbers", async () => {
    const model = scriptedModel((call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: "revenue" } }] };
      if (!call.results.some((result) => result.tool === "run_analysis")) {
        const passages = searches.flatMap((result) => shownPassages(result.text));
        return { calls: Array.from({ length: 7 }, () => salesRun()(passages)) };
      }
      return { text: "The calculated revenue is [=1]." };
    });
    const { core, runtime } = await setUp(model, totalOf);

    const { answer } = await askAndRead(core, "What was the total revenue?");

    expect(runtime.jobs).toHaveLength(6);
    expect(answer.analyses.map((analysis) => analysis.number).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(told(model, "run_analysis")).toContainEqual(
      expect.stringContaining("You have run 6 analyses for this Question"),
    );
  });

  test("a sheet longer than an Analysis reads is read only in part, and the model is told to say so", async () => {
    const rows = Array.from(
      { length: 20_050 },
      (_, index) => `R${index % 7},${index},${index * 2}`,
    );
    const model = analysingModel({
      query: "orders",
      runs: [
        (passages) => ({
          tool: "run_analysis",
          input: {
            title: "Orders",
            inputs: [{ name: "orders", passage: passageOf(passages, "orders") }],
            code: 'result("n", len(inputs["orders"]))',
          },
        }),
      ],
      answer: "There are [=1] orders.",
    });
    const { core } = await setUp(model, () => ({}), [
      { name: "orders.csv", contents: ["Region,Order,Value", ...rows].join("\n") },
    ]);

    const { answer } = await askAndRead(core, "How many orders?");

    expect(answer.analyses[0]?.inputs[0]).toMatchObject({ kind: "range", cut: true });
    expect(told(model, "run_analysis")[0]).toContain("cut: only its first");
  }, 60_000);

  test("it is offered only with a sheet or CSV to read, or when the User chose Analyse data", async () => {
    const offered: boolean[] = [];
    const model = scriptedModel((call) => {
      offered.push(call.tools.includes("run_analysis"));
      return { text: "No data." };
    });
    const { core } = await setUp(model, totalOf, [
      { name: "notes.md", contents: "# Notes\n\nThe board met in March." },
    ]);

    await askAndRead(core, "What did the board do?");
    await askAndRead(core, "Work it out", true);

    expect(offered.at(0)).toBe(false);
    expect(offered.at(-1)).toBe(true);
  });
});

describe("an Analysis table writes its numbers as the Answer's language does (#2102)", () => {
  const table = (name: string, columns: string[], rows: (string | number)[][]) => ({
    kind: "table" as const,
    name,
    label: name,
    unit: null,
    table: { columns, rows, rowCount: rows.length, columnCount: columns.length },
  });

  const amounts = table(
    "amounts",
    ["Region", "Revenue"],
    [
      ["North", 7509964],
      ["South", -1284.5],
      ["East", 0.7717546362339514],
      ["Precise", 12.5],
    ],
  );
  const strings = table(
    "strings",
    ["Region", "Revenue"],
    [
      ["North", 7509964],
      ["South", "7509964"],
      ["East", "7,509,964"],
      ["West", "n/a"],
      ["Padded", "12.50"],
      ["Huge", "9007199254740993"],
      ["Exponent", "1e3"],
      ["Exact", "1.5e3"],
      ["Grouped", "1234.50"],
      ["Zeroed", "02139"],
    ],
  );
  const postcodes = table("postcodes", ["Postcode"], [["02139"]]);
  const identifiers = table(
    "identifiers",
    ["ID", "Code", "No.", "number", "编号", "代码", "序号"],
    [[7509964, "7509964", 1284, 2024, 7509964, "0012", 2026]],
  );
  const periods = table(
    "periods",
    [
      "Year",
      "FY",
      "Period",
      "Quarter",
      "Fiscal year",
      "Financial year",
      "Reporting period",
      "年",
      "年份",
      "年度",
      "期间",
      "季度",
      "财年",
      "会计年度",
      "报告期",
    ],
    [Array.from({ length: 15 }, () => 2026)],
  );
  const headings = table(
    "headings",
    [
      "Year (FY)",
      "年份（财年）",
      "Period (quarter)",
      "Revenue per year (£)",
      "Yearly revenue",
      "年收入",
      "FY 2024",
    ],
    [[2026, 2026, 2026, 1284, 1284, 1284, 2024]],
  );
  const chart = {
    kind: "bar" as const,
    title: "Revenue",
    x: "Region",
    y: ["Revenue"],
    table: {
      columns: ["Region", "Revenue"],
      rows: [["North", 7509964]],
      rowCount: 1,
      columnCount: 2,
    },
  };

  const answer =
    "[=table 1]\n\n[=table 2]\n\n[=table 3]\n\n[=table 4]\n\n[=table 5]\n\n[=table 6]\n\n[=chart 1]";

  test.each([
    ["en", "What were the figures?"],
    ["zh-CN", "这些数字分别是多少？"],
  ])("%s groups every thousand and keeps identifiers and periods raw", async (_language, asked) => {
    const model = analysingModel({ query: "revenue", runs: [salesRun()], answer });
    const { core } = await setUp(model, () => ({
      output: {
        results: [amounts, strings, identifiers, periods, headings, postcodes],
        charts: [chart],
      },
    }));

    const { answer: read } = await askAndRead(core, asked);

    expect(read.text).toContain("| North | 7,509,964 |");
    expect(read.text).toContain("| South | -1,284.5 |");
    expect(read.text).toContain("| East | 0.7718 |");
    expect(read.text).toContain("| Precise | 12.5 |");
    expect(read.text).toContain("| South | 7,509,964 |");
    expect(read.text).toContain("| East | 7,509,964 |");
    expect(read.text).toContain("| West | n/a |");
    expect(read.text).toContain("| Padded | 12.50 |");
    expect(read.text).toContain("| Huge | 9,007,199,254,740,993 |");
    expect(read.text).toContain("| Exponent | 1e3 |");
    expect(read.text).toContain("| Exact | 1.5e3 |");
    expect(read.text).toContain("| Grouped | 1,234.50 |");
    expect(read.text).toContain("| Zeroed | 02139 |");
    expect(read.text).toContain("| 02139 |");
    expect(read.text).toContain("| 7509964 | 7509964 | 1284 | 2024 | 7509964 | 0012 | 2026 |");
    expect(read.text).toContain(
      "| 2026 | 2026 | 2026 | 2026 | 2026 | 2026 | 2026 | 2026 | 2026 | 2026 | 2026 | 2026 | 2026 | 2026 | 2026 |",
    );
    expect(read.text).toContain("| 2026 | 2026 | 2026 | 1,284 | 1,284 | 1,284 | 2,024 |");
    expect(read.text).toContain("| North | 7,509,964 |");
    expect(read.text).not.toContain("| North | 7509964 |");

    // The report the model reads writes the same table the same way.
    expect(told(model, "run_analysis")[0]).toContain("| North | 7,509,964 |");
  });
});
