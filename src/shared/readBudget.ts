import type {
  ClaimCheckAttributes,
  ClaimCheckPart,
  Money,
  RunEstimate,
  SearchScope,
} from "../core/api";
import { sameScope } from "./searchScope";

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
 * The most a whole read may spend, which the meter never lets it pass, never above all it may
 * cost: $0.50 for a read that starts without asking; for one that asks, twice what it costs about,
 * and at least $0.50. Its ceiling counts every call at its output limit, far above what a read
 * costs, so a read that reaches its budget stops and asks again (Continue). Null for a read with
 * no known price, or a model not billed per token, as for the monthly cap.
 */
export function readBudget(estimate: RunEstimate | null, partsSorted: boolean): Money | null {
  if (estimate?.billing !== "per-token") return null;
  const most = estimate.upTo?.cost ?? null;
  if (!most) return null;
  const promised = readsUnasked(estimate, partsSorted)
    ? UNASKED_ABOUT
    : Math.max(UNASKED_ABOUT, 2 * (estimate.cost?.amount ?? most.amount));
  return { ...most, amount: Math.min(most.amount, promised) };
}

/**
 * A whole read stopped at its budget, as its `read-budget` reason's `detail` keeps it: the most it
 * may spend, what it had spent, and for a part, whether its read judges its absence, as the plan
 * of the read that stopped said.
 */
export interface BudgetStop {
  most: Money;
  spent: Money;
  judgesAbsence?: boolean;
}

const moneyOf = (value: unknown): Money | null => {
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
  if (!most || !spent) return null;
  return {
    most,
    spent,
    ...(typeof read.judgesAbsence === "boolean" && { judgesAbsence: read.judgesAbsence }),
  };
}

/** A part a whole read stopped at its budget before it judged it. */
export const stoppedAtBudget = (part: Pick<ClaimCheckPart, "verdict" | "reason">): boolean =>
  part.verdict === "not-checked" && part.reason === "read-budget";

/**
 * Whether a whole read of a part judges its absence too: not when its last check found its words
 * unsupported, as a sentence that says nothing is absent is; a part a read stopped before it judged
 * it, as that read's plan said.
 */
export function judgesAbsence(
  part: Pick<ClaimCheckPart, "verdict" | "reason" | "detail">,
): boolean {
  if (stoppedAtBudget(part)) return budgetStopOf(part.detail)?.judgesAbsence ?? true;
  return part.verdict !== "unsupported";
}

/**
 * Whether a whole read of `within` goes on from a read of the same pick that stopped at its budget:
 * then it reads only the parts that read stopped before it judged them, as they were planned.
 */
export function resumesRead(
  check: Pick<ClaimCheckAttributes, "action" | "scope" | "parts">,
  within: SearchScope,
): boolean {
  const chosen = check.scope.chosen;
  return (
    check.action === "check-against-document" &&
    chosen !== undefined &&
    sameScope(chosen, within) &&
    (check.parts?.some(stoppedAtBudget) ?? false)
  );
}
