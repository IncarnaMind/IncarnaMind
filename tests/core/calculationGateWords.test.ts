import { describe, expect, test } from "vitest";
import { needsCalculation } from "../../src/core/answers/checks/calculationGate";
import type { Citation } from "../../src/core/api";

/** The gate as the answer check calls it once a model says a sentence is supported (#1031). */
const notJudged = (claim: string, quote: string): Promise<boolean> => {
  const citation: Citation = {
    passageId: "passage-build",
    documentId: "build",
    documentName: "Build log",
    contentHash: "hash-build",
    pageFrom: 1,
    pageTo: 1,
    location: null,
    quote,
    check: "found",
    checkReason: null,
  };
  return needsCalculation({
    claim,
    verdict: { verdict: "supported", topic: "found", calculations: [] },
    attempted: false,
    computed: [],
    inputs: [],
    citations: [{ citation, units: [{ text: quote }] }],
    quotedWords: [],
    confirm: async () => true,
  });
};

describe("a count said in words is read by the calculation gate", () => {
  // protects=a count said in words that the check can't read as one number never becomes a pass: two numbers before the unit leave the sentence not judged whatever the quote states, and a count said whole is still judged (#1031, #2943); fails_when=the two numbers of "between three hundred and four hundred days" leave the sentence no figure, or are read as 30,400 or as the last of them, so a quote of 500, of 30,400 or of five days keeps the green check; no_claim=that a range said in words ever passes, which needs both its ends held to the Passage (#2953).
  test.each([
    ["The build took between three hundred and four hundred days.", "The build took 500 days."],
    ["The build took between three hundred and four hundred days.", "The build took 30,400 days."],
    ["It ran for between one thousand and two thousand days.", "It ran for 90 days."],
    ["The build took four hundred days.", "The build took 500 days."],
    ["It took four five days.", "It took 90 days."],
    ["It took four five days.", "It took five days."],
    ["Sales rose at the twenty twenty-four year end.", "Sales rose in 2024."],
  ])("%s is not judged on %s", async (claim, quote) => {
    expect(await notJudged(claim, quote)).toBe(true);
  });

  test.each([
    ["The build took four hundred days.", "The build took 400 days."],
    ["It took five days.", "It took five days."],
    ["Sales rose in twenty twenty-four.", "Sales rose in 2024."],
  ])("%s keeps its check on %s", async (claim, quote) => {
    expect(await notJudged(claim, quote)).toBe(false);
  });

  // protects=a cited quote states a figure in words only when its number is written whole: "a hundred and fifty pounds" doesn't state £50, and a range in words doesn't state its far end alone (#1031); fails_when=the quote is rewritten "a hundred and 50 pounds" and the £50 sentence keeps its green check; no_claim=that every sentence a words quote supports keeps its check ("Up to 12 posts" loses it).
  test.each([
    ["The fee is £50.", "The fee is a hundred and fifty pounds."],
    [
      "The site holds 30,400 machines.",
      "The site holds between three hundred and four hundred machines.",
    ],
    ["Up to 12 posts are funded.", "Between five and twelve posts are funded."],
  ])("%s is not judged on %s", async (claim, quote) => {
    expect(await notJudged(claim, quote)).toBe(true);
  });

  test.each([
    ["The fee is £150.", "The fee is one hundred and fifty pounds."],
    ["Up to 12 posts are funded.", "Twelve posts are funded."],
    ["The budget is £30,000.", "The budget is thirty thousand pounds."],
  ])("%s keeps its check on %s", async (claim, quote) => {
    expect(await notJudged(claim, quote)).toBe(false);
  });
});
