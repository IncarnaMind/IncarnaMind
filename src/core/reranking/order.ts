/**
 * The built-in reranking model scores one request at a time, and the GPU is busy all the while:
 * more at once, batched or on a second session, finished no sooner, and batching changed the
 * scores (#2532). So its requests wait their turn, the first asked first.
 */

/** Runs scorings one at a time, in the order asked; one stopped while it waits leaves at once, never run. */
export function createRerankQueue() {
  const waiting: (() => void)[] = [];
  let busy = false;
  return async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (busy) {
      await new Promise<void>((start, reject) => {
        signal?.throwIfAborted();
        const stopped = () => {
          waiting.splice(waiting.indexOf(turn), 1);
          reject(signal?.reason);
        };
        const turn = () => {
          signal?.removeEventListener("abort", stopped);
          start();
        };
        signal?.addEventListener("abort", stopped, { once: true });
        waiting.push(turn);
      });
    }
    busy = true;
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else busy = false;
    }
  };
}
