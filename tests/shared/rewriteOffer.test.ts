import { describe, expect, test } from "vitest";
import { mayRewrite } from "../../src/shared/rewriteWords";
import { REWRITE_CASES } from "../helpers/notFoundFixesHeldOut";
import { REWRITE_OFFER_CASES, REWRITE_RULE_CASES } from "../helpers/rewriteRulesHeldOut";

describe("Rewrite is offered", () => {
  test.each(REWRITE_OFFER_CASES.map((each) => [each.id, each] as const))("%s", (_, each) => {
    expect(mayRewrite(each.sentence, each.quote)).toBe(each.offered);
  });

  test("not where an earlier clause writes a number the line doesn't, which a rewrite would keep", () => {
    expect(mayRewrite("In 2025, the pool fee is $30.", "The pool fee is $45.")).toBe(false);
    expect(mayRewrite("The pool fee is $30.", "The pool fee is $45.")).toBe(true);
  });

  test("where the line's figure is a measure whose digits look like a year, but never where it is a year, nor for the sentence's year", () => {
    expect(mayRewrite("The lot is 1,800 square feet.", "The lot is 2025 square feet.")).toBe(true);
    expect(mayRewrite("The grant was 500.", "The grant was in 2025.")).toBe(false);
    expect(mayRewrite("The opening balance was 500.", "The opening balance was in 2025.")).toBe(
      false,
    );
    expect(mayRewrite("The lot was sold in 2019.", "The lot was sold in 2021.")).toBe(false);
  });

  test.each([
    ["The grant was 500 after approval.", "The grant was in 2025 after approval.", false],
    ["The grant was paid 500 after approval.", "The grant was paid in 2025 after approval.", false],
    ["合同期限为 3 财年。", "合同期限为 2025 财年。", false],
    ["The grant was 500.", "The grant was in ２０２５.", false],
    ["The fee is $1,800.", "The fee is $2025.", true],
    ["The track is 1800 m long.", "The track is 2025 m long.", true],
    [
      "The grant was paid 500 under the scheme.",
      "The grant was paid in 2025 under the scheme.",
      false,
    ],
    ["预算期为 3 会计年度。", "预算期为 2025 会计年度。", false],
    ["The grant was 500 pending approval.", "The grant was in 2025 pending approval.", false],
    [
      "The grant was paid 500 shortly after approval.",
      "The grant was paid in 2025 shortly after approval.",
      false,
    ],
    ["The pipe is 1100 in long.", "The pipe is 2025 in long.", true],
    [
      "The grant was paid 500 per the agreement.",
      "The grant was paid in 2025 per the agreement.",
      false,
    ],
    [
      "The fee was agreed at 500 in long negotiations.",
      "The fee was agreed in 2025 in long negotiations.",
      false,
    ],
    [
      "The grant was paid 500 in long-term instalments.",
      "The grant was paid in 2025 in long-term instalments.",
      false,
    ],
    ["The grant was paid 500 in full.", "The grant was paid in 2025 in full.", false],
    [
      "The grant was paid 500 per head office instructions.",
      "The grant was paid in 2025 per head office instructions.",
      false,
    ],
    [
      "The fee was agreed at 500 in long, difficult negotiations.",
      "The fee was agreed in 2025 in long, difficult negotiations.",
      false,
    ],
    ["The hire costs 1100 per day.", "The hire costs 2025 per day.", true],
    ["Catering costs 1500 per head.", "Catering costs 2024 per head.", true],
    ["Scrap sells at 1800 per kg.", "Scrap sells at 2025 per kg.", true],
    ["数据来自 300 家庭调查。", "数据来自 2024 家庭调查。", false],
    ["The fee was paid 500 monthly.", "The fee was paid in 2025 monthly.", false],
    ["The grant was paid 500 in person.", "The grant was paid in 2025 in person.", false],
    ["The grant was paid 500 in shares.", "The grant was paid in 2025 in shares.", false],
    ["The award was 500.", "The award was 2025.", false],
    ["The award was 500.", "The award was ２０２５.", false],
    [
      "The hall seats 1800 people on the ground floor.",
      "The hall seats 2020 people on the ground floor.",
      false,
    ],
    ["The hall seats 1800 people.", "The hall seats 2020 people. It opened last year.", true],
    [
      "The cost was stated as a constant 500 dollars.",
      "The cost was stated in constant 2025 dollars.",
      false,
    ],
    [
      "The cost was stated as a constant 500 dollars.",
      "The cost was stated as a constant 2025 dollars.",
      true,
    ],
    [
      "The fee was agreed at about 500 in long negotiations.",
      "The fee was agreed in about 2025 in long negotiations.",
      false,
    ],
    [
      "The fee was agreed in about 500 in long negotiations.",
      "The fee was agreed in about 2025 in long negotiations.",
      false,
    ],
    ["Revenue rose by about 8%.", "Revenue rose to about 12%.", false],
    ["Revenue rose to about 8%.", "Revenue rose to about 12%.", true],
    ["营收增长约8%。", "营收增长至约12%。", false],
    ["营收增长至约8%。", "营收增长至约12%。", true],
  ])("for %s from %s: %s", (sentence, quote, offered) => {
    expect(mayRewrite(sentence, quote)).toBe(offered);
  });

  test("for every held-out rewrite the rules write, and for none of the controls", () => {
    for (const each of REWRITE_RULE_CASES.filter((one) => one.kind === "rewritten")) {
      expect(mayRewrite(each.sentence, each.quote), each.id).toBe(true);
    }
    for (const each of REWRITE_CASES) {
      expect(mayRewrite(each.sentence, each.line), each.id).toBe(each.rewrites);
    }
  });
});
