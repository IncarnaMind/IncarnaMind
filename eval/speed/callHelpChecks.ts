/**
 * A fresh call-help slice (#2526): written and committed on 2026-11-08, before any run on it and
 * after the marks-passages gate's third look, whose English "cited" fell where a reply checking
 * what was said named only the call's line (`gates/call-help-marks-passages.md`). Three of each
 * language's ten presses check what was said against a Document that supports it. A shift
 * scheduling vendor selling to a restaurant group; every name, figure and Document is made up, and
 * no Document or press is in a set before it.
 */
import { type CallHelpCase, line } from "./callHelpCases";

const PLANS_EN = {
  file: "Scheduling plans.md",
  text: [
    "# Scheduling plans",
    "",
    "Every plan includes the shift calendar, the staff app and shift swaps between staff. Plans differ in how many locations they cover, how far ahead shifts can be published and whether labour-cost forecasts come with them.",
    "",
    "| Plan | Price per location a month | Locations | Publish ahead |",
    "|---|---|---|---|",
    "| Starter | $49 | up to 2 | 2 weeks |",
    "| Growth | $89 | up to 10 | 6 weeks |",
    "| Chain | $139 | unlimited | 12 weeks |",
    "",
    "Labour-cost forecasts are included on Growth and Chain. On Starter, they cost $15 per location a month.",
    "",
    "From 20 locations, Chain drops to $119 a location a month. Prices are fixed for the first 18 months; after that, the yearly increase is capped at 3%.",
  ].join("\n"),
};
const KIOSKS_EN = {
  file: "Time clock kiosks.md",
  text: [
    "# Time clock kiosks",
    "",
    "Staff clock in on a wall-mounted tablet kiosk with a face check, or on their phones within 150 metres of the location.",
    "",
    "Each kiosk costs $240 and comes with a two-year warranty. A broken kiosk is swapped within 2 business days.",
    "",
    "Kiosks keep working offline for up to 72 hours and send the punches once they are back online. One kiosk serves up to 60 staff; most locations with more staff put in a second one.",
  ].join("\n"),
};
const PAYROLL_EN = {
  file: "Payroll export.md",
  text: [
    "# Payroll export",
    "",
    "Hours are exported to the payroll system every pay period, weekly or every two weeks, as the location sets it.",
    "",
    "Overtime is worked out after 40 hours a week by default; a location can set it to daily overtime after 8 hours instead. Tips can be split by hours worked or by role, set per location.",
    "",
    "An export that fails is retried every 30 minutes for 6 hours, and the manager gets an email after the first failure.",
  ].join("\n"),
};
const PRIVACY_EN = {
  file: "Data and privacy.md",
  text: [
    "# Data and privacy",
    "",
    "Staff data is stored in the EU, in Frankfurt, and is never sold or shared for advertising.",
    "",
    "Face checks keep no photo: the kiosk keeps only a face template, deleted 30 days after a staff member leaves.",
    "",
    "Punch records are kept for 7 years, as payroll law asks, and can be exported as CSV at any time. Admins sign in with single sign-on on Chain; on Starter and Growth they use two-factor authentication.",
  ].join("\n"),
};

const PLANS_ZH = {
  file: "排班方案.md",
  text: [
    "# 排班方案",
    "",
    "所有方案都包含排班日历、员工端应用和员工之间换班。各方案的区别在于覆盖多少门店、能提前多久发布排班，以及是否含人工成本预测。",
    "",
    "| 方案 | 每家门店每月 | 门店数 | 提前发布 |",
    "|---|---|---|---|",
    "| 入门版 | 299 元 | 最多 2 家 | 2 周 |",
    "| 成长版 | 549 元 | 最多 10 家 | 6 周 |",
    "| 连锁版 | 869 元 | 不限 | 12 周 |",
    "",
    "成长版和连锁版含人工成本预测；入门版每家门店每月另收 99 元。",
    "",
    "20 家门店起，连锁版降到每家每月 749 元。前 18 个月价格不变，之后每年涨幅不超过 3%。",
  ].join("\n"),
};
const KIOSKS_ZH = {
  file: "打卡终端.md",
  text: [
    "# 打卡终端",
    "",
    "员工在门店墙上的平板终端刷脸打卡，也可以在门店 150 米内用手机打卡。",
    "",
    "每台终端 1,600 元，含两年保修。终端故障 2 个工作日内换新。",
    "",
    "终端断网可继续使用最多 72 小时，联网后自动上传打卡记录。一台终端最多服务 60 名员工，员工更多的门店一般再装一台。",
  ].join("\n"),
};
const PAYROLL_ZH = {
  file: "工资导出.md",
  text: [
    "# 工资导出",
    "",
    "工时按每个发薪周期导出到工资系统，每周或每两周一次，由门店设置。",
    "",
    "加班默认按每周超过 40 小时计算；门店也可以改为每天超过 8 小时计加班。小费可以按工时或按岗位分配，由门店设置。",
    "",
    "导出失败后每 30 分钟重试一次，持续 6 小时，第一次失败后店长会收到邮件。",
  ].join("\n"),
};
const PRIVACY_ZH = {
  file: "数据与隐私.md",
  text: [
    "# 数据与隐私",
    "",
    "员工数据存储在欧盟法兰克福，绝不出售，也不用于广告。",
    "",
    "刷脸打卡不保存照片：终端只保存人脸模板，员工离职 30 天后删除。",
    "",
    "打卡记录保存 7 年，符合工资法规要求，可随时导出为 CSV。连锁版管理员用单点登录；入门版和成长版用双重验证登录。",
  ].join("\n"),
};

export const CALL_HELP_CHECKS: readonly CallHelpCase[] = [
  {
    id: "en5-answer-growth",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Most groups your size start on Growth." },
      {
        who: "them",
        text: "What does Growth cost per location, and how far ahead can we publish shifts?",
      },
    ],
    documents: [PLANS_EN, KIOSKS_EN],
    answer: "$89 per location a month, with shifts published up to 6 weeks ahead.",
    rests: [[line(PLANS_EN, "| Growth")]],
    avoid: "Starter's or Chain's price or publishing window as Growth's",
  },
  {
    id: "en5-answer-volume",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "We run 24 restaurants. What would Chain cost per location at that size?",
      },
    ],
    documents: [PLANS_EN, PAYROLL_EN],
    answer: "$119 a location a month: from 20 locations, Chain drops from $139 to $119.",
    rests: [[line(PLANS_EN, "From 20 locations")]],
    avoid: "$139 as the price at 24 locations",
  },
  {
    id: "en5-answer-offline",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "If the internet goes down, how long do the kiosks keep working?" },
    ],
    documents: [KIOSKS_EN],
    answer: "Up to 72 hours offline; the punches are sent once the kiosk is back online.",
    rests: [[line(KIOSKS_EN, "offline")]],
    avoid: "a time other than 72 hours",
  },
  {
    id: "en5-check-overtime",
    language: "en",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "me",
        text: "Overtime counts after 40 hours a week, unless you switch a location to daily overtime after 8 hours.",
      },
      { who: "them", text: "Okay, that matches what our payroll lead expected." },
    ],
    documents: [PAYROLL_EN, PRIVACY_EN],
    answer:
      "Supported: overtime is worked out after 40 hours a week by default, or daily after 8 hours if a location sets it.",
    rests: [[line(PAYROLL_EN, "Overtime")]],
    avoid: "that any part is contradicted",
  },
  {
    id: "en5-check-photos",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "Our staff are worried about their photos being kept." },
      {
        who: "me",
        text: "The kiosk keeps no photo, only a face template, and that is deleted 30 days after someone leaves.",
      },
      { who: "them", text: "That should calm them down." },
    ],
    documents: [PRIVACY_EN, KIOSKS_EN],
    answer:
      "Supported: face checks keep no photo, only a template, deleted 30 days after a staff member leaves.",
    rests: [[line(PRIVACY_EN, "Face checks")]],
    avoid: "that photos are kept",
  },
  {
    id: "en5-check-warranty",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Each kiosk is $240 and comes with a two-year warranty." },
      { who: "them", text: "Good, finance asked about exactly that." },
    ],
    documents: [KIOSKS_EN, PLANS_EN],
    answer: "Supported: each kiosk costs $240 with a two-year warranty.",
    rests: [[line(KIOSKS_EN, "Each kiosk costs")]],
    avoid: "another price or warranty",
  },
  {
    id: "en5-check-wrong",
    language: "en",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "So punch records are kept for three years, and admins on Growth get single sign-on, right?",
      },
    ],
    documents: [PRIVACY_EN],
    answer:
      "Both are contradicted: punch records are kept for 7 years, and single sign-on is on Chain only; Growth admins use two-factor authentication.",
    rests: [[line(PRIVACY_EN, "Punch records")]],
    avoid: "that either claim is supported",
  },
  {
    id: "en5-say-export",
    language: "en",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "With our last vendor the payroll export failed without anyone noticing, and staff were paid late.",
      },
    ],
    documents: [PAYROLL_EN, KIOSKS_EN],
    answer:
      "Reassures with what the Documents say: a failed export is retried every 30 minutes for 6 hours, and the manager gets an email after the first failure.",
    rests: [[line(PAYROLL_EN, "An export that fails")]],
    avoid: "a promise the Documents don't make, such as a phone call or a fix within the hour",
  },
  {
    id: "en5-ask-staff",
    language: "en",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "We'd like a kiosk at every location." }],
    documents: [KIOSKS_EN],
    answer:
      "A question asking how many staff each location has, since one kiosk serves up to 60 staff.",
    rests: [[line(KIOSKS_EN, "offline")]],
  },
  {
    id: "en5-no-forecasts",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Starter keeps it simple for two locations." },
      { who: "them", text: "Could you include the labour-cost forecasts on Starter for free?" },
    ],
    documents: [PLANS_EN],
    answer:
      "Declines: forecasts are included on Growth and Chain, and on Starter they cost $15 per location a month.",
    rests: [[line(PLANS_EN, "Labour-cost forecasts")]],
    avoid: "including forecasts on Starter for free",
  },

  {
    id: "zh5-answer-growth",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "你们这个规模的连锁一般从成长版开始。" },
      { who: "them", text: "成长版每家门店多少钱？排班能提前多久发布？" },
    ],
    documents: [PLANS_ZH, KIOSKS_ZH],
    answer: "每家门店每月 549 元，排班最多提前 6 周发布。",
    rests: [[line(PLANS_ZH, "| 成长版")]],
    avoid: "把入门版或连锁版的价格或发布时间说成成长版的",
  },
  {
    id: "zh5-answer-volume",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "我们有 24 家餐厅，连锁版每家门店多少钱？" }],
    documents: [PLANS_ZH, PAYROLL_ZH],
    answer: "每家每月 749 元：20 家门店起，连锁版从 869 元降到 749 元。",
    rests: [[line(PLANS_ZH, "20 家门店起")]],
    avoid: "把 869 元说成 24 家门店时的价格",
  },
  {
    id: "zh5-answer-offline",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "断网的话，打卡终端还能用多久？" }],
    documents: [KIOSKS_ZH],
    answer: "断网最多可继续使用 72 小时，联网后自动上传打卡记录。",
    rests: [[line(KIOSKS_ZH, "断网")]],
    avoid: "72 小时以外的时长",
  },
  {
    id: "zh5-check-overtime",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      { who: "me", text: "加班默认按每周超过 40 小时算，门店也可以改成每天超过 8 小时算。" },
      { who: "them", text: "好，跟我们工资主管想的一样。" },
    ],
    documents: [PAYROLL_ZH, PRIVACY_ZH],
    answer: "有依据：加班默认按每周超过 40 小时计算，门店也可以改为每天超过 8 小时。",
    rests: [[line(PAYROLL_ZH, "加班默认")]],
    avoid: "说其中有不对的地方",
  },
  {
    id: "zh5-check-photos",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "员工担心照片会被一直存着。" },
      { who: "me", text: "终端不保存照片，只保存人脸模板，员工离职 30 天后就删除。" },
      { who: "them", text: "这样大家就放心了。" },
    ],
    documents: [PRIVACY_ZH, KIOSKS_ZH],
    answer: "有依据：刷脸打卡不保存照片，只保存人脸模板，员工离职 30 天后删除。",
    rests: [[line(PRIVACY_ZH, "刷脸打卡不保存照片")]],
    avoid: "说会保存照片",
  },
  {
    id: "zh5-check-warranty",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "每台终端 1,600 元，含两年保修。" },
      { who: "them", text: "好，财务正好问过这个。" },
    ],
    documents: [KIOSKS_ZH, PLANS_ZH],
    answer: "有依据：每台终端 1,600 元，含两年保修。",
    rests: [[line(KIOSKS_ZH, "每台终端")]],
    avoid: "别的价格或保修期",
  },
  {
    id: "zh5-check-wrong",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "打卡记录保存 3 年，成长版管理员也能用单点登录，对吧？" }],
    documents: [PRIVACY_ZH],
    answer: "两点都不对：打卡记录保存 7 年；单点登录仅连锁版有，成长版管理员用双重验证登录。",
    rests: [[line(PRIVACY_ZH, "打卡记录")]],
    avoid: "说其中任何一点有依据",
  },
  {
    id: "zh5-say-export",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "上一家供应商的工资导出悄悄失败了，没人发现，员工工资都发晚了。" },
    ],
    documents: [PAYROLL_ZH, KIOSKS_ZH],
    answer:
      "用文档里的说法安抚：导出失败后每 30 分钟重试一次、持续 6 小时，第一次失败后店长会收到邮件。",
    rests: [[line(PAYROLL_ZH, "导出失败")]],
    avoid: "文档里没有的承诺，比如打电话通知或一小时内修好",
  },
  {
    id: "zh5-ask-staff",
    language: "zh-CN",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "我们想每家门店都装一台打卡终端。" }],
    documents: [KIOSKS_ZH],
    answer: "问每家门店有多少员工，因为一台终端最多服务 60 名员工。",
    rests: [[line(KIOSKS_ZH, "断网")]],
  },
  {
    id: "zh5-no-forecasts",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "入门版两家店用起来最简单。" },
      { who: "them", text: "入门版能免费送人工成本预测吗？" },
    ],
    documents: [PLANS_ZH],
    answer: "婉拒：成长版和连锁版含人工成本预测，入门版每家门店每月另收 99 元。",
    rests: [[line(PLANS_ZH, "成长版和连锁版含人工成本预测")]],
    avoid: "答应入门版免费送人工成本预测",
  },
];
