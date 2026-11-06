import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The order the built-in reranking model takes its requests in. It scores one at a time, and the
 * GPU is busy all the while: more at once, batched or on a second session, finished no sooner, and
 * batching changed the scores (#2532). So a search the User is waiting on (an Answer's, Cite…'s,
 * a call's help) goes before any check's, and a check's next search goes before the first searches
 * of checks started after it, as a priority queue in an inference server serves its classes. No
 * score changes.
 */
const current = new AsyncLocalStorage<number>();
let next = 0;

/** Where a search waits: outside any check first, by when it is asked; then checks, oldest first. */
interface Place {
  check: boolean;
  order: number;
}

/** Runs `work` as one check, whose searches go after every other search and before those of checks started after it; within one already, as part of it. */
export function asCheckWork<T>(work: () => T): T {
  return current.getStore() === undefined ? current.run(next++, work) : work();
}

/** Where a search asked now waits. */
function placeNow(): Place {
  const check = current.getStore();
  return check === undefined ? { check: false, order: next++ } : { check: true, order: check };
}

const comesAfter = (a: Place, b: Place) =>
  a.check === b.check ? a.order > b.order : a.check && !b.check;

/** Runs scorings one at a time, the one whose place comes first next; one stopped while it waits leaves at once, never run. */
export function createRerankQueue() {
  const waiting: (Place & { start(): void })[] = [];
  let busy = false;
  return async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const place = placeNow();
    if (busy) {
      await new Promise<void>((start, reject) => {
        signal?.throwIfAborted();
        const stopped = () => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(signal?.reason);
        };
        const entry = {
          ...place,
          start: () => {
            signal?.removeEventListener("abort", stopped);
            start();
          },
        };
        signal?.addEventListener("abort", stopped, { once: true });
        // After the last of its place, so one check's searches keep their order.
        const at = waiting.findIndex((each) => comesAfter(each, place));
        waiting.splice(at < 0 ? waiting.length : at, 0, entry);
      });
    }
    busy = true;
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      const first = waiting.shift();
      if (first) first.start();
      else busy = false;
    }
  };
}
