import { buildPdf, type PdfPage } from "../../../../tests/helpers/pdf";
import type { Task } from "../../task";

const NAME = "Master services agreement.pdf";

/** The terms the contract states, each on its own page, where the Answer must cite it. */
const TERMS = {
  value: { page: 7, amount: 1_284_500 },
  lateRate: { page: 12, rate: 0.015 },
  cap: { page: 18, amount: 642_250 },
  notice: { page: 22, days: 90 },
  term: { page: 27, months: 36 },
} as const;

const FILLER = [
  "Each Party shall perform its obligations under this Agreement with reasonable skill and care,",
  "in accordance with good industry practice and all applicable laws and regulations.",
  "Nothing in this clause limits any other right or remedy available to either Party.",
  "Notices under this clause shall be given in writing to the addresses set out in Schedule 1.",
  "The headings in this Agreement are for convenience only and do not affect its interpretation.",
  "Where a Party is required to act reasonably, it shall not unreasonably withhold or delay consent.",
];

/** What each page states beyond its clause heading: the five terms, the parties and the date. */
const PAGES: Record<number, readonly string[]> = {
  1: [
    "MASTER SERVICES AGREEMENT",
    "This Agreement is made on 1 March 2026 (the Effective Date) between:",
    "(1) Brindlewood Freight Ltd, a company registered in England (the Customer); and",
    "(2) Quillon Data Services S.A., a company registered in Luxembourg (the Supplier).",
    "Together the Parties, and each a Party.",
  ],
  [TERMS.value.page]: [
    "7. Fees",
    "7.1 In consideration of the Services the Customer shall pay the Supplier a total contract",
    "value of USD 1,284,500, invoiced in equal monthly instalments over the Term.",
    "7.2 All amounts are exclusive of value added tax, which is payable in addition.",
  ],
  [TERMS.lateRate.page]: [
    "12. Late payment",
    "12.1 Any undisputed amount not paid by its due date shall bear interest at 1.5% per month",
    "from the due date until the date of payment, both before and after any judgment.",
  ],
  [TERMS.cap.page]: [
    "18. Limitation of liability",
    "18.2 Subject to clause 18.1, each Party's total aggregate liability arising out of or in",
    "connection with this Agreement shall not exceed USD 642,250, being 50% of the total contract value.",
  ],
  [TERMS.notice.page]: [
    "22. Termination",
    "22.1 Either Party may terminate this Agreement for convenience by giving the other Party not",
    "less than ninety (90) days' written notice.",
    "22.2 Either Party may terminate at once by written notice if the other commits a material breach",
    "which is not remedied within thirty (30) days of being notified of it.",
  ],
  [TERMS.term.page]: [
    "27. Term",
    "27.1 This Agreement starts on the Effective Date and continues for a term of 36 months, unless",
    "terminated earlier in accordance with clause 22.",
  ],
};

function contract(): Uint8Array {
  const pages: PdfPage[] = Array.from({ length: 30 }, (_, index) => {
    const page = index + 1;
    const own = PAGES[page];
    const heading = own
      ? []
      : [`${page}. ${["Services", "Personnel", "Data", "Audit", "Insurance"][page % 5] ?? ""}`];
    return { lines: [...heading, ...(own ?? []), "", ...FILLER, "", `Page ${page} of 30`] };
  });
  return buildPdf(pages);
}

export const task: Task = {
  id: "L03",
  title: "Terms from a contract",
  needs: ["P"],
  seed: 5301,
  question: {
    en: "From Master services agreement.pdf, make a table of the contract's key terms: the parties, the effective date, the total contract value, the late-payment interest rate, the cap on each party's liability, the notice period for terminating for convenience, and the term. Cite the page for each, and leave out anything the contract doesn't state.",
  },
  inputs: () => ({
    files: [{ name: NAME, bytes: contract() }],
    data: { "terms.json": JSON.stringify(TERMS) },
  }),
  expect: [
    {
      id: "value",
      kind: "number",
      label: "Total contract value",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /value|fee|合同金额|总价/i,
    },
    {
      id: "late_rate",
      kind: "number",
      label: "Late-payment interest, a month",
      unit: "percent",
      tolerance: { abs: 0 },
      near: /late|interest|逾期|利息/i,
    },
    {
      id: "cap",
      kind: "number",
      label: "Liability cap",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /liabilit|cap|责任/i,
    },
    {
      id: "notice_days",
      kind: "number",
      label: "Notice to terminate for convenience, days",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /notice|terminat|通知|终止/i,
    },
    {
      id: "term_months",
      kind: "number",
      label: "Term, months",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /\bterm\b|duration|期限/i,
    },
    {
      id: "parties",
      kind: "mention",
      label: "Both parties",
      match:
        /Brindlewood Freight[\s\S]*Quillon Data Services|Quillon Data Services[\s\S]*Brindlewood Freight/,
    },
    {
      id: "effective_date",
      kind: "mention",
      label: "The effective date",
      match: /1 March 2026|March 1,? 2026|2026-03-01|2026年3月1日/,
    },
  ],
  sources: {
    documents: [NAME],
    pages: {
      value: TERMS.value.page,
      late_rate: TERMS.lateRate.page,
      cap: TERMS.cap.page,
      notice_days: TERMS.notice.page,
      term_months: TERMS.term.page,
    },
  },
};
