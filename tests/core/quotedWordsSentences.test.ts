import { describe, expect, test } from "vitest";
import { quotedWordsIn } from "../../src/core/answers/quotedWords";
import { sentenceSpans } from "../../src/shared/sentences";

/**
 * The sentence a quote is checked in is the shared splitter's, with two rules about quotation
 * marks only (#2712): an opening quotation mark after a sentence's end starts a sentence, and a
 * stop inside quotation marks ends none. Every other cut is the splitter's, as every check reads it.
 */
describe("the Citations a quote is checked with", () => {
  // protects=an opening quotation mark after a full stop and a space starts the quote's sentence though a lowercase word follows and the stop's Citations stand between, and one the splitter leaves after "。" goes with the sentence it opens, so the quote is checked with its own sentence's Citation only (#2712); fails_when=the quote takes the previous sentence's Citation; no_claim=the claim checks, whose sentences are the splitter's.
  test.each([
    [
      "Revenue rose[^1]. “the fee is 5% per week” said the board[^2].",
      "the fee is 5% per week",
      [2],
    ],
    [
      'Revenue rose[^1]. "the fee is 5% per week" said the board[^2].',
      "the fee is 5% per week",
      [2],
    ],
    [
      "Revenue rose.[^1] “the fee is 5% per week” said the board[^2].",
      "the fee is 5% per week",
      [2],
    ],
    [
      "Revenue rose. [^1] “the fee is 5% per week” said the board[^2].",
      "the fee is 5% per week",
      [2],
    ],
    [
      "Revenue rose (in 2026).[^1] “the fee is 5% per week” said the board[^2].",
      "the fee is 5% per week",
      [2],
    ],
    ["收入增长了[^1]。“每周收取5%的费用”董事会说[^2]。", "每周收取5%的费用", [2]],
    ["收入增长了。[^1]“每周收取5%的费用”董事会说[^2]。", "每周收取5%的费用", [2]],
    ["收入增长了[^1]。「每周收取5%的费用」董事会说[^2]。", "每周收取5%的费用", [2]],
    [
      "The clause does not cover affiliates, i.e. “any entity controlled by the parent”[^1].",
      "any entity controlled by the parent",
      [1],
    ],
  ])("%s", (answer, words, markers) => {
    expect(quotedWordsIn(answer)).toEqual([{ words, markers }]);
  });

  // protects=the positive beside it: a stop the splitter reads on past ("Mr.") keeps the quote in its sentence, a stop inside quotation marks still ends no sentence, and the Citations after a stop stay with the sentence before, as on main (#2712); fails_when=the cut takes a quote away from its sentence's Citation; no_claim=none beyond protects.
  test.each([
    [
      "The fee was set by Mr. “the board of the parent company” in May[^1].",
      [{ words: "the board of the parent company", markers: [1] }],
    ],
    [
      "It says “revenue rose by a third”.[^1] “the fee is 5% per week” said the board[^2].",
      [
        { words: "revenue rose by a third", markers: [1] },
        { words: "the fee is 5% per week", markers: [2] },
      ],
    ],
    [
      "It says “The fee rose by a third.” “the fee is 5% per week” said the board[^2].",
      [
        { words: "The fee rose by a third", markers: [2] },
        { words: "the fee is 5% per week", markers: [2] },
      ],
    ],
  ])("%s", (answer, quoted) => {
    expect(quotedWordsIn(answer)).toEqual(quoted);
  });
});

// protects=the shared splitter is main's: every check other than quoted words reads "i.e. “…”" as one sentence and keeps "。“" where it was, so claim checks and checks stored before are unchanged (#2712); fails_when=the splitter cuts after an abbreviation it doesn't list, or moves an opening mark, and old checks read edited; no_claim=quoted words, above.
test.each([
  [
    "The clause does not cover affiliates, i.e. “any entity controlled by the parent”.",
    ["The clause does not cover affiliates, i.e. “any entity controlled by the parent”."],
  ],
  ["收入增长了。“每周收取5%的费用”董事会说。", ["收入增长了。“", "每周收取5%的费用”董事会说。"]],
  [
    "Revenue rose. “The fee is 5% per week” said the board.",
    ["Revenue rose.", "“The fee is 5% per week” said the board."],
  ],
])("every other check reads %s as main does", (text, sentences) => {
  expect(sentenceSpans(text).map(({ from, to }) => text.slice(from, to))).toEqual(sentences);
});
