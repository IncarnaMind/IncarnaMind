/**
 * The call-help set's cases (#2526), held out: written and committed before any run of a faster
 * call-help path, and never shown to a prompt. Each is a sales call heard live, in English or
 * Chinese, with a button pressed at its end, in a Library of only the case's own Documents. A long
 * call has a stretch of talk about the rollout (`ROLLOUT`) in its middle, so a case whose reply
 * needs a line said before it (`needs: "earlier"`) or the whole call (`"whole"`) can tell a path
 * that reads only the newest lines from one that reads the call. Every name, figure and Document
 * is made up.
 */
import type { GeneralHelpKind } from "../../src/shared/meetingHelp";

export interface CallTurn {
  /** The User (the microphone) or the other side (the computer's sound). */
  who: "me" | "them";
  text: string;
}

export interface CallDocument {
  /** A Markdown file's name: the Document is named without ".md". */
  file: string;
  text: string;
}

export interface CallHelpCase {
  id: string;
  language: "en" | "zh-CN";
  kind: GeneralHelpKind;
  /** What the reply needs of the call: its newest lines, a line said before the rollout talk, or all of it. */
  needs: "newest" | "earlier" | "whole";
  /** Said first; then the rollout talk when `long`; then `turns`. */
  before?: readonly CallTurn[];
  long: boolean;
  turns: readonly CallTurn[];
  documents: readonly CallDocument[];
  /** What a right reply gives, for the judge. */
  answer: string;
  /**
   * The Passages it rests on: each group a line of a Document (by file) or of the call
   * ("transcript"), any one of which a found Citation must quote for the group to be cited.
   */
  rests: readonly (readonly { in: string; line: string }[])[];
  /** What the reply must not give as so. */
  avoid?: string;
}

/** Where a line said in the call is, in `rests`. */
export const TRANSCRIPT = "transcript";

const ROLLOUT_EN: readonly CallTurn[] = [
  {
    who: "them",
    text: "Before we get into the numbers, can you walk us through how the first two weeks usually go? Our operations lead wants to know who on our side needs to be in the room and how much of their time it takes.",
  },
  {
    who: "me",
    text: "Sure. The first week is mostly a kickoff and a data review. We meet your operations lead for about an hour on day one, then our onboarding team looks at a sample export and sends a short list of questions by the end of the week.",
  },
  {
    who: "them",
    text: "That sounds manageable. Our exports come out of an old warehouse system, so the column names are a bit of a mess. Is that something your team cleans up, or do we need to map everything ourselves first?",
  },
  {
    who: "me",
    text: "We do the mapping with you. You send the export as it is, and we come back with a mapping sheet. Someone on your side checks it line by line, which usually takes an afternoon, and then we run a trial import.",
  },
  {
    who: "them",
    text: "Okay. And the trial import, does that touch our live data at all, or is it a separate space where people can poke around without breaking anything?",
  },
  {
    who: "me",
    text: "It's a separate workspace. Nothing in it reaches your live system, and we usually leave it open for a couple of weeks so your team can try things and get used to the screens before anything goes live.",
  },
  {
    who: "them",
    text: "Good, because our dispatch team is nervous about change. A few of them have been doing it the same way for fifteen years, and the last tool we rolled out was dropped after a month because nobody trusted the numbers.",
  },
  {
    who: "me",
    text: "That's common, and it's worth planning for. What tends to help is picking two or three people from dispatch early, letting them use the trial workspace first, and having them show the others. People trust a colleague more than a trainer.",
  },
  {
    who: "them",
    text: "I like that. I can think of two people who'd be good at it. One of them is very sceptical, which might actually help, because if she's convinced, everyone else will follow.",
  },
  {
    who: "me",
    text: "Sceptics make the best champions. We can set up a separate session just for those two, where they bring the trickiest jobs from last month and we run them through the tool together.",
  },
  {
    who: "them",
    text: "Let's do that. On the technical side, our IT team asked whether you connect to the calendar system we use for driver shifts, or whether shifts have to be typed in by hand.",
  },
  {
    who: "me",
    text: "We connect to the common calendar systems through a standard feed. If yours can publish a feed, shifts come in automatically every fifteen minutes. If it can't, there's an import from a spreadsheet, which some customers run once a day.",
  },
  {
    who: "them",
    text: "I think it can publish a feed, but I'll have to check with IT. They're in the middle of a server move, so they're a bit slow to answer anything right now.",
  },
  {
    who: "me",
    text: "No rush on that. It doesn't block the trial, because the trial can run on a spreadsheet import. We'd only need the feed before going live, and we can switch over in an afternoon.",
  },
  {
    who: "them",
    text: "Okay. What about training? We have people on three shifts, so getting everyone into one room isn't going to happen.",
  },
  {
    who: "me",
    text: "Training is split into short recorded lessons of about ten minutes each, plus two live sessions at times that suit your shifts. Most people need the first three lessons only, and the rest are for supervisors.",
  },
  {
    who: "them",
    text: "Recorded lessons are good. Are they in English only? About a third of our warehouse staff are more comfortable in Polish.",
  },
  {
    who: "me",
    text: "The lessons have subtitles in several languages, Polish among them, and the screens themselves can be switched per person. A supervisor can see the screen in English while the person next to them sees it in Polish.",
  },
  {
    who: "them",
    text: "That's helpful. Then there's reporting. Every Monday our managers get a spreadsheet with last week's deliveries, late jobs and fuel use. Can that come out of your system without someone building it by hand?",
  },
  {
    who: "me",
    text: "Yes. The weekly report can be scheduled, and it goes out by email as a spreadsheet or a link. We'd rebuild your current Monday report during onboarding so managers get the same columns they're used to.",
  },
  {
    who: "them",
    text: "Same columns would be important. Our finance director has a whole set of formulas sitting on top of that spreadsheet, and he will not be happy if they break.",
  },
  {
    who: "me",
    text: "Then we'll ask for a copy of last Monday's file and match it column for column. If a column needs to change, we'll flag it before it goes out, so nothing breaks on his side.",
  },
  {
    who: "them",
    text: "Good. One more practical thing. Who do we call when something goes wrong early in the morning? Our first shift starts before six.",
  },
  {
    who: "me",
    text: "You'd have a named onboarding contact for the first three months, and after that the regular support team. I'll put who picks up when in writing so there's no confusion.",
  },
];

const ROLLOUT_ZH: readonly CallTurn[] = [
  {
    who: "them",
    text: "在谈价格之前，能先讲讲头两周一般怎么安排吗？我们运营负责人想知道我们这边需要谁参加，大概要占用他们多少时间。",
  },
  {
    who: "me",
    text: "可以。第一周主要是启动会和数据梳理。第一天我们跟你们运营负责人开一个小时左右的会，然后实施团队看一份样例导出数据，周末前把问题清单发给你们。",
  },
  {
    who: "them",
    text: "听起来不难。我们的导出数据来自一套老的仓储系统，字段名比较乱。这个是你们来整理，还是我们得先自己把字段都对好？",
  },
  {
    who: "me",
    text: "字段对应我们跟你们一起做。你们按原样把数据导出来发给我们，我们出一份字段对应表，你们这边找人逐行核对，一般一个下午就够了，然后我们做一次试导入。",
  },
  {
    who: "them",
    text: "好。试导入会不会动到我们的正式数据？还是在单独的环境里，大家随便点也不会弄坏东西？",
  },
  {
    who: "me",
    text: "是单独的工作区，里面的东西不会进入你们的正式系统。我们一般会开放两周左右，让你们团队先上手试用，熟悉界面，再正式上线。",
  },
  {
    who: "them",
    text: "那就好，我们调度组的人对变化比较抵触。有几位用老办法做了十几年，上一个工具推了一个月就没人用了，因为大家不信里面的数字。",
  },
  {
    who: "me",
    text: "这种情况很常见，值得提前准备。比较有效的做法是先从调度组挑两三个人，让他们先在试用环境里用起来，再由他们带其他人。同事说的话比培训老师更让人信服。",
  },
  {
    who: "them",
    text: "这个思路好。我想到两个人挺合适，其中一位特别较真，不过这反而是好事，她要是认可了，其他人都会跟着来。",
  },
  {
    who: "me",
    text: "较真的人往往是最好的推广者。我们可以单独给这两位安排一场，让他们带上上个月最棘手的几单，我们一起在系统里跑一遍。",
  },
  {
    who: "them",
    text: "就这么办。技术方面，我们 IT 问你们能不能对接我们排司机班次用的日历系统，还是班次得手工录入？",
  },
  {
    who: "me",
    text: "常见的日历系统我们都能通过标准订阅源对接。如果你们的系统能发布订阅源，班次每十五分钟自动同步一次；不能的话，也可以用表格导入，有些客户每天导一次。",
  },
  {
    who: "them",
    text: "应该能发布订阅源，不过我得找 IT 确认。他们正在搬服务器，最近回消息都比较慢。",
  },
  {
    who: "me",
    text: "这个不急，不影响试用，试用阶段用表格导入就行。正式上线前接上订阅源就可以，切换一个下午就能完成。",
  },
  {
    who: "them",
    text: "好。那培训呢？我们是三班倒，把所有人叫到一个会议室里不太现实。",
  },
  {
    who: "me",
    text: "培训分成每节十分钟左右的录播课，再加两场直播，时间按你们的班次来定。大部分人只需要看前三节，后面几节是给主管看的。",
  },
  {
    who: "them",
    text: "录播课挺好。有字幕吗？仓库有些同事更习惯看字幕，不太习惯光听。",
  },
  {
    who: "me",
    text: "录播课都配了字幕，界面也可以按人切换显示方式，主管看到的和旁边同事看到的可以不一样。",
  },
  {
    who: "them",
    text: "这个有用。还有报表。每周一我们的经理会收到一份表格，有上周的配送量、延误单和油耗。你们系统能直接出这个吗？不用人手工做？",
  },
  {
    who: "me",
    text: "可以。周报可以设成定时发送，用邮件发表格或者链接。实施期间我们会把你们现在的周一报表照着重做一份，经理看到的还是熟悉的那些列。",
  },
  {
    who: "them",
    text: "列一样很重要。我们财务总监在那张表上面搭了一整套公式，公式要是坏了他肯定不高兴。",
  },
  {
    who: "me",
    text: "那我们先要一份上周一的文件，一列一列对齐。如果哪一列需要改，发出去之前我们会先提醒，保证他那边不受影响。",
  },
  {
    who: "them",
    text: "好。还有个实际问题：早上出了问题找谁？我们早班六点前就开始了。",
  },
  {
    who: "me",
    text: "头三个月你们会有一位专门的实施对接人，之后转到常规支持团队。谁在什么时间接，我会书面写清楚，免得到时候搞不清。",
  },
];

/** The rollout talk in a case's language. */
export const rolloutOf = (language: "en" | "zh-CN") =>
  language === "en" ? ROLLOUT_EN : ROLLOUT_ZH;

const PRICES_2026_EN = {
  file: "Price sheet 2026.md",
  text: [
    "# Price sheet 2026",
    "",
    "- Team plan: $25 per seat a month.",
    "- Enterprise plan: $45 per seat a month, single sign-on included.",
    "- Volume: 10% off Enterprise from 40 seats.",
    "- Annual prepay: two months free.",
    "- Setup fee: $1,500, once.",
    "- Pilot: 30 days, free; it can be extended once by 30 days.",
  ].join("\n"),
};
const PRICES_2025_EN = {
  file: "Price sheet 2025.md",
  text: [
    "# Price sheet 2025",
    "",
    "- Team plan: $22 per seat a month.",
    "- Enterprise plan: $40 per seat a month, single sign-on included.",
    "- Volume: 8% off Enterprise from 50 seats.",
    "- Setup fee: $1,200, once.",
  ].join("\n"),
};
const TERMS_EN = {
  file: "Service terms.md",
  text: [
    "# Service terms",
    "",
    "- Uptime commitment: 99.9% each month; below it, a service credit of 5% of that month's fee.",
    "- Support: email, weekdays 8:00 to 18:00 CET; Enterprise adds a phone line, same hours.",
    "- Data is hosted in Frankfurt and Dublin.",
    "- Either party may end the agreement with 60 days' written notice.",
    "- We give 90 days' notice of any price change.",
  ].join("\n"),
};
const POLICY_EN = {
  file: "Pricing policy.md",
  text: [
    "# Pricing policy",
    "",
    "- Annual price increases are capped at 5%.",
    "- The setup fee can be halved for registered charities; it is never waived.",
    "- Early renewal discount: up to 15%, approved by the account manager.",
  ].join("\n"),
};
const ADD_ON_EN = {
  file: "Support add-on.md",
  text: [
    "# Support add-on",
    "",
    "- The support add-on is priced by the number of support agents: $12 per agent a month.",
    "- It includes a shared inbox and reply templates.",
  ].join("\n"),
};
const MIGRATION_EN = {
  file: "Migration service.md",
  text: [
    "# Migration service",
    "",
    "- We move up to 10 years of records, checked line by line, included in Enterprise.",
    "- On the Team plan, migration costs $2,000.",
  ].join("\n"),
};

const PRICES_2026_ZH = {
  file: "2026年价目表.md",
  text: [
    "# 2026 年价目表",
    "",
    "- 团队版：每席位每月 180 元。",
    "- 企业版：每席位每月 320 元，含单点登录。",
    "- 批量优惠：企业版 50 席位起打九折。",
    "- 年付：赠送两个月。",
    "- 开通费：一次性 8,000 元。",
    "- 试用：免费 30 天，可延长一次，再延 30 天。",
  ].join("\n"),
};
const PRICES_2025_ZH = {
  file: "2025年价目表.md",
  text: [
    "# 2025 年价目表",
    "",
    "- 团队版：每席位每月 160 元。",
    "- 企业版：每席位每月 280 元，含单点登录。",
    "- 批量优惠：企业版 60 席位起打九二折。",
    "- 开通费：一次性 6,000 元。",
  ].join("\n"),
};
const TERMS_ZH = {
  file: "服务条款.md",
  text: [
    "# 服务条款",
    "",
    "- 可用性承诺：每月 99.9%；低于该值，按当月费用的 5% 给予服务抵扣。",
    "- 技术支持：邮件，工作日 9:00 至 18:00（北京时间）；企业版另有电话支持，时间相同。",
    "- 数据存放在上海和深圳的数据中心。",
    "- 任何一方提前 60 天书面通知即可终止协议。",
    "- 价格调整提前 90 天通知。",
  ].join("\n"),
};
const POLICY_ZH = {
  file: "定价政策.md",
  text: [
    "# 定价政策",
    "",
    "- 每年涨价幅度不超过 5%。",
    "- 注册公益机构的开通费可减半，但不会免除。",
    "- 提前续约折扣：最高 15%，需客户经理批准。",
  ].join("\n"),
};
const ADD_ON_ZH = {
  file: "客服增值包.md",
  text: [
    "# 客服增值包",
    "",
    "- 客服增值包按客服坐席数计费：每个坐席每月 80 元。",
    "- 包含共享收件箱和回复模板。",
  ].join("\n"),
};
const MIGRATION_ZH = {
  file: "数据迁移服务.md",
  text: [
    "# 数据迁移服务",
    "",
    "- 最多迁移 10 年的历史记录，逐条核对，企业版已包含。",
    "- 团队版的迁移费为 12,000 元。",
  ].join("\n"),
};

/** A Document's line, as a Citation of it must quote. */
const line = (document: CallDocument, starts: string) => {
  const found = document.text.split("\n").find((each) => each.includes(starts));
  if (!found) throw new Error(`${document.file} has no line with “${starts}”.`);
  return { in: document.file, line: found.replace(/^-\s*/, "") };
};
const said = (text: string) => ({ in: TRANSCRIPT, line: text });

const EN_RENEWAL =
  "If you renew early, I can keep a twelve percent discount for you, as long as you sign by the end of March.";
const EN_RECORDS =
  "Our main worry is moving eight years of shipment records without losing anything.";
const EN_JUNE = "We need this running before our audit in June.";
const EN_BUDGET = "And the budget is fixed, eight thousand dollars a month, nothing above that.";
const EN_PILOT = "Let's agree the pilot starts on the third of March.";
const EN_EXPORT = "And Jonah on our side owns the data export.";
const EN_MAPPING = "Great, and we'll send the mapping sheet by Friday.";
const EN_NOTICE = "And either of us can end the agreement with sixty days' written notice.";

const ZH_RENEWAL = "如果提前续约，我可以给你们保留百分之十二的折扣，前提是三月底前签。";
const ZH_RECORDS = "我们最担心的是把八年的运单记录迁过去，一条都不能丢。";
const ZH_JUNE = "我们必须在六月审计之前上线。";
const ZH_BUDGET = "预算是定死的，每月最多五万，不能再多。";
const ZH_PILOT = "那试点就定在三月三号开始。";
const ZH_EXPORT = "我们这边数据导出由李铭负责。";
const ZH_MAPPING = "好的，字段对应表我们周五前发过去。";
const ZH_NOTICE = "另外，任何一方提前六十天书面通知就可以终止协议。";

export const CALL_HELP_CASES: readonly CallHelpCase[] = [
  {
    id: "en-answer-sso",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Thanks for making the time. Shall we go through the proposal?" },
      { who: "them", text: "Yes please. We looked at the Team plan you sent." },
      { who: "me", text: "The Team plan is twenty-five dollars a seat a month." },
      { who: "them", text: "We like it, but we'd need single sign-on for our security review." },
      {
        who: "them",
        text: "Does Enterprise include single sign-on, and what does it cost per seat?",
      },
    ],
    documents: [PRICES_2026_EN],
    answer: "Enterprise is $45 per seat a month and includes single sign-on.",
    rests: [[line(PRICES_2026_EN, "Enterprise plan")]],
  },
  {
    id: "en-answer-total",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "Thanks, that covers the rollout. Now the money side." },
      {
        who: "them",
        text: "If we went with Enterprise for forty seats, what would we pay each month with the volume discount?",
      },
    ],
    documents: [PRICES_2026_EN],
    answer:
      "$1,620 a month: 40 seats at $45 is $1,800, less the 10% volume discount that starts at 40 seats.",
    rests: [[line(PRICES_2026_EN, "Enterprise plan")], [line(PRICES_2026_EN, "Volume")]],
  },
  {
    id: "en-answer-edition",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "So that's the plan. Any questions on the pricing?" },
      { who: "them", text: "Mostly clear. And the one-time setup fee, what is it this year?" },
    ],
    documents: [PRICES_2025_EN, PRICES_2026_EN],
    answer: "$1,500, once, as the 2026 price sheet says.",
    rests: [[line(PRICES_2026_EN, "Setup fee")]],
    avoid: "$1,200 as this year's setup fee (that is the 2025 price sheet's)",
  },
  {
    id: "en-answer-unknown",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "Our lawyers sent over a few questions too." },
      { who: "them", text: "Do you have a data centre in Brazil? They asked specifically." },
    ],
    documents: [TERMS_EN],
    answer:
      "The terms say data is hosted in Frankfurt and Dublin; they say nothing of Brazil, so the reply doesn't promise a data centre there.",
    rests: [[line(TERMS_EN, "Data is hosted")]],
    avoid: "that data is or can be hosted in Brazil",
  },
  {
    id: "en-answer-earlier",
    language: "en",
    kind: "answer",
    needs: "earlier",
    before: [
      { who: "me", text: "One thing up front, about the renewal." },
      { who: "me", text: EN_RENEWAL },
      { who: "them", text: "Twelve percent, noted. Let's come back to that." },
    ],
    long: true,
    turns: [
      {
        who: "them",
        text: "Coming back to the renewal discount you mentioned at the start, how much was it again, and until when?",
      },
    ],
    documents: [POLICY_EN],
    answer:
      "12%, if they sign by the end of March: what the User offered at the start of the call.",
    rests: [[said(EN_RENEWAL)]],
    avoid: "15% as the discount the User offered",
  },
  {
    id: "en-answer-two",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Anything else from your side before we wrap up?" },
      {
        who: "them",
        text: "Two things from our finance team: how much notice do you give before a price change, and is there a cap on yearly increases?",
      },
    ],
    documents: [TERMS_EN, POLICY_EN],
    answer: "90 days' notice of any price change, and yearly increases are capped at 5%.",
    rests: [[line(TERMS_EN, "90 days")], [line(POLICY_EN, "capped")]],
  },
  {
    id: "en-say-competitor",
    language: "en",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "To be honest, another vendor quoted us twenty percent below your Enterprise price.",
      },
    ],
    documents: [PRICES_2026_EN],
    answer:
      "An option that answers with a real lever from the price sheet, 10% off from 40 seats or two months free on annual prepay, and offers no 20% discount.",
    rests: [[line(PRICES_2026_EN, "Volume"), line(PRICES_2026_EN, "Annual prepay")]],
    avoid: "a 20% discount, or any discount the price sheet doesn't give",
  },
  {
    id: "en-say-records",
    language: "en",
    kind: "say",
    needs: "earlier",
    before: [
      { who: "them", text: EN_RECORDS },
      { who: "me", text: "That's fair, and we'll come back to it properly." },
    ],
    long: true,
    turns: [{ who: "them", text: "So what would make this a safe bet for us?" }],
    documents: [MIGRATION_EN],
    answer:
      "An option that speaks to their worry about moving eight years of records: the migration service moves up to 10 years of records, checked line by line, included in Enterprise.",
    rests: [[line(MIGRATION_EN, "We move up to")]],
  },
  {
    id: "en-want",
    language: "en",
    kind: "want",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "Let me be straight about where we are." },
      { who: "them", text: EN_JUNE },
      { who: "them", text: EN_BUDGET },
    ],
    documents: [PRICES_2026_EN],
    answer: "They want it live before their June audit, for no more than $8,000 a month.",
    rests: [[said(EN_JUNE), said(EN_BUDGET)]],
  },
  {
    id: "en-sum",
    language: "en",
    kind: "sum",
    needs: "whole",
    before: [
      { who: "them", text: EN_PILOT },
      { who: "me", text: "The third of March works for us." },
    ],
    long: true,
    turns: [
      { who: "them", text: EN_EXPORT },
      { who: "me", text: EN_MAPPING },
    ],
    documents: [PRICES_2026_EN],
    answer:
      "The pilot starts on 3 March; Jonah owns the data export on their side; the User sends the mapping sheet by Friday.",
    rests: [[said(EN_PILOT)], [said(EN_EXPORT), said(EN_MAPPING)]],
  },
  {
    id: "en-no-waive",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "The setup is a one-off, then it's just the monthly fee." },
      { who: "them", text: "We're a registered charity. Could you waive the setup fee for us?" },
    ],
    documents: [POLICY_EN, PRICES_2026_EN],
    answer:
      "Declines waiving the setup fee and offers to halve it for a registered charity, to $750.",
    rests: [[line(POLICY_EN, "halved")]],
    avoid: "waiving the setup fee",
  },
  {
    id: "en-ask-agents",
    language: "en",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "So that's the core product." },
      { who: "them", text: "We'd also like the support add-on, probably later in the year." },
    ],
    documents: [ADD_ON_EN],
    answer:
      "A question asking how many support agents they have, since the add-on is priced per agent ($12 a month each).",
    rests: [[line(ADD_ON_EN, "priced by the number")]],
  },
  {
    id: "en-check-wrong",
    language: "en",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "So just to confirm, your uptime commitment is ninety-nine point nine nine percent, and there's phone support around the clock?",
      },
    ],
    documents: [TERMS_EN],
    answer:
      "Both claims are contradicted: the terms commit to 99.9% uptime a month, and support is weekdays 8:00 to 18:00 CET (Enterprise adds a phone line in the same hours), not around the clock.",
    rests: [[line(TERMS_EN, "Uptime commitment")], [line(TERMS_EN, "Support:")]],
    avoid: "that either claim is supported",
  },
  {
    id: "en-check-right",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "Our lawyer wanted to know how we get out if it doesn't work." },
      { who: "me", text: EN_NOTICE },
      { who: "them", text: "Good, that matches what she expected." },
    ],
    documents: [TERMS_EN],
    answer:
      "Supported: either party may end the agreement with 60 days' written notice, as the terms say.",
    rests: [[line(TERMS_EN, "Either party")]],
  },
  {
    id: "en-no-price",
    language: "en",
    kind: "no",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "Can you do thirty-five dollars a seat for Enterprise?" }],
    documents: [PRICES_2026_EN],
    answer:
      "Declines $35 politely, keeps Enterprise at $45, and offers a real lever from the price sheet (10% off from 40 seats, or two months free on annual prepay).",
    rests: [
      [
        line(PRICES_2026_EN, "Enterprise plan"),
        line(PRICES_2026_EN, "Volume"),
        line(PRICES_2026_EN, "Annual prepay"),
      ],
    ],
    avoid: "agreeing to $35 a seat",
  },

  {
    id: "zh-answer-sso",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "谢谢抽时间，我们过一下方案吧？" },
      { who: "them", text: "好的，你们发的团队版我们看过了。" },
      { who: "me", text: "团队版是每个席位每月一百八十元。" },
      { who: "them", text: "挺好的，不过我们安全评审要求必须有单点登录。" },
      { who: "them", text: "企业版包含单点登录吗？每个席位多少钱？" },
    ],
    documents: [PRICES_2026_ZH],
    answer: "企业版每席位每月 320 元，含单点登录。",
    rests: [[line(PRICES_2026_ZH, "企业版：")]],
  },
  {
    id: "zh-answer-total",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "好，上线的事基本清楚了，接下来说说钱。" },
      { who: "them", text: "如果我们买企业版五十个席位，算上批量优惠，每月一共多少钱？" },
    ],
    documents: [PRICES_2026_ZH],
    answer: "每月 14,400 元：50 个席位 × 320 元 = 16,000 元，50 席位起打九折。",
    rests: [[line(PRICES_2026_ZH, "企业版：")], [line(PRICES_2026_ZH, "批量优惠")]],
  },
  {
    id: "zh-answer-edition",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "方案大概就是这样，价格上有什么问题吗？" },
      { who: "them", text: "基本清楚。今年的开通费是多少？" },
    ],
    documents: [PRICES_2025_ZH, PRICES_2026_ZH],
    answer: "一次性 8,000 元，以 2026 年价目表为准。",
    rests: [[line(PRICES_2026_ZH, "开通费")]],
    avoid: "把 6,000 元说成今年的开通费（那是 2025 年价目表的）",
  },
  {
    id: "zh-answer-unknown",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "我们法务也提了几个问题。" },
      { who: "them", text: "你们在香港有数据中心吗？他们专门问了这个。" },
    ],
    documents: [TERMS_ZH],
    answer: "条款只写了数据存放在上海和深圳的数据中心，没有提到香港，回复不承诺香港有数据中心。",
    rests: [[line(TERMS_ZH, "数据存放")]],
    avoid: "数据存放在或可以存放在香港",
  },
  {
    id: "zh-answer-earlier",
    language: "zh-CN",
    kind: "answer",
    needs: "earlier",
    before: [
      { who: "me", text: "先说一下续约的事。" },
      { who: "me", text: ZH_RENEWAL },
      { who: "them", text: "百分之十二，记下了，我们后面再说。" },
    ],
    long: true,
    turns: [{ who: "them", text: "回到你开头说的续约折扣，是多少来着？截止到什么时候？" }],
    documents: [POLICY_ZH],
    answer: "百分之十二，前提是三月底前签约：这是用户在通话开头给出的。",
    rests: [[said(ZH_RENEWAL)]],
    avoid: "把 15% 说成用户给出的折扣",
  },
  {
    id: "zh-answer-two",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "结束之前，你们还有什么问题吗？" },
      { who: "them", text: "我们财务问两件事：调价前提前多久通知？每年涨价有没有上限？" },
    ],
    documents: [TERMS_ZH, POLICY_ZH],
    answer: "价格调整提前 90 天通知；每年涨价幅度不超过 5%。",
    rests: [[line(TERMS_ZH, "价格调整")], [line(POLICY_ZH, "涨价幅度")]],
  },
  {
    id: "zh-say-competitor",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "说实话，另一家给我们的报价比你们企业版低百分之二十。" }],
    documents: [PRICES_2026_ZH],
    answer:
      "一个用价目表里真实的优惠来回应的选项：企业版 50 席位起打九折，或年付赠送两个月；不承诺八折或价目表没有的优惠。",
    rests: [[line(PRICES_2026_ZH, "批量优惠"), line(PRICES_2026_ZH, "年付")]],
    avoid: "打八折，或价目表没有的任何优惠",
  },
  {
    id: "zh-say-records",
    language: "zh-CN",
    kind: "say",
    needs: "earlier",
    before: [
      { who: "them", text: ZH_RECORDS },
      { who: "me", text: "明白，这个我们后面细说。" },
    ],
    long: true,
    turns: [{ who: "them", text: "那怎么才能让我们放心选你们？" }],
    documents: [MIGRATION_ZH],
    answer:
      "一个回应他们迁移八年运单记录担忧的选项：数据迁移服务最多迁移 10 年的历史记录，逐条核对，企业版已包含。",
    rests: [[line(MIGRATION_ZH, "最多迁移")]],
  },
  {
    id: "zh-want",
    language: "zh-CN",
    kind: "want",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "我直说我们现在的情况吧。" },
      { who: "them", text: ZH_JUNE },
      { who: "them", text: ZH_BUDGET },
    ],
    documents: [PRICES_2026_ZH],
    answer: "他们想在六月审计之前上线，每月花费不超过五万元。",
    rests: [[said(ZH_JUNE), said(ZH_BUDGET)]],
  },
  {
    id: "zh-sum",
    language: "zh-CN",
    kind: "sum",
    needs: "whole",
    before: [
      { who: "them", text: ZH_PILOT },
      { who: "me", text: "三月三号没问题。" },
    ],
    long: true,
    turns: [
      { who: "them", text: ZH_EXPORT },
      { who: "me", text: ZH_MAPPING },
    ],
    documents: [PRICES_2026_ZH],
    answer: "试点 3 月 3 日开始；对方由李铭负责数据导出；用户这边周五前发字段对应表。",
    rests: [[said(ZH_PILOT)], [said(ZH_EXPORT), said(ZH_MAPPING)]],
  },
  {
    id: "zh-no-waive",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "开通费是一次性的，之后只收月费。" },
      { who: "them", text: "我们是注册的公益机构，开通费能不能免了？" },
    ],
    documents: [POLICY_ZH, PRICES_2026_ZH],
    answer: "婉拒免除开通费，提出注册公益机构可以减半，即 4,000 元。",
    rests: [[line(POLICY_ZH, "减半")]],
    avoid: "免除开通费",
  },
  {
    id: "zh-ask-agents",
    language: "zh-CN",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "核心产品大概就是这些。" },
      { who: "them", text: "年底我们可能还想加客服增值包。" },
    ],
    documents: [ADD_ON_ZH],
    answer: "问他们有多少个客服坐席，因为增值包按坐席计费（每个坐席每月 80 元）。",
    rests: [[line(ADD_ON_ZH, "按客服坐席数")]],
  },
  {
    id: "zh-check-wrong",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "我确认一下，你们的可用性承诺是百分之九十九点九九，而且电话支持是二十四小时的，对吧？",
      },
    ],
    documents: [TERMS_ZH],
    answer:
      "两项说法都与条款不符：条款承诺每月可用性 99.9%；技术支持是工作日 9:00 至 18:00（企业版的电话支持时间相同），不是二十四小时。",
    rests: [[line(TERMS_ZH, "可用性承诺")], [line(TERMS_ZH, "技术支持")]],
    avoid: "说任何一项有依据或成立",
  },
  {
    id: "zh-check-right",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "我们律师想知道，如果用得不好，怎么退出。" },
      { who: "me", text: ZH_NOTICE },
      { who: "them", text: "好，跟我们律师预期的一样。" },
    ],
    documents: [TERMS_ZH],
    answer: "有依据：条款写明任何一方提前 60 天书面通知即可终止协议。",
    rests: [[line(TERMS_ZH, "任何一方")]],
  },
  {
    id: "zh-no-price",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "企业版能不能做到每个席位两百五？" }],
    documents: [PRICES_2026_ZH],
    answer:
      "婉拒每席位 250 元，企业版保持 320 元，并给出价目表里真实的优惠（50 席位起打九折，或年付赠送两个月）。",
    rests: [
      [
        line(PRICES_2026_ZH, "企业版："),
        line(PRICES_2026_ZH, "批量优惠"),
        line(PRICES_2026_ZH, "年付"),
      ],
    ],
    avoid: "答应每席位 250 元",
  },
];

/** The call of a case, oldest line first. */
export const callOf = (each: CallHelpCase): CallTurn[] => [
  ...(each.before ?? []),
  ...(each.long ? rolloutOf(each.language) : []),
  ...each.turns,
];
