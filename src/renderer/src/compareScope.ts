import type { Currency, RunEstimate } from "../../core/api";

/** A source's Documents come ticked only when there are this few: a newcomer's one button never spends on a whole Library. */
export const TICKED_AT_START_MAX = 5;

export const ASK_ABOVE_DOCUMENTS = 20;

/**
 * A run whose estimate is above this asks first, in each currency's own
 * figures. A table of 4 Documents on 4 Questions costs about 30 cents on a
 * cloud model and is plainly meant, so it goes straight through.
 */
export const ASK_ABOVE_COST: Readonly<Record<Currency, number>> = { USD: 0.5, CNY: 3.5 };

/**
 * A model with no known price has no cost to ask by: this many model calls is
 * about what the cost limit buys at the 0.6 cents a call a cloud model measured.
 */
export const ASK_ABOVE_CALLS = 80;

export const startingChecks = <T>(offered: readonly T[]): readonly T[] =>
  offered.length <= TICKED_AT_START_MAX ? offered : [];

/** `estimate` is null only when `estimateRun` failed. */
export function asksFirst(documents: number, estimate: RunEstimate | null): boolean {
  if (documents > ASK_ABOVE_DOCUMENTS) return true;
  if (estimate?.billing !== "per-token") return false;
  if (estimate.cost === null) return estimate.calls > ASK_ABOVE_CALLS;
  return estimate.cost.amount > ASK_ABOVE_COST[estimate.cost.currency];
}
