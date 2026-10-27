/**
 * The one signal that a run must stop before its work is done (#83): the
 * monthly cap would be passed, or a plan's limit is reached. Waiting can't
 * help the next item, so a run of many items stops cleanly at the first,
 * rather than failing item by item, and its unfinished items say "not
 * checked" with the reason. Tasks (#126) resume from it later.
 *
 * A provider limiting requests (HTTP 429) is different: waiting helps, so
 * the item is tried again after a pause, no new item starts until the pause
 * is over (#98), and one fewer item runs at once for the rest of the run (#1618).
 */
import type { ProviderError, RunStop } from "../api";
import { classifyProviderError } from "../providers/providerErrors";

/** The stop a failure means, or null for a failure that leaves the next item free to try. */
export function runStopOf(error: ProviderError): RunStop | null {
  if (error.kind === "cost-cap") return { reason: "cost-cap" };
  if (error.kind === "plan-limit")
    return { reason: "plan-limit", resetsAt: error.resetsAt ?? null };
  return null;
}

/** What became of one item of a run. */
export type ItemOutcome<T> =
  | { status: "done"; value: T }
  | { status: "failed"; error: ProviderError }
  | { status: "not-checked"; stop: RunStop }
  /** The run was stopped (`RunItemsOptions.signal`) before the item was done. */
  | { status: "stopped" };

/** An item's failure, as its provider error: what `each` throws for a failure it already sorted. */
export class RunItemError extends Error {
  constructor(readonly error: ProviderError) {
    super(error.message);
    this.name = "RunItemError";
  }
}

/**
 * What `each` throws when its item gave way to something that comes first (an
 * Answer, while a Task's model runs on this computer, #126): the item is
 * tried again, from the start, before the next, and it counts as no try.
 */
export class RunItemGaveWay extends Error {
  constructor() {
    super("The item gave way.");
    this.name = "RunItemGaveWay";
  }
}

/** The pauses before trying an item the provider limited again, the first first. */
export const RATE_LIMIT_PAUSES_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export interface RunItemsOptions<I, T> {
  /** How many items run at once. Default 1, in order. */
  concurrency?: number;
  /** Hears each item's outcome as soon as it has one. */
  onOutcome?(item: I, outcome: ItemOutcome<T>): void;
  /** Ends the run: items running or waiting are "stopped". */
  signal?: AbortSignal;
  /** Waits `ms` (or until `signal` aborts): the pause after a provider limited requests. */
  wait?(ms: number, signal?: AbortSignal): Promise<void>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

const failureOf = (thrown: unknown): ProviderError =>
  thrown instanceof RunItemError ? thrown.error : classifyProviderError(thrown);

/**
 * Runs a run's items (a comparison table's cells, verify's sentences…),
 * `concurrency` at a time, starting them in order. A failure fails its item
 * and the run goes on; a provider limiting requests has the item tried again
 * after a pause (`RATE_LIMIT_PAUSES_MS`), with one fewer running at once from
 * then on, and fail once the pauses run out; a stop ends it: that item and
 * every one not started yet are not checked, for the stop's reason, while
 * those already running finish.
 */
export async function runItems<I, T>(
  items: readonly I[],
  each: (item: I) => Promise<T>,
  { concurrency = 1, onOutcome, signal, wait = sleep }: RunItemsOptions<I, T> = {},
): Promise<{ outcomes: ItemOutcome<T>[]; stop: RunStop | null }> {
  const outcomes: ItemOutcome<T>[] = new Array(items.length);
  const queue = items.map((_, index) => index);
  const tries = items.map(() => 0);
  let stop: RunStop | null = null;
  /** No item starts before this, in ms since the epoch: a provider limited requests. */
  let pausedUntil = 0;
  const workers = Math.max(1, Math.min(concurrency, items.length));
  let allowed = workers;
  /** Items that ended without a rate limit since the last one: a round of them brings one more back. */
  let calm = 0;
  /** A limit that outlasted every pause: the rest aren't sent, so a limited key gives up after one round (#1618). */
  let limitedOut: ProviderError | null = null;
  let holding = 0;

  const settle = (index: number, outcome: ItemOutcome<T>) => {
    outcomes[index] = outcome;
    onOutcome?.(items[index] as I, outcome);
  };

  const ended = () => {
    calm++;
    if (allowed < workers && calm >= allowed) {
      allowed++;
      calm = 0;
      grow();
    }
  };

  /** Whether the worker goes on to the next item. */
  const take = async (index: number): Promise<boolean> => {
    const pause = pausedUntil - Date.now();
    if (pause > 0) {
      await wait(pause, signal);
      if (stop || signal?.aborted) {
        queue.unshift(index);
        return false;
      }
    }
    if (limitedOut) {
      settle(index, { status: "failed", error: limitedOut });
      return true;
    }
    tries[index] = (tries[index] ?? 0) + 1;
    try {
      settle(index, { status: "done", value: await each(items[index] as I) });
      ended();
      return true;
    } catch (thrown) {
      if (signal?.aborted) {
        settle(index, { status: "stopped" });
        return false;
      }
      if (thrown instanceof RunItemGaveWay) {
        tries[index] = (tries[index] ?? 1) - 1;
        queue.unshift(index);
        return true;
      }
      const error = failureOf(thrown);
      const stopped = runStopOf(error);
      if (stopped) {
        stop ??= stopped;
        settle(index, { status: "not-checked", stop: stopped });
        return false;
      }
      const tried = tries[index] ?? 1;
      if (error.kind === "rate-limit") {
        calm = 0;
        if (tried <= RATE_LIMIT_PAUSES_MS.length) {
          const delay = RATE_LIMIT_PAUSES_MS[tried - 1] ?? 0;
          pausedUntil = Math.max(pausedUntil, Date.now() + delay);
          allowed = Math.max(1, allowed - 1);
          queue.unshift(index);
          return true;
        }
        limitedOut = error;
      } else ended();
      settle(index, { status: "failed", error });
      return true;
    }
  };

  const worker = async () => {
    // Past the number allowed, a worker leaves the queue to those still holding an item.
    while (!stop && !signal?.aborted && holding < allowed) {
      const index = queue.shift();
      if (index === undefined) return;
      holding++;
      const next = await take(index).finally(() => {
        holding--;
      });
      if (!next) return;
    }
  };

  const pool: Promise<void>[] = [];
  let live = 0;
  function grow() {
    while (live < allowed && queue.length > 0 && !stop && !signal?.aborted) {
      live++;
      pool.push(
        worker().finally(() => {
          live--;
        }),
      );
    }
  }
  grow();
  for (let index = 0; index < pool.length; index++) await pool[index];
  for (const index of queue) {
    settle(index, stop ? { status: "not-checked", stop } : { status: "stopped" });
  }
  return { outcomes, stop };
}
