/**
 * The held-out Note of #2532's gate (../evidence/2532-search-first/README.md): written and committed
 * before any run of the search-first check, and seen by no prompt. Invented rider terms of a bike
 * share and its year in numbers, in English and in Chinese, and a Note of 32 sentences about them
 * in each language: 11 the Documents state (4 word for word, 4 in other words, 3 with a figure: one
 * as written, one in other words, one worked out from two of the year's numbers), 13 wrong twins
 * (one detail changed: must for may, a negation, a place, the parties, a dropped condition, a
 * period, four figures, a scale, a currency and a worked-out figure that doesn't hold) and 8 the
 * Documents don't state at all, on the same topics. A second writer added 7 right sentences in each
 * language of the kinds a first search can miss (./searchFirstWritten). Frozen on 2026-11-14,
 * before Phase A.
 */
import type { PdfPage } from "../../tests/helpers/pdf";
import { WRITTEN_DOCUMENTS, WRITTEN_ITEMS } from "./searchFirstWritten";

export type SearchFirstKind = "right" | "twin" | "absent";

export interface SearchFirstItem {
  id: string;
  language: "en" | "zh-CN";
  kind: SearchFirstKind;
  /** For a right sentence, how it states the line; for a twin, what changed. */
  detail: string;
  sentence: string;
  /** For a right sentence, the Document's lines that state it, as written. */
  rests?: readonly string[];
}

export interface SearchFirstDocument {
  file: string;
  /** The Notes whose Library holds it: its own language's, and the other's for a sentence across languages. */
  libraries: readonly ("en" | "zh-CN")[];
  /** A PDF's pages, or a CSV table's text. */
  pages?: readonly PdfPage[];
  csv?: string;
}

const EN_TERMS = [
  "LUMEN BAY BIKE SHARE: RIDER TERMS",
  "These terms apply between Lumen Bay Bike Share (Lumen Bay) and each person who rents a bike (the Rider).",
  "Riding",
  "The Rider must be at least 16 years old.",
  "The Rider must lock the bike at a Lumen Bay dock at the end of each ride.",
  "The Rider may carry one child in an approved child seat.",
  "The Rider must not ride on the seafront promenade during the summer season.",
  "Helmets are lent free of charge at the Harbour Street dock only.",
  "The Rider must report an accident to Lumen Bay within two days.",
  "Charges",
  "A ride costs 1.50 pounds for each started 30 minutes.",
  "Riders on the annual plan ride the first 45 minutes of every ride free.",
  "Lumen Bay charges a late fee if a bike is not returned on the same day.",
  "The Rider pays for damage caused by misuse.",
  "Lumen Bay refunds a ride if the bike breaks down during it.",
];
const EN_TERMS_PAGE_TWO = [
  "Repairs and accounts",
  "Lumen Bay repairs a flat tyre reported through the app within two working days.",
  "Lumen Bay may suspend an account after repeated late returns.",
  "Either side may end the annual plan with written notice.",
  "Lumen Bay keeps ride records for one year.",
  "Law",
  "These terms are governed by the law of Scotland.",
];

const ZH_TERMS = [
  "青岚单车骑行条款",
  "本条款适用于青岚共享单车（青岚）与每位租用单车的人（骑行者）。",
  "骑行",
  "骑行者须年满16周岁。",
  "骑行者须在每次骑行结束时将单车锁在青岚停车点。",
  "骑行者可在经认可的儿童座椅上搭载一名儿童。",
  "骑行者不得在夏季期间于海滨步道骑行。",
  "仅港湾街停车点免费出借头盔。",
  "骑行者须在两天内向青岚报告事故。",
  "费用",
  "每开始一个30分钟，骑行收费1.5元。",
  "年度套餐骑行者每次骑行的前45分钟免费。",
  "单车未在当天归还的，青岚收取滞纳金。",
  "骑行者须赔偿因不当使用造成的损坏。",
  "单车在骑行中发生故障的，青岚退还该次骑行费用。",
];
const ZH_TERMS_PAGE_TWO = [
  "维修与账户",
  "通过应用程序报告的爆胎，青岚在两个工作日内修复。",
  "多次逾期归还的，青岚可暂停其账户。",
  "任何一方均可书面通知终止年度套餐。",
  "青岚保存骑行记录一年。",
  "法律",
  "本条款受苏格兰法律管辖。",
];

const EN_NUMBERS = [
  "LUMEN BAY BIKE SHARE: 2026 IN NUMBERS",
  "Rides in 2026: 1.2 million.",
  "Revenue in 2026: 2.4 million pounds.",
  "Bikes in service at the end of 2026: 1,800.",
  "Docks at the end of 2026: 140.",
  "Average ride length in 2026: 22 minutes.",
];

const ZH_NUMBERS = [
  "青岚共享单车2026年数据",
  "2026年骑行次数：120万次。",
  "2026年收入：240万元。",
  "2026年末在用单车：1,800辆。",
  "2026年末停车点：140个。",
  "2026年平均骑行时长：22分钟。",
];

export const SEARCH_FIRST_DOCUMENTS: readonly SearchFirstDocument[] = [
  {
    libraries: ["en"],
    file: "Lumen Bay Rider Terms.pdf",
    pages: [{ lines: EN_TERMS }, { lines: EN_TERMS_PAGE_TWO }],
  },
  { libraries: ["en"], file: "Lumen Bay 2026 in Numbers.pdf", pages: [{ lines: EN_NUMBERS }] },
  {
    libraries: ["zh-CN"],
    file: "青岚单车骑行条款.pdf",
    pages: [{ chineseLines: ZH_TERMS }, { chineseLines: ZH_TERMS_PAGE_TWO }],
  },
  {
    libraries: ["zh-CN"],
    file: "青岚共享单车2026年数据.pdf",
    pages: [{ chineseLines: ZH_NUMBERS }],
  },
  ...WRITTEN_DOCUMENTS,
];

const en = (
  id: string,
  kind: SearchFirstKind,
  detail: string,
  sentence: string,
  rests?: readonly string[],
): SearchFirstItem => ({
  id: `en-${id}`,
  language: "en",
  kind,
  detail,
  sentence,
  ...(rests && { rests }),
});
const zh = (
  id: string,
  kind: SearchFirstKind,
  detail: string,
  sentence: string,
  rests?: readonly string[],
): SearchFirstItem => ({
  id: `zh-${id}`,
  language: "zh-CN",
  kind,
  detail,
  sentence,
  ...(rests && { rests }),
});

export const SEARCH_FIRST_ITEMS: readonly SearchFirstItem[] = [
  en(
    "lock",
    "right",
    "word for word",
    "The Rider must lock the bike at a Lumen Bay dock at the end of each ride.",
    ["The Rider must lock the bike at a Lumen Bay dock at the end of each ride."],
  ),
  en(
    "child",
    "right",
    "word for word",
    "The Rider may carry one child in an approved child seat.",
    ["The Rider may carry one child in an approved child seat."],
  ),
  en("law", "right", "word for word", "These terms are governed by the law of Scotland.", [
    "These terms are governed by the law of Scotland.",
  ]),
  en("misuse", "right", "word for word", "The Rider pays for damage caused by misuse.", [
    "The Rider pays for damage caused by misuse.",
  ]),
  en(
    "refund",
    "right",
    "other words",
    "Lumen Bay gives back the cost of a ride when the bike breaks down during that ride.",
    ["Lumen Bay refunds a ride if the bike breaks down during it."],
  ),
  en(
    "end",
    "right",
    "other words",
    "Either side can end the annual plan by giving written notice.",
    ["Either side may end the annual plan with written notice."],
  ),
  en(
    "suspend",
    "right",
    "other words",
    "After repeated late returns, Lumen Bay may suspend the Rider's account.",
    ["Lumen Bay may suspend an account after repeated late returns."],
  ),
  en("age", "right", "other words, a figure", "A Rider has to be 16 or older.", [
    "The Rider must be at least 16 years old.",
  ]),
  en(
    "lock-may",
    "twin",
    "may for must",
    "The Rider may lock the bike at a Lumen Bay dock at the end of each ride.",
  ),
  en(
    "promenade",
    "twin",
    "a negation",
    "The Rider may ride on the seafront promenade during the summer season.",
  ),
  en(
    "helmet-place",
    "twin",
    "another place",
    "Helmets are lent free of charge at the Station Road dock only.",
  ),
  en(
    "report-parties",
    "twin",
    "the parties the other way round",
    "Lumen Bay must report an accident to the Rider within two days.",
  ),
  en(
    "tyre-condition",
    "twin",
    "a dropped condition",
    "Lumen Bay repairs any flat tyre within two working days.",
  ),
  en("records", "twin", "another period", "Lumen Bay keeps ride records for five years."),
  en("age-figure", "twin", "another figure", "The Rider must be at least 18 years old."),
  en(
    "price-figure",
    "twin",
    "another figure",
    "A ride costs 1.50 pounds for each started 60 minutes.",
  ),
  en("helmet-wear", "absent", "not stated", "The Rider must wear a helmet on every ride."),
  en("insurance", "absent", "not stated", "Lumen Bay insures every Rider against injury."),
  en("trains", "absent", "not stated", "Riders may take the bikes on trains free of charge."),
  en("receipt", "absent", "not stated", "Lumen Bay emails the Rider a receipt after every ride."),
  en("lend", "absent", "not stated", "The Rider may lend the bike to a friend."),
  en("holidays", "absent", "not stated", "Lumen Bay closes its docks on public holidays."),
  en("plan-price", "absent", "not stated, a figure", "The annual plan costs 90 pounds a year."),
  en(
    "speed",
    "absent",
    "not stated, a figure",
    "The electric bikes have a top speed of 15 miles per hour.",
  ),
  en(
    "price",
    "right",
    "word for word, a figure",
    "A ride costs 1.50 pounds for each started 30 minutes.",
    ["A ride costs 1.50 pounds for each started 30 minutes."],
  ),
  en(
    "rides",
    "right",
    "other words, a figure",
    "Lumen Bay's riders made 1.2 million rides in 2026.",
    ["Rides in 2026: 1.2 million."],
  ),
  en(
    "per-ride",
    "right",
    "worked out, a figure",
    "Lumen Bay earned 2 pounds of revenue per ride in 2026.",
    ["Rides in 2026: 1.2 million.", "Revenue in 2026: 2.4 million pounds."],
  ),
  en(
    "free-figure",
    "twin",
    "another figure",
    "Riders on the annual plan ride the first 60 minutes of every ride free.",
  ),
  en(
    "bikes-figure",
    "twin",
    "another figure",
    "Lumen Bay had 1,500 bikes in service at the end of 2026.",
  ),
  en(
    "revenue-scale",
    "twin",
    "another scale",
    "Lumen Bay's revenue in 2026 was 2.4 billion pounds.",
  ),
  en(
    "revenue-currency",
    "twin",
    "another currency",
    "Lumen Bay's revenue in 2026 was 2.4 million euros.",
  ),
  en(
    "per-dock",
    "twin",
    "worked out wrong, a figure",
    "At the end of 2026, Lumen Bay's docks held 20 bikes each on average.",
  ),
  zh("lock", "right", "word for word", "骑行者须在每次骑行结束时将单车锁在青岚停车点。", [
    "骑行者须在每次骑行结束时将单车锁在青岚停车点。",
  ]),
  zh("child", "right", "word for word", "骑行者可在经认可的儿童座椅上搭载一名儿童。", [
    "骑行者可在经认可的儿童座椅上搭载一名儿童。",
  ]),
  zh("law", "right", "word for word", "本条款受苏格兰法律管辖。", ["本条款受苏格兰法律管辖。"]),
  zh("misuse", "right", "word for word", "骑行者须赔偿因不当使用造成的损坏。", [
    "骑行者须赔偿因不当使用造成的损坏。",
  ]),
  zh("refund", "right", "other words", "如果单车在骑行途中坏了，青岚会把这次骑行的钱退给骑行者。", [
    "单车在骑行中发生故障的，青岚退还该次骑行费用。",
  ]),
  zh("end", "right", "other words", "年度套餐可由任何一方以书面通知的方式终止。", [
    "任何一方均可书面通知终止年度套餐。",
  ]),
  zh("suspend", "right", "other words", "骑行者多次逾期还车的，青岚可以暂停其账户。", [
    "多次逾期归还的，青岚可暂停其账户。",
  ]),
  zh("age", "right", "other words, a figure", "骑行者至少要满16岁。", ["骑行者须年满16周岁。"]),
  zh("lock-may", "twin", "may for must", "骑行者可在每次骑行结束时将单车锁在青岚停车点。"),
  zh("promenade", "twin", "a negation", "骑行者可在夏季期间于海滨步道骑行。"),
  zh("helmet-place", "twin", "another place", "仅车站路停车点免费出借头盔。"),
  zh(
    "report-parties",
    "twin",
    "the parties the other way round",
    "青岚须在两天内向骑行者报告事故。",
  ),
  zh("tyre-condition", "twin", "a dropped condition", "任何爆胎青岚都在两个工作日内修复。"),
  zh("records", "twin", "another period", "青岚保存骑行记录五年。"),
  zh("age-figure", "twin", "another figure", "骑行者须年满18周岁。"),
  zh("price-figure", "twin", "another figure", "每开始一个60分钟，骑行收费1.5元。"),
  zh("helmet-wear", "absent", "not stated", "骑行者每次骑行都须佩戴头盔。"),
  zh("insurance", "absent", "not stated", "青岚为每位骑行者投保人身意外险。"),
  zh("trains", "absent", "not stated", "骑行者可免费携带单车乘坐火车。"),
  zh("receipt", "absent", "not stated", "每次骑行后青岚都会通过电子邮件向骑行者发送收据。"),
  zh("lend", "absent", "not stated", "骑行者可将单车借给朋友使用。"),
  zh("holidays", "absent", "not stated", "青岚在公共假日关闭其停车点。"),
  zh("plan-price", "absent", "not stated, a figure", "年度套餐每年收费90元。"),
  zh("speed", "absent", "not stated, a figure", "电动单车的最高时速为每小时25公里。"),
  zh("price", "right", "word for word, a figure", "每开始一个30分钟，骑行收费1.5元。", [
    "每开始一个30分钟，骑行收费1.5元。",
  ]),
  zh("rides", "right", "other words, a figure", "2026年青岚骑行者共完成120万次骑行。", [
    "2026年骑行次数：120万次。",
  ]),
  zh("per-ride", "right", "worked out, a figure", "2026年青岚每次骑行的收入为2元。", [
    "2026年骑行次数：120万次。",
    "2026年收入：240万元。",
  ]),
  zh("free-figure", "twin", "another figure", "年度套餐骑行者每次骑行的前60分钟免费。"),
  zh("bikes-figure", "twin", "another figure", "2026年末青岚在用单车为1,500辆。"),
  zh("revenue-scale", "twin", "another scale", "2026年青岚收入为2.4亿元。"),
  zh("revenue-currency", "twin", "another currency", "2026年青岚收入为240万美元。"),
  zh("per-dock", "twin", "worked out wrong, a figure", "2026年末青岚平均每个停车点有20辆单车。"),
  ...WRITTEN_ITEMS,
];
