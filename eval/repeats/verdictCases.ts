/**
 * Held-out sentences for the verdicts a check gets wrong on a sentence the Documents contradict,
 * or on a true one (#1708, #1765, #1766, #1908, #2184), on Documents of their own: a studio
 * licence in each language, and half-year results with a borrowing limit and a cost printed in
 * brackets. They were written before any change to the check, but for the eight conflicts named
 * "should", "guests", "notice-days" and "room" in each language, written just after the first
 * change to its instructions and before any run of it. None is a sentence of the other sets or an
 * example of the check's instructions.
 *
 * - The conflicts: a yearly fee stated per month, the payer and the reporting line the other way
 *   round, another figure for a year the dated clause covers, a duty for a permission ("has to",
 *   "should") and a permission for a duty in words the instructions don't give, and the same
 *   parties and force with another figure or place. Each is expected Contradicted.
 * - The near misses: a figure of someone the licence gives none for, and the year before the
 *   clause starts. Never Contradicted, never Supported.
 * - The faithful sentences: the fee from the other side (receives), the report in the passive,
 *   the force in other words, and the clause's own figure for a year it covers. Each Supported.
 * - The limits: leverage inside the stated limit and interest cover from a cost in brackets,
 *   Supported; a wrong cover, a missed floor and a wrong ratio, Contradicted.
 *
 * `en-limits` and `zh-limits` are #1908's own Document and sentences, checked as a Note is.
 *
 * The allotment sets (#2184) were written before any change to a contradiction's confirmation:
 * the parties the other way round, may for must and must for may (可 for 须 or 应, 须 for 可),
 * each expected Contradicted; and near misses that must never be Contradicted: a plain statement
 * of fact where the tenancy gives a permission, and the same duty of another party or group.
 */
import type { LibraryDocument, RepeatSentence, RepeatSet } from "./cases";

const sentencesOf =
  (kind: RepeatSentence["kind"], expected: RepeatSentence["expected"]) =>
  (list: readonly (readonly [string, string])[]): RepeatSentence[] =>
    list.map(([key, text]) => ({ key, kind, expected, text }));

const conflicts = sentencesOf("conflict", "contradicted");
const eitherWay = sentencesOf("near-miss", "not-contradicted");
const nearMisses = sentencesOf("near-miss", "unsupported");
const faithful = sentencesOf("paraphrase", "supported");

const LICENCE_SETS = {
  en: ["en-licence-conflicts", "en-licence-near-misses", "en-licence-faithful"],
  zh: ["zh-licence-conflicts", "zh-licence-near-misses", "zh-licence-faithful"],
} as const;

const ALLOTMENT_SETS = {
  en: ["en-allotment-conflicts", "en-allotment-near-misses"],
  zh: ["zh-allotment-conflicts", "zh-allotment-near-misses"],
} as const;

export const VERDICT_DOCUMENTS: readonly LibraryDocument[] = [
  {
    language: "en",
    file: "Studio Licence - M. Haddad.pdf",
    onlyFor: LICENCE_SETS.en,
    pages: [
      {
        lines: [
          "STUDIO LICENCE",
          "This licence is made between Kestrel Studios Ltd (the Licensor) and Mira Haddad (the Licensee).",
          "1. Use of the studio",
          "From 1 March 2025 the Licensee may use Studio B for 12 hours a week.",
          "The Licensee may bring up to two guests to each session.",
          "The Licensee may store instruments in Studio B overnight.",
          "2. Fee",
          "The Licensee pays the Licensor a fee of 2,400 per year, in one payment each January.",
          "3. Equipment",
          "The Licensee reports any damaged equipment to the Studio Manager within 48 hours.",
          "4. Ending the licence",
          "The Licensee must give 30 days' written notice to end this licence.",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "排练室使用协议 - 苏晴.pdf",
    onlyFor: LICENCE_SETS.zh,
    pages: [
      {
        chineseLines: [
          "排练室使用协议",
          "甲方：青柳文化传播有限公司　乙方：苏晴",
          "第一条　使用时间：自2025年3月1日起，乙方每周可使用B号排练室12小时。",
          "乙方每次排练可带不超过两名访客。",
          "乙方可将乐器存放在B号排练室过夜。",
          "第二条　使用费：乙方每年向甲方支付使用费人民币九千六百元，于每年一月一次付清。",
          "第三条　设备：乙方发现设备损坏，应在48小时内报告场地主管。",
          "第四条　解除：乙方解除本协议，须提前30日书面通知甲方。",
        ],
      },
    ],
  },
  {
    language: "en",
    file: "Allotment Tenancy - R. Lindqvist.pdf",
    onlyFor: ALLOTMENT_SETS.en,
    pages: [
      {
        lines: [
          "ALLOTMENT TENANCY",
          "This tenancy is made between Fernhill Parish Council (the Council) and Rosa Lindqvist (the Tenant).",
          "1. The plot",
          "The Council lets plot 27 at Fernhill Allotments to the Tenant.",
          "2. Rent",
          "The Tenant pays the Council a rent of 85 per year, due each October.",
          "3. Water",
          "The Council supplies water to the plot from April to September.",
          "4. Use of the plot",
          "The Tenant may keep up to six hens on the plot.",
          "The Tenant must keep the plot free of weeds.",
          "The Tenant may build one shed of up to 6 square metres.",
          "5. Inspection",
          "The Council may inspect the plot after giving 7 days' notice.",
        ],
      },
    ],
  },
  {
    language: "zh-CN",
    file: "地块租用协议 - 周岚.pdf",
    onlyFor: ALLOTMENT_SETS.zh,
    pages: [
      {
        chineseLines: [
          "菜园地块租用协议",
          "甲方：枫林社区居委会　乙方：周岚",
          "第一条　地块：甲方将枫林菜园27号地块出租给乙方。",
          "第二条　租金：乙方每年向甲方支付租金人民币八百五十元，于每年十月付清。",
          "第三条　供水：每年四月至九月由甲方向地块供水。",
          "第四条　使用：乙方可在地块上饲养不超过六只鸡。乙方须保持地块无杂草。",
          "乙方应每月清理地块内的垃圾。乙方可搭建一间不超过6平方米的工具棚。",
          "第五条　检查：甲方可提前7日通知乙方后检查地块。",
        ],
      },
    ],
  },
  {
    language: "en",
    file: "Harbourline results.md",
    onlyFor: ["en-limits-held-out"],
    text: [
      "# Harbourline Ferries half-year results",
      "All amounts are in GBP millions.",
      "",
      "EBITDA 64.0 (FY2025), 30.0 and 34.0 (H1 2025, H1 2026)",
      "",
      "Interest payable (12.8)",
      "",
      "Net debt at 30 June 2026 170.0",
      "",
      "Net debt to EBITDA must not exceed 3.0 to 1",
      "",
    ].join("\n"),
  },
  {
    language: "zh-CN",
    file: "海港轮渡半年业绩.md",
    onlyFor: ["zh-limits-held-out"],
    text: [
      "# 海港轮渡半年业绩",
      "",
      "EBITDA 64.0（2025财年），30.0 和 34.0（2025年上半年、2026年上半年）",
      "",
      "利息支出 (12.8)",
      "",
      "2026年6月30日净负债 170.0",
      "",
      "净负债与EBITDA之比不得超过3.0倍",
      "",
    ].join("\n"),
  },
  {
    language: "en",
    file: "Cedar results.md",
    onlyFor: ["en-limits"],
    text: [
      "# Cedar results",
      "All amounts are in GBP millions.",
      "",
      "Adjusted EBITDA 187.3 (FY2025), 88.0 and 91.5 (H1 2025, H1 2026)",
      "",
      "Finance costs (41.2)",
      "",
      "Net debt at 30 June 2026 528.9",
      "",
      "Net debt at 31 December 2026 (forecast) 668.0",
      "",
      "Net debt to Adjusted EBITDA must not exceed 3.25 to 1",
      "",
    ].join("\n"),
  },
  {
    language: "zh-CN",
    file: "雪松业绩.md",
    onlyFor: ["zh-limits"],
    text: [
      "# 雪松业绩",
      "",
      "调整后EBITDA 187.3（2025财年），88.0 和 91.5（2025年上半年、2026年上半年）",
      "",
      "财务费用 (41.2)",
      "",
      "2026年6月30日净负债 528.9",
      "",
      "2026年12月31日净负债（预测）668.0",
      "",
      "净负债与调整后EBITDA之比不得超过3.25倍",
      "",
    ].join("\n"),
  },
];

export const VERDICT_SETS: readonly RepeatSet[] = [
  {
    id: "en-licence-conflicts",
    language: "en",
    mind: "Licence points",
    sentences: conflicts([
      ["per-month", "The Licensee pays the Licensor a fee of 2,400 per month."],
      ["payer", "The Licensor pays the Licensee a fee of 2,400 per year."],
      ["reporting-line", "The Studio Manager reports damaged equipment to the Licensee."],
      ["period", "In 2026 the Licensee may use Studio B for 20 hours a week."],
      ["duty", "The Licensee has to store instruments in Studio B overnight."],
      ["should", "The Licensee should store instruments in Studio B overnight."],
      ["guests", "The Licensee may bring up to four guests to each session."],
      ["notice-days", "The Licensee must give 60 days' written notice to end this licence."],
      ["room", "The Licensee may store instruments in Studio A overnight."],
    ]).concat(
      // Moved on 2026-11-04 under the principle on #1708 (a sentence is Unsupported only when it
      // claims more than its Document grants): the permission word sits on the notice the clause
      // makes the condition of ending, so it is no force swap on the ending itself.
      eitherWay([
        ["permission", "The Licensee is free to give 30 days' written notice to end this licence."],
      ]),
    ),
  },
  {
    id: "en-licence-near-misses",
    language: "en",
    mind: "Other studio users",
    sentences: nearMisses([
      ["other-person", "The Studio Manager may use Studio B for 20 hours a week."],
      ["other-group", "Other licensees of Kestrel Studios pay a fee of 3,000 per year."],
      ["period-not-covered", "In 2024 the Licensee could use Studio B for 12 hours a week."],
    ]),
  },
  {
    id: "en-licence-faithful",
    language: "en",
    mind: "Licence in other words",
    sentences: faithful([
      ["receives", "The Licensor receives a fee of 2,400 a year from the Licensee."],
      [
        "passive",
        "Damaged equipment is reported by the Licensee to the Studio Manager within 48 hours.",
      ],
      ["allowed", "The Licensee is allowed to bring up to two guests to each session."],
      ["obliged", "The Licensee is obliged to give 30 days' written notice to end this licence."],
      ["period-covered", "In 2026 the Licensee may use Studio B for 12 hours a week."],
    ]),
  },
  {
    id: "zh-licence-conflicts",
    language: "zh-CN",
    mind: "协议要点",
    sentences: conflicts([
      ["per-month", "乙方每月向甲方支付使用费人民币九千六百元。"],
      ["payer", "甲方每年向乙方支付使用费人民币九千六百元。"],
      ["reporting-line", "场地主管向乙方报告设备损坏情况。"],
      ["period", "2026年乙方每周可使用B号排练室20小时。"],
      ["duty", "乙方有义务将乐器存放在B号排练室过夜。"],
      ["should", "乙方应该将乐器存放在B号排练室过夜。"],
      ["guests", "乙方每次排练可带不超过四名访客。"],
      ["notice-days", "乙方解除本协议，须提前60日书面通知甲方。"],
      ["room", "乙方可将乐器存放在A号排练室过夜。"],
    ]).concat(eitherWay([["permission", "乙方解除本协议，获准提前30日书面通知甲方。"]])),
  },
  {
    id: "zh-licence-near-misses",
    language: "zh-CN",
    mind: "其他使用者",
    sentences: nearMisses([
      ["other-person", "场地主管每周可使用B号排练室20小时。"],
      ["other-group", "青柳文化的其他租用者每年支付使用费人民币一万二千元。"],
      ["period-not-covered", "2024年乙方每周可使用B号排练室12小时。"],
    ]),
  },
  {
    id: "zh-licence-faithful",
    language: "zh-CN",
    mind: "协议的其他说法",
    sentences: faithful([
      ["receives", "甲方每年从乙方收取使用费人民币九千六百元。"],
      ["passive", "设备损坏的情况，应由乙方在48小时内报告场地主管。"],
      ["allowed", "乙方每次排练最多可以带两名访客。"],
      ["obliged", "乙方解除本协议，必须提前30日书面通知甲方。"],
      ["period-covered", "2026年乙方每周可使用B号排练室12小时。"],
    ]),
  },
  {
    id: "en-allotment-conflicts",
    language: "en",
    mind: "Allotment points",
    sentences: conflicts([
      ["payer", "The Council pays the Tenant a rent of 85 per year."],
      ["supplier", "The Tenant supplies water to the plot from April to September."],
      ["inspector", "The Tenant may inspect the plot after giving 7 days' notice."],
      ["may-for-must", "The Tenant may keep the plot free of weeds."],
      ["must-for-may", "The Tenant must keep up to six hens on the plot."],
      ["must-for-may-shed", "The Tenant must build one shed of up to 6 square metres."],
    ]),
  },
  {
    id: "en-allotment-near-misses",
    language: "en",
    mind: "Allotment notes",
    sentences: nearMisses([
      ["fact-for-permission", "The Tenant keeps six hens on the plot."],
      ["fact-for-permission-shed", "The Tenant has built a shed on the plot."],
      ["same-duty-other-party", "The Council must keep the plot free of weeds."],
      ["same-duty-other-group", "Other tenants at Fernhill must keep their plots free of weeds."],
    ]),
  },
  {
    id: "zh-allotment-conflicts",
    language: "zh-CN",
    mind: "地块要点",
    sentences: conflicts([
      ["payer", "甲方每年向乙方支付租金人民币八百五十元。"],
      ["supplier", "每年四月至九月由乙方向地块供水。"],
      ["inspector", "乙方可提前7日通知甲方后检查地块。"],
      ["ke-for-xu", "乙方可保持地块无杂草。"],
      ["ke-for-ying", "乙方可每月清理地块内的垃圾。"],
      ["xu-for-ke", "乙方须搭建一间不超过6平方米的工具棚。"],
    ]),
  },
  {
    id: "zh-allotment-near-misses",
    language: "zh-CN",
    mind: "地块笔记",
    sentences: nearMisses([
      ["fact-for-permission", "乙方在地块上饲养了六只鸡。"],
      ["fact-for-permission-shed", "乙方已在地块上搭建了一间工具棚。"],
      ["same-duty-other-party", "甲方须保持地块无杂草。"],
      ["same-duty-other-group", "枫林菜园的其他租户须保持各自地块无杂草。"],
    ]),
  },
  {
    id: "en-limits",
    language: "en",
    mind: "Cedar covenant",
    sentences: [
      ...faithful([
        [
          "inside-limit",
          "Net debt at 30 June 2026 was £528.9m, so leverage should still be inside the 3.25x covenant.",
        ],
        ["bracketed-cost", "Using finance costs of (41.2) as a stand-in, cover would be 4.55x."],
      ]),
      ...conflicts([
        [
          "outside-limit",
          "Net debt at 31 December 2026 is forecast at £668.0m, so leverage should stay inside the 3.25x covenant.",
        ],
        ["floor-missed", "Adjusted EBITDA covers finance costs at least 5 times."],
        ["wrong-cover", "Using finance costs of (41.2) as a stand-in, cover would be 5.55x."],
        [
          "wrong-ratio",
          "Net debt at 30 June 2026 was £528.9m, which is 3.1x last-twelve-months Adjusted EBITDA.",
        ],
      ]),
    ],
  },
  {
    id: "zh-limits",
    language: "zh-CN",
    mind: "雪松契约",
    sentences: [
      ...faithful([
        ["inside-limit", "2026年6月30日净负债为528.9，因此杠杆率仍应在3.25倍的契约上限之内。"],
        ["bracketed-cost", "以 (41.2) 的财务费用估算，利息覆盖倍数为4.55倍。"],
      ]),
      ...conflicts([
        ["outside-limit", "2026年12月31日净负债预测为668.0，杠杆率仍应在3.25倍的契约上限之内。"],
        ["floor-missed", "调整后EBITDA至少是财务费用的5倍。"],
        ["wrong-cover", "以 (41.2) 的财务费用估算，利息覆盖倍数为5.55倍。"],
        ["wrong-ratio", "2026年6月30日净负债为528.9，是近十二个月调整后EBITDA的3.1倍。"],
      ]),
    ],
  },
  {
    id: "en-limits-held-out",
    language: "en",
    mind: "Harbourline borrowing",
    sentences: [
      ...faithful([
        [
          "inside-limit",
          "Net debt at 30 June 2026 was £170.0m, which keeps leverage below the 3.0x ceiling.",
        ],
        ["bracketed-cost", "With interest payable of (12.8), FY2025 interest cover comes to 5.0x."],
      ]),
      ...conflicts([
        ["wrong-cover", "With interest payable of (12.8), FY2025 interest cover comes to 6.0x."],
        ["floor-missed", "FY2025 EBITDA covers interest payable at least 6 times."],
        [
          "wrong-ratio",
          "Net debt at 30 June 2026 was £170.0m, which is 2.0x last-twelve-months EBITDA.",
        ],
      ]),
    ],
  },
  {
    id: "zh-limits-held-out",
    language: "zh-CN",
    mind: "海港轮渡借款",
    sentences: [
      ...faithful([
        ["inside-limit", "2026年6月30日净负债为170.0，杠杆率因此低于3.0倍的上限。"],
        ["bracketed-cost", "按 (12.8) 的利息支出计算，2025财年利息覆盖倍数为5.0倍。"],
      ]),
      ...conflicts([
        ["wrong-cover", "按 (12.8) 的利息支出计算，2025财年利息覆盖倍数为6.0倍。"],
        ["floor-missed", "2025财年EBITDA至少是利息支出的6倍。"],
        ["wrong-ratio", "2026年6月30日净负债为170.0，是近十二个月EBITDA的2.0倍。"],
      ]),
    ],
  },
];
