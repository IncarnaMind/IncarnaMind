/**
 * Call-help cases over Documents as people write them (#2526): written and committed on
 * 2026-11-08, before any run on them, for the marks-passages gate's second look at how a quote is
 * picked (`gates/call-help-marks-passages.md`). The sets before these hold two to five one-fact
 * bullets under a "#" heading, so a picker never chose among similar lines there. These Documents
 * are paragraphs of several sentences and a table of figures, with figures one step from the right
 * one (a volume price beside the list price, battery life at each interval), a Document whose name
 * is in its own text, and two calls in another language than their Document. A cold-chain
 * monitoring vendor selling to a food distributor; every name, figure and Document is made up.
 */
import { type CallHelpCase, line } from "./callHelpCases";

const PLANS_EN = {
  file: "Monitoring plans.md",
  text: [
    "# Monitoring plans",
    "",
    "Every plan includes the monitoring dashboard, email alerts and the warehouse app. Plans differ in how often each sensor reports, how long its readings are kept and which alerts come with it.",
    "",
    "| Plan | Price per sensor a month | Reporting interval | Readings kept |",
    "|---|---|---|---|",
    "| Basic | $6 | every 15 minutes | 90 days |",
    "| Standard | $9 | every 5 minutes | 1 year |",
    "| Premium | $14 | every minute | 3 years |",
    "",
    "Text-message alerts are included on Standard and Premium. On Basic, each text message costs $0.05.",
    "",
    "From 200 sensors, Standard drops to $8 a sensor a month and Premium to $12. Prices are fixed for the first 24 months of a contract; after that, a yearly increase is capped at 4%.",
  ].join("\n"),
};
const HARDWARE_EN = {
  file: "Sensor hardware.md",
  text: [
    "# Sensor hardware",
    "",
    "This Sensor hardware sheet covers the wireless probes we ship with every plan. The probes are the same on every plan; only how often they report changes.",
    "",
    "Each probe works from -30 °C to +60 °C and is accurate to ±0.3 °C. Every probe ships with a calibration certificate valid for 12 months, and recalibration costs $15 a probe.",
    "",
    "Battery life depends on the reporting interval: about 5 years when a probe reports every 15 minutes, 3 years at every 5 minutes, and 2 years at every minute. Batteries can be swapped on site in under a minute.",
    "",
    "A faulty probe is replaced within 3 business days. Gateways cost $180 each, and one gateway covers up to 40 probes within 100 metres.",
  ].join("\n"),
};
const AGREEMENT_EN = {
  file: "Service agreement.md",
  text: [
    "# Service agreement",
    "",
    "The agreement runs for a minimum of 12 months. After that it renews month by month, and either side can end it with 60 days' written notice.",
    "",
    "We guarantee 99.9% uptime for the dashboard and alerts, measured each calendar month. For every 0.1% below that, the customer gets a service credit of 10% of that month's fee, up to 50%.",
    "",
    "When the agreement ends, the customer can export all readings as CSV files for 30 days. After those 30 days the readings are deleted.",
    "",
    "Our liability is capped at the fees paid in the 12 months before a claim. Spoiled stock is not covered.",
  ].join("\n"),
};
const SUPPORT_EN = {
  file: "Support and onboarding.md",
  text: [
    "# Support and onboarding",
    "",
    "Onboarding costs $1,200 once and takes about two weeks: a kickoff call, a survey of the cold rooms and a training session for the warehouse team. Onboarding is free from 500 sensors.",
    "",
    "Standard support is by email, answered within one business day. Premium adds phone support around the clock, and a critical alert is answered within 30 minutes.",
    "",
    "Each customer gets two training sessions a year; an extra session costs $300.",
  ].join("\n"),
};

const PLANS_ZH = {
  file: "监控方案.md",
  text: [
    "# 监控方案",
    "",
    "所有方案都包含监控看板、邮件告警和仓库端应用。各方案的区别在于传感器多久上报一次、读数保存多久，以及含哪些告警。",
    "",
    "| 方案 | 每个传感器每月 | 上报间隔 | 读数保存 |",
    "|---|---|---|---|",
    "| 基础版 | 40 元 | 每 15 分钟 | 90 天 |",
    "| 标准版 | 60 元 | 每 5 分钟 | 1 年 |",
    "| 高级版 | 95 元 | 每分钟 | 3 年 |",
    "",
    "标准版和高级版含短信告警；基础版每条短信 0.3 元。",
    "",
    "200 个传感器起，标准版降到每个每月 55 元，高级版降到 85 元。合同前 24 个月价格不变，之后每年涨幅不超过 4%。",
  ].join("\n"),
};
const HARDWARE_ZH = {
  file: "传感器硬件.md",
  text: [
    "# 传感器硬件",
    "",
    "本传感器硬件说明适用于所有方案随附的无线探头。各方案的探头相同，只是上报频率不同。",
    "",
    "探头工作温度为 -30 °C 至 +60 °C，精度 ±0.3 °C。每个探头出厂附带校准证书，有效期 12 个月；重新校准每个探头 100 元。",
    "",
    "电池寿命取决于上报间隔：每 15 分钟上报约 5 年，每 5 分钟约 3 年，每分钟约 2 年。电池可现场更换，一分钟内完成。",
    "",
    "探头故障 3 个工作日内换新。网关每个 1,200 元，一个网关覆盖 100 米内最多 40 个探头。",
  ].join("\n"),
};
const AGREEMENT_ZH = {
  file: "服务协议.md",
  text: [
    "# 服务协议",
    "",
    "协议最短期限为 12 个月，期满后按月续约，任何一方提前 60 天书面通知即可终止。",
    "",
    "看板和告警的可用性承诺为 99.9%，按自然月计算。每低于 0.1%，客户获得当月费用 10% 的服务抵扣，最多 50%。",
    "",
    "协议终止后 30 天内，客户可将全部读数导出为 CSV 文件；30 天后读数将被删除。",
    "",
    "我方责任上限为索赔前 12 个月已付的费用，货物损坏不在赔偿范围内。",
  ].join("\n"),
};
const SUPPORT_ZH = {
  file: "支持与上线.md",
  text: [
    "# 支持与上线",
    "",
    "上线服务一次性收费 8,000 元，约两周完成：启动会、冷库现场勘察和仓库团队培训。500 个传感器起免收上线费。",
    "",
    "标准支持通过邮件，一个工作日内回复。高级版另含 7×24 小时电话支持，紧急告警 30 分钟内响应。",
    "",
    "每位客户每年两次培训，额外一次 2,000 元。",
  ].join("\n"),
};

export const CALL_HELP_DOCUMENTS: readonly CallHelpCase[] = [
  {
    id: "en4-answer-standard",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Most teams your size start on Standard." },
      {
        who: "them",
        text: "What does Standard cost per sensor, and how long are the readings kept?",
      },
    ],
    documents: [PLANS_EN, SUPPORT_EN],
    answer: "$9 per sensor a month, with readings kept for 1 year.",
    rests: [[line(PLANS_EN, "| Standard")]],
    avoid: "the $8 volume price as Standard's price",
  },
  {
    id: "en4-answer-volume",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "We'll put in about 250 sensors. What would Premium cost per sensor at that size?",
      },
    ],
    documents: [PLANS_EN, HARDWARE_EN],
    answer: "$12 a sensor a month: from 200 sensors, Premium drops from $14 to $12.",
    rests: [[line(PLANS_EN, "From 200 sensors")]],
    avoid: "$14 as the price at 250 sensors",
  },
  {
    id: "en4-answer-texts",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Basic is the cheapest way to start." },
      { who: "them", text: "Are text-message alerts included if we go with Basic?" },
    ],
    documents: [PLANS_EN],
    answer:
      "No: on Basic each text message costs $0.05; text-message alerts are included on Standard and Premium.",
    rests: [[line(PLANS_EN, "Text-message alerts")]],
    avoid: "that text-message alerts are included on Basic",
  },
  {
    id: "en4-answer-battery",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "If the probes report every minute, how long do the batteries last?",
      },
    ],
    documents: [HARDWARE_EN, PLANS_EN],
    answer: "About 2 years when a probe reports every minute (5 years at every 15 minutes).",
    rests: [[line(HARDWARE_EN, "Battery life")]],
    avoid: "5 or 3 years as the battery life at one-minute reporting",
  },
  {
    id: "en4-check-wrong",
    language: "en",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "So the probes work down to minus forty, and they're accurate to half a degree, right?",
      },
    ],
    documents: [HARDWARE_EN],
    answer:
      "Both claims are contradicted: the probes work from -30 °C to +60 °C, and they are accurate to ±0.3 °C.",
    rests: [[line(HARDWARE_EN, "Each probe works")]],
    avoid: "that either claim is supported",
  },
  {
    id: "en4-check-right",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "Our legal team asked how we would get out of it later." },
      {
        who: "me",
        text: "After the first 12 months, either side can end it with 60 days' written notice.",
      },
      { who: "them", text: "Good, that's what they wanted to hear." },
    ],
    documents: [AGREEMENT_EN],
    answer:
      "Supported: the agreement runs for at least 12 months, then either side can end it with 60 days' written notice.",
    rests: [[line(AGREEMENT_EN, "The agreement runs")]],
  },
  {
    id: "en4-no-lock",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "So that's Premium for the cold rooms." },
      { who: "them", text: "Could you lock that price for five years instead of two?" },
    ],
    documents: [PLANS_EN, AGREEMENT_EN],
    answer:
      "Declines a five-year lock: prices are fixed for the first 24 months, and after that a yearly increase is capped at 4%.",
    rests: [[line(PLANS_EN, "From 200 sensors")]],
    avoid: "agreeing to fix the price for five years",
  },
  {
    id: "en4-say-outage",
    language: "en",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "Our last provider's alerts were down for a whole day, and we lost a truckload of frozen fish.",
      },
    ],
    documents: [AGREEMENT_EN, SUPPORT_EN],
    answer:
      "An option that answers with the 99.9% uptime guarantee and its service credits (10% of the month's fee for every 0.1% below, up to 50%), or with Premium's 30-minute answer to a critical alert; it doesn't promise to pay for spoiled stock.",
    rests: [[line(AGREEMENT_EN, "We guarantee 99.9%"), line(SUPPORT_EN, "Standard support")]],
    avoid: "that spoiled stock would be paid for",
  },
  {
    id: "en4-ask-sites",
    language: "en",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Each cold room needs a few probes, and each truck needs one." },
      { who: "them", text: "We have twelve cold rooms and about forty trucks." },
    ],
    documents: [PLANS_EN, HARDWARE_EN],
    answer:
      "A question asking how many probes they need in all, or how the cold rooms are laid out, since prices drop from 200 sensors and one gateway covers up to 40 probes within 100 metres.",
    rests: [[line(PLANS_EN, "From 200 sensors"), line(HARDWARE_EN, "Gateways cost")]],
  },
  {
    id: "en4-answer-onboarding",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We'd get you live before the summer." },
      { who: "them", text: "Is there a setup fee? We'd start with about 300 sensors." },
    ],
    documents: [SUPPORT_EN, PLANS_EN],
    answer:
      "Yes: onboarding costs $1,200 once; it is free only from 500 sensors, so at 300 it applies.",
    rests: [[line(SUPPORT_EN, "Onboarding costs")]],
    avoid: "that onboarding is free at 300 sensors",
  },
  {
    id: "en4-answer-certificate",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "The probes are the same whichever plan you take." },
      { who: "them", text: "Does the sensor hardware come with a calibration certificate?" },
    ],
    documents: [HARDWARE_EN],
    answer:
      "Yes: every probe ships with a calibration certificate valid for 12 months; recalibration costs $15 a probe.",
    rests: [[line(HARDWARE_EN, "Each probe works")]],
  },
  {
    id: "en4-answer-phone-zh",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Premium is what most food distributors pick." },
      {
        who: "them",
        text: "Does Premium include phone support at night, and how fast is a critical alert answered?",
      },
    ],
    documents: [SUPPORT_ZH],
    answer:
      "Yes: Premium includes phone support around the clock (7×24), and a critical alert is answered within 30 minutes.",
    rests: [[line(SUPPORT_ZH, "高级版另含")]],
  },

  {
    id: "zh4-answer-standard",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "你们这个规模的客户，大多从标准版开始。" },
      { who: "them", text: "标准版每个传感器每月多少钱？读数保存多久？" },
    ],
    documents: [PLANS_ZH, SUPPORT_ZH],
    answer: "每个传感器每月 60 元，读数保存 1 年。",
    rests: [[line(PLANS_ZH, "| 标准版")]],
    avoid: "把 55 元的批量价说成标准版的价格",
  },
  {
    id: "zh4-answer-volume",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "我们大概要装 250 个传感器，这个量的话高级版每个多少钱？" }],
    documents: [PLANS_ZH, HARDWARE_ZH],
    answer: "每个每月 85 元：200 个传感器起，高级版从 95 元降到 85 元。",
    rests: [[line(PLANS_ZH, "200 个传感器起")]],
    avoid: "按 95 元报 250 个传感器的价格",
  },
  {
    id: "zh4-answer-texts",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "基础版是起步最便宜的。" },
      { who: "them", text: "选基础版的话，短信告警包含在内吗？" },
    ],
    documents: [PLANS_ZH],
    answer: "不含：基础版每条短信 0.3 元；标准版和高级版含短信告警。",
    rests: [[line(PLANS_ZH, "标准版和高级版含短信告警")]],
    avoid: "说基础版含短信告警",
  },
  {
    id: "zh4-answer-battery",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "如果探头每分钟上报一次，电池能用多久？" }],
    documents: [HARDWARE_ZH, PLANS_ZH],
    answer: "约 2 年（每 15 分钟上报一次约 5 年）。",
    rests: [[line(HARDWARE_ZH, "电池寿命")]],
    avoid: "把 5 年或 3 年说成每分钟上报时的电池寿命",
  },
  {
    id: "zh4-check-wrong",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "所以探头能在零下四十度工作，精度在半度以内，对吧？" }],
    documents: [HARDWARE_ZH],
    answer: "两条都不对：探头工作温度为 -30 °C 至 +60 °C，精度 ±0.3 °C。",
    rests: [[line(HARDWARE_ZH, "探头工作温度")]],
    avoid: "说任何一条有依据",
  },
  {
    id: "zh4-check-right",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "我们法务问以后怎么退出。" },
      { who: "me", text: "头 12 个月之后，任何一方提前 60 天书面通知就能终止。" },
      { who: "them", text: "好，这正是他们想听的。" },
    ],
    documents: [AGREEMENT_ZH],
    answer: "有依据：协议最短 12 个月，之后任何一方提前 60 天书面通知即可终止。",
    rests: [[line(AGREEMENT_ZH, "协议最短期限")]],
  },
  {
    id: "zh4-no-lock",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "那冷库就用高级版。" },
      { who: "them", text: "这个价格能不能锁五年，而不是两年？" },
    ],
    documents: [PLANS_ZH, AGREEMENT_ZH],
    answer: "婉拒锁价五年：合同前 24 个月价格不变，之后每年涨幅不超过 4%。",
    rests: [[line(PLANS_ZH, "200 个传感器起")]],
    avoid: "答应五年不涨价",
  },
  {
    id: "zh4-say-outage",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "上一家的告警系统宕了一整天，我们损失了一整车冻鱼。" }],
    documents: [AGREEMENT_ZH, SUPPORT_ZH],
    answer:
      "用可用性承诺回应：99.9% 可用性，每低于 0.1% 抵扣当月费用 10%，最多 50%；或用高级版紧急告警 30 分钟内响应回应；不承诺赔偿货物损失。",
    rests: [[line(AGREEMENT_ZH, "看板和告警的可用性"), line(SUPPORT_ZH, "标准支持通过邮件")]],
    avoid: "承诺赔偿货物损失",
  },
  {
    id: "zh4-ask-sites",
    language: "zh-CN",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "每个冷库要装几个探头，每辆车装一个。" },
      { who: "them", text: "我们有十二个冷库，四十来辆车。" },
    ],
    documents: [PLANS_ZH, HARDWARE_ZH],
    answer:
      "问他们一共要多少个探头，或冷库怎么分布，因为 200 个传感器起降价，一个网关覆盖 100 米内最多 40 个探头。",
    rests: [[line(PLANS_ZH, "200 个传感器起"), line(HARDWARE_ZH, "网关每个")]],
  },
  {
    id: "zh4-answer-onboarding",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "夏天之前可以帮你们上线。" },
      { who: "them", text: "有上线费吗？我们先装 300 个左右。" },
    ],
    documents: [SUPPORT_ZH, PLANS_ZH],
    answer: "有：上线费一次性 8,000 元；500 个传感器起才免收，300 个要收。",
    rests: [[line(SUPPORT_ZH, "上线服务一次性")]],
    avoid: "说 300 个传感器免收上线费",
  },
  {
    id: "zh4-answer-certificate",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "不管选哪个方案，探头都一样。" },
      { who: "them", text: "传感器硬件带校准证书吗？" },
    ],
    documents: [HARDWARE_ZH],
    answer: "带：每个探头出厂附带校准证书，有效期 12 个月；重新校准每个探头 100 元。",
    rests: [[line(HARDWARE_ZH, "探头工作温度")]],
  },
  {
    id: "zh4-answer-uptime-en",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "合同条款是英文版的，我直接看给你。" },
      { who: "them", text: "你们的可用性承诺是多少？达不到的话怎么赔？" },
    ],
    documents: [AGREEMENT_EN],
    answer: "99.9%，按自然月计；每低于 0.1%，抵扣当月费用的 10%，最多 50%。",
    rests: [[line(AGREEMENT_EN, "We guarantee 99.9%")]],
  },
];
