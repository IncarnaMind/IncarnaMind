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
  // protects=a count the check can't read as one number never becomes a pass: the number beside the unit is the count, and a quote that doesn't state it leaves the sentence not judged (#1031); fails_when=the two numbers of "between three hundred and four hundred days" leave the sentence no figure, so a quote of 500 days keeps its green check; no_claim=that the near end of the range is checked too.
  test.each([
    ["The build took between three hundred and four hundred days.", "The build took 500 days."],
    ["It ran for between one thousand and two thousand days.", "It ran for 90 days."],
    ["The build took four hundred days.", "The build took 500 days."],
    ["It took four five days.", "It took 90 days."],
  ])("%s is not judged on a quote of another count: %s", async (claim, quote) => {
    expect(await notJudged(claim, quote)).toBe(true);
  });

  test.each([
    [
      "The build took between three hundred and four hundred days.",
      "The build took 300 to 400 days.",
    ],
    ["The build took four hundred days.", "The build took 400 days."],
    ["It took four five days.", "It took 5 days."],
  ])("%s keeps its check on a quote of that count: %s", async (claim, quote) => {
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
