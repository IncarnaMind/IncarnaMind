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
 * An item that sends its requests through the run (`RunRequests`, a check's, #2944) has a
 * request refused with a stated wait sent again inside it instead.
 */
import type { ProviderError, RunStop } from "../api";
import { classifyProviderError } from "../providers/providerErrors";
import { sendWaiting } from "./requestWait";

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

/** How an item sends its requests through its run (#2944), so a refused one goes again inside it. */
export interface RunRequests {
  /**
   * Sends `request`. A rate limit that says how long to wait has it sent again once that wait is
   * over, never sooner and at least a second later, inside the item; once its waits since its
   * first refusal would pass `REQUEST_WAIT_LIMIT_MS`, the limit is thrown, marked not to be
   * retried: the item isn't tried again, and the items not started yet aren't sent. A rate limit
   * that doesn't say is thrown as it came, for the AI SDK's own retries and then the run's pauses,
   * as before. A stopped run, or `signal`, ends a wait and throws, unsent. `waiting` hears each
   * wait start (true) and end (false).
   */
  send<R>(
    request: () => PromiseLike<R>,
    options?: {
      signal?: AbortSignal;
      waiting?(on: boolean): void;
      /** Waits `ms` for the request's wait, where the run's own `wait` isn't the clock for it. */
      sleep?(ms: number, signal?: AbortSignal): Promise<void>;
    },
  ): Promise<R>;
  /** Whether a rate limit was thrown to the item by `send` once its waits ran out. */
  limited(): boolean;
}

export interface RunItemsOptions<I, T> {
  /** How many items run at once. Default 1, in order. */
  concurrency?: number;
  /** Hears each item's outcome as soon as it has one. */
  onOutcome?(item: I, outcome: ItemOutcome<T>): void;
  /** Hears when the run waits on a rate limit until (ms since the epoch), or null once it no longer does. */
  onPause?(until: number | null): void;
  /** Ends the run: items running or waiting are "stopped". */
  signal?: AbortSignal;
  /** Waits `ms` (or until `signal` aborts): the pause after a provider limited requests. */
  wait?(ms: number, signal?: AbortSignal): Promise<void>;
  /** The time `wait` keeps, in ms since the epoch. */
  now?(): number;
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
 * those already running finish. `each` may send its item's requests through `requests`
 * (`RunRequests`): one refused with a stated wait then waits it and goes again inside the item.
 *
 * `onOutcome` says what became of an item (writing its mark, say). It is
 * called outside the try that ran the item, and an error it throws is never
 * the item's failure and is heard for no item twice: the item keeps the
 * outcome it had, the rest still run and are heard once, and the first such
 * error comes back as `outcomeError` once every item has settled, for the
 * caller to say once where the User can read it (#2543).
 */
export async function runItems<I, T>(
  items: readonly I[],
  each: (item: I, requests: RunRequests) => Promise<T>,
  {
    concurrency = 1,
    onOutcome,
    onPause,
    signal,
    wait = sleep,
    now = Date.now,
  }: RunItemsOptions<I, T> = {},
): Promise<{
  outcomes: ItemOutcome<T>[];
  stop: RunStop | null;
  outcomeError: { error: unknown } | null;
}> {
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
  /** When each request `send` holds after a rate limit may go again. */
  const waits = new Set<number>();
  /** The wait `onPause` last heard of. */
  let announced: number | null = null;

  const announce = () => {
    const ends = [...waits, ...(pausedUntil > now() ? [pausedUntil] : [])];
    const until = ends.length > 0 ? Math.max(...ends) : null;
    if (until === announced) return;
    announced = until;
    onPause?.(until);
  };

  /** An item's requests; `met` says whether one met a rate limit, so its end is no calm one. */
  const requests = (): RunRequests & { met(): boolean } => {
    let limited = false;
    let met = false;
    return {
      limited: () => limited,
      met: () => met,
      send(request, options = {}) {
        const stopped = options.signal
          ? signal
            ? AbortSignal.any([signal, options.signal])
            : options.signal
          : signal;
        return sendWaiting(
          request,
          {
            now,
            wait,
            met() {
              met = true;
              calm = 0;
            },
            waiting(until, on) {
              if (on) waits.add(until);
              else waits.delete(until);
              options.waiting?.(on);
              announce();
            },
            // As for an item's limit that outlasted every pause, the items not started yet aren't sent.
            gaveUp(error) {
              limited = true;
              limitedOut ??= classifyProviderError(error);
            },
          },
          { ...(stopped && { signal: stopped }), ...(options.sleep && { sleep: options.sleep }) },
        );
      },
    };
  };

  const settle = (index: number, outcome: ItemOutcome<T>) => {
    outcomes[index] = outcome;
  };

  /** The first error `onOutcome` threw: returned once every item has settled, never its item's. */
  let outcomeError: { error: unknown } | null = null;

  const hear = (index: number) => {
    if (!onOutcome) return;
    try {
      onOutcome(items[index] as I, outcomes[index] as ItemOutcome<T>);
    } catch (error) {
      outcomeError ??= { error };
    }
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
    const pause = pausedUntil - now();
    if (pause > 0) {
      announce();
      await wait(pause, signal);
      announce();
      if (stop || signal?.aborted) {
        queue.unshift(index);
        return false;
      }
    }
    if (limitedOut) {
      settle(index, { status: "failed", error: limitedOut });
      hear(index);
      return true;
    }
    tries[index] = (tries[index] ?? 0) + 1;
    const sending = requests();
    let outcome: ItemOutcome<T>;
    try {
      outcome = { status: "done", value: await each(items[index] as I, sending) };
    } catch (thrown) {
      if (signal?.aborted) {
        settle(index, { status: "stopped" });
        hear(index);
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
        hear(index);
        return false;
      }
      const tried = tries[index] ?? 1;
      if (error.kind === "rate-limit") {
        calm = 0;
        // A limit its requests waited out to the end was waited out already.
        if (!sending.limited() && tried <= RATE_LIMIT_PAUSES_MS.length) {
          const delay = RATE_LIMIT_PAUSES_MS[tried - 1] ?? 0;
          pausedUntil = Math.max(pausedUntil, now() + delay);
          allowed = Math.max(1, allowed - 1);
          queue.unshift(index);
          return true;
        }
        limitedOut ??= error;
      } else if (!sending.met()) ended();
      settle(index, { status: "failed", error });
      hear(index);
      return true;
    }
    settle(index, outcome);
    hear(index);
    if (!sending.met()) ended();
    return true;
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
  waits.clear();
  pausedUntil = 0;
  announce();
  for (const index of queue) {
    settle(index, stop ? { status: "not-checked", stop } : { status: "stopped" });
    hear(index);
  }
  return { outcomes, stop, outcomeError };
}

/** Model calls that share one run's limit of `size` at once, whichever item asks: a claim's parts and its neighbours. */
export interface Slots {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** How many tasks could start now without waiting. */
  free(): number;
}

export function slots(size: number): Slots {
  let free = Math.max(1, size);
  const waiting: (() => void)[] = [];
  return {
    free: () => (waiting.length > 0 ? 0 : free),
    async run(task) {
      if (free > 0) free--;
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await task();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else free++;
      }
    },
  };
}
