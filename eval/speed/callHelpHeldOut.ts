/**
 * The call-help set's second held-out cases (#2526): written and committed on 2026-11-07, before
 * any run of the path it gates (`gates/call-help-marks-passages.md`), and never shown to a prompt.
 * The same vendor as `callHelpCases.ts`, and the same buttons, needs and rollout talk, but new
 * questions on new Documents: devices, integrations, training, service levels and the contract.
 * Every name, figure and Document is made up.
 */
import { type CallHelpCase, line, said } from "./callHelpCases";

const PRICES_EN = {
  file: "Driver pricing 2026.md",
  text: [
    "# Driver pricing 2026",
    "",
    "- Team plan: $29 per driver a month.",
    "- Enterprise plan: $52 per driver a month, with route optimisation.",
    "- Volume: 10% off Enterprise from 50 drivers.",
    "- Onboarding: $2,500 once.",
  ].join("\n"),
};
const DEVICES_EN = {
  file: "Device rental.md",
  text: [
    "# Device rental",
    "",
    "- Handheld scanners: $9 per device a month.",
    "- Rugged tablets: $18 per device a month.",
    "- Deposit: $50 per device, refunded when the device comes back; deposits are never waived.",
    "- Devices keep scanning offline and sync when the signal returns.",
    "- A faulty device is replaced within two business days.",
  ].join("\n"),
};
const INTEGRATIONS_EN = {
  file: "Integrations.md",
  text: [
    "# Integrations",
    "",
    "- Connectors: Shopify, included in every plan; SAP, Enterprise only, $300 a month.",
    "- The API allows 600 requests a minute.",
    "- Webhooks are included in every plan.",
  ].join("\n"),
};
const TRAINING_EN = {
  file: "Training.md",
  text: [
    "# Training",
    "",
    "- Two live online sessions are included.",
    "- An extra live session costs $250.",
    "- The recorded course is free.",
    "- On-site training costs $1,800 a day, plus travel.",
  ].join("\n"),
};
const SERVICE_2025_EN = {
  file: "Service levels 2025.md",
  text: [
    "# Service levels 2025",
    "",
    "- Urgent tickets: answered within 4 hours, every plan.",
    "- Weekend support: none.",
  ].join("\n"),
};
const SERVICE_2026_EN = {
  file: "Service levels 2026.md",
  text: [
    "# Service levels 2026",
    "",
    "- Urgent tickets: answered within 1 hour on Enterprise, 4 hours on Team.",
    "- Weekend support: Enterprise only, Saturday and Sunday 9:00 to 17:00 CET.",
  ].join("\n"),
};
const CONTRACT_EN = {
  file: "Contract terms.md",
  text: [
    "# Contract terms",
    "",
    "- Minimum term: 12 months.",
    "- Invoices are due within 30 days.",
    "- To stop renewal, give written notice 90 days before the renewal date.",
    "- After the contract ends, we provide a CSV export of your data within 30 days.",
  ].join("\n"),
};
const DISCOUNTS_EN = {
  file: "Discount rules.md",
  text: [
    "# Discount rules",
    "",
    "- Multi-year: 8% off for a two-year term, 12% off for three years.",
    "- Schools and registered charities: 20% off the subscription, not devices.",
  ].join("\n"),
};

const PRICES_ZH = {
  file: "2026年司机版价目表.md",
  text: [
    "# 2026 年司机版价目表",
    "",
    "- 团队版：每名司机每月 190 元。",
    "- 企业版：每名司机每月 340 元，含路线优化。",
    "- 批量优惠：企业版 50 名司机起打九折。",
    "- 开通费：一次性 15,000 元。",
  ].join("\n"),
};
const DEVICES_ZH = {
  file: "设备租赁.md",
  text: [
    "# 设备租赁",
    "",
    "- 手持扫描枪：每台每月 60 元。",
    "- 加固平板：每台每月 120 元。",
    "- 押金：每台 300 元，设备归还时退还；押金一律不减免。",
    "- 设备离线时照常扫描，恢复信号后自动同步。",
    "- 设备故障两个工作日内换新。",
  ].join("\n"),
};
const INTEGRATIONS_ZH = {
  file: "系统对接.md",
  text: [
    "# 系统对接",
    "",
    "- 连接器：有赞，所有版本均含；用友，仅企业版，每月 2,000 元。",
    "- 接口每分钟最多调用 600 次。",
    "- 所有版本均含 Webhook。",
  ].join("\n"),
};
const TRAINING_ZH = {
  file: "培训.md",
  text: [
    "# 培训",
    "",
    "- 含两场线上直播培训。",
    "- 额外一场直播培训 1,500 元。",
    "- 录播课程免费。",
    "- 上门培训每天 12,000 元，差旅另计。",
  ].join("\n"),
};
const SERVICE_2025_ZH = {
  file: "2025年服务等级.md",
  text: ["# 2025 年服务等级", "", "- 紧急工单：所有版本 4 小时内响应。", "- 周末支持：无。"].join(
    "\n",
  ),
};
const SERVICE_2026_ZH = {
  file: "2026年服务等级.md",
  text: [
    "# 2026 年服务等级",
    "",
    "- 紧急工单：企业版 1 小时内响应，团队版 4 小时内响应。",
    "- 周末支持：仅企业版，周六周日 9:00 至 17:00（北京时间）。",
  ].join("\n"),
};
const CONTRACT_ZH = {
  file: "合同条款.md",
  text: [
    "# 合同条款",
    "",
    "- 最短合同期：12 个月。",
    "- 发票须在 30 天内付清。",
    "- 如不续约，须在续约日前 90 天书面通知。",
    "- 合同结束后 30 天内，我们提供数据的 CSV 导出。",
  ].join("\n"),
};
const DISCOUNTS_ZH = {
  file: "折扣规则.md",
  text: [
    "# 折扣规则",
    "",
    "- 多年期：两年期优惠 8%，三年期优惠 12%。",
    "- 学校和注册公益机构：订阅费八折，设备不打折。",
  ].join("\n"),
};

const EN_TRAINING = "If you sign this quarter, I can add one on-site training day at no charge.";
const EN_SIGNAL =
  "What matters most to us is that drivers can keep scanning when the signal drops in the warehouse basement.";
const EN_LEARN = "Our drivers need something they can learn in a single day.";
const EN_PEAK = "And it has to be running before the Christmas peak in November.";
const EN_DEPOT = "Let's run the pilot with twelve drivers at the Leeds depot.";
const EN_OWNER = "Priya will run the pilot on our side.";
const EN_FORM = "And we'll send the device order form by Wednesday.";
const EN_INVOICES = "Invoices are due within thirty days.";

const ZH_TRAINING = "如果这个季度签约，我可以免费加一天上门培训。";
const ZH_SIGNAL = "我们最在意的是仓库地下室信号断了，司机还能不能继续扫码。";
const ZH_LEARN = "我们的司机需要一天就能学会的系统。";
const ZH_PEAK = "而且必须在十一月的双十一高峰之前上线。";
const ZH_DEPOT = "试点就用成都仓的十二名司机。";
const ZH_OWNER = "我们这边由王蕾负责试点。";
const ZH_FORM = "好的，设备订购单我们周三前发过去。";
const ZH_INVOICES = "发票是三十天内付清。";

export const CALL_HELP_HELD_OUT: readonly CallHelpCase[] = [
  {
    id: "en2-answer-tablets",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Thanks for joining. I hear you had a look at the pricing." },
      { who: "them", text: "We did. The software side looks fine." },
      { who: "me", text: "Great. Anything on the hardware?" },
      { who: "them", text: "Our drivers break phones all the time." },
      {
        who: "them",
        text: "Can we rent rugged tablets from you, and what do they cost each month?",
      },
    ],
    documents: [DEVICES_EN, PRICES_EN],
    answer:
      "Yes: rugged tablets are $18 per device a month (with a $50 deposit per device, refunded when it comes back).",
    rests: [[line(DEVICES_EN, "Rugged tablets")]],
  },
  {
    id: "en2-answer-total",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "Okay, that's the rollout sorted. Let's talk money." },
      {
        who: "them",
        text: "With sixty drivers on Enterprise, what would we pay each month after the volume discount?",
      },
    ],
    documents: [PRICES_EN],
    answer:
      "$2,808 a month: 60 drivers at $52 is $3,120, less the 10% volume discount that starts at 50 drivers.",
    rests: [[line(PRICES_EN, "Enterprise plan")], [line(PRICES_EN, "Volume")]],
  },
  {
    id: "en2-answer-edition",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Support is the other thing people usually ask about." },
      {
        who: "them",
        text: "Right. How quickly do you answer an urgent ticket on Enterprise these days?",
      },
    ],
    documents: [SERVICE_2025_EN, SERVICE_2026_EN],
    answer: "Within 1 hour on Enterprise, as the 2026 service levels say.",
    rests: [[line(SERVICE_2026_EN, "Urgent tickets")]],
    avoid: "4 hours as Enterprise's time to answer an urgent ticket (the 2025 sheet's, or Team's)",
  },
  {
    id: "en2-answer-unknown",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "Our IT team had one more question." },
      {
        who: "them",
        text: "Do you have a connector for Oracle NetSuite? That's our finance system.",
      },
    ],
    documents: [INTEGRATIONS_EN],
    answer:
      "The integrations list names connectors for Shopify and SAP and an API; it says nothing of NetSuite, so the reply doesn't promise a NetSuite connector (it may point to the API).",
    rests: [[line(INTEGRATIONS_EN, "Connectors"), line(INTEGRATIONS_EN, "The API")]],
    avoid: "that a NetSuite connector exists or is included",
  },
  {
    id: "en2-answer-earlier",
    language: "en",
    kind: "answer",
    needs: "earlier",
    before: [
      { who: "me", text: "Before we start, one thing on training." },
      { who: "me", text: EN_TRAINING },
      { who: "them", text: "An on-site day, good to know. Let's park it for now." },
    ],
    long: true,
    turns: [
      {
        who: "them",
        text: "Going back to what you offered on training at the start, what was it exactly, and what was the condition?",
      },
    ],
    documents: [TRAINING_EN],
    answer:
      "One on-site training day at no charge, if they sign this quarter: what the User offered at the start of the call.",
    rests: [[said(EN_TRAINING)]],
    avoid: "a charge of $1,800 for the day the User offered at no charge",
  },
  {
    id: "en2-answer-two",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Anything else before we send the contract over?" },
      {
        who: "them",
        text: "Two things from legal: what's the minimum term, and how do we get our data back if we leave?",
      },
    ],
    documents: [CONTRACT_EN],
    answer:
      "A 12-month minimum term; after the contract ends, they get a CSV export of their data within 30 days.",
    rests: [[line(CONTRACT_EN, "Minimum term")], [line(CONTRACT_EN, "CSV export")]],
  },
  {
    id: "en2-say-competitor",
    language: "en",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "Another vendor told us their SAP connector comes free with every plan.",
      },
    ],
    documents: [INTEGRATIONS_EN],
    answer:
      "An option that is straight about the SAP connector, on Enterprise at $300 a month, and may point to what every plan includes (the Shopify connector, webhooks).",
    rests: [[line(INTEGRATIONS_EN, "Connectors")]],
    avoid: "that the SAP connector is free or included in every plan",
  },
  {
    id: "en2-say-offline",
    language: "en",
    kind: "say",
    needs: "earlier",
    before: [
      { who: "them", text: EN_SIGNAL },
      { who: "me", text: "Understood, I'll come back to that properly." },
    ],
    long: true,
    turns: [{ who: "them", text: "So why should we trust this will hold up for us?" }],
    documents: [DEVICES_EN],
    answer:
      "An option that speaks to their worry about scanning without signal: the devices keep scanning offline and sync when the signal returns.",
    rests: [[line(DEVICES_EN, "keep scanning offline")]],
  },
  {
    id: "en2-want",
    language: "en",
    kind: "want",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "Let me tell you what went wrong last time." },
      { who: "them", text: EN_LEARN },
      { who: "them", text: EN_PEAK },
    ],
    documents: [TRAINING_EN],
    answer:
      "They want a tool their drivers can learn in a day, running before the Christmas peak in November.",
    rests: [[said(EN_LEARN), said(EN_PEAK)]],
  },
  {
    id: "en2-sum",
    language: "en",
    kind: "sum",
    needs: "whole",
    before: [
      { who: "them", text: EN_DEPOT },
      { who: "me", text: "Twelve drivers in Leeds works for us." },
    ],
    long: true,
    turns: [
      { who: "them", text: EN_OWNER },
      { who: "me", text: EN_FORM },
    ],
    documents: [DEVICES_EN],
    answer:
      "The pilot runs with 12 drivers at the Leeds depot; Priya runs it on their side; the User sends the device order form by Wednesday.",
    rests: [[said(EN_DEPOT)], [said(EN_OWNER), said(EN_FORM)]],
  },
  {
    id: "en2-no-deposit",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "The devices ship the week after you sign." },
      { who: "them", text: "We're renting forty scanners. Could you drop the deposit for us?" },
    ],
    documents: [DEVICES_EN],
    answer:
      "Declines dropping the deposit, saying it is $50 per device and refunded when the device comes back.",
    rests: [[line(DEVICES_EN, "Deposit")]],
    avoid: "waiving or dropping the deposit",
  },
  {
    id: "en2-ask-store",
    language: "en",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "That covers dispatch and the drivers' app." },
      {
        who: "them",
        text: "We also sell online, so we'd want orders to flow in from our web shop.",
      },
    ],
    documents: [INTEGRATIONS_EN],
    answer:
      "A question asking which platform their web shop runs on, since the Shopify connector is included in every plan.",
    rests: [[line(INTEGRATIONS_EN, "Connectors")]],
  },
  {
    id: "en2-check-wrong",
    language: "en",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "So urgent tickets get answered within fifteen minutes, and there's weekend support on every plan, right?",
      },
    ],
    documents: [SERVICE_2026_EN],
    answer:
      "Both claims are contradicted: urgent tickets are answered within 1 hour on Enterprise and 4 hours on Team, and weekend support is Enterprise only, Saturday and Sunday 9:00 to 17:00 CET.",
    rests: [[line(SERVICE_2026_EN, "Urgent tickets")], [line(SERVICE_2026_EN, "Weekend support")]],
    avoid: "that either claim is supported",
  },
  {
    id: "en2-check-right",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "Our finance team asked about payment terms." },
      { who: "me", text: EN_INVOICES },
      { who: "them", text: "Good, that's what they assumed." },
    ],
    documents: [CONTRACT_EN],
    answer: "Supported: invoices are due within 30 days, as the contract terms say.",
    rests: [[line(CONTRACT_EN, "Invoices")]],
  },
  {
    id: "en2-no-price",
    language: "en",
    kind: "no",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "Could you do Enterprise at forty dollars a driver?" }],
    documents: [PRICES_EN, DISCOUNTS_EN],
    answer:
      "Declines $40 politely, keeps Enterprise at $52, and offers a real lever (10% off from 50 drivers, or 8% off a two-year term).",
    rests: [
      [
        line(PRICES_EN, "Enterprise plan"),
        line(PRICES_EN, "Volume"),
        line(DISCOUNTS_EN, "Multi-year"),
      ],
    ],
    avoid: "agreeing to $40 a driver",
  },

  {
    id: "zh2-answer-tablets",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "感谢抽时间。听说你们看过报价了。" },
      { who: "them", text: "看过了，软件这块没问题。" },
      { who: "me", text: "好的，硬件方面呢？" },
      { who: "them", text: "我们的司机老是摔坏手机。" },
      { who: "them", text: "你们能租加固平板吗？每个月多少钱？" },
    ],
    documents: [DEVICES_ZH, PRICES_ZH],
    answer: "可以：加固平板每台每月 120 元（每台押金 300 元，设备归还时退还）。",
    rests: [[line(DEVICES_ZH, "加固平板")]],
  },
  {
    id: "zh2-answer-total",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "好，上线安排清楚了，我们聊聊价格。" },
      { who: "them", text: "企业版六十名司机，扣掉批量优惠，每个月要付多少？" },
    ],
    documents: [PRICES_ZH],
    answer: "每月 18,360 元：60 名司机每人 340 元共 20,400 元，50 名司机起打九折。",
    rests: [[line(PRICES_ZH, "企业版")], [line(PRICES_ZH, "批量优惠")]],
  },
  {
    id: "zh2-answer-edition",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "大家通常还会问售后支持。" },
      { who: "them", text: "对，企业版现在紧急工单多久响应？" },
    ],
    documents: [SERVICE_2025_ZH, SERVICE_2026_ZH],
    answer: "企业版 1 小时内响应，以 2026 年服务等级为准。",
    rests: [[line(SERVICE_2026_ZH, "紧急工单")]],
    avoid: "把 4 小时说成企业版紧急工单的响应时间（那是 2025 年的或团队版的）",
  },
  {
    id: "zh2-answer-unknown",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "我们 IT 还有一个问题。" },
      { who: "them", text: "你们能对接金蝶吗？我们财务用的是金蝶。" },
    ],
    documents: [INTEGRATIONS_ZH],
    answer:
      "对接列表只写了有赞和用友的连接器以及接口，没有提到金蝶，所以回答不承诺有金蝶连接器（可以提接口）。",
    rests: [[line(INTEGRATIONS_ZH, "连接器"), line(INTEGRATIONS_ZH, "接口")]],
    avoid: "说有金蝶连接器，或已包含",
  },
  {
    id: "zh2-answer-earlier",
    language: "zh-CN",
    kind: "answer",
    needs: "earlier",
    before: [
      { who: "me", text: "开始之前，先说一下培训。" },
      { who: "me", text: ZH_TRAINING },
      { who: "them", text: "一天上门培训，记下了，先放一放。" },
    ],
    long: true,
    turns: [{ who: "them", text: "回到你开头说的培训，具体是什么，有什么条件？" }],
    documents: [TRAINING_ZH],
    answer: "免费加一天上门培训，前提是这个季度签约：这是用户在通话开头提出的。",
    rests: [[said(ZH_TRAINING)]],
    avoid: "对用户承诺免费的那一天收取 12,000 元",
  },
  {
    id: "zh2-answer-two",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "发合同之前还有别的问题吗？" },
      { who: "them", text: "法务问两件事：最短合同期多久？如果不用了，数据怎么拿回来？" },
    ],
    documents: [CONTRACT_ZH],
    answer: "最短合同期 12 个月；合同结束后 30 天内提供数据的 CSV 导出。",
    rests: [[line(CONTRACT_ZH, "最短合同期")], [line(CONTRACT_ZH, "CSV 导出")]],
  },
  {
    id: "zh2-say-competitor",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "另一家供应商说他们的用友连接器所有版本都免费。" }],
    documents: [INTEGRATIONS_ZH],
    answer:
      "如实说明用友连接器仅企业版有、每月 2,000 元，可以提所有版本都含的有赞连接器和 Webhook。",
    rests: [[line(INTEGRATIONS_ZH, "连接器")]],
    avoid: "说用友连接器免费，或所有版本都含",
  },
  {
    id: "zh2-say-offline",
    language: "zh-CN",
    kind: "say",
    needs: "earlier",
    before: [
      { who: "them", text: ZH_SIGNAL },
      { who: "me", text: "明白，这个我等下专门说。" },
    ],
    long: true,
    turns: [{ who: "them", text: "那凭什么相信这套系统在我们这儿靠得住？" }],
    documents: [DEVICES_ZH],
    answer: "回应他们对没信号时扫码的担心：设备离线时照常扫描，恢复信号后自动同步。",
    rests: [[line(DEVICES_ZH, "离线")]],
  },
  {
    id: "zh2-want",
    language: "zh-CN",
    kind: "want",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "我说说上次哪里出了问题。" },
      { who: "them", text: ZH_LEARN },
      { who: "them", text: ZH_PEAK },
    ],
    documents: [TRAINING_ZH],
    answer: "他们要一套司机一天就能学会、在十一月双十一高峰前上线的系统。",
    rests: [[said(ZH_LEARN), said(ZH_PEAK)]],
  },
  {
    id: "zh2-sum",
    language: "zh-CN",
    kind: "sum",
    needs: "whole",
    before: [
      { who: "them", text: ZH_DEPOT },
      { who: "me", text: "成都仓十二名司机，我们没问题。" },
    ],
    long: true,
    turns: [
      { who: "them", text: ZH_OWNER },
      { who: "me", text: ZH_FORM },
    ],
    documents: [DEVICES_ZH],
    answer: "试点用成都仓的 12 名司机；对方由王蕾负责试点；用户周三前发设备订购单。",
    rests: [[said(ZH_DEPOT)], [said(ZH_OWNER), said(ZH_FORM)]],
  },
  {
    id: "zh2-no-deposit",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "签约后的下一周发货。" },
      { who: "them", text: "我们要租四十台扫描枪，押金能不能免了？" },
    ],
    documents: [DEVICES_ZH],
    answer: "婉拒免押金，说明押金每台 300 元，设备归还时退还。",
    rests: [[line(DEVICES_ZH, "押金")]],
    avoid: "同意免除或减免押金",
  },
  {
    id: "zh2-ask-store",
    language: "zh-CN",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "调度和司机端就是这些。" },
      { who: "them", text: "我们也在网上卖货，希望网店的订单能直接进来。" },
    ],
    documents: [INTEGRATIONS_ZH],
    answer: "问他们的网店用的是什么平台，因为所有版本都含有赞连接器。",
    rests: [[line(INTEGRATIONS_ZH, "连接器")]],
  },
  {
    id: "zh2-check-wrong",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "那紧急工单十五分钟内响应，而且所有版本周末都有支持，对吧？" }],
    documents: [SERVICE_2026_ZH],
    answer:
      "两条都不对：紧急工单企业版 1 小时、团队版 4 小时内响应；周末支持仅企业版，周六周日 9:00 至 17:00。",
    rests: [[line(SERVICE_2026_ZH, "紧急工单")], [line(SERVICE_2026_ZH, "周末支持")]],
    avoid: "说任何一条有依据",
  },
  {
    id: "zh2-check-right",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "财务问了付款条件。" },
      { who: "me", text: ZH_INVOICES },
      { who: "them", text: "好，和他们想的一样。" },
    ],
    documents: [CONTRACT_ZH],
    answer: "有依据：合同条款写明发票须在 30 天内付清。",
    rests: [[line(CONTRACT_ZH, "发票")]],
  },
  {
    id: "zh2-no-price",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "企业版能不能每名司机两百五？" }],
    documents: [PRICES_ZH, DISCOUNTS_ZH],
    answer:
      "婉拒 250 元，企业版保持每名司机每月 340 元，并给出真实的让步（50 名司机起打九折，或两年期优惠 8%）。",
    rests: [[line(PRICES_ZH, "企业版"), line(PRICES_ZH, "批量优惠"), line(DISCOUNTS_ZH, "多年期")]],
    avoid: "答应每名司机 250 元",
  },
];
