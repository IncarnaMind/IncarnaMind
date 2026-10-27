/**
 * Tie out figures on real models (#1932): a results memo of 40 figures, 5 of them
 * wrong, 3 rounded to their own shown precision and 2 totals that don't add up, checked
 * by the one Check against an invented set of accounts and its results announcement, in
 * English and in Chinese. Every wrong figure and every total that is off must need a
 * look, every rounded figure stay Supported with "Rounded from …", and the rest stay
 * Supported. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY, so `npx vitest run` makes no
 * request without one.
 *
 * - INCARNAMIND_LIVE_ANTHROPIC_MODEL: the model (Claude Haiku 5.5 when unset).
 * - INCARNAMIND_LIVE_RUNS: how many times the whole memo is tied out (1 when unset).
 * - INCARNAMIND_LIVE_LANGUAGES: "en", "zh" or both ("en,zh" when unset).
 * - INCARNAMIND_LIVE_REPORT: a file to keep each run's counts, cost and every figure that
 *   came out other than expected.
 * - INCARNAMIND_LIVE_TRACE: a file to keep each check's last request and what the model
 *   wrote back, to read why a figure came out as it did.
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { expect, test } from "vitest";
import type { FigureScheduleRow } from "../../src/core/api";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { xlsxOf } from "../helpers/office";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? catalogProvider("anthropic")?.roles.quickTasks;
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "1");
const LANGUAGES = (process.env.INCARNAMIND_LIVE_LANGUAGES ?? "en,zh").split(",");

/** What the tie-out must make of a figure. */
type Truth = "supported" | "rounded" | "wrong" | "total-off";

/** A figure in the memo, as written, and what it is against the Documents. */
type Figure = [chars: string, truth: Truth];

interface Pack {
  accounts: { name: string; sheets: { name: string; rows: (string | number)[][] }[] };
  results: { name: string; text: string };
  title: string;
  paragraphs: { text: string; figures: Figure[] }[];
  tables: { caption: string; head: [string, string]; rows: [string, string, Truth][] }[];
}

const SEGMENTS_2026: [string, number][] = [
  ["Groceries", 2160],
  ["Fresh food", 1420],
  ["Online", 460],
  ["Clothing", 300],
  ["Fuel", 510],
  ["Other", 130],
];
const SEGMENTS_2025: [string, number][] = [
  ["Groceries", 2100],
  ["Fresh food", 1350],
  ["Online", 480],
  ["Clothing", 310],
  ["Fuel", 450],
  ["Other", 170],
];

// Revenue (£4,983.4m) isn't the segments' total (£4,980m): the memo's £4,983m is rounded from
// one source only, where £4,980m would be the segment total stated exactly.
const PACKS: Record<string, Pack> = {
  en: {
    accounts: {
      name: "Northwind management accounts Q3 2026.xlsx",
      sheets: [
        {
          name: "Profit and loss",
          rows: [
            ["All figures in £m"],
            ["Line", "Q3 2026", "Q3 2025"],
            ["Revenue", 4983.4, 4860.0],
            ["Cost of sales", 3061.4, 2891.7],
            ["Gross profit", 1922.0, 1968.3],
            ["Operating costs", 1262.4, 1201.5],
            ["EBITDA", 1840.0, 1795.0],
            ["Net finance cost, last 12 months", 392.0, 371.0],
            ["Capital expenditure", 248.5, 231.0],
            ["Net debt", 5704.0, 5512.0],
            ["Free cash flow", 84.0, 102.0],
          ],
        },
        {
          name: "Segments",
          rows: [
            ["All figures in £m"],
            ["Segment", "Q3 2026", "Q3 2025"],
            ...SEGMENTS_2026.map(([name, value], index): (string | number)[] => [
              name,
              value,
              SEGMENTS_2025[index]?.[1] ?? 0,
            ]),
            ["Total", 4980, 4860],
          ],
        },
      ],
    },
    results: {
      name: "Northwind Q3 2026 results.md",
      text: [
        "# Northwind Retail: third quarter 2026 results",
        "",
        "Revenue was £4,983.4m in the third quarter of 2026, up from £4,860.0m a year earlier.",
        "",
        "Gross margin was 38.6%, against 40.5% in the third quarter of 2025.",
        "",
        "Net debt was £5,704m at 30 September 2026, and leverage was 3.1x EBITDA of £1,840m. The leverage covenant limit is 3.5x.",
        "",
        "Like-for-like sales grew 2.4%, and online sales fell 4.2%.",
        "",
        "The group opened 14 new stores and closed 6 in the quarter.",
        "",
        "The group employed 41,250 people at the quarter end. The interim dividend is 4.2 pence per share.",
        "",
        "Customer numbers rose to 8.4 million, and store space was 12.6 million square feet.",
      ].join("\n"),
    },
    title: "Q3 2026 results memo",
    paragraphs: [
      {
        text: "Revenue was £4,983m, up from £4,860m a year earlier.",
        figures: [
          ["£4,983m", "rounded"],
          ["£4,860m", "supported"],
        ],
      },
      {
        text: "Gross profit was £1,922m and gross margin was 38.6%, down from 40.5% a year earlier.",
        figures: [
          ["£1,922m", "supported"],
          ["38.6%", "supported"],
          ["40.5%", "supported"],
        ],
      },
      {
        text: "Net finance cost over the last 12 months was £402m.",
        figures: [["£402m", "wrong"]],
      },
      {
        text: "Capital expenditure was £248.5m in the quarter.",
        figures: [["£248.5m", "supported"]],
      },
      {
        text: "Net debt was £5.7bn and leverage was 3.1x on EBITDA of £1,840m, inside the 3.5x covenant limit.",
        figures: [
          ["£5.7bn", "rounded"],
          ["3.1x", "supported"],
          ["£1,840m", "supported"],
          ["3.5x", "supported"],
        ],
      },
      {
        text: "Like-for-like sales grew 2.4% while online sales fell 4.8%.",
        figures: [
          ["2.4%", "supported"],
          ["4.8%", "wrong"],
        ],
      },
      {
        text: "The group opened 14 new stores and closed 9 in the quarter.",
        figures: [
          ["14", "supported"],
          ["9", "wrong"],
        ],
      },
      {
        text: "The group employed 41,250 people, and the interim dividend is 4.2 pence per share.",
        figures: [
          ["41,250 people", "supported"],
          ["4.2", "supported"],
        ],
      },
      {
        text: "Customer numbers rose to 8.4 million, and store space was 12.6 million square feet.",
        figures: [
          ["8.4 million", "supported"],
          ["12.6 million square feet", "supported"],
        ],
      },
      { text: "Free cash flow was £48m in the quarter.", figures: [["£48m", "wrong"]] },
      { text: "Operating costs were £1,262m.", figures: [["£1,262m", "rounded"]] },
      { text: "Cost of sales was £3,061.4m.", figures: [["£3,061.4m", "supported"]] },
      {
        text: "Groceries sold £2,160m, fresh food £1,420m and fuel £510m in the quarter.",
        figures: [
          ["£2,160m", "supported"],
          ["£1,420m", "supported"],
          ["£510m", "supported"],
        ],
      },
      {
        text: "Clothing brought in £300m and other income £130m in the quarter.",
        figures: [
          ["£300m", "supported"],
          ["£130m", "supported"],
        ],
      },
    ],
    tables: [
      {
        caption: "Revenue by segment, Q3 2026 (£m)",
        head: ["Segment", "Q3 2026"],
        rows: [
          ["Groceries", "2,160", "supported"],
          ["Fresh food", "1,420", "supported"],
          ["Online", "460", "supported"],
          ["Clothing", "300", "supported"],
          ["Fuel", "510", "supported"],
          ["Total", "4,980", "total-off"],
        ],
      },
      {
        caption: "Revenue by segment, Q3 2025 (£m)",
        head: ["Segment", "Q3 2025"],
        rows: [
          ["Groceries", "2,100", "supported"],
          ["Fresh food", "1,350", "supported"],
          ["Online", "480", "supported"],
          ["Clothing", "310", "supported"],
          ["Fuel", "540", "wrong"],
          ["Other", "170", "supported"],
          ["Total", "4,860", "total-off"],
        ],
      },
    ],
  },
  zh: {
    accounts: {
      name: "诺斯文德零售2026年第三季度管理账目.xlsx",
      sheets: [
        {
          name: "利润表",
          rows: [
            ["单位：人民币百万元"],
            ["项目", "2026年第三季度", "2025年第三季度"],
            ["营业收入", 4983.4, 4860.0],
            ["营业成本", 3061.4, 2891.7],
            ["毛利", 1922.0, 1968.3],
            ["营业费用", 1262.4, 1201.5],
            ["息税折旧摊销前利润", 1840.0, 1795.0],
            ["近12个月净融资成本", 392.0, 371.0],
            ["资本开支", 248.5, 231.0],
            ["净债务", 5704.0, 5512.0],
            ["自由现金流", 84.0, 102.0],
          ],
        },
        {
          name: "分部",
          rows: [
            ["单位：人民币百万元"],
            ["分部", "2026年第三季度", "2025年第三季度"],
            ["日用食品", 2160, 2100],
            ["生鲜食品", 1420, 1350],
            ["线上", 460, 480],
            ["服装", 300, 310],
            ["燃油", 510, 450],
            ["其他", 130, 170],
            ["合计", 4980, 4860],
          ],
        },
      ],
    },
    results: {
      name: "诺斯文德零售2026年第三季度业绩公告.md",
      text: [
        "# 诺斯文德零售2026年第三季度业绩",
        "",
        "2026年第三季度营业收入为人民币4,983.4百万元，上年同期为人民币4,860.0百万元。",
        "",
        "毛利率为38.6%，2025年第三季度为40.5%。",
        "",
        "截至2026年9月30日，净债务为人民币5,704百万元，杠杆率为息税折旧摊销前利润（人民币1,840百万元）的3.1倍。杠杆率契约上限为3.5倍。",
        "",
        "同店销售增长2.4%，线上销售下降4.2%。",
        "",
        "本季度新开门店14家，关闭门店6家。",
        "",
        "季度末员工人数为41,250人。中期股息为每股0.42元。",
        "",
        "客户数量增至840万，门店面积为1,260万平方英尺。",
      ].join("\n"),
    },
    title: "2026年第三季度业绩备忘录",
    paragraphs: [
      {
        text: "营业收入为49.83亿元，上年同期为48.60亿元。",
        figures: [
          ["49.83亿元", "rounded"],
          ["48.60亿元", "supported"],
        ],
      },
      {
        text: "毛利为19.22亿元，毛利率为38.6%，上年同期为40.5%。",
        figures: [
          ["19.22亿元", "supported"],
          ["38.6%", "supported"],
          ["40.5%", "supported"],
        ],
      },
      { text: "近12个月净融资成本为4.02亿元。", figures: [["4.02亿元", "wrong"]] },
      { text: "本季度资本开支为2.485亿元。", figures: [["2.485亿元", "supported"]] },
      {
        text: "净债务为57亿元，杠杆率为3.1倍，息税折旧摊销前利润为18.40亿元，低于3.5倍的契约上限。",
        figures: [
          ["57亿元", "rounded"],
          ["3.1倍", "supported"],
          ["18.40亿元", "supported"],
          ["3.5倍", "supported"],
        ],
      },
      {
        text: "同店销售增长2.4%，线上销售下降4.8%。",
        figures: [
          ["2.4%", "supported"],
          ["4.8%", "wrong"],
        ],
      },
      {
        text: "本季度新开门店14家，关闭门店9家。",
        figures: [
          ["14家", "supported"],
          ["9家", "wrong"],
        ],
      },
      {
        text: "员工人数为41,250人，中期股息为每股0.42元。",
        figures: [
          ["41,250人", "supported"],
          ["0.42元", "supported"],
        ],
      },
      {
        text: "客户数量增至840万，门店面积为1,260万平方英尺。",
        figures: [
          ["840万", "supported"],
          ["1,260万", "supported"],
        ],
      },
      { text: "本季度自由现金流为0.48亿元。", figures: [["0.48亿元", "wrong"]] },
      { text: "营业费用为12.62亿元。", figures: [["12.62亿元", "rounded"]] },
      { text: "营业成本为30.614亿元。", figures: [["30.614亿元", "supported"]] },
      {
        text: "本季度日用食品收入21.60亿元，生鲜食品14.20亿元，燃油5.10亿元。",
        figures: [
          ["21.60亿元", "supported"],
          ["14.20亿元", "supported"],
          ["5.10亿元", "supported"],
        ],
      },
      {
        text: "本季度服装收入3.00亿元，其他收入1.30亿元。",
        figures: [
          ["3.00亿元", "supported"],
          ["1.30亿元", "supported"],
        ],
      },
    ],
    tables: [
      {
        caption: "2026年第三季度分部收入（单位：人民币百万元）",
        head: ["分部", "2026年第三季度"],
        rows: [
          ["日用食品", "2,160", "supported"],
          ["生鲜食品", "1,420", "supported"],
          ["线上", "460", "supported"],
          ["服装", "300", "supported"],
          ["燃油", "510", "supported"],
          ["合计", "4,980", "total-off"],
        ],
      },
      {
        caption: "2025年第三季度分部收入（单位：人民币百万元）",
        head: ["分部", "2025年第三季度"],
        rows: [
          ["日用食品", "2,100", "supported"],
          ["生鲜食品", "1,350", "supported"],
          ["线上", "480", "supported"],
          ["服装", "310", "supported"],
          ["燃油", "540", "wrong"],
          ["其他", "170", "supported"],
          ["合计", "4,860", "total-off"],
        ],
      },
    ],
  },
};

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content: [text(value)],
});
const cell = (value: string, header = false): JSONContent => ({
  type: header ? "tableHeader" : "tableCell",
  content: [paragraph(value)],
});

function memo(pack: Pack): { blocks: JSONContent[]; truth: Figure[] } {
  const truth: Figure[] = [];
  const blocks: JSONContent[] = [
    { type: "heading", attrs: { id: randomUUID(), level: 1 }, content: [text(pack.title)] },
  ];
  for (const line of pack.paragraphs) {
    blocks.push(paragraph(line.text));
    truth.push(...line.figures);
  }
  for (const table of pack.tables) {
    blocks.push(paragraph(table.caption));
    blocks.push({
      type: "table",
      attrs: { id: randomUUID() },
      content: [
        { type: "tableRow", content: table.head.map((value) => cell(value, true)) },
        ...table.rows.map(([label, value]) => ({
          type: "tableRow",
          content: [cell(label), cell(value)],
        })),
      ],
    });
    truth.push(...table.rows.map(([, value, expected]): Figure => [value, expected]));
  }
  return { blocks, truth };
}

const TRACE = process.env.INCARNAMIND_LIVE_TRACE;
const createChatModel: typeof createAiSdkChatModel = (spec) =>
  wrapLanguageModel({
    model: createAiSdkChatModel(spec),
    middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ doStream, params }) => {
        const result = await doStream();
        if (!TRACE) return result;
        let written = "";
        const calls: unknown[] = [];
        const kept = result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type === "text-delta") written += part.delta;
              if (part.type === "tool-call") calls.push({ tool: part.toolName, input: part.input });
              controller.enqueue(part);
            },
            async flush() {
              const asked = JSON.stringify(params.prompt[1] ?? "");
              const sentence = /<sentence>\\n(.*?)\\n<\/sentence>/.exec(asked)?.[1] ?? null;
              await appendFile(
                TRACE,
                `${JSON.stringify({ sentence, prompt: params.prompt.slice(-2), written, calls })}\n`,
              );
            },
          }),
        );
        return { ...result, stream: kept };
      },
    },
  });

const lookStates = new Set(["unsupported", "contradicted", "needs-recheck"]);

function score(rows: readonly FigureScheduleRow[], truth: readonly Figure[]) {
  const counts = {
    wrong: 0,
    wrongFound: 0,
    wrongContradicted: 0,
    totalsOff: 0,
    totalsFound: 0,
    rounded: 0,
    roundedShown: 0,
    supported: 0,
    supportedKept: 0,
    falseAlarms: 0,
    notChecked: 0,
  };
  const misses: {
    chars: string;
    truth: Truth;
    state: string;
    reason: string | null;
    why?: string;
  }[] = [];
  truth.forEach(([chars, expected], index) => {
    const row = rows[index];
    const state = row?.shown.state ?? "missing";
    const look = lookStates.has(state);
    if (state === "not-checked" || state === "missing") counts.notChecked++;
    let met = false;
    if (expected === "wrong") {
      counts.wrong++;
      if (look) counts.wrongFound++;
      if (state === "contradicted") counts.wrongContradicted++;
      met = look;
    } else if (expected === "total-off") {
      counts.totalsOff++;
      met = row?.reason === "doesnt-add-up";
      if (met) counts.totalsFound++;
    } else if (expected === "rounded") {
      counts.rounded++;
      met = state === "supported" && row?.roundedFrom !== null;
      if (met) counts.roundedShown++;
      else if (look) counts.falseAlarms++;
    } else {
      counts.supported++;
      met = state === "supported";
      if (met) counts.supportedKept++;
      else if (look) counts.falseAlarms++;
    }
    if (!met || row?.reading.chars !== chars)
      misses.push({
        chars: row?.reading.chars === chars ? chars : `${chars} (row: ${row?.reading.chars})`,
        truth: expected,
        state,
        reason: row?.reason ?? null,
        ...(row?.shown.state === "not-checked" && { why: row.shown.reason }),
      });
  });
  return { counts, misses };
}

for (const language of LANGUAGES) {
  const pack = PACKS[language];
  if (!pack) continue;
  test.skipIf(!KEY || !MODEL)(
    `tie out a 40-figure memo against its accounts (${language})`,
    { timeout: 3_600_000 },
    async () => {
      const { blocks, truth } = memo(pack);
      expect(truth).toHaveLength(40);
      for (let run = 1; run <= RUNS; run++) {
        const dataDir = await createTempDataFolder();
        const core = startCore(dataDir, { createChatModel });
        core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
        await core.updateSettings({ user: { language: language === "zh" ? "zh-CN" : "en" } });
        await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL ?? "" });
        const sources = await createTempDataFolder();
        await addAndProcess(core, [
          await writeSourceFile(
            sources,
            pack.accounts.name,
            xlsxOf(pack.accounts.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows }))),
          ),
          await writeSourceFile(sources, pack.results.name, pack.results.text),
        ]);
        const mind = await core.createMind({ title: pack.title });
        const client = await connectToMind(core, mind.id);
        writeMind(client, blocks);
        await client.settled();
        const started = Date.now();
        const result = await core.checkMind({
          requestId: `tie-out-${run}`,
          mindId: mind.id,
          mode: "all",
        });
        const seconds = (Date.now() - started) / 1000;
        const schedule = await core.getFigureSchedule(mind.id);
        const { counts, misses } = score(schedule.rows, truth);
        const cost = queryDatabase<{ cost: number }>(
          dataDir,
          "SELECT coalesce(sum(cost), 0) AS cost FROM model_requests WHERE deleted_at IS NULL AND status = 'settled'",
        )[0]?.cost;
        const report = {
          language,
          model: MODEL,
          run,
          result: result.kind,
          figures: schedule.rows.length,
          seconds,
          cost,
          ...counts,
          misses,
        };
        if (process.env.INCARNAMIND_LIVE_REPORT)
          await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${JSON.stringify(report)}\n`);
        expect(schedule.rows.map((row) => row.reading.chars)).toEqual(
          truth.map(([chars]) => chars),
        );
      }
    },
  );
}
