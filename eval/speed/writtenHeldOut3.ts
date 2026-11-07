/**
 * The third held-out set of the written check, for the verdict beside `cite` (#2532,
 * gates/verdict-beside-cite.md). Written and committed before any run of that step, and before
 * its instruction was written. None of its Documents or sentences comes from a prompt, a test or
 * the first two sets (./writtenCases, ./writtenHeldOut). An invented storage unit licence in
 * English and Chinese; each sentence is written into a Note of its own, in a Library of only
 * these terms, with one Citation of the line it rests on.
 *
 * The decoys are the ones a verdict written before its Citation is checked could let through:
 * may for must and must for may, the parties the other way round, a condition dropped, a line a
 * lead-in limits to some customers, and a rule a later "notwithstanding" overrides.
 */
import type { WrittenDocument, WrittenItem } from "./writtenCases";

const EN_TERMS = [
  {
    lines: [
      "QUILLHAVEN STORAGE: UNIT LICENCE TERMS",
      "These terms apply between Quillhaven Storage (Quillhaven) and the person named on the unit licence (the Customer).",
      "Using the unit",
      "The Customer must keep the unit locked when it is not in use.",
      "Quillhaven may open the unit in an emergency.",
      "The Customer must not store food in the unit.",
      "Quillhaven provides a trolley for moving goods.",
      "Each of the following applies only to customers on a business licence:",
      "The Customer may receive deliveries at the reception desk.",
      "Quillhaven keeps a record of every delivery.",
      "Paying and leaving",
      "The Customer pays the licence fee monthly in advance.",
      "Quillhaven returns the deposit within a week after the Customer moves out, if the unit is left clean.",
      "The Customer must give Quillhaven written notice before moving out.",
    ],
  },
  {
    lines: [
      "Changes and goods left behind",
      "Quillhaven may change these terms with written notice.",
      "Notwithstanding the rule on food, the Customer may store sealed tinned food in the unit.",
      "Quillhaven may sell goods left in the unit after the licence ends, but only once it has written to the Customer twice.",
      "These terms are governed by the law of Scotland.",
    ],
  },
];

const ZH_TERMS = [
  {
    lines: [
      "澄枫仓储储物单元许可条款",
      "本条款适用于澄枫仓储（澄枫）与储物单元许可证上所列人员（客户）。",
      "使用储物单元",
      "客户在不使用储物单元时必须将其锁好。",
      "澄枫可以在紧急情况下打开储物单元。",
      "客户不得在储物单元内存放食品。",
      "澄枫提供搬运物品用的手推车。",
      "以下各项仅适用于持商业许可证的客户：",
      "客户可以在前台接收快递。",
      "澄枫记录每一次快递。",
      "付款与搬出",
      "客户按月预付许可费。",
      "如客户搬出时储物单元保持清洁，澄枫在客户搬出后一周内退还押金。",
      "客户搬出前必须书面通知澄枫。",
    ],
  },
  {
    lines: [
      "变更与遗留物品",
      "澄枫可以书面通知变更本条款。",
      "尽管有关于食品的规定，客户可以在储物单元内存放密封罐头食品。",
      "许可结束后，澄枫可以出售留在储物单元内的物品，但须先两次书面通知客户。",
      "本条款受苏格兰法律管辖。",
    ],
  },
];

export const THIRD_DOCUMENTS: readonly WrittenDocument[] = [
  {
    language: "en",
    file: "Quillhaven unit licence terms.pdf",
    pages: EN_TERMS,
    libraries: ["terms"],
  },
  { language: "zh-CN", file: "澄枫仓储许可条款.pdf", pages: ZH_TERMS, libraries: ["terms"] },
];

type Third = Omit<WrittenItem, "library">;

const EN: readonly Third[] = [
  {
    id: "w3-en-copy-locked",
    language: "en",
    kind: "copy",
    sentence: "The Customer must keep the unit locked when it is not in use.",
    quote: "The Customer must keep the unit locked when it is not in use.",
    expected: "stated",
  },
  {
    id: "w3-en-paraphrase-emergency",
    language: "en",
    kind: "paraphrase",
    sentence: "In an emergency, Quillhaven is allowed to open the unit.",
    quote: "Quillhaven may open the unit in an emergency.",
    expected: "stated",
  },
  {
    id: "w3-en-paraphrase-notice",
    language: "en",
    kind: "paraphrase",
    sentence: "Before moving out, the Customer has to tell Quillhaven in writing.",
    quote: "The Customer must give Quillhaven written notice before moving out.",
    expected: "stated",
  },
  {
    id: "w3-en-paraphrase-trolley",
    language: "en",
    kind: "paraphrase",
    sentence: "A trolley for moving goods is provided by Quillhaven.",
    quote: "Quillhaven provides a trolley for moving goods.",
    expected: "stated",
  },
  {
    id: "w3-en-copy-fee",
    language: "en",
    kind: "copy",
    sentence: "The Customer pays the licence fee monthly in advance.",
    quote: "The Customer pays the licence fee monthly in advance.",
    expected: "stated",
  },
  {
    id: "w3-en-force-must-open",
    language: "en",
    kind: "force",
    sentence: "Quillhaven must open the unit in an emergency.",
    quote: "Quillhaven may open the unit in an emergency.",
    expected: "not stated",
  },
  {
    id: "w3-en-force-may-notice",
    language: "en",
    kind: "force",
    sentence: "The Customer may give Quillhaven written notice before moving out, if they wish.",
    quote: "The Customer must give Quillhaven written notice before moving out.",
    expected: "not stated",
  },
  {
    id: "w3-en-parties-locked",
    language: "en",
    kind: "parties",
    sentence: "Quillhaven must keep the unit locked when it is not in use.",
    quote: "The Customer must keep the unit locked when it is not in use.",
    expected: "not stated",
  },
  {
    id: "w3-en-parties-trolley",
    language: "en",
    kind: "parties",
    sentence: "The Customer provides a trolley for moving goods.",
    quote: "Quillhaven provides a trolley for moving goods.",
    expected: "not stated",
  },
  {
    id: "w3-en-condition-deposit",
    language: "en",
    kind: "condition",
    sentence: "Quillhaven returns the deposit within a week after the Customer moves out.",
    quote:
      "Quillhaven returns the deposit within a week after the Customer moves out, if the unit is left clean.",
    expected: "not stated",
  },
  {
    id: "w3-en-condition-sell",
    language: "en",
    kind: "condition",
    sentence: "Quillhaven may sell goods left in the unit after the licence ends.",
    quote:
      "Quillhaven may sell goods left in the unit after the licence ends, but only once it has written to the Customer twice.",
    expected: "not stated",
  },
  {
    id: "w3-en-lead-in-deliveries",
    language: "en",
    kind: "qualified",
    sentence: "Every customer may receive deliveries at the reception desk.",
    quote: "The Customer may receive deliveries at the reception desk.",
    expected: "not stated",
  },
  {
    id: "w3-en-override-food",
    language: "en",
    kind: "qualified",
    sentence: "The Customer must not store any food at all in the unit.",
    quote: "The Customer must not store food in the unit.",
    expected: "not stated",
  },
];

const ZH: readonly Third[] = [
  {
    id: "w3-zh-copy-locked",
    language: "zh-CN",
    kind: "copy",
    sentence: "客户在不使用储物单元时必须将其锁好。",
    quote: "客户在不使用储物单元时必须将其锁好。",
    expected: "stated",
  },
  {
    id: "w3-zh-paraphrase-emergency",
    language: "zh-CN",
    kind: "paraphrase",
    sentence: "遇到紧急情况时，澄枫有权打开储物单元。",
    quote: "澄枫可以在紧急情况下打开储物单元。",
    expected: "stated",
  },
  {
    id: "w3-zh-paraphrase-notice",
    language: "zh-CN",
    kind: "paraphrase",
    sentence: "客户在搬出之前，需要以书面形式告知澄枫。",
    quote: "客户搬出前必须书面通知澄枫。",
    expected: "stated",
  },
  {
    id: "w3-zh-paraphrase-trolley",
    language: "zh-CN",
    kind: "paraphrase",
    sentence: "搬运物品用的手推车由澄枫提供。",
    quote: "澄枫提供搬运物品用的手推车。",
    expected: "stated",
  },
  {
    id: "w3-zh-copy-fee",
    language: "zh-CN",
    kind: "copy",
    sentence: "客户按月预付许可费。",
    quote: "客户按月预付许可费。",
    expected: "stated",
  },
  {
    id: "w3-zh-force-must-open",
    language: "zh-CN",
    kind: "force",
    sentence: "澄枫在紧急情况下必须打开储物单元。",
    quote: "澄枫可以在紧急情况下打开储物单元。",
    expected: "not stated",
  },
  {
    id: "w3-zh-force-may-notice",
    language: "zh-CN",
    kind: "force",
    sentence: "客户搬出前可以视自己意愿书面通知澄枫。",
    quote: "客户搬出前必须书面通知澄枫。",
    expected: "not stated",
  },
  {
    id: "w3-zh-parties-locked",
    language: "zh-CN",
    kind: "parties",
    sentence: "澄枫在储物单元不使用时必须将其锁好。",
    quote: "客户在不使用储物单元时必须将其锁好。",
    expected: "not stated",
  },
  {
    id: "w3-zh-parties-trolley",
    language: "zh-CN",
    kind: "parties",
    sentence: "客户提供搬运物品用的手推车。",
    quote: "澄枫提供搬运物品用的手推车。",
    expected: "not stated",
  },
  {
    id: "w3-zh-condition-deposit",
    language: "zh-CN",
    kind: "condition",
    sentence: "澄枫在客户搬出后一周内退还押金。",
    quote: "如客户搬出时储物单元保持清洁，澄枫在客户搬出后一周内退还押金。",
    expected: "not stated",
  },
  {
    id: "w3-zh-condition-sell",
    language: "zh-CN",
    kind: "condition",
    sentence: "许可结束后，澄枫可以出售留在储物单元内的物品。",
    quote: "许可结束后，澄枫可以出售留在储物单元内的物品，但须先两次书面通知客户。",
    expected: "not stated",
  },
  {
    id: "w3-zh-lead-in-deliveries",
    language: "zh-CN",
    kind: "qualified",
    sentence: "所有客户都可以在前台接收快递。",
    quote: "客户可以在前台接收快递。",
    expected: "not stated",
  },
  {
    id: "w3-zh-override-food",
    language: "zh-CN",
    kind: "qualified",
    sentence: "客户不得在储物单元内存放任何食品。",
    quote: "客户不得在储物单元内存放食品。",
    expected: "not stated",
  },
];

export const THIRD_ITEMS: readonly WrittenItem[] = [...EN, ...ZH].map((each) => ({
  ...each,
  library: "terms",
}));
