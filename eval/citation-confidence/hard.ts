import { type Case, c } from "./handmade";

/**
 * A second set of invented cases, written after the first results and used for nothing but
 * reporting: near-misses a quote-only judge is likely to let through (direction, quantifier,
 * modal, condition, time scope, a name or figure one character off) and paraphrases that restate
 * the quote in other terms. Each is [sentence, quote].
 */
export const HARD: readonly Case[] = [
  c(
    "direction",
    "NOT",
    [
      "Sales decreased by 12 percent in the second quarter.",
      "Sales increased by 12 percent in the second quarter.",
    ],
    ["销售额第二季度下降12%。", "销售额第二季度增长12%。"],
  ),
  c(
    "direction",
    "NOT",
    [
      "The audit must be completed after the contract is signed.",
      "The audit must be completed before the contract is signed.",
    ],
    ["审计须在合同签署后完成。", "审计须在合同签署前完成。"],
  ),
  c(
    "direction",
    "NOT",
    ["Wages rose faster than prices.", "Prices rose faster than wages."],
    ["工资上涨快于物价上涨。", "物价上涨快于工资上涨。"],
  ),
  c(
    "quantifier",
    "NOT",
    ["Applicants must be at most 18 years old.", "Applicants must be at least 18 years old."],
    ["申请人年龄不得超过18周岁。", "申请人须年满18周岁。"],
  ),
  c(
    "quantifier",
    "NOT",
    ["The fund pays at least £5,000 per claim.", "The fund pays up to £5,000 per claim."],
    ["基金每笔索赔至少赔付5000元。", "基金每笔索赔最高赔付5000元。"],
  ),
  c(
    "quantifier",
    "NOT",
    ["Fewer than half of the respondents agreed.", "More than half of the respondents agreed."],
    ["不到半数的受访者表示同意。", "超过半数的受访者表示同意。"],
  ),
  c(
    "modal",
    "NOT",
    ["Visitors must register at reception.", "Visitors are encouraged to register at reception."],
    ["访客必须在前台登记。", "建议访客在前台登记。"],
  ),
  c(
    "modal",
    "NOT",
    ["Smoking is permitted in all buildings.", "Smoking is prohibited in all buildings."],
    ["所有建筑内允许吸烟。", "所有建筑内禁止吸烟。"],
  ),
  c(
    "modal",
    "NOT",
    ["Staff may share their passwords.", "Staff must not share their passwords."],
    ["员工可以共享密码。", "员工不得共享密码。"],
  ),
  c(
    "condition",
    "NOT",
    [
      "The discount applies even if payment is made after 14 days.",
      "The discount applies only if payment is made within 14 days.",
    ],
    ["即使在14日后付款也适用折扣。", "仅在14日内付款时适用折扣。"],
  ),
  c(
    "condition",
    "NOT",
    [
      "The warranty remains valid if the seal is broken.",
      "The warranty is void if the seal is broken.",
    ],
    ["封条破损的，保修仍然有效。", "封条破损的，保修无效。"],
  ),
  c(
    "condition",
    "PARTLY",
    [
      "Refunds are available within 30 days if the item is unused.",
      "Refunds are available within 30 days.",
    ],
    ["商品未使用的，30日内可申请退款。", "30日内可申请退款。"],
  ),
  c(
    "time-scope",
    "NOT",
    ["The fee is charged weekly.", "The fee is charged monthly."],
    ["费用按周收取。", "费用按月收取。"],
  ),
  c(
    "time-scope",
    "NOT",
    ["Maintenance is carried out twice a year.", "Maintenance is carried out once a year."],
    ["每年维护两次。", "每年维护一次。"],
  ),
  c(
    "time-scope",
    "NOT",
    ["The grant covers the 2025 academic year.", "The grant covers the 2026 academic year."],
    ["资助涵盖2025学年。", "资助涵盖2026学年。"],
  ),
  c(
    "name",
    "NOT",
    [
      "The report was written by Dr Sarah Whitford.",
      "The report was written by Dr Sarah Whitfield.",
    ],
    ["报告由王立信博士撰写。", "报告由王立新博士撰写。"],
  ),
  c(
    "name",
    "NOT",
    ["The depot is in Leicester.", "The depot is in Leeds."],
    ["仓库位于常州。", "仓库位于苏州。"],
  ),
  c(
    "name",
    "NOT",
    ["Invoice no. 20481 was paid on 3 March.", "Invoice no. 20418 was paid on 3 March."],
    ["第20481号发票于3月3日付款。", "第20418号发票于3月3日付款。"],
  ),
  c(
    "figure",
    "NOT",
    ["The site covers 12,500 square metres.", "The site covers 1,250 square metres."],
    ["场地面积为12500平方米。", "场地面积为1250平方米。"],
  ),
  c(
    "figure",
    "NOT",
    ["Unemployment fell to 4.8 percent.", "Unemployment fell to 4.2 percent."],
    ["失业率降至4.8%。", "失业率降至4.2%。"],
  ),
  c(
    "figure",
    "NOT",
    ["The tower is 134 metres tall.", "The tower is 143 metres tall."],
    ["塔高134米。", "塔高143米。"],
  ),
  c(
    "wider-scope",
    "PARTLY",
    ["Employees receive a laptop.", "Full-time employees receive a laptop."],
    ["员工配发笔记本电脑。", "全职员工配发笔记本电脑。"],
  ),
  c(
    "wider-scope",
    "NOT",
    ["The prototypes passed the test.", "One of the three prototypes passed the test."],
    ["原型机通过了测试。", "三个原型机中有一个通过了测试。"],
  ),
  c(
    "wider-scope",
    "NOT",
    ["The pilot ran in schools across the region.", "The pilot ran in two schools."],
    ["试点在全区各学校开展。", "试点在两所学校开展。"],
  ),
  c(
    "less-specific",
    "SUPPORTS",
    ["The vaccine was tested on adults.", "The vaccine was tested on adults aged 18 to 65."],
    ["疫苗在成年人中进行了测试。", "疫苗在18至65岁的成年人中进行了测试。"],
  ),
  c(
    "less-specific",
    "SUPPORTS",
    [
      "The head of cardiology presented the results.",
      "Dr Ng, the head of cardiology, presented the results.",
    ],
    ["心内科主任介绍了结果。", "心内科主任吴医生介绍了结果。"],
  ),
  c(
    "less-specific",
    "SUPPORTS",
    [
      "The new library opened on 3 March.",
      "The new library opened on 3 March and received 4,000 visitors in its first week.",
    ],
    ["新图书馆3月3日开馆。", "新图书馆3月3日开馆，第一周接待访客4000人次。"],
  ),
  c(
    "adds-claim",
    "PARTLY",
    [
      "The new library opened on 3 March and received 4,000 visitors in its first week.",
      "The new library opened on 3 March.",
    ],
    ["新图书馆3月3日开馆，第一周接待访客4000人次。", "新图书馆3月3日开馆。"],
  ),
  c(
    "adds-claim",
    "PARTLY",
    ["Alice, Bob and Carol co-authored the paper.", "Alice and Bob co-authored the paper."],
    ["爱丽丝、鲍勃和卡罗尔合写了这篇论文。", "爱丽丝和鲍勃合写了这篇论文。"],
  ),
  c(
    "adds-claim",
    "PARTLY",
    [
      "The contract is worth £2 million and was awarded to Northwind Ltd.",
      "The contract is worth £2 million.",
    ],
    ["合同金额为200万元，授予北风公司。", "合同金额为200万元。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    ["Revenue was 1,200,000 pounds.", "Revenue was £1.2m."],
    ["营收为1,200,000元。", "营收为120万元。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    ["The product launched in the third quarter of 2025.", "The product launched in Q3 2025."],
    ["产品在2025年第三季度推出。", "产品于2025年第三季度上市。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    ["Over 95 percent of tests passed.", "Fewer than 5 percent of tests failed."],
    ["超过95%的测试通过。", "不到5%的测试未通过。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    [
      "There is no penalty for cancelling at any time.",
      "Customers can cancel at any time without penalty.",
    ],
    ["随时取消不收取违约金。", "客户可随时取消，无需支付违约金。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    [
      "Committee meetings take place monthly, on the second Tuesday.",
      "The committee meets on the second Tuesday of every month.",
    ],
    ["委员会每月召开一次会议，时间为第二个星期二。", "委员会每月第二个星期二开会。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    [
      "Tenants pay for damage they cause.",
      "Each tenant is responsible for the cost of repairing damage they cause.",
    ],
    ["租户自行承担其造成损坏的维修费。", "租户须承担自己造成的损坏的修理费用。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    ["Delivery is free on orders above £100.", "Orders over £100 qualify for free delivery."],
    ["订单金额高于100元可免运费。", "订单金额超过100元的，免费配送。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    [
      "A survey of 1,200 households took place in March 2026.",
      "The survey was carried out in March 2026 among 1,200 households.",
    ],
    ["2026年3月对1200户家庭开展了一项调查。", "该调查于2026年3月对1200户家庭进行。"],
  ),
  c(
    "other-subject",
    "NOT",
    ["The meeting room has a projector.", "The meeting room seats twelve people."],
    ["会议室配有投影仪。", "会议室可容纳十二人。"],
  ),
  c(
    "other-subject",
    "NOT",
    ["Dinner is served from 18:00 to 21:00.", "Breakfast is served from 7:00 to 10:00."],
    ["晚餐供应时间为18:00至21:00。", "早餐供应时间为7:00至10:00。"],
  ),
  c(
    "other-subject",
    "NOT",
    ["The gym is open to members only.", "The pool is open to members only."],
    ["健身房仅对会员开放。", "游泳池仅对会员开放。"],
  ),
  c(
    "negation",
    "NOT",
    ["Refunds are given after 30 days.", "No refunds are given after 30 days."],
    ["30日后可以退款。", "30日后不予退款。"],
  ),
  c(
    "negation",
    "NOT",
    ["All participants completed the survey.", "Not all participants completed the survey."],
    ["所有参与者都完成了调查。", "并非所有参与者都完成了调查。"],
  ),
  c(
    "negation",
    "NOT",
    ["The device is waterproof.", "The device is neither waterproof nor dustproof."],
    ["该设备防水。", "该设备既不防水也不防尘。"],
  ),
];
