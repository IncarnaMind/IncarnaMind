/**
 * The sets `npm run eval:repeats` checks again and again (README.md): an
 * employment agreement in English and a 劳动合同 in Chinese, invented for the
 * evaluation, and the sentences a User writes about them in a Mind of their
 * own, each with the verdict the agreement gives it.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPdf, type PdfPage } from "../../tests/helpers/pdf";
import type { EvalDocument } from "../lib/evaluationSet";

/**
 * What the Documents make of a sentence: "contradicted-or-unsupported" for a wrong figure,
 * which either verdict flags; "partly" for a general word for the agreement's own term, which
 * is judged on the term with the wider group not covered (DESIGN.md › Checks); "contradicted"
 * for a genuine conflict, which a judgement must never lose; "absent" for a figure for a period
 * the agreement doesn't cover, which is another claim, so its card says nothing was found.
 */
export type Expected =
  | "supported"
  | "partly"
  | "contradicted-or-unsupported"
  | "contradicted"
  | "unsupported"
  | "absent";

export interface RepeatSentence {
  /** The same for the same kind of sentence in each language, so the two read side by side. */
  key: string;
  kind:
    | "paraphrase"
    | "general-word"
    | "word-for-word"
    | "wrong-figure"
    | "absent"
    | "near-miss"
    | "conflict";
  expected: Expected;
  text: string;
  /** The issue of a miss the check makes today: the report counts it apart, never as one lost. */
  knownMiss?: number;
}

export interface RepeatSet {
  id: string;
  language: "en" | "zh-CN";
  /** The Mind's name: each set is a Mind of its own. */
  mind: string;
  /** Its sentences, one paragraph each, as a User types them. */
  sentences: readonly RepeatSentence[];
}

export interface RepeatDocument {
  language: "en" | "zh-CN";
  file: string;
  pages: readonly PdfPage[];
  /** The sets whose Library alone holds it, so the others' Library stays as it was; absent: every set's. */
  onlyFor?: readonly string[];
}

export const DOCUMENTS: readonly RepeatDocument[] = [
  {
    language: "en",
    file: "Employment Agreement - T. Okoro.pdf",
    pages: [
      {
        lines: [
          "EMPLOYMENT AGREEMENT",
          "This Employment Agreement is made between Larkfield Provisions Ltd (the Company) and Tunde Okoro (the Employee).",
          "1. Role and start date",
          "The Employee is employed as People Operations Partner and starts on 11 January 2027.",
          "The Employee reports to the Director of People.",
          "2. Pay",
          "The salary is 61,500 per year, paid monthly in arrears on the last working day of the month.",
          "3. Hours and place of work",
          "Normal hours are 9:00 to 17:30, Monday to Friday, with a one-hour unpaid lunch break.",
          "The Employee may work from home two days a week, agreed in advance with the manager.",
          "The Company may ask the Employee to attend the office on a working-from-home day with 24 hours' notice.",
          "4. Holiday",
          "From 1 January 2025 the Employee is entitled to 27 working days of paid holiday per year, in addition to public holidays.",
          "Up to 5 unused days may be carried over into the next year and must be taken by 31 March.",
        ],
      },
      {
        lines: [
          "5. Probation",
          "The first three months are a probation period. During probation either side may end this agreement",
          "by giving one week's written notice.",
          "6. Notice",
          "After probation, either side must give three months' written notice to end this agreement.",
          "The Company may pay salary in lieu of notice instead of requiring the Employee to work the notice period.",
          "7. Pension",
          "The Company will enrol the Employee in its workplace pension scheme and contribute 6 percent of salary.",
          "The Employee contributes 4 percent of salary through payroll.",
          "8. Confidentiality",
          "The Employee must keep the Company's confidential information secret during and after employment.",
          "9. Governing law",
          "This agreement is governed by the laws of England and Wales.",
          "Signed for the Company: ____________________  Date: ____________",
          "Signed by the Employee: ____________________  Date: ____________",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "劳动合同 - 林晓.pdf",
    pages: [
      {
        chineseLines: [
          "劳动合同书",
          "甲方（用人单位）：明川食品有限公司",
          "乙方（劳动者）：林晓",
          "第一条　工作岗位：乙方担任人力资源业务伙伴，自2027年1月11日起入职，向人力资源总监汇报。",
          "第二条　劳动报酬：乙方月工资为人民币一万八千元，于每月最后一个工作日发放。",
          "第三条　工作时间和地点：工作时间为周一至周五9:00至17:30，午休一小时。",
          "乙方每周可在家工作两天，须事先与主管商定。",
          "甲方可提前24小时通知乙方在居家工作日到岗。",
          "第四条　带薪年休假：自2025年1月1日起，乙方每年享有带薪年休假10天，法定节假日另计。",
        ],
      },
      {
        chineseLines: [
          "第五条　试用期：试用期为三个月。试用期内任何一方提前三日书面通知对方，可以解除本合同。",
          "第六条　解除合同：试用期满后，任何一方须提前三个月书面通知对方，方可解除本合同。",
          "第七条　社会保险：甲方依法为乙方缴纳社会保险和住房公积金。",
          "第八条　保密：乙方在职期间及离职后均须对甲方的商业秘密保密。",
          "第九条　适用法律：本合同适用中华人民共和国法律。",
          "甲方（盖章）：　　　　　　　　乙方（签字）：",
          "签订日期：　　　　年　　月　　日",
        ],
      },
    ],
  },
  {
    language: "en",
    file: "Staff flat and laptop - T. Okoro.pdf",
    onlyFor: ["en-conflicts"],
    pages: [
      {
        lines: [
          "STAFF FLAT AND LAPTOP AGREEMENT",
          "Between Larkfield Provisions Ltd (the Company) and Tunde Okoro (the Employee).",
          "1. Staff flat",
          "The Company lets the flat at 14 Mill Lane to the Employee: the Company is the landlord and the Employee the tenant.",
          "The Employee pays the Company a rent of 950 per month.",
          "2. Laptop",
          "At the end of employment the Company may sell the Employee's work laptop to the Employee for 450.",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "员工宿舍及设备协议 - 林晓.pdf",
    onlyFor: ["zh-conflicts"],
    pages: [
      {
        chineseLines: [
          "员工宿舍及设备协议",
          "甲方：明川食品有限公司　乙方：林晓",
          "第一条　员工宿舍：甲方将明川路14号2室出租给乙方，甲方为出租方，乙方为承租方。",
          "乙方每月向甲方支付租金人民币一千五百元。",
          "第二条　设备：劳动合同终止时，甲方可按人民币三千元将乙方使用的笔记本电脑出售给乙方。",
        ],
      },
    ],
  },
  {
    language: "en",
    file: "Annual report 2025 - Harrow Kitchens.pdf",
    onlyFor: ["en-periods"],
    pages: [
      {
        lines: [
          "HARROW KITCHENS LTD - ANNUAL REPORT 2025",
          "For the year ended 31 December 2025, with the figures for 2024 for comparison.",
          "Key figures                          2025        2024",
          "Revenue (thousand pounds)            4,200       3,600",
          "Employees at the year end            48          41",
          "Revenue in the fourth quarter of 2025 was 1,300 thousand pounds, the strongest quarter of the year.",
          "The board proposes a dividend of 12 pence a share for 2025.",
        ],
      },
    ],
  },
  {
    language: "en",
    file: "Supply agreement 2025-2027 - Harrow Kitchens.pdf",
    onlyFor: ["en-periods"],
    pages: [
      {
        lines: [
          "SUPPLY AGREEMENT",
          "Between Harrow Kitchens Ltd (the Buyer) and Fenwick Timber Ltd (the Supplier).",
          "This agreement runs from 1 January 2025 to 31 December 2027.",
          "The Supplier delivers 120 cubic metres of oak a year to the Buyer, at a fixed price of 610 pounds a cubic metre.",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "2025年年度报告 - 青禾餐饮.pdf",
    onlyFor: ["zh-periods"],
    pages: [
      {
        chineseLines: [
          "青禾餐饮有限公司2025年年度报告",
          "报告期为2025年1月1日至12月31日，并列示2024年数据以供比较。",
          "主要数据　　　　　　　　2025年　　　2024年",
          "营业收入（万元）　　　　4,200　　　　3,600",
          "年末员工人数　　　　　　48　　　　　41",
          "2025年第四季度营业收入为1,300万元，为全年最高。",
          "董事会建议2025年度每股派发现金红利0.12元。",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "供货合同（2025—2027）- 青禾餐饮.pdf",
    onlyFor: ["zh-periods"],
    pages: [
      {
        chineseLines: [
          "供货合同",
          "甲方（买方）：青禾餐饮有限公司　乙方（供方）：远山粮油有限公司",
          "本合同期限自2025年1月1日起至2027年12月31日止。",
          "乙方每年向甲方供应大米120吨，单价为每吨人民币5,200元。",
        ],
      },
    ],
  },
];

/**
 * The newcomer walk's three sentences (#1608) and three more: the agreement's
 * own words, a sentence it doesn't state, and a near miss that names days it
 * doesn't. The controls tell a general word for the agreement's term ("Staff"
 * for "the Employee") from a plain paraphrase. The conflicts are genuine
 * contradictions of the agreement, of a kind each, so a change to a verdict or
 * a judgement is measured against the conflicts it loses (#1647). The near
 * misses give a figure or a detail of another person or role than the
 * agreement's, or add one to its own, each expected not Contradicted, and a
 * holiday figure for the year before the agreement starts, expected "I didn't
 * find this". The paraphrases say a clause's duty or permission in other
 * words, each expected Supported. The periods sets hold a year's report with
 * the year before for comparison and a three-year supply agreement: a
 * prior-year figure, a quarter and a year of the term are the Documents' own
 * periods, a year the report doesn't state isn't.
 */
const sentencesOf =
  (kind: RepeatSentence["kind"], expected: Expected) =>
  (list: readonly (readonly [string, string, number?])[]): RepeatSentence[] =>
    list.map(([key, text, knownMiss]) => ({
      key,
      kind,
      expected,
      text,
      ...(knownMiss !== undefined && { knownMiss }),
    }));

const conflicts = sentencesOf("conflict", "contradicted");
const nearMisses = sentencesOf("near-miss", "unsupported");
const notCovered = sentencesOf("near-miss", "absent");
const paraphrases = sentencesOf("paraphrase", "supported");

export const SETS: readonly RepeatSet[] = [
  {
    id: "en",
    language: "en",
    mind: "Summary for the manager",
    sentences: [
      {
        key: "notice",
        kind: "paraphrase",
        expected: "supported",
        text: "Notice is three months after the probation period.",
      },
      {
        key: "holiday",
        kind: "wrong-figure",
        expected: "contradicted-or-unsupported",
        text: "Holiday is 30 days a year plus public holidays.",
      },
      {
        key: "staff-home",
        kind: "general-word",
        expected: "partly",
        text: "Staff may work from home two days a week.",
      },
      {
        key: "own-words",
        kind: "word-for-word",
        expected: "supported",
        text: "The Employee may work from home two days a week.",
      },
      {
        key: "car",
        kind: "absent",
        expected: "unsupported",
        text: "The Employee gets a car allowance of 300 pounds a month.",
      },
      {
        key: "home-days",
        kind: "near-miss",
        expected: "unsupported",
        text: "The Employee may work from home on Mondays and Fridays.",
      },
    ],
  },
  {
    id: "zh",
    language: "zh-CN",
    mind: "给经理的摘要",
    sentences: [
      {
        key: "notice",
        kind: "paraphrase",
        expected: "supported",
        text: "试用期满后，解除合同需提前三个月通知。",
      },
      {
        key: "holiday",
        kind: "wrong-figure",
        expected: "contradicted-or-unsupported",
        text: "员工每年有15天带薪年休假。",
      },
      {
        key: "staff-home",
        kind: "general-word",
        expected: "partly",
        text: "员工每周可以居家办公两天。",
      },
      {
        key: "own-words",
        kind: "word-for-word",
        expected: "supported",
        text: "乙方每周可在家工作两天。",
      },
      { key: "car", kind: "absent", expected: "unsupported", text: "公司每月发放300元交通补贴。" },
      {
        key: "home-days",
        kind: "near-miss",
        expected: "unsupported",
        text: "员工可以在每周一和周五居家办公。",
      },
    ],
  },
  {
    id: "en-control",
    language: "en",
    mind: "Home working",
    sentences: [
      {
        key: "same-subject",
        kind: "paraphrase",
        expected: "supported",
        text: "The Employee can work from home for two days each week.",
      },
      {
        key: "named",
        kind: "paraphrase",
        expected: "supported",
        text: "Tunde Okoro may work from home two days a week.",
      },
      {
        key: "staff-home",
        kind: "general-word",
        expected: "partly",
        text: "Staff may work from home two days a week.",
      },
      {
        key: "employees-home",
        kind: "general-word",
        expected: "partly",
        text: "Employees may work from home two days a week.",
      },
    ],
  },
  {
    id: "zh-control",
    language: "zh-CN",
    mind: "居家办公",
    sentences: [
      {
        key: "same-subject",
        kind: "paraphrase",
        expected: "supported",
        text: "乙方每周有两天可以在家办公。",
      },
      { key: "named", kind: "paraphrase", expected: "supported", text: "林晓每周可在家工作两天。" },
      {
        key: "staff-home",
        kind: "general-word",
        expected: "partly",
        text: "员工每周可以居家办公两天。",
      },
      {
        key: "employees-home",
        kind: "general-word",
        expected: "partly",
        text: "职工每周可在家工作两天。",
      },
    ],
  },
  {
    id: "en-conflicts",
    language: "en",
    mind: "Agreement points",
    sentences: conflicts([
      ["number", "The salary is 65,000 per year, paid monthly in arrears."],
      ["date", "Unused holiday days carried over must be taken by 30 April."],
      ["year", "The Employee starts on 11 January 2028."],
      ["start-month", "The Employee starts on 11 February 2027."],
      ["probation-length", "The first six months are a probation period."],
      [
        "notice-length",
        "After probation, either side must give one month's written notice to end this agreement.",
      ],
      ["negation", "Unused holiday days can't be carried over into the next year."],
      ["unit", "The salary is 61,500 per month."],
      ["reporting-line", "The Director of People reports to the Employee."],
      ["payer", "The Company pays the Employee a rent of 950 per month for the flat."],
      [
        "employer",
        "Tunde Okoro is the employer and Larkfield Provisions Ltd the employee under this agreement.",
      ],
      [
        "seller",
        "At the end of employment the Employee may sell the work laptop to the Company for 450.",
      ],
      [
        "landlord",
        "The Employee is the landlord of the flat at 14 Mill Lane and the Company the tenant.",
      ],
      [
        "name",
        "This Employment Agreement is made between Larkfield Provisions Ltd and Tunde Adeyemi.",
      ],
      [
        "condition",
        "The Company may ask the Employee to attend the office on a working-from-home day with seven days' notice.",
      ],
      [
        "duty",
        "The Company must pay salary in lieu of notice instead of requiring the Employee to work the notice period.",
      ],
      ["duty-short", "The Company must pay salary in lieu of notice."],
      ["duty-home", "The Employee must work from home two days a week."],
      ["duty-carry", "Up to 5 unused holiday days must be carried over into the next year."],
      [
        "permission",
        "The Employee may keep the Company's confidential information secret during and after employment.",
      ],
      [
        "party-in-lieu",
        "The Employee may pay salary in lieu of notice instead of working the notice period.",
      ],
      [
        "party-secret",
        "The Company must keep the Employee's confidential information secret during and after employment.",
      ],
      [
        "scope",
        "The Employee must keep the Company's confidential information secret only during employment.",
      ],
      ["place", "This agreement is governed by the laws of Scotland."],
      [
        "share",
        "The Company contributes 4 percent of salary to the pension and the Employee 6 percent.",
      ],
      ["entitlement-off", "The Employee gets no paid holiday beyond public holidays."],
      ["unlimited", "The Employee may take unlimited paid holiday."],
      ["period", "In 2026 the Employee was entitled to 25 days of paid holiday."],
      ["duty-shall", "The Employee shall work from home two days a week."],
      ["duty-should", "Up to 5 unused days should be carried over into the next year."],
      [
        "permission-can",
        "The Employee can keep the Company's confidential information secret during and after employment.",
      ],
      [
        "party-entitled",
        "The Employee is entitled to salary in lieu of notice instead of working the notice period.",
      ],
    ]),
  },
  {
    id: "zh-conflicts",
    language: "zh-CN",
    mind: "合同要点",
    sentences: conflicts([
      ["number", "乙方月工资为人民币两万元。"],
      ["date", "乙方自2027年2月11日起入职。"],
      ["year", "乙方自2028年1月11日起入职。"],
      ["probation-length", "试用期为六个月。"],
      ["notice-length", "试用期满后，任何一方须提前一个月书面通知对方，方可解除本合同。"],
      ["negation", "试用期内任何一方都不得解除本合同。", 1682],
      ["unit", "乙方年工资为人民币一万八千元。"],
      ["reporting-line", "人力资源总监向乙方汇报。"],
      ["payer", "甲方每月向乙方支付租金人民币一千五百元。"],
      ["employer", "林晓是用人单位，明川食品有限公司是劳动者。"],
      ["seller", "劳动合同终止时，乙方可按人民币三千元将笔记本电脑出售给甲方。"],
      ["landlord", "乙方将明川路14号2室出租给甲方。"],
      ["name", "本合同的劳动者是王晓。"],
      ["condition", "甲方须提前七天通知乙方在居家工作日到岗。"],
      ["scope", "乙方仅在职期间须对甲方的商业秘密保密。"],
      ["place", "本合同适用新加坡法律。"],
      ["share", "乙方依法为甲方缴纳社会保险和住房公积金。"],
      ["share-2", "社会保险和住房公积金由乙方为甲方缴纳。"],
      ["duty-home", "乙方每周须在家工作两天。"],
      ["duty-home-2", "乙方每周必须居家办公两天。"],
      ["permission", "乙方在职期间及离职后均可对甲方的商业秘密保密。"],
      ["party-secret", "甲方须对乙方的商业秘密保密。"],
      ["party-office", "乙方可提前24小时通知甲方在居家工作日到岗。"],
      ["entitlement-off", "乙方不享有带薪年休假。"],
      ["unlimited", "乙方的带薪年休假不限天数。"],
      ["period", "2026年乙方享有带薪年休假15天。"],
      ["duty-xu", "乙方每周需在家工作两天。"],
      ["duty-ying", "甲方应提前24小时通知乙方在居家工作日到岗。"],
      ["duty-yingdang", "试用期内任何一方应当提前三日书面通知对方解除本合同。"],
      ["permission-keyi", "乙方离职后可以对甲方的商业秘密保密。"],
      ["prohibition-bude", "乙方不得在家工作。"],
    ]),
  },
  {
    id: "en-paraphrases",
    language: "en",
    mind: "Duties and permissions",
    sentences: paraphrases([
      [
        "shall",
        "The Employee shall keep the Company's confidential information secret during and after employment.",
      ],
      ["can", "Up to 5 unused days can be carried over into the next year."],
      [
        "entitled-company",
        "The Company is entitled to pay salary in lieu of notice instead of requiring the Employee to work the notice period.",
      ],
      [
        "entitled-holiday",
        "The Employee is entitled to 27 working days of paid holiday a year, on top of public holidays.",
      ],
    ]),
  },
  {
    id: "zh-paraphrases",
    language: "zh-CN",
    mind: "义务与许可",
    sentences: paraphrases([
      ["xu", "乙方每周可在家工作两天，需事先与主管商定。"],
      ["ying", "乙方在职期间及离职后均应对甲方的商业秘密保密。"],
      ["yingdang", "试用期满后，任何一方应当提前三个月书面通知对方，方可解除本合同。"],
      ["bixu", "乙方在职期间及离职后都必须对甲方的商业秘密保密。"],
      ["keyi", "甲方可以提前24小时通知乙方在居家工作日到岗。"],
      ["bude", "乙方在职期间及离职后均不得泄露甲方的商业秘密。"],
    ]),
  },
  {
    id: "en-near-misses",
    language: "en",
    mind: "Other people and details",
    sentences: [
      ...nearMisses([
        ["staff-days", "Staff may work from home on Mondays and Fridays."],
        [
          "staff-condition",
          "Staff may carry over up to 5 unused days into the next year if their manager agrees.",
          1718,
        ],
        ["role-home", "Managers may work from home three days a week.", 1718],
        ["role-holiday", "Managers are entitled to 30 days of paid holiday per year."],
        [
          "person-holiday",
          "The Director of People is entitled to 30 days of paid holiday per year.",
        ],
        ["person-home", "The Director of People may work from home three days a week.", 1718],
      ]),
      ...notCovered([
        [
          "period-not-covered",
          "In 2024 the Employee was entitled to 25 days of paid holiday.",
          1765,
        ],
      ]),
    ],
  },
  {
    id: "zh-near-misses",
    language: "zh-CN",
    mind: "他人与细节",
    sentences: [
      ...nearMisses([
        ["staff-days", "员工每周可在家工作两天，具体为周一和周五。", 1718],
        ["staff-detail", "员工的工资于每月最后一个工作日通过银行转账发放。"],
        ["role-home", "经理每周可在家工作三天。", 1718],
        ["role-holiday", "经理每年享有带薪年休假15天。", 1718],
        ["person-holiday", "人力资源总监每年享有带薪年休假15天。"],
        ["person-home", "人力资源总监每周可在家工作三天。", 1718],
        ["added-detail", "乙方月工资为人民币一万八千元，通过银行转账发放。"],
      ]),
      ...notCovered([["period-not-covered", "2024年乙方享有带薪年休假15天。", 1765]]),
    ],
  },
  {
    id: "en-periods",
    language: "en",
    mind: "Report and supply terms",
    sentences: [
      ...paraphrases([
        ["prior-year", "Harrow Kitchens' revenue in 2024 was 3,600 thousand pounds."],
        [
          "quarter",
          "Harrow Kitchens' revenue in the fourth quarter of 2025 was 1,300 thousand pounds.",
        ],
        [
          "term-year",
          "In 2026 Fenwick Timber delivers 120 cubic metres of oak to Harrow Kitchens.",
        ],
      ]),
      ...conflicts([
        ["prior-year-wrong", "Harrow Kitchens had 45 employees at the end of 2024."],
        [
          "term-year-wrong",
          "In 2026 the oak price under the supply agreement is 650 pounds a cubic metre.",
        ],
      ]),
      ...notCovered([
        ["year-not-stated", "Harrow Kitchens' revenue in 2023 was 3,100 thousand pounds.", 1765],
      ]),
    ],
  },
  {
    id: "zh-periods",
    language: "zh-CN",
    mind: "年报与供货条款",
    sentences: [
      ...paraphrases([
        ["prior-year", "青禾餐饮2024年营业收入为3,600万元。"],
        ["quarter", "青禾餐饮2025年第四季度营业收入为1,300万元。"],
        ["term-year", "2026年远山粮油向青禾餐饮供应大米120吨。"],
      ]),
      ...conflicts([
        ["prior-year-wrong", "青禾餐饮2024年末员工人数为45人。"],
        ["term-year-wrong", "2026年大米单价为每吨人民币5,600元。", 1708],
      ]),
      ...notCovered([["year-not-stated", "青禾餐饮2023年营业收入为3,100万元。", 1765]]),
    ],
  },
];

/** The Documents a set's Library holds. */
export const documentsOf = (set: RepeatSet): RepeatDocument[] =>
  DOCUMENTS.filter(
    (each) => each.language === set.language && (!each.onlyFor || each.onlyFor.includes(set.id)),
  );

/** Writes a set's Documents into `folder`, as the files a User adds. */
export async function writeDocuments(folder: string, set: RepeatSet): Promise<EvalDocument[]> {
  const written: EvalDocument[] = [];
  for (const document of documentsOf(set)) {
    const path = join(folder, document.file);
    await writeFile(path, buildPdf(document.pages));
    written.push({ key: document.file, path });
  }
  return written;
}
