/**
 * A fresh slice of call-help cases (#2526): written and committed on 2026-11-07, before any run on
 * it and after the fix the marks-passages gate's first runs led to (`gates/call-help-marks-passages.md`),
 * so that fix is judged on presses it never met. The same vendor and rollout talk as
 * `callHelpCases.ts`, with Documents of its own: fuel cards, route planning, security, support
 * plans and the drivers' app. Every name, figure and Document is made up.
 */
import { type CallHelpCase, line } from "./callHelpCases";

const FUEL_EN = {
  file: "Fuel cards.md",
  text: [
    "# Fuel cards",
    "",
    "- The fuel card add-on costs $4 per vehicle a month.",
    "- Spend limits are set per driver.",
    "- Statements come monthly, by the 5th.",
  ].join("\n"),
};
const ROUTES_EN = {
  file: "Route planning.md",
  text: [
    "# Route planning",
    "",
    "- Routes are re-planned every 15 minutes during the day.",
    "- A route holds up to 200 stops.",
    "- Live traffic data is included on Enterprise only.",
  ].join("\n"),
};
const SECURITY_EN = {
  file: "Security.md",
  text: [
    "# Security",
    "",
    "- Data is encrypted at rest with AES-256.",
    "- Admins must sign in with two-factor authentication.",
    "- We are ISO 27001 certified, and the certificate renews each April.",
    "- Penetration tests run twice a year.",
  ].join("\n"),
};
const SUPPORT_EN = {
  file: "Support plans.md",
  text: [
    "# Support plans",
    "",
    "- Standard support: email, with replies within one business day.",
    "- Premium support: $600 a month, with a named support manager and phone support.",
  ].join("\n"),
};
const APP_EN = {
  file: "Driver app.md",
  text: [
    "# Driver app",
    "",
    "- The driver app runs on Android 11 and later, and on iOS 16 and later.",
    "- Proof of delivery takes a photo and a signature.",
    "- The app works in 14 languages, Polish and Romanian among them.",
  ].join("\n"),
};

const FUEL_ZH = {
  file: "油卡服务.md",
  text: [
    "# 油卡服务",
    "",
    "- 油卡增值服务：每辆车每月 25 元。",
    "- 消费额度按司机设置。",
    "- 账单每月 5 号前出具。",
  ].join("\n"),
};
const ROUTES_ZH = {
  file: "路线规划.md",
  text: [
    "# 路线规划",
    "",
    "- 白天每 15 分钟重新规划一次路线。",
    "- 每条路线最多 200 个站点。",
    "- 实时路况仅企业版提供。",
  ].join("\n"),
};
const SECURITY_ZH = {
  file: "安全合规.md",
  text: [
    "# 安全合规",
    "",
    "- 静态数据采用 AES-256 加密。",
    "- 管理员必须开启双重验证登录。",
    "- 已通过 ISO 27001 认证，证书每年四月更新。",
    "- 每年进行两次渗透测试。",
  ].join("\n"),
};
const SUPPORT_ZH = {
  file: "支持方案.md",
  text: [
    "# 支持方案",
    "",
    "- 标准支持：邮件，一个工作日内回复。",
    "- 高级支持：每月 4,000 元，配专属支持经理和电话支持。",
  ].join("\n"),
};
const APP_ZH = {
  file: "司机端应用.md",
  text: [
    "# 司机端应用",
    "",
    "- 司机端支持安卓 11 及以上、iOS 16 及以上。",
    "- 签收凭证包括拍照和签名。",
    "- 应用支持 14 种语言，包括维吾尔语和藏语。",
  ].join("\n"),
};

const EN_PROOF = "Proof of delivery takes a photo and a signature.";
const ZH_PROOF = "签收凭证包括拍照和签名。";

export const CALL_HELP_FRESH: readonly CallHelpCase[] = [
  {
    id: "en3-answer-security",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "That's the product side. Anything from your security team?" },
      {
        who: "them",
        text: "Yes. Are you ISO 27001 certified, and when does the certificate renew?",
      },
    ],
    documents: [SECURITY_EN],
    answer: "Yes, ISO 27001 certified; the certificate renews each April.",
    rests: [[line(SECURITY_EN, "ISO 27001")]],
  },
  {
    id: "en3-answer-android",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "One practical thing about the phones." },
      { who: "them", text: "Will the driver app run on our old Android 10 phones?" },
    ],
    documents: [APP_EN],
    answer:
      "No: the driver app needs Android 11 or later (or iOS 16 or later), so Android 10 phones won't run it.",
    rests: [[line(APP_EN, "Android 11")]],
    avoid: "that the app runs on Android 10",
  },
  {
    id: "en3-answer-two",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "And fuel cards come as an add-on." },
      {
        who: "them",
        text: "How much is the fuel card add-on, and when do the statements arrive?",
      },
    ],
    documents: [FUEL_EN],
    answer: "$4 per vehicle a month; statements come monthly, by the 5th.",
    rests: [[line(FUEL_EN, "$4 per vehicle")], [line(FUEL_EN, "Statements")]],
  },
  {
    id: "en3-say-support",
    language: "en",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "Our last vendor made us wait a whole week for answers from support.",
      },
    ],
    documents: [SUPPORT_EN],
    answer:
      "An option that answers with the support plans: standard email replies within one business day, or Premium at $600 a month with a named manager and phone support.",
    rests: [[line(SUPPORT_EN, "Standard support"), line(SUPPORT_EN, "Premium support")]],
    avoid: "a support promise the plans don't make, such as replies within the hour",
  },
  {
    id: "en3-ask-stops",
    language: "en",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "So routes are planned for you each morning." },
      { who: "them", text: "Some of our routes are huge, especially before the holidays." },
    ],
    documents: [ROUTES_EN],
    answer:
      "A question asking how many stops their largest routes have, since a route holds up to 200 stops.",
    rests: [[line(ROUTES_EN, "200 stops")]],
  },
  {
    id: "en3-check-wrong",
    language: "en",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "So routes get re-planned every minute, and live traffic comes with every plan, right?",
      },
    ],
    documents: [ROUTES_EN],
    answer:
      "Both claims are contradicted: routes are re-planned every 15 minutes during the day, and live traffic data is Enterprise only.",
    rests: [[line(ROUTES_EN, "re-planned")], [line(ROUTES_EN, "Live traffic")]],
    avoid: "that either claim is supported",
  },
  {
    id: "en3-no-traffic",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "The Team plan covers everything you listed so far." },
      { who: "them", text: "Could you throw in the live traffic data on the Team plan?" },
    ],
    documents: [ROUTES_EN],
    answer:
      "Declines adding live traffic to the Team plan, since it is included on Enterprise only.",
    rests: [[line(ROUTES_EN, "Live traffic")]],
    avoid: "including live traffic data on the Team plan",
  },
  {
    id: "en3-check-right",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "Our customers keep asking how deliveries are confirmed." },
      { who: "me", text: EN_PROOF },
      { who: "them", text: "Good, they want both." },
    ],
    documents: [APP_EN],
    answer: "Supported: proof of delivery takes a photo and a signature, as the app's sheet says.",
    rests: [[line(APP_EN, "Proof of delivery")]],
  },

  {
    id: "zh3-answer-security",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "产品这块就是这些。你们安全团队有问题吗？" },
      { who: "them", text: "有。你们有 ISO 27001 认证吗？证书什么时候更新？" },
    ],
    documents: [SECURITY_ZH],
    answer: "有，已通过 ISO 27001 认证，证书每年四月更新。",
    rests: [[line(SECURITY_ZH, "ISO 27001")]],
  },
  {
    id: "zh3-answer-android",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "还有个手机的实际问题。" },
      { who: "them", text: "我们司机用的老安卓 10 手机能装你们的应用吗？" },
    ],
    documents: [APP_ZH],
    answer: "不能：司机端需要安卓 11 及以上（或 iOS 16 及以上），安卓 10 的手机装不了。",
    rests: [[line(APP_ZH, "安卓 11")]],
    avoid: "说安卓 10 可以用",
  },
  {
    id: "zh3-answer-two",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "油卡是单独的增值服务。" },
      { who: "them", text: "油卡服务每辆车多少钱？账单什么时候出？" },
    ],
    documents: [FUEL_ZH],
    answer: "每辆车每月 25 元；账单每月 5 号前出具。",
    rests: [[line(FUEL_ZH, "每辆车")], [line(FUEL_ZH, "账单")]],
  },
  {
    id: "zh3-say-support",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "上一家供应商的售后要等一个星期才回复。" }],
    documents: [SUPPORT_ZH],
    answer:
      "用支持方案回应：标准支持邮件一个工作日内回复，或高级支持每月 4,000 元，配专属支持经理和电话支持。",
    rests: [[line(SUPPORT_ZH, "标准支持"), line(SUPPORT_ZH, "高级支持")]],
    avoid: "方案里没有的承诺，比如一小时内回复",
  },
  {
    id: "zh3-ask-stops",
    language: "zh-CN",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "所以每天早上会帮你们排好路线。" },
      { who: "them", text: "我们有些线路特别长，节前尤其多。" },
    ],
    documents: [ROUTES_ZH],
    answer: "问他们最长的线路有多少个站点，因为每条路线最多 200 个站点。",
    rests: [[line(ROUTES_ZH, "200 个站点")]],
  },
  {
    id: "zh3-check-wrong",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "那路线是每分钟重新规划一次，而且所有版本都有实时路况，对吧？" }],
    documents: [ROUTES_ZH],
    answer: "两条都不对：白天每 15 分钟重新规划一次；实时路况仅企业版提供。",
    rests: [[line(ROUTES_ZH, "重新规划")], [line(ROUTES_ZH, "实时路况")]],
    avoid: "说任何一条有依据",
  },
  {
    id: "zh3-no-traffic",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "你们目前列的需求，团队版都能覆盖。" },
      { who: "them", text: "团队版能不能也送实时路况？" },
    ],
    documents: [ROUTES_ZH],
    answer: "婉拒给团队版加实时路况，说明实时路况仅企业版提供。",
    rests: [[line(ROUTES_ZH, "实时路况")]],
    avoid: "答应团队版也有实时路况",
  },
  {
    id: "zh3-check-right",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "我们客户一直问怎么确认送达。" },
      { who: "me", text: ZH_PROOF },
      { who: "them", text: "好，他们两样都要。" },
    ],
    documents: [APP_ZH],
    answer: "有依据：司机端应用写明签收凭证包括拍照和签名。",
    rests: [[line(APP_ZH, "签收凭证")]],
  },
];
