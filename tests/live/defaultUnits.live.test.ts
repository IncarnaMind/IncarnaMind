/**
 * A Document's default unit, stated as the Document gives it, reads Supported (#2889), on a real
 * model. Two sets, each in English and Chinese:
 *
 * - "note": a Note of key figures that opens with its unit line ("Figures are in GBP million, as
 *   the Westmoor documents give them.") over Documents that give that unit "unless otherwise
 *   stated", "except where noted", 除另有说明外 or 如无特别说明, with figures in it and one planted
 *   error. Checked INCARNAMIND_LIVE_RUNS times: the unit line reads Supported, every figure as
 *   the Document gives it Supported, and the planted error Contradicted.
 * - "decoys": pairs of a Document and one sentence where Supported would be wrong: a default
 *   applied to a figure the Document states otherwise, a right stated without its condition beside
 *   an "unless otherwise stated", and a scale changed under the default. Each pair has its own
 *   Folder and Note, so a decoy's Document never backs another. None of them may read Supported.
 *
 * The cases were written and committed before any run of the fix, and none of them is a prompt's
 * example or a case of #2864's. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY.
 *
 * - INCARNAMIND_LIVE_ANTHROPIC_MODEL: the model (Claude Sonnet 5.5 when unset).
 * - INCARNAMIND_LIVE_SET: "note", "decoys" or both ("note,decoys" when unset).
 * - INCARNAMIND_LIVE_RUNS: how many times the Note is checked (10 when unset).
 * - INCARNAMIND_LIVE_LANGUAGES: "en", "zh" or both ("en,zh" when unset).
 * - INCARNAMIND_LIVE_REPORT: a file to keep each run's counts.
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes, Core } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const SETS = (process.env.INCARNAMIND_LIVE_SET ?? "note,decoys").split(",");
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "10");
const LANGUAGES = (process.env.INCARNAMIND_LIVE_LANGUAGES ?? "en,zh").split(",");
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;

type Language = "en" | "zh";

interface SourceFile {
  name: string;
  lines: readonly string[];
}

type Expect =
  | { kind: "unit-line" }
  | { kind: "figure"; figure: string }
  | { kind: "error"; figure: string };

interface NoteSet {
  documents: readonly SourceFile[];
  title: string;
  sentences: readonly { text: string; expect: Expect }[];
}

const NOTES: Record<Language, NoteSet> = {
  en: {
    documents: [
      {
        name: "Westmoor Water interim report 2026.pdf",
        lines: [
          "Westmoor Water plc interim report 2026",
          "All figures in GBP million unless otherwise stated",
          "Regulated revenue for the half year was 412.7.",
          "Operating profit for the half year was 138.2.",
          "Net debt at 30 September 2026 was 4,206.5.",
        ],
      },
      {
        name: "Westmoor Water annual report 2026 extract.pdf",
        lines: [
          "Westmoor Water plc annual report 2026 (extract)",
          "Amounts are in GBP million except where noted.",
          "Regulated revenue for the year was 801.9.",
          "Capital investment for the year was 655.3.",
        ],
      },
      {
        name: "Westmoor Water bond terms.pdf",
        lines: [
          "Westmoor Water Finance plc: summary of bond terms",
          "Guarantor: Westmoor Water plc",
          "Coupon: 5.125% a year, paid every six months.",
        ],
      },
    ],
    title: "Westmoor Water key figures",
    sentences: [
      {
        text: "Figures are in GBP million, as the Westmoor documents give them.",
        expect: { kind: "unit-line" },
      },
      {
        text: "Regulated revenue for the half year: 412.7",
        expect: { kind: "figure", figure: "412.7" },
      },
      {
        text: "Operating profit for the half year: 138.2",
        expect: { kind: "figure", figure: "138.2" },
      },
      {
        text: "Capital investment for the year: 655.3",
        expect: { kind: "figure", figure: "655.3" },
      },
      {
        text: "Net debt at 30 September 2026 was £4,260.5m.",
        expect: { kind: "error", figure: "£4,260.5m" },
      },
    ],
  },
  zh: {
    documents: [
      {
        name: "嘉陵水务2026年半年度报告.pdf",
        lines: [
          "嘉陵水务股份有限公司2026年半年度报告",
          "除另有说明外，金额单位为人民币百万元",
          "2026年上半年营业收入为356.8。",
          "2026年上半年营业利润为97.4。",
          "2026年6月30日有息负债为2,915.6。",
        ],
      },
      {
        name: "嘉陵水务2025年年度报告摘要.pdf",
        lines: [
          "嘉陵水务股份有限公司2025年年度报告摘要",
          "如无特别说明，单位：人民币百万元",
          "2025年营业收入为689.2。",
          "2025年资本开支为488.1。",
        ],
      },
      {
        name: "嘉陵水务债券募集说明书摘要.pdf",
        lines: ["嘉陵水务公司债券募集说明书摘要", "票面利率：每年3.45%，每年付息一次。"],
      },
    ],
    title: "嘉陵水务主要数字",
    sentences: [
      { text: "数字单位为人民币百万元，与嘉陵水务的文件一致。", expect: { kind: "unit-line" } },
      { text: "2026年上半年营业收入：356.8", expect: { kind: "figure", figure: "356.8" } },
      { text: "2026年上半年营业利润：97.4", expect: { kind: "figure", figure: "97.4" } },
      { text: "2025年资本开支：488.1", expect: { kind: "figure", figure: "488.1" } },
      {
        text: "2026年6月30日有息负债为2,951.6百万元。",
        expect: { kind: "error", figure: "2,951.6百万元" },
      },
    ],
  },
};

/** A pair where Supported is wrong. */
interface Decoy {
  name: string;
  language: Language;
  kind: "default-elsewhere" | "right-beside-default" | "scale-changed";
  document: readonly string[];
  sentence: string;
}

const decoy =
  (language: Language, kind: Decoy["kind"]) =>
  (name: string, document: readonly string[], sentence: string): Decoy => ({
    name,
    language,
    kind,
    document,
    sentence,
  });

const enElsewhere = decoy("en", "default-elsewhere");
const enRight = decoy("en", "right-beside-default");
const enScale = decoy("en", "scale-changed");
const zhElsewhere = decoy("zh", "default-elsewhere");
const zhRight = decoy("zh", "right-beside-default");
const zhScale = decoy("zh", "scale-changed");

const DECOYS: readonly Decoy[] = [
  // A default applied to a figure the Document states in another unit.
  enElsewhere(
    "EN staff costs in thousands under a million default",
    [
      "Ashcombe Dairies results",
      "All figures in GBP million unless otherwise stated.",
      "Revenue was 233.4.",
      "Directors' fees (GBP thousand) were 845.",
    ],
    "Directors' fees are given in GBP million.",
  ),
  enElsewhere(
    "EN per-share figure in pence under a million default",
    [
      "Brigstock Retail interim figures",
      "GBP million except where noted.",
      "Operating profit was 61.2.",
      "Dividend per share (pence) was 4.6.",
    ],
    "The dividend per share is stated in GBP million.",
  ),
  enElsewhere(
    "EN headcount in units under a thousand default",
    [
      "Caldwell Rail operating review",
      "Amounts in EUR thousands unless otherwise stated.",
      "Track maintenance cost 9,120.",
      "Employees (number) 2,310.",
    ],
    "The number of employees is given in EUR thousands.",
  ),
  enElsewhere(
    "EN a row in US dollars under a sterling default",
    [
      "Dunmere Shipping figures",
      "All amounts are in GBP million unless otherwise stated.",
      "Charter income was 118.5.",
      "Bunker costs (US$ million) were 40.2.",
    ],
    "Bunker costs are given in GBP million, as the default says.",
  ),
  enElsewhere(
    "EN a table in billions under a million default",
    [
      "Eastleigh Bank summary",
      "Figures are in USD million unless otherwise stated.",
      "Net interest income 912.4",
      "Table 3: Total assets (USD billion) 48.6",
    ],
    "Total assets in Table 3 are given in USD million.",
  ),
  enElsewhere(
    "EN a ratio row under a money default",
    [
      "Fenwick Utilities covenants",
      "All figures in GBP million unless otherwise stated.",
      "EBITDA was 210.0.",
      "Gearing (per cent) was 61.5.",
    ],
    "Gearing is given in GBP million.",
  ),
  enElsewhere(
    "EN a quarter's figures in thousands under a million default",
    [
      "Grantley Hotels trading update",
      "Amounts are in GBP million except where noted.",
      "Room revenue for the year was 96.8.",
      "Room revenue for the fourth quarter (GBP thousand) was 24,100.",
    ],
    "Fourth-quarter room revenue is given in GBP million.",
  ),
  // A right stated without its condition, beside the default.
  enRight(
    "EN sublicence without consent beside a euro default",
    [
      "Software licence summary",
      "Amounts are in EUR unless otherwise stated.",
      "The Licensee may sublicense the software only with the Licensor's prior written consent.",
    ],
    "Amounts are in EUR, and the Licensee may sublicense the software.",
  ),
  enRight(
    "EN early repayment without notice beside a sterling default",
    [
      "Loan facility terms",
      "All amounts are in GBP unless otherwise stated.",
      "The Borrower may repay the loan early, provided it gives 30 days' written notice.",
    ],
    "Amounts are in GBP and the Borrower may repay the loan early.",
  ),
  enRight(
    "EN assignment without approval beside a dollar default",
    [
      "Supply agreement summary",
      "Figures in US dollars except where noted.",
      "The Supplier may assign this agreement subject to the Buyer's approval.",
    ],
    "Figures are in US dollars; the Supplier may assign this agreement.",
  ),
  enRight(
    "EN overtime claim without sign-off beside a thousand default",
    [
      "Staff handbook: pay",
      "Amounts are in GBP thousands unless otherwise stated.",
      "Staff may claim overtime only if their manager has signed it off in advance.",
    ],
    "Amounts are in GBP thousands, and staff may claim overtime.",
  ),
  enRight(
    "EN termination without cause beside a million default",
    [
      "Services contract summary",
      "All figures in EUR million unless otherwise stated.",
      "Either party may end the contract for convenience after the second anniversary only.",
    ],
    "Figures are in EUR million and either party may end the contract for convenience.",
  ),
  enRight(
    "EN rent review unless in arrears beside a default",
    [
      "Lease summary",
      "Rents are in GBP a year unless otherwise stated.",
      "The Tenant may ask for a rent review unless the rent is in arrears.",
    ],
    "Rents are in GBP a year and the Tenant may ask for a rent review.",
  ),
  enRight(
    "EN data export after an assessment beside a default",
    [
      "Data processing terms",
      "Fees are in CHF unless otherwise stated.",
      "The Processor may transfer data abroad only after a transfer assessment.",
    ],
    "Fees are in CHF, and the Processor may transfer data abroad.",
  ),
  // A scale changed under the default.
  enScale(
    "EN millions for thousands",
    [
      "Hartley Foods figures",
      "All amounts in GBP thousands unless otherwise stated.",
      "Sales 81,240",
    ],
    "Amounts are in GBP millions, as the Hartley figures give them.",
  ),
  enScale(
    "EN thousands for millions",
    ["Ilford Cables report", "Figures are in USD million except where noted.", "Revenue 512.6"],
    "Figures are in USD thousands, as the Ilford report states.",
  ),
  enScale(
    "EN billions for millions",
    ["Jessop Energy summary", "EUR million unless otherwise stated", "Capital spending 2,140.5"],
    "The Jessop summary gives its figures in EUR billions.",
  ),
  enScale(
    "EN units for thousands",
    ["Kirkham Clinics accounts", "All figures in GBP '000 unless otherwise stated.", "Fees 6,410"],
    "Figures are in pounds, as the Kirkham accounts give them.",
  ),
  enScale(
    "EN millions for billions",
    [
      "Lowther Bank results",
      "All amounts in USD billion unless otherwise stated.",
      "Deposits 41.9",
    ],
    "Amounts are in USD million, as the Lowther results state.",
  ),
  enScale(
    "EN another currency at the same scale",
    ["Morley Mining review", "US$ million unless otherwise stated", "Copper sales 640.3"],
    "Figures are in GBP million, as the Morley review gives them.",
  ),
  enScale(
    "EN thousands for millions, said as the default",
    [
      "Nettleton Freight update",
      "Unless otherwise stated, amounts are in GBP million.",
      "Freight income 77.1",
    ],
    "Unless otherwise stated, the Nettleton update gives amounts in GBP thousands.",
  ),
  // 默认单位用于另以其他单位列示的项目。
  zhElsewhere(
    "ZH 千元列示的项目套用百万元默认单位",
    [
      "安澜乳业年报摘要",
      "除另有说明外，金额单位为人民币百万元。",
      "营业收入为233.4。",
      "董事薪酬（人民币千元）为845。",
    ],
    "董事薪酬以人民币百万元列示。",
  ),
  zhElsewhere(
    "ZH 每股收益以元列示",
    [
      "碧溪零售中期报告",
      "如无特别说明，单位：人民币百万元",
      "营业利润为61.2。",
      "每股收益（元）为0.46。",
    ],
    "每股收益以人民币百万元列示。",
  ),
  zhElsewhere(
    "ZH 员工人数套用千元默认单位",
    [
      "长泰铁路经营回顾",
      "除非另有说明，金额单位为人民币千元。",
      "线路维护费用为9,120。",
      "员工人数（人）为2,310。",
    ],
    "员工人数以人民币千元列示。",
  ),
  zhElsewhere(
    "ZH 美元项目套用人民币默认单位",
    [
      "东屿航运经营数据",
      "除另有说明外，金额单位为人民币百万元。",
      "租船收入为118.5。",
      "燃油成本（百万美元）为40.2。",
    ],
    "燃油成本按默认单位以人民币百万元列示。",
  ),
  zhElsewhere(
    "ZH 亿元表格套用百万元默认单位",
    [
      "恩平银行摘要",
      "如无特别说明，金额单位为人民币百万元。",
      "利息净收入为912.4。",
      "表3 总资产（人民币亿元）为486.2",
    ],
    "表3中的总资产以人民币百万元列示。",
  ),
  zhElsewhere(
    "ZH 百分比项目套用金额默认单位",
    [
      "丰华公用事业契约指标",
      "除另有说明外，金额单位为人民币百万元。",
      "息税折旧摊销前利润为210.0。",
      "资产负债率（%）为61.5。",
    ],
    "资产负债率以人民币百万元列示。",
  ),
  zhElsewhere(
    "ZH 季度数据以万元列示",
    [
      "广林酒店经营简报",
      "除另有说明外，单位：人民币百万元",
      "全年客房收入为96.8。",
      "第四季度客房收入（人民币万元）为2,410。",
    ],
    "第四季度客房收入以人民币百万元列示。",
  ),
  // 默认单位旁边的权利，略去了其条件。
  zhRight(
    "ZH 转授权略去同意条件",
    [
      "软件许可协议摘要",
      "除另有说明外，金额以欧元计。",
      "被许可方经许可方事先书面同意后，方可转授权本软件。",
    ],
    "金额以欧元计，被许可方可以转授权本软件。",
  ),
  zhRight(
    "ZH 提前还款略去通知条件",
    [
      "贷款协议条款",
      "除另有说明外，金额单位为人民币元。",
      "借款人提前三十日书面通知的，可以提前还款。",
    ],
    "金额单位为人民币元，借款人可以提前还款。",
  ),
  zhRight(
    "ZH 转让合同略去批准条件",
    ["供货协议摘要", "如无特别说明，金额以美元计。", "经买方批准，供应商可以转让本协议。"],
    "金额以美元计；供应商可以转让本协议。",
  ),
  zhRight(
    "ZH 加班费略去审批条件",
    [
      "员工手册：薪酬",
      "除非另有说明，金额单位为人民币千元。",
      "员工只有在主管事先审批后，才可以申报加班费。",
    ],
    "金额单位为人民币千元，员工可以申报加班费。",
  ),
  zhRight(
    "ZH 任意解约略去期限条件",
    [
      "服务合同摘要",
      "除另有说明外，金额单位为欧元百万元。",
      "满两周年后，任何一方方可无因解除合同。",
    ],
    "金额单位为欧元百万元，任何一方可以无因解除合同。",
  ),
  zhRight(
    "ZH 租金复核略去欠租条件",
    [
      "租赁合同摘要",
      "除另有说明外，租金以人民币元/年计。",
      "除非租金处于拖欠状态，承租人可以申请租金复核。",
    ],
    "租金以人民币元/年计，承租人可以申请租金复核。",
  ),
  zhRight(
    "ZH 数据出境略去评估条件",
    [
      "数据处理条款",
      "如无特别说明，费用以瑞士法郎计。",
      "处理方只有在完成出境评估后，才可以将数据传输至境外。",
    ],
    "费用以瑞士法郎计，处理方可以将数据传输至境外。",
  ),
  // 默认单位下改换量级。
  zhScale(
    "ZH 万元改为亿元",
    ["海陵食品财务数据", "除另有说明外，金额单位为人民币万元。", "销售收入为8,124.0。"],
    "金额单位为人民币亿元，与海陵食品的数据一致。",
  ),
  zhScale(
    "ZH 百万元改为千元",
    ["伊川电缆年度报告", "如无特别说明，金额单位为人民币百万元。", "营业收入为512.6。"],
    "伊川电缆的报告以人民币千元列示金额。",
  ),
  zhScale(
    "ZH 百万元改为十亿元",
    ["金山能源摘要", "除另有说明外，单位：人民币百万元", "资本开支为2,140.5。"],
    "金山能源摘要中的数字以人民币十亿元计。",
  ),
  zhScale(
    "ZH 千元改为元",
    ["开平诊所账目", "除非另有说明，金额单位为人民币千元。", "诊疗收入为6,410。"],
    "金额单位为人民币元，与开平诊所账目一致。",
  ),
  zhScale(
    "ZH 亿元改为百万元",
    ["临川银行业绩", "除另有说明外，金额单位为人民币亿元。", "存款余额为41.9。"],
    "临川银行业绩中的金额以人民币百万元计。",
  ),
  zhScale(
    "ZH 同量级改换币种",
    ["茂林矿业回顾", "如无特别说明，金额单位为百万美元。", "铜销售收入为640.3。"],
    "茂林矿业回顾中的金额以人民币百万元计。",
  ),
  zhScale(
    "ZH 默认单位说成千元",
    ["宁河货运简报", "除另有说明外，金额单位为人民币百万元。", "货运收入为77.1。"],
    "除另有说明外，宁河货运简报的金额单位为人民币千元。",
  ),
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

function checkOf(client: MindClient, sentence: string): ClaimCheckAttributes | null {
  return (
    claimSpans(readMind(client)).find((span) => span.sentence.text.trim() === sentence.trim())
      ?.check ?? null
  );
}

async function report(entry: object) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  if (REPORT) await appendFile(REPORT, `${JSON.stringify(entry)}\n`);
}

describe.skipIf(!KEY)("a Document's default unit, stated as the Document gives it (#2889)", () => {
  for (const language of LANGUAGES as Language[]) {
    const set = NOTES[language];
    test.skipIf(!SETS.includes("note") || !set)(
      `the Note, ${RUNS} checks (${language})`,
      { timeout: 3_600_000 },
      async () => {
        const core = await newCore(language);
        const sources = await createTempDataFolder();
        await addAndProcess(
          core,
          await Promise.all(
            set.documents.map((file) => writeSourceFile(sources, file.name, pdfOf(file, language))),
          ),
        );
        const runs: { unitLine: string; figuresNotSupported: string[]; error: string }[] = [];
        for (let run = 1; run <= RUNS; run++) {
          const mind = await core.createMind({ title: set.title });
          const client = await connectToMind(core, mind.id);
          writeMind(client, [
            {
              type: "heading",
              attrs: { id: randomUUID(), level: 1 },
              content: [textNode(set.title)],
            },
            ...set.sentences.map(({ text }) => paragraph(text)),
          ]);
          await client.settled();
          await core.checkMind({
            requestId: `note-${language}-${run}`,
            mindId: mind.id,
            mode: "all",
          });
          await client.settled();
          const schedule = await core.getFigureSchedule(mind.id);
          const figureState = (figure: string) =>
            schedule.rows.find((row) => row.reading.chars === figure)?.shown.state ?? "missing";
          const unitLine = set.sentences.find(({ expect: wanted }) => wanted.kind === "unit-line");
          const unitCheck = unitLine ? checkOf(client, unitLine.text) : null;
          const entry = {
            set: "note",
            language,
            model: MODEL,
            run,
            unitLine: `${unitCheck?.state ?? "missing"}${unitCheck?.reason ? `/${unitCheck.reason}` : ""}`,
            figuresNotSupported: set.sentences.flatMap(({ expect: wanted }) =>
              wanted.kind === "figure" && figureState(wanted.figure) !== "supported"
                ? [`${wanted.figure}=${figureState(wanted.figure)}`]
                : [],
            ),
            error: set.sentences
              .flatMap(({ expect: wanted }) =>
                wanted.kind === "error" ? [figureState(wanted.figure)] : [],
              )
              .join(","),
          };
          runs.push(entry);
          await report(entry);
        }
        const { spent } = await core.getCostSummary();
        const supported = runs.filter((each) => each.unitLine === "supported").length;
        await report({ set: "note", language, model: MODEL, runs: runs.length, supported, spent });
        expect(supported).toBeGreaterThanOrEqual(Math.ceil(RUNS * 0.9));
        for (const each of runs) expect(each.error, JSON.stringify(each)).toBe("contradicted");
      },
    );
  }

  test.skipIf(!SETS.includes("decoys"))(
    "decoys: none reads Supported",
    { timeout: 3_600_000 },
    async () => {
      const results: { name: string; kind: string; state: string }[] = [];
      for (const language of LANGUAGES as Language[]) {
        const decoys = DECOYS.filter((each) => each.language === language);
        if (decoys.length === 0) continue;
        const core = await newCore(language);
        const sources = await createTempDataFolder();
        for (const [index, each] of decoys.entries()) {
          const [file] = await addAndProcess(core, [
            await writeSourceFile(
              sources,
              `decoy-${index + 1}.md`,
              `${each.document.join("\n\n")}\n`,
            ),
          ]);
          if (!file) throw new Error(`${each.name}: its Document didn't process.`);
          const folder = await core.createLibraryGroup({
            name: `decoy-${index + 1}`,
            description: "",
          });
          await core.moveToFolder({ documentIds: [file.id], folderId: folder.id });
          const mind = await core.createMind({ title: `decoy-${index + 1}`, folderId: folder.id });
          const client = await connectToMind(core, mind.id);
          writeMind(client, [paragraph(each.sentence)]);
          await client.settled();
          await core.checkMind({
            requestId: `decoy-${language}-${index}`,
            mindId: mind.id,
            mode: "all",
          });
          await client.settled();
          const entry = {
            name: each.name,
            kind: each.kind,
            state: checkOf(client, each.sentence)?.state ?? "missing",
          };
          results.push(entry);
          await report({ set: "decoys", language, model: MODEL, ...entry });
        }
        const { spent } = await core.getCostSummary();
        await report({ set: "decoys", language, model: MODEL, spent });
      }
      const falseSupported = results.filter((each) => each.state === "supported");
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
