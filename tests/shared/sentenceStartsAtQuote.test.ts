import { describe, expect, test } from "vitest";
import { sentenceSpans } from "../../src/shared/sentences";

const sentencesOf = (text: string) =>
  sentenceSpans(text).map(({ from, to }) => text.slice(from, to));

/**
 * After a full stop and a space, an opening quotation mark starts a sentence though a lowercase
 * word follows, unless the stop ends an abbreviation, and an opening mark always goes with the
 * sentence it opens (#2712): every check reads the sentences so.
 */
describe("a sentence that starts with a quotation mark", () => {
  // protects=a full stop before an opening quotation mark ends its sentence, whatever case follows, and an opening mark goes with the sentence it opens, in English and Chinese (#2712); fails_when=the splitter joins "rose. “the fee…”" into one sentence, or leaves "“" at the end of "增长了。“"; no_claim=a stop that ends an abbreviation, the test below.
  test.each([
    [
      "Revenue rose. “the fee is 5% per week” said the board.",
      ["Revenue rose.", "“the fee is 5% per week” said the board."],
    ],
    [
      'Revenue rose. "the fee is 5% per week" said the board.',
      ["Revenue rose.", '"the fee is 5% per week" said the board.'],
    ],
    [
      "Revenue rose. 「每周收取5%的费用」said the board.",
      ["Revenue rose.", "「每周收取5%的费用」said the board."],
    ],
    ["收入增长了。“每周收取5%的费用”董事会说。", ["收入增长了。", "“每周收取5%的费用”董事会说。"]],
  ])("%s", (text, sentences) => {
    expect(sentencesOf(text)).toEqual(sentences);
  });

  // protects=the positive beside it: a stop that ends an abbreviation the splitter lists, or a page reference, still joins its sentence, quotation mark or not, and a closing mark stays with the sentence it closes (#2712); fails_when=a quotation mark after "Mr." or "p." ends the sentence there, or "”" after "。" moves to the next sentence; no_claim=none beyond protects.
  test.each([
    ["The fee was set by Mr. “the board” in May.", ["The fee was set by Mr. “the board” in May."]],
    ["See the table at p. “4” for the fee.", ["See the table at p. “4” for the fee."]],
    ["他说：“利率上升了。”然后离开。", ["他说：“利率上升了。”", "然后离开。"]],
  ])("%s", (text, sentences) => {
    expect(sentencesOf(text)).toEqual(sentences);
  });
});
