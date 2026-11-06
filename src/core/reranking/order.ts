import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The order the built-in reranking model takes its requests in. It scores one at a time, and the
 * GPU is busy all the while: more at once, batched or on a second session, finished no sooner, and
 * batching changed the scores (#2532). So the requests of work started earlier go first: a check's
 * second search goes before the first searches of checks started after it, as a priority queue in
 * an inference server serves the oldest request first, and no score changes.
 */
const current = new AsyncLocalStorage<number>();
let next = 0;

/** Runs `work` as one piece of work, whose reranks go before those of work started after it; within one already, as part of it. */
export function asRerankWork<T>(work: () => T): T {
  return current.getStore() === undefined ? current.run(next++, work) : work();
}

/** Where a rerank asked now goes: by its work's start, or, outside any, by when it is asked. */
export const rerankOrder = (): number => current.getStore() ?? next++;

/** Runs scorings one at a time, the one whose order comes first next; one stopped while it waits never runs. */
export function createRerankQueue() {
  const waiting: { order: number; start(): void }[] = [];
  let busy = false;
  return async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const order = rerankOrder();
    if (busy) {
      await new Promise<void>((start) => {
        // After the last of its order, so the same work's requests keep theirs.
        const at = waiting.findIndex((each) => each.order > order);
        waiting.splice(at < 0 ? waiting.length : at, 0, { order, start });
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
