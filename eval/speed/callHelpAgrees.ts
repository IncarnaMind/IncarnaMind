/**
 * A fresh call-help slice (#2526): written and committed on 2026-11-08, before any run on it and
 * before the code it gates, after the marks-passages gate's fourth look, whose replies said "the
 * payroll export document agrees" with only the call's line marked
 * (`gates/call-help-marks-passages.md`). Four of each language's twelve presses check what was said
 * against a Document that agrees, one against a Document that disagrees, and one against a Document
 * that agrees with one claim and not the other; the answers have figures one step from the right
 * one, and one press in each language is answered from a Document in the other. A hotel laundry
 * service selling to a hotel group; every name, figure and Document is made up, and no Document or
 * press is in a set before it.
 */
import { type CallHelpCase, line } from "./callHelpCases";

const PLANS_EN = {
  file: "Linen service plans.md",
  text: [
    "# Linen service plans",
    "",
    "Every plan includes collection from your loading bay, washing, pressing and delivery in sealed trolleys. Plans differ in the price per kilogram, how fast the linen comes back and whether weekend collections are included.",
    "",
    "| Plan | Price per kg | Back within | Weekend collection |",
    "|---|---|---|---|",
    "| Standard | $2.40 | 48 hours | $25 each |",
    "| Express | $3.10 | 24 hours | included |",
    "| Premium | $3.60 | 12 hours | included |",
    "",
    "Express and Premium include stain treatment; on Standard, stain treatment costs $0.30 an item.",
    "",
    "From 2,000 kg a month, Express drops to $2.80 per kg and Premium to $3.20. Prices are fixed for the first 12 months; after that, the yearly increase is capped at 5%.",
  ].join("\n"),
};
const PICKUP_EN = {
  file: "Collection and delivery.md",
  text: [
    "# Collection and delivery",
    "",
    "We collect from each hotel on fixed days agreed at onboarding, between 6:00 and 10:00. Clean linen comes back on the same route the next time we call, in sealed trolleys we take back empty.",
    "",
    "A hotel can ask for an extra collection with 24 hours' notice; each extra collection costs $40, or $60 when it is asked for on the day.",
    "",
    "If a delivery is more than 2 hours late, that delivery's service fee is waived. Drivers carry a handheld scanner, and every trolley is weighed at collection and again at delivery.",
  ].join("\n"),
};
const LOSS_EN = {
  file: "Damage and loss.md",
  text: [
    "# Damage and loss",
    "",
    "Every item carries a washable chip, so each sheet and towel is counted out and counted back in.",
    "",
    "An item we lose or damage is replaced at the price on the hotel's linen list, up to $45 an item, and credited on the next invoice. Claims must be made within 7 days of the delivery.",
    "",
    "Stains we could not remove are listed on the delivery note, and those items are not charged for. Wear and tear after 150 washes is not covered.",
  ].join("\n"),
};
const BILLING_EN = {
  file: "Billing terms.md",
  text: [
    "# Billing terms",
    "",
    "Invoices are sent on the first working day of each month and are due within 30 days. Paying by direct debit takes 2% off each invoice.",
    "",
    "The contract runs for at least 12 months; after that, either side can end it with 90 days' written notice. A hotel added during the contract pays its first month pro rata.",
  ].join("\n"),
};

const PLANS_ZH = {
  file: "布草洗涤方案.md",
  text: [
    "# 布草洗涤方案",
    "",
    "所有方案都包含从卸货区收取、洗涤、熨烫，以及用密封推车送回。各方案的区别在于每公斤价格、送回速度，以及是否含周末收货。",
    "",
    "| 方案 | 每公斤 | 送回时间 | 周末收货 |",
    "|---|---|---|---|",
    "| 标准版 | 16 元 | 48 小时内 | 每次 160 元 |",
    "| 快速版 | 21 元 | 24 小时内 | 已含 |",
    "| 高级版 | 25 元 | 12 小时内 | 已含 |",
    "",
    "快速版和高级版含去渍处理；标准版去渍每件另收 2 元。",
    "",
    "每月 2,000 公斤起，快速版降到每公斤 19 元，高级版降到 22 元。前 12 个月价格不变，之后每年涨幅不超过 5%。",
  ].join("\n"),
};
const PICKUP_ZH = {
  file: "收货与送货.md",
  text: [
    "# 收货与送货",
    "",
    "每家酒店按入驻时约定的固定日子收货，时间在 6:00 到 10:00 之间。洗好的布草在下次上门时按同一路线送回，装在密封推车里，空车我们带走。",
    "",
    "酒店可以要求加收一次，需提前 24 小时预约，每次 260 元；当天预约每次 390 元。",
    "",
    "送货晚到超过 2 小时，那次送货的服务费免收。司机随车带手持扫码枪，每个推车收货和送货时都过秤。",
  ].join("\n"),
};
const LOSS_ZH = {
  file: "损坏与丢失.md",
  text: [
    "# 损坏与丢失",
    "",
    "每件布草都缝有可水洗芯片，送出和收回时逐件清点。",
    "",
    "我们丢失或损坏的物品，按酒店布草清单上的价格赔偿，每件最多 300 元，在下一张账单中抵扣。索赔须在送货后 7 天内提出。",
    "",
    "洗不掉的污渍会写在送货单上，这些物品不收费。洗满 150 次后的正常磨损不在赔付范围内。",
  ].join("\n"),
};
const BILLING_ZH = {
  file: "账单条款.md",
  text: [
    "# 账单条款",
    "",
    "账单在每月第一个工作日寄出，30 天内付清。用自动扣款付款，每张账单减 2%。",
    "",
    "合同至少 12 个月；之后任何一方提前 90 天书面通知即可终止。合同期间新增的酒店，首月按天折算。",
  ].join("\n"),
};

export const CALL_HELP_AGREES: readonly CallHelpCase[] = [
  {
    id: "en6-answer-express",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Most hotels your size go with Express." },
      {
        who: "them",
        text: "What does Express cost per kilo, and how quickly do we get the linen back?",
      },
    ],
    documents: [PLANS_EN, PICKUP_EN],
    answer: "$3.10 per kg, with the linen back within 24 hours.",
    rests: [[line(PLANS_EN, "| Express")]],
    avoid: "Standard's or Premium's price or turnaround as Express's",
  },
  {
    id: "en6-answer-volume",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "We send about 2,500 kilos a month across the group. What would Premium cost per kilo at that volume?",
      },
    ],
    documents: [PLANS_EN, BILLING_EN],
    answer: "$3.20 per kg: from 2,000 kg a month, Premium drops from $3.60 to $3.20.",
    rests: [[line(PLANS_EN, "From 2,000 kg")]],
    avoid: "$3.60 as the price at 2,500 kg a month",
  },
  {
    id: "en6-answer-extra",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "We have a wedding on Saturday." },
      {
        who: "them",
        text: "If we book an extra collection a day ahead, can you do it, and what does it cost?",
      },
    ],
    documents: [PICKUP_EN],
    answer: "Yes: with 24 hours' notice an extra collection costs $40; asked for on the day, $60.",
    rests: [[line(PICKUP_EN, "A hotel can ask")]],
    avoid: "$60 as the price of a collection booked a day ahead",
  },
  {
    id: "en6-check-late",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "me",
        text: "If a delivery is more than two hours late, we waive that delivery's service fee.",
      },
      { who: "them", text: "Good, our housekeeping manager will like that." },
    ],
    documents: [PICKUP_EN, LOSS_EN],
    answer: "Supported: a delivery more than 2 hours late has its service fee waived.",
    rests: [[line(PICKUP_EN, "If a delivery is more")]],
    avoid: "that any part is contradicted",
  },
  {
    id: "en6-check-loss",
    language: "en",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "me",
        text: "Anything we lose or damage is replaced at your linen list price, up to forty-five dollars an item, and credited on the next invoice.",
      },
      { who: "them", text: "That sounds fair." },
    ],
    documents: [LOSS_EN, BILLING_EN],
    answer:
      "Supported: a lost or damaged item is replaced at the linen-list price, up to $45 an item, credited on the next invoice.",
    rests: [[line(LOSS_EN, "An item we lose")]],
    avoid: "that any part is contradicted",
  },
  {
    id: "en6-check-notice",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "Our lawyer read it as: after the first twelve months, either of us can end it with ninety days' written notice.",
      },
      { who: "me", text: "That's how I read it too." },
    ],
    documents: [BILLING_EN, PLANS_EN],
    answer:
      "Supported: the contract runs at least 12 months, then either side can end it with 90 days' written notice.",
    rests: [[line(BILLING_EN, "The contract runs")]],
    avoid: "that any part is contradicted",
  },
  {
    id: "en6-check-stains",
    language: "en",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      { who: "me", text: "Stain treatment is included on Express and Premium." },
      { who: "them", text: "Good, the restaurant napkins are the worst." },
    ],
    documents: [PLANS_EN, LOSS_EN],
    answer: "Supported: Express and Premium include stain treatment.",
    rests: [[line(PLANS_EN, "Express and Premium include")]],
    avoid: "that any part is contradicted, or that Standard includes it",
  },
  {
    id: "en6-check-wrong",
    language: "en",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "So invoices are due within sixty days, and paying by direct debit takes five percent off, right?",
      },
    ],
    documents: [BILLING_EN],
    answer:
      "Both are contradicted: invoices are due within 30 days, and direct debit takes 2% off.",
    rests: [[line(BILLING_EN, "Invoices are sent")]],
    avoid: "that either claim is supported",
  },
  {
    id: "en6-check-partly",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "me",
        text: "Every item carries a chip, and we cover wear and tear up to two hundred washes.",
      },
      { who: "them", text: "Okay, noted." },
    ],
    documents: [LOSS_EN],
    answer:
      "Partly: every item carries a washable chip, but wear and tear after 150 washes is not covered, so two hundred washes is contradicted.",
    rests: [[line(LOSS_EN, "Every item carries")], [line(LOSS_EN, "Wear and tear")]],
    avoid: "that wear and tear up to 200 washes is covered",
  },
  {
    id: "en6-no-weekend",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Standard is the simplest place to start." },
      { who: "them", text: "Could you throw in weekend collections on Standard for free?" },
    ],
    documents: [PLANS_EN],
    answer:
      "Declines: weekend collections are included on Express and Premium; on Standard each one costs $25.",
    rests: [[line(PLANS_EN, "| Standard")]],
    avoid: "weekend collections on Standard for free",
  },
  {
    id: "en6-say-towels",
    language: "en",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "Our last laundry kept losing towels, and we never got anything back for them.",
      },
    ],
    documents: [LOSS_EN, PICKUP_EN],
    answer:
      "Reassures with what the Documents say: every item is chipped and counted out and back in, and a lost item is replaced at the linen-list price, up to $45, credited on the next invoice.",
    rests: [[line(LOSS_EN, "An item we lose"), line(LOSS_EN, "Every item carries")]],
    avoid: "a promise the Documents don't make, such as replacing every item at full price",
  },
  {
    id: "en6-answer-invoice-zh",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Our billing terms are written in Chinese; I'll read them for you." },
      {
        who: "them",
        text: "When are your invoices due, and is there anything off for direct debit?",
      },
    ],
    documents: [BILLING_ZH],
    answer: "Within 30 days of the monthly invoice; direct debit takes 2% off each invoice.",
    rests: [[line(BILLING_ZH, "账单在每月")]],
  },

  {
    id: "zh6-answer-premium",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "做婚宴多的酒店一般选高级版。" },
      { who: "them", text: "高级版每公斤多少钱？多久能送回来？" },
    ],
    documents: [PLANS_ZH, PICKUP_ZH],
    answer: "每公斤 25 元，12 小时内送回。",
    rests: [[line(PLANS_ZH, "| 高级版")]],
    avoid: "把标准版或快速版的价格或送回时间说成高级版的",
  },
  {
    id: "zh6-answer-volume",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "我们集团每月大概 2,500 公斤，快速版按这个量每公斤多少钱？" }],
    documents: [PLANS_ZH, BILLING_ZH],
    answer: "每公斤 19 元：每月 2,000 公斤起，快速版从 21 元降到 19 元。",
    rests: [[line(PLANS_ZH, "每月 2,000 公斤起")]],
    avoid: "按 21 元报每月 2,500 公斤的价格",
  },
  {
    id: "zh6-answer-late",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "要是你们送货晚了，我们这边怎么算？" }],
    documents: [PICKUP_ZH, LOSS_ZH],
    answer: "晚到超过 2 小时，那次送货的服务费免收。",
    rests: [[line(PICKUP_ZH, "送货晚到")]],
    avoid: "2 小时以外的时限，或文档里没有的赔偿",
  },
  {
    id: "zh6-check-extra",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "临时加收一次要提前 24 小时约，每次 260 元。" },
      { who: "them", text: "嗯，这个价可以接受。" },
    ],
    documents: [PICKUP_ZH, PLANS_ZH],
    answer: "有依据：提前 24 小时预约加收一次，每次 260 元（当天预约 390 元）。",
    rests: [[line(PICKUP_ZH, "酒店可以要求加收")]],
    avoid: "说其中有不对的地方",
  },
  {
    id: "zh6-check-loss",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "me",
        text: "我们丢的或洗坏的布草，按你们布草清单上的价赔，每件最多三百元，下张账单直接抵扣。",
      },
      { who: "them", text: "这个合理。" },
    ],
    documents: [LOSS_ZH, BILLING_ZH],
    answer: "有依据：丢失或损坏的物品按布草清单价赔偿，每件最多 300 元，在下一张账单中抵扣。",
    rests: [[line(LOSS_ZH, "我们丢失或损坏")]],
    avoid: "说其中有不对的地方",
  },
  {
    id: "zh6-check-notice",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "我们法务的理解是：头十二个月过后，任何一方提前九十天书面通知就能终止。",
      },
      { who: "me", text: "我也是这么理解的。" },
    ],
    documents: [BILLING_ZH, PLANS_ZH],
    answer: "有依据：合同至少 12 个月，之后任何一方提前 90 天书面通知即可终止。",
    rests: [[line(BILLING_ZH, "合同至少")]],
    avoid: "说其中有不对的地方",
  },
  {
    id: "zh6-check-stains",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      { who: "me", text: "快速版和高级版都含去渍处理。" },
      { who: "them", text: "那挺好，餐厅的餐巾最难洗。" },
    ],
    documents: [PLANS_ZH, LOSS_ZH],
    answer: "有依据：快速版和高级版含去渍处理。",
    rests: [[line(PLANS_ZH, "快速版和高级版含去渍")]],
    avoid: "说其中有不对的地方，或说标准版也含",
  },
  {
    id: "zh6-check-wrong",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "账单是六十天内付清，用自动扣款能减百分之五，对吧？" }],
    documents: [BILLING_ZH],
    answer: "两点都不对：账单 30 天内付清，自动扣款每张账单减 2%。",
    rests: [[line(BILLING_ZH, "账单在每月")]],
    avoid: "说任何一条有依据",
  },
  {
    id: "zh6-check-partly",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "每件布草都有芯片，正常磨损我们保到洗两百次。" },
      { who: "them", text: "好，我记一下。" },
    ],
    documents: [LOSS_ZH],
    answer:
      "一半有依据：每件布草都有可水洗芯片；但洗满 150 次后的正常磨损不在赔付范围内，两百次不对。",
    rests: [[line(LOSS_ZH, "每件布草都缝有")], [line(LOSS_ZH, "洗满 150 次")]],
    avoid: "说洗到 200 次的正常磨损都赔",
  },
  {
    id: "zh6-no-weekend",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "标准版最简单，先从它开始。" },
      { who: "them", text: "标准版能不能免费送周末收货？" },
    ],
    documents: [PLANS_ZH],
    answer: "婉拒：快速版和高级版含周末收货，标准版每次另收 160 元。",
    rests: [[line(PLANS_ZH, "| 标准版")]],
    avoid: "答应标准版免费周末收货",
  },
  {
    id: "zh6-say-late",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "上一家洗衣厂老是送晚，客房那边都等着布草用。" }],
    documents: [PICKUP_ZH, LOSS_ZH],
    answer:
      "用文档里的说法安抚：送货晚到超过 2 小时，那次送货的服务费免收；每个推车收送时都扫码过秤。",
    rests: [[line(PICKUP_ZH, "送货晚到")]],
    avoid: "文档里没有的承诺，比如晚到就赔偿房费或保证准时",
  },
  {
    id: "zh6-answer-claim-en",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "赔付条款是英文的，我直接念给你听。" },
      { who: "them", text: "东西丢了要多久之内报？每件最多赔多少？" },
    ],
    documents: [LOSS_EN],
    answer: "送货后 7 天内提出；按布草清单价赔，每件最多 45 美元。",
    rests: [[line(LOSS_EN, "An item we lose")]],
  },
];
