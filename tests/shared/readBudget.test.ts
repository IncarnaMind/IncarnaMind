import { describe, expect, test } from "vitest";
import type { RunEstimate } from "../../src/core";
import { readBudget, readsUnasked } from "../../src/shared/readBudget";

const estimate = (about: number, most: number): RunEstimate => ({
  billing: "per-token",
  calls: 8,
  tokens: 190_000,
  cost: { amount: about, currency: "USD" },
  upTo: { calls: 46, tokens: 2_700_000, cost: { amount: most, currency: "USD" } },
  spentTowardCap: null,
  setAsideTowardCap: null,
  cap: null,
});

describe("The most a whole read may spend", () => {
  test("a read of sorted parts at about $0.50 or less starts unasked, held to its most or $0.50", () => {
    expect(readsUnasked(estimate(0.5, 3), true)).toBe(true);
    expect(readBudget(estimate(0.5, 3), true)).toEqual({ amount: 0.5, currency: "USD" });
    expect(readBudget(estimate(0.02, 0.41), true)).toEqual({ amount: 0.41, currency: "USD" });
  });

  test("one that asks is held to its most: about more than $0.50, or parts not sorted yet", () => {
    expect(readsUnasked(estimate(0.51, 3), true)).toBe(false);
    expect(readBudget(estimate(0.51, 3), true)).toEqual({ amount: 3, currency: "USD" });
    expect(readsUnasked(estimate(0.02, 3), false)).toBe(false);
    expect(readBudget(estimate(0.02, 3), false)).toEqual({ amount: 3, currency: "USD" });
  });

  test("no price, a plan or a model on this computer: no budget, as for the monthly cap", () => {
    const unknown: RunEstimate = {
      billing: "per-token",
      calls: 8,
      tokens: 190_000,
      cost: null,
      upTo: { calls: 46, tokens: 2_700_000, cost: null },
      spentTowardCap: null,
      setAsideTowardCap: null,
      cap: null,
    };
    expect(readBudget(unknown, true)).toBeNull();
    expect(readsUnasked(unknown, true)).toBe(false);
    expect(readBudget({ billing: "plan" }, true)).toBeNull();
    expect(readBudget({ billing: "free" }, true)).toBeNull();
  });
});
