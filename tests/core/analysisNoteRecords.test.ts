/**
 * An Analysis's figures written into a Note keep the run that gives them a check (#2378): the
 * editor writes a Note's Blocks again when it opens it, and that must not take the run away; the
 * Analysis's own table charts its true values, cited to the rows it read; and a figure whose
 * Analysis this answer can't give the Note is never written as if it could be checked.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { Document } from "../../src/core";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { createElement, nodeOf, topLevelBlocks } from "../../src/core/answers/blocks";
import { CHART_NODE, type ConversationAnswer, MIND_FIGURE_RUNS_FIELD } from "../../src/core/api";
import { noAnalysisOutput } from "../../src/shared/analysis";
import { answerBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { readChart } from "../../src/shared/charts";
import { calculatedFiguresIn } from "../../src/shared/figureRuns";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { translate } from "../../src/shared/i18n";
import { askAssistant } from "../helpers/assistant";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { footnotesOf, part, unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { resolveChanges } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { fakePrinter } from "../helpers/printer";

type Language = "en" | "zh-CN";

const ORDERS_CSV = [
  "order_id,region,amount",
  "1001,Central,8325",
  "1002,North,9450",
  "1003,South,8700",
  "1004,West,9075",
].join("\n");

const TOTALS = [8325, 9450, 8700, 9075];

const REGIONS_CSV = ["region,manager", "Central,Ana", "North,Ben", "South,Cara", "West,Dan"].join(
  "\n",
);

const TITLE: Record<Language, string> = { en: "Orders totals", "zh-CN": "订单合计" };

const NOTE: Record<Language, string> = { en: "Orders analysis", "zh-CN": "订单分析" };

/** The four totals as a table, the slope, and the total the core works out again from its rows. */
const ANALYSIS: FakeAnswer = {
  output: {
    ...noAnalysisOutput(),
    results: [
      {
        kind: "table",
        name: "region_totals",
        label: "Total order amount by region",
        unit: "",
        table: {
          columns: ["region", "amount"],
          rows: [
            ["Central", 8325],
            ["North", 9450],
            ["South", 8700],
            ["West", 9075],
          ],
          rowCount: 4,
          columnCount: 2,
        },
      },
      {
        kind: "figure",
        name: "slope",
        label: "Regression slope of amount on order date (per day)",
        unit: "",
        value: 6.550218340611353,
      },
      {
        kind: "figure",
        name: "total_amount",
        label: "Total order amount, all rows",
        unit: "",
        value: 35550,
        of: { input: "orders", columns: ["amount"], rows: [[2, 5]], count: 4, how: "sum" },
      },
    ],
  },
};

const CONTENT: Record<Language, string> = {
  en: [
    "# Orders analysis",
    "",
    "## Total order amount by region",
    "",
    "[=table 1]",
    "",
    "Total amount across all rows is [=2].",
    "",
    "## Regression of amount on order date",
    "",
    "A simple linear regression gives a slope of [=1] per day.",
  ].join("\n"),
  "zh-CN": [
    "# 订单分析",
    "",
    "## 各地区订单金额合计",
    "",
    "[=table 1]",
    "",
    "所有行的金额合计为 [=2]。",
    "",
    "## 订单金额对下单日期的回归",
    "",
    "简单线性回归的斜率为 [=1] 每天。",
  ].join("\n"),
};

const FOLLOW_UP: Record<Language, string> = {
  en: "Add the bar chart of total amount by region beneath the table in Orders analysis.",
  "zh-CN": "在订单分析中表格下方添加各地区金额合计的柱状图。",
};

const UNRELATED: Record<Language, string> = {
  en: "Tell me a joke.",
  "zh-CN": "讲个笑话。",
};

const QUESTION: Record<Language, string> = {
  en: "From Orders.csv, make a bar chart of total order amount by region, fit a simple linear regression of amount on order date, and put the table and the chart in a new note called Orders analysis.",
  "zh-CN":
    "根据 Orders.csv 画一张各地区订单金额合计的柱状图，对订单金额和下单日期做简单线性回归，并把表格和柱状图写进名为「订单分析」的新笔记。",
};

/** Searches, runs the Analysis, then makes the Note with its own table and the two figures. */
function writingModel(
  language: Language,
  {
    chart = true,
    twoInputs = false,
    settled = false,
    chartAfterFirstWrite = false,
  }: {
    chart?: boolean;
    twoInputs?: boolean;
    settled?: boolean;
    chartAfterFirstWrite?: boolean;
  } = {},
): MockLanguageModelV4 {
  let writes = 0;
  return scriptedModel((call) => {
    if (call.prompt.includes(FOLLOW_UP[language])) {
      if (!call.results.some((result) => result.tool === "add_to_mind")) {
        return {
          calls: [
            {
              tool: "add_to_mind",
              input: {
                mind: NOTE[language],
                chart: {
                  kind: "bar",
                  title: language === "en" ? "Total order amount by region" : "各地区订单金额合计",
                },
              },
            },
          ],
        };
      }
      return { text: language === "en" ? "Drawn." : "已绘制。" };
    }
    if (call.prompt.includes(UNRELATED[language])) {
      return { text: language === "en" ? "A short one: the tide came in." : "潮水涨上来了。" };
    }
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: "Central" } }] };
    if (!call.results.some((result) => result.tool === "run_analysis")) {
      const shown = shownPassages(search.text);
      const orders = shown.find((passage) => passage.document.startsWith("Orders"));
      const regions = shown.find((passage) => passage.document.startsWith("Regions"));
      return {
        calls: [
          {
            tool: "run_analysis",
            input: {
              title: TITLE[language],
              inputs: [
                { name: "orders", passage: orders?.id ?? "" },
                ...(twoInputs ? [{ name: "regions", passage: regions?.id ?? "" }] : []),
              ],
              code: "pass",
            },
          },
        ],
      };
    }
    if (!call.results.some((result) => result.tool === "create_mind")) {
      const asked = chart || (chartAfterFirstWrite && writes > 0);
      writes++;
      const content = settled
        ? `${CONTENT[language]}\n\n${
            language === "en"
              ? "Central's orders came from the sheet [^1]."
              : "Central 的订单来自该表 [^1]。"
          }`
        : CONTENT[language];
      return {
        calls: [
          {
            tool: "create_mind",
            streamInput: true,
            input: {
              title: NOTE[language],
              content,
              ...(asked && {
                chart: {
                  kind: "bar",
                  title: language === "en" ? "Total order amount by region" : "各地区订单金额合计",
                },
              }),
            },
          },
          ...(settled
            ? [
                {
                  tool: "cite",
                  input: {
                    citations: shownPassages(search.text).map((passage, index) => ({
                      marker: index + 1,
                      passage: passage.id,
                      quote: passage.text,
                    })),
                  },
                },
              ]
            : []),
        ],
      };
    }
    return { text: language === "en" ? "Written." : "已写入。" };
  });
}

async function setUp(
  language: Language,
  options: {
    chart?: boolean;
    twoInputs?: boolean;
    settled?: boolean;
    chartAfterFirstWrite?: boolean;
    answer?: FakeAnswer;
  } = {},
) {
  const runtime = createFakeAnalysisRuntime({ answer: () => options.answer ?? ANALYSIS });
  const printer = fakePrinter();
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(writingModel(language, options)).createChatModel,
    analysisRuntime: runtime,
    printer: printer.printer,
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  if (language === "zh-CN") await core.updateSettings({ user: { language } });
  const sources = await createTempDataFolder();
  const files = [await writeSourceFile(sources, "Orders.csv", ORDERS_CSV)];
  if (options.twoInputs) files.push(await writeSourceFile(sources, "Regions.csv", REGIONS_CSV));
  const [orders, regions] = await addAndProcess(core, files);
  const mind = await core.createMind({ title: language === "en" ? "Questions" : "提问" });
  return {
    core,
    printer,
    mind,
    orders: orders as Document,
    regions: regions as Document | undefined,
  };
}

/** Asks for the table and the chart in a Note, and gives back the Note it made. */
async function askedFor(
  language: Language,
  options: {
    chart?: boolean;
    twoInputs?: boolean;
    settled?: boolean;
    chartAfterFirstWrite?: boolean;
    answer?: FakeAnswer;
  } = {},
) {
  const { core, printer, mind, orders, regions } = await setUp(language, options);
  const answer = await askAssistant(core, {
    text: QUESTION[language],
    mindId: mind.id,
    analyse: true,
  });
  const madeId = answer.toolCalls.find((call) => call.tool === "create_mind")?.mindChange?.mindId;
  if (!madeId) throw new Error("The Answer made no Note.");
  const client = await connectToMind(core, madeId);
  await client.settled();
  return { core, printer, orders, regions, answer, madeId, client };
}

/** The Blocks of the client's Note that hold calculated figures, and where they are. */
function figureBlocks(client: MindClient) {
  const all = client.blocks.toArray();
  return all.flatMap((node, index) => {
    if (!(node instanceof Y.XmlElement)) return [];
    const figures = calculatedFiguresIn([nodeOf(node)]);
    return figures.length > 0 ? [{ index, node, nodeJson: nodeOf(node) }] : [];
  });
}

/**
 * What the editor does when it opens a Note it was written into while streaming: it writes the
 * Blocks again, first deleting them, then inserting them anew with their figures (#2378).
 */
async function rewrittenByTheEditor(client: MindClient): Promise<void> {
  const at = figureBlocks(client);
  if (at.length === 0) throw new Error("The Note holds no figure.");
  const indexes = at.map((each) => each.index);
  const copies = at.map(({ nodeJson }) => {
    const attrs = { ...(nodeJson.attrs ?? {}) };
    delete attrs.id;
    return { ...nodeJson, attrs };
  });
  client.doc.transact(() => {
    for (const index of [...indexes].sort((a, b) => b - a)) client.blocks.delete(index, 1);
  });
  await client.settled();
  client.doc.transact(() => {
    indexes.forEach((index, number) => {
      const copy = copies[number];
      if (copy) client.blocks.insert(index, [createElement(copy)]);
    });
  });
  await client.settled();
}

const valuesOf = (answer: ConversationAnswer) =>
  answer.analyses.flatMap((analysis) => analysis.output.results.map((result) => result.name));

/** What Blocks say, their text run together. */
const textOf = (node: NodeJSON): string =>
  node.type === "text"
    ? (node.text ?? "")
    : (node.content ?? []).map((child) => textOf(child)).join("");

describe("an Analysis's figures in a Note (#2378)", () => {
  test.each(["en", "zh-CN"] as const)(
    "%s: every figure keeps its Analysis record when the editor writes the Note's Blocks again, and after a reload",
    async (language) => {
      const { core, madeId, client } = await askedFor(language);

      expect(calculatedFiguresIn(topLevelBlocks(client.blocks).map(nodeOf))).toHaveLength(2);
      const before = await core.getFigureSchedule(madeId);
      expect(before.analyses.map((run) => run.values.map((value) => value.name).sort())).toEqual([
        ["slope", "total_amount"],
      ]);

      await rewrittenByTheEditor(client);

      expect(calculatedFiguresIn(topLevelBlocks(client.blocks).map(nodeOf))).toHaveLength(2);
      const after = await core.getFigureSchedule(madeId);
      expect(after.analyses.map((run) => run.values.map((value) => value.name).sort())).toEqual([
        ["slope", "total_amount"],
      ]);
      // Its record is still there: no verdict before a Check reads its sentence, and never "gone".
      const total = after.rows.find((row) => row.calculated?.figure.value === 35550);
      expect(total?.shown).toEqual({ state: "not-checked", reason: "unread" });

      await core.closeMind(madeId);
      const reloaded = await core.getFigureSchedule(madeId);
      expect(reloaded.analyses.map((run) => run.values.map((value) => value.name).sort())).toEqual([
        ["slope", "total_amount"],
      ]);
      core.close();
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "%s: the chart asked for is drawn in the Note from the Analysis's values, cited to the rows it read",
    async (language) => {
      const { core, orders, answer, madeId, client } = await askedFor(language);

      const created = answer.toolCalls.find((call) => call.tool === "create_mind");
      expect(created?.mindChange?.chartNotDrawn).toBeUndefined();
      expect(valuesOf(answer).sort()).toEqual(["region_totals", "slope", "total_amount"]);

      const blocks = topLevelBlocks(client.blocks).map(nodeOf);
      const table = blocks.find((node) => node.type === "table");
      const chart = blocks.find((node) => node.type === CHART_NODE);
      if (!chart?.attrs) throw new Error("The Note has no chart.");
      const drawn = readChart(chart.attrs);

      expect(drawn.data.rows.map((row) => row.values[0]?.value)).toEqual(TOTALS);
      expect(drawn.source).toEqual({ kind: "table", blockId: table?.attrs?.id });
      for (const row of drawn.data.rows) {
        expect(row.values[0]?.inputs?.[0]).toMatchObject({
          documentId: orders.id,
          documentName: orders.name,
          location: { kind: "rows", sheet: null, from: 1, to: 5 },
          check: "found",
        });
      }
      // Its points are its table's, which counts once, as one figure: no point is a row of its own.
      const schedule = await core.getFigureSchedule(madeId);
      expect(schedule.rows.filter((row) => row.locator.kind === "chart")).toEqual([]);
      expect(schedule.rows.filter((row) => row.analysisTable)).toHaveLength(1);
      core.close();
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "%s: a chart of an Analysis over two Documents cites every input it read",
    async (language) => {
      const { core, orders, regions, madeId, client } = await askedFor(language, {
        twoInputs: true,
      });
      if (!regions) throw new Error("The Regions Document is missing.");
      const chart = topLevelBlocks(client.blocks)
        .map(nodeOf)
        .find((node) => node.type === CHART_NODE);
      if (!chart?.attrs) throw new Error("The Note has no chart.");
      const drawn = readChart(chart.attrs);
      const value = drawn.data.rows[0]?.values[0];
      expect(value?.inputs?.[0]).toMatchObject({ documentId: orders.id });
      expect(value?.inputs?.map((each) => each.documentId).sort()).toEqual(
        [orders.id, regions.id].sort(),
      );

      const files = unzip((await core.exportMind(madeId, { format: "docx" })).data);
      const footnotes = Object.values(footnotesOf(part(files, "word/footnotes.xml"))).join("\n");
      expect(footnotes).toContain(orders.name);
      expect(footnotes).toContain(regions.name);
      core.close();
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "%s: a table whose Analysis the last Answer didn't make charts no Citation its display can't back",
    async (language) => {
      // The chart is drawn from what the table shows, never with a Citation the app can't produce.
      const { core, answer, madeId, client } = await askedFor(language, { chart: false });
      expect(
        topLevelBlocks(client.blocks)
          .map(nodeOf)
          .some((node) => node.type === CHART_NODE),
      ).toBe(false);
      await askAssistant(core, {
        text: UNRELATED[language],
        mindId: madeId,
        conversationId: answer.conversationId,
      });
      const followUp = await askAssistant(core, {
        text: FOLLOW_UP[language],
        mindId: madeId,
        conversationId: answer.conversationId,
      });
      await client.settled();
      const chart = topLevelBlocks(client.blocks)
        .map(nodeOf)
        .find((node) => node.type === CHART_NODE);
      if (chart?.attrs) {
        const values = readChart(chart.attrs)
          .data.rows.flatMap((row) => row.values)
          .filter((value) => value !== null);
        // A chart with no value would make the Citation check below assert nothing.
        expect(values.length).toBeGreaterThan(0);
        for (const value of values) {
          expect(value.citation).toBeNull();
          expect(value.citations).toBeUndefined();
        }
      } else {
        // Ambiguous display values aren't charted at all, rather than guessed from a rounded form.
        const added = followUp.toolCalls.find((call) => call.tool === "add_to_mind");
        expect(added?.status).toBe("failed");
      }
      core.close();
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "%s: a follow-up draws the chart of the Note's own table, cited, though the table came from the last Answer",
    async (language) => {
      const { core, orders, answer, madeId, client } = await askedFor(language, { chart: false });
      const blocks = topLevelBlocks(client.blocks).map(nodeOf);
      expect(blocks.some((node) => node.type === CHART_NODE)).toBe(false);
      expect(blocks.some((node) => node.type === "table")).toBe(true);

      const followUp = await askAssistant(core, {
        text: FOLLOW_UP[language],
        mindId: madeId,
        conversationId: answer.conversationId,
      });
      await client.settled();
      const added = followUp.toolCalls.find((call) => call.tool === "add_to_mind");
      expect(added?.status).toBe("done");
      expect(added?.mindChange?.chartNotDrawn).toBeUndefined();
      expect(added?.mindChange?.charts).toBe(1);

      const chart = topLevelBlocks(client.blocks)
        .map(nodeOf)
        .find((node) => node.type === CHART_NODE);
      if (!chart?.attrs) throw new Error("The follow-up drew no chart.");
      const drawn = readChart(chart.attrs);
      expect(drawn.data.rows.map((row) => row.values[0]?.value)).toEqual(TOTALS);
      expect(drawn.data.rows[0]?.values[0]?.inputs?.[0]).toMatchObject({
        documentId: orders.id,
        location: { kind: "rows", sheet: null, from: 1, to: 5 },
        check: "found",
      });
      core.close();
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "%s: the Note's Word and PDF exports cite the Analysis's inputs, never saying they aren't available",
    async (language) => {
      const { core, printer, madeId, answer, client } = await askedFor(language, { chart: false });
      const run = answer.analyses[0];
      expect(run?.end).toEqual({ kind: "done" });
      // The Note the editor wrote again still exports with the inputs its figures name.
      await rewrittenByTheEditor(client);

      const files = unzip((await core.exportMind(madeId, { format: "docx" })).data);
      const footnotes = Object.values(footnotesOf(part(files, "word/footnotes.xml"))).join("\n");
      const unavailable =
        language === "en"
          ? "aren’t available, so IncarnaMind writes it as its value"
          : "保存的输入暂不可用";
      const calculated =
        language === "en"
          ? `Calculated by the Analysis “${TITLE[language]}”`
          : `由数据分析“${TITLE[language]}”计算得出`;
      expect(footnotes).not.toContain(unavailable);
      expect(footnotes).toContain(calculated);
      expect(footnotes).toContain("Orders");

      await core.exportMind(madeId, { format: "pdf" });
      const printed = printer.printed.at(-1);
      if (!printed) throw new Error("The PDF wasn't printed.");
      const notes = printed.notes.join("\n");
      expect(notes).not.toContain(unavailable);
      expect(notes).toContain(calculated);
      expect(notes).toContain("Orders");
      core.close();
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "%s: a figure whose Analysis this Answer can't give the Note is written without claiming one",
    async (language) => {
      const figure: ConversationAnswer["figures"][number] = {
        marker: 1,
        label: language === "en" ? "Total revenue" : "收入合计",
        formula: "",
        inputs: [],
        value: 35550,
        unit: { kind: "plain" },
        approximate: false,
        shown: "35,550",
        show: { language, as: null, decimals: 0, scale: null },
        literals: [],
        engine: FORMULA_VERSION,
        written: null,
        analysis: { analysis: 1, result: "total_amount" },
      };
      const blocks = answerBlocks({
        text: language === "en" ? "It came to [=1]." : "合计为 [=1]。",
        citations: [],
        figures: [figure],
        status: "done",
      });
      // No figure names an Analysis its record can't back; its value reads as text, which the
      // Note's own checks may check, never as a figure an Analysis checked.
      expect(calculatedFiguresIn(blocks)).toEqual([]);
      expect(blocks.map(textOf).join("")).toContain("35,550");
    },
  );
});

describe("a Note from an earlier build, its figure's Analysis record gone (#2378)", () => {
  /** What an earlier build left: figures naming an Analysis whose record is no longer kept. */
  async function noteWithoutItsRecord(language: Language) {
    const made = await askedFor(language, { chart: false });
    const figures = calculatedFiguresIn(topLevelBlocks(made.client.blocks).map(nodeOf));
    const analysisId = figures.find((figure) => figure.figure.analysis)?.analysisId;
    if (!analysisId) throw new Error("The Note names no Analysis.");
    const runs = made.client.doc.getMap(MIND_FIGURE_RUNS_FIELD);
    const key = JSON.stringify([analysisId]);
    const prefix = `${key.slice(0, -1)},`;
    made.client.doc.transact(() => {
      for (const each of [...runs.keys()])
        if (each === key || each.startsWith(prefix)) runs.delete(each);
    });
    await made.client.settled();
    await resolveChanges(made.client, "accept");
    const schedule = await made.core.getFigureSchedule(made.madeId);
    expect(schedule.analyses).toEqual([]);
    return {
      ...made,
      schedule,
      shown: schedule.rows.filter((row) => row.calculated).map((row) => row.shown.state),
    };
  }

  test.each(["en", "zh-CN"] as const)(
    "%s: reads as its value and Not checked through a Checkpoint, retention, the schedule and the card's sources",
    async (language) => {
      const {
        core: running,
        madeId,
        client,
        schedule,
        shown,
      } = await noteWithoutItsRecord(language);
      // The card reads the same schedule row, and its evidence is the figure's own text.
      expect(shown.length).toBeGreaterThan(0);
      expect(new Set(shown)).toEqual(new Set(["not-checked"]));
      expect(
        schedule.rows
          .filter((row) => row.calculated)
          .map((row) => Number(row.calculated?.figure.value ?? 0))
          .sort((a, b) => a - b),
      ).toEqual([6.550218340611353, 35550]);

      const saved = await running.saveCheckpoint(madeId, "idle");
      expect((await running.listCheckpoints(madeId)).checkpoints.map((each) => each.id)).toContain(
        saved.id,
      );
      await running.restoreCheckpoint(madeId, saved.id);
      await client.settled();
      const restored = await running.getFigureSchedule(madeId);
      expect(restored.analyses).toEqual([]);
      expect(restored.rows.filter((row) => row.calculated).map((row) => row.shown.state)).toEqual(
        shown,
      );

      // A reload keeps the Note read the same: retention has nothing to retain, and reads on.
      await running.closeMind(madeId);
      const reloaded = await running.getFigureSchedule(madeId);
      expect(reloaded.rows.filter((row) => row.calculated).map((row) => row.shown.state)).toEqual(
        shown,
      );
      running.close();
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "%s: exports write its value with the saved-inputs note, never as calculated by the Analysis",
    async (language) => {
      const { core: running, printer, madeId } = await noteWithoutItsRecord(language);
      const unavailable =
        language === "en"
          ? "aren’t available, so IncarnaMind writes it as its value"
          : "保存的输入暂不可用";
      const calculated =
        language === "en"
          ? `Calculated by the Analysis “${TITLE[language]}”`
          : `由数据分析“${TITLE[language]}”计算得出`;

      const files = unzip((await running.exportMind(madeId, { format: "docx" })).data);
      const footnotes = Object.values(footnotesOf(part(files, "word/footnotes.xml"))).join("\n");
      expect(footnotes).toContain(unavailable);
      expect(footnotes).not.toContain(calculated);

      await running.exportMind(madeId, { format: "pdf" });
      const printed = printer.printed.at(-1);
      if (!printed) throw new Error("The PDF wasn't printed.");
      const notes = printed.notes.join("\n");
      expect(notes).toContain(unavailable);
      expect(notes).not.toContain(calculated);

      // Its table named its rows only through the run the Note lost: the Note cites nothing now.
      await expect(running.exportMind(madeId, { format: "source-pack" })).rejects.toThrow(
        translate(language, "export.pack.empty"),
      );
      running.close();
    },
  );
});

/** The same Analysis, its four totals with a third decimal no display keeps. */
const ROUNDED_TOTAL = 8325.444;
const ROUNDED: FakeAnswer = {
  output: {
    ...(ANALYSIS.output ?? noAnalysisOutput()),
    results: (ANALYSIS.output?.results ?? []).map((result) =>
      result.kind === "table"
        ? {
            ...result,
            table: {
              ...result.table,
              rows: [
                ["Central", ROUNDED_TOTAL],
                ["North", 9450],
                ["South", 8700],
                ["West", 9075],
              ],
            },
          }
        : result,
    ),
  },
};

describe("a chart of the Analysis's table, drawn after the Answer is read again (#2378)", () => {
  test.each(["en", "zh-CN"] as const)(
    "%s: a write that waited for cite draws the Analysis's own values, not its rounded display",
    async (language) => {
      const { core, client } = await askedFor(language, { settled: true, answer: ROUNDED });
      await client.settled();
      const chart = topLevelBlocks(client.blocks)
        .map(nodeOf)
        .find((node) => node.type === CHART_NODE);
      if (!chart?.attrs) throw new Error("The Note has no chart.");
      expect(readChart(chart.attrs).data.rows[0]?.values[0]?.value).toBe(ROUNDED_TOTAL);
      core.close();
    },
  );

  test.each(["en", "zh-CN"] as const)(
    "%s: a regenerated Answer's chart draws the Analysis's own values",
    async (language) => {
      const { core, answer, client } = await askedFor(language, {
        chart: false,
        chartAfterFirstWrite: true,
        answer: ROUNDED,
      });
      expect(
        topLevelBlocks(client.blocks)
          .map(nodeOf)
          .some((node) => node.type === CHART_NODE),
      ).toBe(false);

      await resolveChanges(client, "accept");
      const result = await core.regenerateConversationAnswer({
        conversationId: answer.conversationId,
        answerId: answer.id,
        clearScope: true,
      });
      if (!result.asked) throw new Error("The Answer wasn't asked again.");
      await answerEnded(core, result.answerId);
      await client.settled();

      const chart = topLevelBlocks(client.blocks)
        .map(nodeOf)
        .find((node) => node.type === CHART_NODE);
      if (!chart?.attrs) throw new Error("The regenerated Note has no chart.");
      expect(readChart(chart.attrs).data.rows[0]?.values[0]?.value).toBe(ROUNDED_TOTAL);
      core.close();
    },
  );
});
