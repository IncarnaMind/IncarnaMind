/**
 * Sentences that state what a contract, a policy or a rule requires, allows or forbids, in Chinese
 * («应», «须», «应当», «不得», «可», «必须»), each beside a wrong twin: another party, another
 * deadline or the opposite permission (#3262). A check has to read them: «应» is "shall" here, not
 * the writer's advice. With them, sentences that are only the writer's own advice, which a check
 * leaves alone. On invented Documents of a line or two.
 *
 * The set is fixed: a pair is not edited once a baseline rests on it, and a new shape is a new pair.
 */
export interface DutyPair {
  id: string;
  document: string;
  right: string;
  wrong: string;
}

export const DUTY_PAIRS: readonly DutyPair[] = [
  {
    id: "zh-y01",
    document: "第八条：乙方应于每月5日前支付当月租金。甲方应在收款后三日内开具发票。",
    right: "乙方应于每月5日前支付当月租金。",
    wrong: "甲方应于每月5日前支付当月租金。",
  },
  {
    id: "zh-y02",
    document: "第三条：供应商须在收到订单后十个工作日内交货。",
    right: "供应商须在收到订单后十个工作日内交货。",
    wrong: "供应商须在收到订单后五个工作日内交货。",
  },
  {
    id: "zh-y03",
    document: "第十五条：员工离职应当提前三十日以书面形式通知公司。",
    right: "员工离职应当提前三十日书面通知公司。",
    wrong: "员工离职应当提前十五日书面通知公司。",
  },
  {
    id: "zh-y04",
    document: "第六条：未经甲方书面同意，乙方不得将房屋转租。",
    right: "未经甲方书面同意，乙方不得将房屋转租。",
    wrong: "乙方可将房屋转租，无需甲方同意。",
  },
  {
    id: "zh-y05",
    document: "第十一条：承包人应对工程质量承担两年保修责任。",
    right: "承包人应对工程质量承担两年保修责任。",
    wrong: "发包人应对工程质量承担两年保修责任。",
  },
  {
    id: "zh-y06",
    document: "报销制度第四条：员工应在出差结束后七日内提交报销单。",
    right: "员工应在出差结束后七日内提交报销单。",
    wrong: "员工应在出差结束后三十日内提交报销单。",
  },
  {
    id: "zh-y07",
    document: "用药须知：患者应在餐后服用本药，每日两次。",
    right: "患者应在餐后服用本药，每日两次。",
    wrong: "患者应在空腹时服用本药，每日两次。",
  },
  {
    id: "zh-y08",
    document: "第九条：借款人应于2027年6月30日前偿还全部本金。",
    right: "借款人应于2027年6月30日前偿还全部本金。",
    wrong: "借款人应于2028年6月30日前偿还全部本金。",
  },
  {
    id: "zh-y09",
    document: "保密协议第二条：接收方不得向任何第三方披露保密信息。",
    right: "接收方不得向任何第三方披露保密信息。",
    wrong: "披露方不得向任何第三方披露保密信息。",
  },
  {
    id: "zh-y10",
    document: "第五条：董事会会议应有过半数董事出席方可举行。",
    right: "董事会会议应有过半数董事出席方可举行。",
    wrong: "董事会会议应有三分之二以上董事出席方可举行。",
  },
  {
    id: "zh-y11",
    document: "第七条：买方可在收货后七日内无理由退货。",
    right: "买方可在收货后七日内无理由退货。",
    wrong: "买方可在收货后三十日内无理由退货。",
  },
  {
    id: "zh-y12",
    document: "安全规程：进入车间的人员必须佩戴安全帽。",
    right: "进入车间的人员必须佩戴安全帽。",
    wrong: "进入车间的人员必须佩戴护目镜。",
  },
];

/** The writer's own advice, beside a Document about the same thing: no check marks it. */
export const ADVICE: readonly {
  id: string;
  language: "en" | "zh-CN";
  document: string;
  sentence: string;
}[] = [
  {
    id: "zh-v01",
    language: "zh-CN",
    document: "第二条：租期自2025年1月1日起至2026年12月31日止。",
    sentence: "我们应尽快续约。",
  },
  {
    id: "zh-v02",
    language: "zh-CN",
    document: "2026年市场部预算为320万元，较上年增加8%。",
    sentence: "我认为公司明年应该提高市场部预算。",
  },
  {
    id: "en-v01",
    language: "en",
    document: "Clause 2: The lease runs from 1 January 2025 to 31 December 2026.",
    sentence: "We should renew soon.",
  },
  {
    id: "en-v02",
    language: "en",
    document: "The analytics team has one analyst and handled 410 requests in 2026.",
    sentence: "In my view the team ought to hire a second analyst.",
  },
];
