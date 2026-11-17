/**
 * Made-up lease text for the sign-word cases (#2578): paragraphs with no sign word in them, so
 * that the words under test are the only ones, and a sign sentence, an amount sentence and a
 * claim for each case, in English and Simplified Chinese.
 */
export const OTHER_TERMS = {
  en: [
    "The lease runs for five years from the first of March.",
    "The tenant may sublet the premises with the landlord's written consent, which may not be unreasonably withheld.",
    "The tenant pays the service charge quarterly in advance.",
    "The landlord insures the building and recovers the premium from the tenant.",
    "Either party may end the lease on six months' notice after the third year.",
    "The landlord returns the deposit within thirty days of the end of the lease, once any rent owing is paid.",
    "The tenant keeps the premises in good repair and tells the landlord of any damage at once.",
  ],
  "zh-CN": [
    "本合同期限为五年，自三月一日起算，期满可以续签，续签的租金由双方另行协商确定。",
    "承租人转租房屋须经出租人书面同意，出租人不得无理拒绝，也不得借此提高租金或者另行收取任何费用。",
    "承租人按季度预付服务费，逾期支付的，应按日向出租人支付违约金，违约金不得超过应付服务费的百分之十。",
    "出租人为整幢大楼投保，保险费由各承租人按承租面积的比例分摊并按年结算，出租人应当提供保单副本。",
    "任何一方在合同期限满三年之后，均可提前六个月书面通知对方解除本合同，解除合同不影响已经产生的债权债务。",
    "出租人应当在承租人交付押金之日起十日内，向承租人出具书面收据，并在合同终止后三十日内退还押金。",
    "承租人应当妥善使用并爱护租赁房屋及其附属设施，发现损坏的，应当立即书面通知出租人并协助处理。",
    "出租人有权在提前二十四小时通知承租人后进入租赁房屋检查，遇到紧急情况的，可以无须事先通知。",
    "出租人更换物业管理公司的，应当提前三十日书面通知承租人，并将新的联系方式一并告知承租人。",
    "承租人在租赁期间使用的水电燃气费用，由承租人按照实际用量向供应单位直接缴纳并保留缴费凭证。",
  ],
} as const;

export const SIGN_SCOPE = {
  en: {
    far: {
      sign: "After the write-down the reserve is negative.",
      amount: "The reserve now stands at ninety-five thousand dollars ($95,000.00).",
      number: "$95,000.00",
      shown: "$95,000",
      claim: (shown: string) => `The amount is ${shown}.`,
    },
    other: {
      sign: "The Landlord is not liable for any loss of business.",
      amount: "The annual rent is ninety-five thousand dollars ($95,000.00).",
      number: "$95,000.00",
      shown: "$95,000",
      claim: (shown: string) => `The annual rent is ${shown}.`,
    },
    before: {
      sign: "The balance was negative.",
      amount: "It was ninety-five thousand dollars ($95,000.00).",
      number: "$95,000.00",
      shown: "$95,000",
      claim: (shown: string) => `The amount is ${shown}.`,
    },
    tied: {
      sign: "Party A made a loss.",
      amount: "Its result for the year was $2.6 million ($2,600,000).",
      number: "$2,600,000",
      shown: "$2,600,000",
      claim: (shown: string) => `The result for the year was ${shown}.`,
    },
    tiedFar: {
      sign: "Party A made a loss this year.",
      amount: "Its result for the year was $2.6 million ($2,600,000).",
      number: "$2,600,000",
      shown: "$2,600,000",
      claim: (shown: string) => `The result for the year was ${shown}.`,
    },
    tiedPlain: {
      sign: "Party A made a loss.",
      amount: "The result for the year was $2.6 million ($2,600,000).",
      number: "$2,600,000",
      shown: "$2,600,000",
      claim: (shown: string) => `The result for the year was ${shown}.`,
    },
  },
  "zh-CN": {
    far: {
      sign: "经减值后，该项准备金为负数。",
      amount: "该项准备金现为人民币九万五千元（¥95,000）。",
      number: "¥95,000",
      shown: "¥95,000",
      claim: (shown: string) => `金额为${shown}。`,
    },
    other: {
      sign: "出租人对任何营业损失不承担责任。",
      amount: "年租金为人民币九万五千元（¥95,000）。",
      number: "¥95,000",
      shown: "¥95,000",
      claim: (shown: string) => `年租金为${shown}。`,
    },
    before: {
      sign: "余额为负数。",
      amount: "该金额为人民币九万五千元（¥95,000）。",
      number: "¥95,000",
      shown: "¥95,000",
      claim: (shown: string) => `金额为${shown}。`,
    },
    tied: {
      sign: "甲方本年发生亏损。",
      amount: "其本年经营成果为人民币260万元（¥2,600,000）。",
      number: "¥2,600,000",
      shown: "¥2,600,000",
      claim: (shown: string) => `本年经营成果为${shown}。`,
    },
    tiedFar: {
      sign: "甲方本年发生亏损。",
      amount: "其本年经营成果为人民币260万元（¥2,600,000）。",
      number: "¥2,600,000",
      shown: "¥2,600,000",
      claim: (shown: string) => `本年经营成果为${shown}。`,
    },
    tiedPlain: {
      sign: "甲方本年发生亏损。",
      amount: "本年经营成果为人民币260万元（¥2,600,000）。",
      number: "¥2,600,000",
      shown: "¥2,600,000",
      claim: (shown: string) => `本年经营成果为${shown}。`,
    },
  },
} as const;
