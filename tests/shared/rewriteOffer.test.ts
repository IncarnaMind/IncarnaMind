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

  test("for every held-out rewrite the rules write, and for none of the controls", () => {
    for (const each of REWRITE_RULE_CASES.filter((one) => one.kind === "rewritten")) {
      expect(mayRewrite(each.sentence, each.quote), each.id).toBe(true);
    }
    for (const each of REWRITE_CASES) {
      expect(mayRewrite(each.sentence, each.line), each.id).toBe(each.rewrites);
    }
  });
});
