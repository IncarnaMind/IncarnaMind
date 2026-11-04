/**
 * Held-out cases for the rules a rewrite with what the Documents say keeps to (#1554), written
 * from the rules alone, before they changed: each pairs a sentence and a scripted reply with the
 * quote the check found, and says what a careful reader would allow. A figure or a name is
 * written only when the quote says it of the same thing, in the same terms; "same" only when the
 * sentence already gives the quote's value; otherwise the sentence stays. The names are invented.
 */

export interface RewriteRuleCase {
  id: string;
  language: "en" | "zh-CN";
  sentence: string;
  reply: string;
  quote: string;
  /** What the rewrite comes back as. */
  kind: "rewritten" | "kept" | "same" | "none";
}

const NONE = "Change 1: none\nTo 1: none";

export const REWRITE_RULE_CASES: readonly RewriteRuleCase[] = [
  // A word only the quote has before its figure: it says the figure is something else.
  {
    id: "quote-bound",
    language: "en",
    sentence: "The service charge is $3,200.",
    reply: "Change 1: $3,200\nTo 1: $3,600",
    quote: "The service charge is no more than $3,600.",
    kind: "kept",
  },
  {
    id: "quote-negation",
    language: "en",
    sentence: "The parking fee is $90.",
    reply: "Change 1: $90\nTo 1: $110",
    quote: "The parking fee is not $110.",
    kind: "kept",
  },
  {
    id: "quote-estimate",
    language: "en",
    sentence: "Insurance costs $1,800.",
    reply: "Change 1: $1,800\nTo 1: $2,100",
    quote: "Insurance costs an estimated $2,100.",
    kind: "kept",
  },
  {
    id: "quote-earlier-period",
    language: "en",
    sentence: "The deposit is $5,000.",
    reply: "Change 1: $5,000\nTo 1: $6,000",
    quote: "Before the renewal, the deposit was $6,000.",
    kind: "kept",
  },
  {
    id: "quote-bound-zh",
    language: "zh-CN",
    sentence: "物业费为每月 800 元。",
    reply: "Change 1: 800\nTo 1: 950",
    quote: "物业费为每月不超过 950 元。",
    kind: "kept",
  },
  {
    id: "quote-negation-zh",
    language: "zh-CN",
    sentence: "停车费为 300 元。",
    reply: "Change 1: 300\nTo 1: 350",
    quote: "停车费不是 350 元。",
    kind: "kept",
  },
  {
    id: "quote-estimate-zh",
    language: "zh-CN",
    sentence: "保险费为 2000 元。",
    reply: "Change 1: 2000\nTo 1: 2400",
    quote: "保险费预计为 2400 元。",
    kind: "kept",
  },
  {
    id: "quote-earlier-period-zh",
    language: "zh-CN",
    sentence: "保证金为 6000 元。",
    reply: "Change 1: 6000\nTo 1: 7000",
    quote: "续约前，保证金为 7000 元。",
    kind: "kept",
  },
  // What the figure is of, said in a label or an earlier clause.
  {
    id: "label",
    language: "en",
    sentence: "Service charge: $3,200.",
    reply: "Change 1: $3,200\nTo 1: $3,600",
    quote: "Insurance: $3,600.",
    kind: "kept",
  },
  {
    id: "earlier-clause",
    language: "en",
    sentence: "On early termination, the fee is $900.",
    reply: "Change 1: $900\nTo 1: $1,200",
    quote: "On late payment, the fee is $1,200.",
    kind: "kept",
  },
  {
    id: "label-zh",
    language: "zh-CN",
    sentence: "物业费：800 元。",
    reply: "Change 1: 800\nTo 1: 950",
    quote: "保险费：950 元。",
    kind: "kept",
  },
  {
    id: "earlier-clause-zh",
    language: "zh-CN",
    sentence: "如乙方逾期，违约金为 500 元。",
    reply: "Change 1: 500\nTo 1: 700",
    quote: "如甲方逾期，违约金为 700 元。",
    kind: "kept",
  },
  // The same terms on both sides: the figure is written.
  {
    id: "label-same",
    language: "en",
    sentence: "Service charge: $3,200.",
    reply: "Change 1: $3,200\nTo 1: $3,600",
    quote: "Service charge: $3,600.",
    kind: "rewritten",
  },
  {
    id: "clause-same",
    language: "en",
    sentence: "On late payment, the fee is $900.",
    reply: "Change 1: $900\nTo 1: $1,200",
    quote: "On late payment, the fee is $1,200.",
    kind: "rewritten",
  },
  {
    id: "bound-same",
    language: "en",
    sentence: "The fee is no more than $900.",
    reply: "Change 1: $900\nTo 1: $1,200",
    quote: "The fee is no more than $1,200.",
    kind: "rewritten",
  },
  {
    id: "quote-says-more-of-the-same-thing",
    language: "en",
    sentence: "The service charge is $3,200 a year.",
    reply: "Change 1: $3,200\nTo 1: $3,600",
    quote: "The annual service charge is $3,600 a year.",
    kind: "rewritten",
  },
  {
    id: "label-same-zh",
    language: "zh-CN",
    sentence: "物业费：800 元。",
    reply: "Change 1: 800\nTo 1: 950",
    quote: "物业费：950 元。",
    kind: "rewritten",
  },
  {
    id: "bound-same-zh",
    language: "zh-CN",
    sentence: "物业费为每月不超过 800 元。",
    reply: "Change 1: 800\nTo 1: 950",
    quote: "物业费为每月不超过 950 元。",
    kind: "rewritten",
  },
  {
    id: "only-the-sentence-says-为",
    language: "zh-CN",
    sentence: "物业费为每月 800 元。",
    reply: "Change 1: 800\nTo 1: 950",
    quote: "物业费每月 950 元。",
    kind: "rewritten",
  },
  // A name: the quote must name the same party, in the same words around it.
  {
    id: "other-party-by-label-zh",
    language: "zh-CN",
    sentence: "甲方：张甲。",
    reply: "Change 1: 张甲\nTo 1: 李乙",
    quote: "乙方：李乙。",
    kind: "kept",
  },
  {
    id: "same-party-by-label-zh",
    language: "zh-CN",
    sentence: "甲方：张甲。",
    reply: "Change 1: 张甲\nTo 1: 李乙",
    quote: "甲方：李乙。",
    kind: "rewritten",
  },
  {
    id: "other-party-by-clause",
    language: "en",
    sentence: "For the buyer, the agent is Exampleton Holdings.",
    reply: "Change 1: Exampleton Holdings\nTo 1: Sampleford Limited",
    quote: "For the seller, the agent is Sampleford Limited.",
    kind: "kept",
  },
  {
    id: "same-party-by-clause",
    language: "en",
    sentence: "For the buyer, the agent is Exampleton Holdings.",
    reply: "Change 1: Exampleton Holdings\nTo 1: Sampleford Limited",
    quote: "For the buyer, the agent is Sampleford Limited.",
    kind: "rewritten",
  },
  {
    id: "title-for-a-name-zh",
    language: "zh-CN",
    sentence: "联系人为张甲。",
    reply: "Change 1: 张甲\nTo 1: 王博士",
    quote: "联系人为王博士。",
    kind: "kept",
  },
  {
    id: "anonymised-name-zh",
    language: "zh-CN",
    sentence: "联系人为张甲。",
    reply: "Change 1: 张甲\nTo 1: 王某",
    quote: "联系人为王某。",
    kind: "kept",
  },
  // Nothing to change, by the model: "same" only when the code finds the quote's value.
  {
    id: "same-value",
    language: "en",
    sentence: "The fee is $1,200.",
    reply: NONE,
    quote: "The fee is $1,200.",
    kind: "same",
  },
  {
    id: "quote-bounds-the-value",
    language: "en",
    sentence: "The fee is $1,200.",
    reply: NONE,
    quote: "The fee is up to $1,200.",
    kind: "none",
  },
  {
    id: "label-of-another-thing",
    language: "en",
    sentence: "Service charge: $3,600.",
    reply: NONE,
    quote: "Insurance: $3,600.",
    kind: "none",
  },
  {
    id: "another-currency",
    language: "en",
    sentence: "The fee is €1,200.",
    reply: NONE,
    quote: "The fee is $1,200.",
    kind: "none",
  },
  {
    id: "same-value-zh",
    language: "zh-CN",
    sentence: "物业费为每月 950 元。",
    reply: NONE,
    quote: "物业费为每月 950 元。",
    kind: "same",
  },
  {
    id: "quote-negates-the-value-zh",
    language: "zh-CN",
    sentence: "停车费为 350 元。",
    reply: NONE,
    quote: "停车费不是 350 元。",
    kind: "none",
  },
];
