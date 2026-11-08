/**
 * A fresh slice of call-help cases in twins (#2847): written and committed on 2026-11-08, before any
 * run on it and before the change it gates (`gates/call-help-held-markers.md`). Each English case
 * has a Chinese twin with the same Documents, call and answer, so a press can be weighed against
 * its twin in the other language. The same vendor and rollout talk as `callHelpCases.ts`, with
 * Documents of its own: dock booking, returns, cargo cover in two editions and data retention.
 * Every name, figure and Document is made up.
 */
import { type CallHelpCase, line, said } from "./callHelpCases";

const DOCKS_EN = {
  file: "Dock booking.md",
  text: [
    "# Dock booking",
    "",
    "- The dock booking add-on costs $3 per dock a day.",
    "- A site can book up to 40 docks.",
    "- Drivers get a reminder 30 minutes before their slot.",
    "- A missed slot is held for 15 minutes.",
  ].join("\n"),
};
const RETURNS_EN = {
  file: "Returns handling.md",
  text: [
    "# Returns handling",
    "",
    "- Return labels cost $1.20 each.",
    "- Refunds are processed within 5 business days.",
    "- Damaged returns are photographed at the dock.",
  ].join("\n"),
};
const COVER_2026_EN = {
  file: "Cargo cover 2026.md",
  text: [
    "# Cargo cover 2026",
    "",
    "- Cargo is covered up to $50,000 per load.",
    "- Claims must be filed within 10 days.",
    "- Refrigerated goods are not covered on the Basic plan.",
  ].join("\n"),
};
const COVER_2025_EN = {
  file: "Cargo cover 2025.md",
  text: [
    "# Cargo cover 2025",
    "",
    "- Cargo is covered up to $40,000 per load.",
    "- Claims must be filed within 14 days.",
  ].join("\n"),
};
const RETENTION_EN = {
  file: "Data retention.md",
  text: [
    "# Data retention",
    "",
    "- Trip history is kept for 7 years.",
    "- A closed account's data is deleted 30 days after it closes.",
    "- Exports come as CSV within 48 hours.",
  ].join("\n"),
};

const DOCKS_ZH = {
  file: "月台预约.md",
  text: [
    "# 月台预约",
    "",
    "- 月台预约增值服务：每个月台每天 20 元。",
    "- 每个站点最多可预约 40 个月台。",
    "- 司机在预约时段前 30 分钟收到提醒。",
    "- 错过的时段保留 15 分钟。",
  ].join("\n"),
};
const RETURNS_ZH = {
  file: "退货处理.md",
  text: [
    "# 退货处理",
    "",
    "- 退货面单每张 8 元。",
    "- 退款在 5 个工作日内处理。",
    "- 破损退货在月台拍照留存。",
  ].join("\n"),
};
const COVER_2026_ZH = {
  file: "2026年货物保险.md",
  text: [
    "# 2026 年货物保险",
    "",
    "- 每车货物最高保额 30 万元。",
    "- 理赔须在 10 天内提出。",
    "- 基础版不承保冷藏货物。",
  ].join("\n"),
};
const COVER_2025_ZH = {
  file: "2025年货物保险.md",
  text: ["# 2025 年货物保险", "", "- 每车货物最高保额 25 万元。", "- 理赔须在 14 天内提出。"].join(
    "\n",
  ),
};
const RETENTION_ZH = {
  file: "数据保留.md",
  text: [
    "# 数据保留",
    "",
    "- 行程记录保存 7 年。",
    "- 注销账户的数据在注销 30 天后删除。",
    "- 数据以 CSV 格式导出，48 小时内提供。",
  ].join("\n"),
};

const OFFER_EN = "If you sign this quarter, I can waive the first month of dock booking.";
const QUEUES_EN = "Honestly, our biggest headache is trucks queuing at the gate.";
const CALLS_EN = "And the warehouse team wants fewer phone calls from drivers.";
const START_EN = "Let's start with the north site.";
const LIVE_EN = "Fine, the north site goes live on the second of June.";
const CONTACT_EN = "Priya is our contact for the docks.";
const MAP_EN = "Great, I'll send Priya the dock map by Wednesday.";
const PURGE_EN = "Thirty days after the account closes, its data is deleted.";

const OFFER_ZH = "如果这个季度签约，我可以免掉第一个月的月台预约费。";
const QUEUES_ZH = "说实话，我们最头疼的是货车在门口排队。";
const CALLS_ZH = "而且仓库那边希望司机少打点电话。";
const START_ZH = "那就先从北区站点开始。";
const LIVE_ZH = "可以，北区站点六月二号上线。";
const CONTACT_ZH = "我们这边月台的对接人是何琳。";
const MAP_ZH = "好的，月台图我周三前发给何琳。";
const PURGE_ZH = "账户注销三十天后，数据就会删除。";

export const CALL_HELP_TWINS: readonly CallHelpCase[] = [
  {
    id: "en8-answer-docks",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Dock booking is an add-on." },
      { who: "them", text: "What does dock booking cost, and how many docks can one site book?" },
    ],
    documents: [DOCKS_EN],
    answer: "$3 per dock a day; a site can book up to 40 docks.",
    rests: [[line(DOCKS_EN, "$3 per dock")], [line(DOCKS_EN, "up to 40")]],
  },
  {
    id: "en8-answer-reminder",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "When do our drivers get told their slot is coming up?" }],
    documents: [DOCKS_EN],
    answer: "Drivers get a reminder 30 minutes before their slot.",
    rests: [[line(DOCKS_EN, "reminder")]],
  },
  {
    id: "en8-answer-edition",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Our cover terms were updated this year." },
      { who: "them", text: "So how much cargo is covered per load now?" },
    ],
    documents: [COVER_2026_EN, COVER_2025_EN],
    answer: "Up to $50,000 per load, from the 2026 cover terms.",
    rests: [[line(COVER_2026_EN, "$50,000")]],
    avoid: "giving $40,000 as this year's cover (that is the 2025 terms')",
  },
  {
    id: "en8-answer-unknown",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "Can returns be picked up on Sundays?" }],
    documents: [RETURNS_EN],
    answer:
      "The returns sheet gives labels at $1.20 each and refunds within 5 business days, but doesn't say whether returns are picked up on Sundays; the reply doesn't promise Sunday pickups.",
    rests: [[line(RETURNS_EN, "Return labels"), line(RETURNS_EN, "Refunds")]],
    avoid: "saying returns can be picked up on Sundays",
  },
  {
    id: "en8-answer-earlier",
    language: "en",
    kind: "answer",
    needs: "earlier",
    before: [
      { who: "me", text: OFFER_EN },
      { who: "them", text: "Good to know, we'll think about it." },
    ],
    long: true,
    turns: [{ who: "them", text: "What was that offer on dock booking again?" }],
    documents: [DOCKS_EN],
    answer:
      "The first month of dock booking is waived if they sign this quarter: the User said it at the start of the call.",
    rests: [[said(OFFER_EN)]],
    avoid: "any other discount as the User's offer",
  },
  {
    id: "en8-answer-claim",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Claims go through the cover terms." },
      { who: "them", text: "How long do we have to file a claim?" },
    ],
    documents: [COVER_2026_EN],
    answer: "Claims must be filed within 10 days.",
    rests: [[line(COVER_2026_EN, "Claims")]],
  },
  {
    id: "en8-say-refunds",
    language: "en",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "Our customers complain that refunds take weeks." }],
    documents: [RETURNS_EN],
    answer:
      "An option that answers with the returns sheet: refunds are processed within 5 business days, or damaged returns are photographed at the dock.",
    rests: [[line(RETURNS_EN, "Refunds"), line(RETURNS_EN, "photographed")]],
    avoid: "a promise the sheet doesn't make, such as refunds the same day",
  },
  {
    id: "en8-say-late",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Slots are booked per dock." },
      { who: "them", text: "Our drivers are often a bit late to the warehouse." },
    ],
    documents: [DOCKS_EN],
    answer:
      "An option that answers with the dock sheet: a missed slot is held for 15 minutes, or drivers get a reminder 30 minutes before their slot.",
    rests: [[line(DOCKS_EN, "missed slot"), line(DOCKS_EN, "reminder")]],
    avoid: "a promise the sheet doesn't make, such as holding a slot for an hour",
  },
  {
    id: "en8-no-cold",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Basic covers most of what you move." },
      { who: "them", text: "Can the Basic plan cover our refrigerated loads too?" },
    ],
    documents: [COVER_2026_EN],
    answer: "Decline: refrigerated goods are not covered on the Basic plan.",
    rests: [[line(COVER_2026_EN, "Refrigerated")]],
    avoid: "agreeing to cover refrigerated goods on Basic",
  },
  {
    id: "en8-no-retention",
    language: "en",
    kind: "no",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "Could you keep our trip history for ten years?" }],
    documents: [RETENTION_EN],
    answer: "Decline ten years: trip history is kept for 7 years.",
    rests: [[line(RETENTION_EN, "Trip history")]],
    avoid: "promising ten years",
  },
  {
    id: "en8-ask-docks",
    language: "en",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Dock booking is priced per dock." },
      { who: "them", text: "We're opening a much bigger site next spring." },
    ],
    documents: [DOCKS_EN],
    answer:
      "Ask how many docks the new site will have, since booking is $3 per dock a day and a site can book up to 40 docks.",
    rests: [[line(DOCKS_EN, "$3 per dock"), line(DOCKS_EN, "up to 40")]],
  },
  {
    id: "en8-want",
    language: "en",
    kind: "want",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "Let me tell you where we are." },
      { who: "them", text: QUEUES_EN },
      { who: "them", text: CALLS_EN },
    ],
    documents: [DOCKS_EN],
    answer: "They want shorter queues at the gate and fewer calls from drivers to the warehouse.",
    rests: [[said(QUEUES_EN), said(CALLS_EN)]],
  },
  {
    id: "en8-sum",
    language: "en",
    kind: "sum",
    needs: "whole",
    before: [
      { who: "them", text: START_EN },
      { who: "me", text: LIVE_EN },
    ],
    long: true,
    turns: [
      { who: "them", text: CONTACT_EN },
      { who: "me", text: MAP_EN },
    ],
    documents: [DOCKS_EN],
    answer:
      "The north site goes first and goes live on 2 June; Priya is their contact for the docks; the User sends her the dock map by Wednesday.",
    rests: [
      [said(START_EN), said(LIVE_EN)],
      [said(CONTACT_EN), said(MAP_EN)],
    ],
  },
  {
    id: "en8-check-wrong",
    language: "en",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "Just to confirm: you keep trip history forever, and exports come within 24 hours, right?",
      },
    ],
    documents: [RETENTION_EN],
    answer:
      "Both are wrong: trip history is kept for 7 years, not forever; exports come within 48 hours, not 24.",
    rests: [[line(RETENTION_EN, "Trip history")], [line(RETENTION_EN, "48 hours")]],
    avoid: "saying either holds",
  },
  {
    id: "en8-check-right",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "If we close our account, when is our data deleted?" },
      { who: "me", text: PURGE_EN },
      { who: "them", text: "Good, that works for our auditors." },
    ],
    documents: [RETENTION_EN],
    answer: "Supported: a closed account's data is deleted 30 days after it closes.",
    rests: [[line(RETENTION_EN, "closed account")]],
  },

  {
    id: "zh8-answer-docks",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "月台预约是增值服务。" },
      { who: "them", text: "月台预约怎么收费？一个站点能预约多少个月台？" },
    ],
    documents: [DOCKS_ZH],
    answer: "每个月台每天 20 元；每个站点最多可预约 40 个月台。",
    rests: [[line(DOCKS_ZH, "每个月台每天")], [line(DOCKS_ZH, "最多可预约")]],
  },
  {
    id: "zh8-answer-reminder",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "我们的司机什么时候会知道预约时段快到了？" }],
    documents: [DOCKS_ZH],
    answer: "司机在预约时段前 30 分钟收到提醒。",
    rests: [[line(DOCKS_ZH, "提醒")]],
  },
  {
    id: "zh8-answer-edition",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "我们的保险条款今年更新过。" },
      { who: "them", text: "那现在每车货物最高保额是多少？" },
    ],
    documents: [COVER_2026_ZH, COVER_2025_ZH],
    answer: "每车货物最高保额 30 万元，以 2026 年保险条款为准。",
    rests: [[line(COVER_2026_ZH, "30 万元")]],
    avoid: "把 25 万元说成今年的保额（那是 2025 年条款的）",
  },
  {
    id: "zh8-answer-unknown",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "退货周日能上门取件吗？" }],
    documents: [RETURNS_ZH],
    answer:
      "退货处理只写了退货面单每张 8 元、退款在 5 个工作日内处理，没有写周日能否上门取件；回复不承诺周日取件。",
    rests: [[line(RETURNS_ZH, "退货面单"), line(RETURNS_ZH, "退款")]],
    avoid: "说周日可以上门取件",
  },
  {
    id: "zh8-answer-earlier",
    language: "zh-CN",
    kind: "answer",
    needs: "earlier",
    before: [
      { who: "me", text: OFFER_ZH },
      { who: "them", text: "好，这个我们考虑一下。" },
    ],
    long: true,
    turns: [{ who: "them", text: "你刚才说的月台预约优惠是什么来着？" }],
    documents: [DOCKS_ZH],
    answer: "这个季度签约，免掉第一个月的月台预约费：这是用户在通话开头给出的。",
    rests: [[said(OFFER_ZH)]],
    avoid: "把其他优惠说成用户给出的",
  },
  {
    id: "zh8-answer-claim",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "理赔按保险条款走。" },
      { who: "them", text: "理赔有没有时间限制？" },
    ],
    documents: [COVER_2026_ZH],
    answer: "有：理赔须在 10 天内提出。",
    rests: [[line(COVER_2026_ZH, "理赔")]],
  },
  {
    id: "zh8-say-refunds",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "我们的客户老是抱怨退款要等好几个星期。" }],
    documents: [RETURNS_ZH],
    answer: "一个用退货处理回应的选项：退款在 5 个工作日内处理，或破损退货在月台拍照留存。",
    rests: [[line(RETURNS_ZH, "退款"), line(RETURNS_ZH, "拍照")]],
    avoid: "文档没有的承诺，比如当天退款",
  },
  {
    id: "zh8-say-late",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "时段是按月台预约的。" },
      { who: "them", text: "我们的司机到仓库经常会晚一点。" },
    ],
    documents: [DOCKS_ZH],
    answer:
      "一个用月台预约回应的选项：错过的时段保留 15 分钟，或司机在预约时段前 30 分钟收到提醒。",
    rests: [[line(DOCKS_ZH, "错过的时段"), line(DOCKS_ZH, "提醒")]],
    avoid: "文档没有的承诺，比如时段保留一小时",
  },
  {
    id: "zh8-no-cold",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "基础版能覆盖你们大部分货物。" },
      { who: "them", text: "基础版能不能也承保我们的冷藏货物？" },
    ],
    documents: [COVER_2026_ZH],
    answer: "婉拒：基础版不承保冷藏货物。",
    rests: [[line(COVER_2026_ZH, "冷藏")]],
    avoid: "答应基础版承保冷藏货物",
  },
  {
    id: "zh8-no-retention",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "行程记录能不能帮我们保存十年？" }],
    documents: [RETENTION_ZH],
    answer: "婉拒保存十年：行程记录保存 7 年。",
    rests: [[line(RETENTION_ZH, "行程记录")]],
    avoid: "答应保存十年",
  },
  {
    id: "zh8-ask-docks",
    language: "zh-CN",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "月台预约是按月台收费的。" },
      { who: "them", text: "我们明年春天要开一个大得多的站点。" },
    ],
    documents: [DOCKS_ZH],
    answer:
      "问新站点会有多少个月台，因为预约按每个月台每天 20 元收费，每个站点最多可预约 40 个月台。",
    rests: [[line(DOCKS_ZH, "每个月台每天"), line(DOCKS_ZH, "最多可预约")]],
  },
  {
    id: "zh8-want",
    language: "zh-CN",
    kind: "want",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "我说说我们现在的情况。" },
      { who: "them", text: QUEUES_ZH },
      { who: "them", text: CALLS_ZH },
    ],
    documents: [DOCKS_ZH],
    answer: "他们想要门口少排队，并且司机少给仓库打电话。",
    rests: [[said(QUEUES_ZH), said(CALLS_ZH)]],
  },
  {
    id: "zh8-sum",
    language: "zh-CN",
    kind: "sum",
    needs: "whole",
    before: [
      { who: "them", text: START_ZH },
      { who: "me", text: LIVE_ZH },
    ],
    long: true,
    turns: [
      { who: "them", text: CONTACT_ZH },
      { who: "me", text: MAP_ZH },
    ],
    documents: [DOCKS_ZH],
    answer: "先从北区站点开始，六月二号上线；对方月台的对接人是何琳；用户周三前把月台图发给何琳。",
    rests: [
      [said(START_ZH), said(LIVE_ZH)],
      [said(CONTACT_ZH), said(MAP_ZH)],
    ],
  },
  {
    id: "zh8-check-wrong",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "我确认一下，你们的行程记录是永久保存的，而且导出 24 小时内就能拿到，对吧？",
      },
    ],
    documents: [RETENTION_ZH],
    answer: "两项都不对：行程记录保存 7 年，不是永久保存；导出在 48 小时内提供，不是 24 小时。",
    rests: [[line(RETENTION_ZH, "行程记录")], [line(RETENTION_ZH, "48 小时")]],
    avoid: "说任何一项有依据或成立",
  },
  {
    id: "zh8-check-right",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "如果我们注销账户，数据什么时候删除？" },
      { who: "me", text: PURGE_ZH },
      { who: "them", text: "好，这个我们审计那边能接受。" },
    ],
    documents: [RETENTION_ZH],
    answer: "有依据：注销账户的数据在注销 30 天后删除。",
    rests: [[line(RETENTION_ZH, "注销账户")]],
  },
];
