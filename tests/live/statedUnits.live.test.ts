/**
 * A figure written in the unit its Document states is never Contradicted for that unit alone
 * (#2864), on a real model. Two sets, each in English and Chinese:
 *
 * - "walk": the newcomer walk's Note of key figures, written by the app from Documents in GBP
 *   million (人民币百万元), with the User's one planted error (£538.9m against 528.9; 4.5% against
 *   4.1%). Checked INCARNAMIND_LIVE_RUNS times: no figure that differs only by the stated unit may
 *   be Contradicted, and the planted error must be Contradicted in every run.
 * - "decoys": pairs of a Document and one sentence where Supported would be wrong: a figure that
 *   really is 1,000 times off, a unit stated for another table than the figure's, and a unit the
 *   sentence claims that the Document doesn't share. Each pair has its own Folder and Note, so a
 *   decoy's Document never backs another. None of them may read Supported.
 *
 * The cases were written before the first measured run and are not the prompt's examples. Runs
 * only with INCARNAMIND_LIVE_ANTHROPIC_KEY, so `npx vitest run` makes no request without one.
 *
 * - INCARNAMIND_LIVE_ANTHROPIC_MODEL: the model (Claude Sonnet 5.5 when unset).
 * - INCARNAMIND_LIVE_SET: "walk", "decoys" or both ("walk,decoys" when unset).
 * - INCARNAMIND_LIVE_RUNS: how many times the walk's Note is checked (10 when unset).
 * - INCARNAMIND_LIVE_LANGUAGES: "en", "zh" or both ("en,zh" when unset).
 * - INCARNAMIND_LIVE_REPORT: a file to keep each run's counts.
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes, Core, FigureScheduleRow } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const SETS = (process.env.INCARNAMIND_LIVE_SET ?? "walk,decoys").split(",");
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "10");
const LANGUAGES = (process.env.INCARNAMIND_LIVE_LANGUAGES ?? "en,zh").split(",");
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;

type Language = "en" | "zh";

interface SourceFile {
  name: string;
  lines: readonly string[];
}

/** What a sentence of the walk's Note must come out as. */
type Expect =
  /** The line that states the unit, which a Document states too: anything but Unsupported. */
  | { kind: "unit-line" }
  /** A figure that differs from its source only by the stated unit: never Contradicted. */
  | { kind: "unit-only"; figure: string }
  /** The User's planted error: Contradicted. */
  | { kind: "error"; figure: string };

interface Walk {
  documents: readonly SourceFile[];
  title: string;
  sentences: readonly { text: string; expect: Expect }[];
}

const WALK: Record<Language, Walk> = {
  en: {
    documents: [
      {
        name: "Harbourline Foods half-year update 2026.pdf",
        lines: [
          "Harbourline Foods plc",
          "Half-year update for the six months to 30 June 2026",
          "GBP million unless stated otherwise",
          "Revenue for the six months was 668.3, up 4.1% on the first half of 2025.",
          "Adjusted EBITDA for the six months was 91.5.",
          "Net debt at 30 June 2026 was 528.9.",
          "Leverage was 2.9x on a last-twelve-months basis.",
        ],
      },
      {
        name: "Harbourline Foods annual report 2025 extract.pdf",
        lines: [
          "Harbourline Foods plc annual report 2025 (extract)",
          "All amounts in GBP million unless otherwise stated.",
          "Revenue for 2025 was 1,287.4.",
          "Adjusted EBITDA for 2025 was 176.2.",
          "Net debt at 31 December 2025 was 541.7.",
        ],
      },
      {
        name: "Harbourline revolving credit facility terms.pdf",
        lines: [
          "Revolving credit facility: summary of terms",
          "Borrower: Harbourline Foods plc",
          "Facility: GBP 250 million, maturing in 2029.",
          "Leverage covenant: net debt to adjusted EBITDA of no more than 3.25x, tested each half year.",
        ],
      },
    ],
    title: "Harbourline key figures",
    sentences: [
      {
        text: "Figures are in GBP million, as the Harbourline documents state them.",
        expect: { kind: "unit-line" },
      },
      { text: "Revenue for the six months: 668.3", expect: { kind: "unit-only", figure: "668.3" } },
      {
        text: "Adjusted EBITDA for the six months: 91.5",
        expect: { kind: "unit-only", figure: "91.5" },
      },
      { text: "Revenue for 2025: 1,287.4", expect: { kind: "unit-only", figure: "1,287.4" } },
      {
        text: "Net debt at 30 June 2026 was £538.9m.",
        expect: { kind: "error", figure: "£538.9m" },
      },
    ],
  },
  zh: {
    documents: [
      {
        name: "华岭食品2025年年度报告摘要.pdf",
        lines: [
          "华岭食品股份有限公司2025年年度报告（摘要）",
          "单位：人民币百万元",
          "2025年全年营业收入为187.3，同比增长4.1%。",
          "2025年12月31日净负债为502.4。",
          "2025年调整后息税折旧摊销前利润为31.6。",
        ],
      },
      {
        name: "华岭食品2026年半年度经营简报.pdf",
        lines: [
          "华岭食品2026年半年度经营简报",
          "除另有说明外，金额单位为人民币百万元。",
          "2026年上半年营业收入为98.7。",
          "2026年6月30日净负债为497.1。",
        ],
      },
    ],
    title: "华岭食品的主要数字（人民币百万元）",
    sentences: [
      {
        text: "数字单位为人民币百万元，与华岭食品的文件一致。",
        expect: { kind: "unit-line" },
      },
      { text: "营业收入：2025年全年为187.3。", expect: { kind: "unit-only", figure: "187.3" } },
      { text: "净负债：2025年12月31日为502.4。", expect: { kind: "unit-only", figure: "502.4" } },
      { text: "2026年上半年营业收入为98.7。", expect: { kind: "unit-only", figure: "98.7" } },
      { text: "2025年营业收入同比增长4.5%。", expect: { kind: "error", figure: "4.5%" } },
    ],
  },
};

/** A pair where Supported is wrong. */
interface Decoy {
  name: string;
  language: Language;
  kind: "thousand-times" | "another-table" | "unshared-unit";
  document: readonly string[];
  sentence: string;
}

const DECOYS: readonly Decoy[] = [
  // A figure that really is 1,000 times off: the Document's unit is read, and the sentence's
  // own unit puts it a thousand times away.
  {
    name: "EN thousands for millions",
    language: "en",
    kind: "thousand-times",
    document: ["Tollgate Ferries results", "GBP thousands", "Ticket revenue was 412.6."],
    sentence: "Ticket revenue was £412.6m.",
  },
  {
    name: "EN millions for thousands",
    language: "en",
    kind: "thousand-times",
    document: ["Ostrava Glassworks accounts", "(EUR million)", "Energy costs were 18.4."],
    sentence: "Energy costs were €18,400.",
  },
  {
    name: "EN billions for millions",
    language: "en",
    kind: "thousand-times",
    document: [
      "Kestrel Telecom summary",
      "All figures in US$ billion",
      "Capital spending was 2.7.",
    ],
    sentence: "Capital spending was $2.7 million.",
  },
  {
    name: "EN full amount a thousand times too big",
    language: "en",
    kind: "thousand-times",
    document: ["Marsh Lane Dairy trading note", "(in £'000)", "Milk purchases were 3,905."],
    sentence: "Milk purchases were £3,905,000,000.",
  },
  {
    name: "EN thousands written as millions in words",
    language: "en",
    kind: "thousand-times",
    document: [
      "Pellucid Optics",
      "Amounts in thousands of US dollars",
      "Research spending was 731.",
    ],
    sentence: "Research spending was 731 million US dollars.",
  },
  {
    name: "EN millions as thousands in words",
    language: "en",
    kind: "thousand-times",
    document: ["Granby Rail plc", "£m", "Track access charges were 64.2."],
    sentence: "Track access charges were £64.2 thousand.",
  },
  {
    name: "EN thousands written as thousands of pounds",
    language: "en",
    kind: "thousand-times",
    document: [
      "Ridgeway Hotels",
      "GBP thousands unless stated otherwise",
      "Room revenue was 8,214.",
    ],
    sentence: "Room revenue was 8.214 thousand pounds.",
  },
  {
    name: "ZH 千元 written as 百万元",
    language: "zh",
    kind: "thousand-times",
    document: ["青川纺织2025年度摘要", "单位：千元", "原材料采购额为5,120。"],
    sentence: "原材料采购额为5,120百万元。",
  },
  {
    name: "ZH 百万元 written as 千元",
    language: "zh",
    kind: "thousand-times",
    document: ["白沙物流经营数据", "单位：人民币百万元", "运输收入为73.6。"],
    sentence: "运输收入为73.6千元。",
  },
  {
    name: "ZH 元 written as 千元",
    language: "zh",
    kind: "thousand-times",
    document: ["东篱餐饮门店报表", "单位：元", "单店月均租金为46,500。"],
    sentence: "单店月均租金为46,500千元。",
  },
  {
    name: "ZH 千元 for a full amount a thousand times off",
    language: "zh",
    kind: "thousand-times",
    document: ["鹤鸣制药年报节选", "金额单位：千元", "研发投入为9,870。"],
    sentence: "研发投入为9,870元。",
  },
  {
    name: "ZH 百万元 a thousand times too big",
    language: "zh",
    kind: "thousand-times",
    document: ["临江港务公告", "单位：人民币百万元", "港口作业收入为215.4。"],
    sentence: "港口作业收入为人民币215,400百万元。",
  },
  {
    name: "ZH bare figure a thousand times too big",
    language: "zh",
    kind: "thousand-times",
    document: ["石桥电子季报", "单位：人民币千元", "销售费用为1,436。"],
    sentence: "销售费用为1,436,000,000。",
  },
  {
    name: "ZH 万元 for 千万",
    language: "zh",
    kind: "thousand-times",
    document: ["远山茶业", "单位：万元", "茶叶销售收入为628.5。"],
    sentence: "茶叶销售收入为628.5千万元。",
  },
  // A unit stated for another table: the figure's own table states none.
  {
    name: "EN headcount table's thousands for revenue",
    language: "en",
    kind: "another-table",
    document: [
      "Table 1 Staff numbers (in thousands)",
      "Employees 3.4",
      "Table 2 Sales by channel",
      "Online sales 912.5",
    ],
    sentence: "Online sales were 912,500.",
  },
  {
    name: "EN segment table's £m for the volumes table",
    language: "en",
    kind: "another-table",
    document: [
      "Table A Segment profit (£m)",
      "Bakery 41.0",
      "Table B Volumes",
      "Loaves sold 286.0",
    ],
    sentence: "Loaves sold were 286 million.",
  },
  {
    name: "EN a note's US$ thousands for the next note",
    language: "en",
    kind: "another-table",
    document: [
      "Note 7 Lease liabilities (US$ thousands)",
      "Current 1,204",
      "Note 8 Share options",
      "Options outstanding 1,912",
    ],
    sentence: "Options outstanding were 1,912,000.",
  },
  {
    name: "EN scale below the rows",
    language: "en",
    kind: "another-table",
    document: [
      "Table 3 Fleet",
      "Vehicles in service 5,210",
      "Table 4 Fuel costs (in thousands of euros)",
      "Diesel 702",
    ],
    sentence: "Vehicles in service were 5,210,000.",
  },
  {
    name: "EN thousands for a percent table",
    language: "en",
    kind: "another-table",
    document: [
      "Table 5 Debt (GBP thousands)",
      "Term loan 9,400",
      "Table 6 Interest rates",
      "Term loan rate 6.2",
    ],
    sentence: "The term loan rate was 6,200.",
  },
  {
    name: "EN millions caption of a chart for a count",
    language: "en",
    kind: "another-table",
    document: [
      "Chart 1 Revenue by year (US$ million)",
      "2025 88.1",
      "Table 2 Customers",
      "Active customers 14.7",
    ],
    sentence: "Active customers were 14.7 million US dollars.",
  },
  {
    name: "EN a section's £'000 for another section",
    language: "en",
    kind: "another-table",
    document: [
      "Section 2 Costs (£'000)",
      "Rent 318",
      "Section 3 Visitors",
      "Visitors in the year 318",
    ],
    sentence: "Visitors in the year cost £318,000.",
  },
  {
    name: "ZH 表1 的千元用于表2",
    language: "zh",
    kind: "another-table",
    document: ["表1 员工薪酬（单位：千元）", "工资 2,650", "表2 产量", "年产量 2,650"],
    sentence: "年产量为2,650,000元。",
  },
  {
    name: "ZH 附注5 的万元用于附注6",
    language: "zh",
    kind: "another-table",
    document: ["附注5 应收账款（单位：万元）", "期末余额 812.3", "附注6 员工人数", "期末人数 812"],
    sentence: "期末人数为812万。",
  },
  {
    name: "ZH 下表的百万元用于上表",
    language: "zh",
    kind: "another-table",
    document: ["表3 门店数量", "门店 1,045", "表4 门店收入（单位：人民币百万元）", "收入 377.2"],
    sentence: "门店为1,045百万家。",
  },
  {
    name: "ZH 图1 的亿元用于表2",
    language: "zh",
    kind: "another-table",
    document: ["图1 营业收入（单位：亿元）", "2025年 31.6", "表2 研发人员", "研发人员 31.6"],
    sentence: "研发人员费用为31.6亿元。",
  },
  {
    name: "ZH 第一节的千元用于第二节",
    language: "zh",
    kind: "another-table",
    document: ["一、费用（单位：千元）", "差旅费 156", "二、出差次数", "出差次数 156"],
    sentence: "出差次数为156,000次。",
  },
  {
    name: "ZH 表7 的美元千元用于表8",
    language: "zh",
    kind: "another-table",
    document: ["表7 境外收入（单位：千美元）", "境外收入 4,410", "表8 境内收入", "境内收入 4,410"],
    sentence: "境内收入为4,410千美元。",
  },
  {
    name: "ZH 表9 的百分比表用于金额",
    language: "zh",
    kind: "another-table",
    document: ["表9 毛利率", "毛利率 27.5", "表10 毛利（单位：人民币百万元）", "毛利 61.2"],
    sentence: "毛利率为27.5百万元。",
  },
  // A unit the sentence claims that the Document doesn't share.
  {
    name: "EN pounds against US dollars",
    language: "en",
    kind: "unshared-unit",
    document: ["Corvid Shipping interim figures", "US$ million", "Charter income was 233.9."],
    sentence: "Charter income was £233.9m.",
  },
  {
    name: "EN euros against a Document with no unit",
    language: "en",
    kind: "unshared-unit",
    document: ["Fenwick Orchards harvest log", "Apples picked 233.9"],
    sentence: "Apples picked were worth €233.9m.",
  },
  {
    name: "EN millions against a Document with no scale",
    language: "en",
    kind: "unshared-unit",
    document: ["Larkspur Clinics", "Patient visits 47.3"],
    sentence: "Patient visits were 47.3 million.",
  },
  {
    name: "EN GBP million line claimed for US$ figures",
    language: "en",
    kind: "unshared-unit",
    document: ["Ashby Mining quarterly", "(in US$ million)", "Copper sales 119.8"],
    sentence: "Copper sales were 119.8, in GBP million.",
  },
  {
    name: "EN tonnes against barrels",
    language: "en",
    kind: "unshared-unit",
    document: ["Northsea Fields output", "Production (thousand barrels)", "Field B 512.0"],
    sentence: "Field B produced 512,000 tonnes.",
  },
  {
    name: "EN thousand euros against thousand Swiss francs",
    language: "en",
    kind: "unshared-unit",
    document: ["Alpenrose Hotels", "CHF thousands", "Spa revenue 2,331"],
    sentence: "Spa revenue was €2,331,000.",
  },
  {
    name: "EN percent against points",
    language: "en",
    kind: "unshared-unit",
    document: ["Bramble Bank margins", "Net interest margin rose by 0.4 percentage points."],
    sentence: "Net interest margin rose by 0.4%.",
  },
  {
    name: "ZH 美元 against 人民币",
    language: "zh",
    kind: "unshared-unit",
    document: ["金桥化工海外业务", "单位：人民币百万元", "海外收入为842.6。"],
    sentence: "海外收入为842.6百万美元。",
  },
  {
    name: "ZH 万元 against a Document with no unit",
    language: "zh",
    kind: "unshared-unit",
    document: ["清河农场记录", "苹果产量 315.2"],
    sentence: "苹果产量为315.2万元。",
  },
  {
    name: "ZH 亿 against a Document with no scale",
    language: "zh",
    kind: "unshared-unit",
    document: ["云岭旅游统计", "游客人次 6.8"],
    sentence: "游客人次为6.8亿。",
  },
  {
    name: "ZH 港元 against 人民币千元",
    language: "zh",
    kind: "unshared-unit",
    document: ["南湾地产", "单位：人民币千元", "物业管理收入 7,410"],
    sentence: "物业管理收入为7,410千港元。",
  },
  {
    name: "ZH 吨 against 千桶",
    language: "zh",
    kind: "unshared-unit",
    document: ["渤东油田产量", "单位：千桶", "C区块 286.4"],
    sentence: "C区块产量为286.4千吨。",
  },
  {
    name: "ZH 欧元 against 英镑百万",
    language: "zh",
    kind: "unshared-unit",
    document: ["伦敦分部", "单位：百万英镑", "分部利润 57.9"],
    sentence: "分部利润为57.9百万欧元。",
  },
  {
    name: "ZH 百分比 against 百分点",
    language: "zh",
    kind: "unshared-unit",
    document: ["长风银行", "净息差下降0.3个百分点。"],
    sentence: "净息差下降0.3%。",
  },
];

const textNode = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content: [textNode(value)],
});

const pdfOf = (file: SourceFile, language: Language) =>
  language === "zh" ? buildPdf([{ chineseLines: file.lines }]) : buildPdf([{ lines: file.lines }]);

async function newCore(language: Language) {
  const dataDir = await createTempDataFolder();
  const core: Core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({ user: { language: language === "zh" ? "zh-CN" : "en" } });
  await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
  return core;
}

/** The sentence's check as the Note keeps it. */
function checkOf(client: MindClient, sentence: string): ClaimCheckAttributes | null {
  return (
    claimSpans(readMind(client)).find((span) => span.sentence.text.trim() === sentence.trim())
      ?.check ?? null
  );
}

const rowOf = (rows: readonly FigureScheduleRow[], figure: string) =>
  rows.find((row) => row.reading.chars === figure) ?? null;

async function report(entry: object) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  if (REPORT) await appendFile(REPORT, `${JSON.stringify(entry)}\n`);
}

describe.skipIf(!KEY)("figures in a unit their Document states (#2864)", () => {
  for (const language of LANGUAGES as Language[]) {
    const walk = WALK[language];
    test.skipIf(!SETS.includes("walk") || !walk)(
      `the walk's Note, ${RUNS} checks (${language})`,
      { timeout: 3_600_000 },
      async () => {
        const core = await newCore(language);
        const sources = await createTempDataFolder();
        await addAndProcess(
          core,
          await Promise.all(
            walk.documents.map((file) =>
              writeSourceFile(sources, file.name, pdfOf(file, language)),
            ),
          ),
        );
        const runs: {
          contradicted: number;
          supported: number;
          unitOnlyContradicted: string[];
          errorContradicted: boolean;
          unitLine: string;
          figures: Record<string, string>;
        }[] = [];
        for (let run = 1; run <= RUNS; run++) {
          const mind = await core.createMind({ title: walk.title });
          const client = await connectToMind(core, mind.id);
          writeMind(client, [
            {
              type: "heading",
              attrs: { id: randomUUID(), level: 1 },
              content: [textNode(walk.title)],
            },
            ...walk.sentences.map(({ text }) => paragraph(text)),
          ]);
          await client.settled();
          const result = await core.checkMind({
            requestId: `walk-${language}-${run}`,
            mindId: mind.id,
            mode: "all",
          });
          await client.settled();
          const schedule = await core.getFigureSchedule(mind.id);
          const figures: Record<string, string> = {};
          for (const row of schedule.rows) figures[row.reading.chars] = row.shown.state;
          const states = walk.sentences.map(({ text, expect: wanted }) => ({
            wanted,
            sentence: checkOf(client, text)?.state ?? "missing",
            figure:
              wanted.kind === "unit-line"
                ? null
                : (rowOf(schedule.rows, wanted.figure)?.shown.state ?? "missing"),
          }));
          const entry = {
            set: "walk",
            language,
            model: MODEL,
            run,
            result: result.kind,
            contradicted: schedule.rows.filter((row) => row.shown.state === "contradicted").length,
            supported: schedule.rows.filter((row) => row.shown.state === "supported").length,
            unitOnlyContradicted: states.flatMap(({ wanted, figure }) =>
              wanted.kind === "unit-only" && figure === "contradicted" ? [wanted.figure] : [],
            ),
            errorContradicted: states.some(
              ({ wanted, figure }) => wanted.kind === "error" && figure === "contradicted",
            ),
            unitLine: states.find(({ wanted }) => wanted.kind === "unit-line")?.sentence ?? "",
            figures,
          };
          runs.push(entry);
          await report(entry);
        }
        const { spent } = await core.getCostSummary();
        await report({ set: "walk", language, model: MODEL, runs: runs.length, spent });
        for (const each of runs) {
          expect(each.unitOnlyContradicted, JSON.stringify(each)).toEqual([]);
          expect(each.errorContradicted, JSON.stringify(each)).toBe(true);
        }
      },
    );
  }

  test.skipIf(!SETS.includes("decoys"))(
    `${DECOYS.length} decoys: none reads Supported`,
    { timeout: 3_600_000 },
    async () => {
      const results: { name: string; kind: string; state: string; figures: string[] }[] = [];
      for (const language of LANGUAGES as Language[]) {
        const decoys = DECOYS.filter((each) => each.language === language);
        if (decoys.length === 0) continue;
        const core = await newCore(language);
        const sources = await createTempDataFolder();
        for (const [index, decoy] of decoys.entries()) {
          const [file] = await addAndProcess(core, [
            await writeSourceFile(
              sources,
              `decoy-${index + 1}.md`,
              `${decoy.document.join("\n\n")}\n`,
            ),
          ]);
          if (!file) throw new Error(`${decoy.name}: its Document didn't process.`);
          const folder = await core.createLibraryGroup({
            name: `decoy-${index + 1}`,
            description: "",
          });
          await core.moveToFolder({ documentIds: [file.id], folderId: folder.id });
          const mind = await core.createMind({ title: `decoy-${index + 1}`, folderId: folder.id });
          const client = await connectToMind(core, mind.id);
          writeMind(client, [paragraph(decoy.sentence)]);
          await client.settled();
          await core.checkMind({
            requestId: `decoy-${language}-${index}`,
            mindId: mind.id,
            mode: "all",
          });
          await client.settled();
          const check = checkOf(client, decoy.sentence);
          const schedule = await core.getFigureSchedule(mind.id);
          const entry = {
            name: decoy.name,
            kind: decoy.kind,
            state: check?.state ?? "missing",
            figures: schedule.rows.map((row) => `${row.reading.chars}=${row.shown.state}`),
          };
          results.push(entry);
          await report({ set: "decoys", language, model: MODEL, ...entry });
        }
        const { spent } = await core.getCostSummary();
        await report({ set: "decoys", language, model: MODEL, spent });
      }
      const falseSupported = results.filter(
        (each) =>
          each.state === "supported" || each.figures.some((one) => one.endsWith("=supported")),
      );
      await report({
        set: "decoys",
        model: MODEL,
        pairs: results.length,
        falseSupported: falseSupported.map(({ name }) => name),
      });
      expect(falseSupported).toEqual([]);
    },
  );
});
