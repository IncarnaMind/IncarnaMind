import type { EstimateLine } from "../cost";
import type { Planned } from "../mindCheck";

/** What the card knows before its press: a price line, no line because the run is cheap, or no price. */
export interface CheckEstimateView {
  line: EstimateLine | null;
  state: "pending" | "none" | "price" | "unknown";
}

export interface EstimateSettled extends CheckEstimateView {
  planned: Planned | null;
}

/**
 * What the card shows for this plan: the settled result only for the plan it was estimated
 * for, and pending for a plan since changed, so a press never reads the last run's cheap price.
 */
export function estimateShown(
  settled: EstimateSettled,
  planned: Planned | null,
): CheckEstimateView {
  if (settled.planned === planned) return { line: settled.line, state: settled.state };
  return { line: null, state: "pending" };
}

/** Whether the card's press asks before running: no price yet, or none could be had. */
export function checkPressOf(state: CheckEstimateView["state"]): "ask" | "run" {
  return state === "pending" || state === "unknown" ? "ask" : "run";
}
