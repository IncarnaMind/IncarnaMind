/**
 * The finance and law Skills (#1938), one case for each Skill in each
 * language: its invented Documents (./documents), the Question the User asks
 * for a note, and the facts the note must state. The facts are groups of
 * alternatives; a note passes a group when its text matches any one of them.
 */

export type SkillCaseLanguage = "en" | "zh-CN";

export interface SkillCase {
  id: string;
  /** The built-in Skill the Question forces. */
  skill: string;
  language: SkillCaseLanguage;
  /** Files under ./documents/<language>/, added as the case's Documents. */
  documents: readonly string[];
  /** The Question, asking for a note, in the case's language. */
  request: string;
  /** A title for the Mind the note goes into. */
  title: string;
  /** The facts the note must state, each group any one of its patterns. */
  facts: readonly (readonly RegExp[])[];
  /** The least Citations the note must hold. */
  citationsAtLeast: number;
}

const FINANCE = [
  "facility-agreement.md",
  "compliance-certificate-q3-2026.md",
  "q3-2026-results.md",
] as const;

export const CASES: readonly SkillCase[] = [
  {
    id: "covenant-summary-en",
    skill: "covenant-summary",
    language: "en",
    documents: FINANCE,
    request:
      "Write a note summarising the financial covenants in the Halden Quay facility agreement, and whether they were met at the latest test.",
    title: "Covenants",
    facts: [
      [/3\.25\s*:\s*1/],
      [/3\.5\s*:\s*1/],
      [/2\.80?\s*:\s*1|2\.8\s*(?:times|x)/i],
      [/4\.61?\s*:\s*1|4\.6\s*(?:times|x)/i],
      [/met|satisfied|within the (?:level|covenant)/i],
    ],
    citationsAtLeast: 4,
  },
  {
    id: "covenant-summary-zh",
    skill: "covenant-summary",
    language: "zh-CN",
    documents: FINANCE,
    request: "写一篇笔记，总结海川冷链融资协议中的财务约定，以及最近一次测试是否满足。",
    title: "财务约定",
    facts: [
      [/3\.25\s*:\s*1/],
      [/3\.5\s*:\s*1/],
      [/2\.80?\s*:\s*1|2\.8\s*倍/],
      [/4\.61?\s*:\s*1|4\.6\s*倍/],
      [/满足|符合|未超过|不低于/],
    ],
    citationsAtLeast: 4,
  },
  {
    id: "cim-red-flags-en",
    skill: "cim-red-flags",
    language: "en",
    documents: [
      "cim.md",
      "data-room-financials-and-customers.md",
      "data-room-legal-property-fleet.md",
    ],
    request:
      "Write a note of the red flags in the Halden Quay CIM: the claims the data room doesn't support or contradicts.",
    title: "CIM red flags",
    facts: [
      [/24\s*%/],
      [/8\s*%/],
      [/22\s*%/],
      [/Pellow|2\.4\s*million/i],
      [/lease|rented|not owned/i],
      [/fleet|trailers/i],
      [/120\s*million/i],
      [/19(?:\.0)?\s*%/],
    ],
    citationsAtLeast: 6,
  },
  {
    id: "cim-red-flags-zh",
    skill: "cim-red-flags",
    language: "zh-CN",
    documents: [
      "cim.md",
      "data-room-financials-and-customers.md",
      "data-room-legal-property-fleet.md",
    ],
    request: "写一篇笔记，列出海川冷链保密信息备忘录中的红旗：数据室不支持或与之矛盾的说法。",
    title: "备忘录红旗",
    facts: [
      [/24\s*%/],
      [/8\s*%/],
      [/22\s*%/],
      [/培罗|240\s*万元/],
      [/租赁/],
      [/车队|挂车/],
      [/1\.2\s*亿/],
      [/19(?:\.0)?\s*%/],
    ],
    citationsAtLeast: 6,
  },
  {
    id: "earnings-review-en",
    skill: "earnings-review",
    language: "en",
    documents: ["q3-2026-results.md", "q2-2026-results.md"],
    request:
      "Write a note reviewing Halden Quay's third quarter of 2026 against the prior period and the guidance.",
    title: "Q3 review",
    facts: [
      [/142\.6/],
      [/8\.1\s*%/],
      [/19\.8/],
      [/18\.1/],
      [/131\.9|third quarter of 2025|second quarter|138\.4/],
      [/27\.4\s*%/],
      [/29\.1\s*%/],
      [/74/],
      [/78/],
      [/57\.2/],
    ],
    citationsAtLeast: 6,
  },
  {
    id: "earnings-review-zh",
    skill: "earnings-review",
    language: "zh-CN",
    documents: ["q3-2026-results.md", "q2-2026-results.md"],
    request: "写一篇笔记，回顾海川冷链 2026 年第三季度的业绩，与前一期和业绩指引对比。",
    title: "第三季度回顾",
    facts: [
      [/14,?260/],
      [/8\.1\s*%/],
      [/1,?980/],
      [/1,?810/],
      [/13,?840|第二季度/],
      [/27\.4\s*%/],
      [/29\.1\s*%/],
      [/7,?400/],
      [/7,?800/],
      [/5,?720/],
    ],
    citationsAtLeast: 6,
  },
  {
    id: "credit-memo-outline-en",
    skill: "credit-memo-outline",
    language: "en",
    documents: [...FINANCE, "cim.md"],
    request:
      "Draft the credit committee paper outline for the Halden Quay financing, filled from the Documents.",
    title: "Credit memo",
    facts: [
      [/Halden Quay/],
      [/Merrowgate/],
      [/180\s*million|180,000,000/],
      [/60\s*million|60,000,000/],
      [/3\.25\s*:\s*1|2\.80?\s*:\s*1|Leverage/i],
      [/Executive summary|Summary/i],
      [/Risks?/i],
      [/Recommendation/i],
      [/Bracken|19(?:\.0)?\s*%|customer/i],
    ],
    citationsAtLeast: 5,
  },
  {
    id: "credit-memo-outline-zh",
    skill: "credit-memo-outline",
    language: "zh-CN",
    documents: [...FINANCE, "cim.md"],
    request: "起草海川冷链这笔融资的信贷委员会报告提纲，内容取自文档。",
    title: "授信报告",
    facts: [
      [/海川冷链/],
      [/澜石银行/],
      [/1\.8\s*亿/],
      [/6,?000\s*万/],
      [/3\.25\s*:\s*1|2\.80?\s*:\s*1|杠杆率/],
      [/摘要|执行摘要/],
      [/风险/],
      [/建议|结论/],
      [/青禾食品|19(?:\.0)?\s*%|客户/],
    ],
    citationsAtLeast: 5,
  },
  {
    id: "deposition-summary-en",
    skill: "deposition-summary",
    language: "en",
    documents: ["deposition-whitlock.md"],
    request:
      "Write a note summarising Dana Whitlock's deposition by topic, with each point cited to page and line.",
    title: "Deposition summary",
    facts: [
      [/p\.\s*1[3-7]/],
      [/ll?\.\s*\d+/],
      [/28 July 2023/],
      [/12 June 2023/],
      [/310,000/],
      [/180,000/],
      [/not fit for purpose/i],
      [/wrongful|terminat/i],
      [/7 November 2023/],
    ],
    citationsAtLeast: 6,
  },
  {
    id: "deposition-summary-zh",
    skill: "deposition-summary",
    language: "zh-CN",
    documents: ["deposition-lin-jiahe.md"],
    request: "写一篇笔记，按主题总结林嘉禾的证词，每个要点注明页码和行号。",
    title: "证词摘要",
    facts: [
      [/第\s*12\s*页/],
      [/第\s*\d+\s*(?:[–-]\s*\d+\s*)?行/],
      [/2023\s*年\s*7\s*月\s*28\s*日/],
      [/(?:2023\s*年\s*)?6\s*月\s*12\s*日/],
      [/31\s*万元/],
      [/18\s*万元/],
      [/不符合要求/],
      [/违约|终止/],
      [/(?:2023\s*年\s*)?11\s*月\s*7\s*日/],
    ],
    citationsAtLeast: 6,
  },
  {
    id: "chronology-en",
    skill: "chronology",
    language: "en",
    documents: ["record-contract-correspondence-filings.md"],
    request:
      "Write a chronology of the record in Ravensworth Analytics v Kestrel Health Systems, with every event cited.",
    title: "Chronology",
    facts: [
      [/3 March 2023/],
      [/12 June 2023/],
      [/28 July 2023/],
      [/29 July 2023/],
      [/19 September 2023/],
      [/6 November 2023/],
      [/7 November 2023/],
      [/22 January 2024/],
      [/differ|disagree|different|conflict|contradict/i],
    ],
    citationsAtLeast: 7,
  },
  {
    id: "chronology-zh",
    skill: "chronology",
    language: "zh-CN",
    documents: ["record-contract-correspondence-filings.md"],
    request: "写一篇时间线，按时间顺序列出远岚科技与青禾健康争议记录中的事件，每条附引用。",
    title: "事件时间线",
    facts: [
      [/2023\s*年\s*3\s*月\s*3\s*日/],
      [/2023\s*年\s*6\s*月\s*12\s*日/],
      [/2023\s*年\s*7\s*月\s*28\s*日/],
      [/2023\s*年\s*7\s*月\s*29\s*日/],
      [/2023\s*年\s*9\s*月\s*19\s*日/],
      [/2023\s*年\s*11\s*月\s*6\s*日/],
      [/2023\s*年\s*11\s*月\s*7\s*日/],
      [/2024\s*年\s*1\s*月\s*22\s*日/],
      [/不同|不一致|矛盾/],
    ],
    citationsAtLeast: 7,
  },
];

/** The Skills the table covers, each in both languages. */
export const SKILLS = [...new Set(CASES.map((each) => each.skill))];
