/**
 * An Analysis's tables and figures written into a Note, then checked, against a real model (#2378),
 * through the core as the app asks, in English and Chinese: the held-out sets of
 * ../helpers/analysisTablesHeldOut and ../helpers/analysisFiguresHeldOut, each written before the
 * run it measures, and the 11-04 walk's request on Orders.csv. The Analysis runs in the app's Python helper (../helpers/pyodideAnalysis).
 * It counts, for each Note: the Analysis tables and how many of their columns IncarnaMind worked
 * out again, the Analysis figures it worked out again and those that name their rows, and after
 * Check every mark that needs a look on the Analysis's own words; a figure or column shown
 * recalculated whose value no reference gives is a false Supported, and fails the run. It runs
 * only when INCARNAMIND_LIVE_ANTHROPIC_KEY is set (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by
 * default); INCARNAMIND_LIVE_REPORT keeps each Note's lines, INCARNAMIND_LIVE_MAX_USD stops asking
 * once the set has cost that much, and INCARNAMIND_LIVE_CASES picks cases by name.
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import type * as Y from "yjs";
import type { AnalysisRuntime, ConversationAnswer, Core } from "../../src/core";
import { nodeOf, topLevelBlocks } from "../../src/core/answers/blocks";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  CHART_NODE,
  CLAIM_CHECK_MARK,
  MIND_CONTENT_FIELD,
} from "../../src/core/api";
import { costOf } from "../../src/core/cost/price";
import { catalogModel } from "../../src/core/providers/catalog";
import { type ChatModelFactory, createAiSdkChatModel } from "../../src/core/providers/models";
import { columnLine, liveVersions, tableShownIn } from "../../src/shared/analysisTables";
import type { NodeJSON } from "../../src/shared/blockJson";
import { readCalculatedFigureAttributes } from "../../src/shared/calculatedFigures";
import { chartSources, readChart } from "../../src/shared/charts";
import { readClaimCheck } from "../../src/shared/claimChecks";
import { figureRunsFor, readTableBinding } from "../../src/shared/figureRuns";
import {
  FIGURES_HELD_OUT,
  SHIPMENTS_FILE,
  shipmentsReference,
  shipmentsWorkbook,
} from "../helpers/analysisFiguresHeldOut";
import {
  CLINIC_FILE,
  clinicReference,
  clinicWorkbook,
  TABLES_HELD_OUT,
  type TableHeldOut,
} from "../helpers/analysisTablesHeldOut";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { resolveChanges } from "../helpers/minds";
import { pyodideAnalysisRuntime } from "../helpers/pyodideAnalysis";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const PRICE = catalogModel("anthropic", MODEL)?.price;
const MAX_USD = Number(process.env.INCARNAMIND_LIVE_MAX_USD ?? Number.POSITIVE_INFINITY);
const PICKED = process.env.INCARNAMIND_LIVE_CASES?.split(",").map((each) => each.trim());

interface Billed {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
type Usage = {
  inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: { total?: number };
};
const billedOf = (usage: Usage | undefined): Billed => ({
  input: usage?.inputTokens?.total ?? 0,
  cacheRead: usage?.inputTokens?.cacheRead ?? 0,
  cacheWrite: usage?.inputTokens?.cacheWrite ?? 0,
  output: usage?.outputTokens?.total ?? 0,
});
const billed: Billed[] = [];
const priced = (each: Billed) =>
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
    : 0;
const spent = () => billed.reduce((total, each) => total + priced(each), 0);
const tokens = () =>
  billed.reduce<Billed & { requests: number }>(
    (total, each) => ({
      requests: total.requests + 1,
      input: total.input + each.input,
      cacheRead: total.cacheRead + each.cacheRead,
      cacheWrite: total.cacheWrite + each.cacheWrite,
      output: total.output + each.output,
    }),
    { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  );

const counting: ChatModelFactory = (spec) => {
  const model = createAiSdkChatModel(spec);
  return new Proxy(model, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "doGenerate" && typeof value === "function")
        return async (...args: unknown[]) => {
          const result = (await value.apply(target, args)) as { usage?: Usage };
          billed.push(billedOf(result.usage));
          return result;
        };
      if (property === "doStream" && typeof value === "function")
        return async (...args: unknown[]) => {
          const result = (await value.apply(target, args)) as {
            stream: ReadableStream<{ type: string; usage?: Usage }>;
          };
          const [given, read] = result.stream.tee();
          const entry = billedOf(undefined);
          billed.push(entry);
          void (async () => {
            const reader = read.getReader();
            for (let part = await reader.read(); !part.done; part = await reader.read())
              if (part.value.type === "finish") Object.assign(entry, billedOf(part.value.usage));
          })().catch(() => {
            // A stream that failed or was stopped costs what its finish part said, if it came.
          });
          return { ...result, stream: given };
        };
      return value;
    },
  });
};

/** The figure an Answer's number is, among the reference's: the nearest within its rounding. */
function referenced(value: number, reference: ReadonlyMap<string, number>): string | null {
  for (const [name, known] of reference)
    if (Math.abs(known - value) <= Math.max(1e-9, Math.abs(known) * 1e-9)) return name;
  return null;
}

interface Counts {
  tables: number;
  columns: number;
  columnsRecalculated: number;
  figures: number;
  figuresRecalculated: number;
  figuresWithRows: number;
  falseSupported: string[];
  lookOnAnalysis: string[];
  charts: number;
  chartValuesUncited: number;
}

async function noteCounts(
  core: Core,
  mindId: string,
  doc: Y.Doc,
  language: "en" | "zh-CN",
  reference: ReadonlyMap<string, number> | null,
): Promise<{ counts: Counts; lines: string[] }> {
  const blocks = topLevelBlocks(doc.getXmlFragment(MIND_CONTENT_FIELD)).map(nodeOf);
  const versions = liveVersions(await core.listDocuments());
  const lines: string[] = [];
  const counts: Counts = {
    tables: 0,
    columns: 0,
    columnsRecalculated: 0,
    figures: 0,
    figuresRecalculated: 0,
    figuresWithRows: 0,
    falseSupported: [],
    lookOnAnalysis: [],
    charts: 0,
    chartValuesUncited: 0,
  };
  const textIn = (node: NodeJSON): string =>
    node.type === "text" ? (node.text ?? "") : (node.content ?? []).map(textIn).join(" ");
  for (const block of blocks) {
    const binding = readTableBinding(block.attrs?.[ANALYSIS_TABLE_ATTRIBUTE]);
    lines.push(
      `  block ${block.type}${binding ? ` bound ${JSON.stringify(binding.table)}` : ""}: ${textIn(block).replace(/\s+/g, " ").slice(0, 140)}`,
    );
  }
  for (const block of blocks) {
    if (block.type === CHART_NODE && block.attrs) {
      counts.charts++;
      counts.chartValuesUncited += chartSources(readChart(block.attrs)).uncited;
    }
    if (block.type !== "table" || !readTableBinding(block.attrs?.[ANALYSIS_TABLE_ATTRIBUTE]))
      continue;
    counts.tables++;
    const shown = tableShownIn(doc, block, language, versions);
    lines.push(`- table: ${shown.state.kind}`);
    for (const column of shown.columns) {
      counts.columns++;
      if (column.rule) counts.columnsRecalculated++;
      lines.push(
        `  - ${columnLine(column, language)}${column.rule ? ` (${column.rule.how} of ${column.rule.value} by ${column.rule.key})` : ""}`,
      );
    }
  }
  const schedule = await core.getFigureSchedule(mindId);
  const figures = (nodes: readonly NodeJSON[]): NodeJSON[] =>
    nodes.flatMap((node) => [
      ...(node.type === CALCULATED_FIGURE_NODE ? [node] : []),
      ...figures(node.content ?? []),
    ]);
  for (const node of figures(blocks)) {
    const attributes = readCalculatedFigureAttributes(node.attrs ?? {});
    if (!attributes?.figure.analysis) continue;
    counts.figures++;
    const [run] = figureRunsFor(doc, [node]);
    const value = run?.values.find((each) => each.name === attributes.figure.analysis?.result);
    if (value?.of) counts.figuresWithRows++;
    const row = schedule.rows.find((each) => each.id === attributes.id);
    if (row?.shown.state === "supported") {
      counts.figuresRecalculated++;
      const numeric = typeof attributes.figure.value === "number" ? attributes.figure.value : NaN;
      if (reference && referenced(numeric, reference) === null)
        counts.falseSupported.push(`${attributes.figure.shown} ${attributes.figure.label}`);
    }
    lines.push(
      `- figure ${attributes.figure.shown} ${attributes.figure.label}: ${row?.shown.state ?? "?"}${value?.of ? `, rows named (${value.of.count})` : ", no rows named"}`,
    );
  }
  // After Check: an Analysis's figure judged against the text, and every mark that needs a look.
  const seen = new Set<string>();
  const marked = (node: NodeJSON) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== CLAIM_CHECK_MARK) continue;
      const check = readClaimCheck(mark.attrs);
      if (!check || seen.has(check.id)) continue;
      seen.add(check.id);
      const rows = (check.figures ?? []).map(
        (figure) =>
          `${figure.reading.chars}${figure.calculated?.figure.analysis ? " (Analysis)" : ""} ${figure.state}`,
      );
      if (check.state === "unsupported" || check.state === "contradicted")
        lines.push(`- needs a look, ${check.state}: ${check.text} [${rows.join("; ")}]`);
      for (const figure of check.figures ?? [])
        if (
          figure.calculated?.figure.analysis &&
          (figure.state === "unsupported" || figure.state === "contradicted")
        )
          counts.lookOnAnalysis.push(`${figure.reading.chars}: ${check.text}`);
    }
    for (const child of node.content ?? []) marked(child);
  };
  for (const block of blocks) marked(block);
  return { counts, lines };
}

async function ask(core: Core, text: string): Promise<ConversationAnswer> {
  const asked = await core.askInConversation({ text });
  if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
  await answerEnded(core, asked.answerId);
  const { messages } = await core.getConversation(asked.conversation.id);
  const answer = messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

let runtime: Promise<AnalysisRuntime> | undefined;

const WALK: TableHeldOut[] = [
  {
    name: "the 11-04 walk",
    language: "en",
    question:
      "Using Orders.csv: total the amount by region, fit a linear trend of the amount against the order date and give its slope per day, and make a bar chart of the totals by region. Write the table and the chart into a new note called Orders analysis.",
    read: "The walk: totals never Not found, the slope never Unsupported, the chart cited, one table.",
  },
  {
    name: "the 11-04 walk in Chinese",
    language: "zh-CN",
    question:
      "用 Orders.csv：按地区汇总金额，对金额和下单日期做线性趋势拟合并给出每天的斜率，再画一张各地区合计的柱状图。把表格和图表写进名为「订单分析」的新笔记。",
    read: "同上，中文。",
  },
];

const SHIPMENTS = new Set(FIGURES_HELD_OUT.map((held) => held.name));

const ALL = [...TABLES_HELD_OUT, ...FIGURES_HELD_OUT, ...WALK].filter(
  (held) => !PICKED || PICKED.includes(held.name),
);

test.skipIf(KEY === undefined).each(ALL.map((held) => ({ ...held })))(
  "$name ($language): the Analysis's tables are judged from their run, never against the text",
  { timeout: 1_800_000 },
  async (held) => {
    if (spent() > MAX_USD) return;
    runtime ??= pyodideAnalysisRuntime();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: counting,
      analysisRuntime: await runtime,
    });
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
    if (held.language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });
    const walk = WALK.some((each) => each.name === held.name);
    const shipments = SHIPMENTS.has(held.name);
    const file = walk
      ? join(process.cwd(), "tests/fixtures/formats/Orders.csv")
      : await writeSourceFile(
          await createTempDataFolder(),
          shipments ? SHIPMENTS_FILE : CLINIC_FILE,
          new Uint8Array(shipments ? shipmentsWorkbook() : clinicWorkbook()),
        );
    await addAndProcess(core, [file]);
    const before = spent();
    const answer = await ask(core, held.question);
    const made = answer.toolCalls.find((call) => call.mindChange?.created)?.mindChange?.mindId;
    const report = [
      `## ${held.name} (${held.language}) · ${MODEL}`,
      `Read for: ${held.read}`,
      `Tools: ${answer.toolCalls.map((call) => `${call.tool} ${call.status}`).join(", ")}`,
      ...answer.toolCalls
        .filter((call) => call.source === "minds" || call.tool === "run_analysis")
        .map((call) => `  ${call.tool}: ${JSON.stringify(call.input).slice(0, 900)}`),
      "",
      answer.text,
      "",
    ];
    let counts: Counts | null = null;
    if (made) {
      const client = await connectToMind(core, made);
      await client.settled();
      await resolveChanges(client, "accept");
      const checked = await core.checkMind({ requestId: randomUUID(), mindId: made, mode: "all" });
      await client.settled();
      const read = await noteCounts(
        core,
        made,
        client.doc,
        held.language,
        walk ? null : shipments ? shipmentsReference() : clinicReference(),
      );
      counts = read.counts;
      report.push(`Check: ${checked.kind}`, ...read.lines, `Counts: ${JSON.stringify(counts)}`);
    } else report.push("No Note was made.");
    report.push(
      `Spent: $${(spent() - before).toFixed(4)}; so far $${spent().toFixed(4)}`,
      `Tokens so far: ${JSON.stringify(tokens())}`,
      "",
    );
    if (process.env.INCARNAMIND_LIVE_REPORT)
      await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n`);
    core.close();
    expect(counts?.falseSupported ?? []).toEqual([]);
    expect(counts?.lookOnAnalysis ?? []).toEqual([]);
  },
);
