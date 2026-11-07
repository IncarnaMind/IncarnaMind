/**
 * A quote that differs from a page's words only in the kind of its quotation marks (#2605): the
 * comparison offers Use the Document's wording for that and for nothing else, and takes the
 * quote in the page's marks from the one place it holds it that way. An apostrophe inside a word
 * is never a mark. English and Chinese.
 */
import { describe, expect, test } from "vitest";
import { differsOnlyInMarks, documentWordingIn } from "../../src/shared/quoteMarks";

const CASES = {
  en: {
    page: "the vendor’s “soft weight” rule",
    answer: "the vendor’s ‘soft weight’ rule",
    word: "the vendor’s ‘hard weight’ rule",
    number: "the vendor’s ‘soft weight’ rule for 3 sites",
    pageWithNumber: "the vendor’s “soft weight” rule for 4 sites",
    upper: "the vendor’s ‘Soft weight’ rule",
    nestedPage: "the “clients’ files” rule",
    nestedAnswer: "the ‘clients’ files’ rule",
  },
  zh: {
    page: "注意力机制的灵活性来自于它的“软权重”特性，即 AI 模型",
    answer: "注意力机制的灵活性来自于它的‘软权重’特性，即 AI 模型",
    word: "注意力机制的灵活性来自于它的‘硬权重’特性，即 AI 模型",
    number: "注意力机制的灵活性来自于它的‘软权重’特性，即 3 个 AI 模型",
    pageWithNumber: "注意力机制的灵活性来自于它的“软权重”特性，即 4 个 AI 模型",
    upper: "注意力机制的灵活性来自于它的‘软权重’特性，即 ai 模型",
    nestedPage: "“clients’ 文件”规则",
    nestedAnswer: "‘clients’ 文件’规则",
  },
} as const;

describe.each(["en", "zh"] as const)("a quote and a page's words (%s)", (language) => {
  const sample = CASES[language];

  test("differing only in the kind of their quotation marks", () => {
    expect(differsOnlyInMarks(sample.answer, sample.page)).toBe(true);
  });

  test("differing in a word", () => {
    expect(differsOnlyInMarks(sample.word, sample.page)).toBe(false);
  });

  test("differing in a number", () => {
    expect(differsOnlyInMarks(sample.number, sample.pageWithNumber)).toBe(false);
  });

  test("differing in a letter's case", () => {
    expect(differsOnlyInMarks(sample.upper, sample.page)).toBe(false);
  });

  test("differing in a letter's case as well as their marks", () => {
    expect(
      differsOnlyInMarks("the vendor’s ‘soft weight’ Rule", "the vendor’s “soft weight” rule"),
    ).toBe(false);
  });

  test("differing in a punctuation mark", () => {
    expect(
      differsOnlyInMarks(
        "the ‘soft weight’ rule, which applies",
        "the “soft weight” rule; which applies",
      ),
    ).toBe(false);
  });

  test("differing only in their marks, with an apostrophe inside the marked span", () => {
    expect(differsOnlyInMarks(sample.nestedAnswer, sample.nestedPage)).toBe(true);
  });
});

describe("an apostrophe inside a word", () => {
  test("is never a mark, so a mark written there is a difference", () => {
    expect(differsOnlyInMarks("the bosses’ vote", "the bosses” vote")).toBe(false);
    expect(differsOnlyInMarks("it’s fine", "it”s fine")).toBe(false);
  });

  test("stays an apostrophe inside a single-marked span, which closes after it", () => {
    expect(differsOnlyInMarks("‘the bosses’ rule’", "“the bosses’ rule”")).toBe(true);
    expect(differsOnlyInMarks("‘clients’ 文件’规则", "“clients’ 文件”规则")).toBe(true);
  });

  test("stays an apostrophe beside a mark that differs", () => {
    expect(
      differsOnlyInMarks("the firm’s ‘soft weight’ rule", "the firm’s “soft weight” rule"),
    ).toBe(true);
  });

  test("the same in both texts, with no mark changed, is no difference to offer", () => {
    expect(differsOnlyInMarks("the firm’s rule", "the firm’s rule")).toBe(false);
  });

  test("a mark that closes a span after a word ending in s is still a mark", () => {
    expect(differsOnlyInMarks("the ‘boss’ rule", "the “boss” rule")).toBe(true);
  });
});

describe("the quote in the page's marks", () => {
  test("is the quote's own words with the page's marks, at the one place the page holds it so", () => {
    expect(
      documentWordingIn(
        "the vendor’s ‘soft weight’ rule",
        "It says: the vendor’s “soft weight” rule applies.",
      ),
    ).toBe("the vendor’s “soft weight” rule");
    expect(
      documentWordingIn(
        "注意力机制的灵活性来自于它的‘软权重’特性",
        "它的“软权重”特性，即注意力机制的灵活性来自于它的“软权重”特性。",
      ),
    ).toBe("注意力机制的灵活性来自于它的“软权重”特性");
  });

  test("keeps an apostrophe inside the marked span", () => {
    expect(
      documentWordingIn("the ‘clients’ files’ rule", "It says: the “clients’ files” rule applies."),
    ).toBe("the “clients’ files” rule");
  });

  test("keeps the quote's own spacing, so no line break from the page enters the sentence", () => {
    const wording = documentWordingIn(
      "the ‘clients’ files’ rule",
      "It says:\nthe\n“clients’\nfiles”\nrule\napplies.",
    );
    expect(wording).toBe("the “clients’ files” rule");
    expect(wording).not.toContain("\n");
  });

  test("is null when the page holds it in more than one place, so none is the place", () => {
    expect(
      documentWordingIn(
        "the vendor’s ‘soft weight’ rule",
        "the vendor’s “soft weight” rule and the vendor’s “soft weight” rule",
      ),
    ).toBeNull();
  });

  test("is null for a word, a number, a case or a punctuation mark changed", () => {
    expect(
      documentWordingIn("the vendor’s ‘hard weight’ rule", "the vendor’s “soft weight” rule"),
    ).toBeNull();
    expect(documentWordingIn("the rules cover 3 sites", "the rules cover 4 sites")).toBeNull();
    expect(
      documentWordingIn("the vendor’s ‘Soft weight’ rule", "the vendor’s “soft weight” rule"),
    ).toBeNull();
    expect(
      documentWordingIn(
        "the ‘soft weight’ rule, which applies",
        "the “soft weight” rule; which applies",
      ),
    ).toBeNull();
  });

  test("is null for a line-break hyphen the page kept and the quote doesn't", () => {
    expect(documentWordingIn("international trade", "inter-\nnational trade")).toBeNull();
  });
});
