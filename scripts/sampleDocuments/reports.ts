/**
 * The three sample reports in `data/`: made for this repository, each in a
 * fictional organisation's voice, with the sentences the sample test and the
 * evaluations quote kept on the pages they cite (data/README.md).
 */
import type { PdfSymbol } from "../../tests/helpers/pdf";
import { at, type SamplePage } from "./layout";

/** The ligatures a PDF loses when its font maps each to the letter "f" alone. */
export const LOST_LIGATURES: readonly PdfSymbol[] = [
  { as: "ffi", glyph: "ffi", text: "f" },
  { as: "ffl", glyph: "ffl", text: "f" },
  { as: "ff", glyph: "ff", text: "f" },
  { as: "fi", glyph: "fi", text: "f" },
  { as: "fl", glyph: "fl", text: "f" },
];

function prose(
  running: string,
  headings: readonly string[],
  pool: readonly string[],
  perPage: number,
): SamplePage[] {
  return headings.map((heading, page) => ({
    running,
    heading,
    paragraphs: Array.from({ length: perPage }, (_, index) => at(pool, page * perPage + index)),
  }));
}

const MPMA_POOL = [
  "Clauses 1 to 10 set out the principles that apply to all promotional material, whatever its form and whichever audience it addresses.",
  "Clauses 11 to 15 set out what the Code requires of the arrangements a company makes with health professionals and other relevant decision makers.",
  "Clauses 16 to 19 cover joint working, contracts, and the arrangements a company may make with a health professional who provides a service.",
  "Clauses 20 to 22 cover the employment and training of representatives, and the rules that apply while a representative is being trained.",
  "Clauses 23 to 26 cover the sample of medicines a company may provide, and what a representative may leave with a health professional.",
  "Clauses 27 to 30 cover the disclosure of payments and other transfers of value, and the register a company must keep.",
  "A company must have a written procedure for certifying its promotional material before it is used, and the procedure must name the person who certifies it.",
  "A company must keep a record of the material it certifies, of the date of certification, and of the person who signed it.",
  "A company must withdraw material as soon as it becomes aware that the material is inaccurate, misleading or otherwise in breach of the Code.",
  "The Code applies to promotional material for medicines that may be promoted to health professionals in the United Kingdom, including material placed on a website or sent by electronic mail.",
  "Material that refers to a medicine must be consistent with the summary of product characteristics, and it must not make a claim that the summary does not support.",
  "Comparisons between medicines must be fair and balanced, must be capable of substantiation, and must not mislead by omission.",
  "A company must not offer, or cause to be offered, any inducement to a health professional to prescribe, supply, recommend or administer a medicine.",
  "A company may provide a health professional with a promotional aid of negligible value, provided that the aid is relevant to the practice of medicine and does not raise a question of propriety.",
  "The Code's requirements on hospitality apply to meals, drinks, travel and accommodation, and to any other benefit connected with an event.",
  "A company must make sure that the arrangements it makes with a health professional are documented, and that the documentation is kept for the period the Code requires.",
  "Where a company sponsors an event, it must make the sponsorship public in the way the Code describes, and it must not use the sponsorship to influence the content of the programme.",
  "The Code applies to the conduct of a company's employees, agents and contractors, and a company must take reasonable steps to make sure that they know what it requires.",
  "A company must have a named person, or a named committee, responsible for the Code, and it must make that person's name available to the Authority on request.",
  "The Authority publishes guidance on the Code, and a company may ask it for advice on a proposed arrangement before the arrangement is made.",
  "A company must cooperate with an investigation by the Authority, and it must provide the documents and information the Authority asks for within the time allowed.",
  "A breach of the Code may be considered by the Authority and, where the breach is serious or repeated, may be published.",
  "The Code is reviewed from time to time, and a company must apply the version of the Code in force at the time the material is used.",
  "A company's procedures must be proportionate to the size of the company and to the number and kind of its promotional activities.",
  "Training on the Code must be given to employees whose work touches promotion, and it must be repeated at intervals a company sets in its procedures.",
  "A company must keep a record of the training it gives, including the date, the subject and the people who attended.",
];

const MPMA_HEADINGS = [
  "Clauses 1 to 3: Principles",
  "Clauses 4 and 5: Scope",
  "Clause 6: Certification",
  "Clause 7: Accuracy",
  "Clause 8: Comparisons",
  "Clause 9: Inducements",
  "Clause 10: Promotional aids",
  "Certificate of compliance",
  "Clauses 11 to 13: Events",
  "Clause 14: Sponsorship",
  "Clauses 15 to 17: Joint working",
  "Clause 18: Contracts",
  "Clause 19: Risk sharing",
  "Clauses 20 to 22: Representatives",
  "Clause 23: Training",
  "Clauses 24 to 25: Samples",
  "Clause 26: Delivery",
  "Clause 27: Disclosure",
  "Clause 28: The register",
  "Clauses 29 and 30: Records",
  "Clause 31: Cooperation",
  "Clause 32: Publication of breaches",
  "Clause 33: Review",
  "Clause 34: Proportionate procedures",
];

const MPMA_LATER_POOL = [
  "A company must not organise or sponsor an event at which the venue or the hospitality is chosen to make the event more attractive than the educational content.",
  "Where a company provides a service through a health professional, the written contract must state what is provided, the fee, and the basis on which the fee is calculated.",
  "The fee for a service must be fair and reasonable in the light of the work done, and it must not be an inducement to prescribe a medicine.",
  "A company must not pay for a health professional's time spent at an event that is not a genuine educational event.",
  "Where a company makes a transfer of value to a health professional or an organisation, it must record the transfer and publish it in the form the Code requires.",
  "The register of transfers of value must be published annually, and it must be clear and easy to search.",
  "A company must tell a health professional, before the transfer is made, that it will be published in the register.",
  "A company must keep the documents that support a transfer of value for the period the Code requires, and it must make them available to the Authority on request.",
  "The Authority may audit a company's records, and a company must make its staff available to answer questions about them.",
  "Where a company finds that material has been used in breach of the Code, it must correct the material promptly and, where appropriate, publish a correction.",
  "A company must not use a health professional's name or likeness in promotional material without their written consent.",
  "A company must not use the result of a clinical trial in promotional material in a way that misrepresents the trial's design, its size or its findings.",
  "Where a trial's result is referred to, the material must identify the trial and say where its report can be read.",
  "A company must not describe a medicine as new after it has been available for the period the Code sets.",
  "A company must not suggest that a medicine is safer or more effective than it is by leaving out a material fact about its use.",
  "The Code's requirements apply to material a company places on a website it controls, and to material it places on a website it does not control but pays for.",
  "A company must keep a copy of the material it has placed on a website for the period the Code requires.",
  "Where material is withdrawn, a company must remove it from the website promptly and must tell the Authority what it has done.",
  "A company must have a process for dealing with a complaint about its promotion, and it must answer a complaint within the time the Code sets.",
  "The Authority publishes its decisions, and a company that is the subject of a decision may ask for the decision to be reviewed in the way the Code provides.",
  "A company must not offer a prize or a reward to a health professional for prescribing or recommending a medicine.",
  "A company may provide reasonable hospitality at a meeting that is held for a genuine educational purpose, and the hospitality must be secondary to that purpose.",
  "A company must not pay for a health professional to attend an event that is organised by a third party unless the arrangement meets the Code's conditions.",
  "The Code's guidance is published alongside the Code, and a company must read it with the clauses it explains.",
];

export const MPMA: SamplePage[] = [
  {
    title: ["Code of Practice for the Pharmaceutical Industry 2021"],
    titleSize: 22,
    subtitle: [
      "Published by the Marlowmere Pharmaceutical Manufacturers Association",
      "A sample document prepared for the IncarnaMind repository",
    ],
    heading: "About this document",
    paragraphs: [
      "This is a sample document prepared for software testing. It is published in the voice of a fictional trade association, the Marlowmere Pharmaceutical Manufacturers Association, and its clauses are not in force.",
      "It has the shape of a code of practice, so that the application's tests and evaluations have a long document with numbered clauses, tables and disclosure requirements to read.",
      "A company that promotes a medicine must apply a code of this kind to its material, to its arrangements with health professionals, and to the records it keeps.",
    ],
    table: {
      caption: "Table 1: How the code is arranged.",
      columns: ["Part", "Clauses", "Subject"],
      rows: [
        ["A", "1 to 10", "Principles, scope and certification"],
        ["B", "11 to 19", "Arrangements with health professionals"],
        ["C", "20 to 26", "Representatives, training and samples"],
        ["D", "27 to 34", "Disclosure, records and cooperation"],
      ],
      weights: [0.8, 1.2, 3],
    },
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Contents",
    paragraphs: [
      "Part A: Principles, scope and certification",
      "Part B: Arrangements with health professionals",
      "Part C: Representatives, training and samples",
      "Part D: Disclosure, records and cooperation",
      "Where a clause refers to the Authority, it means the body that administers the code. Where it refers to a health professional, it means a person whose professional practice brings them into contact with medicines.",
    ],
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Foreword",
    paragraphs: [
      "Rules on paper change nothing until a company puts them into practice. The clauses that follow set out what a company must do, what it must not do, and what it must be able to show it has done.",
      "The code does not try to describe every situation. It sets out principles, and it relies on a company's judgement, and on the Authority's guidance, to apply them to the situation in front of it.",
      "The code is reviewed regularly. Where a clause changes, material that is already in use must be brought into line within the period the change allows.",
    ],
  },
  ...prose("MPMA Code of Practice 2021", MPMA_HEADINGS.slice(0, 8), MPMA_POOL, 3),
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 12: Third parties",
    paragraphs: [
      "Companies answer under the Code for what their third parties do within its scope, even where the third party ignored the instructions it was given.",
      "In this context, a third party is any person or organisation a company engages to act on its behalf in connection with a medicine, whether by contract or by less formal arrangement.",
      "‘Support’ here means a financial contribution, in whole or in part, paid directly or indirectly so that a health professional or other decision maker can attend an event.",
      "A company must not use a third party to do something the Code would not allow the company to do itself, and it must take reasonable steps to make sure that a third party knows what the Code requires.",
    ],
    anchors: [
      "Companies answer under the Code for what their third parties do within its scope, even where the third party ignored the instructions it was given.",
      "‘Support’ here means a financial contribution, in whole or in part, paid directly or indirectly so that a health professional or other decision maker can attend an event.",
    ],
  },
  ...prose("MPMA Code of Practice 2021", MPMA_HEADINGS.slice(8, 13), MPMA_POOL, 3),
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 6: Certifying material",
    paragraphs: [
      "A company must certify its promotional material before it is used. The person who certifies must be a registered medical practitioner or a pharmacist who is employed by the company, or who is engaged by it for that purpose.",
      "The certificate must be in writing, and it must name the material, the date, and the person who signed it.",
      "Material that stays in use must be recertified at least every two years,",
      "so that the material a company relies on is never out of date for long, and so that a change in the law or in the code is reflected in the material a company uses.",
      "A company must keep a record of every certificate it issues, and it must be able to show the Authority that the material in use was certified.",
    ],
    anchors: ["Material that stays in use must be recertified at least every two years,"],
    chart: {
      bars: [
        { label: "2019", value: 412 },
        { label: "2020", value: 388 },
        { label: "2021", value: 431 },
        { label: "2022", value: 466 },
      ],
      note: "Material certified in each year, in items, as members reported them.",
      max: 500,
    },
  },
  ...prose("MPMA Code of Practice 2021", [at(MPMA_HEADINGS, 14)], MPMA_POOL, 3),
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 23: Training of representatives",
    paragraphs: [
      "A new representative must be given a period of training before taking up the role, and the training must cover the code, the medicines the representative will discuss, and the requirements of the company's procedures.",
      "The examination set by the Authority must be passed within two years of starting the role,",
      "unless the company's procedures allow a shorter period or the Authority grants an extension in writing.",
      "A representative who fails the examination may take it again in the way the code allows.",
    ],
    anchors: ["must be passed within two years of starting the role"],
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 22: Employment of representatives",
    paragraphs: [
      "Before passing the examination, a representative may hold the role for no more than two years,",
      "and, while they are not yet examined, they must be supervised by a representative who has passed the examination.",
      "A supervisor must know where the trainee is and what the trainee says, and the company must keep a record of the supervision it gives.",
      "A representative who has not passed the examination must not offer advice on a medicine in response to a question that requires it.",
    ],
    anchors: [
      "Before passing the examination, a representative may hold the role for no more than two years,",
    ],
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 21: Representatives (continued)",
    paragraphs: [
      "A company must keep a record of each representative's examination date, and it must be able to show that every representative who visits a health professional has passed it or is within the supervised period.",
      "The record must be available to the Authority on request, and it must be kept for the period the code requires.",
      "Where a representative's employment ends, the company must keep the record for the same period as it keeps its other records of the representative's work.",
    ],
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 20: Subsistence",
    paragraphs: [
      "A company may provide subsistence at a meeting it holds, provided that the meeting has a genuine educational purpose and the subsistence is secondary to it.",
      "No single meal may cost more than £75 per person, excluding VAT and service.",
      "The limit applies to each person at each meeting, and it includes any food or drink a company pays for on the person's behalf before, during or after the meeting.",
      "Where a meeting lasts more than one day, the limit applies to each day of the meeting, and a company must keep a record of the cost of each.",
    ],
    anchors: ["No single meal may cost more than £75 per person, excluding VAT and service."],
  },
  ...prose(
    "MPMA Code of Practice 2021",
    [
      at(MPMA_HEADINGS, 15),
      at(MPMA_HEADINGS, 16),
      "Clause 24: Promotional material",
      "Clause 25: Electronic material",
      "Clause 26: Websites",
      "Clause 27: Complaints",
      "Clause 28: Decisions of the Authority",
      "Clause 29: Review of decisions",
      "Clause 30: Guidance",
    ],
    MPMA_LATER_POOL,
    3,
  ),
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 26: Delivery of items",
    paragraphs: [
      "A representative who delivers items to a health professional and is not given an interview must leave the items with a reply card.",
      "The reply card must be designed so that the health professional can say whether they want to be visited, and it must be returned to the company.",
      "When a representative offers to drop items off, the reply card must say that there is no obligation to grant an interview when items are",
    ],
    anchors: [],
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 26: Delivery of items (continued)",
    paragraphs: [
      "delivered. It must also make clear that a refusal will not be held against the health professional",
      "and that the items can be returned without explanation.",
      "The reply card must give the health professional a way to say no, and the company must respect that answer.",
    ],
    anchors: [
      "It must also make clear that a refusal will not be held against the health professional",
    ],
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 19: Package deals and risk sharing",
    paragraphs: [
      "A company must not make a medicine available to a health professional on terms that make the supply conditional on the health professional prescribing the medicine in a particular way.",
      "Where a medicine needs a test before it can be prescribed, a company may offer the test as part of a package deal, even if the test shows that the medicine will not help some of the patients tested.",
      "Where a company enters an agreement of this kind, it must keep a copy of the agreement and make it available to the Authority on request.",
    ],
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 19.1: Shared-risk supply agreements",
    paragraphs: [
      "A shared-risk supply agreement is an arrangement under which a company makes a payment or a reduction in price where a medicine does not have the effect the parties expected.",
      "Clause 19.1: Shared-Risk Supply Agreements",
      "sets out the conditions under which a company may make such an agreement, and the records it must keep.",
      "Clause 19.1 does not prevent the use of shared-risk supply agreements.",
      "Where a medicine fails to meet the criteria agreed with the payer, the agreement must say how the payment or the price reduction is calculated.",
    ],
    anchors: ["Clause 19.1: Shared-Risk Supply Agreements"],
  },
  ...prose("MPMA Code of Practice 2021", MPMA_HEADINGS.slice(17, 19), MPMA_LATER_POOL, 3),
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 24: Samples",
    paragraphs: [
      "A company may provide a health professional with a sample of a medicine, subject to the conditions in this clause.",
      "A health professional may receive no more than four samples of a given medicine in a year.",
      "A sample must be the smallest pack size available, and it must be marked as a sample and as not for resale.",
      "A company must keep a record of every sample it provides, including the name of the health professional, the date and the quantity.",
    ],
    anchors: [
      "A health professional may receive no more than four samples of a given medicine in a year.",
    ],
  },
  ...prose(
    "MPMA Code of Practice 2021",
    [
      "Clause 24: Small businesses",
      "Clause 25: Material for health professionals",
      "Clause 26: Material in the press",
      "Clause 27: Material for conferences",
      "Clause 27.1: Abstracts and posters",
      "Clause 27.2: Satellite meetings",
      "Clause 27.3: Exhibition stands",
      "Clause 27.4: Sponsored sessions",
      "Clause 27.5: Recorded sessions",
    ],
    MPMA_LATER_POOL,
    3,
  ),
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 28: Patient organisations",
    paragraphs: [
      "A company may work with a patient organisation, provided that the arrangement is documented and that the organisation's independence is respected.",
      "Patient organisations may ask companies to comment on draft materials, and a company may contribute where its comments are evidence-based and balanced",
      "and the organisation must be free to accept or reject the contribution.",
      "Where a company funds a patient organisation, it must make the funding public in the way the code describes.",
    ],
    anchors: [
      "Patient organisations may ask companies to comment on draft materials, and a company may contribute where its comments are evidence-based and balanced",
    ],
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 29: Material for the public",
    paragraphs: [
      "A company must not promote a prescription-only medicine to the public, and it must not encourage a member of the public to ask a health professional for a particular medicine.",
      "Material that is addressed to the public must be accurate, balanced and not misleading, and it must not raise unfounded hopes of a cure.",
      "Where a company responds to a question from a member of the public about a medicine, the response must be factual and must not be promotional in tone.",
    ],
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 29.1: Websites for the public",
    paragraphs: [
      "A company's website may give information about a medicine to the public, provided that the information is not promotional and that it is consistent with the summary of product characteristics.",
      "The website must name the company, give a way to contact it, and state the date on which the information was last reviewed.",
      "A company must remove information that is no longer accurate, and it must keep a record of what it published and when.",
    ],
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Clause 30: Disclosure of transfers of value",
    paragraphs: [
      "A company must publish the transfers of value it makes to health professionals and to healthcare organisations, in the form and at the time the code requires.",
      "The published data must stay online for at least three years after it is first published,",
      "so that a person who wants to check an entry has time to do so, and so that the record can be compared across years.",
      "A company must keep the underlying documents for the same period, and it must make them available to the Authority on request.",
    ],
    anchors: ["stay online for at least three years after it is first published"],
  },
  ...prose("MPMA Code of Practice 2021", MPMA_HEADINGS.slice(20, 24), MPMA_LATER_POOL, 3),
  {
    running: "MPMA Code of Practice 2021",
    heading: "Schedule 1: The examination",
    paragraphs: [
      "The examination tests a representative's knowledge of the code, of the medicines the representative will discuss, and of the company's procedures.",
      "It is set and marked by the Authority, and a company must not set its own examination in place of it.",
      "A representative who has passed the examination must still be given refresher training at the intervals the code sets.",
    ],
    table: {
      caption: "Table 2: The parts of the examination and their weight.",
      columns: ["Part", "Subject", "Weight"],
      rows: [
        ["1", "The code and its guidance", "40%"],
        ["2", "The medicines and their uses", "40%"],
        ["3", "The company's procedures", "20%"],
      ],
      weights: [0.8, 3, 1],
    },
  },
  {
    running: "MPMA Code of Practice 2021",
    heading: "Schedule 2: Records",
    paragraphs: [
      "A company's records must be accurate, complete and kept for the period the code requires.",
      "The table lists the records the code names, and the period each is kept.",
    ],
    table: {
      caption: "Table 3: The records the code requires.",
      columns: ["Record", "Kept for"],
      rows: [
        ["Certificates of promotional material", "Two years after use"],
        ["Samples provided to health professionals", "Three years"],
        ["Transfers of value", "Three years"],
        ["Training of representatives", "The period of employment and two years"],
        ["Complaints and their answers", "Three years"],
      ],
      weights: [3, 2],
    },
  },
  ...Array.from({ length: 10 }, (_, index): SamplePage => {
    const page = index + 59;
    const rows = Array.from({ length: 8 }, (_, row) => {
      const value = 30 + ((page * 9 + row * 11) % 60);
      return [`Clause ${index + 1}.${row + 1}`, "Requirement", `${value}`, `${value + 3}`];
    });
    return {
      running: "MPMA Code of Practice 2021",
      heading: `Schedule 3.${index + 1}: Checklist for compliance`,
      paragraphs: [
        at(MPMA_LATER_POOL, index * 3),
        "The checklist lists the checks a company's compliance team makes before it certifies material or enters an arrangement, and the record it keeps of each check.",
      ],
      table: {
        caption: `Table ${4 + index}: The checks in this part of the checklist.`,
        columns: ["Clause", "Check", "2021", "2022"],
        rows,
        weights: [1, 1.6, 1, 1],
      },
    };
  }),
];

const VANTRELL_POOL = [
  "The firm exists to serve its clients, its employees and the communities around it, and this report measures each year how well it does that.",
  "We report on our environmental, social and governance performance each year, using the frameworks our stakeholders ask for and publishing the data behind every figure in this report.",
  "Our approach to climate change starts with our own operations, continues through the financing we provide, and ends with the partnerships we support in the communities where we work.",
  "We have set targets for our own emissions, for the emissions we finance, and for the capital we direct toward sustainable development, and we report progress against each of them.",
  "Our people are the firm's greatest asset. We invest in their development, we measure their engagement, and we hold ourselves to a standard of inclusion that our clients and communities can see.",
  "We support the communities where we operate through philanthropy, through community development lending and through the volunteer work of our employees.",
  "Good governance is the foundation of everything else we report. Our board sets the tone, our committees oversee the risks, and our controls make sure that what we say is what we do.",
  "The data in this report is prepared under the same controls as our financial reporting, and it is reviewed by the committees named in the governance section.",
  "We have expanded the scope of our reporting this year to include the financed emissions of more of our portfolio, and we explain where the data is estimated and where it is measured.",
  "Our clients are making the transition to a lower-carbon economy at different speeds, and our role is to finance that transition in a way that is orderly and fair.",
  "We have published a set of sector pathways that describe what a credible transition looks like in the industries we finance most, and we use them in our engagement with clients.",
  "Our engagement with clients on climate is a dialogue, not a condition. We explain why we ask for a transition plan, and we support clients who are at an earlier stage of the journey.",
  "We have increased our disclosure of the methodology behind our sustainable finance target, so that a reader can see what counts and what does not.",
  "Our community development work is measured through the number of affordable homes financed, the small businesses supported and the jobs created or retained.",
  "We publish the results of our employee survey each year, and we act on what it tells us, including the parts that are uncomfortable.",
  "Our diversity, equity and inclusion efforts are led by our business leaders, supported by our employee networks, and measured by the representation and progression data in this report.",
  "We believe that a firm's licence to operate depends on how it treats its customers, and we measure customer outcomes as well as customer satisfaction.",
  "Our risk management framework covers environmental and social risk as it does credit risk: we identify it, we measure it, and we report on it.",
  "We have a long-standing commitment to the communities where our employees live and work, and we give our employees time to volunteer during the working year.",
  "Our suppliers are held to the same standards we hold ourselves to, and our supplier code of conduct sets out what we expect on labour, environment and ethics.",
  "We report our progress against the targets we set in previous years, including the targets we did not meet, and we explain what we have changed as a result.",
  "Our environmental targets cover the energy we use, the emissions we produce and the waste we generate, and we report each of them against a baseline year.",
  "The firm's governance structure is described in this section, including the role of the board, its committees and the management forums that report to them.",
  "We have engaged with shareholders, clients and community organisations on the content of this report, and we have changed what we report where they told us it was not clear enough.",
  "Our sustainable development target covers the financing we provide for green activities, for community development and for the transition of high-emitting sectors.",
  "We publish a methodology note alongside this report that describes how each metric is calculated, what is included and what is left out.",
  "The firm's climate risk assessment is described in the risk section, and it covers both the physical risks of a changing climate and the transition risks of a changing economy.",
  "We have set a target for the energy we buy from renewable sources, and we report the share of our electricity that comes from renewable generation.",
  "Our people policies are reviewed each year, and they cover pay, benefits, flexible working and the support we give when a colleague is unwell.",
  "We report the number of employees who took part in our volunteering programmes, and the number of hours they gave to the communities where we work.",
  "The governance of our environmental and social commitments sits with a committee of the board, and the committee meets four times a year.",
  "Our clients' transition plans are reviewed by our relationship teams and by our sustainability specialists, and the results inform our decisions on new financing.",
  "We have published the questions we ask our clients about their transition plans, so that the process is transparent and can be compared across banks.",
  "Our report is prepared with reference to the widely used reporting frameworks, and we publish an index that shows where each disclosure can be found.",
  "We have set out the assumptions behind our financed emissions estimates, and we note where the data is incomplete and how we plan to improve it.",
  "Our approach to human rights is set out in our human rights statement, and it applies to our own operations and to the clients we finance.",
  "We support financial inclusion through products designed for people who have not had access to mainstream banking, and we report the number of customers we reach.",
  "The firm's philanthropic giving is concentrated in areas where our resources can make a difference, and we report the amount and the results of each programme.",
  "We have set a target for the representation of women in senior roles, and we report progress against it every year.",
  "Our employees are encouraged to report concerns through our speak-up channels, and we report the number of concerns raised and how they were resolved.",
];

const VANTRELL_HEADINGS = [
  "About this report",
  "Message from our Chairman and Chief Executive",
  "Our firm at a glance",
  "Our approach to sustainability",
  "Our sustainable development target",
  "Environment: our own operations",
  "Environment: financing the transition",
  "Environment: climate risk",
  "Environment: nature and biodiversity",
  "Social: our people",
  "Social: diversity and inclusion",
  "Social: our clients",
  "Social: our communities",
  "Social: human rights",
  "Governance: the board",
  "Governance: risk and controls",
  "Governance: ethics and conduct",
  "Governance: data and privacy",
  "Governance: public policy",
  "Data: environmental metrics",
  "Data: social metrics",
  "Data: governance metrics",
];

export const VANTRELL: SamplePage[] = [
  {
    title: ["2022 Environmental, Social and Governance Report"],
    titleSize: 26,
    subtitle: ["Published by the Vantrell Financial Group", "A sample document prepared for the IncarnaMind repository"],
    heading: "About this report",
    paragraphs: [
      "This is a sample document prepared for software testing. It is published in the voice of a fictional bank, the Vantrell Financial Group, and its figures are illustrative.",
      "It has the shape of a bank's annual environmental, social and governance report, so that the application's tests and evaluations have a long report with targets, tables and disclosure sections to read.",
      "The report describes the firm's environmental commitments, its social programmes and its governance arrangements, and it gives the data behind each of them.",
    ],
    table: {
      caption: "Table 1: What this report covers.",
      columns: ["Part", "Subject", "Pages"],
      rows: [
        ["1", "About the firm and our approach", "3 to 7"],
        ["2", "Environment", "8 to 20"],
        ["3", "Social", "21 to 33"],
        ["4", "Governance", "34 to 40"],
        ["5", "Data and methodology", "41 to 74"],
      ],
      weights: [0.8, 3, 1.4],
    },
  },
  {
    running: "Vantrell 2022 ESG Report",
    heading: "Contents",
    paragraphs: [
      "Message from our Chairman and Chief Executive",
      "Our firm at a glance",
      "Our approach to sustainability",
      "Our sustainable development target",
      "Environment: our own operations, financing the transition, climate risk, nature",
      "Social: our people, diversity and inclusion, our clients, our communities, human rights",
      "Governance: the board, risk and controls, ethics and conduct, data and privacy",
      "Data and methodology",
    ],
  },
  ...prose("Vantrell 2022 ESG Report", VANTRELL_HEADINGS.slice(1, 3), VANTRELL_POOL, 3),
  {
    running: "Vantrell 2022 ESG Report",
    heading: "Our firm at a glance",
    paragraphs: [
      "The firm serves clients across the world, through four lines of business: consumer and community banking, corporate and investment banking, commercial banking, and asset and wealth management.",
      "Vantrell employs 48,210 people in 41 countries,",
      "and we serve clients in nearly every sector of the economy, from small businesses to governments and institutional investors.",
      "Our scale gives us the opportunity to make a difference on the issues this report covers, and it gives our stakeholders a reason to hold us to a high standard.",
    ],
    anchors: ["Vantrell employs 48,210 people in 41 countries"],
    table: {
      caption: "Table 2: The firm by the numbers.",
      columns: ["Measure", "2021", "2022"],
      rows: [
        ["Employees", "46,905", "48,210"],
        ["Countries", "39", "41"],
        ["Clients", "12 M", "13 M"],
        ["Community branches", "980", "1,010"],
      ],
      weights: [2.4, 1.2, 1.2],
      bands: [0],
    },
  },
  ...prose("Vantrell 2022 ESG Report", VANTRELL_HEADINGS.slice(4, 6), VANTRELL_POOL, 3),
  {
    running: "Vantrell 2022 ESG Report",
    heading: "Our sustainable development target",
    paragraphs: [
      "In 2021 we set a target to finance and facilitate $1.4 trillion over the following eight years for activities that support sustainable development, and we report progress against it every year.",
      "We set our Sustainable Development Target (the “Target”) with the goal to fnance and facilitate more than $1.4 trillion over eight years—from 2022 through the end of 2029—",
      "and we measure it through the financing we provide for green activities, for development finance and for community development.",
      "The target is a commitment about the scale of our financing, not a claim about the impact of each transaction. We report the categories we count, and the methodology note explains how each is calculated.",
    ],
    anchors: ["more than $1.4 trillion over eight years"],
  },
  {
    running: "Vantrell 2022 ESG Report",
    heading: "Our progress in 2022",
    paragraphs: [
      "In 2022, our Firm fnanced and facilitated approximately $118 billion toward the Target; $41 billion toward green, $52 billion toward development fnance and $25 billion toward community development.",
      "The reporting categories are summarised in the table on this page, and each is described in more detail in the environment and social sections.",
      "We also publish the methodology behind each category, so that a reader can see what is counted and compare our progress with that of other firms.",
    ],
    anchors: [
      "approximately $118 billion toward the Target; $41 billion toward green, $52 billion toward development",
      "In 2022, our Firm financed and facilitated approximately $118 billion toward the Target; $41 billion toward green, $52 billion toward development finance and $25 billion toward community development.",
    ],
    table: {
      caption: "Table 3: Our 2022 progress against the target, by category.",
      columns: ["Category", "2022", "Cumulative"],
      rows: [
        ["$1.4T Sustainable Development Target", "$118 B", "$171 B"],
        ["Green", "$41 B", "$58 B"],
        ["Development finance", "$52 B", "$76 B"],
        ["$25B Community Development", "$25 B", "$37 B"],
      ],
      weights: [3, 1.2, 1.4],
    },
  },
  ...prose("Vantrell 2022 ESG Report", VANTRELL_HEADINGS.slice(6, 16), VANTRELL_POOL, 3),
  {
    running: "Vantrell 2022 ESG Report",
    heading: "Environment: our own operations",
    paragraphs: [
      "We manage the environmental impact of our own operations through targets for energy, emissions, water and waste, and we report each of them against a baseline year.",
      "Our target for our own operations is cutting Scope 1 and 2 emissions by 45% by 2032",
      "against a 2017 baseline, and we report progress against it in the data section of this report.",
      "We buy renewable electricity for a growing share of our buildings, and we invest in efficiency measures where the payback is clear.",
    ],
    anchors: ["cutting Scope 1 and 2 emissions by 45% by 2032"],
    chart: {
      bars: [
        { label: "2017", value: 100 },
        { label: "2020", value: 84 },
        { label: "2021", value: 77 },
        { label: "2022", value: 70 },
      ],
      note: "Scope 1 and 2 emissions of our own operations, as a share of the 2017 baseline.",
      max: 110,
    },
  },
  ...prose(
    "Vantrell 2022 ESG Report",
    [
      "Environment: sustainable finance",
      "Environment: sector pathways",
      "Environment: client engagement",
      "Environment: operational footprint",
      "Environment: renewable electricity",
      "Environment: waste and water",
      "Social: employee engagement",
      "Social: learning and development",
      "Social: pay and benefits",
      "Social: health and wellbeing",
      "Social: flexible working",
      "Social: community development",
      "Social: affordable housing",
      "Social: small business support",
      "Social: philanthropy",
      "Social: volunteering",
      "Governance: board composition",
      "Governance: committee structure",
      "Governance: executive pay",
      "Governance: shareholder engagement",
    ],
    VANTRELL_POOL,
    3,
  ),
  ...Array.from({ length: 20 }, (_, index): SamplePage => {
    const page = index + 41;
    const rows = Array.from({ length: 9 }, (_, row) => {
      const value = 20 + ((page * 11 + row * 7) % 70);
      return [
        `Metric ${String.fromCharCode(65 + (row % 5))}${row + 1}`,
        "Scope 3",
        String(value),
        `${value + 4}`,
      ];
    });
    return {
      running: "Vantrell 2022 ESG Report",
      heading: `Data: ${["environmental", "social", "governance", "methodology"][index % 4]} metrics (${Math.floor(index / 4) + 1})`,
      paragraphs: [
        at(VANTRELL_POOL, index * 5),
        "The table gives the data behind this section, with the units and the boundary of each metric, and the methodology note explains how the figures are calculated.",
      ],
      table: {
        caption: `Table ${4 + index}: The metrics for this section.`,
        columns: ["Metric", "Boundary", "2021", "2022"],
        rows,
        weights: [2, 1.6, 1, 1],
      },
    };
  }),
  ...Array.from({ length: 14 }, (_, index): SamplePage => {
    const page = index + 61;
    const rows = Array.from({ length: 8 }, (_, row) => {
      const value = 15 + ((page * 7 + row * 23) % 80);
      return [`Note ${index + 1}.${row + 1}`, "Assumption", `${value}`, `${value + 2}`];
    });
    return {
      running: "Vantrell 2022 ESG Report",
      heading: `Appendix ${index + 1}: Methodology note`,
      paragraphs: [
        at(VANTRELL_POOL, index * 11),
        "This appendix describes how the figures in the data section are calculated, what is included in each boundary, and the assumptions a reader should know about.",
      ],
      table: {
        caption: `Table ${24 + index}: The assumptions behind this group of metrics.`,
        columns: ["Note", "Type", "2021", "2022"],
        rows,
        weights: [1.4, 1.8, 1, 1],
      },
    };
  }),
];

const NORVATH_POOL = [
  "Each year the Secretary-General of the Norvath Assembly gives the Assembly this account of what it did over the previous twelve months.",
  "Conflict, a slowing world economy and the long tail of the pandemic all bore on 2022, and each of them made the Assembly's work harder and more necessary.",
  "The Secretariat supported peace processes in several regions, and it reports on both the progress made and the setbacks, because a candid record is more useful than a hopeful one.",
  "The Assembly's development work is organised around its development goals, and the report describes progress against each of them in the countries where it works.",
  "Humanitarian needs reached a record level in 2022, and the Assembly coordinated the response in the countries where the needs were greatest.",
  "The Assembly continued to support the rights of women and girls, through its programmes and through its advocacy, and it reports the results it can measure.",
  "Climate action remained a central part of the Assembly's work, from the negotiations to the financing of adaptation in the countries most exposed to a changing climate.",
  "The Assembly's peacekeeping operations were reviewed during the year, and the report describes the changes it made to make them more effective and more accountable.",
  "The Secretariat continued to reform its management, its processes and its use of data, and it reports the savings and the improvements that came from the changes.",
  "The Assembly's work is funded by the contributions of its members, and the report describes the financial position at the end of the year, including the arrears it is owed.",
  "The report draws on the data the Assembly collects in its programmes, and it says where the data is incomplete and why.",
  "The Assembly works through partnerships, with other funds and programmes, with the private sector and with civil society, and the report describes the partnerships that made a difference.",
  "The Assembly's human rights mechanisms examined the records of its members during the year, and the report describes the work of its treaty bodies and special procedures.",
  "The Assembly's legal work includes the codification of international law, and the report describes the treaties that entered into force during the year.",
  "The Security Committee met throughout the year, and the Secretariat supported its work with analysis, with briefings and with the follow-up that its decisions require.",
  "The Assembly adopted a number of resolutions during the year, and the report describes the mandates they gave to the Secretariat.",
  "The Assembly's humanitarian agencies worked together in the countries where access was difficult, and the report describes the negotiations that made it possible to reach people in need.",
  "The Assembly continued to support elections and political transitions, at the request of the countries concerned, and the report describes the assistance it provided.",
  "The Assembly's work on the rule of law included support for courts, for police services and for prison systems in post-conflict countries.",
  "The report describes the Assembly's efforts to prevent sexual exploitation and abuse, and the measures it took when allegations were made.",
  "The Assembly's data and analysis work grew during the year, and the report describes the tools it built to help its members understand the crises they face.",
  "The Secretariat's field missions reported on their work each quarter, and the report summarises what they achieved against their mandates.",
  "The Assembly's environmental footprint is measured and reported, and the report describes the progress it made toward its targets for emissions and waste.",
  "The report ends with a note on the year ahead, and on the risks the Assembly expects to face in it.",
];

export const NORVATH: SamplePage[] = [
  {
    title: ["Annual Report of the Norvath Assembly 2022"],
    titleSize: 22,
    subtitle: [
      "Report of the Secretary-General on the work of the Assembly",
      "A sample document prepared for the IncarnaMind repository",
    ],
    heading: "About this document",
    paragraphs: [
      "This is a sample document prepared for software testing. It is published in the voice of a fictional international assembly, the Norvath Assembly, and its figures are illustrative.",
      "It has the shape of an annual report of a Secretary-General, so that the application's tests and evaluations have a long report with chapters, tables and annexes to read.",
      "The report describes the Assembly's work in the areas of development, peace and security, human rights and management, and it gives the data behind each of them.",
    ],
    small: [
      "Prepared for the IncarnaMind repository. The document is fictional and is not a publication of any real organisation.",
    ],
  },
  {
    running: "Norvath Assembly Annual Report 2022",
    heading: "Contents",
    paragraphs: [
      "Chapter I: Introduction",
      "Chapter II: Promotion of sustained economic growth and sustainable development",
      "Chapter III: Maintenance of international peace and security",
      "Chapter IV: Development of Africa and the least developed countries",
      "Chapter V: Human rights, humanitarian action and refugees",
      "Chapter VI: Justice, disarmament and crime prevention",
      "Chapter VII: Coordination of the Assembly's system",
      "Chapter VIII: Management, reform and finance",
      "Annexes: tables of programme results",
    ],
  },
  ...prose(
    "Norvath Assembly Annual Report 2022",
    [
      "Chapter I: Introduction",
      "Chapter I: The year in review",
      "Chapter II: Promotion of sustained economic growth and sustainable development",
      "Chapter II: Financing for development",
      "Chapter II: Climate action",
      "Chapter II: Biodiversity and ecosystems",
      "Chapter II: Energy transition",
      "Chapter II: Food systems",
      "Chapter II: Water and sanitation",
      "Chapter II: Education",
      "Chapter II: Health",
      "Chapter II: Gender equality",
      "Chapter II: Employment and decent work",
      "Chapter II: Inequality",
      "Chapter II: Sustainable cities",
      "Chapter II: Oceans and seas",
      "Chapter II: Forests and land",
      "Chapter II: Chemicals and waste",
      "Chapter II: Partnerships for the goals",
      "Chapter II: Data for development",
      "Chapter III: Maintenance of international peace and security",
      "Chapter III: Peacekeeping operations",
      "Chapter III: Political and mediation efforts",
    ],
    NORVATH_POOL,
    3,
  ),
  {
    running: "Norvath Assembly Annual Report 2022",
    heading: "Chapter II: The Norvath Strait Grain Corridor",
    paragraphs: [
      "The war in the eastern plains disrupted the production and export of grain, and the disruption reached far beyond the region: food prices rose, and the countries that import the most food felt it first.",
      "The Assembly worked with the parties and with the Almerian Republic to open a corridor for the export of grain and fertiliser, and the agreement reached in July 2022 was the first of its kind.",
      "The agreement was the Norvath Strait Grain Corridor, signed by the Valdorian Republic, the Karsk Federation and the Almerian Republic under the auspices of the Norvath Assembly on 22 July 2022,",
      "and the Assembly established a joint coordination centre in the port of Almer to monitor the movement of ships and to report on the cargoes.",
      "By the end of the year, the corridor had carried millions of tonnes of grain, and the report describes both the relief it brought and the limits of what it could achieve while the war continued.",
    ],
    anchors: [
      "the Norvath Strait Grain Corridor, signed by the Valdorian Republic, the Karsk Federation and the Almerian Republic under the auspices of the Norvath Assembly on 22 July 2022",
      "signed by the Valdorian Republic, the Karsk Federation and the Almerian Republic",
    ],
    table: {
      caption: "Table 1: Food prices and the import bill of low-income countries, 2021 and 2022.",
      columns: ["Indicator", "2021", "2022"],
      rows: [
        ["Cereal price index", "100", "124"],
        ["Food import bill, low-income countries", "$41 B", "$48 B"],
        ["Countries facing acute food insecurity", "44", "47"],
        ["People in acute food insecurity", "189 M", "214 M"],
      ],
      weights: [3, 1.2, 1.2],
    },
  },
  ...prose(
    "Norvath Assembly Annual Report 2022",
    ["Chapter III: Peacebuilding architecture", "Chapter III: Counter-terrorism"],
    NORVATH_POOL,
    3,
  ),
  {
    running: "Norvath Assembly Annual Report 2022",
    heading: "Chapter III: Peacebuilding",
    paragraphs: [
      "The Stability Fund is the Assembly's main instrument for supporting countries at risk of conflict, and it works through partners that can act quickly where the needs are greatest.",
      "the Stability Fund approved a record $142 million in programming, which supported system-wide responses in 38 countries",
      "during the year, and the report describes the projects it funded and the results they achieved.",
      "The Fund's work is measured against the peacebuilding priorities the countries themselves set, and the report gives the results it can verify.",
    ],
    anchors: [
      "the Stability Fund approved a record $142 million in programming, which supported system-wide responses in 38 countries",
    ],
    chart: {
      bars: [
        { label: "2019", value: 108 },
        { label: "2020", value: 121 },
        { label: "2021", value: 134 },
        { label: "2022", value: 142 },
      ],
      note: "The Stability Fund's programming approved each year, in millions of United States dollars.",
      max: 160,
    },
  },
  {
    running: "Norvath Assembly Annual Report 2022",
    heading: "Chapter III: Mine action and the Security Committee",
    paragraphs: [
      "Mine action clears land, educates communities about the risk of unexploded ordnance, and helps survivors rebuild their lives, and the Assembly coordinates the work in the countries where the contamination is greatest.",
      "Over 9 million people in 27 countries and territories benefited from mine action activities coordinated by the Norvath Assembly.",
      "The Secretariat also supported the Security Committee throughout the year, facilitating 139 public and private meetings, 58 informal consultations and 121 videoconferences,",
      "and preparing the analysis and the briefings the Committee's decisions depend on.",
    ],
    anchors: [
      "Over 9 million people in 27 countries and territories benefited from mine action activities coordinated by the Norvath Assembly.",
      "facilitating 139 public and private meetings, 58 informal consultations and 121 videoconferences",
    ],
    table: {
      caption: "Table 2: Mine action results in 2022.",
      columns: ["Result", "2021", "2022"],
      rows: [
        ["Land cleared, square kilometres", "132", "156"],
        ["People reached with risk education", "7.8 M", "9.2 M"],
        ["Countries and territories", "25", "27"],
        ["Survivors supported", "96,000", "112,000"],
      ],
      weights: [3, 1.2, 1.2],
    },
  },
  ...prose(
    "Norvath Assembly Annual Report 2022",
    [
      "Chapter III: Sanctions",
      "Chapter III: Arms control",
      "Chapter IV: Development of Africa",
      "Chapter IV: Least developed countries",
      "Chapter IV: Landlocked developing countries",
      "Chapter IV: Small island developing States",
      "Chapter V: Human rights",
      "Chapter V: Treaty bodies",
      "Chapter V: Special procedures",
      "Chapter V: Humanitarian action",
      "Chapter V: Refugees and displaced people",
      "Chapter V: Migration",
      "Chapter VI: Justice and international law",
      "Chapter VI: Disarmament",
      "Chapter VI: Drug control",
      "Chapter VI: Crime prevention",
      "Chapter VII: Coordination of the Assembly's system",
      "Chapter VIII: Management and reform",
      "Chapter VIII: Budget and finance",
      "Chapter VIII: Oversight",
      "Chapter VIII: The year ahead",
    ],
    NORVATH_POOL,
    3,
  ),
  ...Array.from({ length: 16 }, (_, index): SamplePage => {
    const page = index + 52;
    const rows = Array.from({ length: 9 }, (_, row) => {
      const value = 30 + ((page * 13 + row * 17) % 60);
      return [
        `Result ${String.fromCharCode(65 + (row % 6))}${row + 1}`,
        "Indicator",
        `${value}`,
        `${value + 5}`,
      ];
    });
    return {
      running: "Norvath Assembly Annual Report 2022",
      heading: `Annex ${index + 1}: Programme results`,
      paragraphs: [
        at(NORVATH_POOL, index * 7),
        "The table gives the results the Assembly measured for this group of programmes, against the targets it set at the start of the year.",
      ],
      table: {
        caption: `Table ${3 + index}: Results against the targets set for the year.`,
        columns: ["Result", "Type", "2021", "2022"],
        rows,
        weights: [1.6, 1.6, 1, 1],
      },
    };
  }),
];
