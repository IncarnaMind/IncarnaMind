/**
 * The cases of answerChecksCarried.live.test.ts (#2313), written and committed before any run:
 * made-up Documents and Questions, none of them a test fixture or a prompt example. Each case has
 * a Library of its own. Some Questions ask what the Documents say plainly; others ask for a reason
 * they don't give, or for a policy they don't have, so the Answer's own judgement has more than
 * Supported to give, and its Note more than Supported to carry.
 */

/** Each case is asked this many times, each time in a data folder of its own. */
export const RUNS = 2;

/**
 * How a Note is made from the Answer: Add to note into a Note that holds the User's own line, Add
 * to note with only the Answer's first cited paragraph selected, and Write as a note.
 */
export const ENTRY_POINTS = ["add", "selected", "write"] as const;

export interface CarriedCase {
  name: string;
  language: "en" | "zh-CN";
  documents: { name: string; contents: string }[];
  question: string;
}

export const CASES: readonly CarriedCase[] = [
  {
    name: "en, lease terms",
    language: "en",
    documents: [
      {
        name: "Unit 9 lease.md",
        contents: [
          "# Unit 9 lease",
          "",
          "The lease of Unit 9 at Harrow Yard runs for four years from 1 June 2027.",
          "",
          "The rent is 8,400 pounds a month, reviewed every 18 months.",
          "",
          "The tenant pays a service charge of 620 pounds a quarter.",
          "",
          "The deposit is two months' rent.",
        ].join("\n"),
      },
    ],
    question: "How long does the Unit 9 lease run, what is the rent, and what is the deposit?",
  },
  {
    name: "en, a reason the report doesn't give",
    language: "en",
    documents: [
      {
        name: "Ferry report 2026.md",
        contents: [
          "# Brackwater ferry report 2026",
          "",
          "The Brackwater ferry carried 41,200 passengers in 2026, up from 38,900 in 2025.",
          "",
          "The winter timetable ran from November to March with two sailings a day.",
          "",
          "The new vessel, Gannet, entered service in July.",
        ].join("\n"),
      },
    ],
    question: "Why did ferry passenger numbers rise in 2026, and by how much?",
  },
  {
    name: "en, a quote against a budget",
    language: "en",
    documents: [
      {
        name: "Kiln quote.md",
        contents:
          "# Supplier quote\n\nTwo K9 kilns cost 185,000 pounds, with delivery in 10 weeks. Installation is not included.\n",
      },
      {
        name: "Board minutes.md",
        contents:
          "# Board minutes, 3 September\n\nThe board approved a capital budget of 200,000 pounds for new kilns.\n",
      },
    ],
    question: "Is the kiln quote within the approved budget, and does it include installation?",
  },
  {
    name: "en, the busiest month",
    language: "en",
    documents: [
      {
        name: "Clinic visits.csv",
        contents: "Month,Visits\nJuly,1240\nAugust,1315\nSeptember,1188\n",
      },
    ],
    question: "Which month had the most clinic visits, and how many were there?",
  },
  {
    name: "en, a policy the handbook doesn't have",
    language: "en",
    documents: [
      {
        name: "Staff handbook.md",
        contents: [
          "# Staff handbook",
          "",
          "Staff get 25 days of annual leave plus public holidays.",
          "",
          "Remote work is allowed two days a week with a manager's approval.",
          "",
          "The office opens at 8:00 and closes at 18:30.",
        ].join("\n"),
      },
    ],
    question: "How many days of leave do staff get, and what is the parental leave policy?",
  },
  {
    name: "zh, 仓库租约",
    language: "zh-CN",
    documents: [
      {
        name: "七号仓库租约.md",
        contents: [
          "# 七号仓库租约",
          "",
          "七号仓库的租期为三年，自 2027 年 4 月 1 日起算。",
          "",
          "月租金为 26,000 元，每年上调 3%。",
          "",
          "押金为三个月租金。",
        ].join("\n"),
      },
    ],
    question: "七号仓库的租期多长？租金和押金各是多少？",
  },
  {
    name: "zh, 年报没写的原因",
    language: "zh-CN",
    documents: [
      {
        name: "社区图书馆年报.md",
        contents: [
          "# 社区图书馆 2026 年报",
          "",
          "2026 年借阅量为 58,300 册次，2025 年为 51,700 册次。",
          "",
          "周末开放时间延长到晚上九点。",
          "",
          "儿童阅览区于五月重新开放。",
        ].join("\n"),
      },
    ],
    question: "2026 年借阅量为什么增加了？增加了多少？",
  },
  {
    name: "zh, 报价和预算",
    language: "zh-CN",
    documents: [
      {
        name: "设备报价.md",
        contents: "# 供应商报价\n\n三台冷库压缩机共计 96,000 元，含运输，不含安装。\n",
      },
      {
        name: "会议纪要.md",
        contents: "# 9 月 12 日会议纪要\n\n管理层批准设备预算 100,000 元。\n",
      },
    ],
    question: "压缩机的报价在批准的预算之内吗？包含安装吗？",
  },
  {
    name: "zh, 客流最多的月份",
    language: "zh-CN",
    documents: [
      {
        name: "门店客流.csv",
        contents: "月份,客流\n七月,3420\n八月,3655\n九月,3198\n",
      },
    ],
    question: "哪个月门店客流最多？是多少人次？",
  },
  {
    name: "zh, 手册里没有的政策",
    language: "zh-CN",
    documents: [
      {
        name: "员工手册.md",
        contents: [
          "# 员工手册",
          "",
          "员工每年享有 15 天年假。",
          "",
          "每周可以居家办公一天，需经主管同意。",
          "",
          "办公室早上八点半开门，晚上六点关门。",
        ].join("\n"),
      },
    ],
    question: "员工有多少天年假？育儿假政策是怎样的？",
  },
];
