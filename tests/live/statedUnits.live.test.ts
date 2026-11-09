/**
 * A figure written in the unit its Document states is never Contradicted for that unit alone
 * (#2864), on a real model. Two sets, each in English and Chinese:
 *
 * - "walk": the newcomer walk's Note of key figures, written by the app from Documents in GBP
 *   million (人民币百万元), with the User's one planted error (£538.9m against 528.9; 4.5% against
 *   4.1%). Checked INCARNAMIND_LIVE_RUNS times: no figure that differs only by the stated unit may
 *   be Contradicted, and the planted error must be Contradicted in every run.
 * - "decoys": pairs of a Document and one sentence where Supported would be wrong: a figure that
 *   really is 1,000 times off, a unit stated for another table than the figure's, a unit the
 *   sentence claims that the Document doesn't share, and equal digits under a unit the Note states
 *   in a heading or a line of its own that isn't the Document's. Each pair has its own Folder and
 *   Note, so a decoy's Document never backs another. None of them, nor a Note's unit line, may read
 *   Supported.
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
  kind: "thousand-times" | "another-table" | "unshared-unit" | "note-unit";
  document: readonly string[];
  sentence: string;
  /** What the Note says above the sentence: a heading, or a line of its own, stating its unit. */
  above?: { heading: string } | { line: string };
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
  // Equal digits under a unit the Note states that isn't the Document's: a heading or a line of
  // its own above the sentence says one unit, the Document another.
  {
    name: "EN Note says Key figures (GBP thousand) above Revenue for the year: 668.3",
    language: "en",
    kind: "note-unit",
    above: { heading: "Key figures (GBP thousand)" },
    document: [
      "Ardley Foods results",
      "GBP million unless stated otherwise",
      "Revenue for the year was 668.3.",
    ],
    sentence: "Revenue for the year: 668.3",
  },
  {
    name: "EN Note says Figures are in GBP thousands. above Operating profit: 91.5",
    language: "en",
    kind: "note-unit",
    above: { line: "Figures are in GBP thousands." },
    document: ["Ardley Foods results", "(GBP million)", "Operating profit 91.5"],
    sentence: "Operating profit: 91.5",
  },
  {
    name: "EN Note says Results (US$ million) above Net debt: 528.9",
    language: "en",
    kind: "note-unit",
    above: { heading: "Results (US$ million)" },
    document: ["Bexley Mills update", "GBP million", "Net debt was 528.9."],
    sentence: "Net debt: 528.9",
  },
  {
    name: "EN Note says All amounts below are in euros. above Capital spending: 44.2",
    language: "en",
    kind: "note-unit",
    above: { line: "All amounts below are in euros." },
    document: ["Corran Shipping", "EUR million", "Capital spending was 44.2."],
    sentence: "Capital spending: 44.2",
  },
  {
    name: "EN Note says Summary (in thousands) above Cash: 12.8",
    language: "en",
    kind: "note-unit",
    above: { heading: "Summary (in thousands)" },
    document: ["Dunholme Retail", "All figures in millions of US dollars", "Cash was 12.8."],
    sentence: "Cash: 12.8",
  },
  {
    name: "EN Note says Figures are in US$ thousands. above Order backlog: 302.6",
    language: "en",
    kind: "note-unit",
    above: { line: "Figures are in US$ thousands." },
    document: ["Elstow Aerospace", "US$ million", "Order backlog 302.6"],
    sentence: "Order backlog: 302.6",
  },
  {
    name: "EN Note says Group figures (£m) above Rent paid: 4,118.0",
    language: "en",
    kind: "note-unit",
    above: { heading: "Group figures (£m)" },
    document: ["Farley Estates", "(£'000)", "Rent paid 4,118.0"],
    sentence: "Rent paid: 4,118.0",
  },
  {
    name: "EN Note says Amounts are in CHF million. above Sales: 77.4",
    language: "en",
    kind: "note-unit",
    above: { line: "Amounts are in CHF million." },
    document: ["Glenmore Watches", "EUR million", "Sales 77.4"],
    sentence: "Sales: 77.4",
  },
  {
    name: "EN Note says Key numbers (USD billion) above Total assets: 1,904.2",
    language: "en",
    kind: "note-unit",
    above: { heading: "Key numbers (USD billion)" },
    document: ["Hartwell Energy", "USD million", "Total assets 1,904.2"],
    sentence: "Total assets: 1,904.2",
  },
  {
    name: "EN Note says All figures in this note are in thousands of pounds. above Pension deficit: 63.0",
    language: "en",
    kind: "note-unit",
    above: { line: "All figures in this note are in thousands of pounds." },
    document: ["Inchcape Mutual", "All amounts in GBP million", "Pension deficit 63.0"],
    sentence: "Pension deficit: 63.0",
  },
  {
    name: "EN Note says Fleet costs (EUR thousand) above Fuel: 18.7",
    language: "en",
    kind: "note-unit",
    above: { heading: "Fleet costs (EUR thousand)" },
    document: ["Jarrow Logistics", "EUR million unless stated otherwise", "Fuel 18.7"],
    sentence: "Fuel: 18.7",
  },
  {
    name: "EN Note says Numbers are in Canadian dollars, millions. above Royalties: 26.3",
    language: "en",
    kind: "note-unit",
    above: { line: "Numbers are in Canadian dollars, millions." },
    document: ["Kirkby Mining", "US$ million", "Royalties 26.3"],
    sentence: "Royalties: 26.3",
  },
  {
    name: "EN Note says Balance sheet (in millions) above Inventories: 5,620.4",
    language: "en",
    kind: "note-unit",
    above: { heading: "Balance sheet (in millions)" },
    document: ["Lanark Textiles", "(in thousands)", "Inventories 5,620.4"],
    sentence: "Inventories: 5,620.4",
  },
  {
    name: "EN Note says Figures are in AUD million. above Freight income: 14.9",
    language: "en",
    kind: "note-unit",
    above: { line: "Figures are in AUD million." },
    document: ["Morven Freight", "NZD million", "Freight income 14.9"],
    sentence: "Freight income: 14.9",
  },
  {
    name: "EN Note says Half-year (GBP million) above Dividends paid: 2,250.5",
    language: "en",
    kind: "note-unit",
    above: { heading: "Half-year (GBP million)" },
    document: ["Nairn Brewing", "(GBP thousands)", "Dividends paid 2,250.5"],
    sentence: "Dividends paid: 2,250.5",
  },
  {
    name: "EN Note says All amounts are in yen. above Licence fees: 840.2",
    language: "en",
    kind: "note-unit",
    above: { line: "All amounts are in yen." },
    document: ["Oban Electronics", "JPY million", "Licence fees 840.2"],
    sentence: "Licence fees: 840.2",
  },
  {
    name: "EN Note says Costs (US$ thousand) above Research spending: 1.7",
    language: "en",
    kind: "note-unit",
    above: { heading: "Costs (US$ thousand)" },
    document: ["Penrith Biotech", "US$ billion", "Research spending 1.7"],
    sentence: "Research spending: 1.7",
  },
  {
    name: "EN Note says Amounts are in euro thousands. above Service charges: 512.6",
    language: "en",
    kind: "note-unit",
    above: { line: "Amounts are in euro thousands." },
    document: ["Quorn Property", "(GBP thousands)", "Service charges 512.6"],
    sentence: "Service charges: 512.6",
  },
  {
    name: "EN Note says Statement (HK$ million) above Interest income: 33.1",
    language: "en",
    kind: "note-unit",
    above: { heading: "Statement (HK$ million)" },
    document: ["Rydal Holdings", "RMB million", "Interest income 33.1"],
    sentence: "Interest income: 33.1",
  },
  {
    name: "EN Note says Figures in this summary are in millions. above Market value: 2.45",
    language: "en",
    kind: "note-unit",
    above: { line: "Figures in this summary are in millions." },
    document: ["Selby Networks", "(in billions)", "Market value 2.45"],
    sentence: "Market value: 2.45",
  },
  {
    name: "ZH Note says 主要数字（单位：千元） above 营业收入：187.3",
    language: "zh",
    kind: "note-unit",
    above: { heading: "主要数字（单位：千元）" },
    document: ["岷山食品年报摘要", "单位：人民币百万元", "营业收入为187.3。"],
    sentence: "营业收入：187.3",
  },
  {
    name: "ZH Note says 以下数字单位为万元。 above 净利润：42.6",
    language: "zh",
    kind: "note-unit",
    above: { line: "以下数字单位为万元。" },
    document: ["岷山食品年报摘要", "单位：百万元", "净利润为42.6。"],
    sentence: "净利润：42.6",
  },
  {
    name: "ZH Note says 经营数据（美元百万） above 销售费用：15.8",
    language: "zh",
    kind: "note-unit",
    above: { heading: "经营数据（美元百万）" },
    document: ["汀州物流经营简报", "单位：人民币百万元", "销售费用为15.8。"],
    sentence: "销售费用：15.8",
  },
  {
    name: "ZH Note says 以下金额均以元为单位。 above 研发投入：9,870.5",
    language: "zh",
    kind: "note-unit",
    above: { line: "以下金额均以元为单位。" },
    document: ["汀州物流经营简报", "单位：千元", "研发投入为9,870.5。"],
    sentence: "研发投入：9,870.5",
  },
  {
    name: "ZH Note says 财务摘要（人民币亿元） above 总资产：3,410.5",
    language: "zh",
    kind: "note-unit",
    above: { heading: "财务摘要（人民币亿元）" },
    document: ["沅江机械年报节选", "单位：人民币百万元", "总资产为3,410.5。"],
    sentence: "总资产：3,410.5",
  },
  {
    name: "ZH Note says 本笔记金额单位为港元百万元。 above 利息收入：33.1",
    language: "zh",
    kind: "note-unit",
    above: { line: "本笔记金额单位为港元百万元。" },
    document: ["沅江机械年报节选", "单位：人民币百万元", "利息收入为33.1。"],
    sentence: "利息收入：33.1",
  },
  {
    name: "ZH Note says 成本（单位：百万元） above 原材料成本：628.5",
    language: "zh",
    kind: "note-unit",
    above: { heading: "成本（单位：百万元）" },
    document: ["涪陵茶业半年报", "单位：万元", "原材料成本为628.5。"],
    sentence: "原材料成本：628.5",
  },
  {
    name: "ZH Note says 以下数字以千美元计。 above 运费：4,410.2",
    language: "zh",
    kind: "note-unit",
    above: { line: "以下数字以千美元计。" },
    document: ["涪陵茶业半年报", "单位：千英镑", "运费为4,410.2。"],
    sentence: "运费：4,410.2",
  },
  {
    name: "ZH Note says 门店数据（万元） above 单店租金：46,500.5",
    language: "zh",
    kind: "note-unit",
    above: { heading: "门店数据（万元）" },
    document: ["桐庐餐饮门店报表", "单位：元", "单店租金为46,500.5。"],
    sentence: "单店租金：46,500.5",
  },
  {
    name: "ZH Note says 数字单位为人民币千元。 above 营业收入：21.5",
    language: "zh",
    kind: "note-unit",
    above: { line: "数字单位为人民币千元。" },
    document: ["桐庐餐饮门店报表", "单位：人民币亿元", "营业收入为21.5。"],
    sentence: "营业收入：21.5",
  },
  {
    name: "ZH Note says 现金流（单位：亿元） above 经营活动现金流：8,215.3",
    language: "zh",
    kind: "note-unit",
    above: { heading: "现金流（单位：亿元）" },
    document: ["婺源化工季报", "单位：万元", "经营活动现金流为8,215.3。"],
    sentence: "经营活动现金流：8,215.3",
  },
  {
    name: "ZH Note says 以下金额单位为欧元。 above 海外收入：57.9",
    language: "zh",
    kind: "note-unit",
    above: { line: "以下金额单位为欧元。" },
    document: ["婺源化工季报", "单位：百万欧元", "海外收入为57.9。"],
    sentence: "海外收入：57.9",
  },
  {
    name: "ZH Note says 资产负债（千元） above 应收账款：812.3",
    language: "zh",
    kind: "note-unit",
    above: { heading: "资产负债（千元）" },
    document: ["黟县纺织年报", "金额单位：百万元", "应收账款为812.3。"],
    sentence: "应收账款：812.3",
  },
  {
    name: "ZH Note says 本表数字单位为百万日元。 above 授权费：740.5",
    language: "zh",
    kind: "note-unit",
    above: { line: "本表数字单位为百万日元。" },
    document: ["黟县纺织年报", "单位：百万韩元", "授权费为740.5。"],
    sentence: "授权费：740.5",
  },
  {
    name: "ZH Note says 利润表（单位：元） above 管理费用：1,436.2",
    language: "zh",
    kind: "note-unit",
    above: { heading: "利润表（单位：元）" },
    document: ["歙州电子年报", "单位：人民币万元", "管理费用为1,436.2。"],
    sentence: "管理费用：1,436.2",
  },
  {
    name: "ZH Note says 下列数字以亿元计。 above 研发费用：96.4",
    language: "zh",
    kind: "note-unit",
    above: { line: "下列数字以亿元计。" },
    document: ["歙州电子年报", "单位：百万元", "研发费用为96.4。"],
    sentence: "研发费用：96.4",
  },
  {
    name: "ZH Note says 投资（美元千元） above 资本开支：23.7",
    language: "zh",
    kind: "note-unit",
    above: { heading: "投资（美元千元）" },
    document: ["祁门矿业公告", "单位：美元百万元", "资本开支为23.7。"],
    sentence: "资本开支：23.7",
  },
  {
    name: "ZH Note says 数字单位为新台币百万元。 above 毛利：61.2",
    language: "zh",
    kind: "note-unit",
    above: { line: "数字单位为新台币百万元。" },
    document: ["祁门矿业公告", "单位：人民币百万元", "毛利为61.2。"],
    sentence: "毛利：61.2",
  },
  {
    name: "ZH Note says 负债（单位：万元） above 短期借款：5,120.5",
    language: "zh",
    kind: "note-unit",
    above: { heading: "负债（单位：万元）" },
    document: ["绩溪地产半年报", "单位：千元", "短期借款为5,120.5。"],
    sentence: "短期借款：5,120.5",
  },
  {
    name: "ZH Note says 以下金额单位为人民币元。 above 物业管理收入：7,410.5",
    language: "zh",
    kind: "note-unit",
    above: { line: "以下金额单位为人民币元。" },
    document: ["绩溪地产半年报", "单位：人民币千元", "物业管理收入为7,410.5。"],
    sentence: "物业管理收入：7,410.5",
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
          const above = decoy.above;
          writeMind(client, [
            ...(above && "heading" in above
              ? [
                  {
                    type: "heading",
                    attrs: { id: randomUUID(), level: 2 },
                    content: [textNode(above.heading)],
                  },
                ]
              : []),
            ...(above && "line" in above ? [paragraph(above.line)] : []),
            paragraph(decoy.sentence),
          ]);
          await client.settled();
          await core.checkMind({
            requestId: `decoy-${language}-${index}`,
            mindId: mind.id,
            mode: "all",
          });
          await client.settled();
          const check = checkOf(client, decoy.sentence);
          const schedule = await core.getFigureSchedule(mind.id);
          // The Note's own unit line is a claim too: Supported, it would back the wrong unit.
          const line = above && "line" in above ? checkOf(client, above.line) : null;
          const entry = {
            name: decoy.name,
            kind: decoy.kind,
            state: check?.state ?? "missing",
            ...(line && { line: line.state }),
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
          each.state === "supported" ||
          ("line" in each && each.line === "supported") ||
          each.figures.some((one) => one.endsWith("=supported")),
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
