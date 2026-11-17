/**
 * "Longer" over a summary the assistant wrote (#1385, #1897), against real models, in English and
 * in Chinese: a short cited summary of a contract written into the Note in front, then a request
 * for it a bit longer or twice as long, in words no prompt or Tool description uses. Counted per
 * run, each measured from the Note's text before and after, in words, or characters for Chinese:
 * the growth is within what was asked (a bit longer: more than 1, at most 1.65 times; twice as
 * long: 1.6 to 2.4 times), every sentence it added has a Citation or a check's mark, the sizes
 * the reply states are the measured ones, and the Note holds one summary. Each model runs only
 * when its key is in the environment; the variables are those of
 * ./assistantChangesMinds.live.test.ts.
 *
 * It fails under the floors Claude Haiku 5.5 held on this code: one summary every time, at most
 * one run with an added sentence bare or a size stated falsely, and half the runs within bounds.
 *
 * INCARNAMIND_LIVE_LIMIT runs only the first so many requests of each kind and language. Set
 * INCARNAMIND_LIVE_REPORT to a file to keep what each run gave back.
 *
 * Second round (#1385), bars written 2026-11-17 before any request of it, the paired draw one
 * session with `main` and the branch alternated request by request, stop US$0.70 for every request
 * of it. The model meant is Claude Haiku 5.5, the default; the model that runs is DeepSeek V4.1
 * Flash (deepseek-flash), both arms, by the owner's rule of 2026-11-17, and the bars below stand,
 * `main` in the same session being what each is read against. A run counts only with nothing refused, failed or timed out. At the
 * branch's head:
 * - a bit longer (the ten "a bit" requests): within bound in at least 9 of 10, and no fewer than
 *   `main` in the same session;
 * - the sizes a reply states are the measured ones in at least 15 of the 16 requests of the first
 *   round; every added sentence cited or marked 16 of 16; one summary in place 16 of 16;
 * - no amount asked ("shorter", "longer", 8 requests, "none"): the call declares no length and the
 *   reply states no length the User didn't give, 8 of 8;
 * - the User's own Note made a little longer (4 requests, "own"): within bound in at least 3 of 4,
 *   one copy of the text in place 4 of 4, and a reply that says no change was made when one was,
 *   0 of 4.
 * A missed bar is one line to the lead, and a wrong figure the reply states goes to the owner.
 *
 * Third round (#1385, adding to the User's own Note takes the amount, and a length is refused up to
 * twice), bars written 2026-11-17 before any request of it, DeepSeek V4.1 Flash both arms
 * (Claude Haiku 5.5 meant), `main` and the branch alternated in one session, stop CNY 1.5 (about
 * US$0.20; the core counts DeepSeek in CNY, so the balance is read before and after). At the head:
 * - the User's own Note a little longer (the 8 "own" requests): within 1.0 < x <= 1.65 in at least
 *   6 of 8, and at least 3 more than `main`;
 * - no amount on the own Note (the 2 "ownNone"): none declared or stated, 2 of 2;
 * - a bit longer on the assistant's summary (the 10 "a bit"): at least 9 of 10, and not below `main`;
 * - no amount on the summary (the 8 "shorter" and "longer"): 8 of 8;
 * - the sizes a reply states are the measured ones: all 16 of the summary's and at least 7 of the
 *   own 8; every added sentence cited or marked: 16 of 16 and at least 7 of 8 own;
 * - the User's own text kept in the Note: 8 of 8 (and the 2 "ownNone"); a reply that says no change
 *   was made when one was: 0.
 * Reported on both arms, and in the PR as a cost if the second refusal adds more than one request in
 * five edits on average: seconds and edit calls per request, and how often a refusal fired once and
 * twice.
 *
 * Third round, results, DeepSeek V4.1 Flash, `main` (067cf35cc) and the branch alternated, two runs:
 * the first with a compact amount line, the second with the line that ships ("Always give it, as a
 * multiple of the text now, from an amount the User names: …, never one you chose"):
 * - a bit longer (10): first 8, shipped 10, `main` 6 and 6;
 * - no amount on the summary (8): first 1, shipped 8, `main` 2 and 5;
 * - the User's own Note a little longer (8): first 5, shipped 1, `main` 0 and 0 (the model gives
 *   add_to_mind a length in about half the Chinese asks, and in the English ones when its line is
 *   worded as in the first run); a variant of the shipped line read 5 of 16;
 * - no amount on the own Note (2): first 2, shipped 1, `main` 1 and 2;
 * - sizes the reply states are the measured ones, every added sentence cited, the User's own text
 *   kept, and no reply that denies a change: on every run of the branch but one denial (first run);
 * - what the second refusal costs, on the "a bit" requests (shipped run first): edit calls per
 *   request 2.2 and 2.3 against 2.0 on `main`, seconds 22 and 25 against 24 and 22; the second
 *   refusal fired on 4 of 10 and 3 of 10.
 * Results, DeepSeek V4.1 Flash, `main` (c253f2a4b) and the branch alternated in one session each:
 * - Round 1, with the description "only from an amount in the User's words … 1 when they name no
 *   amount": no amount 8 of 8 against 0 of 8 on `main`, but the "a bit" requests fell to 2 of 10
 *   within bound against 6 of 10: "a little" was read as no amount, and a text with no length
 *   asked grows unchecked (4 times). Not shipped.
 * - Round 2, "a little", "a bit" or "slightly" are amounts, only a bare "shorter" or "longer"
 *   gives 1: a bit longer within bound 7 of 10 on both (the bar was 9; the model declares 1.5 in
 *   all five English requests, and the text lands at 1.57 to 1.76 times after one refusal); stated
 *   sizes the measured ones 16 of 16 (`main` 15 of 16); every added sentence cited 16 of 16; one
 *   summary 16 of 16; no amount 7 of 8 (`main` 0 of 8; the miss is "把摘要写长。"); the User's own
 *   Note within bound 0 of 4 on both: the model adds a new cited section 3 to 5 times the Note,
 *   as add_to_mind has no length to hold it to, and the reply says so truly (a reply that says no
 *   change was made when one was: 0 of 4 on both). "One copy in place" reads the salary figure
 *   twice in a section the model adds about the pay, which is not a copy of the text.
 */
import { appendFile } from "node:fs/promises";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import type { ChatProviderKind, Core } from "../../src/core";
import { CITATION_NODE, CLAIM_CHECK_MARK } from "../../src/core/api";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import {
  comparableSentence,
  INLINE_NODE,
  isClaim,
  sentenceSpans,
} from "../../src/shared/sentences";
import { countFor, countText, mostlyCjk } from "../../src/shared/wordCount";
import { checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { note, readMind, resolveChanges, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const LIVE: { name: string; kind: ChatProviderKind; apiKey: string | undefined; model: string }[] =
  [
    {
      name: "Anthropic",
      kind: "anthropic",
      apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
      model:
        process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
        (catalogProvider("anthropic")?.roles.quickTasks as string),
    },
    {
      name: "DeepSeek",
      kind: "deepseek",
      apiKey: process.env.INCARNAMIND_LIVE_DEEPSEEK_KEY,
      model:
        process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ??
        (catalogProvider("deepseek")?.roles.quickTasks as string),
    },
  ];

type Kind = "a bit" | "twice" | "shorter" | "longer" | "own" | "ownNone" | "topic";

/** A long Note, about 1,500 words (Chinese: characters), as a User with a real Note has: no two paragraphs alike, none on the topics asked about. */
const LONG_ENGLISH = [
  "Desk and laptop. Dana's desk is on the third floor beside the window, with a standing frame and two monitors. The laptop is collected from the IT cupboard on the first morning, with the charger, a headset and a security key. Each is signed for on the equipment sheet kept at reception, and the serial numbers are copied into the team's asset list by the office manager that same afternoon.",
  "Accounts and access. Logins for email, the calendar and the chat tool are created before the start date. Access to the reporting database comes with the second week, after the data protection course has been completed. Until then Dana works from the sample tables in the training schema, which have the same shape as the live ones but only a few thousand rows each.",
  "The Reporting team. Eleven people work in the team, split into dashboards, ad hoc requests and the monthly board pack. Dana joins the dashboards group, which meets every Tuesday at ten for half an hour. The Head of Reporting holds a one-to-one with each new starter on Fridays during the first month, mostly to hear what has been confusing and to adjust the plan.",
  "Week one plan. Monday is for introductions and the building tour, Tuesday for the tools walk-through, and Wednesday for shadowing a colleague on a live request. On Thursday Dana reads the style guide for charts and the glossary of metric names. Friday is a quiet day for questions, and the first week closes with a short written note on what is clear and what is not.",
  "Week two plan. Dana picks up a small, well-defined request from the backlog, such as correcting a filter on the regional sales dashboard. A colleague reviews the change before it goes live. The second week also includes the data protection course, about ninety minutes online, and a short quiz that has to be passed before any access to the live database is switched on.",
  "Tools. The team writes queries in SQL and builds dashboards in the company's reporting tool, with the Python notebooks reserved for analyses that need statistics. Version control is in the shared repository, and every dashboard has a README that says who owns it. Dana is asked to read three of those before touching anything, to see how the team documents its choices.",
  "Style guide for charts. Charts use the company palette, start bar axes at zero, and carry a one-line title that states the finding rather than the topic. Footnotes name the source table and the date the data was last refreshed. Pie charts are avoided, and any chart with more than seven series is split into two. The guide runs to eight pages and has worked examples.",
  "Metric names. The glossary lists about sixty metrics with a single definition each, such as active customer, net revenue and churned account. When a request uses a different word, the first step is to ask which glossary entry is meant. Dana is encouraged to add a question to the glossary channel whenever two colleagues use the same word to mean different things.",
  "The monthly board pack. On the fourth working day each month the team freezes the figures and builds the pack for the board, which is reviewed on the sixth day and sent on the eighth. Dana will observe it in the first month and take one chart in the second, so that by the third month a full section is hers, with a reviewer alongside.",
  "Requests from other teams. Requests arrive through a form, and each one gets a ticket with an owner within a day. Small ones are answered within two working days; larger ones are scoped in a short call first. Dana is asked to keep the ticket updated in plain words, since the people asking are usually not analysts and will read the notes to see how far along it is.",
  "Quality checks. Every number that leaves the team is reconciled against a second source where one exists, such as the finance ledger for revenue or the support system for ticket counts. Differences above one percent are written up and explained in the ticket. The team keeps a log of past reconciliation problems, which is useful reading because the same few causes come up again and again.",
  "Meetings. Besides the Tuesday dashboards meeting there is a team stand-up on Monday and Thursday at nine thirty, lasting ten minutes, and a monthly review of the backlog. Dana is invited to all of them from the first week. Notes from each are posted in the team channel the same day, so missing one is never a problem for long.",
  "Working with finance. Finance is the team's largest internal customer, and its requests have fixed dates around the month end. A named contact in finance, shared among the team, answers questions on definitions and approves any change to a figure that appears in the accounts. Dana is introduced to that contact in the first fortnight, over a short call.",
  "The shared drive. Documents are filed by project and then by year, and the team keeps a single index sheet at the top of the folder that lists what lives where. Files named final are discouraged; instead each file carries a version in its name and a one-line change note in the first cell. Dana is shown how the index is kept up to date when a project ends.",
  "Learning budget. Each person has an annual allowance for courses, books and conferences, to be agreed with the Head of Reporting in advance. New starters usually spend part of it in the first six months on a course in either statistics or data visualisation. The team keeps a list of past courses with short reviews, and people are asked to add their own afterwards.",
  "Buddy. A colleague from the dashboards group is named as Dana's buddy for the first three months. The buddy is the first person to ask about anything small, from how the printer works to which dashboards are worth copying. They also sit in on the first review of Dana's work, and give a short account of it to the Head of Reporting afterwards.",
  "Travel to the other office. The company has a second office across the city, where the data engineering team sits. Reporting staff go there on the first Wednesday of the month for the joint data meeting. Dana is expected to join from the second month, and the travel is by the shuttle bus that leaves the main building at eight forty.",
  "Lunch and the kitchen. The kitchen on the third floor has a fridge shared by the whole floor, with a rota for cleaning it on Fridays. Many of the team walk to the market on Thursdays. On Dana's first day the team takes her to lunch, and the cost goes on the team's social budget, which is kept for occasions like this one.",
  "The first review. After six weeks the Head of Reporting and Dana sit down to talk through what has gone well, what has been hard and what the next quarter should hold. Dana is asked to prepare a page beforehand listing three things learned, two questions, and one thing she would change about how the team works.",
  "Reading list. Beyond the style guide and glossary, new starters are given three short readings: a note on how the company defines a customer, a history of the reporting database and why its tables are named as they are, and a one-page summary of last year's board pack. They take about an hour in total, and are best done in the first week.",
  "Remote days. The team works from the office on Tuesdays and Thursdays and from home on the other days, with flexibility when something is needed in person. On remote days the team channel is the place for quick questions, and anyone can call a ten-minute huddle. Dana is asked to say in the channel when she is online, in the first few weeks.",
  "Support tickets for IT. Problems with the laptop or access go to the IT desk through its form, not by email, so that they are counted. Urgent issues can be phoned in. The desk aims to answer within one working day, and most things are fixed the same day. Dana is shown the form during the tools walk-through and asked to try it once.",
  "Fire and safety. The fire assembly point is in the car park behind the main building, and the first aider for the third floor is named on the notice by the lift. A short safety talk is given on the first morning by the office manager, and the evacuation route is walked through once with the new starters before they go to their desks.",
  "A note on the first month. The aim of the first month is not output but orientation. By the end Dana should know who to ask for what, have fixed one small thing on a live dashboard, have read the three dashboards documents, and have sat through one board pack. Anything more than that is a bonus, and nobody expects it.",
];
const LONG_CHINESE = [
  "座位与电脑。入职第一天，达娜的座位在三楼靠窗的位置，配有升降桌和两台显示器，笔记本电脑到一楼信息技术室领取，同时领取充电器、耳机和一把安全密钥，全部在前台的设备登记表上签收，办公室经理当天下午会把序列号录入团队的资产清单。",
  "账号与权限。邮箱、日历和聊天工具的账号在入职前就已开通，报告数据库的访问权限要到第二周、数据保护课程完成之后才会开通，在此之前达娜使用培训库中的样例表，它们的结构与正式表完全一致，只是每张表只有几千行数据。",
  "报告团队。团队共有十一人，分为看板、临时需求和月度董事会材料三个小组，达娜加入看板组，每周二上午十点开会半小时，报告负责人在头一个月里每周五与新人单独谈一次，主要是听听哪里让人困惑，并据此调整安排。",
  "第一周安排。周一是自我介绍和参观办公楼，周二讲解各种工具，周三跟随同事处理一项实际需求，周四阅读图表风格指南和指标名称词汇表，周五留给提问，第一周结束时需要写一份简短的说明，写明哪些已经清楚，哪些还不清楚。",
  "第二周安排。达娜从待办列表中领取一项范围明确的小需求，例如修正区域销售看板上的一个筛选条件，改动上线前由同事审阅，第二周还要完成约九十分钟的在线数据保护课程并通过测验，通过之后才会开通正式数据库的访问权限。",
  "工具。团队用结构化查询语言写查询，用公司的报告工具制作看板，需要统计方法的分析才会使用笔记本形式的脚本，版本管理放在共享代码库中，每个看板都有一份说明文件，写明负责人，达娜被要求先读三份，看看团队是怎样记录自己所做选择的。",
  "图表风格指南。图表使用公司统一配色，柱状图的纵轴从零开始，标题用一句话写出结论而不是主题，脚注写明数据来源表和最近一次刷新的日期，避免使用饼图，系列超过七个的图表要拆成两张，指南共八页，附有实际示例。",
  "指标名称。词汇表收录了约六十个指标，每个只有一个定义，例如活跃客户、净收入和流失账户，当需求里用了别的说法，第一步是问清楚指的是哪一条，如果两位同事用同一个词表示不同的意思，鼓励达娜在词汇表频道里提出来。",
  "月度董事会材料。每月第四个工作日团队冻结数据并制作材料，第六天评审，第八天发出，达娜第一个月先观摩，第二个月负责其中一张图，到第三个月就要独立负责一个完整的部分，并有评审人在旁协助。",
  "其他团队的需求。需求通过表单提交，每一项在一天内指定负责人，小的需求两个工作日内答复，大的先开一个简短的电话会确定范围，达娜需要用通俗的话更新工单，因为提需求的人通常不是分析人员，会通过说明来了解进度。",
  "质量核对。离开团队的每个数字，只要有第二来源，都要核对，例如收入对照财务总账，工单数量对照客服系统，差异超过百分之一的要写明原因并记录在工单里，团队保存着过去的核对问题记录，值得一读，因为同样的几种原因会反复出现。",
  "会议。除周二的看板会议外，每周一和周四上午九点半有十分钟的站会，每月还有一次待办列表的回顾，从第一周起达娜就受邀参加所有这些会议，每次会议的纪要当天发到团队频道，所以错过一次也没有关系。",
  "与财务部门的合作。财务是团队最大的内部客户，需求集中在月末前后，财务有一位固定联系人负责解答口径问题，并批准账目中所用数字的任何改动，达娜会在前两周内通过一次简短的电话认识这位联系人。",
  "共享文件夹。文件先按项目、再按年份归档，文件夹顶部有一张总索引表，列出各类文件放在哪里，不提倡使用最终版这样的文件名，而是在文件名里写版本，并在第一个单元格写一句改动说明，项目结束时如何更新索引，会演示给达娜看。",
  "学习预算。每人每年有一笔用于课程、书籍和会议的额度，需提前与报告负责人商定，新人通常在头六个月里用一部分上统计或数据可视化的课程，团队保存着过去课程的清单和简短评价，上完课后也请大家补充自己的评价。",
  "带教同事。看板组的一位同事被指定为达娜头三个月的带教人，凡是小问题都先问带教人，从打印机怎么用到哪些看板值得参考，带教人还会旁听达娜第一次的工作评审，并在事后向报告负责人做简短汇报。",
  "前往另一处办公室。公司在城市另一端还有一处办公室，数据工程团队在那里，报告团队每月第一个周三去参加联合数据会议，达娜从第二个月开始参加，乘坐每天八点四十分从主楼出发的班车前往。",
];

const LANGUAGES = [
  {
    language: "English",
    file: "Employment contract.md",
    contents: [
      "# Employment contract: Dana Whitfield and Larkspur Analytics Ltd",
      "1. Role. Dana Whitfield is employed as a Data Analyst in the Reporting team, reporting to the Head of Reporting, from 3 March 2025.",
      "2. Probation. The first six months are a probation period, during which either party may end the contract with two weeks' notice.",
      "3. Hours. Normal hours are 37.5 a week, Monday to Friday, with core hours from 10:00 to 16:00. Overtime is paid at 1.5 times the hourly rate when the line manager agrees to it in advance.",
      "4. Pay. The salary is £41,500 a year, paid monthly on the last working day, and reviewed every April.",
      "5. Holiday. The employee has 25 days of paid holiday a year as well as public holidays, and may carry up to 5 unused days into the next year.",
      "6. Notice. After probation, either party ends the contract with one month's written notice.",
      "7. Confidentiality. The employee keeps client data confidential during the employment and for two years after it ends.",
    ].join("\n\n"),
    first: "Write a short summary of the employment contract into this note.",
    seed: {
      query: "employment contract salary notice",
      content:
        "## Summary\n\nDana Whitfield joins Larkspur Analytics as a Data Analyst in the Reporting team from 3 March 2025 [^1]. The salary is £41,500 a year, paid monthly [^2]. After a six-month probation, either party gives one month's written notice [^3].",
      quotes: [
        "Dana Whitfield is employed as a Data Analyst in the Reporting team, reporting to the Head of Reporting, from 3 March 2025.",
        "The salary is £41,500 a year, paid monthly on the last working day",
        "After probation, either party ends the contract with one month's written notice.",
      ],
    },
    salary: /41,500/g,
    requests: {
      "a bit": [
        "Expand the summary a little.",
        "Could you make the summary slightly longer?",
        "Add a bit more detail to the summary.",
        "Flesh out the summary a little more.",
        "Make the summary a little more detailed, but not much longer.",
      ],
      twice: [
        "Make the summary double its current length.",
        "Expand the summary to about two times its length.",
        "Grow the summary so it's roughly double.",
      ],
      shorter: ["Make the summary shorter.", "Shorten the summary.", "Cut the summary down."],
      longer: ["Make the summary longer."],
      own: [
        "Make my note a little longer, using what the Documents say.",
        "Could you add a bit more detail to my note from the Documents?",
        "Please expand my note slightly with details from the Documents.",
        "My note is a bit short: add a little more from the Documents.",
      ],
      ownNone: ["Add more from the Documents to my note."],
      // Asked of a long Note: the first two a Note the User typed, the last two one the assistant wrote.
      topic: [
        "Add a little about the probation period to my note.",
        "Add a bit about holiday carry-over to the note.",
        "Add a little about the overtime rules.",
        "Add something short about confidentiality.",
      ],
    } satisfies Record<Kind, string[]>,
    ownNote: [
      "Summary",
      "Dana Whitfield joins Larkspur Analytics as a Data Analyst in the Reporting team from 3 March 2025. The salary is £41,500 a year, paid monthly. The first six months are probation, and after it the notice is one month.",
    ],
  },
  {
    language: "Chinese",
    file: "劳动合同.md",
    contents: [
      "# 劳动合同：林晓雯与蓝橡数据分析有限公司",
      "一、岗位。林晓雯受聘为报表部数据分析师，向报表部负责人汇报，自2025年3月3日起履职。",
      "二、试用期。前六个月为试用期，试用期内任何一方提前两周通知即可解除合同。",
      "三、工时。标准工时为每周37.5小时，周一至周五，核心工作时间为10:00至16:00。经直属上级事先同意的加班，按小时工资的1.5倍支付。",
      "四、薪酬。年薪为人民币415,000元，于每月最后一个工作日按月发放，每年四月调整一次。",
      "五、假期。员工每年享有25天带薪年假，另加法定节假日，未休年假最多可结转5天至下一年。",
      "六、解除。试用期满后，任何一方须提前一个月书面通知方可解除合同。",
      "七、保密。员工在职期间及离职后两年内，须对客户数据保密。",
    ].join("\n\n"),
    first: "把这份劳动合同写成一段简短的摘要放进这个笔记。",
    seed: {
      query: "劳动合同 年薪 解除",
      content:
        "## 摘要\n\n林晓雯自2025年3月3日起受聘为蓝橡数据分析有限公司报表部数据分析师[^1]。年薪为人民币415,000元，按月发放[^2]。试用期为六个月，期满后解除合同须提前一个月书面通知[^3]。",
      quotes: [
        "林晓雯受聘为报表部数据分析师，向报表部负责人汇报，自2025年3月3日起履职。",
        "年薪为人民币415,000元，于每月最后一个工作日按月发放",
        "试用期满后，任何一方须提前一个月书面通知方可解除合同。",
      ],
    },
    salary: /415,000/g,
    requests: {
      "a bit": [
        "把摘要稍微扩写一点。",
        "摘要再详细一点点。",
        "摘要稍微加长一些。",
        "摘要有点短，稍微补充一下。",
        "把摘要略微展开一些。",
      ],
      twice: ["把摘要扩写到现在的两倍长。", "摘要篇幅加倍。", "摘要扩充一倍。"],
      shorter: ["把摘要写短。", "缩短摘要。", "摘要精简一下。"],
      longer: ["把摘要写长。"],
      own: [
        "把我的笔记稍微写长一点，用文档里的内容。",
        "能根据文档给我的笔记多补充一些细节吗？",
        "请用文档里的内容把我的笔记稍微扩充一点。",
        "我的笔记有点短，根据文档再补充一小点。",
      ],
      ownNone: ["根据文档给我的笔记多加一些内容。"],
      topic: [
        "再补充一点关于试用期的内容。",
        "笔记里加一点关于年假结转的内容。",
        "补充一下加班规定的内容。",
        "再加一点关于保密义务的说明。",
      ],
    } satisfies Record<Kind, string[]>,
    ownNote: [
      "摘要",
      "林晓雯自2025年3月3日起受聘为蓝橡数据分析有限公司报表部数据分析师。年薪为人民币415,000元，按月发放。试用期为六个月，期满后解除合同须提前一个月书面通知。",
    ],
  },
] as const;

const WITHIN: Record<Kind, (times: number) => boolean> = {
  "a bit": (times) => times > 1 && times <= 1.65,
  twice: (times) => times >= 1.6 && times <= 2.4,
  shorter: (times) => times > 0 && times < 1,
  longer: (times) => times > 1,
  own: (times) => times > 1 && times <= 1.65,
  ownNone: (times) => times > 1,
  topic: (times) => times > 1,
};

/** A length the reply says the User asked for, which no request of the "shorter" and "longer" kinds gives. */
const ASKED_LENGTH =
  /(?:asked for|you asked|requested|wanted)\b[^.]{0,25}\d|\d(?:\.\d+)?\b[^.]{0,25}(?:you asked|asked for)|(?:你|您)(?:要求|想要)[^。]{0,12}\d|\d[^。]{0,12}(?:你的要求|你要求)/i;

/** A reply that says nothing was changed. */
const SAYS_UNCHANGED =
  /\b(?:didn't|did not|couldn't|could not|wasn't|was not|hasn't|has not)\b[^.]{0,40}\b(?:happen|apply|applied|change|changed|rewrite|rewritten|make)\b|没有(?:改|修改|写|成功|应用)|未(?:能)?(?:修改|应用|成功)/i;

const ASK_LIMIT_MS = 240_000;

/**
 * The summary the assistant wrote first, the same in every run and on every commit: written by a
 * scripted model, cited, so what is measured is only the real model's "longer".
 */
function seedModel(seed: { query: string; content: string; quotes: readonly string[] }) {
  // Every sentence of the seed is in the contract: each check finds it supported.
  const supported = new Proxy({}, { get: () => ({ verdict: "supported" }) });
  return scriptedModel((call: ModelCall): ScriptedReply => {
    if (isCheckRun(call)) return checkReply(call, supported);
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: seed.query } }] };
    if (call.results.some((result) => result.tool === "add_to_mind")) return { text: "Done." };
    const [passage] = shownPassages(search.text);
    const citations = seed.quotes.map((quote, index) => ({
      marker: index + 1,
      passage: passage?.id,
      quote,
    }));
    return {
      calls: [
        { tool: "cite", input: { citations } },
        { tool: "add_to_mind", input: { content: seed.content } },
      ],
    };
  });
}

async function ask(core: Core, text: string, mindId: string, folderId: string) {
  const result = await core.askInConversation({
    text,
    mindId,
    scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
  });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => {
    // A reply that never ends would hold the run: past this, it is counted as it stands.
    const limit = setTimeout(done, ASK_LIMIT_MS);
    const stops = [
      core.on("answer.finished", ({ answerId }) => answerId === result.answerId && done()),
      core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done()),
    ];
    function done() {
      clearTimeout(limit);
      for (const stop of stops) stop();
      resolve();
    }
  });
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

interface NoteSentence {
  text: string;
  cited: boolean;
  marked: boolean;
}

/** The Note's sentences once its changes are accepted, each with whether it cites or carries a check's mark. */
function sentencesOf(doc: ProseMirrorNode): { text: string; sentences: NoteSentence[] } {
  const sentences: NoteSentence[] = [];
  const lines: string[] = [];
  doc.descendants((block) => {
    if (!block.isTextblock) return true;
    if (block.type.name === "heading") {
      lines.push(block.textContent);
      return false;
    }
    let text = "";
    const marked: boolean[] = [];
    const cited: boolean[] = [];
    block.forEach((child) => {
      const piece = child.isText ? (child.text ?? "") : INLINE_NODE;
      text += piece;
      for (const _ of piece) {
        marked.push(child.marks.some((mark) => mark.type.name === CLAIM_CHECK_MARK));
        cited.push(child.type.name === CITATION_NODE);
      }
    });
    lines.push(text.replaceAll(INLINE_NODE, ""));
    for (const span of sentenceSpans(text)) {
      const words = text.slice(span.from, span.to).replaceAll(INLINE_NODE, "").trim();
      if (words === "") continue;
      sentences.push({
        text: words,
        cited: cited.slice(span.from, span.to).some(Boolean),
        marked: marked.slice(span.from, span.to).some(Boolean),
      });
    }
    return false;
  });
  return { text: lines.join("\n"), sentences };
}

async function noteNow(client: MindClient) {
  await client.settled();
  await resolveChanges(client, "accept");
  return sentencesOf(readMind(client));
}

/** Words, a Chinese character counting as one, as the Note's own count counts. */
const sizeOf = (text: string) => countFor(countText(text), "words");

/**
 * The sizes a reply states, read as a person would: multiples ("twice as long", "1.5 倍",
 * "加倍"), percentages, counts of words or characters, and of the sentences it says it added.
 */
function statedSizes(reply: string) {
  const multiples: number[] = [];
  const counts: { count: number; of: "words" | "sentences" }[] = [];
  const english = [
    [/\b(?:twice|double[sd]?|two times)\b/gi, () => 2],
    [/\b(?:three times|triple[sd]?)\b/gi, () => 3],
    [/\bhalf again\b/gi, () => 1.5],
    [/\b(\d+(?:\.\d+)?)\s*(?:times|×|x)\b/gi, (match: RegExpMatchArray) => Number(match[1])],
    [/\b(\d+)\s*%\s*(?:longer|more)/gi, (match: RegExpMatchArray) => 1 + Number(match[1]) / 100],
  ] as const;
  const chinese = [
    [/(?:两|二)倍|加倍|翻(?:了)?(?:一)?倍|(?:增加|扩充|扩写|加长)(?:了)?一倍/g, () => 2],
    [/(\d+(?:\.\d+)?)\s*倍/g, (match: RegExpMatchArray) => Number(match[1])],
    [/(?:三)倍/g, () => 3],
    [
      /(?:增加|加长|扩充|多)(?:了)?(?:约|大约|近)?(\d+)\s*%/g,
      (match: RegExpMatchArray) => 1 + Number(match[1]) / 100,
    ],
  ] as const;
  for (const [pattern, value] of [...english, ...chinese]) {
    for (const match of reply.matchAll(pattern)) {
      // "还没到两倍", "rather than the 2 times": a size said not to have been reached.
      const before = reply.slice(Math.max(0, (match.index ?? 0) - 24), match.index);
      if (
        /(?:没|未|不到|不足)[^，。,.]{0,6}$|\b(?:not|rather than|instead of)\b[^,.]{0,20}$/i.test(
          before,
        )
      ) {
        continue;
      }
      multiples.push(value(match));
    }
  }
  for (const match of reply.matchAll(/(\d[\d,]*)\s*(?:words|characters|个?字(?!段))/gi)) {
    counts.push({ count: Number((match[1] ?? "").replace(/,/g, "")), of: "words" });
  }
  for (const match of reply.matchAll(
    // Only a count of what was added: "Two sentences couldn't be checked" counts the checks.
    /\b(?:added|wrote)\s+(\d+|one|two|three|four|five|six)\s+(?:new\s+|more\s+)?sentences|(?:补充|新增|增加|添加)了?\s*(\d+)\s*(?:个)?句/gi,
  )) {
    const said = (match[1] ?? match[2] ?? "").toLowerCase();
    const named = ["one", "two", "three", "four", "five", "six"].indexOf(said);
    counts.push({ count: named >= 0 ? named + 1 : Number(said), of: "sentences" });
  }
  return { multiples, counts };
}

describe.each(LIVE)("Longer, at the length asked, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: "longer" grows the assistant's summary in place by about what was asked, every added sentence cited or marked, the reply's sizes measured`,
    { timeout: 3_600_000 },
    async () => {
      const limit = Number(process.env.INCARNAMIND_LIVE_LIMIT ?? 99);
      const report: string[] = [
        `## ${live.name} · ${live.model} (#1385, longer at the length asked)`,
      ];
      const totals: string[] = [];
      let spent = 0;
      const missed = { within: 0, covered: 0, truthful: 0, inPlace: 0, ran: 0 };
      const onlyLanguage = process.env.INCARNAMIND_LIVE_LANGUAGE;
      const onlyKinds = process.env.INCARNAMIND_LIVE_KINDS?.split(",");
      for (const each of LANGUAGES.filter(
        (one) => !onlyLanguage || one.language === onlyLanguage,
      )) {
        for (const kind of (
          ["a bit", "twice", "shorter", "longer", "own", "ownNone", "topic"] as const
        ).filter((one) => !onlyKinds || onlyKinds.includes(one))) {
          const requests = each.requests[kind].slice(0, limit);
          let within = 0;
          let covered = 0;
          let truthful = 0;
          let inPlace = 0;
          let ran = 0;
          let targetless = 0;
          let denied = 0;
          let claimLines = 0;
          let kept = 0;
          let sumSeconds = 0;
          let sumEdits = 0;
          let refusedOnce = 0;
          let refusedTwice = 0;
          for (const [index, request] of requests.entries()) {
            const longNote =
              kind === "topic" ? (each.language === "English" ? LONG_ENGLISH : LONG_CHINESE) : null;
            // The User's own Note, typed by them: the own kinds, and the first two topic adds.
            const typed = kind === "own" || kind === "ownNone" || (longNote !== null && index < 2);
            const typedLines = longNote ?? each.ownNote;
            let seeding = !typed;
            const seeded = seedModel(
              longNote
                ? {
                    ...each.seed,
                    content: longNote
                      .map((line, at) => `${line} [^${(at % each.seed.quotes.length) + 1}]`)
                      .join("\n\n"),
                  }
                : each.seed,
            );
            const core = startCore(await createTempDataFolder(), {
              createChatModel: (spec) => (seeding ? seeded : createAiSdkChatModel(spec)),
            });
            try {
              core.on(
                "consent.requested",
                (asked) => void core.respondToConsent(asked.requestId, true),
              );
              const questions: string[] = [];
              // The User reading the question passes it by, as one who asked for no choice would.
              core.on("question.asked", (asked) => {
                questions.push(asked.question.question);
                void core.answerUserQuestion(asked.requestId, { skipped: true });
              });
              await core.saveChatProvider({
                kind: live.kind,
                ...(live.apiKey && { apiKey: live.apiKey }),
                modelId: live.model,
              });
              const sources = await createSourceFolder();
              const folder = await core.createLibraryGroup({
                name: each.language,
                description: "",
              });
              const added = await core.addDocuments(
                [await writeSourceFile(sources, each.file, each.contents)],
                { groupId: folder.id },
              );
              await waitForProcessing(
                core,
                added.documents.map((document) => document.id),
              );
              const mind = await core.createMind({ title: each.language, folderId: folder.id });
              const client = await connectToMind(core, mind.id);
              await client.settled();
              // The User's own Note: typed by them, not written by the assistant.
              if (typed)
                writeMind(
                  client,
                  typedLines.map((line) => note(line)),
                );
              const first = typed ? null : await ask(core, each.first, mind.id, folder.id);
              seeding = false;
              const before = await noteNow(client);
              const startedAt = Date.now();
              const second = await ask(core, request, mind.id, folder.id);
              const seconds = (Date.now() - startedAt) / 1000;
              const after = await noteNow(client);
              ran++;
              const cjk = mostlyCjk(countText(before.text));
              const was = sizeOf(before.text);
              const now = sizeOf(after.text);
              const times = was === 0 ? 0 : now / was;
              const old = new Set(
                before.sentences.map((sentence) => comparableSentence(sentence.text)),
              );
              const addedSentences = after.sentences.filter(
                (sentence) => !old.has(comparableSentence(sentence.text)) && isClaim(sentence.text),
              );
              const bare = addedSentences.filter((sentence) => !sentence.cited && !sentence.marked);
              const stated = statedSizes(second.text);
              const falseMultiples = stated.multiples.filter(
                (multiple) => Math.abs(multiple - times) / Math.max(times, 0.01) > 0.2,
              );
              const falseCounts = stated.counts.filter(({ count, of }) =>
                of === "words"
                  ? Math.abs(count - now) / Math.max(now, 1) > 0.15 &&
                    Math.abs(count - was) / Math.max(was, 1) > 0.15 &&
                    Math.abs(count - (now - was)) / Math.max(now - was, 1) > 0.15
                  : Math.abs(count - addedSentences.length) > 1,
              );
              const salaries = after.text.match(each.salary)?.length ?? 0;
              const isWithin = WITHIN[kind](times);
              const isCovered = bare.length === 0 && addedSentences.length > 0;
              const isTruthful = falseMultiples.length === 0 && falseCounts.length === 0;
              const isInPlace = salaries <= 1 && now > 0;
              const edits = second.toolCalls.filter(
                (call) => call.tool === "edit_mind" || call.tool === "add_to_mind",
              );
              const refusals = edits.filter((call) => call.mindProblem?.kind === "length").length;
              sumSeconds += seconds;
              sumEdits += edits.length;
              if (refusals >= 1) refusedOnce++;
              if (refusals >= 2) refusedTwice++;
              if (!typed || typedLines.every((line) => after.text.includes(line))) kept++;
              const declared = second.toolCalls.some(
                (call) =>
                  call.input.times_as_long !== undefined && Number(call.input.times_as_long) !== 1,
              );
              const statesTarget = ASKED_LENGTH.test(second.text);
              const isTargetless = !declared && !statesTarget;
              const deniesChange = times !== 1 && SAYS_UNCHANGED.test(second.text);
              if (isWithin) within++;
              if (isCovered) covered++;
              if (isTruthful) truthful++;
              if (isInPlace) inPlace++;
              if (isTargetless) targetless++;
              if (deniesChange) denied++;
              const claimLine = (second.steps?.unbackedClaims?.length ?? 0) > 0;
              if (claimLine) claimLines++;
              const tools = second.toolCalls
                .map((call) => {
                  const how = [
                    "content" in call.input ? "content" : "",
                    "instruction" in call.input ? "instruction" : "",
                    call.input.times_as_long !== undefined
                      ? `×${String(call.input.times_as_long)}`
                      : "",
                  ].filter(Boolean);
                  return `${call.tool}${how.length > 0 ? `[${how.join(" ")}]` : ""}${call.mindProblem ? `!${call.mindProblem.kind}` : ""}`;
                })
                .join(", ");
              const lines = [
                `- ${each.language} · ${kind} · “${request}”: first ${first?.status ?? "typed"}, then ${second.status} (${tools || "no tools"}); ${was} → ${now} ${cjk ? "characters" : "words"} = ${times.toFixed(2)}×${isWithin ? "" : " OUT OF BOUND"}; added ${addedSentences.length} sentences, ${bare.length} with no Citation and no mark${isCovered ? "" : " UNCOVERED"}; reply states ${JSON.stringify(stated)}${isTruthful ? "" : " FALSE"}; salary ${salaries}×${isInPlace ? "" : " TWO SUMMARIES"}`,
                `  reply: ${second.text.replace(/\n/g, " ⏎ ").slice(0, 600)}`,
                `  claim line: ${claimLine ? JSON.stringify(second.steps?.unbackedClaims) : "none"}`,
                ...bare.map((sentence) => `  bare: ${sentence.text.slice(0, 200)}`),
                ...questions.map((question) => `  asked the User: ${question}`),
                `  note: ${after.text.replace(/\n/g, " ⏎ ").slice(0, 1200)}`,
              ];
              report.push(...lines);
              if (process.env.INCARNAMIND_LIVE_REPORT) {
                await appendFile(
                  `${process.env.INCARNAMIND_LIVE_REPORT}.runs`,
                  `${lines.join("\n")}\n`,
                );
              }
              missed.ran++;
              if (!isWithin) missed.within++;
              if (!isCovered) missed.covered++;
              if (!isTruthful) missed.truthful++;
              if (!isInPlace) missed.inPlace++;
            } finally {
              const cost = await core.getCostSummary();
              spent += cost.spent
                .filter((money) => money.currency === "USD")
                .reduce((sum, money) => sum + money.amount, 0);
              core.close();
            }
          }
          totals.push(
            `  ${each.language} · ${kind}: within ${within}/${ran}, every added sentence cited or marked ${covered}/${ran}, sizes stated truly ${truthful}/${ran}, one summary ${inPlace}/${ran}, no length declared or stated ${targetless}/${ran}, says nothing changed when it did ${denied}/${ran}, a claim line under the reply ${claimLines}/${ran}, the User's own text kept ${kept}/${ran}, ${(sumSeconds / Math.max(ran, 1)).toFixed(0)} s and ${(sumEdits / Math.max(ran, 1)).toFixed(1)} edit calls on average, refused once ${refusedOnce} twice ${refusedTwice}`,
          );
        }
      }
      report.push(...totals, `  spent: $${spent.toFixed(4)}`);
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      // The floors Claude Haiku 5.5 held on 16 requests (#1385): it reads some "a little" as twice.
      expect(missed.inPlace).toBe(0);
      expect(missed.covered).toBeLessThanOrEqual(1);
      expect(missed.truthful).toBeLessThanOrEqual(1);
      expect(missed.within).toBeLessThanOrEqual(missed.ran / 2);
    },
  );
});
