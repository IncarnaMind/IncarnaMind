/**
 * Every figure in a Note's tables gets a look (#2447): held-out tables, none of them the tie-out
 * memo's, checked by Check this Note against invented accounts, in English and in Chinese. Each
 * wrong figure must come back Contradicted or Unsupported, and no figure may end with no check
 * made for it, or the run fails. The report keeps how the sort decided each table cell that holds
 * a figure and each row's label it was shown (a claim, no claim, or nothing said), what the checks
 * made of the labels, every figure that came out other than expected, and the tokens of every
 * request. A label that only names its row should be no claim; one that asserts something, a fact. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY, so
 * `npx vitest run` makes no request without one.
 *
 * - INCARNAMIND_LIVE_ANTHROPIC_MODEL: the model (Claude Haiku 5.5 when unset).
 * - INCARNAMIND_LIVE_RUNS: how many times each Note is checked (1 when unset).
 * - INCARNAMIND_LIVE_LANGUAGES: "en", "zh" or both ("en,zh" when unset).
 * - INCARNAMIND_LIVE_REPORT: a file to keep each run's counts.
 * - INCARNAMIND_LIVE_TRACE: a file to keep each sort request and what the model wrote back.
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
import { checksOn, sortedCells, sortRecorder } from "../helpers/sortCalls";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? catalogProvider("anthropic")?.roles.quickTasks;
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "1");
const LANGUAGES = (process.env.INCARNAMIND_LIVE_LANGUAGES ?? "en,zh").split(",");
const TRACE = process.env.INCARNAMIND_LIVE_TRACE;

type Truth = "supported" | "wrong";
/** A figure as the schedule reads it, and what it is against the accounts. */
type Figure = [chars: string, truth: Truth];
/** A table cell: plain words, or a figure. */
type Cell = string | Figure;

interface Pack {
  accounts: { name: string; sheets: { name: string; rows: (string | number)[][] }[] };
  title: string;
  paragraphs: { text: string; figures: Figure[] }[];
  /** `asserting`: each row's label asserts something of its own, so the sort should call it a fact. */
  tables: { caption: string; head: string[]; rows: Cell[][]; asserting?: boolean }[];
}

const PACKS: Record<string, Pack> = {
  en: {
    accounts: {
      name: "Harbourside Health operations September 2026.xlsx",
      sheets: [
        {
          name: "Sites",
          rows: [
            ["Site", "Beds", "Staff", "Occupancy"],
            ["Northgate", 412, 1830, "91.2%"],
            ["Riverside", 286, 1215, "87.5%"],
            ["Eastfield", 198, 904, "82.0%"],
            ["Westmoor", 154, 660, "79.4%"],
          ],
        },
        {
          name: "Waiting lists",
          rows: [
            ["Specialty", "Patients waiting", "Median wait (weeks)"],
            ["Orthopaedics", 4210, 18],
            ["Cardiology", 2960, 11],
            ["Dermatology", 3480, 22],
            ["Ophthalmology", 5120, 15],
          ],
        },
        {
          name: "Fleet",
          rows: [
            ["Depot", "Vans", "Drivers", "Status"],
            ["Leeds", 46, 58, "Open"],
            ["York", 31, 40, "Open"],
            ["Hull", 27, 33, "Closed for refit"],
          ],
        },
        {
          name: "Regions",
          rows: [
            ["Region", "Stores", "Staff"],
            ["North East England", 14, 610],
            ["South West England", 9, 420],
            ["Scotland and Wales", 6, 255],
          ],
        },
        {
          name: "Margin bridge",
          rows: [
            ["Driver", "Effect on margin (points)"],
            ["Fuel prices rose faster than pump prices", 0.8],
            ["Online orders cost more to pick and deliver", 0.3],
            ["Better buying lifted fresh food margins", 0.6],
          ],
        },
      ],
    },
    title: "Operations review, September 2026",
    paragraphs: [
      {
        text: "Northgate ran 412 beds at 91.2% occupancy in September.",
        figures: [
          ["412", "supported"],
          ["91.2%", "supported"],
        ],
      },
      {
        text: "Cardiology had 2,690 patients waiting, and Dermatology had 3,480.",
        figures: [
          ["2,690 patients", "wrong"],
          ["3,480", "supported"],
        ],
      },
    ],
    tables: [
      {
        caption: "Beds and staff by site, September 2026",
        head: ["Site", "Beds", "Staff"],
        rows: [
          ["Northgate", ["412", "supported"], ["1,830", "supported"]],
          ["Riverside", ["286", "supported"], ["1,251", "wrong"]],
          ["Eastfield", ["198", "supported"], ["904", "supported"]],
          ["Westmoor", ["154", "supported"], ["660", "supported"]],
        ],
      },
      {
        caption: "Waiting lists at the end of September",
        head: ["Specialty", "Patients waiting", "Median wait (weeks)"],
        rows: [
          ["Orthopaedics", ["4,210", "supported"], ["18", "supported"]],
          ["Cardiology", ["2,960", "supported"], ["11", "supported"]],
          ["Dermatology", ["3,840", "wrong"], ["22", "supported"]],
          ["Ophthalmology", ["5,120", "supported"], ["15", "supported"]],
        ],
      },
      {
        caption: "Bed occupancy by site",
        head: ["Site", "Occupancy"],
        rows: [
          ["Northgate", ["91.2%", "supported"]],
          ["Riverside", ["87.5%", "supported"]],
          ["Eastfield", ["82.0%", "supported"]],
          ["Westmoor", ["74.9%", "wrong"]],
        ],
      },
      {
        caption: "Vans and drivers by depot",
        head: ["", "Vans", "Drivers", "Status"],
        rows: [
          ["Leeds", ["46", "supported"], ["58", "supported"], "Open"],
          ["York", ["31", "supported"], ["44", "wrong"], "Open"],
          ["Hull", ["72", "wrong"], ["33", "supported"], "Closed for refit"],
        ],
      },
      {
        caption: "Stores and staff by region",
        head: ["Region", "Stores", "Staff"],
        rows: [
          ["North East England", ["14", "supported"], ["610", "supported"]],
          ["South West England", ["9", "supported"], ["402", "wrong"]],
          ["Scotland and Wales", ["6", "supported"], ["255", "supported"]],
        ],
      },
      {
        caption: "What moved gross margin",
        head: ["Driver", "Effect on margin (points)"],
        rows: [
          ["Fuel prices rose faster than pump prices", ["0.8", "supported"]],
          ["Online orders cost more to pick and deliver", ["0.3", "supported"]],
          ["Better buying lifted fresh food margins", ["0.4", "wrong"]],
        ],
        asserting: true,
      },
    ],
  },
  zh: {
    accounts: {
      name: "华东区域门店经营2026年10月.xlsx",
      sheets: [
        {
          name: "门店",
          rows: [
            ["城市", "门店数", "员工人数", "会员数（万）"],
            ["上海", 48, 2350, 126],
            ["杭州", 31, 1480, 84],
            ["南京", 24, 1160, 69],
            ["苏州", 19, 905, 47],
          ],
        },
        {
          name: "品类",
          rows: [
            ["单位：万元"],
            ["品类", "销售额", "毛利率"],
            ["食品", 3860, "22.4%"],
            ["日化", 1240, "31.0%"],
            ["家电", 2970, "16.4%"],
            ["服饰", 860, "38.5%"],
          ],
        },
        {
          name: "仓库",
          rows: [
            ["仓库", "车辆数", "司机人数", "状态"],
            ["宁波仓库", 62, 75, "营业"],
            ["温州仓库", 38, 46, "营业"],
            ["绍兴仓库", 35, 41, "停业整修"],
          ],
        },
        {
          name: "大区",
          rows: [
            ["大区", "门店数", "员工人数"],
            ["华东大区", 52, 2140],
            ["华南大区", 37, 1850],
            ["西南大区", 21, 930],
          ],
        },
        {
          name: "毛利率变动",
          rows: [
            ["因素", "影响（百分点）"],
            ["燃油进价涨幅高于零售价", 0.8],
            ["线上订单拣货配送成本上升", 0.3],
            ["生鲜采购改善提升毛利", 0.6],
          ],
        },
      ],
    },
    title: "华东区域十月经营回顾",
    paragraphs: [
      {
        text: "上海共有48家门店，员工2,350人。",
        figures: [
          ["48家", "supported"],
          ["2,350人", "supported"],
        ],
      },
      {
        text: "家电销售额为2,790万元，毛利率为16.4%。",
        figures: [
          ["2,790万元", "wrong"],
          ["16.4%", "supported"],
        ],
      },
    ],
    tables: [
      {
        caption: "各城市门店与员工（2026年10月）",
        head: ["城市", "门店数", "员工人数"],
        rows: [
          ["上海", ["48", "supported"], ["2,350", "supported"]],
          ["杭州", ["31", "supported"], ["1,480", "supported"]],
          ["南京", ["27", "wrong"], ["1,160", "supported"]],
          ["苏州", ["19", "supported"], ["905", "supported"]],
        ],
      },
      {
        caption: "各品类销售额与毛利率（单位：万元）",
        head: ["品类", "销售额", "毛利率"],
        rows: [
          ["食品", ["3,860", "supported"], ["22.4%", "supported"]],
          ["日化", ["1,240", "supported"], ["31.0%", "supported"]],
          ["家电", ["2,970", "supported"], ["14.6%", "wrong"]],
          ["服饰", ["860", "supported"], ["38.5%", "supported"]],
        ],
      },
      {
        caption: "各城市会员数（万）",
        head: ["城市", "会员数（万）"],
        rows: [
          ["上海", ["126", "supported"]],
          ["杭州", ["84", "supported"]],
          ["南京", ["69", "supported"]],
          ["苏州", ["74", "wrong"]],
        ],
      },
      {
        caption: "各仓库车辆与司机（2026年10月）",
        head: ["", "车辆数", "司机人数", "状态"],
        rows: [
          ["宁波仓库", ["62", "supported"], ["75", "supported"], "营业"],
          ["温州仓库", ["38", "supported"], ["49", "wrong"], "营业"],
          ["绍兴仓库", ["53", "wrong"], ["41", "supported"], "停业整修"],
        ],
      },
      {
        caption: "各大区门店与员工",
        head: ["大区", "门店数", "员工人数"],
        rows: [
          ["华东大区", ["52", "supported"], ["2,140", "supported"]],
          ["华南大区", ["37", "supported"], ["1,580", "wrong"]],
          ["西南大区", ["21", "supported"], ["930", "supported"]],
        ],
      },
      {
        caption: "毛利率变动因素",
        head: ["因素", "影响（百分点）"],
        rows: [
          ["燃油进价涨幅高于零售价", ["0.8", "supported"]],
          ["线上订单拣货配送成本上升", ["0.3", "supported"]],
          ["生鲜采购改善提升毛利", ["0.4", "wrong"]],
        ],
        asserting: true,
      },
    ],
  },
};

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  ...(value !== "" && { content: [text(value)] }),
});
const cell = (value: string, header = false): JSONContent => ({
  type: header ? "tableHeader" : "tableCell",
  content: [paragraph(value)],
});
const wordsOf = (each: Cell) => (typeof each === "string" ? each : each[0]);

/**
 * The Note's blocks, every figure in reading order, the words of each table cell that holds one,
 * and each row's label: those that only name their row, and those that assert something.
 */
function noteOf(pack: Pack): {
  blocks: JSONContent[];
  truth: Figure[];
  cells: Set<string>;
  labels: Set<string>;
  asserting: Set<string>;
} {
  const truth: Figure[] = [];
  const cells = new Set<string>();
  const labels = new Set<string>();
  const asserting = new Set<string>();
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
        ...table.rows.map((row) => ({
          type: "tableRow",
          content: row.map((each) => cell(wordsOf(each))),
        })),
      ],
    });
    for (const row of table.rows) {
      const [label] = row;
      if (typeof label === "string") (table.asserting ? asserting : labels).add(label);
      for (const each of row)
        if (typeof each !== "string") {
          truth.push(each);
          cells.add(wordsOf(each));
        }
    }
  }
  return { blocks, truth, cells, labels, asserting };
}

function score(rows: readonly FigureScheduleRow[], truth: readonly Figure[]) {
  const counts = {
    wrong: 0,
    wrongFound: 0,
    wrongSupported: 0,
    right: 0,
    rightSupported: 0,
    falseAlarms: 0,
    noLook: 0,
  };
  const misses: { chars: string; truth: Truth; state: string; why?: string; looked: boolean }[] =
    [];
  truth.forEach(([chars, expected], index) => {
    const row = rows[index];
    const state = row?.shown.state ?? "missing";
    const looked = row?.checkedAt != null;
    if (!looked) counts.noLook++;
    const found = state === "contradicted" || state === "unsupported";
    let met: boolean;
    if (expected === "wrong") {
      counts.wrong++;
      if (found) counts.wrongFound++;
      if (state === "supported") counts.wrongSupported++;
      met = found;
    } else {
      counts.right++;
      met = state === "supported";
      if (met) counts.rightSupported++;
      else if (found || state === "needs-recheck") counts.falseAlarms++;
    }
    if (!met || !looked)
      misses.push({
        chars,
        truth: expected,
        state,
        looked,
        ...(row?.shown.state === "not-checked" && { why: row.shown.reason }),
      });
  });
  return { counts, misses };
}

for (const language of LANGUAGES) {
  const pack = PACKS[language];
  if (!pack) continue;
  test.skipIf(!KEY || !MODEL)(
    `every figure of a Note's tables gets a look, and each wrong one needs a look (${language})`,
    { timeout: 3_600_000 },
    async () => {
      const { blocks, truth, cells, labels, asserting } = noteOf(pack);
      expect(truth).toHaveLength(39);
      for (let run = 1; run <= RUNS; run++) {
        const sorts = sortRecorder(async (call) => {
          if (TRACE) await appendFile(TRACE, `${JSON.stringify({ language, ...call })}\n`);
        });
        const dataDir = await createTempDataFolder();
        const core = startCore(dataDir, {
          createChatModel: (spec) =>
            wrapLanguageModel({ model: createAiSdkChatModel(spec), middleware: sorts.middleware }),
        });
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
        ]);
        const mind = await core.createMind({ title: pack.title });
        const client = await connectToMind(core, mind.id);
        writeMind(client, blocks);
        await client.settled();
        const started = Date.now();
        const result = await core.checkMind({
          requestId: `sorted-tables-${run}`,
          mindId: mind.id,
          mode: "all",
        });
        const seconds = (Date.now() - started) / 1000;
        await client.settled();
        const schedule = await core.getFigureSchedule(mind.id);
        const { counts, misses } = score(schedule.rows, truth);
        // The tokens beside the cost, so a reader can price each run again.
        const usage = queryDatabase<{
          cost: number;
          requests: number;
          input: number;
          cached: number;
          written: number;
          output: number;
        }>(
          dataDir,
          `SELECT coalesce(sum(cost), 0) AS cost, count(*) AS requests,
             coalesce(sum(input_tokens), 0) AS input, coalesce(sum(cached_input_tokens), 0) AS cached,
             coalesce(sum(cache_write_tokens), 0) AS written, coalesce(sum(output_tokens), 0) AS output
           FROM model_requests WHERE deleted_at IS NULL AND status = 'settled'`,
        )[0];
        const report = {
          language,
          model: MODEL,
          run,
          result: result.kind,
          figures: schedule.rows.length,
          seconds,
          usage,
          sortRequests: sorts.calls.length,
          sortedCells: sortedCells(sorts.calls, cells),
          sortedLabels: sortedCells(sorts.calls, labels),
          labelChecks: checksOn(client, labels),
          sortedAsserting: sortedCells(sorts.calls, asserting),
          assertingChecks: checksOn(client, asserting),
          ...counts,
          misses,
        };
        if (process.env.INCARNAMIND_LIVE_REPORT)
          await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${JSON.stringify(report)}\n`);
        expect(schedule.rows.map((row) => row.reading.chars)).toEqual(
          truth.map(([chars]) => chars),
        );
        const missed = JSON.stringify(misses);
        expect(counts.noLook, missed).toBe(0);
        expect(counts.wrongFound, missed).toBe(counts.wrong);
      }
    },
  );
}
