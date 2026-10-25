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

const decision = (language: Language): Expected =>
  language === "en"
    ? {
        changed: {
          "Project plan": {
            kind: "add",
            section: "Milestones",
            facts: [["50 customers", "50 pilot customers", "50"]],
          },
          "Meeting notes": {
            kind: "add",
            section: "Decisions",
            facts: [["50 customers", "50 pilot customers", "50"]],
          },
        },
      }
    : {
        changed: {
          项目计划: {
            kind: "add",
            section: "里程碑",
            facts: [["50 位客户", "50 个客户", "50 家客户", "50"]],
          },
          会议纪要: {
            kind: "add",
            section: "决定",
            facts: [["50 位客户", "50 个客户", "50 家客户", "50"]],
          },
        },
      };

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
    request: "把周报、月报和董事会简报这三个 Mind 里的摘要各缩短成两句话。",
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
    request: "在港口计划、港口预算和港口风险这三个 Mind 里，把“供应商”都改成“供货方”。",
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
    request: "在港口计划、港口预算和港口风险这三个 Mind 里，把“供应商”都改成“供货方”。",
    open: "港口预算",
    expected: term("zh-CN"),
  },
  {
    id: "new-from-two-en",
    language: "en",
    request:
      "Make a new Mind called Launch brief from my Project plan Mind and my Meeting notes Mind: the milestones from the plan and the decisions from the notes.",
    open: null,
    expected: launchBrief("en"),
  },
  {
    id: "new-from-two-zh",
    language: "zh-CN",
    request:
      "用项目计划和会议纪要这两个 Mind 新建一个叫“发布简报”的 Mind：放进计划里的里程碑和纪要里的决定。",
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
    id: "missing-mind-en",
    language: "en",
    request: "Shorten the summary in my Budget forecast Mind.",
    open: "Project plan",
    expected: { changed: {}, missing: "Budget forecast" },
  },
  {
    id: "missing-mind-zh",
    language: "zh-CN",
    request: "把我的预算预测 Mind 里的摘要缩短一点。",
    open: "项目计划",
    expected: { changed: {}, missing: "预算预测" },
  },
];
