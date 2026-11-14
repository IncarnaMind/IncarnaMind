/**
 * The held-out Note of #2532's gate (../evidence/2532-search-first/README.md): written and committed
 * before any run of the search-first check, and seen by no prompt. Invented rider terms of a bike
 * share, in English and in Chinese, and a Note of 24 sentences about them in each language: 8 the
 * terms state (4 word for word, 4 in other words), 8 wrong twins (one detail changed: a figure, a
 * period, a place, the parties, must for may, a negation, a dropped condition) and 8 the terms
 * don't state at all, on the same topics. A sentence with a figure in it is checked by its Run on
 * both arms; the rest may be settled by the first reply.
 */
import type { PdfPage } from "../../tests/helpers/pdf";

export type SearchFirstKind = "right" | "twin" | "absent";

export interface SearchFirstItem {
  id: string;
  language: "en" | "zh-CN";
  kind: SearchFirstKind;
  /** For a right sentence, how it states the line; for a twin, what changed. */
  detail: string;
  sentence: string;
}

export interface SearchFirstDocument {
  language: "en" | "zh-CN";
  file: string;
  pages: readonly PdfPage[];
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

export const SEARCH_FIRST_DOCUMENTS: readonly SearchFirstDocument[] = [
  {
    language: "en",
    file: "Lumen Bay Rider Terms.pdf",
    pages: [{ lines: EN_TERMS }, { lines: EN_TERMS_PAGE_TWO }],
  },
  {
    language: "zh-CN",
    file: "青岚单车骑行条款.pdf",
    pages: [{ chineseLines: ZH_TERMS }, { chineseLines: ZH_TERMS_PAGE_TWO }],
  },
];

const en = (
  id: string,
  kind: SearchFirstKind,
  detail: string,
  sentence: string,
): SearchFirstItem => ({ id: `en-${id}`, language: "en", kind, detail, sentence });
const zh = (
  id: string,
  kind: SearchFirstKind,
  detail: string,
  sentence: string,
): SearchFirstItem => ({ id: `zh-${id}`, language: "zh-CN", kind, detail, sentence });

export const SEARCH_FIRST_ITEMS: readonly SearchFirstItem[] = [
  en(
    "lock",
    "right",
    "word for word",
    "The Rider must lock the bike at a Lumen Bay dock at the end of each ride.",
  ),
  en("child", "right", "word for word", "The Rider may carry one child in an approved child seat."),
  en("law", "right", "word for word", "These terms are governed by the law of Scotland."),
  en("misuse", "right", "word for word", "The Rider pays for damage caused by misuse."),
  en(
    "refund",
    "right",
    "other words",
    "Lumen Bay gives back the cost of a ride when the bike breaks down during that ride.",
  ),
  en(
    "end",
    "right",
    "other words",
    "Either side can end the annual plan by giving written notice.",
  ),
  en(
    "suspend",
    "right",
    "other words",
    "After repeated late returns, Lumen Bay may suspend the Rider's account.",
  ),
  en("age", "right", "other words, a figure", "A Rider has to be 16 or older."),
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
  zh("lock", "right", "word for word", "骑行者须在每次骑行结束时将单车锁在青岚停车点。"),
  zh("child", "right", "word for word", "骑行者可在经认可的儿童座椅上搭载一名儿童。"),
  zh("law", "right", "word for word", "本条款受苏格兰法律管辖。"),
  zh("misuse", "right", "word for word", "骑行者须赔偿因不当使用造成的损坏。"),
  zh("refund", "right", "other words", "如果单车在骑行途中坏了，青岚会把这次骑行的钱退给骑行者。"),
  zh("end", "right", "other words", "年度套餐可由任何一方以书面通知的方式终止。"),
  zh("suspend", "right", "other words", "骑行者多次逾期还车的，青岚可以暂停其账户。"),
  zh("age", "right", "other words, a figure", "骑行者至少要满16岁。"),
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
];
