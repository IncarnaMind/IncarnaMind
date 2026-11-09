/**
 * Decoys for #2889 written after the first measured run and before any run on them: a duty or
 * right whose own condition is an "otherwise" clause ("unless otherwise agreed", 除非双方另有约定),
 * stated without it in a sentence that names a unit, beside the Document's own unit default. A
 * judge that took every "unless otherwise …" for a default would read them Supported. None of them
 * may read Supported. Not edited after their commit, and none is a prompt's example.
 */

export interface OtherwiseDecoy {
  name: string;
  language: "en" | "zh";
  document: readonly string[];
  sentence: string;
}

export const OTHERWISE_DECOYS: readonly OtherwiseDecoy[] = [
  {
    name: "EN pay within 30 days unless otherwise agreed in writing",
    language: "en",
    document: [
      "Northgate supply terms",
      "Amounts are in GBP thousands unless otherwise stated.",
      "The Buyer must pay each invoice within 30 days unless otherwise agreed in writing.",
    ],
    sentence: "The Buyer must pay each invoice within 30 days; amounts are in GBP thousands.",
  },
  {
    name: "EN pay in advance except as otherwise provided",
    language: "en",
    document: [
      "Ormsby licence summary",
      "All fees are in EUR thousands unless otherwise stated.",
      "The Licensee shall pay the annual fee in advance, except as otherwise provided in Schedule 2.",
    ],
    sentence: "Fees are in EUR thousands, and the Licensee shall pay the annual fee in advance.",
  },
  {
    name: "EN quarterly rent unless the parties agree otherwise",
    language: "en",
    document: [
      "Pendle lease summary",
      "Rents are in GBP thousands unless otherwise stated.",
      "The Tenant must pay the rent quarterly in advance unless the parties agree otherwise.",
    ],
    sentence: "Rents are in GBP thousands, and the Tenant must pay the rent quarterly in advance.",
  },
  {
    name: "EN monthly invoices save as otherwise set out",
    language: "en",
    document: [
      "Quarry haulage contract",
      "All amounts are in USD millions unless otherwise stated.",
      "The Contractor may invoice monthly, save as otherwise set out in the order.",
    ],
    sentence: "All amounts are in USD millions, and the Contractor may invoice monthly.",
  },
  {
    name: "EN notice unless otherwise directed",
    language: "en",
    document: [
      "Redbridge facilities agreement",
      "Charges are in CHF thousands unless otherwise stated.",
      "The Client must give 60 days' notice to end the service, unless otherwise directed by the Provider.",
    ],
    sentence:
      "Charges are in CHF thousands, and the Client must give 60 days' notice to end the service.",
  },
  {
    name: "EN liability cap except where otherwise agreed",
    language: "en",
    document: [
      "Stanmore services agreement",
      "Amounts are in GBP million unless otherwise stated.",
      "The Supplier shall cap its liability at 5.0 except where otherwise agreed by the Board.",
    ],
    sentence: "Amounts are in GBP million, and the Supplier shall cap its liability at 5.0.",
  },
  {
    name: "ZH 除非双方另有约定，须30日内付款",
    language: "zh",
    document: [
      "北港供货条款",
      "除另有说明外，金额单位为人民币千元。",
      "除非双方另有约定，买方须在30日内支付每张发票。",
    ],
    sentence: "金额单位为人民币千元，买方须在30日内支付每张发票。",
  },
  {
    name: "ZH 除合同另有规定外，应预付年费",
    language: "zh",
    document: [
      "欧姆许可协议摘要",
      "如无特别说明，费用单位为千欧元。",
      "除合同另有规定外，被许可方应预付年费。",
    ],
    sentence: "费用单位为千欧元，被许可方应预付年费。",
  },
  {
    name: "ZH 除非另有书面约定，须按季预付租金",
    language: "zh",
    document: [
      "彭德尔租赁合同摘要",
      "除另有说明外，租金单位为人民币千元。",
      "除非另有书面约定，承租人须按季度预付租金。",
    ],
    sentence: "租金单位为人民币千元，承租人须按季度预付租金。",
  },
  {
    name: "ZH 除本协议另有规定外，可以按月开票",
    language: "zh",
    document: [
      "采石运输合同",
      "除另有说明外，金额单位为百万美元。",
      "除本协议另有规定外，承包方可以按月开具发票。",
    ],
    sentence: "金额单位为百万美元，承包方可以按月开具发票。",
  },
  {
    name: "ZH 除双方另行商定外，须提前60日通知",
    language: "zh",
    document: [
      "瑞桥设施服务协议",
      "如无特别说明，费用单位为千瑞士法郎。",
      "除双方另行商定外，客户终止服务须提前60日通知。",
    ],
    sentence: "费用单位为千瑞士法郎，客户终止服务须提前60日通知。",
  },
  {
    name: "ZH 除董事会另行书面同意外，责任上限",
    language: "zh",
    document: [
      "斯坦莫尔服务协议",
      "除另有说明外，金额单位为人民币百万元。",
      "除董事会另行书面同意外，供应商的责任上限为5.0。",
    ],
    sentence: "金额单位为人民币百万元，供应商的责任上限为5.0。",
  },
];
