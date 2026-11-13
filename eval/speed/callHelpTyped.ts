/**
 * The typed question's slice of call-help cases (#2925): written and committed on 2026-11-13,
 * before any run on it and before the first run of `gates/call-help-typed-question.md`. Seven
 * English cases, each with a Chinese twin of the same call, Documents and answer, about a
 * commercial laundry's offer to a hotel group. In each, a button is pressed first, as in a call,
 * and once its reply ends the User types a question in the panel's field: the question's reply is
 * the one measured. A fact from a Document, a line said earlier, a limit the terms set, a fact no
 * Document holds, a list asked for and what to say. Every case has Documents of its own, which no
 * other case reads, and its own Meeting and Note; no Document, line or question is in a set before
 * it or in a prompt's examples. Short calls only. Every name, figure and Document is made up.
 */
import { type CallDocument, type CallHelpCase, line, said } from "./callHelpCases";

const doc = (file: string, title: string, lines: readonly string[]): CallDocument => ({
  file,
  text: [`# ${title}`, "", ...lines.map((each) => `- ${each}`)].join("\n"),
});

const PRICES_EN = doc("Laundry prices.md", "Laundry prices", [
  "Bed linen is laundered at €1.20 per kilo.",
  "Towels are laundered at €1.50 per kilo.",
  "Table linen is laundered at €2.10 per kilo.",
]);
const ROUNDS_EN = doc("Collection rounds.md", "Collection rounds", [
  "Collection and delivery are included three times a week.",
  "A fourth weekly collection costs €45 each time.",
]);
const DISCOUNTS_EN = doc("Discount rules.md", "Discount rules", [
  "Discounts above 8% need the regional manager's approval.",
  "Volumes over 2,000 kilos a month get 5% off.",
]);
const CARE_EN = doc("Care promise.md", "Care promise", [
  "Stained items are rewashed at no charge.",
  "Lost items are refunded at their replacement cost.",
]);
const RATES_EN = doc("Rate card.md", "Rate card", [
  "Bed linen: €1.20 per kilo.",
  "Towels: €1.50 per kilo.",
  "Table linen: €2.10 per kilo.",
]);
const WATER_EN = doc("Water and detergents.md", "Water and detergents", [
  "Our plant reuses 60% of its rinse water.",
  "Detergents are eco-certified and free of phosphates.",
]);
const CONTRACT_EN = doc("Contract basics.md", "Contract basics", [
  "Contracts run for 24 months.",
  "Prices are fixed for the first 12 months.",
]);

const PRICES_ZH = doc("洗涤价格.md", "洗涤价格", [
  "床品洗涤每公斤 9 元。",
  "毛巾洗涤每公斤 11 元。",
  "台布洗涤每公斤 15 元。",
]);
const ROUNDS_ZH = doc("收送安排.md", "收送安排", [
  "每周三次上门收送，费用已含在价格里。",
  "每周第四次收送每次加收 300 元。",
]);
const DISCOUNTS_ZH = doc("折扣规则.md", "折扣规则", [
  "折扣超过 8% 需要区域经理批准。",
  "每月洗涤量超过 2,000 公斤可享 5% 优惠。",
]);
const CARE_ZH = doc("品质承诺.md", "品质承诺", [
  "有污渍的织物免费重洗。",
  "丢失的织物按重置价赔偿。",
]);
const RATES_ZH = doc("价目表.md", "价目表", [
  "床品：每公斤 9 元。",
  "毛巾：每公斤 11 元。",
  "台布：每公斤 15 元。",
]);
const WATER_ZH = doc("用水和洗涤剂.md", "用水和洗涤剂", [
  "我们工厂 60% 的漂洗水循环再用。",
  "洗涤剂有环保认证，不含磷。",
]);
const CONTRACT_ZH = doc("合同要点.md", "合同要点", ["合同期为 24 个月。", "前 12 个月价格不变。"]);

const START_EN = "We need you to start before the first of March, when our current contract ends.";
const START_ZH = "我们需要你们在 3 月 1 日前开始，那天现在的合同就到期了。";

const ENGLISH: readonly CallHelpCase[] = [
  {
    id: "en-typed-price",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We price by weight, so you only pay for what goes through the plant." },
      { who: "them", text: "And what do you charge for towels?" },
    ],
    documents: [PRICES_EN],
    answer: "Towels are €1.50 per kilo.",
    rests: [[line(PRICES_EN, "Towels")]],
    avoid: "another item's price given as the towels', or a price per piece",
    typed: { question: "How much are towels per kilo?", form: "short" },
  },
  {
    id: "en-typed-included",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "We have four hotels in the city, so pickups matter a lot to us." },
      { who: "them", text: "Is collecting the laundry part of the price, or extra?" },
    ],
    documents: [ROUNDS_EN],
    answer:
      "Collection and delivery are included three times a week; a fourth weekly collection costs €45 each time.",
    rests: [[line(ROUNDS_EN, "three times a week")]],
    avoid: "saying every collection is free, or that collection costs extra in general",
    typed: { question: "Is collection included, and how often?", form: "short" },
  },
  {
    id: "en-typed-said",
    language: "en",
    kind: "want",
    needs: "earlier",
    before: [
      { who: "them", text: START_EN },
      { who: "me", text: "That works with our usual set-up time, so let's keep that in mind." },
    ],
    long: false,
    turns: [
      { who: "them", text: "Our housekeeping managers also want one person to call." },
      { who: "me", text: "You'd have an account manager, and a direct line to the plant." },
      { who: "them", text: "Good. And the invoices should go to our head office." },
    ],
    documents: [CONTRACT_EN],
    answer: "Before the first of March, when their current contract ends.",
    rests: [[said(START_EN)]],
    avoid: "a date the call doesn't give, or the contract's length given as their deadline",
    typed: { question: "When did they say we need to start?", form: "short" },
  },
  {
    id: "en-typed-discount",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "For four hotels, that's a good volume for us." },
      { who: "them", text: "We'd need twelve percent off to switch from our current laundry." },
    ],
    documents: [DISCOUNTS_EN],
    answer:
      "Up to 8% without approval: anything above 8% needs the regional manager's approval, so 12% does.",
    rests: [[line(DISCOUNTS_EN, "above 8%")]],
    avoid: "agreeing to 12%, or saying 12% needs no approval",
    typed: { question: "What's the most I can discount without approval?", form: "short" },
  },
  {
    id: "en-typed-unknown",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Everything is tagged by hotel, so nothing gets mixed up." },
      { who: "them", text: "Are our sheets insured while they're in your vans?" },
    ],
    documents: [CARE_EN],
    answer:
      "It doesn't know: no Document says whether linen is insured in transit (it may add that lost items are refunded at their replacement cost).",
    rests: [],
    avoid:
      "saying the linen is, or isn't, insured in transit, or naming an insurer, a sum or a policy",
    typed: { question: "Do we have insurance for linen in transit?", form: "short" },
  },
  {
    id: "en-typed-list",
    language: "en",
    kind: "sum",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We'll put everything in writing after the call." },
      { who: "them", text: "Can you send the full price list, every item?" },
    ],
    documents: [RATES_EN],
    answer: "Bed linen €1.20, towels €1.50 and table linen €2.10, each per kilo.",
    rests: [
      [line(RATES_EN, "Bed linen")],
      [line(RATES_EN, "Towels")],
      [line(RATES_EN, "Table linen")],
    ],
    avoid: "a price the card doesn't give, or an item left out",
    typed: { question: "List every price per kilo, item by item.", form: "list" },
  },
  {
    id: "en-typed-say",
    language: "en",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We'd love to show your owners the plant." },
      {
        who: "them",
        text: "Our owners worry about how much water an industrial laundry uses.",
      },
    ],
    documents: [WATER_EN],
    answer:
      "One or two options to say, the recommended first: the plant reuses 60% of its rinse water (and its detergents are eco-certified and phosphate-free).",
    rests: [[line(WATER_EN, "60%")]],
    avoid: "a figure the Document doesn't give, such as litres saved",
    typed: { question: "How should I answer their worry about water use?", form: "options" },
  },
];

const CHINESE: readonly CallHelpCase[] = [
  {
    id: "zh-typed-price",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "我们按重量计价，洗多少付多少。" },
      { who: "them", text: "那毛巾怎么收费？" },
    ],
    documents: [PRICES_ZH],
    answer: "毛巾每公斤 11 元。",
    rests: [[line(PRICES_ZH, "毛巾")]],
    avoid: "把别的织物的价格说成毛巾的，或按件报价",
    typed: { question: "毛巾每公斤多少钱？", form: "short" },
  },
  {
    id: "zh-typed-included",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "我们在市里有四家酒店，所以收送对我们很重要。" },
      { who: "them", text: "上门收布草算在价格里，还是另外收费？" },
    ],
    documents: [ROUNDS_ZH],
    answer: "每周三次上门收送已含在价格里；每周第四次收送每次加收 300 元。",
    rests: [[line(ROUNDS_ZH, "每周三次")]],
    avoid: "说每次收送都免费，或说收送一律另外收费",
    typed: { question: "收送包含在价格里吗？每周几次？", form: "short" },
  },
  {
    id: "zh-typed-said",
    language: "zh-CN",
    kind: "want",
    needs: "earlier",
    before: [
      { who: "them", text: START_ZH },
      { who: "me", text: "这跟我们平常的准备时间对得上，我们记一下。" },
    ],
    long: false,
    turns: [
      { who: "them", text: "我们的客房经理还希望只对接一个人。" },
      { who: "me", text: "会有一位客户经理，还有直通工厂的电话。" },
      { who: "them", text: "好的。发票要寄到我们总部。" },
    ],
    documents: [CONTRACT_ZH],
    answer: "3 月 1 日前开始，那天他们现在的合同到期。",
    rests: [[said(START_ZH)]],
    avoid: "通话里没说过的日期，或把合同期说成他们的期限",
    typed: { question: "他们说我们最晚什么时候要开始？", form: "short" },
  },
  {
    id: "zh-typed-discount",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "四家酒店的量，对我们来说很不错。" },
      { who: "them", text: "要换掉现在的洗衣厂，我们需要打八八折，也就是便宜 12%。" },
    ],
    documents: [DISCOUNTS_ZH],
    answer: "不经批准最多 8%：超过 8% 需要区域经理批准，所以 12% 需要批准。",
    rests: [[line(DISCOUNTS_ZH, "超过 8%")]],
    avoid: "答应 12%，或说 12% 不需要批准",
    typed: { question: "不需要批准的话，我最多能给多少折扣？", form: "short" },
  },
  {
    id: "zh-typed-unknown",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "每件都按酒店贴了标签，不会混。" },
      { who: "them", text: "布草在你们车上的时候有保险吗？" },
    ],
    documents: [CARE_ZH],
    answer: "不知道：没有文档说运输途中是否有保险（可以补充丢失的织物按重置价赔偿）。",
    rests: [],
    avoid: "说运输途中有或没有保险，或说出保险公司、金额或保单",
    typed: { question: "布草运输途中有保险吗？", form: "short" },
  },
  {
    id: "zh-typed-list",
    language: "zh-CN",
    kind: "sum",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "通话后我们会把所有内容发书面材料给你们。" },
      { who: "them", text: "能把完整的价目表发给我们吗？每一项都要。" },
    ],
    documents: [RATES_ZH],
    answer: "床品每公斤 9 元，毛巾每公斤 11 元，台布每公斤 15 元。",
    rests: [[line(RATES_ZH, "床品")], [line(RATES_ZH, "毛巾")], [line(RATES_ZH, "台布")]],
    avoid: "价目表没有的价格，或漏掉一项",
    typed: { question: "把每一项的每公斤价格都列出来。", form: "list" },
  },
  {
    id: "zh-typed-say",
    language: "zh-CN",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "很欢迎你们的业主来参观工厂。" },
      { who: "them", text: "我们业主担心工业洗衣厂用水太多。" },
    ],
    documents: [WATER_ZH],
    answer:
      "一两个可以说的选项，推荐的在前：工厂 60% 的漂洗水循环再用（洗涤剂有环保认证、不含磷）。",
    rests: [[line(WATER_ZH, "60%")]],
    avoid: "文档没有的数字，比如节省了多少升水",
    typed: { question: "他们担心用水，我该怎么回答？", form: "options" },
  },
];

export const CALL_HELP_TYPED: readonly CallHelpCase[] = [...ENGLISH, ...CHINESE];
