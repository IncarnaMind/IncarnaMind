/**
 * Uncited sentences of an Answer beside a Passage of a Document, made up for this set (#3410): a
 * sentence that says what the Passage says, in its words or in others, and near-twins that change
 * one thing that matters. Every Document, name and figure is invented.
 */

export type PairKind =
  | "same-words"
  | "paraphrase"
  | "party"
  | "modal"
  | "negation"
  | "unit"
  | "period"
  | "condition"
  | "direction"
  | "quoted";

export interface UncitedDocument {
  key: string;
  /** The Document's name, as the file is named. */
  name: string;
  language: "en" | "zh";
  text: string;
  /** What a Question may ask the Document about besides the pair's own sentence, with the sentence that says it. */
  hooks: readonly { topic: string; sentence: string }[];
}

export interface UncitedPair {
  id: string;
  language: "en" | "zh";
  kind: PairKind;
  document: string;
  /** The Document's sentence the Answer's sentence is about. */
  passage: string;
  /** The Answer's sentence, written with no Citation. */
  sentence: string;
  /** It says what `passage` says: a Citation of it is right. */
  same: boolean;
  /** Never quoted in a report, so a change can't be fitted to it. */
  heldOut: boolean;
}

const LEASE = [
  "Pellow Street Lease between Harlan Brindle (the Landlord) and Orchid Lane Bakery Ltd (the Tenant).",
  "The Landlord must repair the roof and the external walls within 30 days of written notice from the Tenant.",
  "The Tenant shall pay the service charge of £1,200 each quarter in advance.",
  "The Tenant may sublet the ground floor only with the Landlord's prior written consent.",
  "The deposit of £4,800 is returned to the Tenant within 14 days after the lease ends.",
  "The Landlord does not insure the Tenant's stock, but insures the building.",
  "Rent rises by 3% on each anniversary of the start date if the retail price index has risen.",
];

const SUPPLY = [
  "Supply agreement between Calder Freight Ltd (the Supplier) and Wynn Mills plc (the Buyer).",
  "The Supplier shall deliver 40 tonnes of oat flour to the Buyer's Selby warehouse every month.",
  "The Buyer must pay each invoice within 45 days of receiving the goods.",
  "Either party may end the agreement by giving 90 days' written notice.",
  "The Supplier is not liable for delays caused by flooding at the Selby warehouse.",
  "Late payments carry interest at 2% per month above the lender's base rate.",
  "Prices are fixed for the first 12 months and may then increase by up to 5% a year.",
];

const WATER = [
  "Marrick Valley Water Board, annual report for 2025.",
  "Leakage fell from 112 to 97 megalitres a day between 2024 and 2025.",
  "The Board replaced 38 kilometres of mains pipe in the northern district during the year.",
  "Customer complaints about water pressure rose by 18% compared with the previous year.",
  "Bills for households on the social tariff will not increase in 2026.",
  "The Board's new reservoir at Gillam Moor holds 2,400 megalitres.",
];

const ZH_LEASE = [
  "青禾路商铺租赁合同，出租人林嘉禾，承租人溪口面包坊有限公司。",
  "出租人应在收到承租人书面通知后30日内修复屋顶和外墙。",
  "承租人应于每季度开始前预付服务费1200元。",
  "未经出租人事先书面同意，承租人不得转租一楼。",
  "租赁期满后14日内，出租人应将押金4800元退还承租人。",
  "出租人不负责承租人存货的保险，但负责房屋的保险。",
  "若消费价格指数上涨，租金在每个租赁周年日上调3%。",
];

const ZH_SUPPLY = [
  "博远物流有限公司（供应方）与临川面粉厂（采购方）供货协议。",
  "供应方每月向采购方的城东仓库交付燕麦粉40吨。",
  "采购方须在收到货物后45日内支付每张发票。",
  "任何一方均可提前90日书面通知终止本协议。",
  "因城东仓库水灾造成的延误，供应方不承担责任。",
  "逾期付款按每月2%计收利息。",
  "前12个月价格固定，此后每年涨幅不超过5%。",
];

const ZH_WATER = [
  "溪口水务局2025年度报告。",
  "2025年漏损量由每日112兆升降至97兆升。",
  "本年度北区共更换供水主管38公里。",
  "关于水压的用户投诉比上年增加18%。",
  "2026年低保家庭的水费不会上调。",
  "新建的石门水库库容为2400兆升。",
];

export const DOCUMENTS: readonly UncitedDocument[] = [
  {
    key: "lease",
    name: "Pellow Street Lease",
    language: "en",
    text: LEASE.join("\n"),
    hooks: [
      { topic: "the deposit", sentence: LEASE[4] as string },
      { topic: "insurance", sentence: LEASE[5] as string },
    ],
  },
  {
    key: "supply",
    name: "Calder Freight Supply Agreement",
    language: "en",
    text: SUPPLY.join("\n"),
    hooks: [
      { topic: "ending the agreement", sentence: SUPPLY[3] as string },
      { topic: "late payment", sentence: SUPPLY[5] as string },
    ],
  },
  {
    key: "water",
    name: "Marrick Valley Water Board Annual Report 2025",
    language: "en",
    text: WATER.join("\n"),
    hooks: [
      { topic: "the new reservoir", sentence: WATER[5] as string },
      { topic: "mains pipe", sentence: WATER[2] as string },
    ],
  },
  {
    key: "zh-lease",
    name: "青禾路商铺租赁合同",
    language: "zh",
    text: ZH_LEASE.join("\n"),
    hooks: [
      { topic: "押金", sentence: ZH_LEASE[4] as string },
      { topic: "保险", sentence: ZH_LEASE[5] as string },
    ],
  },
  {
    key: "zh-supply",
    name: "博远物流供货协议",
    language: "zh",
    text: ZH_SUPPLY.join("\n"),
    hooks: [
      { topic: "终止协议", sentence: ZH_SUPPLY[3] as string },
      { topic: "逾期付款", sentence: ZH_SUPPLY[5] as string },
    ],
  },
  {
    key: "zh-water",
    name: "溪口水务局2025年度报告",
    language: "zh",
    text: ZH_WATER.join("\n"),
    hooks: [
      { topic: "新水库", sentence: ZH_WATER[5] as string },
      { topic: "供水主管", sentence: ZH_WATER[2] as string },
    ],
  },
];

type Row = [kind: PairKind, document: string, passage: string, sentence: string, heldOut?: true];

const at = (lines: readonly string[], index: number) => lines[index] as string;

const EN: readonly Row[] = [
  [
    "same-words",
    "lease",
    at(LEASE, 4),
    "The deposit of £4,800 is returned to the Tenant within 14 days after the lease has ended.",
  ],
  [
    "same-words",
    "supply",
    at(SUPPLY, 3),
    "Either party can end the agreement by giving 90 days' written notice.",
  ],
  [
    "same-words",
    "water",
    at(WATER, 2),
    "During the year the Board replaced 38 kilometres of mains pipe in the northern district.",
    true,
  ],
  [
    "paraphrase",
    "lease",
    at(LEASE, 2),
    "Every three months, Orchid Lane Bakery pays a £1,200 service charge up front.",
  ],
  [
    "paraphrase",
    "supply",
    at(SUPPLY, 2),
    "Wynn Mills has 45 days from delivery to settle each invoice.",
  ],
  [
    "paraphrase",
    "water",
    at(WATER, 1),
    "Daily leakage dropped to 97 megalitres in 2025, down from 112 the year before.",
    true,
  ],
  [
    "party",
    "lease",
    at(LEASE, 1),
    "The Tenant must repair the roof and the external walls within 30 days of written notice from the Landlord.",
  ],
  [
    "party",
    "supply",
    at(SUPPLY, 1),
    "The Buyer shall deliver 40 tonnes of oat flour to the Supplier's Selby warehouse every month.",
  ],
  [
    "party",
    "supply",
    at(SUPPLY, 4),
    "The Buyer is not liable for delays caused by flooding at the Selby warehouse.",
    true,
  ],
  [
    "modal",
    "lease",
    at(LEASE, 2),
    "The Tenant may pay the service charge of £1,200 each quarter in advance.",
  ],
  [
    "modal",
    "supply",
    at(SUPPLY, 2),
    "The Buyer may pay each invoice within 45 days of receiving the goods.",
  ],
  [
    "modal",
    "supply",
    at(SUPPLY, 6),
    "Prices are fixed for the first 12 months and must then increase by up to 5% a year.",
    true,
  ],
  [
    "negation",
    "lease",
    at(LEASE, 5),
    "The Landlord insures the Tenant's stock, but does not insure the building.",
  ],
  [
    "negation",
    "supply",
    at(SUPPLY, 4),
    "The Supplier is liable for delays not caused by flooding at the Selby warehouse.",
  ],
  [
    "negation",
    "water",
    at(WATER, 4),
    "Bills for households not on the social tariff will increase in 2026.",
    true,
  ],
  [
    "unit",
    "lease",
    at(LEASE, 1),
    "The Landlord must repair the roof and the external walls within 30 weeks of written notice from the Tenant.",
  ],
  [
    "unit",
    "supply",
    at(SUPPLY, 1),
    "The Supplier shall deliver 40 kilograms of oat flour to the Buyer's Selby warehouse every month.",
  ],
  [
    "unit",
    "water",
    at(WATER, 2),
    "The Board replaced 38 miles of mains pipe in the northern district during the year.",
    true,
  ],
  [
    "period",
    "lease",
    at(LEASE, 2),
    "The Tenant shall pay the service charge of £1,200 each month in advance.",
  ],
  [
    "period",
    "supply",
    at(SUPPLY, 5),
    "Late payments carry interest at 2% per year above the lender's base rate.",
  ],
  [
    "period",
    "water",
    at(WATER, 1),
    "Leakage fell from 112 to 97 megalitres a week between 2024 and 2025.",
    true,
  ],
  ["condition", "lease", at(LEASE, 6), "Rent rises by 3% on each anniversary of the start date."],
  [
    "condition",
    "lease",
    at(LEASE, 3),
    "The Tenant may sublet the ground floor without asking the Landlord for prior written consent.",
  ],
  ["condition", "supply", at(SUPPLY, 2), "The Buyer must pay each invoice within 45 days.", true],
  [
    "direction",
    "water",
    at(WATER, 1),
    "Leakage rose from 97 to 112 megalitres a day between 2024 and 2025.",
  ],
  [
    "direction",
    "water",
    at(WATER, 3),
    "Customer complaints about water pressure fell by 18% compared with the previous year.",
  ],
  [
    "direction",
    "lease",
    at(LEASE, 6),
    "Rent falls by 3% on each anniversary of the start date if the retail price index has risen.",
    true,
  ],
  [
    "quoted",
    "lease",
    at(LEASE, 1),
    'The Tenant has to "repair the roof and the external walls within 30 days".',
  ],
  [
    "quoted",
    "supply",
    at(SUPPLY, 3),
    'Only the Supplier may end the agreement, "by giving 90 days\' written notice".',
  ],
  ["quoted", "water", at(WATER, 4), 'Bills for every household "will not increase in 2026".', true],
];

const ZH: readonly Row[] = [
  [
    "same-words",
    "zh-lease",
    at(ZH_LEASE, 4),
    "租赁期满后14日内，出租人应把押金4800元退还给承租人。",
  ],
  ["same-words", "zh-supply", at(ZH_SUPPLY, 3), "本协议任何一方均可提前90日以书面通知终止。"],
  ["same-words", "zh-water", at(ZH_WATER, 2), "本年度共在北区更换供水主管38公里。", true],
  ["paraphrase", "zh-lease", at(ZH_LEASE, 2), "溪口面包坊每三个月提前交一次1200元的服务费。"],
  ["paraphrase", "zh-supply", at(ZH_SUPPLY, 2), "临川面粉厂有45天时间在到货后付清每张发票。"],
  [
    "paraphrase",
    "zh-water",
    at(ZH_WATER, 1),
    "与前一年相比，2025年每天漏掉的水从112兆升减少到97兆升。",
    true,
  ],
  ["party", "zh-lease", at(ZH_LEASE, 1), "承租人应在收到出租人书面通知后30日内修复屋顶和外墙。"],
  ["party", "zh-supply", at(ZH_SUPPLY, 1), "采购方每月向供应方的城东仓库交付燕麦粉40吨。"],
  ["party", "zh-supply", at(ZH_SUPPLY, 4), "因城东仓库水灾造成的延误，采购方不承担责任。", true],
  ["modal", "zh-lease", at(ZH_LEASE, 2), "承租人可于每季度开始前预付服务费1200元。"],
  ["modal", "zh-supply", at(ZH_SUPPLY, 2), "采购方可在收到货物后45日内支付每张发票。"],
  [
    "modal",
    "zh-lease",
    at(ZH_LEASE, 4),
    "租赁期满后14日内，出租人可将押金4800元退还承租人。",
    true,
  ],
  ["negation", "zh-lease", at(ZH_LEASE, 5), "出租人负责承租人存货的保险，但不负责房屋的保险。"],
  ["negation", "zh-supply", at(ZH_SUPPLY, 4), "非因城东仓库水灾造成的延误，供应方承担责任。"],
  ["negation", "zh-water", at(ZH_WATER, 4), "2026年非低保家庭的水费会上调。", true],
  ["unit", "zh-lease", at(ZH_LEASE, 1), "出租人应在收到承租人书面通知后30周内修复屋顶和外墙。"],
  ["unit", "zh-supply", at(ZH_SUPPLY, 1), "供应方每月向采购方的城东仓库交付燕麦粉40公斤。"],
  ["unit", "zh-water", at(ZH_WATER, 2), "本年度北区共更换供水主管38英里。", true],
  ["period", "zh-lease", at(ZH_LEASE, 2), "承租人应于每月开始前预付服务费1200元。"],
  ["period", "zh-supply", at(ZH_SUPPLY, 5), "逾期付款按每年2%计收利息。"],
  ["period", "zh-water", at(ZH_WATER, 1), "2025年漏损量由每周112兆升降至97兆升。", true],
  ["condition", "zh-lease", at(ZH_LEASE, 6), "租金在每个租赁周年日上调3%。"],
  ["condition", "zh-lease", at(ZH_LEASE, 3), "承租人无须征得出租人事先书面同意即可转租一楼。"],
  ["condition", "zh-supply", at(ZH_SUPPLY, 2), "采购方须在45日内支付每张发票。", true],
  ["direction", "zh-water", at(ZH_WATER, 1), "2025年漏损量由每日97兆升升至112兆升。"],
  ["direction", "zh-water", at(ZH_WATER, 3), "关于水压的用户投诉比上年减少18%。"],
  [
    "direction",
    "zh-lease",
    at(ZH_LEASE, 6),
    "若消费价格指数上涨，租金在每个租赁周年日下调3%。",
    true,
  ],
  ["quoted", "zh-lease", at(ZH_LEASE, 1), "承租人须在“30日内修复屋顶和外墙”。"],
  ["quoted", "zh-supply", at(ZH_SUPPLY, 3), "只有供应方可以“提前90日书面通知终止本协议”。"],
  ["quoted", "zh-water", at(ZH_WATER, 4), "2026年所有家庭的水费都“不会上调”。", true],
];

const SAME: ReadonlySet<PairKind> = new Set(["same-words", "paraphrase"]);

const pairsOf = (language: "en" | "zh", rows: readonly Row[]): UncitedPair[] =>
  rows.map(([kind, document, passage, sentence, heldOut], index) => ({
    id: `${language}-${String(index + 1).padStart(2, "0")}-${kind}`,
    language,
    kind,
    document,
    passage,
    sentence,
    same: SAME.has(kind),
    heldOut: heldOut === true,
  }));

export const PAIRS: readonly UncitedPair[] = [...pairsOf("en", EN), ...pairsOf("zh", ZH)];
