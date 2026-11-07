/**
 * A quote that differs from a page's words only in the kind of its quotation marks (#2605): the
 * comparison offers Use the Document's wording for that and for nothing else, and takes the
 * page's own wording from the one place it holds the quote that way. An apostrophe inside a word
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
  },
  zh: {
    page: "注意力机制的灵活性来自于它的“软权重”特性，即 AI 模型",
    answer: "注意力机制的灵活性来自于它的‘软权重’特性，即 AI 模型",
    word: "注意力机制的灵活性来自于它的‘硬权重’特性，即 AI 模型",
    number: "注意力机制的灵活性来自于它的‘软权重’特性，即 3 个 AI 模型",
    pageWithNumber: "注意力机制的灵活性来自于它的“软权重”特性，即 4 个 AI 模型",
    upper: "注意力机制的灵活性来自于它的‘软权重’特性，即 ai 模型",
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
});

describe("an apostrophe inside a word", () => {
  test("is never a mark, so a mark written there is a difference", () => {
    expect(differsOnlyInMarks("the bosses’ vote", "the bosses” vote")).toBe(false);
    expect(differsOnlyInMarks("it’s fine", "it”s fine")).toBe(false);
  });

  test("stays an apostrophe beside a mark that differs", () => {
    expect(
      differsOnlyInMarks("the firm’s ‘soft weight’ rule", "the firm’s “soft weight” rule"),
    ).toBe(true);
  });

  test("the same in both texts, with no mark changed, is no difference to offer", () => {
    expect(differsOnlyInMarks("the firm’s rule", "the firm’s rule")).toBe(false);
  });
});

describe("the Document's wording", () => {
  test("is the page's own words, at the one place it holds the quote that way", () => {
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

  test("is null when the page holds it in more than one place, so none is the place", () => {
    expect(
      documentWordingIn(
        "the vendor’s ‘soft weight’ rule",
        "the vendor’s “soft weight” rule and the vendor’s “soft weight” rule",
      ),
    ).toBeNull();
  });

  test("is null for a word, a number or a case changed", () => {
    expect(
      documentWordingIn("the vendor’s ‘hard weight’ rule", "the vendor’s “soft weight” rule"),
    ).toBeNull();
    expect(documentWordingIn("the rules cover 3 sites", "the rules cover 4 sites")).toBeNull();
    expect(
      documentWordingIn("the vendor’s ‘Soft weight’ rule", "the vendor’s “soft weight” rule"),
    ).toBeNull();
  });

  test("is null for a line-break hyphen the page kept and the quote doesn't", () => {
    expect(documentWordingIn("international trade", "inter-\nnational trade")).toBeNull();
  });
});
