/**
 * The workspace of test Minds and the requests that change several of them
 * at once (README.md). Each request says what must hold afterwards; `checks.ts`
 * holds every run to it.
 */

export type Language = "en" | "zh-CN";

/** A Mind to seed: its Blocks in Markdown-ish lines ("## " a heading), as eval/everyday writes them. */
export interface SeedMind {
  title: string;
  blocks: readonly string[];
}

/** Words a text must hold: one of each group's alternatives, since a model may reword a name or a date. */
export type Facts = readonly (readonly string[])[];

export type Rule =
  /** The section ends up with at most `sentences` sentences, shorter, and still holds one of `keeps`; the rest of the Mind is as it was. */
  | { kind: "shorten"; section: string; sentences: number; keeps: readonly string[] }
  /** The section holds the facts and every Block that was there is unchanged; the rest of the Mind is as it was. */
  | { kind: "add"; section: string; facts: Facts }
  /** Every Block reads as it did with `from` written as `to`, and nothing else differs. */
  | { kind: "replace"; from: string; to: string };

export interface Expected {
  /** The Minds that must change, by title, and what each must hold afterwards. */
  changed: Readonly<Record<string, Rule>>;
  /** One new Mind: its title must hold one of these, and its text every group of facts. */
  made?: { title: readonly string[]; facts: Facts };
  /** The Mind asked for isn't there: nothing changes, and the reply names it. */
  missing?: string;
}

export interface MindsCase {
  id: string;
  language: Language;
  request: string;
  /** The Mind in front when it is asked, by title; none: asked from Home. */
  open: string | null;
  /** The Library also holds `DOCUMENTS`, or these Documents, so the model can search them too. */
  documents?: true | readonly LibraryText[];
  /** The Minds it names hold only AI text: a Meeting's notes filled after Stop ("ai"), or what an Answer added ("answer"). */
  sources?: "ai" | "answer";
  /** More Minds beside the workspace's, such as near namesakes of the one it names (#1865). */
  extra?: readonly SeedMind[];
  /** What the User picks when the assistant asks which Mind, by its label; none: the Answer stops at the question. */
  choose?: string;
  expected: Expected;
}

const HARBOUR_TITLES = {
  en: ["Harbour plan", "Harbour budget", "Harbour risks"],
  "zh-CN": ["港口计划", "港口预算", "港口风险"],
} as const;

const WORKSPACE_EN: readonly SeedMind[] = [
  {
    title: "Weekly update",
    blocks: [
      "## Summary",
      "This week the team finished the new onboarding flow, fixed 14 of the 20 open bugs, and ran the first round of user tests with 8 customers. Feedback was mostly positive, although three customers found the sign-up form confusing, so we plan to redesign it next sprint. The server migration is on track for 20 March, and spending is still within 4% of the plan.",
      "## Blockers",
      "Waiting on legal to approve the new privacy text.",
    ],
  },
  {
    title: "Monthly report",
    blocks: [
      "## Summary",
      "Revenue for September was €312,000, up 6% on August, with the largest gains in the Nordic region. Support tickets fell by a fifth after the help centre was rewritten, and the average response time dropped to 3 hours. Two senior engineers joined in September, which brings the team to 23 people, and the office move is planned for November.",
      "## Numbers",
      "Revenue €312,000; costs €268,000; new customers 41.",
    ],
  },
  {
    title: "Board brief",
    blocks: [
      "## Summary",
      "The company closed the quarter with 118 customers and a cash runway of 19 months. The main risk is the delay of the Nordic launch, which moved from June to August because of a certification backlog. Management proposes to hire two more sales staff and to keep the research budget flat for the rest of the year.",
      "## Asks of the board",
      "Approve the two sales hires.",
    ],
  },
  {
    title: "Project plan",
    blocks: [
      "## Goals",
      "Launch the customer portal in all regions.",
      "## Milestones",
      "Beta opens on 2 February with the Nordic pilot group.",
      "Public launch on 1 March.",
      "## Risks",
      "Legal review may take longer than planned.",
    ],
  },
  {
    title: "Meeting notes",
    blocks: [
      "## Attendees",
      "Maria, Tom and Priya.",
      "## Decisions",
      "Hire a part-time designer.",
      "## Action items",
      "Tom to send the revised budget by Friday.",
    ],
  },
  {
    title: "Harbour plan",
    blocks: [
      "## Scope",
      "The main supplier delivers the cranes in two batches. Every supplier signs the safety checklist before work starts.",
      "## Timeline",
      "The first supplier visit is in May, and the second is in September.",
    ],
  },
  {
    title: "Harbour budget",
    blocks: [
      "## Costs",
      "Supplier invoices are paid within 30 days of receipt.",
      "The supplier discount is 4% for orders over €50,000.",
      "## Contingency",
      "Ten percent is kept back in case a supplier raises its prices.",
    ],
  },
  {
    title: "Harbour risks",
    blocks: [
      "## Supplier risks",
      "If the supplier misses a delivery, the crane installation slips by a month.",
      "## Other risks",
      "Bad weather can stop work for several days.",
    ],
  },
  {
    title: "Warehouse notes",
    blocks: ["## Stock", "The supplier of pallets changed in August."],
  },
];

const WORKSPACE_ZH: readonly SeedMind[] = [
  {
    title: "周报",
    blocks: [
      "## 摘要",
      "本周团队完成了新的用户引导流程，修复了 20 个未解决问题中的 14 个，并与 8 位客户进行了第一轮用户测试。反馈整体积极，但有三位客户觉得注册表单不够清楚，因此我们计划在下个迭代中重新设计。服务器迁移预计在 3 月 20 日完成，支出仍在计划的 4% 以内。",
      "## 阻碍",
      "等待法务批准新的隐私条款。",
    ],
  },
  {
    title: "月报",
    blocks: [
      "## 摘要",
      "9 月收入为 31.2 万欧元，比 8 月增长 6%，增幅最大的是北欧地区。帮助中心重写之后，客服工单减少了五分之一，平均响应时间降到 3 小时。9 月有两位资深工程师加入，团队达到 23 人，办公室计划在 11 月搬迁。",
      "## 数据",
      "收入 31.2 万欧元；成本 26.8 万欧元；新增客户 41 家。",
    ],
  },
  {
    title: "董事会简报",
    blocks: [
      "## 摘要",
      "公司本季度结束时有 118 家客户，现金可维持 19 个月。主要风险是北欧发布推迟，由于认证积压，从 6 月推迟到了 8 月。管理层建议再招聘两名销售人员，并在今年余下的时间里保持研发预算不变。",
      "## 请董事会批准",
      "批准增聘两名销售人员。",
    ],
  },
  {
    title: "项目计划",
    blocks: [
      "## 目标",
      "在所有地区上线客户门户。",
      "## 里程碑",
      "内测于 2 月 2 日开始，先面向北欧试点小组。",
      "正式发布在 3 月 1 日。",
      "## 风险",
      "法务审核可能比计划花更长的时间。",
    ],
  },
  {
    title: "会议纪要",
    blocks: [
      "## 参会人",
      "玛丽亚、汤姆和普丽娅。",
      "## 决定",
      "聘请一名兼职设计师。",
      "## 待办事项",
      "汤姆周五前发出修订后的预算。",
    ],
  },
  {
    title: "港口计划",
    blocks: [
      "## 范围",
      "主要供应商分两批交付起重机。每家供应商在开工前都要签署安全检查表。",
      "## 时间表",
      "第一次供应商访问在 5 月，第二次在 9 月。",
    ],
  },
  {
    title: "港口预算",
    blocks: [
      "## 费用",
      "供应商发票在收到后 30 天内支付。",
      "订单超过 5 万欧元时，供应商给 4% 的折扣。",
      "## 应急",
      "预留百分之十，以防供应商涨价。",
    ],
  },
  {
    title: "港口风险",
    blocks: [
      "## 供应商风险",
      "如果供应商错过一次交货，起重机安装会推迟一个月。",
      "## 其他风险",
      "恶劣天气可能让施工停止好几天。",
    ],
  },
  {
    title: "仓库笔记",
    blocks: ["## 库存", "托盘的供应商在 8 月更换了。"],
  },
];

export const WORKSPACES: Readonly<Record<Language, readonly SeedMind[]>> = {
  en: WORKSPACE_EN,
  "zh-CN": WORKSPACE_ZH,
};

const PLAN_DRAFT: Readonly<Record<Language, SeedMind>> = {
  en: {
    title: "Project plan (draft)",
    blocks: [
      "## Goals",
      "Launch the customer portal in the Nordic region first.",
      "## Milestones",
      "Beta opens in February.",
      "## Risks",
      "Hiring may be slow.",
    ],
  },
  "zh-CN": {
    title: "项目计划（草稿）",
    blocks: [
      "## 目标",
      "先在北欧上线客户门户。",
      "## 里程碑",
      "内测在 2 月开始。",
      "## 风险",
      "招聘可能偏慢。",
    ],
  },
};

const BUDGETS: Readonly<Record<Language, readonly SeedMind[]>> = {
  en: [2024, 2025].map((year) => ({
    title: `Budget ${year}`,
    blocks: [
      "## Summary",
      `The ${year} budget is €2.4 million, up 5% on the year before, after a long review of every team's plans with the finance group. Most of the increase goes to the support team, which grows by three people so that customers in the Nordic region get answers on the same day. Travel and office costs stay flat, as they have for three years, and the research budget is held at €300,000. A reserve of €50,000 is kept back for the second half, to be released only if sales reach the target set in March.`,
      "## Notes",
      "Approved by the board.",
    ],
  })),
  "zh-CN": [2024, 2025].map((year) => ({
    title: `${year}年预算`,
    blocks: [
      "## 摘要",
      `${year} 年预算为 240 万欧元，比上一年增长 5%，这是和财务组逐一审核各团队计划之后定下的。增加的部分大多用于客服团队，团队将增加三人，让北欧地区的客户当天就能得到答复。差旅和办公费用与过去三年一样保持不变，研发预算维持在 30 万欧元。另有 5 万欧元的储备留到下半年，只有销售额达到三月定下的目标才会动用。`,
      "## 备注",
      "已获董事会批准。",
    ],
  })),
};

/** A Document of the same name as the Mind "Budget 2025", which the request means (#1865). */
const BUDGET_DOCUMENT: Readonly<Record<Language, LibraryText>> = {
  en: {
    file: "Budget 2025.md",
    text: "# Budget 2025\n\nFinance's draft, sent on 3 October. It asks for €2.6 million, with two more people in sales, and cuts travel by a tenth.\n",
  },
  "zh-CN": {
    file: "2025年预算.md",
    text: "# 2025年预算\n\n财务部 10 月 3 日发来的草案：申请 260 万欧元，销售增加两人，差旅削减一成。\n",
  },
};

const budgetShortened = (language: Language): Expected => ({
  changed: {
    [language === "en" ? "Budget 2025" : "2025年预算"]: {
      kind: "shorten",
      section: language === "en" ? "Summary" : "摘要",
      sentences: 2,
      keeps: language === "en" ? ["2.4 million", "5%", "300,000"] : ["240", "5%", "30"],
    },
  },
});

/** The Minds the requests for a new note from two name. */
export const SOURCES: Readonly<Record<Language, readonly string[]>> = {
  en: ["Project plan", "Meeting notes"],
  "zh-CN": ["项目计划", "会议纪要"],
};

/** A Document written for the Library, by its file name. */
export interface LibraryText {
  file: string;
  text: string;
}

/** Documents of other matters, for a request asked in a Library that has some: nothing of them belongs in its answer. */
export const DOCUMENTS: Readonly<Record<Language, readonly LibraryText[]>> = {
  en: [
    {
      file: "Supplier contract.md",
      text: "# Supplier contract\n\nThis agreement between Northwind Ltd and Harbour Freight runs for two years from 1 January 2026. Harbour Freight delivers within 5 working days of an order. Either party may end the agreement with three months' notice. A late delivery earns a credit of 2% of the order's value for each day.\n",
    },
    {
      file: "Q3 sales figures.md",
      text: "# Q3 sales figures\n\nSales in the third quarter were €1.2 million, up 8% on the second quarter. The German market grew fastest, at 15%. The average order was €2,400, and 61 new customers signed.\n",
    },
  ],
  "zh-CN": [
    {
      file: "供应商合同.md",
      text: "# 供应商合同\n\n本合同由北风有限公司与海港货运签订，自 2026 年 1 月 1 日起生效，为期两年。海港货运须在下单后 5 个工作日内交货。任何一方提前三个月书面通知即可终止合同。每延迟交货一天，按订单金额的 2% 抵扣。\n",
    },
    {
      file: "第三季度销售数据.md",
      text: "# 第三季度销售数据\n\n第三季度销售额为 120 万欧元，比第二季度增长 8%。德国市场增长最快，达 15%。平均订单金额为 2,400 欧元，新签客户 61 家。\n",
    },
  ],
};

const shortenAll = (language: Language): Expected => {
  const keeps =
    language === "en"
      ? {
          "Weekly update": ["20 March", "14", "onboarding"],
          "Monthly report": ["312,000", "23", "6%"],
          "Board brief": ["118", "19 months", "Nordic"],
        }
      : {
          周报: ["3 月 20 日", "14", "用户引导"],
          月报: ["31.2", "23", "6%"],
          董事会简报: ["118", "19 个月", "北欧"],
        };
  const section = language === "en" ? "Summary" : "摘要";
  return {
    changed: Object.fromEntries(
      Object.entries(keeps).map(([title, words]) => [
        title,
        { kind: "shorten", section, sentences: 2, keeps: words },
      ]),
    ),
  };
};

/** A line holding the decision to open the beta to 50 customers, added to `section`. */
const fifty = (language: Language, section: string): Rule => ({
  kind: "add",
  section,
  facts: [
    language === "en"
      ? ["50 customers", "50 pilot customers", "50"]
      : ["50 位客户", "50 个客户", "50 家客户", "50"],
  ],
});

const decision = (language: Language): Expected =>
  language === "en"
    ? {
        changed: {
          "Project plan": fifty("en", "Milestones"),
          "Meeting notes": fifty("en", "Decisions"),
        },
      }
    : { changed: { 项目计划: fifty("zh-CN", "里程碑"), 会议纪要: fifty("zh-CN", "决定") } };

const term = (language: Language): Expected => {
  const rule: Rule =
    language === "en"
      ? { kind: "replace", from: "supplier", to: "vendor" }
      : { kind: "replace", from: "供应商", to: "供货方" };
  return { changed: Object.fromEntries(HARBOUR_TITLES[language].map((title) => [title, rule])) };
};

const launchBrief = (language: Language): Expected =>
  language === "en"
    ? {
        changed: {},
        made: {
          title: ["Launch brief"],
          facts: [
            ["Nordic pilot", "2 February", "February 2"],
            ["part-time designer", "part time designer"],
          ],
        },
      }
    : {
        changed: {},
        made: {
          title: ["发布简报"],
          facts: [["北欧试点", "2 月 2 日", "2月2日"], ["兼职设计师"]],
        },
      };

export const CASES: readonly MindsCase[] = [
  {
    id: "shorten-three-en",
    language: "en",
    request:
      "Shorten the summary in Weekly update, Monthly report and Board brief to two sentences each.",
    open: null,
    expected: shortenAll("en"),
  },
  {
    id: "shorten-three-zh",
    language: "zh-CN",
    request: "把周报、月报和董事会简报这三个笔记里的摘要各缩短成两句话。",
    open: null,
    expected: shortenAll("zh-CN"),
  },
  {
    id: "decision-two-en",
    language: "en",
    request:
      "Today we decided to open the beta to 50 customers. Add that to the Milestones in the Project plan and to the Decisions in the Meeting notes.",
    open: null,
    expected: decision("en"),
  },
  {
    id: "decision-two-zh",
    language: "zh-CN",
    request:
      "今天我们决定内测向 50 位客户开放。把这条加到项目计划的里程碑里，也加到会议纪要的决定里。",
    open: null,
    expected: decision("zh-CN"),
  },
  {
    id: "term-three-en",
    language: "en",
    request:
      "In Harbour plan, Harbour budget and Harbour risks, change “supplier” to “vendor” everywhere.",
    open: null,
    expected: term("en"),
  },
  {
    id: "term-three-zh",
    language: "zh-CN",
    request: "在港口计划、港口预算和港口风险这三个笔记里，把“供应商”都改成“供货方”。",
    open: null,
    expected: term("zh-CN"),
  },
  {
    id: "term-one-open-en",
    language: "en",
    request:
      "In Harbour plan, Harbour budget and Harbour risks, change “supplier” to “vendor” everywhere.",
    open: "Harbour budget",
    expected: term("en"),
  },
  {
    id: "term-one-open-zh",
    language: "zh-CN",
    request: "在港口计划、港口预算和港口风险这三个笔记里，把“供应商”都改成“供货方”。",
    open: "港口预算",
    expected: term("zh-CN"),
  },
  {
    id: "new-from-two-en",
    language: "en",
    request:
      "Make a new Note called Launch brief from my Project plan Note and my Meeting notes Note: the milestones from the plan and the decisions from the notes.",
    open: null,
    expected: launchBrief("en"),
  },
  {
    id: "new-from-two-zh",
    language: "zh-CN",
    request:
      "用项目计划和会议纪要这两个笔记新建一个叫“发布简报”的笔记：放进计划里的里程碑和纪要里的决定。",
    open: null,
    expected: launchBrief("zh-CN"),
  },
  {
    id: "new-from-two-plain-en",
    language: "en",
    request:
      "Make a new note called Launch brief from the Project plan and the Meeting notes: the milestones from the plan and the decisions from the notes.",
    open: null,
    expected: launchBrief("en"),
  },
  {
    id: "new-from-two-plain-zh",
    language: "zh-CN",
    request: "用项目计划和会议纪要新建一份叫“发布简报”的笔记：放进计划里的里程碑和纪要里的决定。",
    open: null,
    expected: launchBrief("zh-CN"),
  },
  {
    id: "new-from-two-plain-docs-en",
    language: "en",
    request:
      "Make a new note called Launch brief from the Project plan and the Meeting notes: the milestones from the plan and the decisions from the notes.",
    open: null,
    documents: true,
    expected: launchBrief("en"),
  },
  {
    id: "new-from-two-plain-docs-zh",
    language: "zh-CN",
    request: "用项目计划和会议纪要新建一份叫“发布简报”的笔记：放进计划里的里程碑和纪要里的决定。",
    open: null,
    documents: true,
    expected: launchBrief("zh-CN"),
  },
  {
    id: "new-from-two-plain-ai-en",
    language: "en",
    request:
      "Make a new note called Launch brief from the Project plan and the Meeting notes: the milestones from the plan and the decisions from the notes.",
    open: null,
    sources: "ai",
    expected: launchBrief("en"),
  },
  {
    id: "new-from-two-plain-ai-zh",
    language: "zh-CN",
    request: "用项目计划和会议纪要新建一份叫“发布简报”的笔记：放进计划里的里程碑和纪要里的决定。",
    open: null,
    sources: "ai",
    expected: launchBrief("zh-CN"),
  },
  {
    id: "new-from-two-plain-made-en",
    language: "en",
    request:
      "Make a new note called Launch brief from the Project plan and the Meeting notes: the milestones from the plan and the decisions from the notes.",
    open: null,
    sources: "answer",
    expected: launchBrief("en"),
  },
  {
    id: "new-from-two-plain-made-zh",
    language: "zh-CN",
    request: "用项目计划和会议纪要新建一份叫“发布简报”的笔记：放进计划里的里程碑和纪要里的决定。",
    open: null,
    sources: "answer",
    expected: launchBrief("zh-CN"),
  },
  {
    id: "namesake-add-en",
    language: "en",
    request:
      "Today we decided to open the beta to 50 customers. Add that to the Milestones in the Project plan.",
    open: null,
    extra: [PLAN_DRAFT.en],
    choose: "Project plan",
    expected: { changed: { "Project plan": fifty("en", "Milestones") } },
  },
  {
    id: "namesake-add-zh",
    language: "zh-CN",
    request: "今天我们决定内测向 50 位客户开放。把这条加到项目计划的里程碑里。",
    open: null,
    extra: [PLAN_DRAFT["zh-CN"]],
    choose: "项目计划",
    expected: { changed: { 项目计划: fifty("zh-CN", "里程碑") } },
  },
  {
    id: "namesake-year-en",
    language: "en",
    request: "Shorten the summary in Budget 2025 to two sentences.",
    open: null,
    extra: BUDGETS.en,
    choose: "Budget 2025",
    expected: budgetShortened("en"),
  },
  {
    id: "namesake-year-zh",
    language: "zh-CN",
    request: "把 2025年预算 里的摘要缩短成两句话。",
    open: null,
    extra: BUDGETS["zh-CN"],
    choose: "2025年预算",
    expected: budgetShortened("zh-CN"),
  },
  {
    id: "namesake-document-en",
    language: "en",
    request: "Shorten the summary in Budget 2025 to two sentences.",
    open: null,
    extra: BUDGETS.en.filter((mind) => mind.title === "Budget 2025"),
    documents: [BUDGET_DOCUMENT.en],
    expected: budgetShortened("en"),
  },
  {
    id: "namesake-document-zh",
    language: "zh-CN",
    request: "把 2025年预算 里的摘要缩短成两句话。",
    open: null,
    extra: BUDGETS["zh-CN"].filter((mind) => mind.title === "2025年预算"),
    documents: [BUDGET_DOCUMENT["zh-CN"]],
    expected: budgetShortened("zh-CN"),
  },
  {
    id: "missing-mind-en",
    language: "en",
    request: "Shorten the summary in my Budget forecast Note.",
    open: "Project plan",
    expected: { changed: {}, missing: "Budget forecast" },
  },
  {
    id: "missing-mind-zh",
    language: "zh-CN",
    request: "把我的预算预测笔记里的摘要缩短一点。",
    open: "项目计划",
    expected: { changed: {}, missing: "预算预测" },
  },
];
