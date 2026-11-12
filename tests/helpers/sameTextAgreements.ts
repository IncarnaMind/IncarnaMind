/**
 * Invented agreements, in English and Chinese, for telling a copy of a checked
 * file from a Document that only shares some of its text (#2216): one template
 * filled for two deals, drafts with some clauses rewritten, a reply that quotes
 * two of its paragraphs, a bundle that holds it whole, and a code it quotes.
 * Every party, address and figure is made up.
 */

export type Language = "en" | "zh";

export interface Paragraph {
  text: string;
  heading?: boolean;
}

/** A file's text as a person laid it out: its running header and its paragraphs. */
export interface Agreement {
  title: string;
  header: string;
  paragraphs: Paragraph[];
}

interface Deal {
  number: string;
  date: string;
  supplier: string;
  supplierIs: string;
  client: string;
  clientIs: string;
  business: string;
  start: string;
  months: string;
  services: [string, string];
  fee: string;
  insurance: string;
  supplierNotice: string;
  clientNotice: string;
  special: [string, string];
  signatories: [string, string];
}

interface Clause {
  heading: string;
  paragraphs: string[];
}

const ENGLISH_A: Deal = {
  number: "FA-2026-017",
  date: "14 March 2026",
  supplier: "Fernhill Analytics Ltd",
  supplierIs:
    "a company incorporated in England and Wales with company number 11904736, whose registered office is at Unit 4, Wharf Road, Leeds LS2 7EQ",
  client: "Calder Vale Housing Trust",
  clientIs:
    "a registered society with number 31872R, whose registered office is at Mill House, 20 Station Parade, Halifax HX1 1DF",
  business: "data analysis and stock condition reporting to social landlords",
  start: "1 April 2026",
  months: "twenty-four",
  services: [
    "The Supplier shall carry out a stock condition survey of the Client's 2,140 homes across the Calder Valley, collecting data on the age and condition of roofs, windows, heating systems and kitchens, and shall load the results into the Client's asset management system in the format set out in the Schedule.",
    "The Supplier shall analyse the survey data, prepare a thirty-year investment plan for the Client's homes and present the plan to the Client's board at its meeting in October 2026. It shall also provide a dashboard of damp and mould reports, updated weekly, for the whole of the term.",
  ],
  fee: "a fixed fee of GBP 186,000 for the survey and the investment plan, payable in six equal instalments, and GBP 2,450 a month for the dashboard",
  insurance: "two million pounds",
  supplierNotice:
    "Fernhill Analytics Ltd, Unit 4, Wharf Road, Leeds LS2 7EQ, for the attention of the Managing Director, email contracts@fernhill-analytics.example",
  clientNotice:
    "Calder Vale Housing Trust, Mill House, 20 Station Parade, Halifax HX1 1DF, for the attention of the Director of Assets, email assets@caldervale.example",
  special: [
    "1. The survey shall cover at least ninety per cent of the Client's homes. The Supplier shall make three attempts to gain access to each home, at least one of them in the evening or at a weekend, before recording it as a no-access property.",
    "2. Surveyors shall carry identification at all times, shall give tenants at least forty-eight hours' notice of a visit, and shall report any safeguarding concern to the Client's housing team on the same day.",
  ],
  signatories: ["Priya Raman, Managing Director", "Thomas Whitlock, Chief Executive"],
};

const ENGLISH_B: Deal = {
  number: "BSP-2025-042",
  date: "2 June 2025",
  supplier: "Brightwater Survey Partners LLP",
  supplierIs:
    "a limited liability partnership with number OC438215, whose registered office is at 3 Harbour Yard, Bristol BS1 6QH",
  client: "Marlow Street Cooperative Homes Ltd",
  clientIs:
    "a company with number 07712093, whose registered office is at 41 Marlow Street, Reading RG1 2LP",
  business: "building surveys and energy assessments for housing cooperatives",
  start: "1 July 2025",
  months: "eighteen",
  services: [
    "The Supplier shall carry out an energy assessment of each of the Client's 312 flats and shared buildings, measuring insulation, ventilation and the efficiency of the communal boilers, and shall issue an energy performance report for each building.",
    "The Supplier shall recommend a programme of retrofit works that brings every flat to an energy rating of C or better by 2030, with costed options, and shall help the Client prepare its application to the regional retrofit grant scheme.",
  ],
  fee: "GBP 640 for each flat assessed and a fixed fee of GBP 38,500 for the retrofit programme and the grant application, invoiced on completion of each stage",
  insurance: "one million pounds",
  supplierNotice:
    "Brightwater Survey Partners LLP, 3 Harbour Yard, Bristol BS1 6QH, for the attention of the Senior Partner, email office@brightwater-survey.example",
  clientNotice:
    "Marlow Street Cooperative Homes Ltd, 41 Marlow Street, Reading RG1 2LP, for the attention of the Secretary, email secretary@marlowstreet.example",
  special: [
    "1. The Supplier shall complete the assessments of the shared buildings before the end of September 2025, so that the results can be used in the Client's grant application.",
    "2. The Supplier shall use only assessors accredited under the national retrofit standard, and shall give the Client copies of their accreditation before the work starts.",
  ],
  signatories: ["Daniel Okafor, Partner", "Helen Marsh, Secretary"],
};

const QUOTED_CODE_EN =
  "a provider must not share a tenant's records with a third party unless the sharing is necessary for the service the tenant receives. Records shared must be limited to the fields that the service needs.";

function englishClauses(deal: Deal): Clause[] {
  return [
    {
      heading: "1. Definitions and interpretation",
      paragraphs: [
        "1.1 In this Agreement the following words have these meanings. Business Day means a day other than a Saturday, a Sunday or a public holiday in England. Charges means the sums payable for the Services under clause 6. Client Materials means all documents, data and other materials that the Client provides to the Supplier for the purpose of the Services. Deliverables means the reports, data sets and other outputs that the Supplier provides to the Client as part of the Services. Services means the services described in clause 3 and in the Schedule.",
        "1.2 Clause and paragraph headings do not affect the interpretation of this Agreement. A reference to a statute is a reference to it as amended or re-enacted from time to time. Words in the singular include the plural and the other way round. A reference to writing includes email but not any other form of electronic message.",
      ],
    },
    {
      heading: "2. Commencement and term",
      paragraphs: [
        `2.1 This Agreement starts on ${deal.start} and continues for ${deal.months} months, unless it is terminated earlier under clause 13.`,
        "2.2 The Client may extend this Agreement once, for a further period of twelve months, by giving the Supplier written notice at least sixty days before the end of the initial term. The terms of this Agreement apply during any extension, except that the Charges may be reviewed under clause 6.5.",
      ],
    },
    {
      heading: "3. The Services",
      paragraphs: [
        `3.1 ${deal.services[0]}`,
        `3.2 ${deal.services[1]}`,
        "3.3 The Supplier shall provide the Services from the start date and shall meet any performance dates set out in the Schedule. Time is not of the essence for performance dates, but the Supplier shall tell the Client promptly if it expects to miss one, with the reasons and a revised date.",
      ],
    },
    {
      heading: "4. Supplier's obligations",
      paragraphs: [
        "4.1 The Supplier shall provide the Services with the skill, care and diligence to be expected of a competent provider of similar services, and in accordance with good industry practice. It shall use personnel who are suitably skilled and experienced, and shall make sure that they comply with the Client's reasonable site rules when they are on the Client's premises.",
        "4.2 The Supplier shall obtain and keep in force all licences, permissions and consents it needs to provide the Services, and shall comply with all laws that apply to the Services. It shall not do or omit to do anything that may cause the Client to lose any licence, authority or permission on which it relies for its business.",
      ],
    },
    {
      heading: "5. Client's obligations",
      paragraphs: [
        "5.1 The Client shall co-operate with the Supplier in all matters relating to the Services, and shall appoint a manager for the Services who has the authority to make decisions on its behalf. It shall give the Supplier, its employees and its subcontractors access to its premises, records and systems as the Supplier reasonably needs to provide the Services.",
        "5.2 The Client shall provide the Client Materials in good time and shall make sure that they are accurate and complete. If the Supplier's performance is prevented or delayed by an act or omission of the Client, the Supplier shall not be liable for any cost or loss that results, and the dates for performance shall be extended accordingly.",
      ],
    },
    {
      heading: "6. Charges and payment",
      paragraphs: [
        `6.1 In return for the Services the Client shall pay the Supplier ${deal.fee}.`,
        "6.2 The Supplier shall invoice the Client monthly in arrears. Each invoice shall set out the Services provided in the month, any expenses agreed in advance, and value added tax at the rate in force at the date of the invoice.",
        "6.3 The Client shall pay each valid invoice within thirty days of receiving it, into the bank account that the Supplier names in writing. If the Client disputes an invoice in good faith, it shall tell the Supplier within ten Business Days and pay the part that is not in dispute.",
        "6.4 If the Client fails to pay any undisputed amount by the due date, the Supplier may charge interest on the overdue amount at four per cent a year above the Bank of England base rate, from the due date until payment, whether before or after judgment.",
        "6.5 The Supplier may review the Charges once in each year of this Agreement, on giving the Client not less than three months' notice. No increase may exceed the rise in the Consumer Prices Index over the previous twelve months.",
      ],
    },
    {
      heading: "7. Change control",
      paragraphs: [
        "7.1 Either party may ask for a change to the scope or the timing of the Services. The Supplier shall, within ten Business Days of a request, give the Client a written estimate of the effect of the change on the Charges, the timetable and any other term of this Agreement.",
        "7.2 No change takes effect until both parties have agreed it in writing. Until then the Supplier shall go on providing the Services as they were before the request.",
      ],
    },
    {
      heading: "8. Intellectual property",
      paragraphs: [
        "8.1 All intellectual property rights in the Deliverables shall belong to the Client from the moment they are created, except for the Supplier's methods, software and know-how that existed before this Agreement or were developed independently of it. The Supplier grants the Client a non-exclusive, royalty-free licence to use those for the purpose of receiving and using the Services and the Deliverables.",
        "8.2 The Client grants the Supplier a licence to copy and modify the Client Materials for the term of this Agreement, for the sole purpose of providing the Services.",
      ],
    },
    {
      heading: "9. Confidentiality",
      paragraphs: [
        "9.1 Each party shall keep confidential all information about the business, affairs, customers and suppliers of the other party that it receives under or in connection with this Agreement, and shall not use it for any purpose other than performing its obligations under this Agreement.",
        "9.2 A party may disclose confidential information to its employees, officers, advisers and subcontractors who need to know it for the purposes of this Agreement, provided that it makes sure they keep it confidential, and as required by law, a court of competent jurisdiction or any regulatory authority. This clause 9 survives termination of this Agreement for five years.",
      ],
    },
    {
      heading: "10. Data protection",
      paragraphs: [
        "10.1 Each party shall comply with the data protection legislation in force from time to time. Where the Supplier processes personal data on behalf of the Client, it shall do so only on the Client's documented instructions, and shall put in place appropriate technical and organisational measures against unauthorised or unlawful processing and against accidental loss, destruction or damage.",
        `10.2 The parties have had regard to paragraph 4.2 of the Housing Data Sharing Code, which provides that "${QUOTED_CODE_EN}" The Supplier shall notify the Client without undue delay, and in any event within forty-eight hours, on becoming aware of a personal data breach.`,
      ],
    },
    {
      heading: "11. Limitation of liability",
      paragraphs: [
        "11.1 Nothing in this Agreement limits or excludes liability for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, or for any other liability that cannot be limited or excluded by law.",
        "11.2 Subject to clause 11.1, neither party shall be liable to the other, whether in contract, tort (including negligence), breach of statutory duty or otherwise, for any loss of profits, loss of sales or business, loss of agreements or contracts, loss of anticipated savings, or any indirect or consequential loss.",
        "11.3 Subject to clause 11.1, each party's total liability to the other under or in connection with this Agreement shall not exceed one hundred and twenty-five per cent of the Charges paid and payable in the twelve months before the event giving rise to the claim.",
      ],
    },
    {
      heading: "12. Insurance",
      paragraphs: [
        `12.1 During the term of this Agreement and for six years afterwards, the Supplier shall maintain professional indemnity insurance of not less than ${deal.insurance} for each claim, and public liability insurance of not less than five million pounds for each claim, with a reputable insurer. It shall produce evidence of the insurance to the Client on request.`,
      ],
    },
    {
      heading: "13. Termination",
      paragraphs: [
        "13.1 Either party may terminate this Agreement by giving the other at least three months' written notice.",
        "13.2 Either party may terminate this Agreement with immediate effect by written notice if the other party commits a material breach of any term of this Agreement and, where the breach can be remedied, fails to remedy it within thirty days of being notified of it in writing; or if the other party becomes insolvent, enters into an arrangement with its creditors, or has an administrator, receiver or liquidator appointed.",
        "13.3 The Supplier may terminate this Agreement by written notice if the Client fails to pay any undisputed amount within sixty days of its due date.",
      ],
    },
    {
      heading: "14. Consequences of termination",
      paragraphs: [
        "14.1 On termination of this Agreement for any reason, the Client shall pay all of the Supplier's outstanding unpaid invoices and, for Services supplied but not yet invoiced, the Supplier shall submit an invoice, which shall be payable on receipt.",
        "14.2 The Supplier shall return all Client Materials and any Deliverables, whether or not they have been paid for, within ten Business Days. Termination does not affect any rights or remedies that either party has accrued by then, or any clause that is expressed to survive it.",
      ],
    },
    {
      heading: "15. Non-solicitation",
      paragraphs: [
        "15.1 Neither party shall, during the term of this Agreement and for twelve months afterwards, solicit or entice away from the other party, or employ or try to employ, any person who is or has been engaged as an employee or a subcontractor of the other party in the provision of the Services, without the other party's prior written consent. This does not prevent either party from employing a person who answers a general advertisement.",
      ],
    },
    {
      heading: "16. Force majeure",
      paragraphs: [
        "16.1 Neither party shall be in breach of this Agreement, nor liable for delay in performing or failure to perform any of its obligations, if the delay or failure results from events, circumstances or causes beyond its reasonable control. The time for performance shall be extended accordingly. If the period of delay or non-performance continues for eight weeks, the party not affected may terminate this Agreement by giving fourteen days' written notice to the affected party.",
      ],
    },
    {
      heading: "17. Notices",
      paragraphs: [
        `17.1 A notice given to a party under or in connection with this Agreement shall be in writing and shall be delivered by hand or by pre-paid first-class post at its address set out below, or sent by email to the address set out below. Notices to the Supplier: ${deal.supplierNotice}. Notices to the Client: ${deal.clientNotice}.`,
        "17.2 A notice is deemed to have been received, if delivered by hand, when it is left at the address; if sent by post, at nine in the morning on the second Business Day after posting; and if sent by email, at the time of transmission, or if that is outside business hours, when business hours next begin.",
      ],
    },
    {
      heading: "18. General",
      paragraphs: [
        "18.1 This Agreement is the entire agreement between the parties and supersedes all previous agreements, promises, assurances and understandings between them, whether written or oral, relating to its subject matter. Each party agrees that it shall have no remedies for any statement, representation or warranty that is not set out in this Agreement.",
        "18.2 No variation of this Agreement shall be effective unless it is in writing and signed by the parties. Neither party may assign, transfer or subcontract any of its rights or obligations under this Agreement without the prior written consent of the other, which shall not be unreasonably withheld. If any provision of this Agreement is found to be invalid or unenforceable, it shall be deemed modified to the minimum extent necessary to make it valid, and the rest of this Agreement shall not be affected.",
      ],
    },
    {
      heading: "19. Governing law and jurisdiction",
      paragraphs: [
        "19.1 This Agreement and any dispute or claim arising out of or in connection with it or its subject matter or formation shall be governed by the law of England and Wales. Each party irrevocably agrees that the courts of England and Wales shall have exclusive jurisdiction to settle any such dispute or claim.",
      ],
    },
  ];
}

/** The clauses a draft rewrote, by heading: one, or a third of them. */
const ENGLISH_REWRITES: Record<string, string[]> = {
  "2. Commencement and term": [
    "2.1 This Agreement takes effect when both parties have signed it. The Services begin on the date the Client's manager confirms in writing that the survey programme may start, and end when the Client's board has approved the investment plan.",
    "2.2 If the board has not approved the plan within thirty months of signature, either party may bring this Agreement to an end by giving one month's notice, and the Client shall pay for the work done up to that date.",
  ],
  "5. Client's obligations": [
    "5.1 The Client shall name one officer as the single point of contact for the survey, who shall answer the Supplier's questions within five working days and arrange the keys and the tenant letters for each estate.",
    "5.2 The Client warrants that the property list it supplies is up to date. Homes missing from the list shall be surveyed at the rate for additional homes, and the Client shall bear the cost of any repeat visit caused by an error in the list.",
  ],
  "8. Intellectual property": [
    "8.1 The Supplier keeps ownership of the survey software and the data model it uses, and of every report template. The Client receives a perpetual licence to use the reports and the data collected about its own homes for any purpose connected with managing its housing.",
    "8.2 The Supplier may use survey data that does not identify any tenant or home to improve its benchmarks, and may publish anonymous statistics drawn from it.",
  ],
  "11. Limitation of liability": [
    "11.1 Neither party excludes or limits its liability for death or personal injury resulting from its negligence, or for fraud.",
    "11.2 The Supplier's total liability for loss of or damage to the Client's property shall not exceed one million pounds for each event.",
    "11.3 In every other case the Supplier's total liability under this Agreement shall be limited to the Charges paid in the twelve months before the claim, and the Supplier shall have no liability for any indirect loss or for any loss of profit, revenue or goodwill.",
  ],
  "14. Consequences of termination": [
    "14.1 When this Agreement ends, the Supplier shall hand over the survey data collected so far in the agreed format, and the Client shall pay for each home surveyed at the rate in the Schedule, less any instalments already paid.",
    "14.2 The Supplier shall delete the Client's personal data from its systems within thirty days of the end of this Agreement and shall confirm the deletion in writing.",
  ],
  "17. Notices": [
    "17.1 Notices under this Agreement shall be sent by email to the contract manager of each party named in the Schedule, with a copy by recorded delivery to its registered office.",
    "17.2 A notice sent by email is received on the next working day after it is sent, unless the sender receives a message that it could not be delivered.",
  ],
};

const ONE_CLAUSE = ["11. Limitation of liability"];
const A_THIRD = Object.keys(ENGLISH_REWRITES);

function englishAgreement(deal: Deal, rewritten: readonly string[] = []): Agreement {
  const paragraphs: Paragraph[] = [
    { text: "SERVICES AGREEMENT", heading: true },
    { text: `Agreement number ${deal.number}. This Agreement is dated ${deal.date}.` },
    { text: "PARTIES", heading: true },
    { text: `(1) ${deal.supplier}, ${deal.supplierIs} (the Supplier).` },
    { text: `(2) ${deal.client}, ${deal.clientIs} (the Client).` },
    { text: "BACKGROUND", heading: true },
    {
      text: `(A) The Supplier provides ${deal.business}. (B) The Client wishes to obtain, and the Supplier has agreed to provide, the Services on the terms of this Agreement.`,
    },
    { text: "AGREED TERMS", heading: true },
  ];
  for (const clause of englishClauses(deal)) {
    paragraphs.push({ text: clause.heading, heading: true });
    const texts = rewritten.includes(clause.heading)
      ? (ENGLISH_REWRITES[clause.heading] ?? [])
      : clause.paragraphs;
    for (const text of texts) paragraphs.push({ text });
  }
  paragraphs.push(
    { text: "SCHEDULE: SPECIAL CONDITIONS", heading: true },
    { text: deal.special[0] },
    { text: deal.special[1] },
    { text: `Signed by ${deal.signatories[0]}, for and on behalf of ${deal.supplier}.` },
    { text: `Signed by ${deal.signatories[1]}, for and on behalf of ${deal.client}.` },
  );
  return {
    title: "Services Agreement",
    header: `Services Agreement ${deal.number} - ${deal.client}`,
    paragraphs,
  };
}

const CHINESE_A: Deal = {
  number: "QSW-2026-017",
  date: "2026年3月14日",
  supplier: "南岭数据科技有限公司",
  supplierIs: "统一社会信用代码：91440300MA5G2T6W1P，住所：深圳市南岭大道1203号",
  client: "青石湾物业服务有限公司",
  clientIs: "统一社会信用代码：91330106MA2H7Q8R3K，住所：杭州市青石湾路88号",
  business: "物业数据采集与设施状况评估",
  start: "2026年4月1日",
  months: "二十四个月",
  services: [
    "乙方应当对甲方管理的十二个住宅小区共计4,860户住宅及其公共设施开展设施状况普查，采集屋面、外墙、电梯、给排水和消防设施的使用年限与损坏情况，并按照附件规定的格式将普查数据导入甲方的资产管理系统。",
    "乙方应当对普查数据进行分析，编制甲方所管理住宅的三十年维修改造计划，并在2026年10月甲方董事会会议上汇报。服务期限内，乙方还应当按周更新渗漏及霉变报修的统计看板。",
  ],
  fee: "普查及维修改造计划的固定服务费人民币一百二十八万元，分六期等额支付；统计看板服务费每月人民币一万六千元",
  insurance: "人民币二百万元",
  supplierNotice:
    "南岭数据科技有限公司，深圳市南岭大道1203号，收件人：总经理，电子邮箱contracts@nanling-data.example",
  clientNotice:
    "青石湾物业服务有限公司，杭州市青石湾路88号，收件人：工程管理部负责人，电子邮箱assets@qingshiwan.example",
  special: [
    "一、普查应当覆盖甲方所管理住宅的百分之九十以上。乙方对每户住宅应当至少上门三次，其中至少一次安排在晚间或者周末，三次均无法入户的方可登记为未入户。",
    "二、普查人员应当随身佩戴工作证件，上门前至少提前四十八小时通知住户，发现涉及住户人身安全的情况应当于当日报告甲方客服部门。",
  ],
  signatories: ["林晓雯", "周建国"],
};

const CHINESE_B: Deal = {
  number: "BLZ-2025-042",
  date: "2025年6月2日",
  supplier: "远帆测绘技术有限公司",
  supplierIs: "统一社会信用代码：91320100MA1N8K3D5X，住所：南京市江宁区远帆路7号",
  client: "白鹭洲社区服务中心",
  clientIs: "统一社会信用代码：12320104MB1C4E7Y2H，住所：南京市白鹭洲路16号",
  business: "建筑测绘与能耗评估",
  start: "2025年7月1日",
  months: "十八个月",
  services: [
    "乙方应当对甲方辖区内的312套住宅及公共建筑开展能耗评估，测量外墙保温、通风状况和公共锅炉的运行效率，并为每栋建筑出具能耗评估报告。",
    "乙方应当提出节能改造方案，使全部住宅在2030年前达到二级以上能效标准，方案应当附有多种造价选项，并协助甲方准备申报市级既有建筑节能改造补助资金的材料。",
  ],
  fee: "每套住宅评估费人民币四千二百元，节能改造方案及补助申报材料的固定服务费人民币二十六万元，按各阶段完成情况开具发票",
  insurance: "人民币一百万元",
  supplierNotice:
    "远帆测绘技术有限公司，南京市江宁区远帆路7号，收件人：技术总监，电子邮箱office@yuanfan-survey.example",
  clientNotice:
    "白鹭洲社区服务中心，南京市白鹭洲路16号，收件人：办公室主任，电子邮箱office@bailuzhou.example",
  special: [
    "一、乙方应当于2025年9月底前完成公共建筑的评估，以便甲方在补助申报中使用评估结果。",
    "二、乙方应当仅使用取得国家建筑节能评估资格的评估人员，并在工作开始前向甲方提供其资格证书复印件。",
  ],
  signatories: ["陈立明", "王慧"],
};

const QUOTED_CODE_ZH =
  "服务提供者不得向第三方提供住户的记录，但提供该记录为住户所接受的服务所必需的除外。提供的记录应当限于该服务所需的字段。";

function chineseClauses(deal: Deal): Clause[] {
  return [
    {
      heading: "第一条 定义",
      paragraphs: [
        "1.1 本合同中，“工作日”指中华人民共和国法定工作日；“服务费”指甲方依照第六条应当支付的款项；“甲方资料”指甲方为本合同目的向乙方提供的文件、数据和其他资料；“交付成果”指乙方在服务过程中向甲方提交的报告、数据和其他成果。",
        "1.2 本合同各条款的标题仅为方便阅读而设，不影响对条款内容的解释。本合同所称法律法规，包括其不时修订后的版本。",
      ],
    },
    {
      heading: "第二条 服务期限",
      paragraphs: [
        `2.1 本合同自${deal.start}起生效，服务期限为${deal.months}，但依照第十三条提前解除的除外。`,
        "2.2 甲方可以在服务期限届满前六十日书面通知乙方，将服务期限延长一次，延长期为十二个月。延长期内适用本合同的全部条款，但服务费可以依照第六条第五款调整。",
      ],
    },
    {
      heading: "第三条 服务内容",
      paragraphs: [
        `3.1 ${deal.services[0]}`,
        `3.2 ${deal.services[1]}`,
        "3.3 乙方应当自服务开始之日起提供服务，并按照附件所列的时间节点完成各项工作。乙方预计无法按期完成某项工作的，应当及时书面告知甲方，说明原因并提出新的完成时间。",
      ],
    },
    {
      heading: "第四条 乙方的义务",
      paragraphs: [
        "4.1 乙方应当以同类服务提供者应有的专业水准、谨慎和勤勉提供服务，并遵守行业通行做法。乙方应当安排具备相应技能和经验的人员提供服务，并确保其在甲方场所工作时遵守甲方合理的现场管理规定。",
        "4.2 乙方应当取得并维持提供服务所需的全部资质、许可和批准，遵守适用于本服务的法律法规，不得作出或者不作出任何可能导致甲方丧失其经营所依赖的资质或许可的行为。",
      ],
    },
    {
      heading: "第五条 甲方的义务",
      paragraphs: [
        "5.1 甲方应当在与服务有关的一切事项上配合乙方，并指定一名有权代表甲方作出决定的项目负责人。甲方应当根据乙方提供服务的合理需要，允许乙方及其人员进入甲方场所，查阅甲方的记录和系统。",
        "5.2 甲方应当及时提供甲方资料，并保证其准确、完整。因甲方的作为或者不作为导致乙方无法履行或者迟延履行的，乙方不承担由此产生的费用和损失，相应的履行期限顺延。",
      ],
    },
    {
      heading: "第六条 服务费及支付",
      paragraphs: [
        `6.1 甲方应当就本合同项下的服务向乙方支付${deal.fee}。`,
        "6.2 乙方应当按月向甲方开具发票，列明当月提供的服务、经甲方事先同意的费用以及按开票时适用税率计算的增值税。",
        "6.3 甲方应当在收到合格发票之日起三十日内，将款项支付至乙方书面指定的银行账户。甲方对发票有异议的，应当在十个工作日内书面告知乙方，并支付无异议的部分。",
        "6.4 甲方逾期支付无异议款项的，乙方有权自应付之日起至实际支付之日止，按照逾期金额每日万分之五的标准收取逾期付款违约金。",
        "6.5 本合同履行期间，乙方每年可以调整一次服务费，但应当提前三个月书面通知甲方，且调整幅度不得超过上一年度居民消费价格指数的涨幅。",
      ],
    },
    {
      heading: "第七条 服务变更",
      paragraphs: [
        "7.1 任何一方均可以要求变更服务的范围或者时间安排。乙方应当在收到变更要求之日起十个工作日内，书面说明变更对服务费、进度安排和本合同其他条款的影响。",
        "7.2 变更经双方书面确认后方可生效。在此之前，乙方应当继续按照变更前的约定提供服务。",
      ],
    },
    {
      heading: "第八条 知识产权",
      paragraphs: [
        "8.1 交付成果的知识产权自形成之时起归甲方所有，但乙方在本合同签订前已有的或者独立于本合同开发的方法、软件和专有技术除外。乙方授予甲方非独占、免费的许可，使甲方得以为接受和使用服务及交付成果之目的使用上述方法、软件和专有技术。",
        "8.2 甲方授予乙方在本合同期限内复制和修改甲方资料的许可，但仅限于为提供服务之目的。",
      ],
    },
    {
      heading: "第九条 保密",
      paragraphs: [
        "9.1 一方对因本合同或者与本合同有关而获得的另一方的经营、事务、客户和供应商等信息负有保密义务，不得将其用于履行本合同以外的任何目的。",
        "9.2 一方可以向因本合同目的需要知悉保密信息的员工、高级管理人员、顾问和分包商披露保密信息，但应当确保其履行保密义务；依照法律、有管辖权的法院或者监管机构的要求披露的除外。本条在本合同终止后五年内继续有效。",
      ],
    },
    {
      heading: "第十条 个人信息保护",
      paragraphs: [
        "10.1 双方应当遵守不时有效的个人信息保护法律法规。乙方代表甲方处理个人信息的，应当仅依照甲方的书面指示处理，并采取适当的技术措施和管理措施，防止个人信息被未经授权或者非法处理，以及意外丢失、毁损或者损坏。",
        `10.2 双方已注意到《住房数据共享规范》第4.2条的规定：“${QUOTED_CODE_ZH}”乙方知悉发生个人信息泄露的，应当立即通知甲方，最迟不得超过四十八小时。`,
      ],
    },
    {
      heading: "第十一条 责任限制",
      paragraphs: [
        "11.1 本合同的任何约定均不限制或者排除一方因过失造成人身伤亡的责任、因欺诈产生的责任，以及依法不得限制或者排除的其他责任。",
        "11.2 除第11.1款另有约定外，任何一方均不对另一方的利润损失、营业损失、合同机会损失、预期节省的损失或者任何间接损失承担责任，无论该责任基于合同、侵权、违反法定义务或者其他原因。",
        "11.3 除第11.1款另有约定外，一方因本合同或者与本合同有关而对另一方承担的赔偿责任总额，不超过引起索赔的事件发生前十二个月内已付和应付服务费的百分之一百二十五。",
      ],
    },
    {
      heading: "第十二条 保险",
      paragraphs: [
        `12.1 在本合同期限内及期满后六年内，乙方应当向信誉良好的保险公司投保每次事故赔偿限额不低于${deal.insurance}的职业责任保险，以及每次事故赔偿限额不低于人民币五百万元的公众责任保险，并应甲方要求提供投保证明。`,
      ],
    },
    {
      heading: "第十三条 合同解除",
      paragraphs: [
        "13.1 任何一方均可以提前三个月书面通知另一方解除本合同。",
        "13.2 一方严重违反本合同约定，且在收到另一方书面通知之日起三十日内未予纠正的，或者一方资不抵债、与债权人达成和解、被指定管理人或者进入清算程序的，另一方有权书面通知立即解除本合同。",
        "13.3 甲方逾期六十日仍未支付无异议款项的，乙方有权书面通知解除本合同。",
      ],
    },
    {
      heading: "第十四条 合同解除的后果",
      paragraphs: [
        "14.1 本合同因任何原因终止的，甲方应当支付乙方全部未付的发票款项；对已提供但尚未开票的服务，乙方应当开具发票，甲方应当在收到发票时支付。",
        "14.2 乙方应当在十个工作日内返还全部甲方资料和交付成果，无论交付成果是否已经付款。合同终止不影响任何一方届时已经取得的权利和救济，也不影响约定在合同终止后继续有效的条款。",
      ],
    },
    {
      heading: "第十五条 禁止招揽",
      paragraphs: [
        "15.1 在本合同期限内及期满后十二个月内，未经另一方事先书面同意，任何一方不得招揽、引诱或者雇用另一方参与本服务的员工或者分包商。一方通过公开招聘录用人员的，不受本条限制。",
      ],
    },
    {
      heading: "第十六条 不可抗力",
      paragraphs: [
        "16.1 因超出一方合理控制范围的事件、情况或者原因，导致该方迟延履行或者不能履行本合同义务的，该方不构成违约，也不承担责任，履行期限相应顺延。迟延或者不能履行的情形持续八周的，未受影响的一方可以提前十四日书面通知受影响的一方解除本合同。",
      ],
    },
    {
      heading: "第十七条 通知",
      paragraphs: [
        `17.1 一方根据本合同发出的通知应当采用书面形式，以专人送达、挂号信或者电子邮件的方式发送至下列地址。致乙方：${deal.supplierNotice}。致甲方：${deal.clientNotice}。`,
        "17.2 通知以专人送达的，在送达至上述地址时视为收到；以挂号信发送的，在寄出后第二个工作日上午九时视为收到；以电子邮件发送的，在发送时视为收到，但发送时间在工作时间以外的，在下一个工作时间开始时视为收到。",
      ],
    },
    {
      heading: "第十八条 其他",
      paragraphs: [
        "18.1 本合同构成双方就本合同标的达成的完整协议，取代双方此前就该标的达成的全部书面或者口头的协议、承诺、保证和谅解。任何一方均不得就本合同未载明的陈述、声明或者保证主张救济。",
        "18.2 本合同的变更应当以书面形式作出，并经双方签字盖章。未经另一方事先书面同意，任何一方不得转让或者分包其在本合同项下的权利义务，另一方不得无理拒绝同意。本合同的任何条款被认定无效或者不可执行的，该条款应当在使其有效所必需的最小范围内修改，本合同其他条款的效力不受影响。",
      ],
    },
    {
      heading: "第十九条 法律适用与争议解决",
      paragraphs: [
        "19.1 本合同的订立、效力、解释、履行及争议的解决，适用中华人民共和国法律。因本合同引起的或者与本合同有关的任何争议，双方应当协商解决；协商不成的，任何一方均可以向甲方住所地有管辖权的人民法院提起诉讼。",
      ],
    },
  ];
}

const CHINESE_REWRITES: Record<string, string[]> = {
  "第二条 服务期限": [
    "2.1 本合同自双方签字盖章之日起生效。服务自甲方项目负责人书面确认普查可以开始之日起算，至甲方董事会审议通过维修改造计划之日止。",
    "2.2 签约后三十个月内董事会仍未审议通过该计划的，任何一方均可以提前一个月书面通知对方终止本合同，甲方应当支付截至终止之日已完成工作的费用。",
  ],
  "第五条 甲方的义务": [
    "5.1 甲方应当指定一名普查联络人，在五个工作日内答复乙方的问题，并负责协调各小区的钥匙交接和住户告知书的发放。",
    "5.2 甲方保证其提供的房屋清单真实有效。清单遗漏的住宅按照新增住宅的单价另行计费，因清单错误导致重复上门的费用由甲方承担。",
  ],
  "第八条 知识产权": [
    "8.1 普查软件、数据模型和报告模板的所有权归乙方。甲方取得永久许可，可以为管理其住宅之目的以任何方式使用报告以及有关其自有住宅的普查数据。",
    "8.2 乙方可以将不能识别任何住户或者住宅的普查数据用于完善其行业基准，并可以发布据此形成的匿名统计数据。",
  ],
  "第十一条 责任限制": [
    "11.1 一方因过失造成人身伤亡或者因欺诈给另一方造成损失的，应当依法承担全部责任。",
    "11.2 乙方对甲方财产损坏的赔偿责任，每次事故以人民币一百万元为限。",
    "11.3 除前两款规定的情形外，乙方在本合同项下的赔偿责任总额以索赔发生前十二个月内甲方已付的服务费为限，乙方不对任何间接损失或者利润、收入、商誉的损失承担责任。",
  ],
  "第十四条 合同解除的后果": [
    "14.1 本合同终止时，乙方应当按照约定格式移交截至终止之日已采集的普查数据，甲方应当按照附件所列单价支付已普查住宅的费用，并扣除已支付的分期款项。",
    "14.2 乙方应当在本合同终止后三十日内从其系统中删除甲方的个人信息，并书面确认删除情况。",
  ],
  "第十七条 通知": [
    "17.1 本合同项下的通知应当以电子邮件发送至附件所列的双方合同联系人，并同时以挂号信抄送其住所地。",
    "17.2 以电子邮件发送的通知，在发送后的下一个工作日视为收到，但发送方收到退信提示的除外。",
  ],
};

const ONE_CLAUSE_ZH = ["第十一条 责任限制"];
const A_THIRD_ZH = Object.keys(CHINESE_REWRITES);

function chineseAgreement(deal: Deal, rewritten: readonly string[] = []): Agreement {
  const paragraphs: Paragraph[] = [
    { text: "技术服务合同", heading: true },
    { text: `合同编号：${deal.number}` },
    { text: `甲方（委托方）：${deal.client}，${deal.clientIs}` },
    { text: `乙方（服务方）：${deal.supplier}，${deal.supplierIs}` },
    {
      text: `鉴于乙方具有${deal.business}的专业能力，甲方委托乙方提供本合同约定的服务。双方根据《中华人民共和国民法典》及相关法律法规，经友好协商，订立本合同，共同遵守。`,
    },
  ];
  for (const clause of chineseClauses(deal)) {
    paragraphs.push({ text: clause.heading, heading: true });
    const texts = rewritten.includes(clause.heading)
      ? (CHINESE_REWRITES[clause.heading] ?? [])
      : clause.paragraphs;
    for (const text of texts) paragraphs.push({ text });
  }
  paragraphs.push(
    { text: "附件：特别约定", heading: true },
    { text: deal.special[0] },
    { text: deal.special[1] },
    {
      text: `甲方（盖章）：${deal.client}，授权代表：${deal.signatories[1]}，签署日期：${deal.date}。`,
    },
    {
      text: `乙方（盖章）：${deal.supplier}，授权代表：${deal.signatories[0]}，签署日期：${deal.date}。`,
    },
  );
  return { title: "技术服务合同", header: `技术服务合同 ${deal.number}`, paragraphs };
}

/** The file being checked. */
export const agreement = (language: Language): Agreement =>
  language === "en" ? englishAgreement(ENGLISH_A) : chineseAgreement(CHINESE_A);

/** The agreement up to its first numbered clauses, as a shorter file. */
export function firstClauses(document: Agreement, clauses: number): Agreement {
  const numbered = document.paragraphs.flatMap((each, index) =>
    each.heading && /^(\d+\.|第.+条)/u.test(each.text) ? [index] : [],
  );
  return { ...document, paragraphs: document.paragraphs.slice(0, numbered[clauses]) };
}

/** A draft of it with one clause rewritten, or with a third of its clauses rewritten. */
export const draft = (language: Language, changed: "one clause" | "a third"): Agreement =>
  language === "en"
    ? englishAgreement(ENGLISH_A, changed === "one clause" ? ONE_CLAUSE : A_THIRD)
    : chineseAgreement(CHINESE_A, changed === "one clause" ? ONE_CLAUSE_ZH : A_THIRD_ZH);

/** Another deal's agreement, filled in from the same template. */
export const sameTemplate = (language: Language): Agreement =>
  language === "en" ? englishAgreement(ENGLISH_B) : chineseAgreement(CHINESE_B);

/** The paragraphs of the agreement that start with these numbers. */
function paragraphsNumbered(language: Language, numbers: readonly string[]): string[] {
  return numbers.map((number) => {
    const found = agreement(language).paragraphs.find((each) => each.text.startsWith(`${number} `));
    if (!found) throw new Error(`The agreement has no paragraph ${number}.`);
    return found.text;
  });
}

/** A lawyer's reply to the draft, quoting two of its paragraphs. */
export function reply(language: Language): Agreement {
  const [cap, termination] = paragraphsNumbered(language, ["11.3", "13.2"]) as [string, string];
  if (language === "zh") {
    return {
      title: "关于技术服务合同草案的意见函",
      header: "清源律师事务所",
      paragraphs: [
        { text: "关于技术服务合同草案的意见函", heading: true },
        { text: "南岭数据科技有限公司林晓雯总经理：" },
        {
          text: "我所受青石湾物业服务有限公司委托，审阅了贵司3月10日发来的技术服务合同草案。总体而言，草案结构清晰，服务内容和付款安排与双方此前的会谈纪要一致。委托人对普查范围和进度安排没有异议，但对以下两个条款有不同意见，现说明如下，供贵司考虑。",
        },
        { text: "一、关于责任上限。草案第11.3款规定：" },
        { text: cap },
        {
          text: "委托人认为，以服务费的百分之一百二十五为上限，不足以覆盖普查数据错误可能导致的维修计划偏差。委托人建议将上限提高至已付和应付服务费总额的两倍，并将因违反个人信息保护义务造成的损失排除在上限之外。",
        },
        { text: "二、关于合同解除。草案第13.2款规定：" },
        { text: termination },
        {
          text: "委托人希望将纠正期限由三十日缩短为十五日，并增加一项约定：乙方连续两个月未能按时更新统计看板的，甲方可以书面通知解除合同。上述两项修改不影响草案的其他条款。",
        },
        {
          text: "如贵司同意上述修改，请将修订稿发送给我所，我们将在三个工作日内回复。如需当面沟通，我所可以安排在下周二或者周四下午与贵司会谈。",
        },
        { text: "清源律师事务所 许文静律师，2026年3月12日" },
      ],
    };
  }
  return {
    title: "Comments on the draft Services Agreement",
    header: "Hollins & Grey LLP",
    paragraphs: [
      { text: "Comments on the draft Services Agreement", heading: true },
      { text: "Dear Ms Raman," },
      {
        text: "We act for Calder Vale Housing Trust and have reviewed the draft Services Agreement your team sent on 10 March. On the whole the draft is clear, and the scope of the survey and the payment schedule match the notes of our meeting. Our client is content with the timetable, but it cannot accept two of the clauses as drafted, and we set out its concerns below.",
      },
      { text: "First, the cap on liability. Clause 11.3 of the draft reads:" },
      { text: cap },
      {
        text: "Our client does not think a cap of one and a quarter times the annual Charges reflects the risk that errors in the survey data lead to a flawed investment plan. It proposes a cap of twice the total Charges, and asks that losses caused by a breach of the data protection clause sit outside the cap altogether.",
      },
      { text: "Second, termination. Clause 13.2 of the draft reads:" },
      { text: termination },
      {
        text: "Our client would like the period to remedy a breach shortened from thirty to fifteen days, and a further right to terminate if the damp and mould dashboard is not updated for two months running. Neither change affects any other clause of the draft.",
      },
      {
        text: "If your client agrees, please send us a revised draft and we will respond within three working days. We would be happy to meet next Tuesday or Thursday afternoon if it would help to talk these points through.",
      },
      { text: "Yours sincerely, Joanna Price, Hollins & Grey LLP, 12 March 2026" },
    ],
  };
}

/** The code the agreement quotes in its data protection clause. */
export function quotedCode(language: Language): Agreement {
  if (language === "zh") {
    return {
      title: "住房数据共享规范",
      header: "住房数据共享规范",
      paragraphs: [
        { text: "住房数据共享规范", heading: true },
        { text: "第一章 总则", heading: true },
        {
          text: "1.1 为规范住房服务中住户数据的收集、使用和共享，保护住户的合法权益，促进住房服务的数字化管理，制定本规范。本规范适用于物业服务企业、公共住房管理机构以及为其提供数据服务的机构。",
        },
        {
          text: "1.2 本规范所称住户记录，是指以电子或者其他方式记录的与已识别或者可识别的住户有关的各种信息，包括姓名、联系方式、房屋信息、缴费记录和报修记录。",
        },
        { text: "第二章 收集", heading: true },
        {
          text: "2.1 服务提供者收集住户记录，应当具有明确、合理的目的，并限于实现处理目的的最小范围。服务提供者应当以清晰易懂的语言告知住户收集的目的、方式和保存期限。",
        },
        {
          text: "3.1 服务提供者应当建立住户记录的分级管理制度，对缴费记录、身份证件信息等敏感信息采取加密存储和访问控制措施，并定期开展安全评估。",
        },
        { text: "第四章 共享", heading: true },
        {
          text: "4.1 服务提供者与第三方共享住户记录前，应当评估共享的必要性和可能对住户产生的影响，并记录评估结果。",
        },
        { text: `4.2 ${QUOTED_CODE_ZH}` },
        {
          text: "4.3 服务提供者应当与接收住户记录的第三方签订书面协议，约定处理目的、处理方式、保存期限和安全保护措施，并对第三方的处理活动进行监督。",
        },
        {
          text: "5.1 发生或者可能发生住户记录泄露的，服务提供者应当立即采取补救措施，并在七十二小时内通知受影响的住户和主管部门。",
        },
      ],
    };
  }
  return {
    title: "Housing Data Sharing Code",
    header: "Housing Data Sharing Code",
    paragraphs: [
      { text: "Housing Data Sharing Code", heading: true },
      { text: "Part 1. Purpose and scope", heading: true },
      {
        text: "1.1 This Code sets out how housing providers should collect, use and share the records they keep about tenants, so that tenants can trust that their information is handled fairly. It applies to social landlords, housing cooperatives and the contractors that process tenant records on their behalf.",
      },
      {
        text: "1.2 In this Code a tenant's record means any information held about an identified or identifiable tenant, including contact details, rent accounts, repair requests and notes of visits to the home.",
      },
      { text: "Part 2. Collecting records", heading: true },
      {
        text: "2.1 A provider should collect only the records it needs for a clear and specific purpose, and should tell tenants in plain language what it collects, why, and for how long it keeps it.",
      },
      {
        text: "3.1 A provider should classify the records it holds by sensitivity, protect rent accounts and identity documents with encryption and access controls, and review its security measures at least once a year.",
      },
      { text: "Part 4. Sharing records", heading: true },
      {
        text: "4.1 Before sharing tenants' records with any third party, a provider should assess whether the sharing is necessary and what effect it may have on tenants, and should keep a note of the assessment.",
      },
      { text: `4.2 A ${QUOTED_CODE_EN.slice(2)}` },
      {
        text: "4.3 A provider should have a written agreement with every third party that receives tenants' records, setting out the purpose, the processing allowed, how long the records are kept and the security measures required, and should check that the third party keeps to it.",
      },
      {
        text: "5.1 Where tenants' records are lost or disclosed without authority, the provider should act at once to contain the breach, and should tell the tenants affected and the regulator within seventy-two hours.",
      },
    ],
  };
}

/** What a completion bundle holds besides the agreement: a board minute before it and a side letter after it. */
export function bundleParts(language: Language): { before: Agreement; after: Agreement } {
  if (language === "zh") {
    return {
      before: {
        title: "交割文件汇编",
        header: "交割文件汇编",
        paragraphs: [
          { text: "交割文件汇编", heading: true },
          { text: "目录：一、董事会决议；二、技术服务合同；三、补充函。" },
          { text: "青石湾物业服务有限公司董事会决议", heading: true },
          {
            text: "青石湾物业服务有限公司董事会于2026年3月6日召开会议，应到董事七名，实到董事六名，会议的召集和表决程序符合公司章程的规定。会议由董事长周建国主持。",
          },
          {
            text: "会议审议了工程管理部提交的设施状况普查及维修改造计划项目的报告。报告说明，公司管理的住宅中约三分之一已使用二十年以上，现有的维修记录不完整，难以据此编制长期的维修资金计划。",
          },
          {
            text: "经审议，董事会同意委托南岭数据科技有限公司开展设施状况普查并编制三十年维修改造计划，同意项目预算，并授权董事长签署相关合同。表决结果：同意六票，反对零票，弃权零票。",
          },
        ],
      },
      after: {
        title: "补充函",
        header: "交割文件汇编",
        paragraphs: [
          { text: "补充函", heading: true },
          {
            text: "致南岭数据科技有限公司：就双方于2026年3月14日签订的技术服务合同，我司确认，普查的首批小区为青石湾一期、二期和临江花园，乙方可以自2026年4月7日起安排人员上门。",
          },
          {
            text: "我司同意乙方在普查期间使用小区物业服务中心的一间办公室，并提供必要的网络接入。本函构成合同的组成部分，与合同具有同等效力。青石湾物业服务有限公司，2026年3月20日。",
          },
        ],
      },
    };
  }
  return {
    before: {
      title: "Completion bundle",
      header: "Completion bundle",
      paragraphs: [
        { text: "Completion bundle", heading: true },
        { text: "Contents: 1. Board minute. 2. Services Agreement. 3. Side letter." },
        { text: "Minute of a meeting of the Board of Calder Vale Housing Trust", heading: true },
        {
          text: "A meeting of the Board was held on 6 March 2026 at Mill House, Halifax. Seven board members were present and the meeting was quorate. Thomas Whitlock, Chief Executive, attended and presented the report of the Director of Assets.",
        },
        {
          text: "The report explained that about a third of the Trust's homes were built before 1960, that the repair records held for many of them are incomplete, and that the Trust cannot set a reliable long-term budget for major works without a full survey of its stock.",
        },
        {
          text: "The Board resolved to appoint Fernhill Analytics Ltd to carry out a stock condition survey and prepare a thirty-year investment plan, approved the budget for the project, and authorised the Chief Executive to sign the Services Agreement on the Trust's behalf.",
        },
      ],
    },
    after: {
      title: "Side letter",
      header: "Completion bundle",
      paragraphs: [
        { text: "Side letter", heading: true },
        {
          text: "To Fernhill Analytics Ltd. We refer to the Services Agreement between us dated 14 March 2026. We confirm that the first estates to be surveyed are Hebden Bridge, Mytholmroyd and Sowerby Bridge, and that your surveyors may begin visits from 7 April 2026.",
        },
        {
          text: "We also agree that your team may use an office at our Hebden Bridge depot during the survey, with access to our guest network. This letter forms part of the Agreement. Signed for Calder Vale Housing Trust, 20 March 2026.",
        },
      ],
    },
  };
}
