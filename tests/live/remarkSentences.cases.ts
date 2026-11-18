/**
 * Notes as an assistant or an outside agent writes them: facts from a Document, and beside them
 * the writer's own remarks about the Note (#3320): where its content came from, what the writer
 * was asked or given, what it could or couldn't open, and a reminder to verify. No Document could
 * state a remark, so a check leaves it without a mark. Each Note also holds facts a check has to
 * read, some with a remark in the same sentence, and wrong twins; several facts look like a
 * remark (who made a survey, what its interviewers couldn't reach, what a patient must do) and are
 * stated by the Document. On invented Documents of a few lines.
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
    /** None: the writer's own remark, which a check leaves without a mark. */
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
];
