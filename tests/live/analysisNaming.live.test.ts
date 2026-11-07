/**
 * The claim judge's naming of an Analysis's figure on a real model (#2378). Each case writes its
 * one sentence into a Note of its own, from a scripted Answer whose Analysis gave the figure, and
 * Check judges it on the model: never a false Supported, and how many right names read Supported.
 *
 * INCARNAMIND_LIVE_ANTHROPIC_KEY runs it. INCARNAMIND_LIVE_SET picks "probes" (development),
 * "held-out" (the first held-out set, built against since), "gate" (the set the change was first
 * gated on) or "wide" (other Documents, Answer shapes and wordings); INCARNAMIND_LIVE_RIGHT_ONLY=1 runs only the right names, as main is scored on;
 * INCARNAMIND_LIVE_REPORT appends a line per case.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { expect, test } from "vitest";
import { createFakeAnalysisRuntime, type FakeAnswer } from "../../src/core/analysis/fake";
import { nodeOf, topLevelBlocks } from "../../src/core/answers/blocks";
import { CLAIM_CHECK_MARK, MIND_CONTENT_FIELD } from "../../src/core/api";
import { writeXlsx } from "../../src/core/exports/xlsx";
import { type AnalysisValue, noAnalysisOutput } from "../../src/shared/analysis";
import type { NodeJSON } from "../../src/shared/blockJson";
import { readClaimCheck } from "../../src/shared/claimChecks";
import { NAMING_GATE } from "../helpers/analysisNamingGate";
import { NAMING_HELD_OUT } from "../helpers/analysisNamingHeldOut";
import {
  type How,
  LABELS,
  NAMING_PROBES,
  type NamingCase,
  type Region,
} from "../helpers/analysisNamingProbes";
import {
  DATASETS,
  NAMING_WIDE,
  type WideCase,
  type WideDataset,
  wideLabel,
} from "../helpers/analysisNamingWide";
import { askAssistant } from "../helpers/assistant";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess } from "../helpers/documents";
import { billedModels } from "../helpers/liveBilling";
import { routedChecks } from "../helpers/liveChecks";
import { connectToMind } from "../helpers/mindClient";
import { resolveChanges } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const MAX_USD = Number(process.env.INCARNAMIND_LIVE_MAX_USD ?? Number.POSITIVE_INFINITY);
const SET =
  process.env.INCARNAMIND_LIVE_SET === "gate"
    ? NAMING_GATE
    : process.env.INCARNAMIND_LIVE_SET === "held-out"
      ? NAMING_HELD_OUT
      : NAMING_PROBES;
const RIGHT_ONLY = process.env.INCARNAMIND_LIVE_RIGHT_ONLY === "1";
const WIDE = process.env.INCARNAMIND_LIVE_SET === "wide";
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const { createChatModel: real, spent } = billedModels(MODEL);

const ORDERS = join(process.cwd(), "tests/fixtures/formats/Orders.csv");

/** Each region's rows of Orders.csv, by their row number in the sheet, and their amounts. */
const ROWS = (() => {
  const rows = new Map<Region, { row: number; amount: number }[]>();
  readFileSync(ORDERS, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .forEach((line, at) => {
      const cells = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      const region = cells[3] as Region;
      rows.set(region, [...(rows.get(region) ?? []), { row: at + 2, amount: Number(cells[4]) }]);
    });
  return rows;
})();

const runsOf = (rows: readonly number[]) =>
  rows.reduce<[number, number][]>((runs, row) => {
    const last = runs.at(-1);
    if (last && row === last[1] + 1) last[1] = row;
    else runs.push([row, row]);
    return runs;
  }, []);

function figureOf(
  language: NamingCase["language"],
  region: Region,
  how: How,
  label: string,
  at: number,
): AnalysisValue {
  const rows = ROWS.get(region) ?? [];
  const amounts = rows.map((each) => each.amount);
  const total = amounts.reduce((sum, each) => sum + each, 0);
  const value =
    how === "sum"
      ? total
      : how === "mean"
        ? total / amounts.length
        : how === "max"
          ? Math.max(...amounts)
          : rows.length;
  return {
    kind: "figure",
    name: `figure_${at + 1}`,
    label: label || LABELS[language][how](region),
    unit: "",
    value,
    of: {
      input: "orders",
      columns: ["amount"],
      rows: runsOf(rows.map((each) => each.row)),
      count: rows.length,
      how,
    },
  };
}

const TABLE_LABEL = { en: "Total amount by region", "zh-CN": "各地区金额合计" } as const;

function analysisOf(held: NamingCase): { answer: FakeAnswer; code: string } {
  const figures = held.figures.map(({ region, how, label }, at) =>
    figureOf(held.language, region, how, label ?? "", at),
  );
  const totals = [...ROWS].map(([region, rows]) => [
    region,
    rows.reduce((sum, each) => sum + each.amount, 0),
  ]);
  const pandas: Record<How, string> = { sum: "sum", mean: "mean", max: "max", count: "count" };
  const code = [
    'df = inputs["orders"]',
    'totals = df.groupby("region", as_index=False)["amount"].sum()',
    `result("region_totals", totals, "${TABLE_LABEL[held.language]}")`,
    ...held.figures.map(
      ({ region, how }, at) =>
        `figure("figure_${at + 1}", df[df["region"] == "${region}"]["amount"], "${pandas[how]}", "${figures[at]?.label ?? ""}")`,
    ),
  ].join("\n");
  return {
    code,
    answer: {
      output: {
        ...noAnalysisOutput(),
        results: [
          {
            kind: "table",
            name: "region_totals",
            label: TABLE_LABEL[held.language],
            unit: "",
            table: {
              columns: ["region", "amount"],
              rows: totals,
              rowCount: totals.length,
              columnCount: 2,
            },
          },
          ...figures,
        ],
      },
    },
  };
}

function answering(held: NamingCase, code: string) {
  const title = held.language === "en" ? "Orders analysis" : "订单分析";
  const content = [`# ${title}`, "", "[=table 1]", "", held.sentence].join("\n");
  return scriptedModel((call: ModelCall) => {
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search)
      return { calls: [{ tool: "search_documents", input: { query: "orders by region" } }] };
    if (!call.results.some((result) => result.tool === "run_analysis")) {
      const orders = shownPassages(search.text).find((each) => each.document.startsWith("Orders"));
      return {
        calls: [
          {
            tool: "run_analysis",
            input: {
              title: "Orders by region",
              inputs: [{ name: "orders", passage: orders?.id ?? "" }],
              code,
            },
          },
        ],
      };
    }
    if (!call.results.some((result) => result.tool === "create_mind"))
      return { calls: [{ tool: "create_mind", input: { title, content } }] };
    return { text: held.language === "en" ? "Written into the note." : "已写入笔记。" };
  });
}

interface Read {
  figures: string[];
  sentence: string;
}

function readNote(blocks: readonly NodeJSON[], sentence: (text: string) => boolean): Read {
  const figures: string[] = [];
  let said = "none";
  const visit = (node: NodeJSON) => {
    for (const mark of node.marks ?? []) {
      const check = mark.type === CLAIM_CHECK_MARK ? readClaimCheck(mark.attrs) : null;
      if (!check?.figures?.some((figure) => figure.calculated?.figure.analysis)) continue;
      if (sentence(check.text))
        said = check.state === "not-checked" ? `not-checked ${check.reason}` : check.state;
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const block of blocks) visit(block);
  return { figures, sentence: said };
}

// A run split across processes, as "2/4": cores in one process share what they read Documents with.
const [part, parts] = (process.env.INCARNAMIND_LIVE_SHARD ?? "1/1").split("/").map(Number);
const CASES = SET.filter((held) => !RIGHT_ONLY || held.right).filter(
  (_, at) => at % (parts || 1) === (part || 1) - 1,
);

test.skipIf(KEY === undefined || WIDE).each(CASES.map((held) => ({ ...held })))(
  "$name: an Analysis figure's name is the claim judge's, never a false Supported",
  { timeout: 600_000 },
  async (held) => {
    if (spent() > MAX_USD) return;
    const { answer, code } = analysisOf(held);
    const heard: string[] = [];
    const core = startCore(await createTempDataFolder(), {
      createChatModel: routedChecks(answering(held, code), real, heard),
      analysisRuntime: createFakeAnalysisRuntime({ answer: () => answer }),
    });
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
    if (held.language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });
    await addAndProcess(core, [ORDERS]);
    const asked = await askAssistant(core, {
      text:
        held.language === "en"
          ? "Total the orders by region and write a note."
          : "按地区汇总订单并写成笔记。",
      mindId: (await core.createMind({ title: "Questions" })).id,
      analyse: true,
    });
    const made = asked.toolCalls.find(
      (call) => call.tool === "create_mind" && call.status === "done",
    )?.mindChange?.mindId;
    if (!made) throw new Error(`No Note: ${JSON.stringify(asked.toolCalls).slice(0, 600)}`);
    const client = await connectToMind(core, made);
    await client.settled();
    await resolveChanges(client, "accept");
    await core.checkMind({ requestId: randomUUID(), mindId: made, mode: "changed" });
    await client.settled();
    const schedule = await core.getFigureSchedule(made);
    const rows = schedule.rows.filter((row) => !row.analysisTable);
    const marker = held.sentence.split("[=1]")[0]?.trim().slice(0, 8) ?? "";
    const read = readNote(
      topLevelBlocks(client.doc.getXmlFragment(MIND_CONTENT_FIELD)).map(nodeOf),
      (text) => text.startsWith(marker),
    );
    read.figures.push(
      ...rows.map((row) =>
        row.shown.state === "not-checked" ? `not-checked ${row.shown.reason}` : row.shown.state,
      ),
    );
    core.close();
    const green =
      read.sentence === "supported" || read.figures.some((each) => each === "supported");
    const recalled =
      read.sentence === "supported" && read.figures.every((each) => each === "supported");
    const outcome = held.right
      ? recalled
        ? "recalled"
        : "missed"
      : green
        ? "FALSE SUPPORTED"
        : "held";
    if (REPORT)
      await appendFile(
        REPORT,
        `${JSON.stringify({ name: held.name, kind: held.kind, right: held.right, outcome, sentence: read.sentence, figures: read.figures, said: held.sentence, heard, spent: Number(spent().toFixed(4)) })}\n`,
      );
    if (!held.right) expect(outcome).toBe("held");
  },
);

/** A wide case's Document, written into its own data folder: a CSV, or a workbook of one sheet. */
async function writeDataset(set: WideDataset, folder: string): Promise<string> {
  const path = join(folder, set.file);
  if (set.kind === "csv") {
    await writeFile(path, [set.columns, ...set.rows].map((row) => row.join(",")).join("\n"));
    return path;
  }
  const cell = (value: string | number, column: number) => ({
    column: String(column),
    value:
      typeof value === "number"
        ? { kind: "number" as const, number: value }
        : { kind: "text" as const, text: value },
  });
  const book = writeXlsx(
    {
      sheets: [
        {
          id: "sheet",
          name: set.title.en,
          columns: set.columns.map((_, at) => ({ id: String(at) })),
          rows: [set.columns, ...set.rows].map((row, at) => ({
            id: String(at),
            ...(at === 0 && { header: true }),
            cells: row.map(cell),
          })),
        },
      ],
    },
    deflateRawSync,
    { author: "Test", created: "2026-11-05T00:00:00.000Z" },
  );
  await writeFile(path, book);
  return path;
}

function wideAnalysis(held: WideCase): { answer: FakeAnswer; code: string } {
  const set: WideDataset = DATASETS[held.figure.dataset];
  const { key, column, how } = { key: set.key, ...held.figure };
  const keyAt = set.columns.indexOf(key);
  const valueAt = set.columns.indexOf(column);
  const [, , first = column] = set.columns;
  const firstAt = set.columns.indexOf(first);
  const rows = set.rows.flatMap((row, at) =>
    row[keyAt] === held.figure.group ? [{ row: at + 2, value: Number(row[valueAt]) }] : [],
  );
  const values = rows.map((each) => each.value);
  const total = values.reduce((sum, each) => sum + each, 0);
  const value =
    how === "sum" ? total : how === "mean" ? total / values.length : Math.max(...values);
  const label = wideLabel(held.language, held.figure);
  const groups = [...new Set(set.rows.map((row) => String(row[keyAt])))];
  const totals = groups.map((group) => [
    group,
    set.rows
      .filter((row) => row[keyAt] === group)
      .reduce((sum, row) => sum + Number(row[firstAt]), 0),
  ]);
  const code = [
    `df = inputs["${set.input}"]`,
    `totals = df.groupby("${key}", as_index=False)["${first}"].sum()`,
    `result("totals", totals, "${set.title[held.language]}")`,
    `figure("figure_1", df[df["${key}"] == "${held.figure.group}"]["${column}"], "${how}", "${label}")`,
  ].join("\n");
  return {
    code,
    answer: {
      output: {
        ...noAnalysisOutput(),
        results: [
          {
            kind: "table",
            name: "totals",
            label: set.title[held.language],
            unit: set.units[first] ?? "",
            table: { columns: [key, first], rows: totals, rowCount: totals.length, columnCount: 2 },
          },
          {
            kind: "figure",
            name: "figure_1",
            label,
            unit: set.units[column] ?? "",
            value,
            of: {
              input: set.input,
              columns: [column],
              rows: runsOf(rows.map((each) => each.row)),
              count: rows.length,
              how,
            },
          },
        ],
      },
    },
  };
}

function wideContent(held: WideCase): string {
  const { shape, sentence } = held;
  const body =
    shape.kind === "prose"
      ? `${shape.before ? `${shape.before} ` : ""}${sentence}`
      : shape.kind === "list"
        ? `- ${sentence}`
        : shape.kind === "heading"
          ? `## ${shape.heading}\n\n${sentence}`
          : `| ${shape.headings[0]} | ${shape.headings[1]} |\n| --- | --- |\n| ${shape.label} | ${sentence} |`;
  return [
    `# ${DATASETS[held.figure.dataset].title[held.language]}`,
    "",
    "[=table 1]",
    "",
    body,
  ].join("\n");
}

function wideAnswering(held: WideCase, code: string) {
  const set: WideDataset = DATASETS[held.figure.dataset];
  const title = set.title[held.language];
  const content = wideContent(held);
  return scriptedModel((call: ModelCall) => {
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: set.title.en } }] };
    if (!call.results.some((result) => result.tool === "run_analysis")) {
      const base = set.file.replace(/\.[a-z]+$/u, "");
      const passage = shownPassages(search.text).find((each) => each.document.startsWith(base));
      return {
        calls: [
          {
            tool: "run_analysis",
            input: { title, inputs: [{ name: set.input, passage: passage?.id ?? "" }], code },
          },
        ],
      };
    }
    if (!call.results.some((result) => result.tool === "create_mind"))
      return { calls: [{ tool: "create_mind", input: { title, content } }] };
    return { text: held.language === "en" ? "Written into the note." : "已写入笔记。" };
  });
}

const WIDE_CASES = NAMING_WIDE.filter((held) => !RIGHT_ONLY || held.right).filter(
  (_, at) => at % (parts || 1) === (part || 1) - 1,
);

test.skipIf(KEY === undefined || !WIDE).each(WIDE_CASES.map((held) => ({ ...held })))(
  "$name: an Analysis figure's name is the claim judge's, in any Document and Answer shape",
  { timeout: 600_000 },
  async (held) => {
    if (spent() > MAX_USD) return;
    const set: WideDataset = DATASETS[held.figure.dataset];
    const { answer, code } = wideAnalysis(held);
    const heard: string[] = [];
    const folder = await createTempDataFolder();
    const core = startCore(folder, {
      createChatModel: routedChecks(wideAnswering(held, code), real, heard),
      analysisRuntime: createFakeAnalysisRuntime({ answer: () => answer }),
    });
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
    if (held.language === "zh-CN") await core.updateSettings({ user: { language: "zh-CN" } });
    await addAndProcess(core, [await writeDataset(set, await createTempDataFolder())]);
    const asked = await askAssistant(core, {
      text:
        held.language === "en"
          ? `Summarise ${set.title.en} by ${set.key} and write a note.`
          : `按${set.key}汇总${set.title["zh-CN"]}并写成笔记。`,
      mindId: (await core.createMind({ title: "Questions" })).id,
      analyse: true,
    });
    const made = asked.toolCalls.find(
      (call) => call.tool === "create_mind" && call.status === "done",
    )?.mindChange?.mindId;
    if (!made) throw new Error(`No Note: ${JSON.stringify(asked.toolCalls).slice(0, 600)}`);
    const client = await connectToMind(core, made);
    await client.settled();
    await resolveChanges(client, "accept");
    await core.checkMind({ requestId: randomUUID(), mindId: made, mode: "changed" });
    await client.settled();
    const rows = (await core.getFigureSchedule(made)).rows.filter((row) => !row.analysisTable);
    const read = readNote(
      topLevelBlocks(client.doc.getXmlFragment(MIND_CONTENT_FIELD)).map(nodeOf),
      () => true,
    );
    read.figures.push(
      ...rows.map((row) =>
        row.shown.state === "not-checked" ? `not-checked ${row.shown.reason}` : row.shown.state,
      ),
    );
    core.close();
    const green =
      read.sentence === "supported" || read.figures.some((each) => each === "supported");
    const recalled =
      read.sentence === "supported" && read.figures.every((each) => each === "supported");
    const outcome = held.right
      ? recalled
        ? "recalled"
        : "missed"
      : green
        ? "FALSE SUPPORTED"
        : "held";
    if (REPORT)
      await appendFile(
        REPORT,
        `${JSON.stringify({ name: held.name, kind: held.kind, right: held.right, outcome, sentence: read.sentence, figures: read.figures, said: held.sentence, heard, spent: Number(spent().toFixed(4)) })}\n`,
      );
    if (!held.right) expect(outcome).toBe("held");
  },
);
