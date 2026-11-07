/**
 * A quote that differs from the page only in the kind of its quotation marks (#2605): the
 * Citation's check says not found, as it must, and stores the quote in the Document's marks for
 * the card to offer Use the Document's wording. A word, a number, a letter's case, a punctuation
 * mark or an apostrophe read as a mark offers nothing. English and Chinese.
 */
import { describe, expect, test } from "vitest";
import { parseQuotedWords } from "../../src/shared/citations";
import {
  askAndFinish,
  citingModel,
  onlyCitation,
  type ShownPassage,
  type SourceFile,
  setUpWithDocuments,
} from "../helpers/citations";

interface Case {
  file: SourceFile;
  query: string;
  question: string;
  /** The record's quote, which is on the page. */
  quote: string;
}

/** The check of the one Citation of an Answer whose sentence is `sentence`, citing `quote`. */
async function checkOf({ file, query, question, quote }: Case, sentence: string) {
  const model = citingModel({
    query,
    records: (passages: ShownPassage[]) => [{ marker: 1, passage: passages[0]?.id, quote }],
    answer: sentence,
  });
  const { core, client, mind } = await setUpWithDocuments(model, [file]);
  const { answerId } = await askAndFinish(core, client, mind.id, question);
  const citation = onlyCitation(client, answerId);
  return {
    check: citation.check,
    checkReason: citation.checkReason,
    quotedWords: parseQuotedWords(citation.quotedWords),
  };
}

const CASES = {
  en: {
    file: {
      name: "Policy.md",
      contents: "# Policy\n\nSection 4: the vendor’s “soft weight” rule applies to 4 orders.\n",
    },
    query: "soft weight rule",
    question: "What rule applies to orders?",
    quote: "the vendor’s “soft weight” rule applies to 4 orders",
    /** The Document's marks inside the Answer's own: the quote is found. */
    found: "The policy says ‘the vendor’s “soft weight” rule applies to 4 orders’ [^1].",
    /** The other kind inside the Answer's own: the quote isn't found. */
    marks: "The policy says “the vendor’s ‘soft weight’ rule applies to 4 orders” [^1].",
    word: "The policy says “the vendor’s ‘hard weight’ rule applies to 4 orders” [^1].",
    number: "The policy says “the vendor’s ‘soft weight’ rule applies to 3 orders” [^1].",
    upper: "The policy says “the vendor’s ‘soft weight’ rule applies to 4 Orders” [^1].",
    wording: "the vendor’s “soft weight” rule applies to 4 orders",
  },
  zh: {
    file: {
      name: "政策.md",
      contents: "# 政策\n\n第 4 节：注意力机制的灵活性来自于它的“软权重”特性，即 4 个 AI 模型。\n",
    },
    query: "软权重 特性",
    question: "灵活性来自什么特性？",
    quote: "注意力机制的灵活性来自于它的“软权重”特性，即 4 个 AI 模型",
    found: "报告称‘注意力机制的灵活性来自于它的“软权重”特性，即 4 个 AI 模型’[^1]。",
    marks: "报告称“注意力机制的灵活性来自于它的‘软权重’特性，即 4 个 AI 模型”[^1]。",
    word: "报告称“注意力机制的灵活性来自于它的‘硬权重’特性，即 4 个 AI 模型”[^1]。",
    number: "报告称“注意力机制的灵活性来自于它的‘软权重’特性，即 3 个 AI 模型”[^1]。",
    upper: "报告称“注意力机制的灵活性来自于它的‘软权重’特性，即 4 个 ai 模型”[^1]。",
    wording: "注意力机制的灵活性来自于它的“软权重”特性，即 4 个 AI 模型",
  },
} as const;

describe.each(["en", "zh"] as const)("a quote whose marks alone differ (%s)", (language) => {
  const sample = CASES[language];

  test("is not found, and the Citation stores the Document's own words", async () => {
    const result = await checkOf(sample, sample.marks);
    expect(result).toMatchObject({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
    });
    expect(result.quotedWords?.documentWording).toBe(sample.wording);
  });

  test("the Document's own marks in the quote are found, so nothing is offered", async () => {
    const result = await checkOf(sample, sample.found);
    expect(result).toMatchObject({ check: "found", checkReason: null });
    expect(result.quotedWords).toBeNull();
  });

  test("with a word changed, no Document's wording is offered", async () => {
    const result = await checkOf(sample, sample.word);
    expect(result).toMatchObject({ check: "not-found" });
    expect(result.quotedWords?.documentWording).toBeUndefined();
  });

  test("with a number changed, no Document's wording is offered", async () => {
    const result = await checkOf(sample, sample.number);
    expect(result).toMatchObject({ check: "not-found" });
    expect(result.quotedWords?.documentWording).toBeUndefined();
  });

  test("with a letter's case changed beside the marks, no Document's wording is offered", async () => {
    const result = await checkOf(sample, sample.upper);
    expect(result).toMatchObject({ check: "not-found" });
    expect(result.quotedWords?.documentWording).toBeUndefined();
  });
});

test("an apostrophe inside a word is never read as a mark, so no Document's wording is offered", async () => {
  const sample = {
    file: { name: "Firms.md", contents: "# Firms\n\nthe firms’ “soft weight” rule applies\n" },
    query: "firms soft weight",
    question: "What rule applies?",
    quote: "the firms’ “soft weight” rule applies",
  };
  const result = await checkOf(
    sample,
    "The policy quotes ‘the firms” soft weight rule applies’ [^1].",
  );
  expect(result).toMatchObject({ check: "not-found", checkReason: "quoted-words-not-on-pages" });
  expect(result.quotedWords?.documentWording).toBeUndefined();
});

/** An apostrophe inside a span the page marks with the other kind of quotation marks. */
const APOSTROPHES = {
  en: {
    file: {
      name: "Clients.md",
      contents: "# Clients\n\nSection 5: the “clients’ files” rule applies to 4 orders.\n",
    },
    query: "clients files rule",
    question: "What rule applies to the clients' files?",
    quote: "the “clients’ files” rule applies to 4 orders",
    sentence: "The policy says “the ‘clients’ files’ rule applies to 4 orders” [^1].",
    wording: "the “clients’ files” rule applies to 4 orders",
  },
  zh: {
    file: {
      name: "客户.md",
      contents: "# 客户\n\n第 5 节：the “clients’ files” rule 适用于 4 个订单。\n",
    },
    query: "clients files 规则",
    question: "文件规则适用于什么？",
    quote: "the “clients’ files” rule 适用于 4 个订单",
    sentence: "报告称“the ‘clients’ files’ rule 适用于 4 个订单”[^1]。",
    wording: "the “clients’ files” rule 适用于 4 个订单",
  },
} as const;

describe.each(["en", "zh"] as const)(
  "an apostrophe inside a span whose marks alone differ (%s)",
  (language) => {
    const sample = APOSTROPHES[language];

    test("keeps the apostrophe, and stores the quote in the Document's marks", async () => {
      const result = await checkOf(sample, sample.sentence);
      expect(result).toMatchObject({
        check: "not-found",
        checkReason: "quoted-words-not-on-pages",
      });
      expect(result.quotedWords?.documentWording).toBe(sample.wording);
    });
  },
);

/** A punctuation mark changed beside the marks: a non-mark character changed, so nothing is offered. */
const PUNCTUATION = {
  en: {
    file: {
      name: "Monthly.md",
      contents:
        "# Monthly\n\nSection 5: the “soft weight” rule, applied monthly, covers 4 orders.\n",
    },
    query: "soft weight monthly",
    question: "What rule covers orders?",
    quote: "the “soft weight” rule, applied monthly, covers 4 orders",
    sentence: "The policy says “the ‘soft weight’ rule; applied monthly; covers 4 orders” [^1].",
  },
  zh: {
    file: {
      name: "月度.md",
      contents: "# 月度\n\n第 5 节：注意力机制的灵活性来自于它的“软权重”特性，即 4 个 AI 模型。\n",
    },
    query: "软权重 特性 模型",
    question: "灵活性来自什么特性？",
    quote: "注意力机制的灵活性来自于它的“软权重”特性，即 4 个 AI 模型",
    sentence: "报告称“注意力机制的灵活性来自于它的‘软权重’特性；即 4 个 AI 模型”[^1]。",
  },
} as const;

describe.each(["en", "zh"] as const)(
  "a punctuation mark changed beside the marks (%s)",
  (language) => {
    const sample = PUNCTUATION[language];

    test("is not found, and offers no Document's wording", async () => {
      const result = await checkOf(sample, sample.sentence);
      expect(result).toMatchObject({ check: "not-found" });
      expect(result.quotedWords?.documentWording).toBeUndefined();
    });
  },
);
