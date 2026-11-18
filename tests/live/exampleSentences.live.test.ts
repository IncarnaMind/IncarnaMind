/**
 * The gate of #3088 on a real model (`eval/evidence/3088-example-sentences/README.md`): the credit
 * example's own two sentences in a new Note, with the example alone and beside a Document of the
 * User's own, wrong twins of them, and held-out pairs of the same two kinds (a comparative clause,
 * a figure with a thousands comma in a short Note), each Note checked as Check this note does,
 * its sort included. One JSON line a check, and one for the run, to INCARNAMIND_LIVE_GATE_OUT.
 * INCARNAMIND_LIVE_GATE_GROUPS=everyday runs the everyday set alone (`npm run check:everyday`).
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY, or with INCARNAMIND_LIVE_GATE_DRY=1, where a
 * scripted judge stands in and nothing is sent. INCARNAMIND_LIVE_GATE_PROVIDER=deepseek runs it on
 * DeepSeek's own API with INCARNAMIND_LIVE_KEY (#3022).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguageModelV4CallOptions, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import { type Core, createAiSdkChatModel, type Document } from "../../src/core";
import { readVerdict } from "../../src/core/answers/checks/prompt";
import { costOf, inCurrency } from "../../src/core/cost/price";
import type { Language } from "../../src/core/language";
import { catalogModel } from "../../src/core/providers/catalog";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { reasonText } from "../../src/renderer/src/cost";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { translate } from "../../src/shared/i18n";
import { checkGenerate, isCheckRun, sentenceOf, unsupportedReply } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { ADVICE, DUTY_PAIRS } from "./dutySentences.cases";
import { EVERYDAY_PAIRS } from "./everydaySentences.cases";
import { FIELD_PAIRS } from "./fieldSentences.cases";
import { JUDGEMENT_NOTES } from "./judgementSentences.cases";
import { REMARK_NOTES } from "./remarkSentences.cases";

const PROVIDER =
  process.env.INCARNAMIND_LIVE_GATE_PROVIDER === "deepseek" ? "deepseek" : "anthropic";
const KEY =
  PROVIDER === "deepseek"
    ? process.env.INCARNAMIND_LIVE_KEY
    : process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const DRY = process.env.INCARNAMIND_LIVE_GATE_DRY === "1";
/** With an OpenRouter key here, the measured decision model reads each sentence first (#3118). */
const DECISION_KEY = process.env.INCARNAMIND_LIVE_DECISION_KEY;
/** Saved replies files, comma apart: the round is answered from them and nothing is sent. */
const REPLAY = process.env.INCARNAMIND_LIVE_GATE_REPLAY?.split(",").filter(Boolean);
const OUT = process.env.INCARNAMIND_LIVE_GATE_OUT;
/** A file for every reply with its request's words: a reply the check can't read is kept to replay. */
const REPLIES = process.env.INCARNAMIND_LIVE_GATE_REPLIES;
const ARM = process.env.INCARNAMIND_LIVE_GATE_ARM ?? "unnamed";
const ROUND = Number(process.env.INCARNAMIND_LIVE_GATE_ROUND ?? "0");
const GROUPS = (process.env.INCARNAMIND_LIVE_GATE_GROUPS ?? "example,held-out").split(",");
/** The held-out pairs to run, by the start of their ids ("en-c,zh-c"); all of them when unset. */
const CASES = process.env.INCARNAMIND_LIVE_GATE_CASES?.split(",");
const MODEL =
  (PROVIDER === "deepseek"
    ? process.env.INCARNAMIND_LIVE_MODEL
    : process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL) ??
  (catalogProvider(PROVIDER)?.roles.answers as string);
/** Notes checked at once: enough to finish a round in minutes, few enough to stay under the key's limit. */
const AT_ONCE = 4;
const EXAMPLES = resolve(__dirname, "../../resources/examples");

/** A sentence to check, and the part of it whose first reply is counted. */
interface Probe {
  sentence: string;
  /**
   * Right: the Documents state it. Wrong: they say otherwise, so it is never to be Supported.
   * None: the writer's own advice, which a check leaves without a mark.
   */
  expected: "right" | "wrong" | "none";
  /** The part whose first reply's verdict is recorded; the sentence's whole text when it has none. */
  part?: string;
}

const EXAMPLE = {
  en: {
    report: "Northwind Retail · Q3 2026 results",
    line: "Underlying EBITDA was £96 million, against £118 million a year earlier.",
    own: {
      name: "Harbour Foods board pack",
      text: "Harbour Foods sells through its own shops and online.\n\nHarbour Foods’ underlying EBITDA was £12 million in 2025.",
    },
    note: [
      {
        sentence: "Underlying EBITDA was £96 million, against £118 million a year earlier.",
        expected: "right",
        part: "against £118 million a year earlier",
      },
      { sentence: "Revenue was £1,284 million, up 4.2% year on year.", expected: "right" },
    ],
    twins: [
      {
        sentence: "Underlying EBITDA was £96 million, against £128 million a year earlier.",
        expected: "wrong",
        part: "against £128 million a year earlier",
      },
      {
        sentence: "Underlying EBITDA was £118 million, against £96 million a year earlier.",
        expected: "wrong",
        part: "against £96 million a year earlier",
      },
      { sentence: "Revenue was £1,248 million, up 4.2% year on year.", expected: "wrong" },
    ],
  },
  "zh-CN": {
    report: "Northwind Retail · 2026 年第三季度业绩",
    line: "基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。",
    own: {
      name: "海港食品董事会资料",
      text: "海港食品通过自有门店和线上渠道销售。\n\n海港食品 2025 年的基础 EBITDA 为 1,200 万英镑。",
    },
    note: [
      {
        sentence: "基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。",
        expected: "right",
        part: "上年同期为 1.18 亿英镑",
      },
      { sentence: "集团收入为 12.84 亿英镑，同比增长 4.2%。", expected: "right" },
    ],
    twins: [
      {
        sentence: "基础 EBITDA 为 9,600 万英镑，上年同期为 1.28 亿英镑。",
        expected: "wrong",
        part: "上年同期为 1.28 亿英镑",
      },
      {
        sentence: "基础 EBITDA 为 1.18 亿英镑，上年同期为 9,600 万英镑。",
        expected: "wrong",
        part: "上年同期为 9,600 万英镑",
      },
      { sentence: "集团收入为 12.48 亿英镑，同比增长 4.2%。", expected: "wrong" },
    ],
  },
} as const satisfies Record<
  Language,
  {
    report: string;
    line: string;
    own: { name: string; text: string };
    note: readonly Probe[];
    twins: readonly Probe[];
  }
>;

/** A held-out case: its own Folder, its own Document and a Note of one sentence. */
interface HeldOut extends Probe {
  id: string;
  kind: "comparative" | "short-note" | "table";
  language: Language;
  document: string;
}

/** Written before any run; none is an example the check's instructions or the unit tests give. */
const HELD_OUT: readonly HeldOut[] = [
  ...pair("en-a1", "comparative", "en", {
    document:
      "Operating profit fell to £41 million in 2026, from £52 million in 2025, as energy costs rose.",
    right: "Operating profit was £41 million in 2026, against £52 million in 2025.",
    wrong: "Operating profit was £41 million in 2026, against £25 million in 2025.",
    parts: ["against £52 million in 2025", "against £25 million in 2025"],
  }),
  ...pair("en-a2", "comparative", "en", {
    document: "Average occupancy in July was 82 per cent, compared with 76 per cent in July 2025.",
    right: "Occupancy averaged 82% in July, up from 76% a year before.",
    wrong: "Occupancy averaged 82% in July, down from 76% a year before.",
    parts: ["up from 76% a year before", "down from 76% a year before"],
  }),
  ...pair("en-a3", "comparative", "en", {
    document: "Net debt was $3.4 billion at 31 December 2026 (31 December 2025: $2.9 billion).",
    right:
      "Net debt stood at $3.4 billion at the end of 2026, compared with $2.9 billion a year earlier.",
    wrong:
      "Net debt stood at $2.9 billion at the end of 2026, compared with $3.4 billion a year earlier.",
    parts: [
      "compared with $2.9 billion a year earlier",
      "compared with $3.4 billion a year earlier",
    ],
  }),
  // The four pairs below flip a direction and no figure, written before any request of #3183.
  ...pair("en-a4", "comparative", "en", {
    document: "Customer churn was 3.1 per cent in 2026 (2025: 4.4 per cent).",
    right: "Churn was 3.1% in 2026, down from 4.4% the year before.",
    wrong: "Churn was 3.1% in 2026, up from 4.4% the year before.",
    parts: ["down from 4.4% the year before", "up from 4.4% the year before"],
  }),
  ...pair("en-a5", "comparative", "en", {
    document: "Headcount at 30 June stood at 1,240, against 1,115 a year earlier.",
    right: "Headcount was 1,240 at the end of June, higher than the 1,115 of a year earlier.",
    wrong: "Headcount was 1,240 at the end of June, lower than the 1,115 of a year earlier.",
    parts: ["higher than the 1,115 of a year earlier", "lower than the 1,115 of a year earlier"],
  }),
  ...pair("zh-a4", "comparative", "zh-CN", {
    document: "本季度毛利率为 34.5%，上年同期为 31.2%。",
    right: "毛利率为 34.5%，高于上年同期的 31.2%。",
    wrong: "毛利率为 34.5%，低于上年同期的 31.2%。",
    parts: ["高于上年同期的 31.2%", "低于上年同期的 31.2%"],
  }),
  ...pair("zh-a5", "comparative", "zh-CN", {
    document: "年末在册员工 860 人，上年末为 912 人。",
    right: "年末员工为 860 人，比上年末的 912 人有所减少。",
    wrong: "年末员工为 860 人，比上年末的 912 人有所增加。",
    parts: ["比上年末的 912 人有所减少", "比上年末的 912 人有所增加"],
  }),
  ...pair("zh-a1", "comparative", "zh-CN", {
    document: "报告期内营业利润为 2,750 万元，去年同期为 3,180 万元，主要受原材料涨价影响。",
    right: "营业利润为 2,750 万元，上年同期为 3,180 万元。",
    wrong: "营业利润为 2,750 万元，上年同期为 3,810 万元。",
    parts: ["上年同期为 3,180 万元", "上年同期为 3,810 万元"],
  }),
  ...pair("zh-a2", "comparative", "zh-CN", {
    document: "本年平均出租率为 91%，上年为 87%。",
    right: "出租率为 91%，较上年的 87% 有所上升。",
    wrong: "出租率为 91%，较上年的 87% 有所下降。",
    parts: ["较上年的 87% 有所上升", "较上年的 87% 有所下降"],
  }),
  ...pair("zh-a3", "comparative", "zh-CN", {
    document: "截至 2026 年末，净负债为 18.6 亿元（2025 年末：15.2 亿元）。",
    right: "2026 年末净负债为 18.6 亿元，一年前为 15.2 亿元。",
    wrong: "2026 年末净负债为 15.2 亿元，一年前为 18.6 亿元。",
    parts: ["一年前为 15.2 亿元", "一年前为 18.6 亿元"],
  }),
  ...pair("en-b1", "short-note", "en", {
    document: "Group sales were £2,615 million in the year, up 3 per cent on the year before.",
    right: "Sales were £2,615 million.",
    wrong: "Sales were £2,165 million.",
  }),
  ...pair("en-b2", "short-note", "en", {
    document: "Operating costs were $1.075 billion for the year, the company said.",
    right: "Costs came to $1,075 million.",
    wrong: "Costs came to $1,705 million.",
  }),
  ...pair("en-b3", "short-note", "en", {
    document: "The group employed 4,310 people at the end of the year.",
    right: "Headcount was 4,310.",
    wrong: "Headcount was 3,410.",
  }),
  ...pair("zh-b1", "short-note", "zh-CN", {
    document: "集团全年销售额为 2,615 万英镑，同比增长 3%。",
    right: "销售额为 2,615 万英镑。",
    wrong: "销售额为 2,165 万英镑。",
  }),
  ...pair("zh-b2", "short-note", "zh-CN", {
    document: "全年营业成本为 1075 万美元。",
    right: "成本为 1,075 万美元。",
    wrong: "成本为 1,705 万美元。",
  }),
  ...pair("zh-b3", "short-note", "zh-CN", {
    document: "The group employed 4,310 people at the end of the year.",
    right: "Headcount was 4,310.",
    wrong: "Headcount was 3,410.",
  }),
  // One clause and one fact, so never a part: a direction flipped in a sentence checked whole,
  // written before any request of that item of #3183.
  ...pair("en-c1", "short-note", "en", {
    document: "Average occupancy in the quarter was 81 per cent (prior quarter: 86 per cent).",
    right: "Occupancy fell to 81% in the quarter.",
    wrong: "Occupancy rose to 81% in the quarter.",
  }),
  ...pair("en-c2", "short-note", "en", {
    document: "Net debt increased to £412 million from £388 million at the prior year end.",
    right: "Net debt rose to £412 million.",
    wrong: "Net debt fell to £412 million.",
  }),
  ...pair("en-c3", "short-note", "en", {
    document: "The group had 5,260 employees at the year end, against 4,980 a year earlier.",
    right: "The number of employees went up over the year.",
    wrong: "The number of employees went down over the year.",
  }),
  ...pair("zh-c1", "short-note", "zh-CN", {
    document: "本年度客户流失率为 5.2%，上年度为 6.8%。",
    right: "客户流失率降至 5.2%。",
    wrong: "客户流失率升至 5.2%。",
  }),
  ...pair("zh-c2", "short-note", "zh-CN", {
    document: "期末存货较年初的 3,900 万元减少至 3,400 万元。",
    right: "存货降至 3,400 万元。",
    wrong: "存货增至 3,400 万元。",
  }),
  ...pair("zh-c3", "short-note", "zh-CN", {
    document: "年末门店数量为 128 家，上年末为 117 家。",
    right: "门店数量比上年有所增加。",
    wrong: "门店数量比上年有所减少。",
  }),
  // A count written with a thousands comma where the Document is one line or one table, and a
  // direction with no figure, written before any request of #3190.
  ...pair("en-e1", "short-note", "en", {
    document: "Subscribers at 30 September numbered 7,450, against 6,980 a year earlier.",
    right: "There were 7,450 subscribers at the end of September.",
    wrong: "There were 7,540 subscribers at the end of September.",
  }),
  ...pair("en-e2", "table", "en", {
    document: "| Site | Staff |\n|---|---|\n| Leeds | 1,320 |\n| Hull | 2,145 |",
    right: "The Leeds site has 1,320 staff.",
    wrong: "The Leeds site has 1,230 staff.",
  }),
  ...pair("en-e3", "short-note", "en", {
    document: "Stores at year end numbered 64, against 71 a year earlier.",
    right: "The number of stores fell over the year.",
    wrong: "The number of stores grew over the year.",
  }),
  ...pair("zh-e1", "short-note", "zh-CN", {
    document: "期末在册会员 3,260 人，上年末 2,980 人。",
    right: "期末在册会员为 3,260 人。",
    wrong: "期末在册会员为 3,620 人。",
  }),
  // en-a5's sentences over a Document long enough to tell how it writes its numbers (#3190).
  ...pair("en-e4", "comparative", "en", {
    document:
      "This is the staff report of the group for the half year. Headcount at 30 June stood at 1,240, against 1,115 a year earlier. The board has noted the report.",
    right: "Headcount was 1,240 at the end of June, higher than the 1,115 of a year earlier.",
    wrong: "Headcount was 1,240 at the end of June, lower than the 1,115 of a year earlier.",
    parts: ["higher than the 1,115 of a year earlier", "lower than the 1,115 of a year earlier"],
  }),
  // A comparison whose second half holds no number of its own but the one it is set against,
  // written before any request of #3223 and not read until its run was counted.
  ...pair("en-f1", "comparative", "en", {
    document:
      "The annual review covers the group's sites. Visitors to the museum numbered 48,200 in the year, against 52,900 the year before. The trustees approved the review.",
    right: "The museum had 48,200 visitors in the year, lower than the 52,900 of the year before.",
    wrong: "The museum had 48,200 visitors in the year, higher than the 52,900 of the year before.",
    parts: [
      "lower than the 52,900 of the year before",
      "higher than the 52,900 of the year before",
    ],
  }),
  ...pair("en-f2", "comparative", "en", {
    document:
      "The fleet report is for the year to March. The operator ran 312 buses at the year end, against 287 a year earlier. Fuel costs are set out below.",
    right: "The operator ran 312 buses at the year end, more than the 287 of a year earlier.",
    wrong: "The operator ran 312 buses at the year end, fewer than the 287 of a year earlier.",
    parts: ["more than the 287 of a year earlier", "fewer than the 287 of a year earlier"],
  }),
  ...pair("en-f3", "comparative", "en", {
    document:
      "The survey was carried out in May. Satisfaction among tenants stood at 78%, against 71% in the previous survey. Responses came from all estates.",
    right: "Tenant satisfaction was 78%, above the 71% of the previous survey.",
    wrong: "Tenant satisfaction was 78%, below the 71% of the previous survey.",
    parts: ["above the 71% of the previous survey", "below the 71% of the previous survey"],
  }),
  ...pair("zh-f1", "comparative", "zh-CN", {
    document: "本报告为年度经营情况说明。全年接待游客 36.5 万人次，上年为 32.8 万人次。详见附表。",
    right: "全年接待游客 36.5 万人次，高于上年的 32.8 万人次。",
    wrong: "全年接待游客 36.5 万人次，低于上年的 32.8 万人次。",
    parts: ["高于上年的 32.8 万人次", "低于上年的 32.8 万人次"],
  }),
  ...pair("zh-f2", "comparative", "zh-CN", {
    document: "本说明涵盖全部在建工程。期末在建项目 47 个，上年末为 53 个。项目明细见附表。",
    right: "期末在建项目 47 个，少于上年末的 53 个。",
    wrong: "期末在建项目 47 个，多于上年末的 53 个。",
    parts: ["少于上年末的 53 个", "多于上年末的 53 个"],
  }),
  ...pair("zh-f3", "comparative", "zh-CN", {
    document: "本次调查于五月完成。客户续约率为 84%，上年为 79%。样本覆盖全部地区。",
    right: "客户续约率为 84%，高于上年的 79%。",
    wrong: "客户续约率为 84%，低于上年的 79%。",
    parts: ["高于上年的 79%", "低于上年的 79%"],
  }),
  // Ordinary sentences with no "more or less than" in them, written before any request of #3223
  // and not read until its run was counted: a change to how a comparison is sorted must leave
  // these as they are sorted today. Each wrong twin has one wrong figure.
  ...pair("en-g1", "short-note", "en", {
    document:
      "The trust's annual report covers the year to March. Income was £4.2 million and spending was £3.9 million. The auditors gave a clean opinion.",
    right: "Income was £4.2 million and spending was £3.9 million.",
    wrong: "Income was £4.2 million and spending was £3.6 million.",
  }),
  ...pair("en-g2", "short-note", "en", {
    document:
      "The clinic's activity report is for the year. Appointments numbered 18,450, against 17,900 the year before. Waiting times are set out below.",
    right: "The clinic recorded 18,450 appointments, against 17,900 the year before.",
    wrong: "The clinic recorded 18,450 appointments, against 19,700 the year before.",
  }),
  ...pair("en-g3", "short-note", "en", {
    document:
      "The lease was signed on 3 May. The rent is £64,000 a year, payable quarterly. The term is ten years.",
    right: "The rent is £64,000 a year, payable quarterly.",
    wrong: "The rent is £46,000 a year, payable quarterly.",
  }),
  ...pair("zh-g1", "short-note", "zh-CN", {
    document: "本报告为年度工作总结。全年新签合同 126 份，合同金额 3.8 亿元。详见附表。",
    right: "全年新签合同 126 份，合同金额 3.8 亿元。",
    wrong: "全年新签合同 126 份，合同金额 8.3 亿元。",
  }),
  ...pair("zh-g2", "short-note", "zh-CN", {
    document:
      "本说明为季度经营简报。本季度出货量为 5,400 台，上年同期为 4,950 台。库存情况见下表。",
    right: "本季度出货量为 5,400 台，上年同期为 4,950 台。",
    wrong: "本季度出货量为 5,400 台，上年同期为 4,590 台。",
  }),
  ...pair("zh-g3", "short-note", "zh-CN", {
    document: "本合同于三月签订。年租金为 48 万元，按季度支付。租期五年。",
    right: "年租金为 48 万元，按季度支付。",
    wrong: "年租金为 84 万元，按季度支付。",
  }),
  ...pair("zh-e2", "short-note", "zh-CN", {
    document: "期末在职员工 412 人，年初为 389 人。",
    right: "在职员工人数比年初有所增加。",
    wrong: "在职员工人数比年初有所减少。",
  }),
  // The same number in a unit the table's heading doesn't name (#3022). The first four are the
  // issue's own; the six after them were written before any request and not read while fitting.
  ...pair("en-d1", "table", "en", {
    document: "| Item | Levy (‰) |\n|---|---|\n| Stamp duty | 5 |\n| Transfer | 3 |",
    right: "The levy on stamp duty is 5‰.",
    wrong: "The levy on stamp duty is 5%.",
  }),
  ...pair("en-d2", "table", "en", {
    document:
      "| Stage | Deals | Value (£k) |\n|---|---|---|\n| Qualified | 42 | 1,260 |\n| Proposal | 17 | 830 |",
    right: "Seventeen deals worth £830k were at the proposal stage.",
    wrong: "Seventeen deals worth £830 were at the proposal stage.",
  }),
  ...pair("en-d3", "table", "en", {
    document: "| Region | Output (t) |\n|---|---|\n| North | 54,000 |\n| South | 61,500 |",
    right: "North's output was 54,000 tonnes.",
    wrong: "North's output was 54,000 kg.",
  }),
  ...pair("en-d4", "table", "en", {
    document: "| Metric | YoY% |\n|---|---|\n| Revenue | 12 |\n| Costs | 9 |",
    right: "Revenue grew 12% year on year.",
    wrong: "Revenue grew 12‰ year on year.",
  }),
  ...pair("en-d5", "table", "en", {
    document:
      "| Item | Amount | Unit |\n|---|---|---|\n| Diesel used | 420 | litres |\n| Water used | 1,900 | litres |",
    right: "Diesel used was 420 litres.",
    wrong: "Diesel used was 420 gallons.",
  }),
  ...pair("en-d6", "table", "en", {
    document: "| Division | Revenue ($m) |\n|---|---|\n| Marine | 310 |\n| Rail | 275 |",
    right: "Marine revenue was $310 million.",
    wrong: "Marine revenue was $310 billion.",
  }),
  ...pair("en-d7", "table", "en", {
    document: "| Bond | Spread (bps) |\n|---|---|\n| Series A | 145 |\n| Series B | 210 |",
    right: "The Series A spread was 145 bps.",
    wrong: "The Series A spread was 145 percentage points.",
  }),
  ...pair("zh-d1", "table", "zh-CN", {
    document: "| 项目 | 税率（‰） |\n|---|---|\n| 印花税 | 5 |\n| 过户费 | 3 |",
    right: "印花税税率为5‰。",
    wrong: "印花税税率为5%。",
  }),
  ...pair("zh-d2", "table", "zh-CN", {
    document: "| 部门 | 收入（万元） |\n|---|---|\n| 华东 | 860 |\n| 华南 | 745 |",
    right: "华东收入为860万元。",
    wrong: "华东收入为860元。",
  }),
  ...pair("zh-d3", "table", "zh-CN", {
    document: "单位：吨\n\n| 工厂 | 产量 |\n|---|---|\n| 一厂 | 2,800 |\n| 二厂 | 3,150 |",
    right: "一厂产量为2,800吨。",
    wrong: "一厂产量为2,800千克。",
  }),
  // Tables whose one unit statement doesn't cover every number, as a count of 40 published tables
  // found them (#2997): a money line over a % column, a "%" line over changes in points, per-share
  // rows under a money line, a units column, column headings at two scales, a unit stated once for
  // the Document. Invented; each wrong twin has a wrong scale, a wrong unit or another row's figure.
  ...pair("en-h1", "table", "en", {
    document:
      "Segment performance\n(dollars in millions)\n| Segment | 2025 | 2024 | Change |\n|---|---|---|---|\n| Devices | 4,210 | 3,905 | 8% |\n| Services | 1,130 | 1,020 | 11% |",
    right: "Devices revenue was $4,210 million in 2025.",
    wrong: "Devices revenue was $4,210 thousand in 2025.",
  }),
  ...pair("en-h2", "table", "en", {
    document:
      "Segment performance\n(dollars in millions)\n| Segment | 2025 | 2024 | Change |\n|---|---|---|---|\n| Devices | 4,210 | 3,905 | 8% |\n| Services | 1,130 | 1,020 | 11% |",
    right: "Devices revenue rose 8% from 2024 to 2025.",
    wrong: "Devices revenue rose 8 percentage points from 2024 to 2025.",
  }),
  ...pair("en-h3", "table", "en", {
    document:
      "Unemployment by region\n| Region | Rate (%) | Persons (in thousands) |\n|---|---|---|\n| North | 6.1 | 412 |\n| South | 5.4 | 388 |",
    right: "The unemployment rate in the North was 6.1%.",
    wrong: "The unemployment rate in the North was 61%.",
  }),
  ...pair("en-h4", "table", "en", {
    document:
      "Unemployment by region\n| Region | Rate (%) | Persons (in thousands) |\n|---|---|---|\n| North | 6.1 | 412 |\n| South | 5.4 | 388 |",
    right: "The North had 412 thousand unemployed persons.",
    wrong: "The North had 412 million unemployed persons.",
  }),
  ...pair("en-h5", "table", "en", {
    document:
      "Group income statement\n|  | 2025 £m | 2024 £m |\n|---|---|---|\n| Revenue | 1,840 | 1,715 |\n| Operating profit | 212 | 198 |\n| Basic earnings per share (pence) | 14.2 | 13.1 |",
    right: "Revenue was £1,840 million in 2025.",
    wrong: "Revenue was £1,840 thousand in 2025.",
  }),
  ...pair("en-h6", "table", "en", {
    document:
      "Group income statement\n|  | 2025 £m | 2024 £m |\n|---|---|---|\n| Revenue | 1,840 | 1,715 |\n| Operating profit | 212 | 198 |\n| Basic earnings per share (pence) | 14.2 | 13.1 |",
    right: "Basic earnings per share were 14.2 pence in 2025.",
    wrong: "Basic earnings per share were £14.2 in 2025.",
  }),
  ...pair("en-h7", "table", "en", {
    document:
      "Consolidated statements of operations\n(In millions, except number of shares, which are reflected in thousands, and per-share amounts)\n|  | 2025 | 2024 |\n|---|---|---|\n| Net sales | 8,420 | 7,910 |\n| Earnings per share, basic | 2.14 | 1.98 |\n| Shares used, basic | 1,520,300 | 1,548,900 |",
    right: "Net sales were $8,420 million in 2025.",
    wrong: "Net sales were $8,420 thousand in 2025.",
  }),
  ...pair("en-h8", "table", "en", {
    document:
      "Consolidated statements of operations\n(In millions, except number of shares, which are reflected in thousands, and per-share amounts)\n|  | 2025 | 2024 |\n|---|---|---|\n| Net sales | 8,420 | 7,910 |\n| Earnings per share, basic | 2.14 | 1.98 |\n| Shares used, basic | 1,520,300 | 1,548,900 |",
    right: "Basic earnings per share were $2.14 in 2025.",
    wrong: "Basic earnings per share were $2.14 million in 2025.",
  }),
  ...pair("en-h9", "table", "en", {
    document:
      "Consolidated statements of operations\n(In millions, except number of shares, which are reflected in thousands, and per-share amounts)\n|  | 2025 | 2024 |\n|---|---|---|\n| Net sales | 8,420 | 7,910 |\n| Earnings per share, basic | 2.14 | 1.98 |\n| Shares used, basic | 1,520,300 | 1,548,900 |",
    right: "Basic shares used were 1,520,300 thousand in 2025.",
    wrong: "Basic shares used were 1,520,300 in 2025.",
  }),
  ...pair("en-h10", "table", "en", {
    document:
      "Table 1: Supply and demand by sector, tonnes\n|  | 2024 | 2025 | Change |\n|---|---|---|---|\n| Jewellery | 2,010 | 1,880 | 6% |\n| Price (US$/oz) | 2,386 | 3,120 | 31% |",
    right: "Jewellery demand was 1,880 tonnes in 2025.",
    wrong: "Jewellery demand was 1,880 kilotonnes in 2025.",
  }),
  ...pair("en-h11", "table", "en", {
    document:
      "Table 1: Supply and demand by sector, tonnes\n|  | 2024 | 2025 | Change |\n|---|---|---|---|\n| Jewellery | 2,010 | 1,880 | 6% |\n| Price (US$/oz) | 2,386 | 3,120 | 31% |",
    right: "The price was US$3,120 an ounce in 2025.",
    wrong: "The price was US$3,120 a tonne in 2025.",
  }),
  ...pair("zh-h1", "table", "zh-CN", {
    document:
      "附件1 一般公共预算收入决算表\n单位：万元\n| 项目 | 预算数 | 决算数 | 决算数为预算数的% |\n|---|---|---|---|\n| 税收收入 | 5200 | 5460 | 105 |\n| 非税收入 | 1800 | 1710 | 95 |",
    right: "税收收入决算数为5460万元。",
    wrong: "税收收入决算数为5460元。",
  }),
  ...pair("zh-h2", "table", "zh-CN", {
    document:
      "附件1 一般公共预算收入决算表\n单位：万元\n| 项目 | 预算数 | 决算数 | 决算数为预算数的% |\n|---|---|---|---|\n| 税收收入 | 5200 | 5460 | 105 |\n| 非税收入 | 1800 | 1710 | 95 |",
    right: "税收收入决算数为预算数的105%。",
    wrong: "税收收入决算数为预算数的95%。",
  }),
  ...pair("zh-h3", "table", "zh-CN", {
    document:
      "表3 新发放贷款加权平均利率情况\n单位：%\n| 项目 | 12月 | 比9月变化 | 同比变化 |\n|---|---|---|---|\n| 企业贷款 | 3.40 | 0.12 | 0.35 |\n| 个人住房贷款 | 3.10 | 0.21 | 0.88 |",
    right: "12月企业贷款利率为3.40%。",
    wrong: "12月企业贷款利率为3.10%。",
  }),
  ...pair("zh-h4", "table", "zh-CN", {
    document:
      "表3 新发放贷款加权平均利率情况\n单位：%\n| 项目 | 12月 | 比9月变化 | 同比变化 |\n|---|---|---|---|\n| 企业贷款 | 3.40 | 0.12 | 0.35 |\n| 个人住房贷款 | 3.10 | 0.21 | 0.88 |",
    right: "企业贷款利率比9月上升0.12个百分点。",
    wrong: "企业贷款利率比9月上升0.12%。",
  }),
  ...pair("zh-h5", "table", "zh-CN", {
    document:
      "主营业务分产品情况\n单位：元 币种：人民币\n| 分产品 | 营业收入 | 营业成本 | 毛利率（%） | 毛利率比上年增减（%） |\n|---|---|---|---|---|\n| 甲类产品 | 8200000 | 3100000 | 62.2 | 增加1.2个百分点 |\n| 乙类产品 | 4100000 | 2300000 | 43.9 | 减少0.8个百分点 |",
    right: "甲类产品毛利率比上年增加1.2个百分点。",
    wrong: "甲类产品毛利率比上年增加1.2%。",
  }),
  ...pair("zh-h6", "table", "zh-CN", {
    document:
      "主营业务分产品情况\n单位：元 币种：人民币\n| 分产品 | 营业收入 | 营业成本 | 毛利率（%） | 毛利率比上年增减（%） |\n|---|---|---|---|---|\n| 甲类产品 | 8200000 | 3100000 | 62.2 | 增加1.2个百分点 |\n| 乙类产品 | 4100000 | 2300000 | 43.9 | 减少0.8个百分点 |",
    right: "甲类产品营业收入为820万元。",
    wrong: "甲类产品营业收入为8200万元。",
  }),
  ...pair("zh-h7", "table", "zh-CN", {
    document:
      "主要财务指标\n单位：元\n| 主要财务指标 | 2024年 | 2023年 |\n|---|---|---|\n| 营业收入 | 52000000 | 48000000 |\n| 基本每股收益（元/股） | 0.52 | 0.48 |\n| 加权平均净资产收益率（%） | 12.4 | 11.9 |",
    right: "2024年基本每股收益为0.52元。",
    wrong: "2024年基本每股收益为0.52万元。",
  }),
  ...pair("zh-h8", "table", "zh-CN", {
    document:
      "主要财务指标\n单位：元\n| 主要财务指标 | 2024年 | 2023年 |\n|---|---|---|\n| 营业收入 | 52000000 | 48000000 |\n| 基本每股收益（元/股） | 0.52 | 0.48 |\n| 加权平均净资产收益率（%） | 12.4 | 11.9 |",
    right: "2024年加权平均净资产收益率为12.4%。",
    wrong: "2024年加权平均净资产收益率为11.9%。",
  }),
  ...pair("zh-h9", "table", "zh-CN", {
    document:
      "除特别注明外，金额单位均为人民币百万元\n\n四、财务报表主要项目附注\n\n1. 现金及存放中央银行款项\n| 项目 | 2024年末 | 2023年末 |\n|---|---|---|\n| 库存现金 | 1520 | 1480 |\n| 存放中央银行款项 | 9300 | 8800 |",
    right: "2024年末库存现金为15.2亿元。",
    wrong: "2024年末库存现金为1520万元。",
  }),
  ...pair("zh-h10", "table", "zh-CN", {
    document:
      "表4 财政拨款支出决算表\n单位：青禾大学　　单位：万元\n| 科目 | 合计 | 基本支出 | 项目支出 |\n|---|---|---|---|\n| 教育支出 | 8400 | 6100 | 2300 |\n| 科学技术支出 | 1200 | 300 | 900 |",
    right: "教育支出合计8400万元。",
    wrong: "教育支出合计8400元。",
  }),
  ...pair("zh-h11", "table", "zh-CN", {
    document:
      "表3 主要产品产量及其增长速度\n| 产品名称 | 单位 | 产量 | 比上年增长（%） |\n|---|---|---|---|\n| 原煤 | 万吨 | 540 | 3.2 |\n| 汽车 | 万辆 | 31 | 1.5 |",
    right: "原煤产量为540万吨。",
    wrong: "原煤产量为540吨。",
  }),
  ...pair("zh-h12", "table", "zh-CN", {
    document:
      "表3 主要产品产量及其增长速度\n| 产品名称 | 单位 | 产量 | 比上年增长（%） |\n|---|---|---|---|\n| 原煤 | 万吨 | 540 | 3.2 |\n| 汽车 | 万辆 | 31 | 1.5 |",
    right: "原煤产量比上年增长3.2%。",
    wrong: "原煤产量比上年增长3.2个百分点。",
  }),
  ...pair("zh-h13", "table", "zh-CN", {
    document:
      "表1 主要财务数据\n| 项目 | 2023年 | 2024年 |\n|---|---|---|\n| 资产总额（万亿元） | 3.1 | 3.4 |\n| 不良贷款率（%） | 1.62 | 1.50 |",
    right: "2024年资产总额为3.4万亿元。",
    wrong: "2024年资产总额为3.4亿元。",
  }),
  ...pair("zh-h14", "table", "zh-CN", {
    document:
      "表7 社会融资规模\n| 项目 | 年末存量（万亿元） | 同比增速（%） | 全年增量（亿元） |\n|---|---|---|---|\n| 人民币贷款 | 252.5 | 7.2 | 170500 |\n| 企业债券 | 32.3 | 3.8 | 19000 |",
    right: "人民币贷款年末存量为252.5万亿元。",
    wrong: "人民币贷款年末存量为252.5亿元。",
  }),
  ...pair("zh-h15", "table", "zh-CN", {
    document:
      "表7 社会融资规模\n| 项目 | 年末存量（万亿元） | 同比增速（%） | 全年增量（亿元） |\n|---|---|---|---|\n| 人民币贷款 | 252.5 | 7.2 | 170500 |\n| 企业债券 | 32.3 | 3.8 | 19000 |",
    right: "人民币贷款全年增量为17.05万亿元。",
    wrong: "人民币贷款全年增量为1.705万亿元。",
  }),
  // The word-boundary gaps of #2251: a letter or character that is no unit where it stands ("5G",
  // 升 as a verb, 每米勒) beside a plain number, and a sentence that adds that unit to the number.
  ...pair("en-u3", "short-note", "en", {
    document: "The price was $5m. The cable length was 5.",
    right: "The cable length was 5.",
    wrong: "The cable was 5 m long.",
  }),
  ...pair("en-u4", "short-note", "en", {
    document: "It runs on the 5G network. The parcel weight was 5.",
    right: "The parcel weight was 5.",
    wrong: "The parcel weighed 5 g.",
  }),
  ...pair("en-u5", "short-note", "en", {
    document: "See note (m). The span was 54.",
    right: "The span was 54.",
    wrong: "The span was 54 m.",
  }),
  ...pair("zh-u1", "short-note", "zh-CN", {
    document: "单位：元\n产量\t54,000",
    right: "产量为54,000元。",
    wrong: "产量为54,000吨。",
  }),
  ...pair("zh-u2", "short-note", "zh-CN", {
    document: "单位：吨位分析\n产量\t54,000",
    right: "产量为54,000。",
    wrong: "产量为54,000吨。",
  }),
  ...pair("zh-u6a", "short-note", "zh-CN", {
    document: "股价从10升至12。销量为12。",
    right: "销量为12。",
    wrong: "销量为12升。",
  }),
  ...pair("zh-u6b", "short-note", "zh-CN", {
    document: "系统从3.0升级到4.0。容量为4.0。",
    right: "容量为4.0。",
    wrong: "容量为4.0升。",
  }),
  ...pair("zh-u7", "short-note", "zh-CN", {
    document: "请千万克制。重量为54。",
    right: "重量为54。",
    wrong: "重量为54克。",
  }),
  ...pair("zh-u8", "short-note", "zh-CN", {
    document: "每米勒公司一份，路线长54",
    right: "路线长54。",
    wrong: "路线长54米。",
  }),
  ...pair("zh-u9", "short-note", "zh-CN", {
    document: "2026/克和米兰，产量54,000",
    right: "产量为54,000。",
    wrong: "产量为54,000吨。",
  }),
  ...pair("zh-u10", "short-note", "zh-CN", {
    document: "编号2026/吨钢厂，产量54,000",
    right: "产量为54,000。",
    wrong: "产量为54,000吨。",
  }),
  ...pair("zh-u11a", "short-note", "zh-CN", {
    document: "每升学一次登记一份，数量为54",
    right: "数量为54。",
    wrong: "数量为54升。",
  }),
  ...pair("zh-u11b", "short-note", "zh-CN", {
    document: "每升任一次登记一份，数量为54",
    right: "数量为54。",
    wrong: "数量为54升。",
  }),
  ...pair("zh-u12", "short-note", "zh-CN", {
    document: "吨级54,000",
    right: "吨级为54,000。",
    wrong: "产量为54,000吨。",
  }),
  // A sentence that says less than its Passage, leaving out its year, number or how it was found,
  // is right (#3197); one that adds a wider group or a part, or drops its condition, is not.
  ...pair("en-n1", "short-note", "en", {
    document:
      "Report 14, March 2025: the Harbour depot handled 4,200 containers in the month, up from 3,900.",
    right: "The Harbour depot handled 4,200 containers in the month.",
    wrong: "The Harbour depot and the Quay depot each handled 4,200 containers in the month.",
  }),
  ...pair("en-n2", "short-note", "en", {
    document:
      "Under clause 9 of the 2024 handbook, staff may work remotely two days a week, provided the team lead agrees in advance.",
    right: "Staff may work remotely two days a week, provided the team lead agrees in advance.",
    wrong: "Staff may work remotely two days a week.",
  }),
  ...pair("en-n3", "short-note", "en", {
    document:
      "The survey of 1,180 tenants, carried out by post in May, found that 62% were satisfied with repairs.",
    right: "62% of the tenants surveyed were satisfied with repairs.",
    wrong: "62% of the tenants surveyed were satisfied with repairs and with rents.",
  }),
  ...pair("zh-n1", "short-note", "zh-CN", {
    document: "2025年第三季度，南湖仓库（编号07）出库量为1.8万件，同比增长6%。",
    right: "南湖仓库出库量为1.8万件。",
    wrong: "南湖仓库和北岸仓库出库量均为1.8万件。",
  }),
  ...pair("zh-n2", "short-note", "zh-CN", {
    document: "根据2024年版员工手册第9条，员工可每周远程办公两天，须事先与主管商定。",
    right: "员工可每周远程办公两天，须事先与主管商定。",
    wrong: "员工可每周远程办公两天。",
  }),
  ...pair("zh-n3", "short-note", "zh-CN", {
    document: "本次问卷于5月以邮寄方式发放，共回收1,180份，其中62%的租户对维修服务表示满意。",
    right: "62%的受访租户对维修服务表示满意。",
    wrong: "62%的受访租户对维修服务和租金水平均表示满意。",
  }),
  // A right or a duty with the requirement that trails it after a comma (#3257): the sentence that
  // keeps it is right, the one that drops it is wrong, and so is one that changes who must agree
  // or what the limit is.
  ...withCondition("en-n2x", "en", {
    document:
      "Under clause 9 of the 2024 handbook, staff may work remotely two days a week, provided the team lead agrees in advance.",
    changed:
      "Staff may work remotely two days a week, provided the finance director agrees in advance.",
  }),
  ...withCondition("en-k1", "en", {
    document:
      "Section 4 of the 2025 residents' guide: residents may keep one pet in a flat, provided the building manager approves it in writing.",
    right:
      "Residents may keep one pet in a flat, provided the building manager approves it in writing.",
    dropped: "Residents may keep one pet in a flat.",
    changed:
      "Residents may keep one pet in a flat, provided their neighbours approve it in writing.",
  }),
  ...withCondition("en-k2", "en", {
    document:
      "Per rule 12 of the 2023 lab manual, students may use the laser cutter after hours, provided a technician is present.",
    right: "Students may use the laser cutter after hours, provided a technician is present.",
    dropped: "Students may use the laser cutter after hours.",
    changed:
      "Students may use the laser cutter after hours, provided they have booked it a week ahead.",
  }),
  ...withCondition("zh-n2x", "zh-CN", {
    document: "根据2024年版员工手册第9条，员工可每周远程办公两天，须事先与主管商定。",
    changed: "员工可每周远程办公两天，须事先与财务总监商定。",
  }),
  ...withCondition("zh-k1", "zh-CN", {
    document: "按2025年版住户手册第4条，住户可在公共花园举办小型聚会，须提前三天向物业报备。",
    right: "住户可在公共花园举办小型聚会，须提前三天向物业报备。",
    dropped: "住户可在公共花园举办小型聚会。",
    changed: "住户可在公共花园举办小型聚会，须提前一天向物业报备。",
  }),
  ...withCondition("zh-k2", "zh-CN", {
    document: "根据2023年实验室守则第12条，学生可在课后使用三维打印机，但须有指导教师在场。",
    right: "学生可在课后使用三维打印机，但须有指导教师在场。",
    dropped: "学生可在课后使用三维打印机。",
    changed: "学生可在课后使用三维打印机，但须有保安在场。",
  }),
];

/** A pair whose right sentence keeps its Document's condition, with a second wrong twin that changes it; `en-n2` and `zh-n2` above are the pairs of the two given only that twin. */
function withCondition(
  id: string,
  language: Language,
  words: { document: string; right?: string; dropped?: string; changed: string },
): HeldOut[] {
  const { document, right, dropped, changed } = words;
  const twin = (suffix: string, sentence: string, expected: HeldOut["expected"]): HeldOut => ({
    id: `${id}${suffix}`,
    kind: "short-note",
    language,
    document,
    sentence,
    expected,
  });
  return [
    ...(right && dropped ? [twin("-right", right, "right"), twin("-wrong", dropped, "wrong")] : []),
    twin(right ? "x-wrong" : "-wrong", changed, "wrong"),
  ];
}

function pair(
  id: string,
  kind: HeldOut["kind"],
  language: Language,
  words: { document: string; right: string; wrong: string; parts?: readonly [string, string] },
): HeldOut[] {
  return [
    {
      id: `${id}-right`,
      kind,
      language,
      document: words.document,
      sentence: words.right,
      expected: "right",
      ...(words.parts && { part: words.parts[0] }),
    },
    {
      id: `${id}-wrong`,
      kind,
      language,
      document: words.document,
      sentence: words.wrong,
      expected: "wrong",
      ...(words.parts && { part: words.parts[1] }),
    },
  ];
}

/** The everyday set (`everydaySentences.cases.ts`), each pair a right sentence and its wrong twin. */
const EVERYDAY: readonly HeldOut[] = EVERYDAY_PAIRS.flatMap((each) =>
  pair(each.id, "short-note", each.language, each),
);

/** The finance, law and medicine set (`fieldSentences.cases.ts`): twins wrong without a contradiction. */
const FIELD: readonly HeldOut[] = FIELD_PAIRS.flatMap((each) =>
  pair(each.id, "short-note", each.language, each),
);

/** Duties a Document sets, in Chinese, and the writer's own advice (`dutySentences.cases.ts`, #3262). */
const DUTY: readonly HeldOut[] = [
  ...DUTY_PAIRS.flatMap((each) => pair(each.id, "short-note", "zh-CN", each)),
  ...ADVICE.map(
    ({ id, language, document, sentence }): HeldOut => ({
      id,
      kind: "short-note",
      language,
      document,
      sentence,
      expected: "none",
    }),
  ),
];

/** What the run's requests did: each check Run's replies, and every refused, failed or timed-out request. */
const heard = {
  requests: 0,
  refused: 0,
  failed: 0,
  timedOut: 0,
  inputTokens: 0,
  outputTokens: 0,
  /** Reasoning tokens the replies report, and how many replies reported any. */
  reasoningTokens: 0,
  thought: 0,
  /** Replies that ended at the output limit. */
  cut: 0,
  /** Dollars, at the catalog's Haiku 5.5 price, from each reply's own usage. */
  spent: 0,
  /** Requests not sent because the gate's stop was reached. */
  held: 0,
  replies: [] as { prompt: string; sentence: string; text: string }[],
};

/** The gate's stop in dollars, and what the gate spent before this arm-round. */
const STOP = Number(process.env.INCARNAMIND_LIVE_GATE_STOP_USD ?? "Infinity");
const SPENT_BEFORE = Number(process.env.INCARNAMIND_LIVE_GATE_SPENT_USD ?? "0");
/** Room for the requests already in flight when the stop is reached: a few at about $0.001 each. */
const IN_FLIGHT = 0.05;

type Usage = LanguageModelV4Usage;

/**
 * Haiku 5.5's catalog price, per million tokens: uncached input, cache reads, cache writes, output.
 * Another provider's model is priced as the catalog prices it at the hour of the request.
 */
function priced(usage: Usage) {
  const input = usage.inputTokens;
  heard.inputTokens += input.total ?? 0;
  heard.outputTokens += usage.outputTokens.total ?? 0;
  const reasoning = usage.outputTokens.reasoning ?? 0;
  heard.reasoningTokens += reasoning;
  if (reasoning > 0) heard.thought++;
  const price = PROVIDER === "anthropic" ? undefined : catalogModel(PROVIDER, MODEL)?.price;
  if (price) {
    heard.spent += inCurrency(
      costOf(
        {
          inputTokens: input.total ?? 0,
          cachedInputTokens: input.cacheRead ?? 0,
          outputTokens: usage.outputTokens.total ?? 0,
        },
        price,
        new Date(),
      ),
      price.currency,
      "USD",
    );
    return;
  }
  heard.spent +=
    ((input.noCache ?? input.total ?? 0) * 0.1 +
      (input.cacheRead ?? 0) * 0.01 +
      (input.cacheWrite ?? 0) * 0.125 +
      (usage.outputTokens.total ?? 0) * 0.5) /
    1_000_000;
}

/** Counts a reply the provider ended at its output limit. */
function endedAtLimit(reason: unknown) {
  const unified =
    typeof reason === "object" && reason !== null && "unified" in reason ? reason.unified : reason;
  if (unified === "length") heard.cut++;
}

/** Sends no request once the gate's spend, before this arm-round and in it, reaches its stop. */
function underStop() {
  if (SPENT_BEFORE + heard.spent < STOP - IN_FLIGHT) return;
  heard.held++;
  throw new Error("The gate's spend stop is reached; no more requests are sent.");
}

type Params = LanguageModelV4CallOptions;

const textOf = (prompt: Params["prompt"], role?: string): string =>
  prompt
    .filter((message) => (role ? message.role === role : message.role !== "system"))
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n");

function heardFailure(error: unknown): never {
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? Number(error.statusCode)
      : null;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") heard.timedOut++;
  else if (status !== null && status >= 400) heard.refused++;
  else heard.failed++;
  throw error;
}

/** A Tool call of a reply, as the saved file keeps it. */
interface HeardCall {
  tool: string;
  input: unknown;
}

/** What the Tools answered since the model's last turn, each cut to its first words. */
function toolResults(prompt: Params["prompt"]): { tool: string; output: string }[] {
  const from = prompt.findLastIndex((message) => message.role === "assistant");
  return prompt
    .slice(from + 1)
    .flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result"
              ? [{ tool: part.toolName, output: JSON.stringify(part.output).slice(0, 600) }]
              : [],
          )
        : [],
    );
}

function heardReply(params: Params, text: string, calls: readonly HeardCall[] = []) {
  if (REPLIES)
    appendFileSync(
      REPLIES,
      `${JSON.stringify({ arm: ARM, round: ROUND, to: textOf(params.prompt, "system").slice(0, 80), prompt: textOf(params.prompt), results: toolResults(params.prompt), text, calls })}\n`,
    );
  if (!textOf(params.prompt, "system").startsWith("You check one sentence")) return;
  const prompt = textOf(params.prompt);
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(prompt)?.[1] ?? "";
  heard.replies.push({ prompt, sentence, text });
}

/** The real model, every request counted and every check Run's reply kept. */
const realModel: NonNullable<Parameters<typeof startCore>[1]>["createChatModel"] = (spec) =>
  wrapLanguageModel({
    model: createAiSdkChatModel(spec),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params }) => {
        underStop();
        heard.requests++;
        const result = await Promise.resolve(doGenerate()).catch(heardFailure);
        priced(result.usage);
        endedAtLimit(result.finishReason);
        const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        const calls = result.content.flatMap((part) =>
          part.type === "tool-call" ? [{ tool: part.toolName, input: part.input }] : [],
        );
        if (text.length > 0 || calls.length > 0) heardReply(params, text.join(""), calls);
        return result;
      },
      wrapStream: async ({ doStream, params }) => {
        underStop();
        heard.requests++;
        const result = await Promise.resolve(doStream()).catch(heardFailure);
        let text = "";
        const calls: HeardCall[] = [];
        const stream = result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part.type === "text-delta") text += part.delta;
              if (part.type === "tool-call") calls.push({ tool: part.toolName, input: part.input });
              if (part.type === "error") heard.failed++;
              if (part.type === "finish") {
                priced(part.usage);
                endedAtLimit(part.finishReason);
              }
              controller.enqueue(part);
            },
            flush() {
              heardReply(params, text, calls);
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });

interface SavedReply {
  to: string;
  prompt: string;
  results: unknown;
  text: string;
  calls: { tool: string; input: unknown }[];
  /** What the model thought before this reply, read back from the next request of its Run. */
  reasoning?: string;
}

/** The saved replies by their request: its system prompt's start, its words and its Tools' results. */
const saved = new Map<string, SavedReply[]>();
const savedLoosely = new Map<string, SavedReply[]>();
for (const file of REPLAY ?? []) {
  const replies = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SavedReply);
  for (const reply of replies) {
    // A thinking model's thoughts go back with its reply in the Run's next request, and the saved
    // reply holds only its words: the thoughts are what stands before them there.
    const start = `${reply.prompt}\n`;
    let next: SavedReply | undefined;
    for (const other of replies) {
      if (
        other.to === reply.to &&
        other.prompt.length > start.length &&
        other.prompt.startsWith(start) &&
        (!next || other.prompt.length < next.prompt.length)
      )
        next = other;
    }
    if (next) {
      const rest = next.prompt.slice(start.length);
      const at = reply.text ? rest.indexOf(reply.text) : rest.endsWith("\n") ? rest.length - 1 : -1;
      if (at > 0) reply.reasoning = rest.slice(0, at);
    }
    const loose = `${reply.to}\u0000${reply.prompt}`;
    const exact = `${loose}\u0000${JSON.stringify(reply.results)}`;
    saved.set(exact, [...(saved.get(exact) ?? []), reply]);
    savedLoosely.set(loose, [...(savedLoosely.get(loose) ?? []), reply]);
  }
}
const replayed = { exact: 0, loose: 0, missed: 0, misses: [] as string[] };

/** The saved reply to this request; a request no saved reply answers is a miss and ends its check. */
function savedReply(prompt: Params["prompt"]): SavedReply {
  heard.requests++;
  const loose = `${textOf(prompt, "system").slice(0, 80)}\u0000${textOf(prompt)}`;
  const exact = saved.get(`${loose}\u0000${JSON.stringify(toolResults(prompt))}`);
  const found = exact ?? savedLoosely.get(loose);
  const reply = found?.[0];
  if (!reply) {
    replayed.missed++;
    replayed.misses.push(
      `${textOf(prompt, "system").slice(0, 40)} | ${/<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(textOf(prompt))?.[1] ?? textOf(prompt).slice(0, 120)}`,
    );
    throw new Error("No saved reply answers this request.");
  }
  if (exact) replayed.exact++;
  else replayed.loose++;
  // A request sent twice was answered twice: each saved reply is given once, the last one again.
  if (found.length > 1) found.shift();
  return reply;
}

const replayModel = scriptedModel(
  (call) => {
    void call.question;
    void call.json;
    const reply = savedReply(call.options.prompt);
    if (isCheckRun(call) && reply.text)
      heard.replies.push({ prompt: call.prompt, sentence: sentenceOf(call), text: reply.text });
    return {
      ...(reply.reasoning && { reasoning: reply.reasoning }),
      text: reply.text,
      calls: reply.calls.map((each) => ({
        tool: each.tool,
        input: typeof each.input === "string" ? JSON.parse(each.input) : each.input,
        ...(typeof each.input === "string" && { raw: each.input }),
      })),
    };
  },
  { generate: (call) => ({ text: savedReply(call.options.prompt).text }) },
);

/** The dry run's sort: a sentence's parts are before and after its first comma, as a real sort may split them. */
function dryParts(text: string): { kind: "fact"; text: string }[] {
  const comma = /,\s+|，/u.exec(text);
  if (!comma) return [{ kind: "fact", text }];
  return [
    { kind: "fact", text: text.slice(0, comma.index) },
    { kind: "fact", text: text.slice(comma.index + comma[0].length).replace(/[.。]$/u, "") },
  ];
}

/** The dry run's judge: it sorts as `dryParts` does, searches once and finds nothing. */
const dryModel = scriptedModel(
  (call) => {
    heard.requests++;
    if (!isCheckRun(call)) return { text: "Done." };
    if (!call.results.some((result) => result.tool === "search_documents"))
      return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
    const text = unsupportedReply(call);
    heard.replies.push({ prompt: call.prompt, sentence: sentenceOf(call), text });
    return { text };
  },
  {
    generate: (call) => {
      heard.requests++;
      if (call.question !== "find-claims") return checkGenerate({})(call);
      const { sentences } = JSON.parse(call.prompt) as {
        sentences: { number: number; text: string }[];
      };
      return {
        text: JSON.stringify({
          sentences: sentences.map(({ number, text }) => ({
            number,
            parts: dryParts(text),
          })),
        }),
      };
    },
  },
);

async function coreIn(language: Language): Promise<Core> {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    paths: { dataDir, examples: EXAMPLES },
    createChatModel: DRY
      ? scriptedModels(dryModel).createChatModel
      : REPLAY
        ? scriptedModels(replayModel).createChatModel
        : realModel,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({ user: { language, monthlyCap: { amount: 5, currency: "USD" } } });
  if (DRY) await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  else
    await core.saveChatProvider({
      kind: PROVIDER,
      apiKey: REPLAY ? "replay" : (KEY ?? ""),
      modelId: MODEL,
    });
  if (!DRY && !REPLAY && DECISION_KEY) {
    await core.saveChatProvider({
      kind: "openrouter",
      apiKey: DECISION_KEY,
      modelId: "anthropic/claude-haiku-5.5",
      keepDefault: true,
    });
    await core.updateSettings({
      device: {
        checkDecisionModel: { host: "openrouter", modelId: "perplexity/pplx-decider-v1.2" },
      },
    });
  }
  return core;
}

async function examplesReady(core: Core): Promise<Document[]> {
  await core.createExamples();
  const examples = await core.getExamples();
  return vi.waitFor(
    async () => {
      const read = await core.listDocuments({ linkedFolderId: examples.linkedFolderId ?? "" });
      expect(read.length).toBe(2);
      expect(read.every((each) => each.status === "ready")).toBe(true);
      return read;
    },
    { timeout: 60_000 },
  );
}

/** A Citation of `line` in `document`, made as the viewer makes one from selected words. */
async function citationOf(core: Core, document: Document, line: string): Promise<JSONContent> {
  const selected = await core.citeSelection({
    documentId: document.id,
    parts: [{ unit: 1, text: line }],
  });
  return {
    type: "citation",
    attrs: {
      passageId: selected.passageId,
      documentId: document.id,
      documentName: document.name,
      contentHash: selected.contentHash,
      quote: selected.quote,
      pageFrom: selected.pageFrom,
      pageTo: selected.pageTo,
      location: selected.location,
      check: selected.check,
    },
  };
}

interface Written {
  client: MindClient;
  mindId: string;
  probes: readonly Probe[];
  row: Record<string, unknown>;
}

async function noteOf(
  core: Core,
  title: string,
  probes: readonly Probe[],
  citation: JSONContent | null,
  folderId?: string,
): Promise<Pick<Written, "client" | "mindId">> {
  const mind = await core.createMind({ title, ...(folderId && { folderId }) });
  const client = await connectToMind(core, mind.id);
  writeMind(
    client,
    probes.map(({ sentence }, index) => ({
      type: "paragraph",
      attrs: { id: `line-${index}` },
      content: [
        { type: "text", text: sentence },
        ...(citation && sentence.includes("EBITDA") ? [citation] : []),
      ],
    })),
  );
  await client.settled();
  return { client, mindId: mind.id };
}

/**
 * The first verdict a check Run of `part`, in the Note whose sentence is `sentence`, wrote, of the
 * replies heard since `from`: one core's, since a round's set-ups check the same sentences.
 */
function firstReplyOf(part: string, sentence: string, from: number): string | null {
  const reply = heard.replies
    .slice(from)
    .find(
      (each) =>
        each.sentence === part && each.prompt.includes(sentence) && readVerdict(each.text) !== null,
    );
  return reply ? (readVerdict(reply.text)?.verdict ?? null) : null;
}

async function checkAll(core: Core, language: Language, notes: readonly Written[]) {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  const from = heard.replies.length;
  const rows: Record<string, unknown>[] = [];
  for (let at = 0; at < notes.length; at += AT_ONCE) {
    await Promise.all(
      notes.slice(at, at + AT_ONCE).map(async ({ client, mindId, probes, row }) => {
        const run = await core.checkMind({
          requestId: `${ARM}-${ROUND}-${mindId}`,
          mindId,
          mode: "all",
        });
        await client.settled();
        const spans = claimSpans(readMind(client));
        for (const probe of probes) {
          const span = spans.find((each) => each.sentence.text.trim() === probe.sentence);
          const check = span?.check;
          const parts = (check?.parts ?? []).map((each) => ({
            text: probe.sentence.slice(each.span.start, each.span.end),
            verdict: each.verdict,
            reason: each.verdict === "not-checked" ? each.reason : null,
          }));
          const part = probe.part ? parts.find((each) => each.text === probe.part) : undefined;
          rows.push({
            ...row,
            run: run.kind,
            sentence: probe.sentence,
            expected: probe.expected,
            state: check?.state ?? "no-mark",
            by: check?.parts?.[0]?.modelId ?? check?.modelId ?? null,
            kind: check?.parts?.[0]?.unsupported?.word ?? null,
            reason: check?.state === "not-checked" ? check.reason : null,
            line:
              check?.state === "not-checked" && check.reason
                ? reasonText(t, language, check.reason, check.detail)
                : null,
            figures: (check?.figures ?? []).map((figure) => ({
              shown: figure.reading.chars,
              state: figure.state,
              reason: figure.state === "not-checked" ? figure.reason : null,
            })),
            parts,
            ...(probe.part && {
              part: probe.part,
              partVerdict: part?.verdict ?? null,
              firstReply: firstReplyOf(probe.part, probe.sentence, from),
              firstReplyFrom: "its own core",
            }),
          });
        }
      }),
    );
  }
  return rows;
}

function write(rows: readonly Record<string, unknown>[]) {
  if (!OUT) return;
  for (const row of rows) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

async function exampleRound(language: Language, own: boolean) {
  const words = EXAMPLE[language];
  const core = await coreIn(language);
  const report = (await examplesReady(core)).find((each) => each.name === words.report);
  if (!report) throw new Error("The example's report isn't there.");
  if (own) {
    const sources = await createSourceFolder();
    await addAndProcess(core, [
      await writeSourceFile(
        sources,
        `${words.own.name}.md`,
        `# ${words.own.name}\n\n${words.own.text}\n`,
      ),
    ]);
  }
  const citation = await citationOf(core, report, words.line);
  const setup = own ? "example+own" : "example";
  const base = { arm: ARM, round: ROUND, group: "example", language, setup };
  const notes: Written[] = [
    {
      ...(await noteOf(core, "Summary of my documents", words.note, citation)),
      probes: words.note,
      row: { ...base, case: "note" },
    },
    ...(await Promise.all(
      words.twins.map(async (twin, index) => ({
        ...(await noteOf(core, `Twin ${index + 1}`, [twin], citation)),
        probes: [twin],
        row: { ...base, case: `twin-${index + 1}` },
      })),
    )),
  ];
  const rows = await checkAll(core, language, notes);
  const { spent } = await core.getCostSummary();
  core.close();
  return { rows, spent };
}

async function heldOutRound(
  language: Language,
  from: readonly HeldOut[] = HELD_OUT,
  group = "held-out",
) {
  const cases = from.filter(
    (each) =>
      each.language === language && (CASES?.some((start) => each.id.startsWith(start)) ?? true),
  );
  const core = await coreIn(language);
  const sources = await createSourceFolder();
  const notes: Written[] = [];
  for (const each of cases) {
    const [file] = await addAndProcess(core, [
      await writeSourceFile(sources, `${each.id}.md`, `# ${each.id}\n\n${each.document}\n`),
    ]);
    if (!file) throw new Error(`${each.id}'s Document didn't process.`);
    const folder = await core.createLibraryGroup({ name: each.id, description: "" });
    await core.moveToFolder({ documentIds: [file.id], folderId: folder.id });
    notes.push({
      ...(await noteOf(core, each.id, [each], null, folder.id)),
      probes: [each],
      row: {
        arm: ARM,
        round: ROUND,
        group,
        language,
        case: each.id,
        kind: each.kind,
      },
    });
  }
  const rows = await checkAll(core, language, notes);
  const { spent } = await core.getCostSummary();
  core.close();
  return { rows, spent };
}

/**
 * The Notes of `remarkSentences.cases.ts` (#3320), each in its own Folder with its Document: facts
 * a check reads, and the writer's own remarks about the Note, which it leaves without a mark.
 */
async function remarkRound(language: Language) {
  const cases = [...REMARK_NOTES, ...JUDGEMENT_NOTES].filter(
    (each) =>
      each.language === language && (CASES?.some((start) => each.id.startsWith(start)) ?? true),
  );
  const core = await coreIn(language);
  const sources = await createSourceFolder();
  const notes: Written[] = [];
  for (const each of cases) {
    const [file] = await addAndProcess(core, [
      await writeSourceFile(sources, `${each.name}.md`, `# ${each.name}\n\n${each.document}\n`),
    ]);
    if (!file) throw new Error(`${each.id}'s Document didn't process.`);
    const folder = await core.createLibraryGroup({ name: each.id, description: "" });
    await core.moveToFolder({ documentIds: [file.id], folderId: folder.id });
    notes.push({
      ...(await noteOf(core, each.id, each.lines, null, folder.id)),
      probes: each.lines,
      row: { arm: ARM, round: ROUND, group: "remark", language, case: each.id },
    });
  }
  const rows = await checkAll(core, language, notes);
  const { spent } = await core.getCostSummary();
  core.close();
  return { rows, spent };
}

/**
 * Each held-out sentence through the bare claim check, as a Meeting's fill and a Comparison's
 * cells ask it (#3022): its own core, with the pair's Document alone in the Library.
 */
async function claimRound(language: Language) {
  const cases = HELD_OUT.filter(
    (each) =>
      each.language === language && (CASES?.some((start) => each.id.startsWith(start)) ?? true),
  );
  const rows: Record<string, unknown>[] = [];
  const spent: unknown[] = [];
  for (const each of cases) {
    const core = await coreIn(language);
    const sources = await createSourceFolder();
    const [file] = await addAndProcess(core, [
      await writeSourceFile(sources, `${each.id}.md`, `# ${each.id}\n\n${each.document}\n`),
    ]);
    if (!file) throw new Error(`${each.id}'s Document didn't process.`);
    const result = await core.checkClaim({ claim: each.sentence }).catch((error: unknown) => ({
      verdict: "threw",
      unsupported: { reason: String(error) },
    }));
    rows.push({
      arm: ARM,
      round: ROUND,
      group: "claim",
      language,
      case: each.id,
      kind: each.kind,
      expected: each.expected,
      state: result.verdict,
      reason: "unsupported" in result ? (result.unsupported?.reason ?? null) : null,
    });
    spent.push((await core.getCostSummary()).spent);
    core.close();
  }
  return { rows, spent };
}

/**
 * One Note of a language's everyday sentences, the right ones and their wrong twins, in one Folder
 * with their Documents: how long Check this Note takes the User from the click to the last Mark.
 */
async function wholeNoteRound(language: Language) {
  const cases = EVERYDAY.filter((each) => each.language === language);
  const core = await coreIn(language);
  const sources = await createSourceFolder();
  const folder = await core.createLibraryGroup({ name: "Everyday", description: "" });
  const added = new Set<string>();
  for (const each of cases) {
    if (added.has(each.document)) continue;
    added.add(each.document);
    const name = each.id.replace(/-(?:right|wrong)$/, "");
    const [file] = await addAndProcess(core, [
      await writeSourceFile(sources, `${name}.md`, `# ${name}\n\n${each.document}\n`),
    ]);
    if (!file) throw new Error(`${name}'s Document didn't process.`);
    await core.moveToFolder({ documentIds: [file.id], folderId: folder.id });
  }
  const { client, mindId } = await noteOf(core, "Everyday", cases, null, folder.id);
  const started = performance.now();
  const run = await core.checkMind({ requestId: `${ARM}-${ROUND}-note`, mindId, mode: "all" });
  await client.settled();
  const seconds = (performance.now() - started) / 1000;
  const spans = claimSpans(readMind(client));
  const states = Object.fromEntries(
    cases.map((each) => [
      each.id,
      spans.find((span) => span.sentence.text.trim() === each.sentence)?.check?.state ?? "no-mark",
    ]),
  );
  const { spent } = await core.getCostSummary();
  core.close();
  return {
    rows: [
      {
        arm: ARM,
        round: ROUND,
        group: "note",
        language,
        run: run.kind,
        sentences: cases.length,
        seconds,
        states,
      },
    ],
    spent,
  };
}

describe("the #3088 gate", () => {
  test.skipIf(!DRY && !REPLAY && KEY === undefined)(
    "one round of every case, each Note checked once",
    { timeout: 3_600_000 },
    async () => {
      // A stop with no room under it would hold every request, and the round would end as if the
      // stop had been reached with nothing sent.
      if (!DRY && !REPLAY && SPENT_BEFORE >= STOP - IN_FLIGHT)
        throw new Error(
          `The stop of US$${STOP} leaves no room for a request: US$${SPENT_BEFORE} was spent before this round and US$${IN_FLIGHT} is kept for requests in flight, so it needs to be more than US$${(SPENT_BEFORE + IN_FLIGHT).toFixed(2)}.`,
        );
      const spent: unknown[] = [];
      // The round's own line is written however it ends, so what it spent is always counted.
      try {
        for (const language of ["en", "zh-CN"] as const) {
          if (GROUPS.includes("example"))
            for (const own of [false, true]) {
              const round = await exampleRound(language, own);
              write(round.rows);
              spent.push(round.spent);
            }
          if (GROUPS.includes("held-out")) {
            const round = await heldOutRound(language);
            write(round.rows);
            spent.push(round.spent);
          }
          if (GROUPS.includes("everyday")) {
            const round = await heldOutRound(language, EVERYDAY, "everyday");
            write(round.rows);
            spent.push(round.spent);
          }
          if (GROUPS.includes("duty")) {
            const round = await heldOutRound(language, DUTY, "duty");
            write(round.rows);
            spent.push(round.spent);
          }
          if (GROUPS.includes("field")) {
            const round = await heldOutRound(language, FIELD, "field");
            write(round.rows);
            spent.push(round.spent);
          }
          if (GROUPS.includes("remark")) {
            const round = await remarkRound(language);
            write(round.rows);
            spent.push(round.spent);
          }
          if (GROUPS.includes("note")) {
            const round = await wholeNoteRound(language);
            write(round.rows);
            spent.push(round.spent);
          }
          if (GROUPS.includes("claim")) {
            const round = await claimRound(language);
            write(round.rows);
            spent.push(round.spent);
          }
        }
      } finally {
        write([
          {
            arm: ARM,
            round: ROUND,
            group: "run",
            model: DRY ? "scripted" : MODEL,
            complete:
              spent.length ===
              (GROUPS.includes("example") ? 4 : 0) +
                (GROUPS.includes("held-out") ? 2 : 0) +
                (GROUPS.includes("everyday") ? 2 : 0) +
                (GROUPS.includes("duty") ? 2 : 0) +
                (GROUPS.includes("field") ? 2 : 0) +
                (GROUPS.includes("remark") ? 2 : 0) +
                (GROUPS.includes("note") ? 2 : 0) +
                (GROUPS.includes("claim") ? 2 : 0),
            requests: heard.requests,
            refused: heard.refused,
            failed: heard.failed,
            timedOut: heard.timedOut,
            inputTokens: heard.inputTokens,
            outputTokens: heard.outputTokens,
            reasoningTokens: heard.reasoningTokens,
            thought: heard.thought,
            cut: heard.cut,
            priced: heard.spent,
            held: heard.held,
            ...(REPLAY && { replayed }),
            spent,
          },
        ]);
      }
      expect(heard.requests).toBeGreaterThan(0);
    },
  );
});
