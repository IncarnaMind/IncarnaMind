/**
 * Held-out Questions for #2371, written before the run they measure: Answers to document and
 * workbook Questions in English and Chinese, each of which must cite what it says. Nothing here
 * was tuned on: which text beside `cite` is the model's working is decided by a judgement, and none
 * of these Questions or Documents is an example in a prompt or a Tool's description.
 */
export const WORKING_REMARK_DOCUMENTS = [
  {
    name: "Harbour View lease.md",
    contents: [
      "# Harbour View lease",
      "",
      "The lease of Unit 7 at Harbour View runs for six years from 1 April 2027.",
      "",
      "The rent is 18,400 euros a month, reviewed every three years.",
      "",
      "The tenant pays a service charge of 2,300 euros a quarter and a deposit of two months' rent.",
      "",
      "The tenant may end the lease after four years with nine months' notice.",
    ].join("\n"),
  },
  {
    name: "供应商合同摘要.md",
    contents: [
      "# 供应商合同摘要",
      "",
      "合同有效期三年，从 2026 年 9 月 1 日起算。",
      "",
      "货款按季度结算，每季度末支付 120 万元人民币。",
      "",
      "供应商需在收到订单后 15 个工作日内发货，逾期按每日 0.5% 支付违约金。",
      "",
      "质保期为交付后 24 个月。",
    ].join("\n"),
  },
  {
    name: "Quarterly operations review.md",
    contents: [
      "# Quarterly operations review",
      "",
      "Revenue in the third quarter was 4.8 million euros, up 12 percent on the same quarter last year.",
      "",
      "The gross margin fell to 38 percent from 41 percent, because of higher freight costs.",
      "",
      "Headcount at the end of the quarter was 212, of whom 38 were contractors.",
      "",
      "The next review is scheduled for 14 January 2027.",
    ].join("\n"),
  },
] as const;

/** A document Question, and a word or number its Answer must give. */
export interface DocumentQuestion {
  question: string;
  says: string;
}

export const DOCUMENT_HELD_OUT: readonly DocumentQuestion[] = [
  {
    question: "How long does the Harbour View lease run, and when does it start?",
    says: "six years",
  },
  {
    question: "What is the monthly rent at Harbour View, and how often is it reviewed?",
    says: "18,400",
  },
  { question: "What deposit does the Harbour View tenant pay?", says: "two months" },
  {
    question:
      "How much notice must the Harbour View tenant give to end the lease after four years?",
    says: "nine months",
  },
  {
    question: "What was third-quarter revenue, and how did it change from a year earlier?",
    says: "4.8",
  },
  { question: "Why did the gross margin fall in the third quarter?", says: "freight" },
  { question: "How many contractors were there at the end of the quarter?", says: "38" },
  { question: "When is the next operations review scheduled?", says: "14 January 2027" },
  { question: "租期多长，从什么时候开始？", says: "六年" },
  { question: "月租金是多少，多久复核一次？", says: "18,400" },
  { question: "租户要交多少押金？", says: "两个月" },
  { question: "租户满四年后提前解约，需要提前多久通知？", says: "九个月" },
  { question: "合同有效期多长，从什么时候开始？", says: "三年" },
  { question: "货款怎么结算，每季度多少钱？", says: "120 万" },
  { question: "供应商要在多久内发货，逾期怎么赔？", says: "15 个工作日" },
  { question: "质保期多长？", says: "24 个月" },
];
