/**
 * Tagging on a plan: the ChatGPT plan, or a Claude account's. The plan's
 * limits are shared with ChatGPT or Claude itself, and adding a folder of 500
 * Documents could use them up in minutes, so tagging takes it gently:
 *
 * - one Document at a time, its requests at least `PLAN_PACE.gapMs` apart;
 * - when the plan's limit is reached, nothing more is sent until it resets,
 *   or, when the provider doesn't say when, for a wait that doubles each time
 *   the limit is still reached (`firstWaitMs` up to `longestWaitMs`).
 *   Documents wait meanwhile, and one tries first when the wait is over: it
 *   never retries in a loop.
 */
import { ChatGptPlanError, isPlanLimit } from "../providers/chatgpt/errors";
import { ClaudePlanLimitError } from "../providers/providerErrors";
import type { Pace, PaceTimers } from "../sources/pace";

export const PLAN_PACE = {
  gapMs: 3_000,
  firstWaitMs: 15 * 60_000,
  longestWaitMs: 4 * 60 * 60_000,
};

export type Plan = "chatgpt" | "claude-account";

interface PlanLimit {
  /** When the limit resets (epoch milliseconds), when the provider says. */
  resetsAt: number | null;
}

const isClaudePlanLimit = (error: unknown): error is ClaudePlanLimitError =>
  error instanceof ClaudePlanLimitError;

/** Either plan's usage limit is reached: a request refused, or tagging waiting for it to reset. */
export const reachedPlanLimit = (error: unknown): error is PlanLimit =>
  isPlanLimit(error) || isClaudePlanLimit(error);

const PLANS: Record<
  Plan,
  {
    /** The Pace's lane: every request tagging makes on the plan, Organize's and automatic tagging's. */
    lane: string;
    limit(error: unknown): error is PlanLimit;
    /** What tagging meets while it waits, until `until` (epoch milliseconds). */
    waiting(until: number): Error;
  }
> = {
  chatgpt: {
    lane: "chatgpt-plan-tagging",
    limit: isPlanLimit,
    waiting: (until) =>
      new ChatGptPlanError(
        "plan-limit",
        `Tagging waits for your ChatGPT plan's limit to reset, until ${new Date(until).toISOString()}.`,
        429,
      ),
  },
  "claude-account": {
    lane: "claude-plan-tagging",
    limit: isClaudePlanLimit,
    waiting: (until) =>
      new ClaudePlanLimitError(
        `Tagging waits for your Claude plan's limit to reset, until ${new Date(until).toISOString()}.`,
        until,
      ),
  },
};

export type PlanPace = ReturnType<typeof createPlanPace>;

export function createPlanPace(options: {
  plan: Plan;
  pace: Pace;
  timers: PaceTimers;
  resumed(): void;
  signal: AbortSignal;
}) {
  const { pace, timers } = options;
  const plan = PLANS[options.plan];
  let pausedUntil: number | null = null;
  let nextWait = PLAN_PACE.firstWaitMs;

  const paused = () => pausedUntil !== null && timers.now() < pausedUntil;
  const waiting = () => plan.waiting(pausedUntil ?? timers.now());

  function pause(error: PlanLimit): void {
    const now = timers.now();
    const until = error.resetsAt ?? now + nextWait;
    nextWait = Math.min(nextWait * 2, PLAN_PACE.longestWaitMs);
    if (pausedUntil !== null && pausedUntil >= until) return;
    pausedUntil = Math.max(until, now);
    const ends = pausedUntil;
    timers.sleep(ends - now, options.signal).then(
      () => {
        if (pausedUntil !== ends) return;
        pausedUntil = null;
        options.resumed();
      },
      () => undefined,
    );
  }

  return {
    /** Until when tagging on the plan waits (ISO 8601), or null while it doesn't. */
    pausedUntil: (): string | null => (paused() ? new Date(pausedUntil ?? 0).toISOString() : null),

    /**
     * Makes one plan request in turn, `gapMs` after the last one ended. While
     * the plan's limit holds, nothing is sent: it throws the plan's limit.
     */
    run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
      if (paused()) return Promise.reject(waiting());
      return pace.run(
        plan.lane,
        PLAN_PACE.gapMs,
        async () => {
          if (paused()) throw waiting();
          try {
            const result = await task();
            nextWait = PLAN_PACE.firstWaitMs;
            return result;
          } catch (error) {
            if (plan.limit(error)) pause(error);
            throw error;
          }
        },
        signal,
      );
    },
  };
}
