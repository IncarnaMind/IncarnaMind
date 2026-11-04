/**
 * Sentences that say something is absent from a named Document (#1443), with the Documents they
 * name, made up for this evaluation in English and Chinese. A true absence names something its
 * Document never mentions; a false one names a clause or disclosure the Document has, on a page a
 * search of the sentence's words may or may not hand the model. None is the check prompt's own
 * example, so they measure the check rather than its memory of an example.
 */
import type { PdfPage } from "../../tests/helpers/pdf";

export type AbsenceLanguage = "en" | "zh-CN";

export interface AbsenceSentence {
  key: string;
  text: string;
  /** The Document it names, by file. */
  document: string;
  /**
   * "holds": the Document never mentions it; "there": the Document has it; "fact": no absence at
   * all; "elsewhere": the Document never mentions it, but `other`, checked with it, does.
   */
  kind: "holds" | "there" | "fact" | "elsewhere";
  /** For "elsewhere": the other Document of the scope, by file, which has the thing. */
  other?: string;
  /** For "there" and "fact": words of the clause that states it, as the Document writes them. */
  clause?: string;
}

export interface AbsenceDocument {
  file: string;
  language: AbsenceLanguage;
  pages: readonly PdfPage[];
}

const en = (pages: readonly (readonly string[])[]): PdfPage[] => pages.map((lines) => ({ lines }));
const zh = (pages: readonly (readonly string[])[]): PdfPage[] =>
  pages.map((lines) => ({ chineseLines: lines }));

export const ABSENCE_DOCUMENTS: readonly AbsenceDocument[] = [
  {
    file: "Willow Street lease.pdf",
    language: "en",
    pages: en([
      [
        "TENANCY AGREEMENT - 14 Willow Street, Bristol BS3 4LT",
        "Landlord: Harriet Moss. Tenant: Daniel Okafor.",
        "1. Term. The tenancy starts on 1 March 2026 and runs for three years, to 28 February 2029.",
        "2. Rent. The Tenant pays rent of GBP 1,450 a month, in advance, on the first day of each month.",
        "3. Deposit. The Tenant pays a deposit of GBP 2,175, held in a government-approved scheme.",
      ],
      [
        "4. Use. The Tenant uses the property as a private home for the Tenant and the Tenant's family only.",
        "5. Pets. The Tenant may keep one cat or one small dog with the Landlord's written consent,",
        "which the Landlord will not unreasonably refuse.",
        "6. Repairs. The Landlord keeps the structure, roof, boiler and pipes in repair. The Tenant keeps",
        "the interior clean and reports any damage within seven days.",
      ],
      [
        "7. Utilities. The Tenant pays council tax, water, gas, electricity and broadband.",
        "8. Insurance. The Landlord insures the building. The Tenant insures the Tenant's own belongings.",
        "9. Access. The Landlord may enter to inspect or repair after giving 24 hours' written notice.",
      ],
      [
        "10. Ending the tenancy early. After the first 12 months either party may end this agreement by",
        "giving the other at least two months' written notice.",
        "11. Notices. Notices are given in writing to the addresses above or by e-mail.",
        "12. Law. This agreement is governed by the law of England and Wales.",
        "Signed by the Landlord and the Tenant on 20 February 2026.",
      ],
    ]),
  },
  {
    file: "Brightline supply agreement.pdf",
    language: "en",
    pages: en([
      [
        "SUPPLY AGREEMENT between Brightline Components Ltd (Supplier) and Arden Robotics plc (Buyer)",
        "1. Products. The Supplier sells the Buyer servo motors of the types listed in Schedule 1.",
        "2. Price. Prices are as set out in Schedule 1 and are fixed until 31 December 2026.",
        "3. Orders. The Buyer places orders in writing at least 30 days before the delivery date.",
      ],
      [
        "4. Delivery. The Supplier delivers to the Buyer's Coventry plant, DAP Incoterms 2020.",
        "5. Payment. The Buyer pays each invoice within 45 days of the end of the month of delivery.",
        "6. Warranty. The Supplier warrants that the Products are free from defects for 12 months from",
        "delivery, and will repair or replace any defective Product free of charge.",
      ],
      [
        "7. Liability. Each party's total liability under this agreement is limited to the price paid",
        "in the 12 months before the claim.",
        "8. Force majeure. Neither party is liable for delay caused by events beyond its reasonable",
        "control, such as fire, flood, war or strikes, if it notifies the other party promptly.",
      ],
      [
        "9. Term. This agreement runs for two years from 1 January 2026 and then renews for one year",
        "at a time unless either party gives six months' notice.",
        "10. Law. This agreement is governed by the law of England and Wales.",
        "Schedule 1 - Products and prices: SM-40 servo motor GBP 212; SM-60 servo motor GBP 286.",
      ],
    ]),
  },
  {
    file: "Corvid Labs 2026 annual report.pdf",
    language: "en",
    pages: en([
      [
        "CORVID LABS PLC - ANNUAL REPORT 2026",
        "Chair's statement",
        "Revenue grew 18% to GBP 64.2 million and operating profit rose to GBP 9.8 million.",
        "The Board proposes a final dividend of 4.5 pence per share for 2026, payable on 12 June 2027.",
      ],
      [
        "Strategic report",
        "We opened a second laboratory in Leeds and grew our headcount from 310 to 362.",
        "Research and development spending was GBP 11.6 million, 18% of revenue.",
        "Principal risks: dependence on two large customers, and the cost of skilled staff.",
      ],
      [
        "Note 21 - Related party transactions",
        "On 3 April 2026 the Company lent GBP 250,000 to its Chief Executive, Dr Imogen Hart, to help buy",
        "a home near the Leeds laboratory. The loan bears interest at 4% a year and is repayable by",
        "3 April 2029. GBP 250,000 was outstanding at 31 December 2026.",
      ],
      [
        "Note 22 - Events after the reporting period",
        "On 15 January 2027 the Company signed a three-year contract with Halden Pharma worth GBP 7 million.",
        "Note 23 - Share capital",
        "At 31 December 2026 the Company had 48,200,000 ordinary shares of 1 penny each in issue.",
      ],
    ]),
  },
  {
    file: "柳巷住房租赁合同.pdf",
    language: "zh-CN",
    pages: zh([
      [
        "住房租赁合同",
        "出租方（甲方）：莫海燕　承租方（乙方）：欧家明",
        "房屋地址：杭州市西湖区柳巷 14 号 2 单元 301 室",
        "第一条 租赁期限自 2026 年 3 月 1 日起至 2029 年 2 月 28 日止，共三年。",
        "第二条 月租金为人民币 6,800 元，乙方应于每月 1 日前支付当月租金。",
        "第三条 乙方应支付押金人民币 13,600 元，租赁期满无损坏的，甲方全额退还。",
      ],
      [
        "第四条 房屋仅供乙方及其家庭成员居住使用。",
        "第五条 经甲方书面同意，乙方可饲养一只猫或一只小型犬，甲方不得无理拒绝。",
        "第六条 甲方负责房屋主体结构、屋顶、热水器及管道的维修；乙方负责保持室内清洁，",
        "发现损坏应在七日内告知甲方。",
      ],
      [
        "第七条 水费、电费、燃气费、物业费及宽带费由乙方承担。",
        "第八条 甲方为房屋投保财产险；乙方自行为其个人物品投保。",
        "第九条 甲方因检查或维修需要进入房屋的，应提前二十四小时书面通知乙方。",
      ],
      [
        "第十条 提前解除合同：租赁满十二个月后，任何一方均可提前两个月书面通知对方解除本合同。",
        "第十一条 通知以书面形式送达上述地址或以电子邮件发送。",
        "第十二条 本合同适用中华人民共和国法律。",
        "甲乙双方于 2026 年 2 月 20 日签订本合同。",
      ],
    ]),
  },
  {
    file: "明线元件供货合同.pdf",
    language: "zh-CN",
    pages: zh([
      [
        "供货合同",
        "供方：明线元件有限公司　需方：雅登机器人股份有限公司",
        "第一条 供方向需方供应附件一所列型号的伺服电机。",
        "第二条 价格按附件一执行，2026 年 12 月 31 日前不作调整。",
        "第三条 需方应在交货日前至少 30 日以书面形式下达订单。",
      ],
      [
        "第四条 供方将货物送至需方苏州工厂。",
        "第五条 需方应在交货当月结束后 45 日内支付货款。",
        "第六条 质量保证：供方保证产品自交货之日起 12 个月内无质量缺陷，",
        "对有缺陷的产品免费维修或更换。",
      ],
      [
        "第七条 责任限制：任何一方在本合同项下的赔偿责任总额以索赔前 12 个月内已支付的货款为限。",
        "第八条 不可抗力：因火灾、洪水、战争、罢工等不能合理控制的事件造成延误的，",
        "及时通知对方的一方不承担责任。",
      ],
      [
        "第九条 本合同自 2026 年 1 月 1 日起有效期两年，期满后每次自动续期一年，",
        "任何一方提前六个月通知不再续期的除外。",
        "第十条 本合同适用中华人民共和国法律。",
        "附件一：SM-40 伺服电机每台 1,890 元；SM-60 伺服电机每台 2,560 元。",
      ],
    ]),
  },
  {
    file: "鸦岭科技 2026年年度报告.pdf",
    language: "zh-CN",
    pages: zh([
      [
        "鸦岭科技股份有限公司 2026 年年度报告",
        "董事长致辞",
        "营业收入增长 18% 至 6.42 亿元，营业利润增至 9,800 万元。",
        "董事会建议派发 2026 年度末期股息每股 0.45 元，于 2027 年 6 月 12 日派付。",
      ],
      [
        "经营情况讨论与分析",
        "公司在合肥开设第二个实验室，员工人数由 310 人增至 362 人。",
        "研发投入 1.16 亿元，占营业收入的 18%。",
        "主要风险：依赖两家大客户，以及专业人才成本上升。",
      ],
      [
        "附注二十一 关联方交易",
        "2026 年 4 月 3 日，公司向总经理何静怡博士提供借款 250 万元，用于其在合肥实验室附近购房。",
        "该借款年利率 4%，应于 2029 年 4 月 3 日前归还。截至 2026 年 12 月 31 日，借款余额为 250 万元。",
      ],
      [
        "附注二十二 资产负债表日后事项",
        "2027 年 1 月 15 日，公司与霍顿制药签订为期三年、金额 7,000 万元的服务合同。",
        "附注二十三 股本",
        "截至 2026 年 12 月 31 日，公司已发行普通股 4,820 万股，每股面值 1 元。",
      ],
    ]),
  },
];

const LEASE = "Willow Street lease.pdf";
const SUPPLY = "Brightline supply agreement.pdf";
const REPORT = "Corvid Labs 2026 annual report.pdf";
const LEASE_ZH = "柳巷住房租赁合同.pdf";
const SUPPLY_ZH = "明线元件供货合同.pdf";
const REPORT_ZH = "鸦岭科技 2026年年度报告.pdf";

export const ABSENCE_SENTENCES: Record<AbsenceLanguage, readonly AbsenceSentence[]> = {
  en: [
    {
      key: "rent-review",
      kind: "holds",
      document: LEASE,
      text: "The Willow Street lease contains no rent review clause.",
    },
    {
      key: "guarantor",
      kind: "holds",
      document: LEASE,
      text: "The Willow Street lease does not require a guarantor.",
    },
    {
      key: "exclusivity",
      kind: "holds",
      document: SUPPLY,
      text: "The Brightline supply agreement has no exclusivity provision.",
    },
    {
      key: "late-interest",
      kind: "holds",
      document: SUPPLY,
      text: "Nothing in the Brightline agreement charges interest on late payment.",
    },
    {
      key: "impairment",
      kind: "holds",
      document: REPORT,
      text: "Corvid Labs' 2026 annual report does not mention any goodwill impairment.",
    },
    {
      key: "buyback",
      kind: "holds",
      document: REPORT,
      text: "Corvid Labs did not disclose a share buyback in its 2026 annual report.",
    },
    {
      key: "early-end",
      kind: "there",
      document: LEASE,
      clause: "either party may end this agreement",
      text: "The Willow Street lease gives neither side a way to end it early.",
    },
    {
      key: "pets",
      kind: "there",
      document: LEASE,
      clause: "may keep one cat or one small dog",
      text: "The Willow Street lease says nothing about pets.",
    },
    {
      key: "force-majeure",
      kind: "there",
      document: SUPPLY,
      clause: "Neither party is liable for delay caused by events beyond",
      text: "The Brightline supply agreement lacks a force majeure clause.",
    },
    {
      key: "warranty",
      kind: "there",
      document: SUPPLY,
      clause: "free from defects for 12 months",
      text: "Brightline gives no warranty on the servo motors it supplies.",
    },
    {
      key: "ceo-loan",
      kind: "there",
      document: REPORT,
      clause: "lent GBP 250,000 to its Chief Executive",
      text: "Corvid Labs never disclosed its loan to the chief executive.",
    },
    {
      key: "dividend",
      kind: "there",
      document: REPORT,
      clause: "final dividend of 4.5 pence per share",
      text: "The Corvid Labs annual report proposes no dividend for 2026.",
    },
    {
      key: "rent-fact",
      kind: "fact",
      document: LEASE,
      clause: "rent of GBP 1,450 a month",
      text: "Under the Willow Street lease the rent is GBP 1,450 a month.",
    },
    {
      key: "warranty-fact",
      kind: "fact",
      document: SUPPLY,
      clause: "free from defects for 12 months",
      text: "Brightline warrants the motors for 12 months from delivery.",
    },
    {
      key: "pets-elsewhere",
      kind: "elsewhere",
      document: SUPPLY,
      other: LEASE,
      text: "The Brightline supply agreement says nothing about pets.",
    },
    {
      key: "warranty-elsewhere",
      kind: "elsewhere",
      document: REPORT,
      other: SUPPLY,
      text: "Corvid Labs' 2026 annual report gives no warranty on any product.",
    },
    {
      key: "force-majeure-elsewhere",
      kind: "elsewhere",
      document: LEASE,
      other: SUPPLY,
      text: "The Willow Street lease has no force majeure clause.",
    },
  ],
  "zh-CN": [
    {
      key: "rent-review",
      kind: "holds",
      document: LEASE_ZH,
      text: "柳巷住房租赁合同里没有租金调整的约定。",
    },
    {
      key: "guarantor",
      kind: "holds",
      document: LEASE_ZH,
      text: "柳巷租赁合同并未要求承租方提供担保人。",
    },
    {
      key: "exclusivity",
      kind: "holds",
      document: SUPPLY_ZH,
      text: "明线元件供货合同中没有独家供货条款。",
    },
    {
      key: "late-interest",
      kind: "holds",
      document: SUPPLY_ZH,
      text: "明线供货合同没有对逾期付款计收利息。",
    },
    {
      key: "impairment",
      kind: "holds",
      document: REPORT_ZH,
      text: "鸦岭科技 2026 年年度报告未提及任何商誉减值。",
    },
    {
      key: "buyback",
      kind: "holds",
      document: REPORT_ZH,
      text: "鸦岭科技在 2026 年年报中没有披露股份回购。",
    },
    {
      key: "early-end",
      kind: "there",
      document: LEASE_ZH,
      clause: "任何一方均可提前两个月书面通知对方解除本合同",
      text: "柳巷租赁合同没有给任何一方提前解约的权利。",
    },
    {
      key: "pets",
      kind: "there",
      document: LEASE_ZH,
      clause: "乙方可饲养一只猫或一只小型犬",
      text: "柳巷住房租赁合同对养宠物只字未提。",
    },
    {
      key: "force-majeure",
      kind: "there",
      document: SUPPLY_ZH,
      clause: "不可抗力",
      text: "明线元件供货合同缺少不可抗力条款。",
    },
    {
      key: "warranty",
      kind: "there",
      document: SUPPLY_ZH,
      clause: "自交货之日起 12 个月内无质量缺陷",
      text: "明线元件对所供伺服电机不提供任何质保。",
    },
    {
      key: "ceo-loan",
      kind: "there",
      document: REPORT_ZH,
      clause: "公司向总经理何静怡博士提供借款 250 万元",
      text: "鸦岭科技从未披露向总经理提供的借款。",
    },
    {
      key: "dividend",
      kind: "there",
      document: REPORT_ZH,
      clause: "末期股息每股 0.45 元",
      text: "鸦岭科技年报没有提出 2026 年度的股息。",
    },
    {
      key: "rent-fact",
      kind: "fact",
      document: LEASE_ZH,
      clause: "月租金为人民币 6,800 元",
      text: "柳巷租赁合同约定的月租金为 6,800 元。",
    },
    {
      key: "warranty-fact",
      kind: "fact",
      document: SUPPLY_ZH,
      clause: "自交货之日起 12 个月内无质量缺陷",
      text: "明线元件对伺服电机提供自交货起 12 个月的质保。",
    },
    {
      key: "pets-elsewhere",
      kind: "elsewhere",
      document: SUPPLY_ZH,
      other: LEASE_ZH,
      text: "明线元件供货合同对养宠物只字未提。",
    },
    {
      key: "warranty-elsewhere",
      kind: "elsewhere",
      document: REPORT_ZH,
      other: SUPPLY_ZH,
      text: "鸦岭科技 2026 年年报没有提到任何产品质保。",
    },
    {
      key: "force-majeure-elsewhere",
      kind: "elsewhere",
      document: LEASE_ZH,
      other: SUPPLY_ZH,
      text: "柳巷住房租赁合同没有不可抗力条款。",
    },
  ],
};
