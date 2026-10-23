import type { Label } from "./types";

interface Text {
  sentence: string;
  quote: string;
}

export interface Case {
  kind: string;
  label: Label;
  en: Text;
  zh: Text;
}

export const c = (
  kind: string,
  label: Label,
  en: [string, string],
  zh: [string, string],
): Case => ({
  kind,
  label,
  en: { sentence: en[0], quote: en[1] },
  zh: { sentence: zh[0], quote: zh[1] },
});

/**
 * Invented sentence and quote pairs, one case in both languages, covering what a Citation can
 * get wrong: a copy, a paraphrase, a changed figure, a negation, a scope word, may for must, a
 * swapped party, a sentence that adds a claim, and a quote from the next clause.
 * Each is [sentence, quote].
 */
export const HANDMADE: readonly Case[] = [
  c(
    "verbatim",
    "SUPPORTS",
    [
      "The tenant shall pay rent on the first day of each month.",
      "The tenant shall pay rent on the first day of each month.",
    ],
    ["承租人应于每月一日支付租金。", "承租人应于每月一日支付租金。"],
  ),
  c(
    "verbatim",
    "SUPPORTS",
    [
      "The warranty lasts for 24 months from the date of delivery.",
      "The warranty lasts for 24 months from the date of delivery.",
    ],
    ["质保期自交付之日起二十四个月。", "质保期自交付之日起二十四个月。"],
  ),
  c(
    "verbatim",
    "SUPPORTS",
    [
      "Applications close at 17:00 on Friday 6 March 2026.",
      "Applications close at 17:00 on Friday 6 March 2026.",
    ],
    ["申请于2026年3月6日（星期五）17:00截止。", "申请于2026年3月6日（星期五）17:00截止。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    [
      "Each employee gets twenty-five days of paid leave every calendar year.",
      "Employees receive 25 days of paid leave per calendar year.",
    ],
    ["每位员工每年有二十五天带薪假。", "员工每个日历年享有25天带薪假期。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    [
      "The budget was approved by the committee on 12 May.",
      "The committee approved the budget on 12 May.",
    ],
    ["预算在5月12日获委员会批准。", "委员会于5月12日批准了预算。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    [
      "Delivery has to happen within thirty days after the order is placed.",
      "The vendor must deliver within 30 days of the order.",
    ],
    ["供应商必须在下单后三十天内送货。", "供应商须在订单下达后30日内交货。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    [
      "A late payment is charged interest of 1.5 percent each month.",
      "Late payments incur interest at 1.5% per month.",
    ],
    ["逾期付款每月收取百分之一点五的利息。", "逾期付款按每月1.5%计收利息。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    [
      "The clinic does not open on Sundays or public holidays.",
      "The clinic is closed on Sundays and public holidays.",
    ],
    ["诊所在星期日和法定节假日不开门。", "诊所周日及法定节假日休息。"],
  ),
  c(
    "paraphrase",
    "SUPPORTS",
    [
      "A parent or guardian must give written consent for participants younger than 18.",
      "Participants under 18 need written consent from a parent or guardian.",
    ],
    [
      "18岁以下的参与者需要父母或监护人出具书面同意。",
      "未满18岁的参与者须取得父母或监护人的书面同意。",
    ],
  ),
  c(
    "pronoun",
    "SUPPORTS",
    [
      "Maria chaired the board from 2022.",
      "Maria joined the board in 2018. She chaired it from 2022.",
    ],
    ["玛丽亚自2022年起担任董事长。", "玛丽亚2018年加入董事会。她自2022年起担任董事长。"],
  ),
  c(
    "unit",
    "SUPPORTS",
    ["The cable is 300 centimetres long.", "The cable is 3 metres long."],
    ["电缆长300厘米。", "电缆长3米。"],
  ),
  c(
    "number",
    "NOT",
    ["The maximum grant is £500,000 per project.", "The maximum grant is £50,000 per project."],
    ["每个项目的资助上限为50万元。", "每个项目的资助上限为5万元。"],
  ),
  c(
    "number",
    "NOT",
    [
      "The security deposit equals three months' rent.",
      "The security deposit equals two months' rent.",
    ],
    ["押金相当于三个月的租金。", "押金相当于两个月的租金。"],
  ),
  c(
    "number",
    "NOT",
    [
      "Shifts last eight hours, with a one-hour break.",
      "Shifts last eight hours, with a thirty-minute break.",
    ],
    ["每班八小时，含一小时休息。", "每班八小时，含三十分钟休息。"],
  ),
  c(
    "number",
    "NOT",
    ["Inspections take place every 3 months.", "Inspections take place every 6 months."],
    ["检查每3个月进行一次。", "检查每6个月进行一次。"],
  ),
  c(
    "year",
    "NOT",
    ["The licence expires on 31 December 2028.", "The licence expires on 31 December 2027."],
    ["许可证于2028年12月31日到期。", "许可证于2027年12月31日到期。"],
  ),
  c(
    "year",
    "NOT",
    ["The new rules take effect on 1 January 2026.", "The new rules take effect on 1 July 2026."],
    ["新规自2026年1月1日起施行。", "新规自2026年7月1日起施行。"],
  ),
  c(
    "year",
    "NOT",
    ["The company was founded in 2019.", "The company was founded in 2009."],
    ["公司成立于2019年。", "公司成立于2009年。"],
  ),
  c(
    "negation",
    "NOT",
    ["Pets are allowed in the flats.", "Pets are not allowed in the flats."],
    ["公寓内可以饲养宠物。", "公寓内不得饲养宠物。"],
  ),
  c(
    "negation",
    "NOT",
    [
      "Unused leave can be carried over to the next year.",
      "Unused leave cannot be carried over to the next year.",
    ],
    ["未休完的假期可以结转至下一年度。", "未休完的假期不得结转至下一年度。"],
  ),
  c(
    "negation",
    "NOT",
    [
      "The supplier is liable for delays caused by weather.",
      "The supplier is not liable for delays caused by weather.",
    ],
    ["对因天气造成的延误，供应商承担责任。", "对因天气造成的延误，供应商不承担责任。"],
  ),
  c(
    "wider-scope",
    "PARTLY",
    [
      "All employees may apply for a transfer.",
      "Employees with at least one year of service may apply for a transfer.",
    ],
    ["所有员工都可以申请调岗。", "工作满一年的员工可以申请调岗。"],
  ),
  c(
    "only",
    "NOT",
    [
      "Visitors may use the car park only after 18:00.",
      "Visitors may use the car park after 18:00 and at weekends.",
    ],
    ["访客仅可在18:00后使用停车场。", "访客可在18:00后及周末使用停车场。"],
  ),
  c(
    "only",
    "NOT",
    [
      "Confidential information must be protected only during employment.",
      "Confidential information must be protected during and after employment.",
    ],
    ["仅在职期间须对保密信息保密。", "在职期间及离职后均须对保密信息保密。"],
  ),
  c(
    "all-some",
    "NOT",
    [
      "All participants reported mild side effects.",
      "Some participants reported mild side effects.",
    ],
    ["所有参与者都报告了轻微副作用。", "部分参与者报告了轻微副作用。"],
  ),
  c(
    "may-must",
    "NOT",
    [
      "The contractor must subcontract with the client's written approval.",
      "The contractor may subcontract with the client's written approval.",
    ],
    ["经客户书面同意，承包商必须分包。", "经客户书面同意，承包商可以分包。"],
  ),
  c(
    "may-must",
    "NOT",
    [
      "Employees may wear safety boots on the factory floor.",
      "Employees must wear safety boots on the factory floor.",
    ],
    ["员工在车间内可以穿安全靴。", "员工在车间内必须穿安全靴。"],
  ),
  c(
    "may-must",
    "NOT",
    [
      "The landlord must enter the flat with 24 hours' notice.",
      "The landlord may enter the flat with 24 hours' notice.",
    ],
    ["房东必须在提前24小时通知后进入公寓。", "房东可提前24小时通知后进入公寓。"],
  ),
  c(
    "swapped-party",
    "NOT",
    [
      "The Contractor pays the Company a fee of 4,000 per month.",
      "The Company pays the Contractor a fee of 4,000 per month.",
    ],
    ["乙方每月向甲方支付服务费4000元。", "甲方每月向乙方支付服务费4000元。"],
  ),
  c(
    "swapped-party",
    "NOT",
    ["Dr Ruiz referred the patient to Dr Patel.", "Dr Patel referred the patient to Dr Ruiz."],
    ["鲁伊斯医生将患者转诊给了帕特尔医生。", "帕特尔医生将患者转诊给了鲁伊斯医生。"],
  ),
  c(
    "swapped-party",
    "NOT",
    [
      "Brightside Ltd acquired Northwind Ltd in March 2025.",
      "Northwind Ltd acquired Brightside Ltd in March 2025.",
    ],
    ["2025年3月，晨光公司收购了北风公司。", "2025年3月，北风公司收购了晨光公司。"],
  ),
  c(
    "adds-claim",
    "PARTLY",
    [
      "The product is available in blue and green, and ships free worldwide.",
      "The product is available in blue and green.",
    ],
    ["该产品有蓝色和绿色两种，并在全球免运费。", "该产品有蓝色和绿色两种。"],
  ),
  c(
    "adds-claim",
    "PARTLY",
    [
      "The study enrolled 240 adults and found the drug halved their symptoms.",
      "The study enrolled 240 adults.",
    ],
    ["该研究招募了240名成年人，发现药物使症状减半。", "该研究招募了240名成年人。"],
  ),
  c(
    "adds-claim",
    "PARTLY",
    [
      "Rent is due on the first of each month, and a late fee applies after five days.",
      "Rent is due on the first of each month.",
    ],
    ["租金于每月一日到期，逾期五天后收取滞纳金。", "租金于每月一日到期。"],
  ),
  c(
    "adds-claim",
    "PARTLY",
    ["The museum opens at 10:00 and has free entry on Sundays.", "The museum opens at 10:00."],
    ["博物馆10:00开馆，周日免费入场。", "博物馆10:00开馆。"],
  ),
  c(
    "adds-claim",
    "PARTLY",
    [
      "The team shipped version 2.0 in June after a three-month delay.",
      "The team shipped version 2.0 in June.",
    ],
    ["团队在推迟三个月后于6月发布了2.0版本。", "团队在6月发布了2.0版本。"],
  ),
  c(
    "adds-claim",
    "PARTLY",
    [
      "The warranty covers manufacturing defects and accidental damage.",
      "The warranty covers manufacturing defects.",
    ],
    ["保修范围涵盖制造缺陷和意外损坏。", "保修范围涵盖制造缺陷。"],
  ),
  c(
    "neighbouring-clause",
    "NOT",
    ["The notice period is three months.", "Notice of termination must be given in writing."],
    ["通知期为三个月。", "解除合同的通知须以书面形式作出。"],
  ),
  c(
    "neighbouring-clause",
    "NOT",
    ["The salary is 48,000 per year.", "The salary is paid monthly in arrears."],
    ["年薪为4.8万元。", "工资按月后付。"],
  ),
  c(
    "neighbouring-clause",
    "NOT",
    ["Parking costs £5 per day.", "Parking is available behind the main building."],
    ["停车费每天5元。", "主楼后方设有停车位。"],
  ),
  c(
    "two-facts",
    "PARTLY",
    [
      "The lab opens at 8:00 on weekdays and at 10:00 on Saturdays.",
      "The lab opens at 8:00 on weekdays.",
    ],
    ["实验室工作日8:00开放，周六10:00开放。", "实验室工作日8:00开放。"],
  ),
  c(
    "two-facts",
    "PARTLY",
    [
      "Ana Silva is the project's lead engineer and joined in 2021.",
      "Ana Silva is the project's lead engineer.",
    ],
    ["安娜·席尔瓦是该项目的首席工程师，2021年加入。", "安娜·席尔瓦是该项目的首席工程师。"],
  ),
  c(
    "general-word",
    "PARTLY",
    [
      "Customers are entitled to one guest pass per month.",
      "Each Member is entitled to one guest pass per month.",
    ],
    ["顾客每月可领取一张访客券。", "每位会员每月可领取一张访客券。"],
  ),
  c(
    "general-word",
    "PARTLY",
    ["Residents must give two months' notice.", "The Tenant must give two months' notice."],
    ["住户须提前两个月通知。", "承租人须提前两个月通知。"],
  ),
];
