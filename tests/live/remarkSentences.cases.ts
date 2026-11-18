/**
 * Notes as an assistant or an outside agent writes them: facts from a Document, and beside them
 * the writer's own remarks about the Note (#3320): where its content came from, what the writer
 * was asked or given, what it could or couldn't open, and a reminder to verify. No Document could
 * state a remark, so a check leaves it without a mark. Each Note also holds facts a check has to
 * read, some with a remark in the same sentence, and wrong twins; several facts look like a
 * remark (who made a survey, what its interviewers couldn't reach, what a patient must do) and are
 * stated by the Document. On invented Documents of a few lines.
 *
 * The memo Notes (`-j`, #3322) hold the writer's own judgements, steps, criteria and definitions,
 * some with a figure or a date, beside facts, opinions a Document reports, and a Document's own
 * recommendations, duties and forecasts with their wrong twins: advice is the writer's own only
 * when no Document gives it.
 *
 * The set is fixed: a Note is not edited once a baseline rests on it, and a new shape is a new Note.
 */
export interface RemarkNote {
  id: string;
  language: "en" | "zh-CN";
  /** The Document's name, which a source line in the Note gives. */
  name: string;
  document: string;
  lines: readonly {
    sentence: string;
    /** None: the writer's own remark, advice or judgement, which a check leaves without a mark. */
    expected: "right" | "wrong" | "none";
    /** The factual part of a sentence that also holds a remark. */
    part?: string;
  }[];
}

export const REMARK_NOTES: readonly RemarkNote[] = [
  {
    id: "en-r1",
    language: "en",
    name: "Ferry service review",
    document:
      "The ferry to Carrow Island runs six times a day in summer and three times a day in winter. A single crossing takes 35 minutes. The ferry carried 86,400 passengers in 2025.",
    lines: [
      { sentence: "The ferry to Carrow Island runs six times a day in summer.", expected: "right" },
      { sentence: "A single crossing takes 25 minutes.", expected: "wrong" },
      {
        sentence: "Source: the Ferry service review in the Port Ellery folder.",
        expected: "none",
      },
      {
        sentence:
          "Please check the passenger figure against the operator's own count before it is published.",
        expected: "none",
      },
    ],
  },
  {
    id: "en-r2",
    language: "en",
    name: "Lease summary",
    document:
      "The lease of Unit 4 runs for five years from 1 March 2025. The rent is £2,400 a month, reviewed every two years. The tenant may end the lease on six months' written notice.",
    lines: [
      { sentence: "The lease of Unit 4 runs for five years from 1 March 2025.", expected: "right" },
      {
        sentence: "The rent of £2,600 a month is the figure you gave me in your message.",
        expected: "none",
      },
      {
        sentence:
          "The tenant may end the lease on six months' written notice, which is worth confirming with the landlord.",
        expected: "right",
        part: "The tenant may end the lease on six months' written notice",
      },
      {
        sentence: "This note should be read by a solicitor before anyone relies on it.",
        expected: "none",
      },
    ],
  },
  {
    id: "en-r3",
    language: "en",
    name: "Household survey 2026",
    document:
      "The survey was carried out by Wrenlow & Pike between 3 and 21 March 2026. Interviewers could not reach 14 of the 320 households. The results should be read with the 2024 survey, which used the same questions.",
    lines: [
      {
        sentence: "The survey was carried out by Wrenlow & Pike in March 2026.",
        expected: "right",
      },
      { sentence: "Interviewers could not reach 14 of the 320 households.", expected: "right" },
      {
        sentence: "The results should be read with the 2022 survey, which used the same questions.",
        expected: "wrong",
      },
      {
        sentence: "I could open only this one file; the second file in the folder would not load.",
        expected: "none",
      },
      { sentence: "This summary was drafted from that file alone.", expected: "none" },
    ],
  },
  {
    id: "en-r4",
    language: "en",
    name: "Budget memo",
    document:
      "The marketing budget for 2026 is £3.2 million, 8% more than in 2025. Events take £900,000 of it. The memo was approved by the board on 14 January 2026.",
    lines: [
      { sentence: "The marketing budget for 2026 is £3.2 million.", expected: "right" },
      {
        sentence: "Events take £1.9 million of it, a figure worth double-checking.",
        expected: "wrong",
        part: "Events take £1.9 million of it",
      },
      { sentence: "All figures above are taken from the Budget memo.", expected: "none" },
      { sentence: "The memo was approved by the board on 14 January 2026.", expected: "right" },
      { sentence: "As requested, the note leaves out the staffing section.", expected: "none" },
    ],
  },
  {
    id: "en-r5",
    language: "en",
    name: "Clinic opening hours",
    document:
      "The clinic opens at 8 am on weekdays and closes at 6 pm. On Saturdays it opens from 9 am to 1 pm. Patients must book vaccinations at least two days ahead.",
    lines: [
      { sentence: "The clinic opens at 8 am on weekdays and closes at 6 pm.", expected: "right" },
      { sentence: "On Saturdays it opens from 9 am to 3 pm.", expected: "wrong" },
      { sentence: "Patients must book vaccinations at least two days ahead.", expected: "right" },
      {
        sentence: "Confirm the Saturday hours with the clinic before you print this.",
        expected: "none",
      },
      { sentence: "I found nothing else to draw on, so the note is short.", expected: "none" },
    ],
  },
  {
    id: "en-r6",
    language: "en",
    name: "Supplier review",
    document:
      "Quillfield Packaging delivered 96% of orders on time in 2026. Its prices rose 4% in January 2026. The contract with Quillfield ends on 30 June 2027.",
    lines: [
      {
        sentence: "Quillfield Packaging delivered 96% of orders on time in 2026.",
        expected: "right",
      },
      { sentence: "The contract with Quillfield ends on 30 June 2028.", expected: "wrong" },
      { sentence: "Source: Supplier review (Purchasing folder).", expected: "none" },
      {
        sentence: "The on-time figure you mentioned on the phone, 98%, is not used here.",
        expected: "none",
      },
      {
        sentence: "Both dates need a second look before the renewal meeting.",
        expected: "none",
      },
    ],
  },
  {
    id: "zh-r1",
    language: "zh-CN",
    name: "渡轮服务评估",
    document:
      "前往青屿的渡轮夏季每天开六班，冬季每天开三班。单程航行35分钟。2025年渡轮共运送旅客86,400人次。",
    lines: [
      { sentence: "前往青屿的渡轮夏季每天开六班，冬季每天开三班。", expected: "right" },
      { sentence: "单程航行25分钟。", expected: "wrong" },
      { sentence: "来源：《渡轮服务评估》（港口文件夹）。", expected: "none" },
      { sentence: "旅客人数发布前请再与运营方核对一次。", expected: "none" },
    ],
  },
  {
    id: "zh-r2",
    language: "zh-CN",
    name: "租约摘要",
    document:
      "4号单元的租期为五年，自2025年3月1日起算。月租金为24,000元，每两年调整一次。承租人提前六个月书面通知即可解约。",
    lines: [
      { sentence: "4号单元的租期为五年，自2025年3月1日起算。", expected: "right" },
      { sentence: "月租金26,000元是你在消息里给我的数字。", expected: "none" },
      {
        sentence: "承租人提前六个月书面通知即可解约，这一点建议再向房东确认。",
        expected: "right",
        part: "承租人提前六个月书面通知即可解约",
      },
      { sentence: "这份笔记在使用前应请律师过目。", expected: "none" },
    ],
  },
  {
    id: "zh-r3",
    language: "zh-CN",
    name: "2026年住户调查",
    document:
      "本次调查由栎川咨询于2026年3月3日至21日完成。320户中有14户未能联系上。调查结果应与2024年的调查对照阅读，两次调查的问题相同。",
    lines: [
      { sentence: "本次调查由栎川咨询于2026年3月完成。", expected: "right" },
      { sentence: "320户中有14户未能联系上。", expected: "right" },
      { sentence: "调查结果应与2022年的调查对照阅读，两次调查的问题相同。", expected: "wrong" },
      { sentence: "我只打开了这一份文件，文件夹里的另一份没能加载。", expected: "none" },
      { sentence: "本摘要仅依据这一份文件写成。", expected: "none" },
    ],
  },
  {
    id: "zh-r4",
    language: "zh-CN",
    name: "预算备忘录",
    document:
      "2026年市场部预算为320万元，比2025年增加8%。其中活动费用为90万元。该备忘录已于2026年1月14日经董事会批准。",
    lines: [
      { sentence: "2026年市场部预算为320万元。", expected: "right" },
      {
        sentence: "其中活动费用为190万元，这个数字值得再核对。",
        expected: "wrong",
        part: "其中活动费用为190万元",
      },
      { sentence: "以上数字均取自《预算备忘录》。", expected: "none" },
      { sentence: "该备忘录已于2026年1月14日经董事会批准。", expected: "right" },
      { sentence: "按你的要求，笔记没有写人员编制部分。", expected: "none" },
    ],
  },
  {
    id: "zh-r5",
    language: "zh-CN",
    name: "门诊开放时间",
    document:
      "门诊工作日上午8点开门，下午6点关门。周六上午9点至下午1点开放。接种疫苗须至少提前两天预约。",
    lines: [
      { sentence: "门诊工作日上午8点开门，下午6点关门。", expected: "right" },
      { sentence: "周六上午9点至下午3点开放。", expected: "wrong" },
      { sentence: "接种疫苗须至少提前两天预约。", expected: "right" },
      { sentence: "打印前请先向门诊确认周六的时间。", expected: "none" },
      { sentence: "我没有找到其他可用的材料，所以笔记比较短。", expected: "none" },
    ],
  },
  {
    id: "zh-r6",
    language: "zh-CN",
    name: "供应商评估",
    document:
      "栎川包装2026年的订单准时交付率为96%。其价格在2026年1月上调4%。与栎川包装的合同于2027年6月30日到期。",
    lines: [
      { sentence: "栎川包装2026年的订单准时交付率为96%。", expected: "right" },
      { sentence: "与栎川包装的合同于2028年6月30日到期。", expected: "wrong" },
      { sentence: "来源：《供应商评估》（采购文件夹）。", expected: "none" },
      { sentence: "你在电话里提到的准时率98%，这里没有采用。", expected: "none" },
      { sentence: "这两个日期在续约会议前都需要再看一遍。", expected: "none" },
    ],
  },
  {
    id: "en-j1",
    language: "en",
    name: "Warehouse quotes",
    document:
      "Dunmerrow Logistics quotes £18,400 a month for 2,000 pallet places in Leeds. Harrowfinch Storage quotes £16,900 a month for 1,800 pallet places in Wakefield. Both contracts run for three years with a break after eighteen months. Dunmerrow's quote includes racking; Harrowfinch charges £22,000 once for it.",
    lines: [
      {
        sentence: "Dunmerrow Logistics quotes £18,400 a month for 2,000 pallet places in Leeds.",
        expected: "right",
      },
      {
        sentence:
          "Harrowfinch Storage quotes £16,900 a month for 2,000 pallet places in Wakefield.",
        expected: "wrong",
      },
      { sentence: "Of the two, Dunmerrow is the safer choice.", expected: "none" },
      {
        sentence:
          "The risk of running out of space is low this year and higher next year; that is my own reading.",
        expected: "none",
      },
      {
        sentence: "Ask both firms for a reference from a customer of similar size.",
        expected: "none",
      },
      {
        sentence: "Ask Harrowfinch for 2 or 3 references before the board meets on 14 March.",
        expected: "none",
      },
      {
        sentence:
          "Go ahead if the reference calls raise no concern; stop if either firm refuses to give one.",
        expected: "none",
      },
      {
        sentence: 'In this memo, "cost" means the monthly fee without the one-off racking charge.',
        expected: "none",
      },
      {
        sentence: "Both contracts run for three years, which seems long for a first agreement.",
        expected: "right",
        part: "Both contracts run for three years",
      },
      {
        sentence:
          "Harrowfinch charges £12,000 once for racking, which I would try to negotiate away.",
        expected: "wrong",
        part: "Harrowfinch charges £12,000 once for racking",
      },
    ],
  },
  {
    id: "en-j2",
    language: "en",
    name: "Support team report",
    document:
      "The support team has 6 agents and answered 9,200 tickets in 2026. Median first reply time was 4 hours 10 minutes. The head of support, Mara Lindqvist, said the team cannot keep that time if volume grows. Ticket volume is forecast to grow 15% in 2027.",
    lines: [
      {
        sentence: "The support team has 6 agents and answered 9,200 tickets in 2026.",
        expected: "right",
      },
      {
        sentence: "Mara Lindqvist said the team cannot keep that reply time if volume grows.",
        expected: "right",
      },
      {
        sentence: "Mara Lindqvist said the team can keep that reply time even if volume grows.",
        expected: "wrong",
      },
      { sentence: "Ticket volume is forecast to grow 15% in 2027.", expected: "right" },
      { sentence: "Median first reply time was 2 hours 10 minutes.", expected: "wrong" },
      { sentence: "We should hire before the summer rather than after it.", expected: "none" },
      { sentence: "My suggestion is 2 more agents, starting in May.", expected: "none" },
      {
        sentence: "You know the budget better than I do, so treat the number as a starting point.",
        expected: "none",
      },
      { sentence: "The question is no longer whether to hire but when.", expected: "none" },
      {
        sentence:
          "If median first reply time passes 5 hours in any month, bring the second hire forward.",
        expected: "none",
      },
    ],
  },
  {
    id: "zh-j1",
    language: "zh-CN",
    name: "仓库报价",
    document:
      "敦沐物流报价每月184,000元，提供2,000个托盘位，地点在苏州。栎川仓储报价每月169,000元，提供1,800个托盘位，地点在昆山。两份合同期限均为三年，满十八个月可解约。敦沐物流的报价含货架；栎川仓储另收一次性货架费220,000元。",
    lines: [
      {
        sentence: "敦沐物流报价每月184,000元，提供2,000个托盘位，地点在苏州。",
        expected: "right",
      },
      {
        sentence: "栎川仓储报价每月169,000元，提供2,000个托盘位，地点在昆山。",
        expected: "wrong",
      },
      { sentence: "两家之中，敦沐物流是更稳妥的选择。", expected: "none" },
      { sentence: "今年仓位不够的风险不高，明年会更高（这是我的判断）。", expected: "none" },
      { sentence: "请两家各提供一位规模相近的客户作为参考。", expected: "none" },
      { sentence: "请栎川仓储在3月14日董事会前提供2到3位参考客户。", expected: "none" },
      {
        sentence: "参考客户没有提出问题就继续推进；任何一家拒绝提供就停下来。",
        expected: "none",
      },
      { sentence: "本备忘录中的“成本”指月费，不含一次性货架费。", expected: "none" },
      {
        sentence: "两份合同期限均为三年，对第一次合作来说似乎偏长。",
        expected: "right",
        part: "两份合同期限均为三年",
      },
      {
        sentence: "栎川仓储另收一次性货架费120,000元，这一项我会争取谈掉。",
        expected: "wrong",
        part: "栎川仓储另收一次性货架费120,000元",
      },
    ],
  },
  {
    id: "zh-j2",
    language: "zh-CN",
    name: "客服团队报告",
    document:
      "客服团队有6名客服，2026年共处理工单9,200张。首次回复时间的中位数为4小时10分钟。客服负责人林若棠表示，如果工单量继续增长，团队无法保持这一回复时间。预计2027年工单量增长15%。",
    lines: [
      { sentence: "客服团队有6名客服，2026年共处理工单9,200张。", expected: "right" },
      {
        sentence: "林若棠表示，如果工单量继续增长，团队无法保持这一回复时间。",
        expected: "right",
      },
      {
        sentence: "林若棠表示，即使工单量继续增长，团队也能保持这一回复时间。",
        expected: "wrong",
      },
      { sentence: "预计2027年工单量增长15%。", expected: "right" },
      { sentence: "首次回复时间的中位数为2小时10分钟。", expected: "wrong" },
      { sentence: "我们应该在夏天之前招人，而不是之后。", expected: "none" },
      { sentence: "我的建议是增加2名客服，5月到岗。", expected: "none" },
      { sentence: "预算你比我清楚，这个数字只作为起点。", expected: "none" },
      { sentence: "现在的问题不是招不招，而是什么时候招。", expected: "none" },
      {
        sentence: "如果任何一个月首次回复时间的中位数超过5小时，就把第二个人的招聘提前。",
        expected: "none",
      },
    ],
  },
  {
    id: "en-j3",
    language: "en",
    name: "Fleet review",
    document:
      "The fleet has 14 vans, 9 of them older than eight years. The reviewer, Tolland Marsh Consulting, recommends replacing 6 vans by the end of September 2027 and keeping the other 8 until 2029. Drivers must check tyre pressure every Monday. Maintenance cost £96,000 in 2026 and is forecast to reach £110,000 in 2027.",
    lines: [
      { sentence: "The fleet has 14 vans, 9 of them older than eight years.", expected: "right" },
      {
        sentence: "The review recommends replacing 6 vans by the end of September 2027.",
        expected: "right",
      },
      {
        sentence: "The review recommends replacing 9 vans by the end of September 2027.",
        expected: "wrong",
      },
      {
        sentence: "Replace 6 vans by the end of September 2027 and keep the other 8 until 2029.",
        expected: "right",
      },
      { sentence: "Replace 6 vans by the end of March 2027.", expected: "wrong" },
      { sentence: "Drivers must check tyre pressure every Monday.", expected: "right" },
      { sentence: "Drivers must check tyre pressure every Friday.", expected: "wrong" },
      { sentence: "Maintenance cost is forecast to reach £110,000 in 2027.", expected: "right" },
      { sentence: "Maintenance cost is forecast to reach £130,000 in 2027.", expected: "wrong" },
      {
        sentence:
          "I would book a call with the reviewer before 20 November to go through the list.",
        expected: "none",
      },
      { sentence: "My own view is that 2029 is too late.", expected: "none" },
      {
        sentence: "Set aside 2 days in January to compare lease offers from 3 dealers.",
        expected: "none",
      },
    ],
  },
  {
    id: "zh-j3",
    language: "zh-CN",
    name: "车队评估",
    document:
      "车队共有14辆货车，其中9辆车龄超过八年。评估方拓岚咨询建议在2027年9月底前更换6辆，其余8辆保留到2029年。司机必须每周一检查胎压。2026年维修费用为96万元，预计2027年将达到110万元。",
    lines: [
      { sentence: "车队共有14辆货车，其中9辆车龄超过八年。", expected: "right" },
      { sentence: "评估报告建议在2027年9月底前更换6辆货车。", expected: "right" },
      { sentence: "评估报告建议在2027年9月底前更换9辆货车。", expected: "wrong" },
      { sentence: "在2027年9月底前更换6辆货车，其余8辆保留到2029年。", expected: "right" },
      { sentence: "在2027年3月底前更换6辆货车。", expected: "wrong" },
      { sentence: "司机必须每周一检查胎压。", expected: "right" },
      { sentence: "司机必须每周五检查胎压。", expected: "wrong" },
      { sentence: "预计2027年维修费用将达到110万元。", expected: "right" },
      { sentence: "预计2027年维修费用将达到130万元。", expected: "wrong" },
      { sentence: "我打算在11月20日前约评估方通个电话，把清单过一遍。", expected: "none" },
      { sentence: "我个人认为保留到2029年太晚了。", expected: "none" },
      { sentence: "1月份留出2天时间，比较3家经销商的租赁报价。", expected: "none" },
    ],
  },
  {
    id: "en-j4",
    language: "en",
    name: "Office energy audit",
    document:
      "The office used 412,000 kWh of electricity in 2026, down from 455,000 kWh in 2025. Heating accounts for 38% of the total. The auditor, Brackenhall Energy, says the boiler is 19 years old. The solar panels on the roof produced 61,000 kWh in 2026.",
    lines: [
      {
        sentence:
          "The office used 412,000 kWh of electricity in 2026, which strikes me as a lot for a building this size.",
        expected: "right",
        part: "The office used 412,000 kWh of electricity in 2026",
      },
      {
        sentence:
          "The office used 512,000 kWh of electricity in 2026, which strikes me as a lot for a building this size.",
        expected: "wrong",
        part: "The office used 512,000 kWh of electricity in 2026",
      },
      {
        sentence: "Heating accounts for 38% of the total, the first thing I would look at.",
        expected: "right",
        part: "Heating accounts for 38% of the total",
      },
      {
        sentence: "The boiler is 19 years old, and in my opinion that is past the point of repair.",
        expected: "right",
        part: "The boiler is 19 years old",
      },
      {
        sentence: "The boiler is 9 years old, and in my opinion that is past the point of repair.",
        expected: "wrong",
        part: "The boiler is 9 years old",
      },
      {
        sentence: "The solar panels produced 61,000 kWh in 2026, a better result than I expected.",
        expected: "right",
        part: "The solar panels produced 61,000 kWh in 2026",
      },
      { sentence: "I left the 2024 figures out of this note to keep it short.", expected: "none" },
      {
        sentence: "The 500,000 kWh you quoted in your email is not the figure used in this note.",
        expected: "none",
      },
      { sentence: "A 10% cut by 2028 looks realistic to me.", expected: "none" },
    ],
  },
  {
    id: "zh-j4",
    language: "zh-CN",
    name: "办公室能耗审计",
    document:
      "办公室2026年用电412,000千瓦时，低于2025年的455,000千瓦时。供暖占总用电量的38%。审计方柏岭能源表示，锅炉已使用19年。屋顶太阳能板2026年发电61,000千瓦时。",
    lines: [
      {
        sentence: "办公室2026年用电412,000千瓦时，在我看来对这种规模的楼来说偏多。",
        expected: "right",
        part: "办公室2026年用电412,000千瓦时",
      },
      {
        sentence: "办公室2026年用电512,000千瓦时，在我看来对这种规模的楼来说偏多。",
        expected: "wrong",
        part: "办公室2026年用电512,000千瓦时",
      },
      {
        sentence: "供暖占总用电量的38%，这是我会最先着手的地方。",
        expected: "right",
        part: "供暖占总用电量的38%",
      },
      {
        sentence: "锅炉已使用19年，我认为已经不值得再修。",
        expected: "right",
        part: "锅炉已使用19年",
      },
      {
        sentence: "锅炉已使用9年，我认为已经不值得再修。",
        expected: "wrong",
        part: "锅炉已使用9年",
      },
      {
        sentence: "屋顶太阳能板2026年发电61,000千瓦时，比我预想的要好。",
        expected: "right",
        part: "屋顶太阳能板2026年发电61,000千瓦时",
      },
      { sentence: "为了简短，这份笔记没有列出2024年的数据。", expected: "none" },
      { sentence: "你邮件里提到的500,000千瓦时，不是这份笔记采用的数字。", expected: "none" },
      { sentence: "到2028年减少10%，在我看来是可行的。", expected: "none" },
    ],
  },
];
