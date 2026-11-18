/**
 * Sentences a User in finance, law or medicine writes from a Document, each beside a wrong twin
 * that is wrong without contradicting it: it says more than the Document does (`overstated`), adds
 * something the Document doesn't state to something it does (`partly-supported`), or states what
 * the Document doesn't state at all (`not-found`). Fourteen in English and fourteen in Chinese, on
 * invented Documents of a line or two.
 *
 * `way` was written with the pair, before any run. The set is fixed: a pair is not edited once a
 * baseline rests on it, and a new shape is a new pair.
 */
export interface FieldPair {
  id: string;
  field: "finance" | "law" | "medicine";
  language: "en" | "zh-CN";
  document: string;
  right: string;
  wrong: string;
  /** How the wrong twin goes beyond its Document. */
  way: "overstated" | "partly-supported" | "not-found";
}

export const FIELD_PAIRS: readonly FieldPair[] = [
  {
    id: "en-p01",
    field: "finance",
    language: "en",
    document:
      "Outlook: management expects revenue for fiscal 2027 to be between $410 million and $430 million.",
    right: "Management expects fiscal 2027 revenue of between $410 million and $430 million.",
    wrong: "Fiscal 2027 revenue will be $430 million.",
    way: "overstated",
  },
  {
    id: "en-p02",
    field: "finance",
    language: "en",
    document:
      "On 3 February the Board authorised the repurchase of up to $150 million of ordinary shares over the next two years.",
    right: "The Board has authorised share repurchases of up to $150 million.",
    wrong: "The company will buy back $150 million of its shares.",
    way: "overstated",
  },
  {
    id: "en-p03",
    field: "finance",
    language: "en",
    document:
      "In the European segment, gross margin improved to 38.2% from 36.5%, helped by lower freight costs. Margins in the other segments are not reported separately.",
    right: "Gross margin in the European segment improved to 38.2%.",
    wrong: "The group's gross margin improved to 38.2%.",
    way: "overstated",
  },
  {
    id: "en-p04",
    field: "finance",
    language: "en",
    document:
      "The auditor issued an unqualified opinion on the 2025 financial statements on 14 March 2026.",
    right: "The auditor issued an unqualified opinion on the 2025 financial statements.",
    wrong:
      "The auditor issued an unqualified opinion on the 2025 financial statements and found no weaknesses in internal controls.",
    way: "partly-supported",
  },
  {
    id: "en-p05",
    field: "finance",
    language: "en",
    document:
      "Net debt stood at €1.8 billion at the year end, down from €2.1 billion a year earlier.",
    right: "Net debt was €1.8 billion at the year end.",
    wrong: "The company's credit rating was upgraded at the year end.",
    way: "not-found",
  },
  {
    id: "en-p06",
    field: "law",
    language: "en",
    document:
      "Clause 18.2: Either party may terminate this Agreement on 90 days' written notice, provided that no Order is then in progress.",
    right: "Either party may terminate on 90 days' written notice if no Order is in progress.",
    wrong: "Either party may terminate the Agreement on 90 days' written notice.",
    way: "overstated",
  },
  {
    id: "en-p07",
    field: "law",
    language: "en",
    document:
      "The court held that the limitation clause was unenforceable against the consumer claimants. It expressed no view on the clause's effect between the commercial parties.",
    right: "The court held the limitation clause unenforceable against the consumer claimants.",
    wrong: "The court held that the limitation clause was unenforceable against every claimant.",
    way: "overstated",
  },
  {
    id: "en-p08",
    field: "law",
    language: "en",
    document:
      "Clause 11: The Supplier's liability under this clause shall not exceed the fees paid in the preceding twelve months.",
    right:
      "The Supplier's liability under the clause is capped at the fees paid in the preceding twelve months.",
    wrong: "The Supplier must pay damages equal to the fees paid in the preceding twelve months.",
    way: "overstated",
  },
  {
    id: "en-p09",
    field: "law",
    language: "en",
    document:
      "The lease runs for ten years from 1 May 2024, with a rent review at the end of the fifth year.",
    right: "The lease runs for ten years from 1 May 2024.",
    wrong:
      "The lease runs for ten years from 1 May 2024, and the tenant may renew it for a further five.",
    way: "partly-supported",
  },
  {
    id: "en-p10",
    field: "law",
    language: "en",
    document:
      "Clause 24: Any dispute arising out of this Agreement shall be referred to arbitration in Singapore under the SIAC Rules.",
    right: "Disputes are to be referred to arbitration in Singapore under the SIAC Rules.",
    wrong: "The Agreement is governed by the law of England and Wales.",
    way: "not-found",
  },
  {
    id: "en-p11",
    field: "medicine",
    language: "en",
    document:
      "In this cohort of 3,412 adults, daily use of the drug was associated with a 21% lower rate of hospital admission. The study was observational and cannot show cause.",
    right: "Daily use of the drug was associated with a 21% lower rate of hospital admission.",
    wrong: "Daily use of the drug cut hospital admissions by 21%.",
    way: "overstated",
  },
  {
    id: "en-p12",
    field: "medicine",
    language: "en",
    document:
      "Early results suggest that the vaccine may reduce transmission; a larger trial is under way to confirm this.",
    right: "Early results suggest the vaccine may reduce transmission.",
    wrong: "The vaccine reduces transmission.",
    way: "overstated",
  },
  {
    id: "en-p13",
    field: "medicine",
    language: "en",
    document:
      "The treatment lowered systolic blood pressure by 9 mmHg in patients over 65. No significant change was seen in younger patients.",
    right: "In patients over 65, the treatment lowered systolic blood pressure by 9 mmHg.",
    wrong: "The treatment lowered patients' systolic blood pressure by 9 mmHg at every age.",
    way: "overstated",
  },
  {
    id: "en-p14",
    field: "medicine",
    language: "en",
    document: "The guideline recommends a starting dose of 5 mg once daily for adults.",
    right: "The guideline recommends a starting dose of 5 mg once daily for adults.",
    wrong:
      "The guideline recommends a starting dose of 5 mg once daily for adults, rising to 10 mg after four weeks.",
    way: "partly-supported",
  },
  {
    id: "zh-p01",
    field: "finance",
    language: "zh-CN",
    document: "业绩展望：公司预计2027年全年净利润同比增长10%至15%。",
    right: "公司预计2027年净利润同比增长10%至15%。",
    wrong: "公司2027年净利润将同比增长15%。",
    way: "overstated",
  },
  {
    id: "zh-p02",
    field: "finance",
    language: "zh-CN",
    document: "董事会于1月批准2026年资本开支预算，总额不超过8亿元。",
    right: "董事会批准的2026年资本开支预算上限为8亿元。",
    wrong: "公司2026年将投入资本开支8亿元。",
    way: "overstated",
  },
  {
    id: "zh-p03",
    field: "finance",
    language: "zh-CN",
    document: "华东区门店同店销售额同比增长6.4%，其余地区的同店销售数据未披露。",
    right: "华东区门店同店销售额同比增长6.4%。",
    wrong: "公司全部门店同店销售额同比增长6.4%。",
    way: "overstated",
  },
  {
    id: "zh-p04",
    field: "finance",
    language: "zh-CN",
    document: "本期计提商誉减值准备1.2亿元，全部来自此前收购的物流业务。",
    right: "本期计提商誉减值准备1.2亿元。",
    wrong: "本期计提商誉减值准备1.2亿元，相关物流业务已于本期出售。",
    way: "partly-supported",
  },
  {
    id: "zh-p05",
    field: "finance",
    language: "zh-CN",
    document: "截至年末，公司货币资金余额为23.5亿元，较年初增加3.1亿元。",
    right: "年末公司货币资金余额为23.5亿元。",
    wrong: "年末公司已还清全部银行借款。",
    way: "not-found",
  },
  {
    id: "zh-p06",
    field: "law",
    language: "zh-CN",
    document: "第九条：乙方逾期付款超过30日的，甲方有权解除合同，但应提前10日书面通知乙方。",
    right: "乙方逾期付款超过30日的，甲方可在提前10日书面通知后解除合同。",
    wrong: "乙方逾期付款的，甲方有权解除合同。",
    way: "overstated",
  },
  {
    id: "zh-p07",
    field: "law",
    language: "zh-CN",
    document: "法院认定该竞业限制条款对高级管理人员有效；对普通员工是否有效，判决未作认定。",
    right: "法院认定该竞业限制条款对高级管理人员有效。",
    wrong: "法院认定该竞业限制条款对全体员工有效。",
    way: "overstated",
  },
  {
    id: "zh-p08",
    field: "law",
    language: "zh-CN",
    document: "第十四条：违约方应支付的违约金总额不超过合同总价的20%。",
    right: "违约金总额以合同总价的20%为上限。",
    wrong: "违约方应支付合同总价20%的违约金。",
    way: "overstated",
  },
  {
    id: "zh-p09",
    field: "law",
    language: "zh-CN",
    document: "第二十条：保密义务自合同终止之日起持续三年。",
    right: "保密义务在合同终止后持续三年。",
    wrong: "保密义务在合同终止后持续三年，违反者须支付50万元违约金。",
    way: "partly-supported",
  },
  {
    id: "zh-p10",
    field: "law",
    language: "zh-CN",
    document: "第三十条：本合同自双方签字盖章之日起生效，一式两份。",
    right: "合同自双方签字盖章之日起生效。",
    wrong: "本合同适用香港特别行政区法律。",
    way: "not-found",
  },
  {
    id: "zh-p11",
    field: "medicine",
    language: "zh-CN",
    document:
      "这项回顾性研究纳入2,860名患者，发现规律服用该药与住院率降低18%相关。研究者指出，不能据此推断因果关系。",
    right: "研究发现规律服用该药与住院率降低18%相关。",
    wrong: "规律服用该药使住院率降低了18%。",
    way: "overstated",
  },
  {
    id: "zh-p12",
    field: "medicine",
    language: "zh-CN",
    document: "动物实验提示，该化合物可能延缓肿瘤生长；目前尚未开展人体试验。",
    right: "动物实验提示该化合物可能延缓肿瘤生长。",
    wrong: "该化合物能延缓肿瘤生长。",
    way: "overstated",
  },
  {
    id: "zh-p13",
    field: "medicine",
    language: "zh-CN",
    document:
      "在合并糖尿病的患者中，该方案使心血管事件减少14%；在未合并糖尿病的患者中未见明显差异。",
    right: "在合并糖尿病的患者中，该方案使心血管事件减少14%。",
    wrong: "该方案使所有患者的心血管事件减少14%。",
    way: "overstated",
  },
  {
    id: "zh-p14",
    field: "medicine",
    language: "zh-CN",
    document: "指南建议该药成人每日最大剂量为4克。",
    right: "指南建议该药成人每日最大剂量为4克。",
    wrong: "指南建议该药成人每日最大剂量为4克，儿童为2克。",
    way: "partly-supported",
  },
];
