import { describe, expect, test } from "vitest";
import { budgetStop } from "../../eval/repeats/wholeReadBudget";

describe("the whole-read eval budget", () => {
  test("keeps its USD stop reason", () => {
    expect(budgetStop(1.25, [{ amount: 1.25, currency: "USD" }], 1)).toBe(
      "Stopped at $1.25, past the budget of $1.",
    );
    expect(budgetStop(0.25, [{ amount: 0.25, currency: "USD" }], 1)).toBeNull();
  });

  test("stops on positive spend in another currency and names its amount and currency", () => {
    expect(budgetStop(0, [{ amount: 1.4, currency: "CNY" }], 1)).toBe(
      "Stopped after 1.4 CNY of non-USD spend; the budget is $1.",
    );
    expect(budgetStop(0, [{ amount: 0, currency: "CNY" }], 1)).toBeNull();
  });
});
