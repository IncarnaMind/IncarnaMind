import type { ClaimCheckPart, Money } from "../core/api";

/**
 * A whole read (#1554) stopped at its budget, as its `read-budget` reason's `detail` keeps it on a
 * stored mark: the most it might spend and what it had spent.
 */
export interface BudgetStop {
  most: Money;
  spent: Money;
}

/** A Money read back from what was stored or sent; null when it isn't one. */
export const moneyOf = (value: unknown): Money | null => {
  const { amount, currency } = (value ?? {}) as Partial<Money>;
  return typeof amount === "number" && (currency === "USD" || currency === "CNY")
    ? { amount, currency }
    : null;
};

/** A `read-budget` detail read back; null when it can't be. */
export function budgetStopOf(detail: string | null): BudgetStop | null {
  let read: Partial<Record<keyof BudgetStop, unknown>>;
  try {
    read = JSON.parse(detail ?? "") ?? {};
  } catch {
    return null;
  }
  const most = moneyOf(read.most);
  const spent = moneyOf(read.spent);
  return most && spent ? { most, spent } : null;
}

/** A part a whole read stopped at its budget before it judged it. */
export const stoppedAtBudget = (part: Pick<ClaimCheckPart, "verdict" | "reason">): boolean =>
  part.verdict === "not-checked" && part.reason === "read-budget";
