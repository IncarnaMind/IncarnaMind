/**
 * Honest sentences whose figures test the Units guard (#3806): same amount at another scale or
 * exact unit conversion, figures worked out from stated amounts (including run_analysis over sheet
 * rows and Library counts), units stated away from the figure in a multi-passage Document, and a
 * sentence with two stated amounts, in English and Chinese.
 *
 * Every sentence here is true and Supported against its Documents; none should be lowered by the
 * Units guard. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY (or INCARNAMIND_LIVE_PROVIDER=deepseek
 * with DEEPSEEK_API_KEY), so `npx vitest run` makes no request without one.
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import type { AnalysisRuntime, ChatModelFactory, ClaimCheckAttributes, Core } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";
import { pyodideAnalysisRuntime } from "../helpers/pyodideAnalysis";

const DEEPSEEK = process.env.INCARNAMIND_LIVE_PROVIDER === "deepseek";
const PROVIDER = DEEPSEEK ? "deepseek" : "anthropic";
const KEY = DEEPSEEK ? process.env.DEEPSEEK_API_KEY : process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = DEEPSEEK
  ? (process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ?? "deepseek-flash")
  : (process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5");
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "5");
const ARM = process.env.INCARNAMIND_LIVE_ARM ?? "branch";
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const ASSERT = process.env.INCARNAMIND_LIVE_ASSERT !== "0";

type Language = "en" | "zh";
type Category = "scale-convert" | "worked-out" | "distant-unit" | "two-amounts";

interface ProbeFile {
  name: string;
  content: string | Uint8Array;
}

interface ProbeCase {
  id: string;
  category: Category;
  language: Language;
  files: readonly ProbeFile[];
  sentence: string;
  needsAnalysis?: boolean;
}

const enFiller = (topic: string, count: number): string[] =>
  Array.from(
    { length: count },
    (_, i) =>
      `${topic} review note ${i + 1}: Regional managers completed routine safety inspections, equipment servicing, depot scheduling, warehouse auditing, supplier onboarding and quality assurance checks across every operating site during the reporting period without disruption to regular customer deliveries.`,
  );

const zhFiller = (topic: string, count: number): string[] =>
  Array.from(
    { length: count },
    (_, i) =>
      `${topic}运营回顾第${i + 1}条：各区域管理团队在报告期内按计划完成了安全巡检、设备保养、仓储盘点、物流排班、供应商复审及质量抽检等常规工作，各生产与配送节点运行平稳，未对日常客户交付造成影响。`,
  );

const enManyRows = (): string =>
  [
    "# Segment Cash Flow Report",
    "",
    ...enFiller("Operations", 10),
    "",
    "Table 2: Segment Cash Flow (EUR thousand)",
    "",
    "| Segment | Cash Flow |",
    "| --- | --- |",
    ...Array.from({ length: 24 }, (_, i) => `| Division ${i + 1} | ${(i + 1) * 110} |`),
    "| Nordic Logistics | 4,320 |",
    "",
  ].join("\n");

const zhManyRows = (): string =>
  [
    "# 分部现金流报告",
    "",
    ...zhFiller("业务", 10),
    "",
    "表2：分部现金流（单位：千欧元）",
    "",
    "| 分部 | 现金流 |",
    "| --- | --- |",
    ...Array.from({ length: 24 }, (_, i) => `| 业务部${i + 1} | ${(i + 1) * 110} |`),
    "| 北欧物流 | 4,320 |",
    "",
  ].join("\n");

const enTableNote = (): string =>
  [
    "# Infrastructure Maintenance Review",
    "",
    ...enFiller("Maintenance", 10),
    "",
    "Table 3: Maintenance Spending",
    "",
    "| Programme | Spend |",
    "| --- | --- |",
    "| Bridge repairs | 14.5 |",
    ...Array.from({ length: 12 }, (_, i) => `| Track section ${i + 1} | ${(i + 2).toFixed(1)} |`),
    "",
    "Note: All figures in Table 3 are in USD million.",
    "",
  ].join("\n");

const zhTableNote = (): string =>
  [
    "# 基础设施维修支出回顾",
    "",
    ...zhFiller("维修", 10),
    "",
    "表3：维修支出",
    "",
    "| 项目 | 支出 |",
    "| --- | --- |",
    "| 桥梁维修 | 14.5 |",
    ...Array.from({ length: 12 }, (_, i) => `| 线路段${i + 1} | ${(i + 2).toFixed(1)} |`),
    "",
    "注：表3所有金额均以美元百万元计。",
    "",
  ].join("\n");

const enSharedTables = (): string =>
  [
    "# Alpine Holdings Financial Summary",
    "",
    "All tables in this section are in CHF million.",
    "",
    "## Table 1: Revenue",
    "| Region | 2025 |",
    "| --- | --- |",
    "| Zurich | 82.0 |",
    "| Geneva | 64.5 |",
    "",
    ...enFiller("Alpine segment", 8),
    "",
    "## Table 2: Operating Costs",
    "| Cost line | 2025 |",
    "| --- | --- |",
    "| Payroll | 51.2 |",
    "| Energy | 18.7 |",
    "",
    ...enFiller("Alpine cost", 8),
    "",
    "## Table 3: Cash Generation",
    "| Metric | 2025 |",
    "| --- | --- |",
    "| Operating cash flow | 41.8 |",
    "| Free cash flow | 29.4 |",
    "",
  ].join("\n");

const zhSharedTables = (): string =>
  [
    "# 阿尔卑斯控股财务摘要",
    "",
    "本节所有表格金额单位均为瑞士法郎百万元。",
    "",
    "## 表1：营业收入",
    "| 区域 | 2025年 |",
    "| --- | --- |",
    "| 苏黎世 | 82.0 |",
    "| 日内瓦 | 64.5 |",
    "",
    ...zhFiller("分部收入", 8),
    "",
    "## 表2：营业成本",
    "| 成本项 | 2025年 |",
    "| --- | --- |",
    "| 人工 | 51.2 |",
    "| 能源 | 18.7 |",
    "",
    ...zhFiller("成本结构", 8),
    "",
    "## 表3：现金流",
    "| 指标 | 2025年 |",
    "| --- | --- |",
    "| 经营活动现金流 | 41.8 |",
    "| 自由现金流 | 29.4 |",
    "",
  ].join("\n");

const PROBE_CASES: readonly ProbeCase[] = [
  // 1. Same amount at another scale word or exact unit conversion.
  {
    id: "en-scale-gbp",
    category: "scale-convert",
    language: "en",
    files: [
      {
        name: "Brampton Capex.md",
        content: "# Brampton Capex\n\nCapital expenditure in 2025 was £1.2 million.\n",
      },
    ],
    sentence: "Capital expenditure in 2025 was £1,200,000.",
  },
  {
    id: "en-scale-months",
    category: "scale-convert",
    language: "en",
    files: [
      {
        name: "Licence Terms.md",
        content: "# Licence Terms\n\nThe licence runs for 3 years from signing.\n",
      },
    ],
    sentence: "The licence runs for 36 months from signing.",
  },
  {
    id: "zh-scale-wan",
    category: "scale-convert",
    language: "zh",
    files: [
      {
        name: "出货简报.md",
        content: "# 出货简报\n\n2025年出货量为1.8万件。\n",
      },
    ],
    sentence: "2025年出货量为18,000件。",
  },
  {
    id: "zh-scale-rmb",
    category: "scale-convert",
    language: "zh",
    files: [
      {
        name: "资本开支说明.md",
        content: "# 资本开支说明\n\n2025年资本开支为1.2百万元人民币。\n",
      },
    ],
    sentence: "2025年资本开支为1,200,000元人民币。",
  },
  {
    id: "zh-scale-months",
    category: "scale-convert",
    language: "zh",
    files: [
      {
        name: "许可协议.md",
        content: "# 许可协议\n\n该许可协议自签署之日起有效期为3年。\n",
      },
    ],
    sentence: "该许可协议自签署之日起有效期为36个月。",
  },

  // 2. Figure worked out from stated amounts, sheet rows, or Library counts.
  {
    id: "en-worked-leverage",
    category: "worked-out",
    language: "en",
    files: [
      {
        name: "Cairn Debt.md",
        content: [
          "# Cairn Group Results",
          "All amounts are in GBP million.",
          "",
          "Net debt at year end was 360.0.",
          "Adjusted EBITDA for the year was 120.0.",
        ].join("\n"),
      },
    ],
    sentence: "Year-end leverage (net debt to Adjusted EBITDA) was 3.0x.",
  },
  {
    id: "en-worked-pct",
    category: "worked-out",
    language: "en",
    files: [
      {
        name: "Denby Sales.md",
        content: [
          "# Denby Retail",
          "All amounts are in USD million.",
          "",
          "Online sales were 30.0 out of total sales of 120.0.",
        ].join("\n"),
      },
    ],
    sentence: "Online sales accounted for 25% of total sales.",
  },
  {
    id: "en-worked-pp",
    category: "worked-out",
    language: "en",
    files: [
      {
        name: "Elgin Margins.md",
        content: "# Elgin Margins\n\nGross margin rose from 31.5% in 2024 to 34.0% in 2025.\n",
      },
    ],
    sentence: "Gross margin increased by 2.5 percentage points in 2025.",
  },
  {
    id: "en-worked-rows",
    category: "worked-out",
    language: "en",
    needsAnalysis: true,
    files: [
      {
        name: "Regional Revenue.csv",
        content: [
          "Store,Revenue (GBP million)",
          ...Array.from(
            { length: 120 },
            (_, i) => `Store ${i + 1},${(0.25 + (i % 6) * 0.1).toFixed(2)}`,
          ),
        ].join("\n"),
      },
    ],
    sentence: "Total revenue across all 120 stores in Regional Revenue.csv was £60.0m.",
  },
  {
    id: "en-worked-library",
    category: "worked-out",
    language: "en",
    needsAnalysis: true,
    files: [
      { name: "Brief Alpha.md", content: "# Brief Alpha\n\nAlpha operations note.\n" },
      { name: "Brief Beta.md", content: "# Brief Beta\n\nBeta operations note.\n" },
      { name: "Brief Gamma.md", content: "# Brief Gamma\n\nGamma operations note.\n" },
    ],
    sentence: "There are 3 documents in this folder.",
  },
  {
    id: "zh-worked-leverage",
    category: "worked-out",
    language: "zh",
    files: [
      {
        name: "凯恩债务.md",
        content: [
          "# 凯恩集团业绩",
          "金额单位：人民币百万元。",
          "",
          "年末净负债为360.0。",
          "全年调整后EBITDA为120.0。",
        ].join("\n"),
      },
    ],
    sentence: "年末杠杆率（净负债与调整后EBITDA之比）为3.0倍。",
  },
  {
    id: "zh-worked-pct",
    category: "worked-out",
    language: "zh",
    files: [
      {
        name: "丹比销售.md",
        content: [
          "# 丹比零售",
          "金额单位：美元百万元。",
          "",
          "线上销售额为30.0，总销售额为120.0。",
        ].join("\n"),
      },
    ],
    sentence: "线上销售额占总销售额的25%。",
  },
  {
    id: "zh-worked-pp",
    category: "worked-out",
    language: "zh",
    files: [
      {
        name: "埃尔金毛利率.md",
        content: "# 埃尔金毛利率\n\n毛利率由2024年的31.5%上升至2025年的34.0%。\n",
      },
    ],
    sentence: "2025年毛利率上升了2.5个百分点。",
  },
  {
    id: "zh-worked-rows",
    category: "worked-out",
    language: "zh",
    needsAnalysis: true,
    files: [
      {
        name: "门店收入.csv",
        content: [
          "门店,收入（人民币百万元）",
          ...Array.from(
            { length: 120 },
            (_, i) => `门店${i + 1},${(0.25 + (i % 6) * 0.1).toFixed(2)}`,
          ),
        ].join("\n"),
      },
    ],
    sentence: "门店收入.csv 中全部120家门店的总收入为60.0百万元人民币。",
  },
  {
    id: "zh-worked-library",
    category: "worked-out",
    language: "zh",
    needsAnalysis: true,
    files: [
      { name: "简报甲.md", content: "# 简报甲\n\n甲项目运营纪要。\n" },
      { name: "简报乙.md", content: "# 简报乙\n\n乙项目运营纪要。\n" },
      { name: "简报丙.md", content: "# 简报丙\n\n丙项目运营纪要。\n" },
    ],
    sentence: "该文件夹中共有3个文档。",
  },

  // 3. Unit stated away from the figure in a multi-passage Document.
  {
    id: "en-distant-page1",
    category: "distant-unit",
    language: "en",
    files: [
      {
        name: "Alderwood Annual Report 2025.pdf",
        content: buildPdf([
          {
            lines: [
              "Alderwood Group Annual Report 2025",
              "All amounts in £m unless otherwise stated.",
              ...enFiller("Page 1", 6),
            ],
          },
          { lines: ["Operational Review", ...enFiller("Page 2", 8)] },
          { lines: ["Governance Review", ...enFiller("Page 3", 8)] },
          {
            lines: [
              "Financial Performance",
              "Operating profit for the year was 84.6.",
              "Closing cash balance stood at 31.2.",
            ],
          },
        ]),
      },
    ],
    sentence: "Alderwood Group's operating profit for 2025 was £84.6m.",
  },
  {
    id: "en-distant-table-header",
    category: "distant-unit",
    language: "en",
    files: [{ name: "Segment Cash Flow.md", content: enManyRows() }],
    sentence: "Nordic Logistics segment cash flow was €4,320 thousand.",
  },
  {
    id: "en-distant-table-note",
    category: "distant-unit",
    language: "en",
    files: [{ name: "Maintenance Review.md", content: enTableNote() }],
    sentence: "Bridge repairs maintenance spending was $14.5m.",
  },
  {
    id: "en-distant-shared-tables",
    category: "distant-unit",
    language: "en",
    files: [{ name: "Alpine Summary.md", content: enSharedTables() }],
    sentence: "Free cash flow was CHF 29.4 million.",
  },
  {
    id: "zh-distant-page1",
    category: "distant-unit",
    language: "zh",
    files: [
      {
        name: "青松集团2025年年度报告.pdf",
        content: buildPdf([
          {
            chineseLines: [
              "青松集团2025年年度报告",
              "除另有说明外，金额单位均为人民币百万元。",
              ...zhFiller("第一页", 6),
            ],
          },
          { chineseLines: ["经营回顾", ...zhFiller("第二页", 8)] },
          { chineseLines: ["公司治理", ...zhFiller("第三页", 8)] },
          {
            chineseLines: ["财务表现", "全年营业利润为84.6。", "期末现金余额为31.2。"],
          },
        ]),
      },
    ],
    sentence: "青松集团2025年营业利润为84.6百万元人民币。",
  },
  {
    id: "zh-distant-table-header",
    category: "distant-unit",
    language: "zh",
    files: [{ name: "分部现金流.md", content: zhManyRows() }],
    sentence: "北欧物流分部现金流为4,320千欧元。",
  },
  {
    id: "zh-distant-table-note",
    category: "distant-unit",
    language: "zh",
    files: [{ name: "维修支出回顾.md", content: zhTableNote() }],
    sentence: "桥梁维修支出为14.5百万美元。",
  },
  {
    id: "zh-distant-shared-tables",
    category: "distant-unit",
    language: "zh",
    files: [{ name: "阿尔卑斯摘要.md", content: zhSharedTables() }],
    sentence: "自由现金流为29.4百万瑞士法郎。",
  },

  // 4. One sentence with two amounts, both stated.
  {
    id: "en-two-amounts",
    category: "two-amounts",
    language: "en",
    files: [
      {
        name: "Farrow Revenue.md",
        content: [
          "# Farrow Trading",
          "All figures in GBP million.",
          "",
          "Revenue rose from 410.2 in 2024 to 455.8 in 2025.",
        ].join("\n"),
      },
    ],
    sentence: "Revenue rose from £410.2m in 2024 to £455.8m in 2025.",
  },
  {
    id: "zh-two-amounts",
    category: "two-amounts",
    language: "zh",
    files: [
      {
        name: "法罗营收.md",
        content: [
          "# 法罗商贸",
          "金额单位：人民币百万元。",
          "",
          "营业收入由2024年的410.2增至2025年的455.8。",
        ].join("\n"),
      },
    ],
    sentence: "营业收入由2024年的410.2百万元人民币增至2025年的455.8百万元人民币。",
  },
];

const textNode = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content: [textNode(value)],
});

function checkOf(client: MindClient, sentence: string): ClaimCheckAttributes | null {
  return (
    claimSpans(readMind(client)).find((span) => span.sentence.text.trim() === sentence.trim())
      ?.check ?? null
  );
}

interface JudgeCapture {
  units: string | null;
  verdict: string | null;
}

function captureFrom(
  text: string,
  toolCalls: { toolName: string; input: unknown }[],
): JudgeCapture | null {
  const unitsLine = text.match(/^\s*Units\s*:\s*(.*)$/im)?.[1]?.trim() ?? null;
  const verdictLine = text.match(/^\s*Verdict\s*:\s*(.*)$/im)?.[1]?.trim() ?? null;
  const cite = toolCalls.findLast((c) => {
    if (c.toolName !== "cite") return false;
    const inp =
      typeof c.input === "string"
        ? (JSON.parse(c.input) as Record<string, unknown>)
        : ((c.input ?? {}) as Record<string, unknown>);
    return inp.verdict !== undefined || inp.units !== undefined;
  });
  const citeInput = cite
    ? typeof cite.input === "string"
      ? (JSON.parse(cite.input) as Record<string, unknown>)
      : ((cite.input ?? {}) as Record<string, unknown>)
    : null;
  const units = unitsLine ?? (typeof citeInput?.units === "string" ? citeInput.units : null);
  const verdict =
    verdictLine ?? (typeof citeInput?.verdict === "string" ? citeInput.verdict : null);
  return units !== null || verdict !== null ? { units, verdict } : null;
}

async function runCase(
  probe: ProbeCase,
  run: number,
  analysisRuntime: AnalysisRuntime | undefined,
) {
  const captured: JudgeCapture[] = [];
  const wrapped: ChatModelFactory = (spec) =>
    wrapLanguageModel({
      model: createAiSdkChatModel(spec),
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate }) => {
          const res = await doGenerate();
          const text = res.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("");
          const calls = res.content
            .filter((p) => p.type === "tool-call")
            .map((p) => ({ toolName: p.toolName, input: p.input }));
          const cap = captureFrom(text, calls);
          if (cap) captured.push(cap);
          return res;
        },
        wrapStream: async ({ doStream }) => {
          const res = await doStream();
          let text = "";
          const calls: { toolName: string; input: unknown }[] = [];
          const stream = res.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type === "text-delta") text += part.delta;
                if (part.type === "tool-call") {
                  calls.push({ toolName: part.toolName, input: part.input });
                }
                controller.enqueue(part);
              },
              flush() {
                const cap = captureFrom(text, calls);
                if (cap) captured.push(cap);
              },
            }),
          );
          return { ...res, stream };
        },
      },
    });

  const dataDir = await createTempDataFolder();
  const core: Core = startCore(dataDir, {
    createChatModel: wrapped,
    ...(probe.needsAnalysis && analysisRuntime ? { analysisRuntime } : {}),
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({ user: { language: probe.language === "zh" ? "zh-CN" : "en" } });
  await core.saveChatProvider({ kind: PROVIDER, apiKey: KEY ?? "", modelId: MODEL });

  const sources = await createTempDataFolder();
  const written = await Promise.all(
    probe.files.map((file) => writeSourceFile(sources, file.name, file.content)),
  );
  const added = await addAndProcess(core, written);
  const folder = await core.createLibraryGroup({ name: probe.id, description: "" });
  await core.moveToFolder({ documentIds: added.map((d) => d.id), folderId: folder.id });

  const mind = await core.createMind({ title: probe.id, folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [paragraph(probe.sentence)]);
  await client.settled();
  await core.checkMind({
    requestId: `probe-${probe.id}-${run}`,
    mindId: mind.id,
    mode: "all",
  });
  await client.settled();

  const lastJudge = captured.at(-1) ?? null;
  const check = checkOf(client, probe.sentence);
  const state = check?.state ?? "missing";
  const unsupportedKind = check?.unsupported?.kind ?? null;
  const unsupportedUnits = check?.unsupported?.units ?? null;
  const entry = {
    arm: ARM,
    provider: PROVIDER,
    model: MODEL,
    run,
    id: probe.id,
    category: probe.category,
    language: probe.language,
    state,
    notCheckedReason: check?.reason ?? null,
    unsupportedKind,
    unsupportedUnits,
    unitsWord: lastJudge?.units ?? null,
    rawVerdict: lastJudge?.verdict ?? null,
    loweredByUnits: state === "unsupported" && unsupportedKind === "units",
  };
  if (REPORT) await appendFile(REPORT, `${JSON.stringify(entry)}\n`);
  return entry;
}

describe.skipIf(!KEY)("honest probe for the Units guard (#3806)", () => {
  test(`${PROBE_CASES.length} honest sentences, ${RUNS} runs each (${PROVIDER}/${MODEL})`, {
    timeout: 3_600_000,
  }, async () => {
    const needsPython = PROBE_CASES.some((each) => each.needsAnalysis);
    const analysisRuntime = needsPython ? await pyodideAnalysisRuntime() : undefined;
    const rows: Awaited<ReturnType<typeof runCase>>[] = [];
    for (let run = 1; run <= RUNS; run++) {
      // Run non-analysis cases 3 at a time and analysis cases sequentially (Pyodide queues one job).
      const plain = PROBE_CASES.filter((c) => !c.needsAnalysis);
      const py = PROBE_CASES.filter((c) => c.needsAnalysis);
      for (let i = 0; i < plain.length; i += 3) {
        const batch = plain.slice(i, i + 3);
        const results = await Promise.all(batch.map((c) => runCase(c, run, undefined)));
        rows.push(...results);
      }
      for (const c of py) {
        rows.push(await runCase(c, run, analysisRuntime));
      }
    }
    const lowered = rows.filter((each) => each.loweredByUnits);
    const unsettled = rows.filter(
      (each) => each.state === "not-checked" || each.state === "missing",
    );
    process.stdout.write(
      `SUMMARY arm=${ARM} model=${MODEL} total=${rows.length} supported=${rows.filter((r) => r.state === "supported").length} loweredByUnits=${lowered.length} unsettled=${unsettled.length}\n`,
    );
    if (ASSERT) {
      expect(unsettled).toEqual([]);
      expect(lowered).toEqual([]);
    }
  });
});
