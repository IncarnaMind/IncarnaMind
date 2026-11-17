/** Twelve invented reports someone else wrote, for the brief's proof (#3277): six English, six Chinese; eight PDFs, four Word files. */

export interface BriefCase {
  id: string;
  language: "English" | "Chinese";
  format: "pdf" | "word";
  title: string;
  /** The report's paragraphs, after its title; the first of each section is its heading. */
  sections: { heading: string; lines: string[] }[];
}

export const BRIEF_CASES: readonly BriefCase[] = [
  {
    id: "en-ferry",
    language: "English",
    format: "pdf",
    title: "Harbour ferry service review",
    sections: [
      {
        heading: "Summary",
        lines: [
          "The ferry service between Northquay and the island carried 184,000 passengers in 2025, up 9% on the year before.",
          "The review finds that the service is worth keeping, but that the winter timetable needs to change.",
        ],
      },
      {
        heading: "Findings",
        lines: [
          "Between November and February the 7:15 crossing ran at 31% of its capacity, while the 17:40 crossing was full on 62 of 90 weekdays.",
          "The two ferries were out of service for a combined 41 days, 28 of them for the same engine fault.",
          "Fares were last raised in 2022, and income covered 58% of the running costs in 2025.",
          "A survey of 1,200 passengers found that 83% would pay up to 50 pence more for a later last boat.",
        ],
      },
      {
        heading: "Recommendations",
        lines: [
          "The council should move the 7:15 crossing to 8:00 and add a 21:30 return crossing from the mainland on Fridays and Saturdays.",
          "It should replace the engine on the older ferry before next winter, at an estimated cost of £310,000.",
          "A fare rise of 40 pence in April would bring cost recovery to about 64%.",
        ],
      },
    ],
  },
  {
    id: "en-library",
    language: "English",
    format: "pdf",
    title: "Library evening opening trial",
    sections: [
      {
        heading: "Summary",
        lines: [
          "Five branch libraries opened until 8 pm on weekdays for 16 weeks from September to December 2025.",
          "The trial shows that evening opening reaches people the daytime hours do not, and it should continue at three of the five branches.",
        ],
      },
      {
        heading: "Findings",
        lines: [
          "Evening visits averaged 46 an hour, against 31 an hour in the afternoon, and 38% of evening visitors had not used the library in the previous year.",
          "The Eastgate and Millbrook branches averaged fewer than 12 visits an hour after 6 pm.",
          "Staffing the extra hours cost £2,300 a week per branch, of which £700 came from the volunteer scheme.",
          "Computer bookings rose by 44% in the evening and meeting-room bookings doubled.",
        ],
      },
      {
        heading: "Next steps",
        lines: [
          "Evening opening should continue at Central, Riverside and Hartley, and stop at Eastgate and Millbrook.",
          "The volunteer scheme should be extended so that it covers at least £1,000 of each branch's weekly cost.",
        ],
      },
    ],
  },
  {
    id: "en-cycle",
    language: "English",
    format: "pdf",
    title: "Cycle lane safety audit, Ashford Road",
    sections: [
      {
        heading: "Summary",
        lines: [
          "The audit covered the 3.4 km of protected cycle lane on Ashford Road, opened in March 2024.",
          "The lane has cut collisions, but its junctions are still where cyclists are hurt, and four of them should be redesigned.",
        ],
      },
      {
        heading: "Findings",
        lines: [
          "Reported collisions involving cyclists fell from 19 in the 12 months before opening to 11 in the 12 months after.",
          "Seven of the 11 collisions happened at junctions where the lane crosses a side road.",
          "At the Mill Lane and Church Street junctions, 22% of left-turning drivers did not give way, from a sample of 400.",
          "Cycle counts rose from 1,100 to 1,900 a day at the busiest point.",
        ],
      },
      {
        heading: "Recommendations",
        lines: [
          "The four junctions with the most conflicts should get raised crossings and a 10 mph approach, at about £85,000 each.",
          "Parking should be removed for 20 metres either side of each, to give drivers a clear view.",
        ],
      },
    ],
  },
  {
    id: "en-meals",
    language: "English",
    format: "pdf",
    title: "School meals pilot: one year on",
    sections: [
      {
        heading: "Summary",
        lines: [
          "Twelve primary schools offered a free breakfast to every pupil in 2024/25.",
          "The pilot raised attendance and took pressure off the lunch hour, and the cost per child is lower than expected.",
        ],
      },
      {
        heading: "Findings",
        lines: [
          "Take-up averaged 61% of pupils, and reached 78% in the three schools that served breakfast in the classroom.",
          "Attendance rose by 1.4 percentage points, from 94.1% to 95.5%, against a rise of 0.3 points in comparison schools.",
          "The cost came to £0.87 a child a day, against a budget of £1.10.",
          "Teachers in 9 of 12 schools reported calmer starts to the morning.",
        ],
      },
      {
        heading: "Recommendation",
        lines: [
          "The pilot should expand to all 41 primary schools, with classroom serving as the standard method.",
          "At current take-up the full scheme would cost about £1.4 million a year.",
        ],
      },
    ],
  },
  {
    id: "en-allotments",
    language: "English",
    format: "word",
    title: "Allotment waiting list report",
    sections: [
      {
        heading: "Summary",
        lines: [
          "There were 640 people on the allotment waiting list at the end of June 2025, for 412 plots.",
          "The list is too long to be cleared by the current supply, and the council should create new plots and shorten the wait by sharing plots.",
        ],
      },
      {
        heading: "Findings",
        lines: [
          "The average wait is now 3.8 years, up from 2.1 years in 2020.",
          "Only 14 plots became free in the last year, and 9 of those were returned by tenants who had held them for over 20 years.",
          "A third of the plots are larger than 250 square metres, which is more than most new tenants say they can manage.",
          "The council owns 11 hectares of land near the railway that is not in use.",
        ],
      },
      {
        heading: "Recommendations",
        lines: [
          "Split the 60 largest plots into halves, which would free up to 60 places within a year.",
          "Prepare four of the 11 hectares near the railway for 80 new plots, at a cost of about £190,000.",
        ],
      },
    ],
  },
  {
    id: "en-shelters",
    language: "English",
    format: "word",
    title: "Bus shelter maintenance review",
    sections: [
      {
        heading: "Summary",
        lines: [
          "The council looks after 318 bus shelters, and 74 of them are in poor condition.",
          "Repairs are slow because there is no single owner, and the review proposes a rolling programme under one team.",
        ],
      },
      {
        heading: "Findings",
        lines: [
          "A repair takes 47 days on average from report to fix, and 12% of reports were never closed.",
          "Glass replacement accounts for 52% of the spending, and most of it is for shelters on three roads.",
          "Shelters that have been cleaned on a fortnightly cycle had 40% fewer reports of damage than the others.",
          "Three different teams hold part of the budget, which came to £260,000 in 2024/25.",
        ],
      },
      {
        heading: "Recommendations",
        lines: [
          "One team should hold the whole budget and visit every shelter once a quarter.",
          "Toughened glass should be fitted at the 25 shelters with the most breakages, at about £1,800 a shelter.",
        ],
      },
    ],
  },
  {
    id: "zh-library",
    language: "Chinese",
    format: "pdf",
    title: "社区图书馆延时开放试点报告",
    sections: [
      {
        heading: "概述",
        lines: [
          "东城区五个社区图书馆在2025年9月至12月试行工作日开放到晚上8点。",
          "试点表明，延时开放吸引了白天来不了的读者，应当在其中三个馆继续实行。",
        ],
      },
      {
        heading: "主要发现",
        lines: [
          "晚间平均每小时到馆46人，下午为31人，晚间读者中有38%一年内没有来过图书馆。",
          "清河馆和南湾馆晚6点后每小时到馆不足12人。",
          "延长开放的人员费用为每馆每周2,300元，其中700元由志愿者服务承担。",
          "晚间电脑预约增加了44%，会议室预约增加了一倍。",
        ],
      },
      {
        heading: "建议",
        lines: [
          "中心馆、河滨馆和华亭馆应继续晚间开放，清河馆和南湾馆则停止。",
          "应扩大志愿者服务，使其每周至少承担每馆1,000元的费用。",
        ],
      },
    ],
  },
  {
    id: "zh-elevators",
    language: "Chinese",
    format: "pdf",
    title: "老旧小区加装电梯情况报告",
    sections: [
      {
        heading: "概述",
        lines: [
          "全市2025年共有186个老旧小区申请加装电梯，已完工的有97个。",
          "加装电梯总体进展良好，但费用分担和施工期长仍是主要障碍，需要出台更明确的分摊办法。",
        ],
      },
      {
        heading: "主要发现",
        lines: [
          "从申请到完工平均需要14个月，其中征求居民意见一项就占了5个月。",
          "每部电梯平均造价为58万元，政府补贴20万元，其余由住户分摊。",
          "一楼住户的同意率只有63%，而三楼以上住户的同意率达到91%。",
          "有29个项目因为个别住户不同意而停工超过半年。",
        ],
      },
      {
        heading: "建议",
        lines: [
          "应规定一楼住户按三楼以上住户一半的比例分摊费用，以提高同意率。",
          "应把征求意见的期限压缩到两个月，逾期按多数意见办理。",
        ],
      },
    ],
  },
  {
    id: "zh-bikes",
    language: "Chinese",
    format: "pdf",
    title: "共享单车停放整治评估",
    sections: [
      {
        heading: "概述",
        lines: [
          "2025年上半年，市区划定了3,200个共享单车停放区，并对乱停放行为进行整治。",
          "整治显著减少了乱停放，但夜间的投诉仍然偏多，应当增加夜间巡查。",
        ],
      },
      {
        heading: "主要发现",
        lines: [
          "乱停放投诉从每月5,400件降到2,100件，降幅为61%。",
          "夜间22时至次日6时的投诉占投诉总数的44%，而这段时间的巡查人员只有白天的三分之一。",
          "停放区内的车辆占比从52%上升到87%。",
          "三家运营企业中，有一家的违规停放率仍是其他两家的两倍。",
        ],
      },
      {
        heading: "建议",
        lines: [
          "夜间巡查人员应增加到白天的一半，所需经费约每年180万元。",
          "对违规停放率最高的企业，应按其超出部分扣减投放额度。",
        ],
      },
    ],
  },
  {
    id: "zh-canteen",
    language: "Chinese",
    format: "pdf",
    title: "社区食堂试点评估",
    sections: [
      {
        heading: "概述",
        lines: [
          "六个社区食堂自2024年10月起为60岁以上居民提供午餐，试点已满一年。",
          "试点让老年人吃得更方便，成本也基本可以承受，建议在全区推广，但要解决周末用餐不足的问题。",
        ],
      },
      {
        heading: "主要发现",
        lines: [
          "工作日平均每个食堂每天供应212份午餐，周末只有87份。",
          "每份午餐的成本为18.5元，居民支付12元，差额由街道补贴。",
          "问卷调查中，89%的受访者表示愿意继续在食堂用餐，其中独居老人占41%。",
          "有两个食堂的厨房设备已接近满负荷，晚餐无法开办。",
        ],
      },
      {
        heading: "建议",
        lines: [
          "在全区42个街道各建一个食堂，预计每年需要补贴约960万元。",
          "周末应改为每周两次集中供餐，以降低人手成本。",
        ],
      },
    ],
  },
  {
    id: "zh-lighting",
    language: "Chinese",
    format: "word",
    title: "公园夜间照明改造报告",
    sections: [
      {
        heading: "概述",
        lines: [
          "滨江公园在2025年更换了全部步道照明，共安装节能灯具412盏。",
          "改造后照明更亮、更省电，夜间安全感明显提升，但个别区段对周边居民造成了光污染。",
        ],
      },
      {
        heading: "主要发现",
        lines: [
          "照明用电量从每月3.6万度降到1.9万度，下降47%。",
          "夜间到访人数增加了28%，居民问卷中认为夜间“安全”的比例从54%上升到81%。",
          "东段有九盏灯的照射方向正对居民楼，收到了17起投诉。",
          "灯具总投入为148万元，按电费节省计算，约三年半可以收回。",
        ],
      },
      {
        heading: "建议",
        lines: [
          "东段九盏灯应加装遮光罩，并调低亮度，费用约1.2万元。",
          "午夜之后可将步道照明调暗到一半亮度，预计每年再省电8%。",
        ],
      },
    ],
  },
  {
    id: "zh-sorting",
    language: "Chinese",
    format: "word",
    title: "垃圾分类推广情况报告",
    sections: [
      {
        heading: "概述",
        lines: [
          "2025年全区207个小区全部设置了分类投放点，分类准确率提升到72%。",
          "分类工作取得了明显进展，但厨余垃圾的混投仍然严重，需要把工作重点转向厨余垃圾。",
        ],
      },
      {
        heading: "主要发现",
        lines: [
          "分类准确率从2024年的48%提高到72%，其中干垃圾和可回收物已超过85%。",
          "厨余垃圾的准确率仅为54%，混入的主要是塑料袋，占混投量的六成。",
          "有督导员的小区准确率为81%，没有督导员的小区只有59%。",
          "每个督导员每月的费用为2,400元，全区共需要督导员310名。",
        ],
      },
      {
        heading: "建议",
        lines: [
          "优先给准确率低于60%的63个小区配备督导员，所需经费约每年180万元。",
          "推广可破袋的厨余垃圾桶，让居民不必再把整袋垃圾扔进去。",
        ],
      },
    ],
  },
];
