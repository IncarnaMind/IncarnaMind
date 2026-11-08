/**
 * The 11-04 walk's Analysis flow (#2378), through the core as the app drives it: Orders.csv, the
 * request, the Note the Answer writes, the User's Accept, then Check. The Analysis's own table is
 * one calculated object, judged from the run the Note keeps and never against the Documents' text;
 * a sentence whose figure the Analysis gave is judged by that figure's run; the chart keeps the
 * Analysis's values and inputs once the write is checked; and the table goes in once.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { Core } from "../../src/core";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { createElement, nodeOf, topLevelBlocks } from "../../src/core/answers/blocks";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  ANALYSIS_TABLE_NODE,
  CALCULATED_FIGURE_NODE,
  CHART_NODE,
  CLAIM_CHECK_MARK,
  MIND_FIGURE_RUNS_FIELD,
} from "../../src/core/api";
import { homeReading, noteStateParts, readNoteState } from "../../src/renderer/src/noteState";
import { type AnalysisValue, noAnalysisOutput } from "../../src/shared/analysis";
import { columnLine, differingLine, footedLine } from "../../src/shared/analysisTables";
import type { NodeJSON } from "../../src/shared/blockJson";
import { chartSources, readChart } from "../../src/shared/charts";
import { readClaimCheck } from "../../src/shared/claimChecks";
import { translate } from "../../src/shared/i18n";
import { askAssistant } from "../helpers/assistant";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
  listedSentences,
  type Plan,
  requestedFigures,
  sentenceOf,
} from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess } from "../helpers/documents";
import { footnotesOf, part, unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { resolveChanges } from "../helpers/minds";
import {
  type GenerateCall,
  type ModelCall,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { fakePrinter } from "../helpers/printer";

type Language = "en" | "zh-CN";

const ORDERS = join(process.cwd(), "tests/fixtures/formats/Orders.csv");

/** The fixture's 40 orders summed by region, as pandas gives them. */
const TOTALS: [string, number][] = [
  ["Central", 8325],
  ["North", 9450],
  ["South", 8700],
  ["West", 9075],
];

type Answered = Exclude<FakeAnswer, "hang">;

const ANALYSIS = (heading: string): Answered => ({
  output: {
    ...noAnalysisOutput(),
    results: [
      {
        kind: "table",
        name: "region_totals",
        label: heading,
        unit: "",
        table: {
          columns: ["region", "amount"],
          rows: TOTALS,
          rowCount: 4,
          columnCount: 2,
        },
      },
      {
        kind: "figure",
        name: "slope",
        label: "Slope of amount on order date (per day)",
        unit: "",
        value: 6.550218340611387,
      },
      // Each region's total again as a figure of its own, [=2] to [=5], as the walk's code gave them.
      ...TOTALS.map(([region, total]) => ({
        kind: "figure" as const,
        name: `total_${region.toLowerCase()}`,
        label: `Total amount, ${region}`,
        unit: "",
        value: total,
      })),
    ],
    // Drawn of the same rows under the headings the code gave the chart, as the walk's was.
    charts: [
      {
        kind: "bar",
        title: heading,
        x: "Region",
        y: ["Total"],
        table: { columns: ["Region", "Total"], rows: TOTALS, rowCount: 4, columnCount: 2 },
      },
    ],
  },
});

const WORDS = {
  en: {
    question:
      "Using Orders.csv: total the amount by region, fit a linear trend of the amount against the order date and give its slope per day, and make a bar chart of the totals by region. Write the table and the chart into a new note called Orders analysis.",
    title: "Orders analysis",
    caption: "Total amount by region",
    slope: "A linear fit of amount against order date gives a slope of [=1] per day.",
    chart: "Total amount by region",
    note: "Calculated by the Analysis “Orders by region” from 40 rows of Orders.",
    notRecalculated: "1 figure not recalculated",
    column: "amount: sum of 40 rows, by region · recalculated",
    differs: "North: 9,999 in the note, 9,450 in the Analysis",
    footed: "The rows above add to 35,550",
    notIn: "Total: 35,551 in the note, not in the Analysis",
  },
  "zh-CN": {
    question:
      "用 Orders.csv：按地区汇总金额，对金额和下单日期做线性趋势拟合并给出每天的斜率，再画一张各地区合计的柱状图。把表格和图表写进名为「订单分析」的新笔记。",
    title: "订单分析",
    caption: "各地区金额合计",
    slope: "金额对下单日期的线性拟合斜率为每天 [=1]。",
    chart: "各地区金额合计",
    note: "由数据分析“按地区汇总订单”根据“Orders”的 40 行计算得出。",
    notRecalculated: "1 个数字未重新计算",
    column: "amount：按 region 计算 40 行的合计 · 已重新计算",
    differs: "North：笔记中为 9,999，数据分析中为 9,450",
    footed: "上面各行相加为 35,550",
    notIn: "合计：笔记中为 35,551，数据分析中没有",
  },
} as const;

/**
 * A sort and check model that keeps every sentence it is sent, and finds none in the Documents.
 * `content` is what create_mind is given, or each call's in turn while a call is refused.
 */
function writingModel(
  language: Language,
  content: string | readonly string[],
  sent: string[],
  offered: Map<string, readonly string[]>,
  asksChart: boolean,
  again: string | null,
  rewrite: { part: string; content: string } | null,
  plan: (sentence: string) => Plan | undefined,
) {
  const words = WORDS[language];
  return scriptedModel(
    (call: ModelCall) => {
      if (isCheckRun(call)) {
        if (!call.results.some((result) => result.tool === "search_documents")) {
          sent.push(sentenceOf(call));
          offered.set(sentenceOf(call), call.tools);
        }
        const planned = plan(sentenceOf(call));
        return checkReply(call, planned ? { [sentenceOf(call)]: planned } : {});
      }
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "Central" } }] };
      if (!call.results.some((result) => result.tool === "run_analysis")) {
        const orders = shownPassages(search.text).find((each) =>
          each.document.startsWith("Orders"),
        );
        return {
          calls: [
            {
              tool: "run_analysis",
              input: {
                title: language === "en" ? "Orders by region" : "按地区汇总订单",
                inputs: [{ name: "orders", passage: orders?.id ?? "" }],
                code: "pass",
              },
            },
          ],
        };
      }
      const contents = typeof content === "string" ? [content] : content;
      const creates = call.results.filter((result) => result.tool === "create_mind");
      const refused = creates.at(-1)?.text.includes("wasn't made") ?? true;
      const next = contents[creates.length];
      if (refused && next !== undefined)
        return {
          calls: [
            {
              tool: "create_mind",
              streamInput: true,
              input: {
                title: words.title,
                content: next,
                ...(asksChart && { chart: { kind: "bar", title: words.chart } }),
              },
            },
          ],
        };
      if (again !== null && !call.results.some((result) => result.tool === "add_to_mind"))
        return {
          calls: [{ tool: "add_to_mind", input: { mind: words.title, content: again } }],
        };
      if (rewrite !== null && !call.results.some((result) => result.tool === "edit_mind"))
        return {
          calls: [{ tool: "edit_mind", input: { mind: words.title, ...rewrite } }],
        };
      return { text: language === "en" ? "Written." : "已写入。" };
    },
    {
      generate: (call: GenerateCall) => {
        if (call.question === "find-claims") {
          const listed = listedSentences(call.prompt);
          sent.push(...listed.map((each) => each.text));
          return {
            text: JSON.stringify({
              sentences: listed.map(({ number, text }) => ({
                number,
                parts: [{ kind: "fact", text }],
              })),
            }),
          };
        }
        return checkGenerate({})(call);
      },
    },
  );
}

async function walked(
  language: Language,
  content: string | readonly string[],
  asksChart = true,
  again: string | null = null,
  given: FakeAnswer = ANALYSIS(WORDS[language].caption),
  rewrite: { part: string; content: string } | null = null,
  plan: (sentence: string) => Plan | undefined = () => undefined,
) {
  const sent: string[] = [];
  const offered = new Map<string, readonly string[]>();
  const model = writingModel(language, content, sent, offered, asksChart, again, rewrite, plan);
  const printer = fakePrinter();
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    printer: printer.printer,
    analysisRuntime: createFakeAnalysisRuntime({
      answer: () => given,
    }),
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  if (language === "zh-CN") await core.updateSettings({ user: { language } });
  await addAndProcess(core, [ORDERS]);
  const answer = await askAssistant(core, {
    text: WORDS[language].question,
    mindId: (await core.createMind({ title: "Questions" })).id,
    analyse: true,
  });
  const madeId = answer.toolCalls.findLast((call) => call.tool === "create_mind")?.mindChange
    ?.mindId;
  if (!madeId)
    throw new Error(`The Answer made no Note: ${JSON.stringify(answer.toolCalls).slice(0, 1500)}`);
  const client = await connectToMind(core, madeId);
  await client.settled();
  await resolveChanges(client, "accept");
  return { core, answer, madeId, client, sent, offered, printer };
}

const blocksOf = (client: MindClient): NodeJSON[] => topLevelBlocks(client.blocks).map(nodeOf);

/** Every claim check's mark in the Note, by the words it marks. */
function marks(client: MindClient): { text: string; state: string; reason: string | null }[] {
  const found: { text: string; state: string; reason: string | null }[] = [];
  const visit = (node: NodeJSON) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== CLAIM_CHECK_MARK) continue;
      const check = readClaimCheck(mark.attrs);
      if (check)
        found.push({
          text: node.text ?? "",
          state: check.state,
          reason:
            check.state === "unsupported"
              ? (check.unsupported?.reason ?? null)
              : check.state === "not-checked"
                ? check.reason
                : null,
        });
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const block of blocksOf(client)) visit(block);
  return found;
}

const tableOf = (client: MindClient) => blocksOf(client).find((block) => block.type === "table");

const cellTexts = (table: NodeJSON | undefined) =>
  (table?.content ?? []).slice(1).map((row) => JSON.stringify(row));

const CONTENT = (language: Language) =>
  [`# ${WORDS[language].title}`, "", "[=table 1]", "", WORDS[language].slope].join("\n");

describe.each(["en", "zh-CN"] as const)("%s: the walk's Analysis Note (#2378)", (language) => {
  test("the table arrives as one calculated object, under its caption and marker, with no Citation per heading", async () => {
    const { core, client } = await walked(language, CONTENT(language));
    const blocks = blocksOf(client);
    const at = blocks.findIndex((block) => block.type === "table");
    const caption = blocks[at - 1];
    const marker = caption?.content?.find((node) => node.type === ANALYSIS_TABLE_NODE);
    expect(caption?.content?.find((node) => node.type === "text")?.text).toBe(
      WORDS[language].caption,
    );
    expect(marker?.attrs?.[ANALYSIS_TABLE_ATTRIBUTE]).toEqual(
      blocks[at]?.attrs?.[ANALYSIS_TABLE_ATTRIBUTE],
    );
    expect(blocks[at]?.attrs?.[ANALYSIS_TABLE_ATTRIBUTE]).toMatchObject({
      table: { result: "region_totals" },
    });
    expect(JSON.stringify(blocks[at])).not.toContain('"citation"');
    expect(blocks.filter((block) => block.type === "table")).toHaveLength(1);
    // The Note keeps the run's table, and what IncarnaMind made of its column.
    const keys = [...client.doc.getMap(MIND_FIGURE_RUNS_FIELD).keys()];
    expect(keys.some((key) => key.includes('"table"'))).toBe(true);
    core.close();
  });

  test("Check never sends the table's cells to the Documents, and the schedule gives the table one row, recalculated", async () => {
    const { core, madeId, client, sent } = await walked(language, CONTENT(language));
    sent.length = 0;
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(sent.length).toBeGreaterThan(0);
    for (const [, total] of TOTALS)
      expect(sent.some((each) => each.includes(new Intl.NumberFormat("en").format(total)))).toBe(
        false,
      );
    // Nor its caption, which names it as a heading does, nor its chart, whose values are the run's.
    expect(sent.some((each) => each.includes(WORDS[language].caption))).toBe(false);
    expect(sent.some((each) => each.includes('"kind":"bar"'))).toBe(false);
    expect(marks(client).filter((mark) => /\d,\d{3}$/.test(mark.text))).toEqual([]);
    const schedule = await core.getFigureSchedule(madeId);
    const tables = schedule.rows.filter((row) => row.analysisTable);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.shown.state).toBe("supported");
    expect(tables[0]?.analysisTable?.columns.map((each) => columnLine(each, language))).toEqual([
      WORDS[language].column,
    ]);
    // No cell is a figure of its own, so nothing counts toward "don't cover".
    expect(schedule.rows.filter((row) => row.place.table)).toEqual([]);
    expect(schedule.counts.needsLook).toBe(0);
    core.close();
  });

  test.each([
    [
      "a sentence",
      "North's total amount grew 40% to 12,000 in 2025. ",
      "北部地区金额合计在 2025 年增长 40%，达到 12,000。",
    ],
    ["a figure with no full stop", "North leads with 12,000 ", "北部地区领先，金额合计 12,000 "],
  ])("%s the User types into the caption line is checked as any is", async (_, en, zh) => {
    const { core, madeId, client, sent } = await walked(language, CONTENT(language));
    const typed = language === "en" ? en : zh;
    const caption = client.blocks
      .toArray()
      .find(
        (each): each is Y.XmlElement =>
          each instanceof Y.XmlElement &&
          each
            .toArray()
            .some((node) => node instanceof Y.XmlElement && node.nodeName === ANALYSIS_TABLE_NODE),
      );
    const words = caption?.toArray().find((each): each is Y.XmlText => each instanceof Y.XmlText);
    if (!words) throw new Error("No caption.");
    client.doc.transact(() => words.insert(0, typed));
    await client.settled();
    sent.length = 0;
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(sent.some((each) => each.includes("12,000"))).toBe(true);
    core.close();
  });

  test("a caption with an abbreviation still only names its table", async () => {
    const { core, madeId, client, sent } = await walked(language, CONTENT(language));
    const typed = language === "en" ? "Orders vs. returns: " : "订单 vs. 退货：";
    const caption = client.blocks
      .toArray()
      .find(
        (each): each is Y.XmlElement =>
          each instanceof Y.XmlElement &&
          each
            .toArray()
            .some((node) => node instanceof Y.XmlElement && node.nodeName === ANALYSIS_TABLE_NODE),
      );
    const words = caption?.toArray().find((each): each is Y.XmlText => each instanceof Y.XmlText);
    if (!words) throw new Error("No caption.");
    client.doc.transact(() => words.insert(0, typed));
    await client.settled();
    sent.length = 0;
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(sent.some((each) => each.includes(typed.trim()))).toBe(false);
    core.close();
  });

  test("a cell of words in the Analysis's table is its run's too, never a sentence Check sends", async () => {
    const base = ANALYSIS(WORDS[language].caption);
    const busiest: Record<string, string> = {
      Central: "Brightside, Inc. placed most orders",
      North: "Evergreen Labs placed most orders",
      South: "Coastal Foods placed most orders",
      West: "Delta Health placed most orders",
    };
    const results = (base.output?.results ?? []).map((result) =>
      result.kind === "table"
        ? {
            ...result,
            table: {
              columns: ["region", "amount", "busiest"],
              rows: TOTALS.map(([region, total]) => [region, total, busiest[region] ?? ""]),
              rowCount: 4,
              columnCount: 3,
            },
          }
        : result,
    );
    const given = {
      ...base,
      output: { ...noAnalysisOutput(), ...base.output, results: results ?? [] },
    };
    const { core, madeId, client, sent } = await walked(
      language,
      CONTENT(language),
      false,
      null,
      given,
    );
    sent.length = 0;
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((each) => each.includes("placed most orders"))).toBe(false);
    core.close();
  });

  test("Word, PDF and the Source Pack give the table one note, naming its Analysis and the rows it read", async () => {
    const { core, madeId, printer } = await walked(language, CONTENT(language));
    const files = unzip((await core.exportMind(madeId, { format: "docx" })).data);
    const footnotes = Object.values(footnotesOf(part(files, "word/footnotes.xml")));
    expect(footnotes.filter((each) => each.includes(WORDS[language].note))).toHaveLength(1);
    await core.exportMind(madeId, { format: "pdf" });
    expect(
      printer.printed.at(-1)?.notes.filter((each) => each.includes(WORDS[language].note)),
    ).toHaveLength(1);
    const pack = await core.exportMind(madeId, { format: "source-pack" });
    expect(pack.citations).toBeGreaterThan(0);
    core.close();
  });

  test("with its chart beside it, a table with every row deleted, or deleted, leaves the badge with no ✓", async () => {
    const { core, madeId, client } = await walked(language, CONTENT(language));
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    const state = async () =>
      readNoteState({
        doc: client.doc,
        cellFigures: [],
        documents: await core.listDocuments(),
        keptCitationTexts: [],
        folderId: null,
      }).state?.kind;
    expect(blocksOf(client).some((block) => block.type === CHART_NODE)).toBe(true);
    expect(await state()).toBe("checked");
    const table = client.blocks
      .toArray()
      .find(
        (each): each is Y.XmlElement => each instanceof Y.XmlElement && each.nodeName === "table",
      );
    if (!table) throw new Error("No table.");
    client.doc.transact(() => table.delete(1, table.length - 1));
    await client.settled();
    expect(await state()).not.toBe("checked");
    client.doc.transact(() => {
      const at = client.blocks.toArray().indexOf(table);
      client.blocks.delete(at, 1);
    });
    await client.settled();
    expect(await state()).not.toBe("checked");
    core.close();
  });

  test("a line put between the caption and its table keeps the table's note and its schedule row's caption", async () => {
    const { core, madeId, client } = await walked(language, CONTENT(language));
    const blocks = client.blocks.toArray();
    const at = blocks.findIndex(
      (each) => each instanceof Y.XmlElement && each.nodeName === "table",
    );
    client.doc.transact(() => {
      const line = new Y.XmlElement("paragraph");
      line.setAttribute("id", randomUUID());
      line.insert(0, [
        new Y.XmlText(language === "en" ? "Read with the notes below." : "请结合下面的说明阅读。"),
      ]);
      client.blocks.insert(at, [line]);
    });
    await client.settled();
    const files = unzip((await core.exportMind(madeId, { format: "docx" })).data);
    const footnotes = Object.values(footnotesOf(part(files, "word/footnotes.xml")));
    expect(footnotes.filter((each) => each.includes(WORDS[language].note))).toHaveLength(1);
    const row = (await core.getFigureSchedule(madeId)).rows.find((each) => each.analysisTable);
    const caption = client.blocks
      .toArray()
      .find(
        (each): each is Y.XmlElement =>
          each instanceof Y.XmlElement &&
          each
            .toArray()
            .some((node) => node instanceof Y.XmlElement && node.nodeName === ANALYSIS_TABLE_NODE),
      );
    // The row opens at the caption's marker, not at the line put above the table.
    expect(row?.locator).toMatchObject({ from: { blockId: caption?.getAttribute("id") } });
    core.close();
  });

  test("a table whose cell the User changed, or a caption left without its table, exports no note that the Analysis worked it out", async () => {
    const { core, madeId, client } = await walked(language, CONTENT(language));
    const noted = async () => {
      const files = unzip((await core.exportMind(madeId, { format: "docx" })).data);
      return Object.values(footnotesOf(part(files, "word/footnotes.xml"))).filter((each) =>
        each.includes(WORDS[language].note),
      ).length;
    };
    expect(await noted()).toBe(1);
    const table = client.blocks
      .toArray()
      .find(
        (each): each is Y.XmlElement => each instanceof Y.XmlElement && each.nodeName === "table",
      );
    const north = table?.toArray()[2] as Y.XmlElement | undefined;
    const cell = north?.toArray()[1] as Y.XmlElement | undefined;
    const text = (cell?.toArray()[0] as Y.XmlElement | undefined)?.toArray()[0] as
      | Y.XmlText
      | undefined;
    if (!table || !text) throw new Error("No North cell.");
    client.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, "9,999");
    });
    await client.settled();
    expect(await noted()).toBe(0);
    client.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, "9,450");
    });
    await client.settled();
    expect(await noted()).toBe(1);
    client.doc.transact(() => client.blocks.delete(client.blocks.toArray().indexOf(table), 1));
    await client.settled();
    expect(await noted()).toBe(0);
    core.close();
  });

  test("a cell the User changes differs from the Analysis, named under its column", async () => {
    const { core, madeId, client } = await walked(language, CONTENT(language));
    const table = client.blocks
      .toArray()
      .find(
        (each): each is Y.XmlElement => each instanceof Y.XmlElement && each.nodeName === "table",
      );
    const north = table?.toArray()[2] as Y.XmlElement | undefined;
    const cell = north?.toArray()[1] as Y.XmlElement | undefined;
    const text = (cell?.toArray()[0] as Y.XmlElement | undefined)?.toArray()[0] as
      | Y.XmlText
      | undefined;
    if (!text) throw new Error("No North cell.");
    client.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, "9,999");
    });
    await client.settled();
    const schedule = await core.getFigureSchedule(madeId);
    const row = schedule.rows.find((each) => each.analysisTable);
    expect(row?.shown.state).toBe("unsupported");
    expect(row?.reason).toBe("differs-from-analysis");
    expect(
      row?.analysisTable?.columns.flatMap((each) =>
        each.differs.map((cell) => differingLine(cell, language)),
      ),
    ).toEqual([WORDS[language].differs]);
    expect(schedule.counts.needsLook).toBe(1);
    core.close();
  });

  test("the slope sentence is judged by its figure's run, never Unsupported against the text", async () => {
    const { core, madeId, client } = await walked(language, CONTENT(language));
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    const slope = marks(client).filter((mark) => mark.text.length > 6);
    expect(slope.length).toBeGreaterThan(0);
    expect(slope.map((mark) => mark.state)).not.toContain("unsupported");
    expect(new Set(slope.map((mark) => mark.state))).toEqual(new Set(["not-checked"]));
    // No check can change it, so the Note reads Checked, naming the figure not recalculated.
    const { state } = readNoteState({
      doc: client.doc,
      cellFigures: [],
      documents: await core.listDocuments(),
      keptCitationTexts: [],
      folderId: null,
    });
    expect(state?.kind).toBe("checked");
    expect(
      state &&
        noteStateParts(state, (key, params) => translate(language, key, params), language)[1],
    ).toBe(WORDS[language].notRecalculated);
    // A Check of what changed has nothing to send.
    expect(
      (await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "changed" })).kind,
    ).toBe("nothing");
    core.close();
  });

  test("the chart draws the Analysis's values, cited to the rows it read", async () => {
    const { core, answer, client } = await walked(language, CONTENT(language));
    const created = answer.toolCalls.find((call) => call.tool === "create_mind");
    expect(created?.mindChange?.chartNotDrawn).toBeUndefined();
    const chart = blocksOf(client).find((block) => block.type === CHART_NODE);
    if (!chart?.attrs) throw new Error("No chart.");
    const drawn = readChart(chart.attrs);
    expect(drawn.data.rows.map((row) => row.values[0]?.value)).toEqual(
      TOTALS.map(([, total]) => total),
    );
    const sources = chartSources(drawn);
    expect(sources.uncited).toBe(0);
    // The Analysis's values, never "each quoted" from the rows it read, which their cards still name.
    expect(sources.analysis).toBe(TOTALS.length);
    expect(sources.places.map((place) => place.citation.documentName)).toEqual(["Orders"]);
    expect(drawn.data.rows[0]?.values[0]?.inputs?.[0]?.documentName).toBe("Orders");
    expect(translate(language, `chart.source.byAnalysis.other`, { count: sources.analysis })).toBe(
      language === "en"
        ? "4 values, each calculated by the Analysis"
        : "4 个数值，均由数据分析计算得出",
    );
    expect(translate(language, "chart.source.byAnalysis.one")).toBe(
      language === "en" ? "1 value, calculated by the Analysis" : "1 个数值，由数据分析计算得出",
    );
    core.close();
  });

  test("a chart marker whose table is there, and a table marker written twice, give one table", async () => {
    const content = [
      `# ${WORDS[language].title}`,
      "",
      "[=table 1]",
      "",
      "[=chart 1]",
      "",
      "[=table 1]",
      "",
      WORDS[language].slope,
    ].join("\n");
    const { core, client } = await walked(language, content);
    expect(blocksOf(client).filter((block) => block.type === "table")).toHaveLength(1);
    expect(cellTexts(tableOf(client))).toHaveLength(4);
    core.close();
  });

  test("a chart's marker in the content draws its chart beneath its one table, as the chart option does", async () => {
    const content = [
      `# ${WORDS[language].title}`,
      "",
      "[=chart 1]",
      "",
      WORDS[language].slope,
    ].join("\n");
    const { core, answer, client } = await walked(language, content, false);
    const blocks = blocksOf(client);
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "table",
      CHART_NODE,
      "paragraph",
    ]);
    const created = answer.toolCalls.find((call) => call.tool === "create_mind");
    expect(created?.mindChange?.charts).toBe(1);
    expect(created?.mindChange?.chartNotDrawn).toBeUndefined();
    core.close();
  });

  test.each([
    ["its numbers", "Area | Sum", (total: number, _: number) => total.toLocaleString("en")],
    ["its chart's headings", "Region | Total", (total: number) => total.toLocaleString("en")],
    ["its figures' markers", "Region | Total", (_: number, at: number) => `[=${at + 2}]`],
  ])(
    "content that types the table again with %s beside its marker is refused, and the call made again gives one table",
    async (_, headings, cell) => {
      const typed = [
        `# ${WORDS[language].title}`,
        "",
        `| ${headings} |`,
        "|---|---|",
        ...TOTALS.map(([region, total], at) => `| ${region} | ${cell(total, at)} |`),
        "",
        "[=table 1]",
        "",
        WORDS[language].slope,
      ].join("\n");
      const { core, answer, client } = await walked(language, [typed, CONTENT(language)]);
      const [refused, made] = answer.toolCalls.filter((call) => call.tool === "create_mind");
      expect(refused?.status).toBe("failed");
      expect(refused?.mindProblem).toMatchObject({ kind: "copy", text: WORDS[language].caption });
      expect(made?.status).toBe("done");
      expect(blocksOf(client).filter((block) => block.type === "table")).toHaveLength(1);
      // The refused call's Note went with it: the User finds one Note of that name.
      const named = (await core.listMinds()).filter((mind) =>
        mind.title.startsWith(WORDS[language].title),
      );
      expect(named).toHaveLength(1);
      core.close();
    },
  );

  test("a chart's marker between two tables goes beneath the one its Analysis drew", async () => {
    const base = ANALYSIS(WORDS[language].caption);
    const counts = {
      kind: "table" as const,
      name: "region_counts",
      label: language === "en" ? "Orders by region" : "各地区订单数",
      unit: "",
      table: {
        columns: ["region", "orders"],
        rows: TOTALS.map(([region], at) => [region, 9 + at]),
        rowCount: 4,
        columnCount: 2,
      },
    };
    const given = {
      ...base,
      output: {
        ...noAnalysisOutput(),
        ...base.output,
        results: [...(base.output?.results ?? []), counts],
      },
    };
    const content = [
      `# ${WORDS[language].title}`,
      "",
      "[=table 1]",
      "",
      "[=chart 1]",
      "",
      "[=table 2]",
    ].join("\n");
    const { core, client } = await walked(language, content, false, null, given);
    const blocks = blocksOf(client);
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "table",
      CHART_NODE,
      "paragraph",
      "table",
    ]);
    const chart = blocks.find((block) => block.type === CHART_NODE);
    if (!chart?.attrs) throw new Error("No chart.");
    expect(readChart(chart.attrs).data.rows.map((row) => row.values[0]?.value)).toEqual(
      TOTALS.map(([, total]) => total),
    );
    core.close();
  });

  test("a later call that writes the table again is refused: the Note holds it once", async () => {
    const { core, answer, client } = await walked(language, CONTENT(language), true, "[=table 1]");
    const added = answer.toolCalls.find((call) => call.tool === "add_to_mind");
    expect(added?.status).toBe("failed");
    expect(added?.mindProblem).toMatchObject({ kind: "copy", text: WORDS[language].caption });
    expect(blocksOf(client).filter((block) => block.type === "table")).toHaveLength(1);
    core.close();
  });

  test("a rewrite of the text beside the table that gives the table again is refused: the Note holds it once", async () => {
    const part = WORDS[language].slope.slice(0, 12);
    const rewrite = { part, content: ["[=table 1]", "", WORDS[language].slope].join("\n") };
    const { core, answer, client } = await walked(
      language,
      CONTENT(language),
      false,
      null,
      undefined,
      rewrite,
    );
    const edited = answer.toolCalls.find((call) => call.tool === "edit_mind");
    expect(edited?.status).toBe("failed");
    expect(edited?.mindProblem).toMatchObject({ kind: "copy", text: WORDS[language].caption });
    expect(blocksOf(client).filter((block) => block.type === "table")).toHaveLength(1);
    core.close();
  });

  test("a total row the User adds is footed, never flagged; one that doesn't add up isn't the Analysis's", async () => {
    const { core, madeId, client } = await walked(language, CONTENT(language));
    const total = language === "en" ? "Total" : "合计";
    const table = client.blocks
      .toArray()
      .find(
        (each): each is Y.XmlElement => each instanceof Y.XmlElement && each.nodeName === "table",
      );
    const row = (value: string) =>
      createElement({
        type: "tableRow",
        content: [total, value].map((text) => ({
          type: "tableCell",
          attrs: { colspan: 1, rowspan: 1 },
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        })),
      });
    client.doc.transact(() => table?.push([row("35,550")]));
    await client.settled();
    const footed = (await core.getFigureSchedule(madeId)).rows.find((each) => each.analysisTable);
    expect(footed?.shown.state).toBe("supported");
    expect(
      footed?.analysisTable?.columns.flatMap((each) =>
        each.footed.map((one) => footedLine(one, language)),
      ),
    ).toEqual([WORDS[language].footed]);

    client.doc.transact(() => {
      table?.delete((table?.length ?? 1) - 1, 1);
      table?.push([row("35,551")]);
    });
    await client.settled();
    const off = (await core.getFigureSchedule(madeId)).rows.find((each) => each.analysisTable);
    expect(off?.reason).toBe("differs-from-analysis");
    expect(
      off?.analysisTable?.columns.flatMap((each) =>
        each.differs.map((cell) => differingLine(cell, language)),
      ),
    ).toEqual([WORDS[language].notIn]);
    core.close();
  });
});

/** Each region's rows in Orders.csv, as an Analysis names them: their row numbers in the sheet. */
function regionRows(): Map<string, number[]> {
  const lines = readFileSync(ORDERS, "utf8").trim().split("\n").slice(1);
  const rows = new Map<string, number[]>();
  lines.forEach((line, at) => {
    const cells = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const region = cells[3] ?? "";
    rows.set(region, [...(rows.get(region) ?? []), at + 2]);
  });
  return rows;
}

/** A `figure()` figure of Central's rows, as the walk's code gives one, worked out again by the core. */
function centralFigure(name: string, how: "sum" | "mean", label: string): AnalysisValue {
  const rows = regionRows().get("Central") ?? [];
  const amounts = TOTALS.find(([region]) => region === "Central")?.[1] ?? 0;
  return {
    kind: "figure",
    name,
    label,
    unit: "",
    value: how === "sum" ? amounts : amounts / rows.length,
    of: {
      input: "orders",
      columns: ["amount"],
      rows: rows.reduce<[number, number][]>((runs, row) => {
        const last = runs.at(-1);
        if (last && row === last[1] + 1) last[1] = row;
        else runs.push([row, row]);
        return runs;
      }, []),
      count: rows.length,
      how,
    },
  };
}

const NAMED = {
  en: {
    total: "Total amount, Central",
    mean: "Average amount, Central",
    right: "Central's total amount is [=6].",
    swapped: "North's total amount is [=6].",
    asTotal: "In Central, the total amount was [=7].",
    extra: "Central's total amount is [=6], and revenue doubled.",
    reworded: "South's total amount is ",
    gone: "The Analysis it came from is no longer available",
    misnamed: (label: string) => `The sentence doesn’t say this figure is ${label}`,
    unnamed: (label: string) => `The sentence doesn’t clearly say this figure is ${label}`,
    rests: "1 figure not recalculated",
    two: "2 figures not recalculated",
    whole: "North's total is [=3], of [=6] in all.",
    inWord: "Central's subtotal amount is [=6].",
    inOrder: "Central's total amount is [=6], and Central's average amount is [=7].",
    others: ["North", "In Central"],
    rewordedTo: "South",
    outOfOrder: "Central's average amount is [=6], and its total amount is [=7].",
    listed: [
      "- Central: total amount [=6]",
      "1. Central's total amount is [=6]",
      "- Central's total amount is [=6], and Central's average amount is [=7]",
      "Central's total amount is [=6]",
    ],
    nested: "- By region:\n  - Central: total amount [=6]",
    listedWrong: "- North: total amount [=6]",
    listedUnclear: "- South: total amount [=6]",
  },
  "zh-CN": {
    total: "中部地区金额合计",
    mean: "中部地区平均金额",
    right: "中部地区金额合计为 [=6]。",
    swapped: "北部地区金额合计为 [=6]。",
    asTotal: "在中部地区，金额合计是 [=7]。",
    extra: "中部地区金额合计为 [=6]，而且收入翻了一番。",
    reworded: "南部地区金额合计为 ",
    gone: "它所来自的数据分析已不可用",
    misnamed: (label: string) => `句中没有写明这个数字是${label}`,
    unnamed: (label: string) => `句中没有写明这个数字是${label}`,
    rests: "1 个数字未重新计算",
    two: "2 个数字未重新计算",
    whole: "North地区合计为 [=3]，全部合计为 [=6]。",
    inWord: null,
    inOrder: "中部地区金额合计为 [=6]，中部地区平均金额为 [=7]。",
    others: ["北部", "在中部"],
    rewordedTo: "南部",
    outOfOrder: "中部地区平均金额为 [=6]，金额合计为 [=7]。",
    listed: [
      "- 中部地区：金额合计 [=6]",
      "1. 中部地区金额合计为 [=6]",
      "- 中部地区金额合计为 [=6]，中部地区平均金额为 [=7]",
      "中部地区金额合计为 [=6]",
    ],
    nested: "- 按地区：\n  - 中部地区：金额合计 [=6]",
    listedWrong: "- 北部地区：金额合计 [=6]",
    listedUnclear: "- 南部地区：金额合计 [=6]",
  },
} as const;

/**
 * One wrong name of each kind #2544 found, in the Note's lines after the right one: what the
 * sentence, its paragraph, the heading above or a typed table's column says besides the name.
 */
const WORDS_AROUND: Record<Language, readonly [kind: string, ...lines: string[]][]> = {
  en: [
    ["per unit", "A Central order's total amount is [=6]."],
    ["sign or symbol", "Central's total amount is -[=6]."],
    ["scale said before", "All amounts below are in thousands. Central's total amount is [=6]."],
    ["typed-table column", "| Region | Total amount % |\n| --- | --- |\n| Central | [=6] |"],
    ["target", "Central's total amount has to reach [=6]."],
    ["currency the unit doesn't back", "Central's total amount is €[=6]."],
    ["subset", "Central's closed orders had a total amount of [=6]."],
  ],
  "zh-CN": [
    ["per unit", "中部地区每笔订单的金额合计为 [=6]。"],
    ["sign or symbol, a slash before the input's word", "中部地区金额合计为 [=6]/order。"],
    ["sign or symbol", "中部地区金额合计为 [=6]%。"],
    ["scale said before", "## 金额（单位：千元）", "中部地区金额合计为 [=6]。"],
    ["typed-table column", "| 地区 | 金额合计（%） |\n| --- | --- |\n| 中部地区 | [=6] |"],
    ["target", "中部地区金额合计须达到 [=6]。"],
    ["currency the unit doesn't back", "中部地区金额合计为 ¥[=6]。"],
    ["subset", "中部地区已完成订单的金额合计为 [=6]。"],
  ],
};

describe.each(["en", "zh-CN"] as const)("%s: an Analysis figure's sentence (#2378)", (language) => {
  const words = NAMED[language];
  const withFigures = (): Answered => {
    const base = ANALYSIS(WORDS[language].caption);
    return {
      ...base,
      output: {
        ...noAnalysisOutput(),
        ...base.output,
        results: [
          ...(base.output?.results ?? []),
          centralFigure("central_sum", "sum", words.total),
          centralFigure("central_mean", "mean", words.mean),
        ],
      },
    };
  };
  const lines = (...said: string[]) => [`# ${WORDS[language].title}`, "", ...said].join("\n\n");
  /** The mark on the sentence `said` starts with: its first words before the figure. */
  const stateOf = (client: MindClient, said: string) =>
    marks(client).find((mark) => mark.text.trim().length > 1 && said.startsWith(mark.text));
  const reading = async (core: Core, client: MindClient) =>
    readNoteState({
      doc: client.doc,
      cellFigures: [],
      documents: await core.listDocuments(),
      keptCitationTexts: [],
      folderId: null,
    }).state;
  const parts = (state: NonNullable<Awaited<ReturnType<typeof reading>>>) =>
    noteStateParts(state, (key, params) => translate(language, key, params), language);

  /** The scripted judge reads another figure's name in each sentence that starts with one of `others`. */
  const judgedOther =
    (others: readonly string[]) =>
    (sentence: string): Plan | undefined =>
      others.some((each) => sentence.startsWith(each))
        ? { names: "other", verdict: "unsupported" }
        : undefined;
  const scheduleStates = async (core: Core, madeId: string) =>
    (await core.getFigureSchedule(madeId)).rows
      .filter((row) => !row.analysisTable)
      .map((row) => row.shown.state);

  test("the claim judge names a figure: Supported where it reads the sentence as naming it, Unsupported where it reads another figure's name there, saying what the figure is", async () => {
    const content = lines(words.right, words.swapped, words.asTotal);
    const { core, madeId, client, sent } = await walked(
      language,
      content,
      false,
      null,
      withFigures(),
      null,
      judgedOther(words.others),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(stateOf(client, words.right)?.state).toBe("supported");
    expect(stateOf(client, words.swapped)).toMatchObject({
      state: "unsupported",
      reason: words.misnamed(words.total),
    });
    expect(stateOf(client, words.asTotal)).toMatchObject({
      state: "unsupported",
      reason: words.misnamed(words.mean),
    });
    // It holds the badge, and its own row in the schedule: never quietly green.
    expect((await reading(core, client))?.kind).toBe("needs-look");
    expect(await scheduleStates(core, madeId)).toEqual(["supported", "unsupported", "unsupported"]);
    // Check again leaves it as the judge read it; only the User's edit sends it again.
    sent.length = 0;
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "changed" });
    await client.settled();
    expect(sent.filter((each) => words.others.some((other) => each.includes(other)))).toEqual([]);
    core.close();
  });

  test("the judge decides: a reply whose fields disagree with its verdict is asked once, then read as the model's reply that couldn't be read", async () => {
    const unread = "malformed";
    const judgedWith =
      (fields: (asked: boolean) => Record<string, string>, names: Plan["names"] = "same") =>
      (sentence: string): Plan | undefined =>
        sentence.startsWith(words.right.slice(0, 8))
          ? { verdict: "supported", names, analysisItem: fields }
          : undefined;
    const checked = async (plan: (sentence: string) => Plan | undefined) => {
      const { core, madeId, client } = await walked(
        language,
        lines(words.right),
        false,
        null,
        withFigures(),
        null,
        plan,
      );
      await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
      await client.settled();
      const shown = {
        mark: stateOf(client, words.right),
        rows: await scheduleStates(core, madeId),
      };
      core.close();
      return shown;
    };
    // Each field that disagrees with a same, asked about and still disagreeing.
    for (const disagreeing of <Record<string, string>[]>[
      { verdict: "unsupported" },
      { verdict: "contradicted" },
      { relation: "at least" },
      { topic: "not found" },
      { roles: "differs" },
      { scope: "wider" },
    ]) {
      const shown = await checked(judgedWith(() => disagreeing));
      expect(shown.mark, JSON.stringify(disagreeing)).toMatchObject({
        state: "not-checked",
        reason: unread,
      });
      expect(shown.rows, JSON.stringify(disagreeing)).toEqual(["not-checked"]);
    }
    // "other" with a verdict of supported, and "unclear" with supported, disagree as well.
    for (const names of ["other", "unclear"] as const) {
      const shown = await checked(judgedWith(() => ({ verdict: "supported" }), names));
      expect(shown.mark, names).toMatchObject({ state: "not-checked", reason: unread });
    }
    // Mended when asked, the judge's own same stands.
    const mended = await checked(
      judgedWith((asked): Record<string, string> => (asked ? {} : { verdict: "unsupported" })),
    );
    expect(mended.mark?.state).toBe("supported");
    expect(mended.rows).toEqual(["supported"]);
  });

  test("one verdict everywhere: a reply with no remainder leaves the sentence, its marker and its row all Not checked", async () => {
    const { core, madeId, client } = await walked(
      language,
      lines(words.right),
      false,
      null,
      withFigures(),
      null,
      () => ({ remainder: "left out" }),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(stateOf(client, words.right)).toMatchObject({
      state: "not-checked",
      reason: "malformed",
    });
    expect(await scheduleStates(core, madeId)).toEqual(["not-checked"]);
    expect((await reading(core, client))?.kind).not.toBe("checked");
    core.close();
  });

  test("the judge's same never stands where the figure's own clause leaves a word of its label out: it is left Not checked, never Unsupported", async () => {
    const content = lines(words.right, words.swapped, words.asTotal);
    const { core, madeId, client } = await walked(language, content, false, null, withFigures());
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(stateOf(client, words.right)?.state).toBe("supported");
    for (const said of [words.swapped, words.asTotal])
      expect(stateOf(client, said)).toMatchObject({
        state: "not-checked",
        reason: "analysis-unnamed",
      });
    expect(translate(language, "claim.reason.analysis-unnamed", { detail: words.total })).toBe(
      words.unnamed(words.total),
    );
    expect((await reading(core, client))?.kind).not.toBe("checked");
    expect(await scheduleStates(core, madeId)).toEqual(["supported", "not-checked", "not-checked"]);
    core.close();
  });

  test("a sentence of only an Analysis's figures is checked with no calculate to call: IncarnaMind worked them out", async () => {
    const { core, madeId, client, sent, offered } = await walked(
      language,
      lines(words.right),
      false,
      null,
      withFigures(),
    );
    sent.length = 0;
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    const tools = sent.map((each) => offered.get(each) ?? []);
    expect(tools.length).toBeGreaterThan(0);
    for (const each of tools) {
      expect(each).toContain("search_documents");
      expect(each).not.toContain("calculate");
    }
    core.close();
  });

  test("a judge's prose where an Analysis item's calculation goes doesn't make its reply unreadable", async () => {
    const { core, madeId, client } = await walked(
      language,
      lines(words.right),
      false,
      null,
      withFigures(),
      null,
      () => ({
        reply: (call) =>
          call.results.some((result) => result.tool === "search_documents")
            ? {
                text: `Verdict: supported\nAbsence: no\nFigures: ${JSON.stringify({
                  items: requestedFigures(call).map(({ id }) => ({
                    id,
                    names: "same",
                    verdict: "supported",
                    scope: "same",
                    topic: "found",
                    roles: "same",
                    measure: null,
                    says: null,
                    reading: null,
                    relation: "equals",
                    source: null,
                    calculation: "the sum of Central's amounts",
                  })),
                  remainder: null,
                })}`,
              }
            : { calls: [{ tool: "search_documents", input: { query: "Central" } }] },
      }),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(stateOf(client, words.right)?.state).toBe("supported");
    core.close();
  });

  test("a judge that gives supported but leaves names out, asked again and still without them, is a reply that couldn't be read", async () => {
    const { core, madeId, client } = await walked(
      language,
      lines(words.right),
      false,
      null,
      withFigures(),
      null,
      () => ({ names: null, verdict: "supported" }),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(stateOf(client, words.right)).toMatchObject({
      state: "not-checked",
      reason: "malformed",
    });
    core.close();
  });

  test("a figure the judge can't tell is named is left Not checked", async () => {
    const { core, madeId, client } = await walked(
      language,
      lines(words.right),
      false,
      null,
      withFigures(),
      null,
      () => ({ names: "unclear", verdict: "unsupported" }),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(stateOf(client, words.right)).toMatchObject({
      state: "not-checked",
      reason: "analysis-unnamed",
    });
    expect(await scheduleStates(core, madeId)).toEqual(["not-checked"]);
    core.close();
  });

  test("two figures each under the other's words are left Not checked; each named in its own clause, both are Supported", async () => {
    const { core, madeId, client } = await walked(
      language,
      lines(words.inOrder, words.outOfOrder),
      false,
      null,
      withFigures(),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(stateOf(client, words.inOrder)?.state).toBe("supported");
    expect(stateOf(client, words.outOfOrder)).toMatchObject({
      state: "not-checked",
      reason: "analysis-unnamed",
    });
    core.close();
  });

  test.runIf(words.inWord !== null)(
    "a word of the label found only inside another word doesn't name the figure",
    async () => {
      const said = words.inWord ?? "";
      const { core, madeId, client } = await walked(
        language,
        lines(said),
        false,
        null,
        withFigures(),
      );
      await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
      await client.settled();
      expect(stateOf(client, said)).toMatchObject({
        state: "not-checked",
        reason: "analysis-unnamed",
      });
      core.close();
    },
  );

  test("a figure in a typed table is named by its row and column headings", async () => {
    const north = language === "en" ? "North's total amount" : "北部地区金额合计";
    const table = [
      `| ${language === "en" ? "Measure" : "指标"} | ${language === "en" ? "Value" : "数值"} |`,
      "| --- | --- |",
      `| ${words.total} | [=6] |`,
      `| ${north} | [=6] |`,
    ].join("\n");
    const { core, madeId, client } = await walked(
      language,
      lines(table),
      false,
      null,
      withFigures(),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    // A figure in a cell keeps its check on itself, not as a mark on words.
    const cells: { state: string; reason: string | null }[] = [];
    const visit = (node: NodeJSON) => {
      const check =
        node.type === CALCULATED_FIGURE_NODE ? readClaimCheck(node.attrs?.claimCheck) : null;
      if (check)
        cells.push({
          state: check.state,
          reason: check.state === "not-checked" ? check.reason : null,
        });
      for (const child of node.content ?? []) visit(child);
    };
    for (const block of blocksOf(client)) visit(block);
    expect(cells).toEqual([
      { state: "supported", reason: null },
      { state: "not-checked", reason: "analysis-unnamed" },
    ]);
    core.close();
  });

  test("a figure has no verdict before a check reads its sentence, nor once the User rewords it, until the next Check judges the new words", async () => {
    const { core, madeId, client } = await walked(
      language,
      lines(words.right),
      false,
      null,
      withFigures(),
      null,
      judgedOther([words.rewordedTo]),
    );
    expect(await scheduleStates(core, madeId)).not.toContain("supported");
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(stateOf(client, words.right)?.state).toBe("supported");
    expect(await scheduleStates(core, madeId)).toEqual(["supported"]);
    const paragraph = client.blocks
      .toArray()
      .find(
        (each): each is Y.XmlElement =>
          each instanceof Y.XmlElement &&
          each.toString().includes(language === "en" ? "Central" : "中部"),
      );
    const text = paragraph?.toArray().find((each): each is Y.XmlText => each instanceof Y.XmlText);
    if (!text) throw new Error("No sentence.");
    client.doc.transact(() => {
      text.delete(0, text.toString().indexOf(language === "en" ? " amount" : "金额"));
      text.insert(0, language === "en" ? "South's total" : "南部地区");
    });
    await client.settled();
    // The check left on the full stop is still the sentence's: Needs re-check, as the sentence
    // shows (#2584).
    expect(await scheduleStates(core, madeId)).toEqual(["needs-recheck"]);
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "changed" });
    await client.settled();
    expect(stateOf(client, words.reworded)).toMatchObject({
      state: "unsupported",
      reason: words.misnamed(words.total),
    });
    expect(await scheduleStates(core, madeId)).toEqual(["unsupported"]);
    core.close();
  });

  test("a correctly named figure beside a claim the Documents don't make is never Supported", async () => {
    const claim = language === "en" ? "revenue doubled" : "收入翻了一番";
    const { core, madeId, client } = await walked(
      language,
      lines(words.extra),
      false,
      null,
      withFigures(),
      null,
      (sentence) =>
        sentence.includes(claim)
          ? { remainder: { text: claim, verdict: "unsupported" } }
          : undefined,
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(stateOf(client, words.extra)?.state).toBe("unsupported");
    core.close();
  });

  test("a figure whose record is gone reads Not checked, and a Note with nothing earned rests on what wasn't recalculated, with no ✓", async () => {
    const { core, madeId, client } = await walked(
      language,
      lines(words.right),
      false,
      null,
      withFigures(),
    );
    client.doc.transact(() => {
      const runs = client.doc.getMap(MIND_FIGURE_RUNS_FIELD);
      for (const key of [...runs.keys()]) runs.delete(key);
    });
    await client.settled();
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    const mark = stateOf(client, words.right);
    expect(mark).toMatchObject({ state: "not-checked", reason: "analysis-gone" });
    expect(translate(language, "claim.reason.analysis-gone")).toBe(words.gone);
    const state = await reading(core, client);
    expect(state).toMatchObject({ kind: "not-checked", tone: "neutral" });
    expect(state && parts(state)).toEqual([words.rests]);
    core.close();
  });

  test("a Note whose only figure is the slope rests on it, with no ✓ and no amber", async () => {
    const { core, madeId, client } = await walked(language, lines(WORDS[language].slope), false);
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    const state = await reading(core, client);
    expect(state).toMatchObject({ kind: "not-checked", tone: "neutral" });
    expect(state && parts(state)).toEqual([words.rests]);
    core.close();
  });

  test("each column not recalculated counts as one figure, beside the slope, on the green line", async () => {
    const base = ANALYSIS(WORDS[language].caption);
    const shares: Answered = {
      ...base,
      output: {
        ...noAnalysisOutput(),
        ...base.output,
        results: (base.output?.results ?? []).map((result) =>
          result.kind === "table"
            ? {
                ...result,
                table: {
                  columns: ["region", "amount", "share"],
                  rows: TOTALS.map(([region, total]) => [region, total, total / 35550]),
                  rowCount: 4,
                  columnCount: 3,
                },
              }
            : result,
        ),
      },
    };
    const { core, madeId, client } = await walked(language, CONTENT(language), false, null, shares);
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    const state = await reading(core, client);
    expect(state?.kind).toBe("checked");
    expect(state && parts(state)[1]).toBe(words.two);
    core.close();
  });

  test("a whole figure is written out, never rounded to a scale word", async () => {
    const base = ANALYSIS(WORDS[language].caption);
    const total: AnalysisValue = {
      kind: "figure",
      name: "all_total",
      label: language === "en" ? "Total amount, all orders" : "全部订单金额合计",
      unit: "",
      value: 35550,
    };
    const given: Answered = {
      ...base,
      output: {
        ...noAnalysisOutput(),
        ...base.output,
        results: [...(base.output?.results ?? []), total],
      },
    };
    const { client, core } = await walked(language, lines(words.whole), false, null, given);
    expect(JSON.stringify(blocksOf(client))).toContain('"shown":"9,450"');
    expect(JSON.stringify(blocksOf(client))).toContain('"shown":"35,550"');
    core.close();
  });

  test("a bound table whose run the Note no longer keeps is a typed table: its cells are checked", async () => {
    const { core, madeId, client, sent } = await walked(language, CONTENT(language), false);
    client.doc.transact(() => {
      const runs = client.doc.getMap(MIND_FIGURE_RUNS_FIELD);
      for (const key of [...runs.keys()]) if (key.includes('"table"')) runs.delete(key);
    });
    await client.settled();
    sent.length = 0;
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(sent.some((each) => each.includes("9,450"))).toBe(true);
    const schedule = await core.getFigureSchedule(madeId);
    expect(schedule.rows.filter((row) => row.analysisTable)).toEqual([]);
    expect(schedule.rows.filter((row) => row.place.table).length).toBeGreaterThan(0);
    core.close();
  });

  test("behind a walled Folder the Note is outside, the run backs nothing; inside it, it does again", async () => {
    const { core, madeId, client } = await walked(
      language,
      [CONTENT(language), "", words.right].join("\n"),
      false,
      null,
      withFigures(),
    );
    // Another Document the Note may read, so its Check has somewhere to look.
    const elsewhere = join(await createTempDataFolder(), "Notes.txt");
    await writeFile(elsewhere, "Meeting notes on the regions.\n");
    await addAndProcess(core, [elsewhere]);
    const orders = (await core.listDocuments()).find((each) => each.name.startsWith("Orders"));
    if (!orders) throw new Error("No Orders.");
    const matter = await core.createLibraryGroup({ name: "Matter", description: "" });
    await core.assignDocumentGroup(orders.id, matter.id);
    await core.updateLibraryGroup(matter.id, { name: "Matter", description: "", keepInside: true });
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(stateOf(client, words.right)).toMatchObject({
      state: "not-checked",
      reason: "kept-inside",
    });
    const outside = await core.getFigureSchedule(madeId);
    expect(outside.rows.find((row) => row.analysisTable)?.shown).toEqual({
      state: "not-checked",
      reason: "kept-inside",
    });
    // Nor does its column line say it was recalculated.
    expect(
      outside.rows
        .find((row) => row.analysisTable)
        ?.analysisTable?.columns.map((column) => columnLine(column, language)),
    ).toEqual([
      language === "en"
        ? "amount: from the Analysis · not recalculated"
        : "amount：来自数据分析 · 未重新计算",
    ]);
    expect(
      outside.rows.filter((row) => !row.analysisTable).map((row) => row.shown.state),
    ).not.toContain("supported");
    // Home's row reads the wall as the badge does: the walled table earns no ✓ there either.
    const [walled] = await core.readMindContents([madeId]);
    if (!walled) throw new Error("No content.");
    const home = homeReading(walled, {
      documents: await core.listDocuments(),
      keptCitationTexts: [],
      library: await core.getLibrary(),
      folderId: null,
    });
    expect(home.health.supported).toBe(0);
    expect(home.state?.kind).toBe("not-checked");
    await core.moveToFolder({ mindIds: [madeId], folderId: matter.id });
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(stateOf(client, words.right)?.state).toBe("supported");
    const inside = await core.getFigureSchedule(madeId);
    expect(inside.rows.find((row) => row.analysisTable)?.shown.state).toBe("supported");
    // Moved out again, what was checked inside backs nothing there, before any Check: Home's row
    // reads the wall from the Library as the badge does.
    await core.moveToFolder({ mindIds: [madeId], folderId: null });
    await client.settled();
    const [stored] = await core.readMindContents([madeId]);
    if (!stored) throw new Error("No content.");
    const out = homeReading(stored, {
      documents: await core.listDocuments(),
      keptCitationTexts: [],
      library: await core.getLibrary(),
      folderId: null,
    });
    expect(out.health.supported).toBe(0);
    expect(out.state?.kind).not.toBe("checked");
    core.close();
  });

  test("the caption is the table's title, and a line above it that only says the same is dropped", async () => {
    const content = [
      `# ${WORDS[language].title}`,
      "",
      `${WORDS[language].caption}:`,
      "",
      "[=table 1]",
    ].join("\n");
    const { core, client } = await walked(language, content, false);
    expect(blocksOf(client).map((block) => block.type)).toEqual(["heading", "paragraph", "table"]);
    expect(blocksOf(client)[1]?.content?.[0]?.text).toBe(WORDS[language].caption);
    core.close();
  });

  test("two chart markers draw two charts, and a chart of the same rows sorted adds no table", async () => {
    const base = ANALYSIS(WORDS[language].caption);
    const [chart] = base.output?.charts ?? [];
    if (!chart) throw new Error("No chart.");
    const sorted = { ...chart, table: { ...chart.table, rows: [...chart.table.rows].reverse() } };
    const given: Answered = {
      ...base,
      output: { ...noAnalysisOutput(), ...base.output, charts: [chart, sorted] },
    };
    const content = [
      `# ${WORDS[language].title}`,
      "",
      "[=table 1]",
      "",
      "[=chart 1]",
      "",
      "[=chart 2]",
    ].join("\n");
    const { core, client } = await walked(language, content, false, null, given);
    const types = blocksOf(client).map((block) => block.type);
    expect(types.filter((type) => type === "table")).toHaveLength(1);
    expect(types.filter((type) => type === CHART_NODE)).toHaveLength(2);
    core.close();
  });

  /** Each check that holds an Analysis figure, in the Note's order: a sentence's, or a typed cell's own. */
  const analysisVerdicts = (client: MindClient) => {
    const found = new Map<string, string>();
    const said = (check: ReturnType<typeof readClaimCheck>) =>
      check?.state === "not-checked" ? `not-checked ${check.reason}` : (check?.state ?? "none");
    const visit = (node: NodeJSON, path: string) => {
      for (const mark of node.marks ?? []) {
        const check = mark.type === CLAIM_CHECK_MARK ? readClaimCheck(mark.attrs) : null;
        if (check?.figures?.some((figure) => figure.calculated?.figure.analysis))
          found.set(`${path}:${check.text}`, said(check));
      }
      if (node.type === CALCULATED_FIGURE_NODE && path.includes("table")) {
        const check = readClaimCheck(node.attrs?.claimCheck);
        if (check) found.set(`${path}:${found.size}`, said(check));
      }
      for (const child of node.content ?? []) visit(child, `${path}/${node.type}`);
    };
    for (const [at, block] of blocksOf(client).entries()) visit(block, String(at));
    return [...found.values()];
  };
  const homeOf = async (core: Core, madeId: string) => {
    const [stored] = await core.readMindContents([madeId]);
    if (!stored) throw new Error("No content.");
    return homeReading(stored, {
      documents: await core.listDocuments(),
      keptCitationTexts: [],
      library: await core.getLibrary(),
      folderId: null,
    });
  };

  test.each(WORDS_AROUND[language])(
    "%s: a judge's consistent same never stands, on the sentence, its row, the badge or Home, while the right name beside it is Supported (#2544)",
    async (_kind, ...wrong) => {
      const { core, madeId, client } = await walked(
        language,
        lines(words.right, ...wrong),
        false,
        null,
        withFigures(),
      );
      await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
      await client.settled();
      expect(analysisVerdicts(client)).toEqual(["supported", "not-checked analysis-unnamed"]);
      expect(await scheduleStates(core, madeId)).toEqual(["supported", "not-checked"]);
      expect((await reading(core, client))?.kind).not.toBe("checked");
      // Home's row, which the export's line reads too, counts the right name and nothing more.
      const home = await homeOf(core, madeId);
      expect(home.state?.kind).not.toBe("checked");
      expect(home.health.supported).toBe(1);
      core.close();
    },
  );

  test("a scale said in a line above, or in the heading the sentence is under, is said of its figure too (#2544)", async () => {
    const above =
      language === "en" ? "All amounts below are in thousands." : "以下金额单位为万元。";
    const { core, madeId, client } = await walked(
      language,
      lines(words.right, `## ${WORDS[language].caption}`, above, words.right),
      false,
      null,
      withFigures(),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(analysisVerdicts(client)).toEqual(["supported", "not-checked analysis-unnamed"]);
    // The check's record keeps the line that says a scale, and not the Note's title above it.
    const stored: string[] = [];
    const visit = (node: NodeJSON) => {
      for (const mark of node.marks ?? [])
        if (mark.type === CLAIM_CHECK_MARK) stored.push(JSON.stringify(mark.attrs));
      for (const child of node.content ?? []) visit(child);
    };
    for (const block of blocksOf(client)) visit(block);
    const underTheLine = stored.filter((each) => each.includes(above));
    expect(underTheLine.length).toBeGreaterThan(0);
    expect(underTheLine.some((each) => each.includes(WORDS[language].title))).toBe(false);
    core.close();
    const titled = await walked(
      language,
      [
        `# ${WORDS[language].title} (${language === "en" ? "in thousands" : "单位：千元"})`,
        "",
        `## ${WORDS[language].caption}`,
        "",
        words.right,
      ].join("\n\n"),
      false,
      null,
      withFigures(),
    );
    await titled.core.checkMind({ requestId: randomUUID(), mindId: titled.madeId, mode: "all" });
    await titled.client.settled();
    expect(analysisVerdicts(titled.client)).toEqual(["not-checked analysis-unnamed"]);
    titled.core.close();
  });

  test("an enclosing section's opening lines are said of the sections under it (#2544)", async () => {
    const scale =
      language === "en" ? "All amounts below are in thousands." : "以下金额单位为万元。";
    const { core, madeId, client } = await walked(
      language,
      lines(words.right, scale, `## ${WORDS[language].caption}`, words.right),
      false,
      null,
      withFigures(),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(analysisVerdicts(client)).toEqual(["supported", "not-checked analysis-unnamed"]);
    core.close();
  });

  test("a long sibling section between the title's units line and the sentence doesn't hide it (#2544)", async () => {
    const scale =
      language === "en" ? "All amounts below are in thousands." : "以下金额单位为万元。";
    const long =
      language === "en"
        ? `${"the regions kept their records by month, ".repeat(56)}as before.`
        : `${"各地区按月记录数据，".repeat(230)}与往常一样。`;
    expect(long.length).toBeGreaterThan(2_200);
    const { core, madeId, client } = await walked(
      language,
      lines(scale, "## A", long, "## B", words.right),
      false,
      null,
      withFigures(),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(analysisVerdicts(client)).toEqual(["not-checked analysis-unnamed"]);
    core.close();
    // The same Note without the units line keeps its Supported.
    const plain = await walked(
      language,
      lines("## A", long, "## B", words.right),
      false,
      null,
      withFigures(),
    );
    await plain.core.checkMind({ requestId: randomUUID(), mindId: plain.madeId, mode: "all" });
    await plain.client.settled();
    expect(analysisVerdicts(plain.client)).toEqual(["supported"]);
    plain.core.close();
  });

  test("a heading or a line the User types above the sentence after the Answer is read by its first Check (#2544)", async () => {
    for (const [kind, words_] of [
      ["heading", language === "en" ? "Amounts (in thousands)" : "金额（单位：千元）"],
      ["paragraph", language === "en" ? "Currency: EUR" : "以下金额均以欧元计。"],
    ] as const) {
      const { core, madeId, client } = await walked(
        language,
        lines(words.right, words.right),
        false,
        null,
        withFigures(),
      );
      // The Note's figures were read before the edit, as its schedule or badge reads them.
      expect(await scheduleStates(core, madeId)).toHaveLength(2);
      const blocks = client.blocks.toArray();
      const second = blocks.findLastIndex(
        (each) => each instanceof Y.XmlElement && each.nodeName === "paragraph",
      );
      client.doc.transact(() => {
        const line = new Y.XmlElement(kind);
        line.setAttribute("id", randomUUID());
        if (kind === "heading") line.setAttribute("level", "2");
        line.insert(0, [new Y.XmlText(words_)]);
        client.blocks.insert(second, [line]);
      });
      await client.settled();
      await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
      await client.settled();
      expect(analysisVerdicts(client), kind).toEqual(["supported", "not-checked analysis-unnamed"]);
      core.close();
    }
  });

  test("a heading typed above a typed table after the Answer is read by its cell's next Check (#2544)", async () => {
    const table =
      language === "en"
        ? "| Region | Total amount |\n| --- | --- |\n| Central | [=6] |"
        : "| 地区 | 金额合计 |\n| --- | --- |\n| 中部地区 | [=6] |";
    const { core, madeId, client } = await walked(
      language,
      lines(words.right, table),
      false,
      null,
      withFigures(),
    );
    expect(await scheduleStates(core, madeId)).toHaveLength(2);
    const at = client.blocks
      .toArray()
      .findIndex((each) => each instanceof Y.XmlElement && each.nodeName === "table");
    client.doc.transact(() => {
      const heading = new Y.XmlElement("heading");
      heading.setAttribute("id", randomUUID());
      heading.setAttribute("level", "2");
      heading.insert(0, [
        new Y.XmlText(language === "en" ? "Amounts (in thousands)" : "金额（单位：千元）"),
      ]);
      client.blocks.insert(at, [heading]);
    });
    await client.settled();
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(analysisVerdicts(client)).toEqual(["supported", "not-checked analysis-unnamed"]);
    core.close();
  });

  test("the judge reads the heading above as it is when the check runs, not as the Note was first read (#2544)", async () => {
    const before = language === "en" ? "Northern figures" : "北方数字";
    const after = language === "en" ? "Central figures" : "中部数字";
    const prompts: string[] = [];
    const { core, madeId, client } = await walked(
      language,
      lines(`## ${before}`, words.right),
      false,
      null,
      withFigures(),
      null,
      (sentence) =>
        sentence.includes("8,325")
          ? {
              reply: (call) => {
                prompts.push(call.prompt);
                return checkReply(call, {});
              },
            }
          : undefined,
    );
    expect(await scheduleStates(core, madeId)).toHaveLength(1);
    const heading = client.blocks
      .toArray()
      .find(
        (each): each is Y.XmlElement =>
          each instanceof Y.XmlElement &&
          each.nodeName === "heading" &&
          each.toString().includes(before),
      );
    const text = heading?.toArray().find((each): each is Y.XmlText => each instanceof Y.XmlText);
    if (!text) throw new Error("No heading.");
    client.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, after);
    });
    await client.settled();
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((prompt) => prompt.includes(`"heading":"${after}"`))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes(before))).toBe(false);
    expect(analysisVerdicts(client)).toEqual(["supported"]);
    core.close();
  });

  test("the lines above are its own section's, and a table's caption is its table's (#2544)", async () => {
    const scale =
      language === "en" ? "All amounts below are in thousands." : "以下金额单位为万元。";
    const caption = language === "en" ? "Totals (in thousands)" : "合计（单位：千元）";
    const table = "| A | B |\n| --- | --- |\n| x | 1 |";
    const { core, madeId, client } = await walked(
      language,
      lines(`## ${caption}`, scale, "## B", words.right, caption, table, words.right),
      false,
      null,
      withFigures(),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(analysisVerdicts(client)).toEqual(["supported", "supported"]);
    core.close();
  });

  test("code never makes a Supported: the judge's other stays Unsupported and its unclear Not checked, whatever the sentence's symbols (#2544)", async () => {
    const [, wrong = ""] = WORDS_AROUND[language].find(([kind]) => kind === "sign or symbol") ?? [];
    const prefix = wrong.slice(0, 8);
    for (const [names, shown] of [
      ["other", "unsupported"],
      ["unclear", "not-checked analysis-unnamed"],
    ] as const) {
      const { core, madeId, client } = await walked(
        language,
        lines(words.right, wrong),
        false,
        null,
        withFigures(),
        null,
        (sentence) =>
          sentence.startsWith(prefix) && sentence !== words.right.replace("[=6]", "8,325")
            ? { names, verdict: "unsupported" }
            : undefined,
      );
      await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
      await client.settled();
      expect(analysisVerdicts(client)).toEqual(["supported", shown]);
      core.close();
    }
  });

  test("a figure that ends its list item or its line has its sentence's one verdict on its row, the badge and Home (#2584)", async () => {
    const { core, madeId, client } = await walked(
      language,
      lines(...words.listed),
      false,
      null,
      withFigures(),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(analysisVerdicts(client)).toEqual(["supported", "supported", "supported", "supported"]);
    expect(await scheduleStates(core, madeId)).toEqual(Array(5).fill("supported"));
    expect((await reading(core, client))?.kind).toBe("checked");
    // Home's row, which the export's line reads too.
    const home = await homeOf(core, madeId);
    expect(home.state?.kind).toBe("checked");
    expect(home.health.supported).toBe(4);
    core.close();
  });

  test("a list item's wrong name is Unsupported on its row too, one the judge can't tell and a figure no sentence holds are Not checked, and nothing is green (#2584)", async () => {
    const [north, south] = language === "en" ? ["North", "South"] : ["北部", "南部"];
    const { core, madeId, client } = await walked(
      language,
      lines(words.nested, words.listedWrong, words.listedUnclear, "- [=7]"),
      false,
      null,
      withFigures(),
      null,
      (sentence) =>
        sentence.startsWith(north)
          ? { names: "other", verdict: "unsupported" }
          : sentence.startsWith(south)
            ? { names: "unclear", verdict: "unsupported" }
            : undefined,
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(analysisVerdicts(client)).toEqual([
      "supported",
      "unsupported",
      "not-checked analysis-unnamed",
    ]);
    expect(await scheduleStates(core, madeId)).toEqual([
      "supported",
      "unsupported",
      "not-checked",
      "not-checked",
    ]);
    expect((await reading(core, client))?.kind).toBe("needs-look");
    const home = await homeOf(core, madeId);
    expect(home.state?.kind).not.toBe("checked");
    expect(home.health.supported).toBe(1);
    core.close();
  });

  test("a reply whose Roles line gives a list item to someone else, while its figure's item names it, leaves the figure Not checked on the sentence, its row and the badge (#2584)", async () => {
    const [item = ""] = words.listed;
    const [subject, other] = language === "en" ? ["Central", "North"] : ["中部地区", "北部地区"];
    const { core, madeId, client } = await walked(
      language,
      lines(item),
      false,
      null,
      withFigures(),
      null,
      (sentence) =>
        sentence.startsWith(subject)
          ? { verdict: "unsupported", roles: `${subject} / ${other}, other` }
          : undefined,
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(analysisVerdicts(client)).toEqual(["not-checked malformed"]);
    expect(await scheduleStates(core, madeId)).toEqual(["not-checked"]);
    expect((await reading(core, client))?.kind).toBe("not-checked");
    expect((await homeOf(core, madeId)).state?.kind).toBe("not-checked");
    core.close();
  });
  test("a wrong name stays Unsupported on the sentence and its row when the reply's Roles line also gives the sentence to someone else (#2596)", async () => {
    const [item, subject, roles] =
      language === "en"
        ? ["- North: total amount [=6]", "North", "North / Central, other"]
        : ["- 北部地区：金额合计 [=6]", "北部地区", "北部地区 / 中部地区, other"];
    const { core, madeId, client } = await walked(
      language,
      lines(item),
      false,
      null,
      withFigures(),
      null,
      (sentence) =>
        sentence.startsWith(subject)
          ? { names: "other", verdict: "unsupported", roles }
          : undefined,
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(analysisVerdicts(client)).toEqual(["unsupported"]);
    expect(await scheduleStates(core, madeId)).toEqual(["unsupported"]);
    expect((await reading(core, client))?.kind).toBe("needs-look");
    core.close();
  });

  test("a figure that starts its list item has its sentence's verdict on its row (#2596)", async () => {
    const item =
      language === "en" ? "- [=6] is Central's total amount" : "- [=6] 是中部地区金额合计";
    const { core, madeId, client } = await walked(
      language,
      lines(item),
      false,
      null,
      withFigures(),
    );
    await core.checkMind({ requestId: randomUUID(), mindId: madeId, mode: "all" });
    await client.settled();
    expect(analysisVerdicts(client)).toEqual(["supported"]);
    expect(await scheduleStates(core, madeId)).toEqual(["supported"]);
    expect((await reading(core, client))?.kind).toBe("checked");
    core.close();
  });
});
