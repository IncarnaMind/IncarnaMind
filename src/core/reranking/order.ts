import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The order the built-in reranking model takes its requests in. It scores one at a time, and the
 * GPU is busy all the while: more at once, batched or on a second session, finished no sooner, and
 * batching changed the scores (#2532). So a search the User is waiting on (an Answer's, Cite…'s,
 * a call's help) goes before any check's, and a check's next search goes before the first searches
 * of checks started after it, as a priority queue in an inference server serves its classes. No
 * score changes.
 */

/**
 * Where a search waits: outside any check first, by when it is asked; then checks, oldest first.
 * The searches of one check share its place.
 */
interface Place {
  rank: 0 | 1;
  order: number;
}

const current = new AsyncLocalStorage<Place>();
let next = 0;

/** Runs `work` as one check, whose searches go after every other search and before those of checks started after it; within one already, as part of it. */
export function asCheckWork<T>(work: () => T): T {
  return current.getStore() === undefined ? current.run({ rank: 1, order: next++ }, work) : work();
}

const byPlace = (a: Place, b: Place) => a.rank - b.rank || a.order - b.order;

/** Runs scorings one at a time, the one whose place comes first next; one stopped while it waits leaves at once, never run. */
export function createRerankQueue() {
  const waiting: { place: Place; start(): void }[] = [];
  let busy = false;
  return async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const place = current.getStore() ?? { rank: 0, order: next++ };
    if (busy) {
      await new Promise<void>((start, reject) => {
        signal?.throwIfAborted();
        const stopped = () => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(signal?.reason);
        };
        const entry = {
          place,
          start: () => {
            signal?.removeEventListener("abort", stopped);
            start();
          },
        };
        signal?.addEventListener("abort", stopped, { once: true });
        waiting.push(entry);
      });
    }
    busy = true;
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      // The first asked of a place goes first, so one check's searches keep their order.
      const [first] = waiting.toSorted((a, b) => byPlace(a.place, b.place));
      if (first) {
        waiting.splice(waiting.indexOf(first), 1);
        first.start();
      } else busy = false;
    }
  };
}
