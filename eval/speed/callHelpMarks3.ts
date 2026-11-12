/**
 * The third gate's slice of call-help cases for the ✓ that only the sentence check gives (#2847):
 * written and committed on 2026-11-12, before any run on it and before the first run of
 * `gates/call-help-checked-marks-3.md`. Fifteen English presses, each with a Chinese twin of the
 * same call, Documents and answer, about solar panels on a bakery chain's roofs, with the same mix
 * of buttons as `call-help-marks`. Every case has Documents of its own, which no other case reads,
 * and its own Meeting and Note; no Document, line or press is in a set before it or in a prompt's
 * examples. Short calls only. Every name, figure and Document is made up.
 */
import { type CallDocument, type CallHelpCase, line, said } from "./callHelpCases";

const doc = (file: string, title: string, lines: readonly string[]): CallDocument => ({
  file,
  text: [`# ${title}`, "", ...lines.map((each) => `- ${each}`)].join("\n"),
});

const PRICES_EN = doc("System prices.md", "System prices", [
  "A 50 kW roof system costs €42,000 installed.",
  "Each extra 10 kW adds €7,500.",
  "Scaffolding is charged at cost, quoted after the roof survey.",
]);
const WARRANTY_EN = doc("Warranty.md", "Warranty", [
  "Panels carry a 25-year performance warranty.",
  "Inverters are covered for 10 years, parts and labour.",
  "Workmanship is guaranteed for 5 years.",
]);
const WORKING_EN = doc("Installation days.md", "Installation days", [
  "Installers work Monday to Saturday, 7 am to 5 pm.",
  "A 50 kW system takes about four working days on the roof.",
  "The grid connection is booked with the network operator after installation.",
]);
const BATTERIES_EN = doc("Batteries.md", "Batteries", [
  "A 30 kWh battery stores the afternoon surplus for the evening.",
  "Batteries start at €14,000.",
]);
const ROOF_EN = doc("Roof works.md", "Roof works", [
  "A structural engineer checks the roof before any work starts.",
  "Mounting uses clamps on the existing seams, with no holes drilled through the roof.",
  "Any leak caused by the installation is repaired at our cost.",
]);
const OUTAGES_EN = doc("Power cuts.md", "Power cuts", [
  "Without a battery, the system switches off during a grid power cut, as the rules require.",
  "With a battery, chosen circuits keep running for up to 6 hours.",
]);
const PRICING_EN = doc("Pricing rules.md", "Pricing rules", [
  "A quoted price can come down by at most 5%, and only when paid in full upfront.",
  "Quotes are valid for 45 days.",
]);
const LEAD_EN = doc("Lead times.md", "Lead times", [
  "Installation starts at least 6 weeks after the roof survey.",
  "Panels are ordered once the deposit is paid.",
]);
const SURVEYS_EN = doc("Surveys.md", "Surveys", [
  "Every roof needs its own survey before we can quote.",
  "A survey takes about two hours and costs nothing.",
]);
const UPKEEP_EN = doc("Maintenance.md", "Maintenance", [
  "Panels are cleaned once a year, included in the service plan.",
  "The service plan costs €600 a year.",
]);
const APP_EN = doc("Monitoring.md", "Monitoring", [
  "The monitoring app is free for the first 2 years.",
  "After that it costs €8 a month.",
]);
const OUTPUT_EN = doc("Yearly output.md", "Yearly output", [
  "A 50 kW system makes about 45,000 kWh a year.",
]);
const NEXT_EN = doc("Next steps.md", "Next steps", [
  "A project manager is named once the quote is signed.",
]);
const RELIEF_EN = doc("Tax relief.md", "Tax relief", [
  "The full cost can be deducted from taxable profits in the first year.",
  "We send the paperwork your accountant needs.",
]);
const TIMELINE_EN = doc("Timeline.md", "Timeline", [
  "From signing to switch-on takes about 10 weeks.",
  "The roof survey is booked within 5 working days of signing.",
]);

const OFFER_EN = "If you sign this quarter, we'll cover the scaffolding.";
const BILLS_EN = "Honestly, it's the electricity bill. It doubled in two years.";
const AFTERNOONS_EN = "The afternoons, when all the ovens and the cold rooms run at once.";
const SURVEY_EN = "So the survey is on the twelfth of May, at the main shop.";
const QUOTE_EN = "And I'll send the final quote by Wednesday.";

const ENGLISH: readonly CallHelpCase[] = [
  {
    id: "en12-answer-price",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We size the system to your roof and to what you use in the day." },
      { who: "them", text: "What would a fifty kilowatt system cost us, installed?" },
    ],
    documents: [PRICES_EN],
    answer: "€42,000 installed for a 50 kW system.",
    rests: [[line(PRICES_EN, "50 kW roof system")]],
    avoid:
      "adding the scaffolding or an extra 10 kW into the price, or a total the sheet doesn't give",
  },
  {
    id: "en12-answer-two",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "Two questions: how long are the panels guaranteed, and what about the inverters?",
      },
    ],
    documents: [WARRANTY_EN],
    answer: "Panels: a 25-year performance warranty; inverters: 10 years, parts and labour.",
    rests: [[line(WARRANTY_EN, "25-year")], [line(WARRANTY_EN, "Inverters")]],
  },
  {
    id: "en12-answer-unknown",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We plan the work around your opening hours." },
      { who: "them", text: "Can your team work on the roof at night, while the shop is closed?" },
    ],
    documents: [WORKING_EN],
    answer:
      "Installers work Monday to Saturday, 7 am to 5 pm; the sheet doesn't say whether night work is possible.",
    rests: [[line(WORKING_EN, "Monday to Saturday")]],
    avoid: "stating as a fact that night work is, or isn't, possible",
  },
  {
    id: "en12-answer-earlier",
    language: "en",
    kind: "answer",
    needs: "earlier",
    before: [
      { who: "me", text: OFFER_EN },
      { who: "them", text: "Good to know, we'll note that." },
    ],
    long: false,
    turns: [
      { who: "me", text: "Shall I go through the battery options?" },
      { who: "them", text: "Hold on, what was the deal you mentioned at the beginning?" },
    ],
    documents: [BATTERIES_EN],
    answer:
      "If they sign this quarter, the scaffolding is covered, as the User said earlier in the call.",
    rests: [[said(OFFER_EN)]],
    avoid: "any other discount or price as the User's offer",
  },
  {
    id: "en12-say-roof",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "Our roof is quite old, and I'm worried about leaks once you start drilling into it.",
      },
    ],
    documents: [ROOF_EN],
    answer:
      "An option that answers with the roof sheet: a structural engineer checks the roof first, the mounting is clamped to the seams with no holes drilled, or a leak the installation causes is repaired at the installer's cost.",
    rests: [
      [line(ROOF_EN, "structural engineer"), line(ROOF_EN, "no holes"), line(ROOF_EN, "leak")],
    ],
    avoid: "a promise the sheet doesn't make, such as a guarantee on the whole roof",
  },
  {
    id: "en12-say-outage",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "The panels feed your own building first." },
      {
        who: "them",
        text: "What happens if the grid goes down? Last winter we lost power for a whole day.",
      },
    ],
    documents: [OUTAGES_EN],
    answer:
      "An option that answers with the sheet: without a battery the system switches off in a power cut; with a battery, chosen circuits keep running for up to 6 hours.",
    rests: [[line(OUTAGES_EN, "Without a battery"), line(OUTAGES_EN, "With a battery")]],
    avoid: "saying the panels keep the building running in a power cut without a battery",
  },
  {
    id: "en12-no-price",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "Could you do the whole thing for thirty thousand euros?" }],
    documents: [PRICING_EN],
    answer:
      "A polite no to €30,000 that keeps things moving: a quoted price comes down by at most 5%, and only when paid in full upfront.",
    rests: [[line(PRICING_EN, "at most 5%")]],
    avoid: "agreeing to €30,000, or a discount the rules don't allow",
  },
  {
    id: "en12-no-monday",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We can usually move quickly once the roof is surveyed." },
      {
        who: "them",
        text: "Great, can you start next Monday? We'd like it done before the summer.",
      },
    ],
    documents: [LEAD_EN],
    answer:
      "A polite no to next Monday: installation starts at least 6 weeks after the roof survey; it may offer to book the survey.",
    rests: [[line(LEAD_EN, "6 weeks")]],
    avoid: "promising a start next Monday",
  },
  {
    id: "en12-ask-shops",
    language: "en",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "We have four shops, and two of them have flat roofs." },
      { who: "me", text: "I see." },
    ],
    documents: [SURVEYS_EN],
    answer:
      "A question that moves towards a survey of each roof, since every roof is surveyed before a quote, and a survey is free.",
    rests: [[line(SURVEYS_EN, "own survey"), line(SURVEYS_EN, "two hours")]],
  },
  {
    id: "en12-check-right",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "Your sheet says you clean the panels once a year, is that right?" },
      { who: "me", text: "Let me look." },
    ],
    documents: [UPKEEP_EN],
    answer:
      "Their claim is supported: panels are cleaned once a year, included in the service plan.",
    rests: [[line(UPKEEP_EN, "cleaned once a year")]],
  },
  {
    id: "en12-check-wrong",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "And the monitoring app is free for as long as we have the system.",
      },
    ],
    documents: [APP_EN],
    answer: "Wrong: the monitoring app is free for the first 2 years, then it costs €8 a month.",
    rests: [[line(APP_EN, "first 2 years"), line(APP_EN, "€8 a month")]],
    avoid: "saying the app is free for the life of the system",
  },
  {
    id: "en12-want-bills",
    language: "en",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: BILLS_EN },
      { who: "me", text: "Which part of the day costs you most?" },
      { who: "them", text: AFTERNOONS_EN },
    ],
    documents: [OUTPUT_EN],
    answer:
      "They want a lower electricity bill: it doubled in two years, and the afternoons, when the ovens and cold rooms all run, cost most.",
    rests: [[said(BILLS_EN), said(AFTERNOONS_EN)]],
  },
  {
    id: "en12-sum",
    language: "en",
    kind: "sum",
    needs: "whole",
    long: false,
    turns: [
      { who: "me", text: SURVEY_EN },
      { who: "them", text: "Yes, and Corin Vale will meet your engineer there." },
      { who: "me", text: QUOTE_EN },
      { who: "them", text: "Good." },
    ],
    documents: [NEXT_EN],
    answer:
      "Lines that sum up: the survey is on 12 May at the main shop; Corin Vale meets the engineer; the User sends the final quote by Wednesday.",
    rests: [[said(SURVEY_EN)], [said(QUOTE_EN)]],
  },
  {
    id: "en12-answer-relief",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "Is there any tax relief we can use for this?" }],
    documents: [RELIEF_EN],
    answer:
      "Yes: the full cost can be deducted from taxable profits in the first year; the installer sends the paperwork their accountant needs.",
    rests: [[line(RELIEF_EN, "full cost")]],
    avoid: "a grant or a relief the sheet doesn't give",
  },
  {
    id: "en12-say-autumn",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "We'd like the panels working before our busy season in the autumn." },
    ],
    documents: [TIMELINE_EN],
    answer:
      "An option saying signing to switch-on takes about 10 weeks, or that the roof survey is booked within 5 working days of signing.",
    rests: [[line(TIMELINE_EN, "10 weeks"), line(TIMELINE_EN, "5 working days")]],
    avoid: "a switch-on date the sheet doesn't give",
  },
];

const PRICES_ZH = doc("系统价格.md", "系统价格", [
  "50 千瓦屋顶系统含安装 32 万元。",
  "每增加 10 千瓦加 5.6 万元。",
  "脚手架按实际成本收费，屋顶勘察后报价。",
]);
const WARRANTY_ZH = doc("质保.md", "质保", [
  "组件享受 25 年性能质保。",
  "逆变器保修 10 年，包工包料。",
  "施工质量保证 5 年。",
]);
const WORKING_ZH = doc("施工时间.md", "施工时间", [
  "安装人员周一至周六上午 7 点到下午 5 点施工。",
  "50 千瓦系统在屋顶上施工约四个工作日。",
  "安装完成后再向电网公司预约并网。",
]);
const BATTERIES_ZH = doc("储能.md", "储能", [
  "30 千瓦时的电池可以把下午多余的电存到晚上用。",
  "电池 10.5 万元起。",
]);
const ROOF_ZH = doc("屋面施工.md", "屋面施工", [
  "施工前由结构工程师检查屋顶。",
  "支架用夹具固定在原有的屋面接缝上，不在屋顶上打孔。",
  "安装造成的漏水由我们负责维修。",
]);
const OUTAGES_ZH = doc("停电.md", "停电", [
  "没有电池时，电网停电期间系统会按规定自动关闭。",
  "配了电池，选定的线路最多可以继续供电 6 小时。",
]);
const PRICING_ZH = doc("价格规则.md", "价格规则", [
  "报价最多下调 5%，且仅限一次性全额付款。",
  "报价有效期 45 天。",
]);
const LEAD_ZH = doc("交付周期.md", "交付周期", [
  "屋顶勘察后至少 6 周才能开始安装。",
  "付了定金才下单订购组件。",
]);
const SURVEYS_ZH = doc("勘察.md", "勘察", [
  "每个屋顶都要单独勘察后才能报价。",
  "勘察约两小时，不收费。",
]);
const UPKEEP_ZH = doc("运维.md", "运维", [
  "组件每年清洗一次，包含在运维套餐中。",
  "运维套餐每年 4,500 元。",
]);
const APP_ZH = doc("监控.md", "监控", ["监控 App 前 2 年免费。", "之后每月 60 元。"]);
const OUTPUT_ZH = doc("年发电量.md", "年发电量", ["50 千瓦系统每年发电约 4.5 万度。"]);
const NEXT_ZH = doc("后续安排.md", "后续安排", ["报价签字后指定一名项目经理。"]);
const RELIEF_ZH = doc("税收优惠.md", "税收优惠", [
  "全部费用可在第一年从应纳税所得额中扣除。",
  "我们提供会计需要的材料。",
]);
const TIMELINE_ZH = doc("时间安排.md", "时间安排", [
  "从签约到并网发电约 10 周。",
  "签约后 5 个工作日内安排屋顶勘察。",
]);

const OFFER_ZH = "如果你们这个季度签约，脚手架的费用我们出。";
const BILLS_ZH = "说实话，就是电费。两年翻了一倍。";
const AFTERNOONS_ZH = "下午，烤炉和冷库全都开着的时候。";
const SURVEY_ZH = "那勘察就定在 5 月 12 日，在总店。";
const QUOTE_ZH = "我周三前把最终报价发给你们。";

const CHINESE: readonly CallHelpCase[] = [
  {
    id: "zh12-answer-price",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "系统大小按你们的屋顶和白天的用电量来定。" },
      { who: "them", text: "装一套 50 千瓦的系统，含安装要多少钱？" },
    ],
    documents: [PRICES_ZH],
    answer: "50 千瓦系统含安装 32 万元。",
    rests: [[line(PRICES_ZH, "50 千瓦屋顶系统")]],
    avoid: "把脚手架或每增加 10 千瓦的价格算进去，或给出价目表没有的总价",
  },
  {
    id: "zh12-answer-two",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "问两个问题：组件质保多久？逆变器呢？" }],
    documents: [WARRANTY_ZH],
    answer: "组件 25 年性能质保；逆变器保修 10 年，包工包料。",
    rests: [[line(WARRANTY_ZH, "25 年")], [line(WARRANTY_ZH, "逆变器")]],
  },
  {
    id: "zh12-answer-unknown",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "施工会避开你们的营业时间。" },
      { who: "them", text: "你们能不能晚上关店以后上屋顶施工？" },
    ],
    documents: [WORKING_ZH],
    answer: "安装人员周一至周六上午 7 点到下午 5 点施工；文档没有说能否夜间施工。",
    rests: [[line(WORKING_ZH, "周一至周六")]],
    avoid: "把能或不能夜间施工当作事实来说",
  },
  {
    id: "zh12-answer-earlier",
    language: "zh-CN",
    kind: "answer",
    needs: "earlier",
    before: [
      { who: "me", text: OFFER_ZH },
      { who: "them", text: "好，我们记一下。" },
    ],
    long: false,
    turns: [
      { who: "me", text: "要不要我介绍一下电池的方案？" },
      { who: "them", text: "先等一下，你一开始说的那个优惠是什么？" },
    ],
    documents: [BATTERIES_ZH],
    answer: "如果这个季度签约，脚手架的费用由他们出：这是用户在通话开头说的。",
    rests: [[said(OFFER_ZH)]],
    avoid: "把其他折扣或价格当作用户的优惠",
  },
  {
    id: "zh12-say-roof",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "我们的屋顶挺旧的，我担心你们一打孔就漏水。" }],
    documents: [ROOF_ZH],
    answer:
      "一个用屋面施工文档回答的选项：施工前由结构工程师检查屋顶，支架用夹具固定在接缝上、不打孔，或安装造成的漏水由安装方负责维修。",
    rests: [[line(ROOF_ZH, "结构工程师"), line(ROOF_ZH, "不在屋顶上打孔"), line(ROOF_ZH, "漏水")]],
    avoid: "文档没有的承诺，比如对整个屋顶质保",
  },
  {
    id: "zh12-say-outage",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "发的电先供你们自己的楼用。" },
      { who: "them", text: "那电网停电怎么办？去年冬天我们停了一整天。" },
    ],
    documents: [OUTAGES_ZH],
    answer:
      "一个用文档回答的选项：没有电池时，停电期间系统会关闭；配了电池，选定的线路最多可以继续供电 6 小时。",
    rests: [[line(OUTAGES_ZH, "没有电池"), line(OUTAGES_ZH, "配了电池")]],
    avoid: "说没有电池时组件也能在停电时继续供电",
  },
  {
    id: "zh12-no-price",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "整个项目二十五万能做吗？" }],
    documents: [PRICING_ZH],
    answer: "礼貌地拒绝 25 万元，同时推进：报价最多下调 5%，且仅限一次性全额付款。",
    rests: [[line(PRICING_ZH, "最多下调 5%")]],
    avoid: "答应 25 万元，或给出价格规则不允许的折扣",
  },
  {
    id: "zh12-no-monday",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "屋顶勘察完，我们一般推进得很快。" },
      { who: "them", text: "太好了，下周一能开工吗？我们想在夏天之前装好。" },
    ],
    documents: [LEAD_ZH],
    answer: "礼貌地拒绝下周一开工：屋顶勘察后至少 6 周才能开始安装；可以提出先约勘察。",
    rests: [[line(LEAD_ZH, "6 周")]],
    avoid: "答应下周一开工",
  },
  {
    id: "zh12-ask-shops",
    language: "zh-CN",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "我们有四家店，其中两家是平屋顶。" },
      { who: "me", text: "明白。" },
    ],
    documents: [SURVEYS_ZH],
    answer: "一个推进到逐个勘察屋顶的问题：每个屋顶都要单独勘察后才能报价，勘察不收费。",
    rests: [[line(SURVEYS_ZH, "单独勘察"), line(SURVEYS_ZH, "两小时")]],
  },
  {
    id: "zh12-check-right",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "你们资料上说组件每年清洗一次，对吧？" },
      { who: "me", text: "我看一下。" },
    ],
    documents: [UPKEEP_ZH],
    answer: "对方说得对：组件每年清洗一次，包含在运维套餐中。",
    rests: [[line(UPKEEP_ZH, "每年清洗一次")]],
  },
  {
    id: "zh12-check-wrong",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "还有，只要系统在用，监控 App 就一直免费。" }],
    documents: [APP_ZH],
    answer: "不对：监控 App 前 2 年免费，之后每月 60 元。",
    rests: [[line(APP_ZH, "前 2 年"), line(APP_ZH, "每月 60 元")]],
    avoid: "说 App 在系统整个使用期内都免费",
  },
  {
    id: "zh12-want-bills",
    language: "zh-CN",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: BILLS_ZH },
      { who: "me", text: "一天里哪段时间电费最贵？" },
      { who: "them", text: AFTERNOONS_ZH },
    ],
    documents: [OUTPUT_ZH],
    answer: "对方想降低电费：两年翻了一倍，下午烤炉和冷库全开的时候最贵。",
    rests: [[said(BILLS_ZH), said(AFTERNOONS_ZH)]],
  },
  {
    id: "zh12-sum",
    language: "zh-CN",
    kind: "sum",
    needs: "whole",
    long: false,
    turns: [
      { who: "me", text: SURVEY_ZH },
      { who: "them", text: "好的，到时候祁嘉禾在那边接你们的工程师。" },
      { who: "me", text: QUOTE_ZH },
      { who: "them", text: "好。" },
    ],
    documents: [NEXT_ZH],
    answer: "几行总结：5 月 12 日在总店勘察；祁嘉禾接工程师；用户周三前发最终报价。",
    rests: [[said(SURVEY_ZH)], [said(QUOTE_ZH)]],
  },
  {
    id: "zh12-answer-relief",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "这个项目有没有什么税收优惠可以用？" }],
    documents: [RELIEF_ZH],
    answer: "有：全部费用可在第一年从应纳税所得额中扣除；安装方提供会计需要的材料。",
    rests: [[line(RELIEF_ZH, "全部费用")]],
    avoid: "文档没有的补贴或优惠",
  },
  {
    id: "zh12-say-autumn",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "我们希望秋天旺季之前就能用上。" }],
    documents: [TIMELINE_ZH],
    answer: "一个选项：从签约到并网发电约 10 周，或签约后 5 个工作日内安排屋顶勘察。",
    rests: [[line(TIMELINE_ZH, "10 周"), line(TIMELINE_ZH, "5 个工作日")]],
    avoid: "给出文档没有的并网日期",
  },
];

export const CALL_HELP_MARKS_3: readonly CallHelpCase[] = [...ENGLISH, ...CHINESE];
