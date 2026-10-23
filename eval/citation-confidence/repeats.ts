import type { Label, Language } from "./types";

const EN = {
  salary:
    "The salary is 61,500 per year, paid monthly in arrears on the last working day of the month.",
  start: "The Employee is employed as People Operations Partner and starts on 11 January 2027.",
  reports: "The Employee reports to the Director of People.",
  wfh: "The Employee may work from home two days a week, agreed in advance with the manager.",
  attend:
    "The Company may ask the Employee to attend the office on a working-from-home day with 24 hours' notice.",
  holiday:
    "The Employee is entitled to 27 working days of paid holiday per year, in addition to public holidays.",
  carry:
    "Up to 5 unused days may be carried over into the next year and must be taken by 31 March.",
  notice:
    "After probation, either side must give three months' written notice to end this agreement.",
  inLieu:
    "The Company may pay salary in lieu of notice instead of requiring the Employee to work the notice period.",
  pension:
    "The Company will enrol the Employee in its workplace pension scheme and contribute 6 percent of salary. The Employee contributes 4 percent of salary through payroll.",
  confidential:
    "The Employee must keep the Company's confidential information secret during and after employment.",
  law: "This agreement is governed by the laws of England and Wales.",
  flat: "The Company lets the flat at 14 Mill Lane to the Employee: the Company is the landlord and the Employee the tenant. The Employee pays the Company a rent of 950 per month.",
  laptop:
    "At the end of employment the Company may sell the Employee's work laptop to the Employee for 450.",
  parties:
    "This Employment Agreement is made between Larkfield Provisions Ltd (the Company) and Tunde Okoro (the Employee).",
};

const ZH = {
  salary: "乙方月工资为人民币一万八千元，于每月最后一个工作日发放。",
  start: "乙方担任人力资源业务伙伴，自2027年1月11日起入职，向人力资源总监汇报。",
  wfh: "乙方每周可在家工作两天，须事先与主管商定。",
  attend: "甲方可提前24小时通知乙方在居家工作日到岗。",
  holiday: "乙方每年享有带薪年休假10天，法定节假日另计。",
  probation: "试用期为三个月。试用期内任何一方提前三日书面通知对方，可以解除本合同。",
  notice: "试用期满后，任何一方须提前三个月书面通知对方，方可解除本合同。",
  social: "甲方依法为乙方缴纳社会保险和住房公积金。",
  confidential: "乙方在职期间及离职后均须对甲方的商业秘密保密。",
  law: "本合同适用中华人民共和国法律。",
  flat: "甲方将明川路14号2室出租给乙方，甲方为出租方，乙方为承租方。乙方每月向甲方支付租金人民币一千五百元。",
  laptop: "劳动合同终止时，甲方可按人民币三千元将乙方使用的笔记本电脑出售给乙方。",
  parties: "甲方（用人单位）：明川食品有限公司 乙方（劳动者）：林晓",
};

export interface RepeatPair {
  set: string;
  key: string;
  language: Language;
  kind: string;
  label: Label;
  sentence: string;
  quote: string;
  caveat?: "needs-context";
}

type Row = [set: string, key: string, kind: string, label: Label, sentence: string, quote: string];

const row = (language: Language, r: Row, caveat?: "needs-context"): RepeatPair => ({
  set: r[0],
  key: r[1],
  language,
  kind: r[2],
  label: r[3],
  sentence: r[4],
  quote: r[5],
  ...(caveat && { caveat }),
});

const conflict = (set: string, key: string, sentence: string, quote: string): Row => [
  set,
  key,
  "conflict",
  "NOT",
  sentence,
  quote,
];

/**
 * The sentences of the repeated-checks evaluation (#1608) with the clause
 * of the agreement each should be judged against, the one the check cites. The agreement is
 * invented, so the pairs are too.
 */
export const REPEATS: readonly RepeatPair[] = [
  ...(
    [
      [
        "en",
        "notice",
        "paraphrase",
        "SUPPORTS",
        "Notice is three months after the probation period.",
        EN.notice,
      ],
      [
        "en",
        "holiday",
        "wrong-figure",
        "NOT",
        "Holiday is 30 days a year plus public holidays.",
        EN.holiday,
      ],
      [
        "en",
        "staff-home",
        "general-word",
        "PARTLY",
        "Staff may work from home two days a week.",
        EN.wfh,
      ],
      [
        "en",
        "own-words",
        "word-for-word",
        "SUPPORTS",
        "The Employee may work from home two days a week.",
        EN.wfh,
      ],
      [
        "en",
        "car",
        "absent",
        "NOT",
        "The Employee gets a car allowance of 300 pounds a month.",
        EN.salary,
      ],
      [
        "en",
        "home-days",
        "near-miss",
        "PARTLY",
        "The Employee may work from home on Mondays and Fridays.",
        EN.wfh,
      ],
      [
        "en-control",
        "same-subject",
        "paraphrase",
        "SUPPORTS",
        "The Employee can work from home for two days each week.",
        EN.wfh,
      ],
      [
        "en-control",
        "staff-home",
        "general-word",
        "PARTLY",
        "Staff may work from home two days a week.",
        EN.wfh,
      ],
      [
        "en-control",
        "employees-home",
        "general-word",
        "PARTLY",
        "Employees may work from home two days a week.",
        EN.wfh,
      ],
    ] satisfies Row[]
  ).map((r) => row("en", r)),
  row(
    "en",
    [
      "en-control",
      "named",
      "paraphrase",
      "SUPPORTS",
      "Tunde Okoro may work from home two days a week.",
      EN.wfh,
    ],
    "needs-context",
  ),
  ...(
    [
      [
        "zh",
        "notice",
        "paraphrase",
        "SUPPORTS",
        "试用期满后，解除合同需提前三个月通知。",
        ZH.notice,
      ],
      ["zh", "holiday", "wrong-figure", "NOT", "员工每年有15天带薪年休假。", ZH.holiday],
      ["zh", "staff-home", "general-word", "PARTLY", "员工每周可以居家办公两天。", ZH.wfh],
      ["zh", "own-words", "word-for-word", "SUPPORTS", "乙方每周可在家工作两天。", ZH.wfh],
      ["zh", "car", "absent", "NOT", "公司每月发放300元交通补贴。", ZH.salary],
      ["zh", "home-days", "near-miss", "PARTLY", "员工可以在每周一和周五居家办公。", ZH.wfh],
      [
        "zh-control",
        "same-subject",
        "paraphrase",
        "SUPPORTS",
        "乙方每周有两天可以在家办公。",
        ZH.wfh,
      ],
      ["zh-control", "staff-home", "general-word", "PARTLY", "员工每周可以居家办公两天。", ZH.wfh],
      [
        "zh-control",
        "employees-home",
        "general-word",
        "PARTLY",
        "职工每周可在家工作两天。",
        ZH.wfh,
      ],
    ] satisfies Row[]
  ).map((r) => row("zh", r)),
  row(
    "zh",
    ["zh-control", "named", "paraphrase", "SUPPORTS", "林晓每周可在家工作两天。", ZH.wfh],
    "needs-context",
  ),
  ...(
    [
      conflict(
        "en-conflicts",
        "number",
        "The salary is 65,000 per year, paid monthly in arrears.",
        EN.salary,
      ),
      conflict(
        "en-conflicts",
        "date",
        "Unused holiday days carried over must be taken by 30 April.",
        EN.carry,
      ),
      conflict("en-conflicts", "year", "The Employee starts on 11 January 2028.", EN.start),
      conflict(
        "en-conflicts",
        "negation",
        "Unused holiday days can't be carried over into the next year.",
        EN.carry,
      ),
      conflict("en-conflicts", "unit", "The salary is 61,500 per month.", EN.salary),
      conflict(
        "en-conflicts",
        "reporting-line",
        "The Director of People reports to the Employee.",
        EN.reports,
      ),
      conflict(
        "en-conflicts",
        "payer",
        "The Company pays the Employee a rent of 950 per month for the flat.",
        EN.flat,
      ),
      conflict(
        "en-conflicts",
        "employer",
        "Tunde Okoro is the employer and Larkfield Provisions Ltd the employee under this agreement.",
        EN.parties,
      ),
      conflict(
        "en-conflicts",
        "seller",
        "At the end of employment the Employee may sell the work laptop to the Company for 450.",
        EN.laptop,
      ),
      conflict(
        "en-conflicts",
        "landlord",
        "The Employee is the landlord of the flat at 14 Mill Lane and the Company the tenant.",
        EN.flat,
      ),
      conflict(
        "en-conflicts",
        "name",
        "This Employment Agreement is made between Larkfield Provisions Ltd and Tunde Adeyemi.",
        EN.parties,
      ),
      conflict(
        "en-conflicts",
        "condition",
        "The Company may ask the Employee to attend the office on a working-from-home day with seven days' notice.",
        EN.attend,
      ),
      conflict(
        "en-conflicts",
        "duty",
        "The Company must pay salary in lieu of notice instead of requiring the Employee to work the notice period.",
        EN.inLieu,
      ),
      conflict(
        "en-conflicts",
        "scope",
        "The Employee must keep the Company's confidential information secret only during employment.",
        EN.confidential,
      ),
      conflict(
        "en-conflicts",
        "place",
        "This agreement is governed by the laws of Scotland.",
        EN.law,
      ),
      conflict(
        "en-conflicts",
        "share",
        "The Company contributes 4 percent of salary to the pension and the Employee 6 percent.",
        EN.pension,
      ),
      conflict(
        "en-conflicts",
        "entitlement-off",
        "The Employee gets no paid holiday beyond public holidays.",
        EN.holiday,
      ),
      conflict(
        "en-conflicts",
        "unlimited",
        "The Employee may take unlimited paid holiday.",
        EN.holiday,
      ),
    ] satisfies Row[]
  ).map((r) => row("en", r)),
  ...(
    [
      conflict("zh-conflicts", "number", "乙方月工资为人民币两万元。", ZH.salary),
      conflict("zh-conflicts", "date", "乙方自2027年2月11日起入职。", ZH.start),
      conflict("zh-conflicts", "year", "乙方自2028年1月11日起入职。", ZH.start),
      conflict("zh-conflicts", "negation", "试用期内任何一方都不得解除本合同。", ZH.probation),
      conflict("zh-conflicts", "unit", "乙方年工资为人民币一万八千元。", ZH.salary),
      conflict("zh-conflicts", "reporting-line", "人力资源总监向乙方汇报。", ZH.start),
      conflict("zh-conflicts", "payer", "甲方每月向乙方支付租金人民币一千五百元。", ZH.flat),
      conflict(
        "zh-conflicts",
        "employer",
        "林晓是用人单位，明川食品有限公司是劳动者。",
        ZH.parties,
      ),
      conflict(
        "zh-conflicts",
        "seller",
        "劳动合同终止时，乙方可按人民币三千元将笔记本电脑出售给甲方。",
        ZH.laptop,
      ),
      conflict("zh-conflicts", "landlord", "乙方将明川路14号2室出租给甲方。", ZH.flat),
      conflict("zh-conflicts", "name", "本合同的劳动者是王晓。", ZH.parties),
      conflict("zh-conflicts", "condition", "甲方须提前七天通知乙方在居家工作日到岗。", ZH.attend),
      conflict("zh-conflicts", "scope", "乙方仅在职期间须对甲方的商业秘密保密。", ZH.confidential),
      conflict("zh-conflicts", "place", "本合同适用新加坡法律。", ZH.law),
      conflict("zh-conflicts", "share", "乙方依法为甲方缴纳社会保险和住房公积金。", ZH.social),
      conflict("zh-conflicts", "entitlement-off", "乙方不享有带薪年休假。", ZH.holiday),
      conflict("zh-conflicts", "unlimited", "乙方的带薪年休假不限天数。", ZH.holiday),
    ] satisfies Row[]
  ).map((r) => row("zh", r)),
];
