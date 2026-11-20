/**
 * Everyday check requests (#3432): a connected agent's Note, the invented Documents it was written
 * from, and the User asking, in their own words, whether it is right. Each Note has one sentence
 * the Documents contradict, or none. The Note was written in the same chat (its `create_mind` call
 * is in the history) or in an earlier one, when the User names it. A few requests ask a question
 * about the Documents and no check, so that a check started unasked is seen too. Every Document,
 * name and figure is invented for this repository.
 */
import type { Language } from "../../src/core/language";

export interface CheckRequest {
  id: string;
  language: Language;
  /** A check of the Note, or a question about the Documents that asks for none. */
  asks: "check" | "question";
  /** Where the agent wrote the Note: earlier in this chat, or in a chat before it. */
  written: "this-chat" | "earlier";
  documents: readonly { name: string; text: string }[];
  note: { title: string; sentences: readonly string[] };
  /** The sentences the Documents contradict, by their place in the Note from 0. */
  wrong: readonly number[];
  request: string;
}

const doc = (name: string, ...paragraphs: string[]) => ({
  name,
  text: `# ${name}\n\n${paragraphs.join("\n\n")}\n`,
});

const ENGLISH: readonly CheckRequest[] = [
  {
    id: "en-lease",
    language: "en",
    asks: "check",
    written: "this-chat",
    documents: [
      doc(
        "Unit 4 Fenwick Yard lease summary",
        "The tenant, Larkspur Design, leases Unit 4 at Fenwick Yard from 1 March 2026 for five years.",
        "Rent is £1,850 a month, payable in advance on the first working day of each month.",
        "Either side may end the lease after the third year by giving six months' written notice.",
        "The deposit is £5,550, three months' rent, held by the landlord's agent.",
      ),
    ],
    note: {
      title: "Office lease: the main terms",
      sentences: [
        "Larkspur Design's lease of Unit 4 at Fenwick Yard starts on 1 March 2026 and runs for five years.",
        "The rent is £1,850 a month, paid in advance.",
        "Either side can end the lease after the second year with three months' notice.",
        "The deposit is £5,550.",
      ],
    },
    wrong: [2],
    request: "Can you make sure this is all correct before I forward it to the landlord?",
  },
  {
    id: "en-clinic",
    language: "en",
    asks: "check",
    written: "this-chat",
    documents: [
      doc(
        "Moorbank Community Clinic service guide",
        "The clinic is open Monday to Friday from 8:00 to 18:30, and on Saturday from 9:00 to 12:30. It is closed on Sundays and public holidays.",
        "Walk-in appointments are offered every weekday morning until 11:00.",
        "The clinic has four nurses and two doctors; a pharmacist visits on Tuesdays and Thursdays.",
      ),
    ],
    note: {
      title: "Moorbank clinic at a glance",
      sentences: [
        "The clinic opens at 8:00 on weekdays and closes at 18:30.",
        "On Saturdays it is open from 9:00 to 13:30.",
        "Walk-ins are taken on weekday mornings until 11:00.",
        "A pharmacist visits on Tuesdays and Thursdays.",
      ],
    },
    wrong: [1],
    request: "Are these details right?",
  },
  {
    id: "en-grant",
    language: "en",
    asks: "check",
    written: "earlier",
    documents: [
      doc(
        "Ashgrove Community Garden grant report 2025",
        "The £12,000 grant from the Ashgrove Trust paid for 24 raised beds, a tool shed and a rainwater tank.",
        "Between April and September, 38 volunteers gave 1,140 hours.",
        "The garden held 9 open days, with 612 visitors in all.",
      ),
    ],
    note: {
      title: "Garden grant summary",
      sentences: [
        "The Ashgrove Trust's grant of £12,000 paid for 24 raised beds, a tool shed and a rainwater tank.",
        "38 volunteers gave 1,410 hours between April and September.",
        "The garden held 9 open days with 612 visitors.",
      ],
    },
    wrong: [1],
    request: "Please fact-check my note “Garden grant summary” against the grant report.",
  },
  {
    id: "en-offsite",
    language: "en",
    asks: "check",
    written: "this-chat",
    documents: [
      doc(
        "Heronsgate Lodge booking confirmation",
        "Booking for 14 guests, arriving Wednesday 15 April 2026 and leaving Friday 17 April 2026 (two nights).",
        "The rate is £96 per person per night, breakfast included. Dinner on the first night is booked for 19:30.",
      ),
      doc(
        "Team offsite travel plan",
        "The coach leaves the office at 8:15 on 15 April and returns by 17:00 on 17 April.",
      ),
    ],
    note: {
      title: "Offsite plan",
      sentences: [
        "14 of us stay at Heronsgate Lodge for two nights, from 15 to 17 April 2026.",
        "The room rate is £96 per person per night, with breakfast.",
        "The coach leaves the office at 9:15 on the first day.",
        "Dinner on the first night is at 19:30.",
      ],
    },
    wrong: [2],
    request: "Double-check that against the booking papers, would you?",
  },
  {
    id: "en-kettle",
    language: "en",
    asks: "check",
    written: "earlier",
    documents: [
      doc(
        "Calder K2 kettle specification sheet",
        "Capacity: 1.7 litres. Power: 3,000 watts. Boils one litre in about 2 minutes 40 seconds.",
        "Weight without water: 1.1 kg. Cord length: 75 cm.",
        "Recommended retail price: £44.99. Warranty: two years.",
      ),
    ],
    note: {
      title: "Kettle spec notes",
      sentences: [
        "The Calder K2 holds 1.7 litres and runs at 3,000 watts.",
        "It boils a litre in about 2 minutes 40 seconds.",
        "It weighs 1.1 kg empty and comes with a three-year warranty.",
      ],
    },
    wrong: [2],
    request: "Go over “Kettle spec notes” and tell me if anything doesn't match the spec sheet.",
  },
  {
    id: "en-leave",
    language: "en",
    asks: "check",
    written: "this-chat",
    documents: [
      doc(
        "Pinewell Studio staff leave policy",
        "Full-time staff get 25 days of annual leave a year, plus public holidays.",
        "Up to 5 unused days can be carried over to the next year, and must be taken by 31 March.",
        "Requests for more than 3 days in a row need two weeks' notice.",
      ),
    ],
    note: {
      title: "Leave policy in brief",
      sentences: [
        "Full-time staff get 25 days of annual leave, plus public holidays.",
        "Up to 5 unused days carry over and must be used by 31 March.",
        "Requests for more than 3 days in a row need two weeks' notice.",
      ],
    },
    wrong: [],
    request: "Is everything in there backed up by the policy?",
  },
  {
    id: "en-survey",
    language: "en",
    asks: "check",
    written: "this-chat",
    documents: [
      doc(
        "Riverside Library user survey 2025",
        "The survey had 842 responses, 61% of them online.",
        "78% of respondents were satisfied or very satisfied with opening hours.",
        "The most requested change was more study space, named by 312 respondents.",
      ),
    ],
    note: {
      title: "Library survey findings",
      sentences: [
        "842 people answered the survey, most of them online.",
        "78% were satisfied or very satisfied with the opening hours.",
        "More study space was the top request, named by 213 respondents.",
      ],
    },
    wrong: [2],
    request: "Verify it, please.",
  },
  {
    id: "en-bridge",
    language: "en",
    asks: "check",
    written: "earlier",
    documents: [
      doc(
        "Mill Lane footbridge repair site report, week 12",
        "Deck replacement is 70% complete. The new handrails arrive on 9 June.",
        "Spend to date is £186,400 of the £240,000 budget.",
        "The bridge is expected to reopen on 30 June, two weeks later than planned.",
      ),
    ],
    note: {
      title: "Bridge repair status",
      sentences: [
        "The deck replacement is 70% done.",
        "£186,400 of the £240,000 budget has been spent.",
        "The bridge should reopen on 30 June, on schedule.",
      ],
    },
    wrong: [2],
    request:
      "My manager wants the “Bridge repair status” note to be accurate. Can you review it against the site report?",
  },
  {
    id: "en-ferry-question",
    language: "en",
    asks: "question",
    written: "this-chat",
    documents: [
      doc(
        "Calloway ferry timetable, winter 2026",
        "Ferries leave Calloway at 7:10, 9:40, 12:15 and 16:50 on weekdays, and at 9:40 and 14:30 at weekends.",
        "The crossing takes 35 minutes. A return ticket costs £8.40 for adults.",
      ),
    ],
    note: {
      title: "Ferry times",
      sentences: [
        "Weekday ferries leave Calloway at 7:10, 9:40, 12:15 and 16:50.",
        "The crossing takes 35 minutes.",
      ],
    },
    wrong: [],
    request: "What time is the last ferry on a Saturday?",
  },
  {
    id: "en-pool-question",
    language: "en",
    asks: "question",
    written: "earlier",
    documents: [
      doc(
        "Oakfield Leisure Centre membership terms",
        "Monthly membership is £34; students pay £24 with a valid card.",
        "The pool is closed for cleaning every Monday from 6:00 to 9:00.",
      ),
    ],
    note: {
      title: "Gym membership notes",
      sentences: ["Monthly membership is £34.", "Students pay £24 with a valid card."],
    },
    wrong: [],
    request: "When is the pool at Oakfield closed for cleaning?",
  },
];

const CHINESE: readonly CheckRequest[] = [
  {
    id: "zh-lease",
    language: "zh-CN",
    asks: "check",
    written: "this-chat",
    documents: [
      doc(
        "云杉路商铺租赁合同要点",
        "承租方晨禾花艺自2026年3月1日起承租云杉路18号商铺，租期三年。",
        "月租金为9,800元，每季度第一个月5日前支付当季租金。",
        "押金为两个月租金，共19,600元。",
        "租期内任何一方提前解约，须提前60天书面通知对方。",
      ),
    ],
    note: {
      title: "商铺租约要点",
      sentences: [
        "晨禾花艺从2026年3月1日起承租云杉路18号商铺，租期三年。",
        "月租金9,800元，每月月初支付。",
        "押金为19,600元。",
        "提前解约须提前60天书面通知。",
      ],
    },
    wrong: [1],
    request: "这些内容都对吗？",
  },
  {
    id: "zh-clinic",
    language: "zh-CN",
    asks: "check",
    written: "this-chat",
    documents: [
      doc(
        "柳湾社区卫生服务站服务指南",
        "服务站周一至周五8:00至17:30开放，周六上午8:30至12:00开放，周日及法定节假日休息。",
        "每周二、周四下午有中医门诊。",
        "站内有全科医生3名、护士5名。",
      ),
    ],
    note: {
      title: "柳湾卫生站信息",
      sentences: [
        "工作日开放时间为8:00至17:30。",
        "周六全天开放。",
        "每周二、周四下午有中医门诊。",
        "站内有3名全科医生和5名护士。",
      ],
    },
    wrong: [1],
    request: "帮我看看有没有写错的地方。",
  },
  {
    id: "zh-books",
    language: "zh-CN",
    asks: "check",
    written: "earlier",
    documents: [
      doc(
        "青石社区图书角补助项目总结",
        "项目获得区文化基金补助3.6万元，用于采购图书和书架。",
        "共采购图书1,280册，其中少儿读物540册。",
        "2025年图书角共接待读者2,315人次，举办读书会14场。",
      ),
    ],
    note: {
      title: "社区图书角补助小结",
      sentences: [
        "图书角项目获得区文化基金补助3.6万元。",
        "共采购图书1,280册，其中少儿读物450册。",
        "2025年共接待读者2,315人次，举办读书会14场。",
      ],
    },
    wrong: [1],
    request: "把《社区图书角补助小结》和项目总结对一遍。",
  },
  {
    id: "zh-trip",
    language: "zh-CN",
    asks: "check",
    written: "this-chat",
    documents: [
      doc(
        "部门秋季团建安排",
        "团建定于2026年10月16日至17日，地点为松溪山庄，共22人参加。",
        "10月16日上午8:30在公司楼下集合，乘大巴出发。",
        "住宿为双人间，人均费用680元，含一晚住宿和三餐。",
      ),
    ],
    note: {
      title: "团建行程",
      sentences: [
        "团建在10月16日至17日，去松溪山庄，共22人。",
        "16日上午9:30在公司楼下集合出发。",
        "人均费用680元，含住宿和三餐。",
      ],
    },
    wrong: [1],
    request: "发给大家之前，确认一下有没有错。",
  },
  {
    id: "zh-purifier",
    language: "zh-CN",
    asks: "check",
    written: "earlier",
    documents: [
      doc(
        "清泉Q5净水器产品参数",
        "额定净水流量：每分钟1.8升。",
        "PP棉滤芯建议每6个月更换，RO反渗透滤芯建议每24个月更换。",
        "整机尺寸：45×18×42厘米，重量9.5千克。",
        "建议零售价2,699元，整机保修三年。",
      ),
    ],
    note: {
      title: "净水器参数整理",
      sentences: [
        "清泉Q5每分钟出水1.8升。",
        "RO滤芯建议每12个月更换一次。",
        "整机保修三年，建议零售价2,699元。",
      ],
    },
    wrong: [1],
    request: "帮我检查一下笔记《净水器参数整理》里的数据准不准。",
  },
  {
    id: "zh-leave",
    language: "zh-CN",
    asks: "check",
    written: "this-chat",
    documents: [
      doc(
        "启明设计请假管理办法",
        "员工每年享有带薪年假：工作满1年不满10年的为5天，满10年不满20年的为10天。",
        "病假须在3个工作日内补交医院证明。",
        "连续请假超过3天的，须由部门负责人和人事部共同审批。",
      ),
    ],
    note: {
      title: "请假制度要点",
      sentences: [
        "工作满1年不满10年的员工每年有5天带薪年假。",
        "病假须在5个工作日内补交医院证明。",
        "连续请假超过3天，须部门负责人和人事部共同审批。",
      ],
    },
    wrong: [1],
    request: "这份笔记跟制度文件一致吗？",
  },
  {
    id: "zh-survey",
    language: "zh-CN",
    asks: "check",
    written: "this-chat",
    documents: [
      doc(
        "南溪公园游客满意度调查报告",
        "本次调查共回收有效问卷1,026份。",
        "对公园环境卫生表示满意的占86%，对停车便利表示满意的占41%。",
        "游客最希望增加的设施是儿童游乐区，选择人数为387人。",
      ),
    ],
    note: {
      title: "公园调查结论",
      sentences: [
        "调查共回收有效问卷1,026份。",
        "86%的游客对环境卫生表示满意。",
        "游客最希望增加的设施是儿童游乐区。",
      ],
    },
    wrong: [],
    request: "帮我核实一下里面的内容。",
  },
  {
    id: "zh-renovation",
    language: "zh-CN",
    asks: "check",
    written: "earlier",
    documents: [
      doc(
        "桂花里小区改造工程周报（第8周）",
        "外墙保温施工已完成65%。",
        "截至本周累计支出312万元，总预算480万元。",
        "受雨季影响，预计竣工日期由11月30日推迟至12月20日。",
      ),
    ],
    note: {
      title: "老旧小区改造进度",
      sentences: [
        "外墙保温已完成65%。",
        "累计支出312万元，总预算480万元。",
        "工程预计11月30日按期竣工。",
      ],
    },
    wrong: [2],
    request: "领导要看《老旧小区改造进度》，你先帮我审一下，看看和工程周报对不对得上。",
  },
  {
    id: "zh-canteen-question",
    language: "zh-CN",
    asks: "question",
    written: "this-chat",
    documents: [
      doc(
        "职工食堂就餐须知",
        "午餐供应时间为11:30至13:00，晚餐供应时间为17:30至19:00。",
        "员工餐标准为每餐15元，由公司补贴10元。",
      ),
    ],
    note: {
      title: "食堂就餐",
      sentences: ["午餐11:30至13:00供应。", "员工每餐标准15元。"],
    },
    wrong: [],
    request: "晚餐几点开始供应？",
  },
  {
    id: "zh-parking-question",
    language: "zh-CN",
    asks: "question",
    written: "earlier",
    documents: [
      doc(
        "园区停车管理规定",
        "园区内员工车位实行月卡管理，月卡费用为每月150元。",
        "访客车辆凭登记可免费停放2小时，超时按每小时5元收费。",
      ),
    ],
    note: {
      title: "停车规定",
      sentences: ["员工月卡每月150元。", "访客登记后可免费停放2小时。"],
    },
    wrong: [],
    request: "园区访客停车超过两小时怎么收费？",
  },
];

export const CHECK_REQUESTS: readonly CheckRequest[] = [...ENGLISH, ...CHINESE];
