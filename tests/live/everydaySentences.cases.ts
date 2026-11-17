/**
 * Thirty everyday sentences a User writes from a Document, each beside a wrong twin: rules with a
 * condition or a deadline, figures with a unit, a scale or a period, comparisons, who does what,
 * and sentences that say less than their Passage. Fifteen in English and fifteen in Chinese, on
 * invented Documents of a line or two.
 *
 * A pull request that changes a check's verdict gives two numbers from this set, before and after,
 * on Claude Haiku 5.5: how many of the 30 right sentences get their ✓, and how many of the 30
 * wrong twins do (`npm run check:everyday`). Each wrong twin differs from its Document in the one
 * thing its `wrong` says: another party, unit, scale, month or figure, the other direction, a part
 * the Document doesn't state, or its condition dropped.
 *
 * The set is fixed: a pair is not edited once a baseline rests on it, and a new shape is a new pair.
 */
export interface EverydayPair {
  id: string;
  shape: "condition" | "figure" | "comparison" | "party" | "says-less";
  language: "en" | "zh-CN";
  document: string;
  right: string;
  wrong: string;
}

export const EVERYDAY_PAIRS: readonly EverydayPair[] = [
  {
    id: "en-e01",
    shape: "says-less",
    language: "en",
    document:
      "Report 14, March 2025: the Harbour depot handled 4,200 containers in the month, up from 3,900.",
    right: "The Harbour depot handled 4,200 containers in the month.",
    wrong: "The Harbour depot and the Quay depot each handled 4,200 containers in the month.",
  },
  {
    id: "en-e02",
    shape: "condition",
    language: "en",
    document:
      "Under clause 9 of the 2024 handbook, staff may work remotely two days a week, provided the team lead agrees in advance.",
    right: "Staff may work remotely two days a week, provided the team lead agrees in advance.",
    wrong: "Staff may work remotely two days a week.",
  },
  {
    id: "en-e03",
    shape: "says-less",
    language: "en",
    document:
      "The survey of 1,180 tenants, carried out by post in May, found that 62% were satisfied with repairs.",
    right: "62% of the tenants surveyed were satisfied with repairs.",
    wrong: "62% of the tenants surveyed were satisfied with repairs and with rents.",
  },
  {
    id: "en-e04",
    shape: "party",
    language: "en",
    document:
      "Clause 12: The Tenant must repaint the premises before the lease ends. The Landlord may inspect the premises on 48 hours' notice.",
    right: "The Tenant must repaint the premises before the lease ends.",
    wrong: "The Landlord must repaint the premises before the lease ends.",
  },
  {
    id: "en-e05",
    shape: "condition",
    language: "en",
    document:
      "Expenses over £500 need the finance director's approval before they are paid. Expenses of £500 or less are paid within ten working days.",
    right: "Expenses over £500 need the finance director's approval before they are paid.",
    wrong: "Expenses over £500 are paid within ten working days.",
  },
  {
    id: "en-e06",
    shape: "condition",
    language: "en",
    document:
      "Members may cancel within 14 days of joining and receive a full refund. After that, fees already paid are not returned.",
    right: "Members who cancel within 14 days of joining receive a full refund.",
    wrong: "Members who cancel within 30 days of joining receive a full refund.",
  },
  {
    id: "en-e07",
    shape: "figure",
    language: "en",
    document:
      "In the 2025 financial year the Ridgeway plant produced 54,000 tonnes of cement, against 49,500 tonnes in 2024.",
    right: "The Ridgeway plant produced 54,000 tonnes of cement in the 2025 financial year.",
    wrong: "The Ridgeway plant produced 54,000 kilograms of cement in the 2025 financial year.",
  },
  {
    id: "en-e08",
    shape: "figure",
    language: "en",
    document:
      "Revenue for the first half was £12.4 million, of which £3.1 million came from services.",
    right: "Services brought in £3.1 million of first-half revenue.",
    wrong: "Services brought in £3.1 billion of first-half revenue.",
  },
  {
    id: "en-e09",
    shape: "figure",
    language: "en",
    document: "The clinic saw 1,340 patients in January and 1,515 in February.",
    right: "The clinic saw 1,515 patients in February.",
    wrong: "The clinic saw 1,515 patients in January.",
  },
  {
    id: "en-e10",
    shape: "figure",
    language: "en",
    document: "Staff turnover was 8.5% in 2025, down from 11.2% the year before.",
    right: "Staff turnover was 8.5% in 2025.",
    wrong: "Staff turnover was 11.2% in 2025.",
  },
  {
    id: "en-e11",
    shape: "comparison",
    language: "en",
    document: "Average delivery time fell from 3.4 days to 2.6 days after the new depot opened.",
    right: "Average delivery time fell after the new depot opened.",
    wrong: "Average delivery time rose after the new depot opened.",
  },
  {
    id: "en-e12",
    shape: "comparison",
    language: "en",
    document:
      "The Northgate store sold 2,300 units in the quarter; the Riverside store sold 1,900.",
    right: "The Northgate store sold more units than the Riverside store in the quarter.",
    wrong: "The Riverside store sold more units than the Northgate store in the quarter.",
  },
  {
    id: "en-e13",
    shape: "comparison",
    language: "en",
    document: "Subscriptions grew 12% year on year to 48,000.",
    right: "Subscriptions grew 12% year on year.",
    wrong: "Subscriptions grew 21% year on year.",
  },
  {
    id: "en-e14",
    shape: "party",
    language: "en",
    document:
      "Under the supply agreement, the Supplier delivers the goods to the Buyer's warehouse and the Buyer pays within 30 days of the invoice.",
    right: "The Buyer pays within 30 days of the invoice.",
    wrong: "The Supplier pays within 30 days of the invoice.",
  },
  {
    id: "en-e15",
    shape: "party",
    language: "en",
    document:
      "The board approved the budget on 4 March; the audit committee will review it in June.",
    right: "The board approved the budget on 4 March.",
    wrong: "The audit committee approved the budget on 4 March.",
  },
  {
    id: "zh-e01",
    shape: "says-less",
    language: "zh-CN",
    document: "2025年第三季度，南湖仓库（编号07）出库量为1.8万件，同比增长6%。",
    right: "南湖仓库出库量为1.8万件。",
    wrong: "南湖仓库和北岸仓库出库量均为1.8万件。",
  },
  {
    id: "zh-e02",
    shape: "condition",
    language: "zh-CN",
    document: "根据2024年版员工手册第9条，员工可每周远程办公两天，须事先与主管商定。",
    right: "员工可每周远程办公两天，须事先与主管商定。",
    wrong: "员工可每周远程办公两天。",
  },
  {
    id: "zh-e03",
    shape: "says-less",
    language: "zh-CN",
    document: "本次问卷于5月以邮寄方式发放，共回收1,180份，其中62%的租户对维修服务表示满意。",
    right: "62%的受访租户对维修服务表示满意。",
    wrong: "62%的受访租户对维修服务和租金水平均表示满意。",
  },
  {
    id: "zh-e04",
    shape: "party",
    language: "zh-CN",
    document: "第十二条：承租人应在租期届满前重新粉刷房屋。出租人可提前48小时通知后进入房屋检查。",
    right: "承租人应在租期届满前重新粉刷房屋。",
    wrong: "出租人应在租期届满前重新粉刷房屋。",
  },
  {
    id: "zh-e05",
    shape: "condition",
    language: "zh-CN",
    document:
      "单笔超过5,000元的报销须经财务总监批准后方可支付。5,000元及以下的报销在十个工作日内支付。",
    right: "单笔超过5,000元的报销须经财务总监批准后方可支付。",
    wrong: "单笔超过5,000元的报销在十个工作日内支付。",
  },
  {
    id: "zh-e06",
    shape: "condition",
    language: "zh-CN",
    document: "会员自入会之日起14日内可取消并获全额退款。逾期已缴费用不予退还。",
    right: "会员在入会14日内取消可获全额退款。",
    wrong: "会员在入会30日内取消可获全额退款。",
  },
  {
    id: "zh-e07",
    shape: "figure",
    language: "zh-CN",
    document: "2025财年，岭西工厂水泥产量为5.4万吨，2024财年为4.95万吨。",
    right: "岭西工厂2025财年水泥产量为5.4万吨。",
    wrong: "岭西工厂2025财年水泥产量为5.4万千克。",
  },
  {
    id: "zh-e08",
    shape: "figure",
    language: "zh-CN",
    document: "上半年营业收入为1,240万元，其中服务收入310万元。",
    right: "上半年服务收入为310万元。",
    wrong: "上半年服务收入为310亿元。",
  },
  {
    id: "zh-e09",
    shape: "figure",
    language: "zh-CN",
    document: "门诊部1月接诊1,340人次，2月接诊1,515人次。",
    right: "门诊部2月接诊1,515人次。",
    wrong: "门诊部1月接诊1,515人次。",
  },
  {
    id: "zh-e10",
    shape: "figure",
    language: "zh-CN",
    document: "2025年员工流失率为8.5%，上年为11.2%。",
    right: "2025年员工流失率为8.5%。",
    wrong: "2025年员工流失率为11.2%。",
  },
  {
    id: "zh-e11",
    shape: "comparison",
    language: "zh-CN",
    document: "新仓启用后，平均配送时间由3.4天降至2.6天。",
    right: "新仓启用后平均配送时间缩短。",
    wrong: "新仓启用后平均配送时间延长。",
  },
  {
    id: "zh-e12",
    shape: "comparison",
    language: "zh-CN",
    document: "本季度北门店销量为2,300件，河滨店为1,900件。",
    right: "本季度北门店销量高于河滨店。",
    wrong: "本季度河滨店销量高于北门店。",
  },
  {
    id: "zh-e13",
    shape: "comparison",
    language: "zh-CN",
    document: "订阅用户同比增长12%，达到4.8万户。",
    right: "订阅用户同比增长12%。",
    wrong: "订阅用户同比增长21%。",
  },
  {
    id: "zh-e14",
    shape: "party",
    language: "zh-CN",
    document: "根据供货协议，供方负责将货物送至需方仓库，需方应在收到发票后30日内付款。",
    right: "需方应在收到发票后30日内付款。",
    wrong: "供方应在收到发票后30日内付款。",
  },
  {
    id: "zh-e15",
    shape: "party",
    language: "zh-CN",
    document: "董事会于3月4日批准了预算，审计委员会将在6月进行复核。",
    right: "董事会于3月4日批准了预算。",
    wrong: "审计委员会于3月4日批准了预算。",
  },
];
