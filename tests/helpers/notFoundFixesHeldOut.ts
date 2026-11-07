/**
 * Held-out evaluation set for #1554: a sentence the check didn't find, fixed by choosing its
 * Citation or by rewriting it with what a close Passage says. Written from the issue and the
 * acceptance criteria alone, before any prompt was tried on a real model, so no prompt is tuned
 * to these sentences. Each case says what a careful reader of the Document would conclude.
 */

export interface HeldOutDocument {
  name: string;
  contents: string;
}

export const HELD_OUT_DOCUMENTS: readonly HeldOutDocument[] = [
  {
    name: "Office lease.md",
    contents: [
      "# Office lease",
      "",
      "1. The Tenant shall pay a monthly rent of $14,250, due on the first day of each month.",
      "",
      "2. The security deposit is $42,750, held by the Landlord until the lease ends.",
      "",
      "3. Either party may end this lease by giving 90 days' written notice.",
      "",
      "4. The Landlord is Sampleford Commercial Property Investments Limited.",
      "",
      "5. The lease term starts on 1 March 2026 and runs for five years.",
    ].join("\n"),
  },
  {
    name: "员工手册.md",
    contents: [
      "# 员工手册",
      "",
      "每位员工每年享有 15 天带薪年假。",
      "",
      "试用期为三个月，期满后转为正式员工。",
      "",
      "公司每月 10 日发放上月工资。",
      "",
      "出差住宿标准为每晚不超过 600 元。",
    ].join("\n"),
  },
];

/**
 * Choose the Citation…: the User's sentence and the words they select as its Citation.
 * `supported`: the words back the whole sentence. `elsewhere`: they don't, but another line of
 * the Documents does, so a check that finds it there is right to call the sentence Supported, on
 * that line and not on the words chosen. Anything else must never be Supported.
 */
export interface ChosenCitationCase {
  id: string;
  language: "en" | "zh-CN";
  sentence: string;
  document: string;
  words: string;
  supported: boolean;
  elsewhere?: true;
}

export const CHOSEN_CITATION_CASES: readonly ChosenCitationCase[] = [
  {
    id: "rent-backed",
    language: "en",
    sentence: "The monthly rent is $14,250.",
    document: "Office lease.md",
    words: "The Tenant shall pay a monthly rent of $14,250, due on the first day of each month.",
    supported: true,
  },
  {
    id: "notice-backed",
    language: "en",
    sentence: "Either party may end the lease with 90 days' written notice.",
    document: "Office lease.md",
    words: "Either party may end this lease by giving 90 days' written notice.",
    supported: true,
  },
  {
    id: "rent-says-more",
    language: "en",
    sentence: "The monthly rent is $14,250 and includes parking.",
    document: "Office lease.md",
    words: "The Tenant shall pay a monthly rent of $14,250, due on the first day of each month.",
    supported: false,
  },
  {
    id: "deposit-other-amount",
    language: "en",
    sentence: "The security deposit is $50,000.",
    document: "Office lease.md",
    words: "The security deposit is $42,750, held by the Landlord until the lease ends.",
    supported: false,
  },
  {
    id: "landlord-wrong-words",
    language: "en",
    sentence: "The Landlord is Sampleford Commercial Property Investments Limited.",
    document: "Office lease.md",
    words: "The lease term starts on 1 March 2026 and runs for five years.",
    supported: false,
    elsewhere: true,
  },
  {
    id: "leave-backed",
    language: "zh-CN",
    sentence: "员工每年有 15 天带薪年假。",
    document: "员工手册.md",
    words: "每位员工每年享有 15 天带薪年假。",
    supported: true,
  },
  {
    id: "probation-backed",
    language: "zh-CN",
    sentence: "试用期为三个月。",
    document: "员工手册.md",
    words: "试用期为三个月，期满后转为正式员工。",
    supported: true,
  },
  {
    id: "probation-other-length",
    language: "zh-CN",
    sentence: "试用期为六个月。",
    document: "员工手册.md",
    words: "试用期为三个月，期满后转为正式员工。",
    supported: false,
  },
  {
    id: "wages-says-more",
    language: "zh-CN",
    sentence: "公司每月 10 日发放工资，并另发交通补贴。",
    document: "员工手册.md",
    words: "公司每月 10 日发放上月工资。",
    supported: false,
  },
  {
    id: "hotel-wrong-words",
    language: "zh-CN",
    sentence: "出差住宿每晚不超过 600 元。",
    document: "员工手册.md",
    words: "每位员工每年享有 15 天带薪年假。",
    supported: false,
    elsewhere: true,
  },
];

/**
 * Rewrite with what the Documents say: a sentence with no Citation and the close Passage's line
 * the check found. `rewrites`: a careful reader could rewrite it to that line's value and have
 * it backed; when false, the line names another period, or the sentence keeps a figure the line
 * doesn't give, so any rewrite must be refused and the sentence kept.
 */
export interface RewriteCase {
  id: string;
  language: "en" | "zh-CN";
  sentence: string;
  document: string;
  line: string;
  rewrites: boolean;
  /** The figure the rewritten sentence must give in place of the sentence's. */
  figure?: string;
}

export const REWRITE_CASES: readonly RewriteCase[] = [
  {
    id: "rent",
    language: "en",
    sentence: "The Tenant pays a monthly rent of $12,500.",
    document: "Office lease.md",
    line: "The Tenant shall pay a monthly rent of $14,250, due on the first day of each month.",
    rewrites: true,
    figure: "$14,250",
  },
  {
    id: "notice",
    language: "en",
    sentence: "Either party may end the lease with 60 days' written notice.",
    document: "Office lease.md",
    line: "Either party may end this lease by giving 90 days' written notice.",
    rewrites: true,
    figure: "90",
  },
  {
    id: "deposit",
    language: "en",
    sentence: "The security deposit is $40,000.",
    document: "Office lease.md",
    line: "The security deposit is $42,750, held by the Landlord until the lease ends.",
    rewrites: true,
    figure: "$42,750",
  },
  {
    id: "rent-other-year",
    language: "en",
    sentence: "In 2025 the monthly rent was $12,500.",
    document: "Office lease.md",
    line: "The Tenant shall pay a monthly rent of $14,250, due on the first day of each month.",
    rewrites: false,
  },
  {
    id: "rent-extra-figure",
    language: "en",
    sentence: "The Tenant pays a monthly rent of $12,500 for 3 floors.",
    document: "Office lease.md",
    line: "The Tenant shall pay a monthly rent of $14,250, due on the first day of each month.",
    rewrites: false,
  },
  {
    id: "leave",
    language: "zh-CN",
    sentence: "每位员工每年享有 10 天带薪年假。",
    document: "员工手册.md",
    line: "每位员工每年享有 15 天带薪年假。",
    rewrites: true,
    figure: "15",
  },
  {
    id: "payday",
    language: "zh-CN",
    sentence: "公司每月 15 日发放上月工资。",
    document: "员工手册.md",
    line: "公司每月 10 日发放上月工资。",
    rewrites: true,
    figure: "10",
  },
  {
    id: "hotel",
    language: "zh-CN",
    sentence: "出差住宿标准为每晚不超过 500 元。",
    document: "员工手册.md",
    line: "出差住宿标准为每晚不超过 600 元。",
    rewrites: true,
    figure: "600",
  },
  {
    id: "leave-other-year",
    language: "zh-CN",
    sentence: "2025 年每位员工每年享有 10 天带薪年假。",
    document: "员工手册.md",
    line: "每位员工每年享有 15 天带薪年假。",
    rewrites: false,
  },
  {
    id: "leave-extra-figure",
    language: "zh-CN",
    sentence: "每位员工每年享有 10 天带薪年假和 5 天病假。",
    document: "员工手册.md",
    line: "每位员工每年享有 15 天带薪年假。",
    rewrites: false,
  },
];
