/**
 * The sentences `npm run eval:support` checks against the quotes they cite (#2311), and the
 * Documents they cite. Frozen before the first run: a fix fitted to the two fixtures shows up as
 * a held-out sentence it still calls supported. The held-out sentences whose ids end in "b" were
 * added after it, once it showed the others never met the date the Library reads from a
 * Document's first page; they were frozen before either arm ran on them.
 *
 * - fixture: the walk's two sentences, each in English and Chinese.
 * - held-out: the same mistakes in other words, over the same Documents and two more: a dryer's
 *   quote "delivered and commissioned", and a contract summary whose file says it was created in
 *   May 2026 while its text gives no date.
 * - control: sentences their quotes do support, which must keep their green check.
 */
import { corePropertiesXml, docxOf } from "../../tests/helpers/office";
import { para, pptxOf, sp, txBody } from "../../tests/helpers/pptx";

export interface SupportCase {
  id: string;
  set: "fixture" | "held-out" | "control";
  /** The mistake it makes, or for a control the one it is next to. */
  kind: "installed" | "dated";
  language: "en" | "zh-CN";
  sentence: string;
  /** The Document it cites, and its quote there. */
  document: string;
  quote: string;
  /** Whether the quote supports the sentence: only then may it keep its green check. */
  supported: boolean;
}

const slide = (...lines: string[]) => ({
  shapes: sp({
    id: 2,
    name: "Body",
    txBox: true,
    body: txBody(lines.map((line) => para(line)).join("")),
  }),
});

export const DOCUMENTS: readonly { name: string; contents: Buffer }[] = [
  {
    name: "Kiln upgrade plan.pptx",
    contents: pptxOf({
      slides: [
        slide("Kiln upgrade plan", "Northwind Ceramics Ltd", "Board pack, October 2026"),
        slide(
          "Why upgrade now",
          "Our two kilns are 14 years old.",
          "They use 31% more energy than the Hartwell K9.",
          "Unplanned downtime was 9 days in 2026 so far.",
        ),
        slide(
          "The plan",
          "Supplier: Hartwell Kilns",
          "Cost: £185,000 for two K9 kilns, installed",
          "Installation in February 2027",
          "Payback in about 3.5 years from energy savings",
        ),
      ],
    }),
  },
  {
    name: "供应商合同.docx",
    contents: docxOf([
      { text: "供应商合同摘要", heading: 1 },
      { text: "供应商：景德镇青山陶土有限公司。" },
      { text: "采购方：Northwind Ceramics Ltd。" },
      { text: "合同总金额为人民币 860,000 元，分四期支付。" },
      { text: "交货安排：自 2026 年 11 月起，每季度交货一次，每次 12 吨高岭土。" },
      { text: "付款条件：收货后 30 天内付款。" },
      { text: "合同有效期至 2027 年 12 月 31 日。" },
    ]),
  },
  {
    name: "Dryer replacement.docx",
    contents: docxOf([
      { text: "Dryer replacement", heading: 1 },
      { text: "Quote: £42,000 for one Hartwell D3 dryer, delivered and commissioned." },
      { text: "Commissioning is booked for March 2027, after the old dryer is removed." },
    ]),
  },
  {
    name: "Warehouse lease notes.docx",
    contents: docxOf([
      { text: "Warehouse lease notes", heading: 1 },
      { text: "The previous lease ended in 2024." },
      { text: "Rent is £2,100 a month, paid quarterly." },
    ]),
  },
  {
    name: "Clay supply agreement.docx",
    contents: docxOf(
      [
        { text: "Summary of the clay supply agreement", heading: 1 },
        { text: "Supplier: Qingshan Clay Co. Ltd." },
        { text: "Deliveries start in January 2027, 12 tonnes each quarter." },
        { text: "Payment is due 30 days after each delivery." },
      ],
      { coreXml: corePropertiesXml({ created: "2026-05-12T09:00:00Z" }) },
    ),
  },
];

const KILN = "Kiln upgrade plan";
const COST = "Cost: £185,000 for two K9 kilns, installed";
const INSTALLATION = "Installation in February 2027";
const BOARD_PACK = "Board pack, October 2026";
const CONTRACT = "供应商合同";
const TITLE = "供应商合同摘要";
const DRYER = "Dryer replacement";
const DRYER_QUOTE = "Quote: £42,000 for one Hartwell D3 dryer, delivered and commissioned.";
const SUPPLY = "Clay supply agreement";
const SUPPLY_TITLE = "Summary of the clay supply agreement";
const LEASE = "Warehouse lease notes";

const installed = (
  id: string,
  set: SupportCase["set"],
  language: SupportCase["language"],
  sentence: string,
  supported = false,
  document = KILN,
  quote = COST,
): SupportCase => ({ id, set, kind: "installed", language, sentence, document, quote, supported });

const dated = (
  id: string,
  set: SupportCase["set"],
  language: SupportCase["language"],
  sentence: string,
  supported = false,
  document = CONTRACT,
  quote = TITLE,
): SupportCase => ({ id, set, kind: "dated", language, sentence, document, quote, supported });

export const CASES: readonly SupportCase[] = [
  installed(
    "installed-zh-fixture",
    "fixture",
    "zh-CN",
    "窑炉升级计划的费用是 £185,000，包括两台 K9 窑炉并已安装好。",
  ),
  installed(
    "installed-en-fixture",
    "fixture",
    "en",
    "The kiln upgrade plan costs £185,000, covering two K9 kilns that are already installed.",
  ),
  dated(
    "dated-en-fixture",
    "fixture",
    "en",
    "The document is a supplier contract summary, “供应商合同摘要”, dated 2026.",
  ),
  dated("dated-zh-fixture", "fixture", "zh-CN", "这份文件是供应商合同摘要，日期为 2026 年。"),

  installed("installed-zh-1", "held-out", "zh-CN", "两台 K9 窑炉已经安装完毕，总价为 £185,000。"),
  installed(
    "installed-zh-2",
    "held-out",
    "zh-CN",
    "窑炉升级的费用为 £185,000，即两台 K9 窑炉的安装费用。",
  ),
  installed(
    "installed-zh-3",
    "held-out",
    "zh-CN",
    "Hartwell 已为我们安装了两台 K9 窑炉，花费 £185,000。",
  ),
  installed(
    "installed-en-1",
    "held-out",
    "en",
    "Both K9 kilns have been installed, at a cost of £185,000.",
  ),
  installed("installed-en-2", "held-out", "en", "The two K9 kilns were installed for £185,000."),
  installed(
    "installed-en-3",
    "held-out",
    "en",
    "Northwind now runs two installed K9 kilns, bought for £185,000.",
  ),
  installed(
    "installed-en-4",
    "held-out",
    "en",
    "The Hartwell D3 dryer has already been commissioned, for £42,000.",
    false,
    DRYER,
    DRYER_QUOTE,
  ),
  installed(
    "installed-zh-4",
    "held-out",
    "zh-CN",
    "Hartwell D3 干燥机已经调试完毕，费用为 £42,000。",
    false,
    DRYER,
    DRYER_QUOTE,
  ),
  dated("dated-en-1", "held-out", "en", "The supplier contract summary was signed in 2026."),
  dated("dated-en-2", "held-out", "en", "供应商合同摘要 is dated October 2026."),
  dated("dated-zh-1", "held-out", "zh-CN", "《供应商合同摘要》签订于 2026 年。"),
  dated("dated-zh-2", "held-out", "zh-CN", "该供应商合同摘要的日期为 2026 年 10 月。"),
  dated(
    "dated-en-3",
    "held-out",
    "en",
    "The clay supply agreement summary is dated May 2026.",
    false,
    SUPPLY,
    SUPPLY_TITLE,
  ),
  dated(
    "dated-zh-3",
    "held-out",
    "zh-CN",
    "这份陶土供货协议摘要的日期是 2026 年 5 月。",
    false,
    SUPPLY,
    SUPPLY_TITLE,
  ),
  dated("dated-en-4b", "held-out", "en", "The supplier contract summary is a 2026 document."),
  dated("dated-zh-4b", "held-out", "zh-CN", "供应商合同摘要是 2026 年的文件。"),
  dated("dated-en-5b", "held-out", "en", "This summary of the supplier contract dates from 2026."),
  dated("dated-zh-5b", "held-out", "zh-CN", "该供应商合同摘要写于 2026 年。"),
  dated(
    "dated-en-6b",
    "held-out",
    "en",
    "The clay supply agreement summary was written in 2026.",
    false,
    SUPPLY,
    SUPPLY_TITLE,
  ),
  dated(
    "dated-zh-6b",
    "held-out",
    "zh-CN",
    "这份陶土供货协议摘要写于 2026 年。",
    false,
    SUPPLY,
    SUPPLY_TITLE,
  ),
  dated(
    "dated-en-7b",
    "held-out",
    "en",
    "The warehouse lease notes are dated 2024.",
    false,
    LEASE,
    LEASE,
  ),
  dated("dated-zh-7b", "held-out", "zh-CN", "仓库租约笔记的日期是 2024 年。", false, LEASE, LEASE),

  installed(
    "control-installed-en-1",
    "control",
    "en",
    "The upgrade costs £185,000 for two K9 kilns, installed.",
    true,
  ),
  installed(
    "control-installed-zh-1",
    "control",
    "zh-CN",
    "升级费用为 £185,000，含两台 K9 窑炉及其安装。",
    true,
  ),
  installed(
    "control-installed-en-2",
    "control",
    "en",
    "Installation is planned for February 2027.",
    true,
    KILN,
    INSTALLATION,
  ),
  installed(
    "control-installed-zh-2",
    "control",
    "zh-CN",
    "窑炉计划在 2027 年 2 月安装。",
    true,
    KILN,
    INSTALLATION,
  ),
  installed(
    "control-installed-en-3",
    "control",
    "en",
    "The £42,000 quote covers one Hartwell D3 dryer, delivered and commissioned.",
    true,
    DRYER,
    DRYER_QUOTE,
  ),
  installed(
    "control-installed-zh-3",
    "control",
    "zh-CN",
    "£42,000 的报价包括一台 Hartwell D3 干燥机的交付和调试。",
    true,
    DRYER,
    DRYER_QUOTE,
  ),
  dated(
    "control-dated-en-1",
    "control",
    "en",
    "The kiln upgrade plan is the board pack of October 2026.",
    true,
    KILN,
    BOARD_PACK,
  ),
  dated(
    "control-dated-zh-1",
    "control",
    "zh-CN",
    "窑炉升级计划是 2026 年 10 月的董事会材料。",
    true,
    KILN,
    BOARD_PACK,
  ),
  dated(
    "control-dated-en-2",
    "control",
    "en",
    "The document is a summary of a supplier contract.",
    true,
  ),
  dated("control-dated-zh-2", "control", "zh-CN", "这份文件是一份供应商合同摘要。", true),
  dated(
    "control-dated-en-3",
    "control",
    "en",
    "The contract runs until 31 December 2027.",
    true,
    CONTRACT,
    "合同有效期至 2027 年 12 月 31 日",
  ),
  dated(
    "control-dated-zh-3",
    "control",
    "zh-CN",
    "根据供货协议，交货从 2027 年 1 月开始，每季度 12 吨。",
    true,
    SUPPLY,
    "Deliveries start in January 2027, 12 tonnes each quarter.",
  ),
];
