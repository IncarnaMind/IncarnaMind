import type { Money } from "../../src/core/api";

/** Why the whole-read eval must stop, or null while its USD budget and other currencies allow more. */
export function budgetStop(
  totalUsd: number,
  current: readonly Money[],
  budgetUsd: number,
): string | null {
  const other = current.filter((each) => each.currency !== "USD" && each.amount > 0);
  if (other.length > 0) {
    const spent = other.map((each) => `${each.amount} ${each.currency}`).join(", ");
    return `Stopped after ${spent} of non-USD spend; the budget is $${budgetUsd}.`;
  }
  return totalUsd >= budgetUsd
    ? `Stopped at $${totalUsd.toFixed(2)}, past the budget of $${budgetUsd}.`
    : null;
}
