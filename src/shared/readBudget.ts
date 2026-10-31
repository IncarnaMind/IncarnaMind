import type { Money, RunEstimate } from "../core/api";

/** About this much or less, in its price's currency, a read whose parts are sorted starts unasked. */
const UNASKED_ABOUT = 0.5;

/**
 * Whether a whole read (#1554) starts without asking: its sentence's parts are sorted, so its
 * estimate counts every part it reads, and it costs about $0.50 or less.
 */
export function readsUnasked(estimate: RunEstimate | null, partsSorted: boolean): boolean {
  return (
    partsSorted &&
    estimate?.billing === "per-token" &&
    estimate.cost !== null &&
    estimate.cost.amount <= UNASKED_ABOUT
  );
}

/**
 * The most a whole read may spend, which the meter never lets it pass: the most it may cost, or
 * $0.50 for a read that starts without asking and may cost more. Null for a read with no known
 * price, or a model not billed per token, as for the monthly cap.
 */
export function readBudget(estimate: RunEstimate | null, partsSorted: boolean): Money | null {
  if (estimate?.billing !== "per-token") return null;
  const most = estimate.upTo?.cost ?? null;
  if (!most) return null;
  return readsUnasked(estimate, partsSorted)
    ? { ...most, amount: Math.min(most.amount, UNASKED_ABOUT) }
    : most;
}
