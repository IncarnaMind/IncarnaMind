/**
 * Which providers an Answer is being written on: an Answer marks its provider from its first
 * request to its end, its Tools' work included, and the check of what an Answer wrote sends no
 * new request on that provider while one is, so the reply goes first on the key's allowance
 * (#2830). Counted: two Answers can be out at once. One per core.
 */
export interface RepliesOut {
  /** Marks a reply out on `provider` until the returned function is called; a second call does nothing. */
  begin(provider: string): () => void;
  /** Whether a reply is out on `provider` now. */
  out(provider: string): boolean;
  /** Settles once no reply is out on `provider`, or once `stop` aborts. */
  none(provider: string, stop: AbortSignal): Promise<void>;
}

export function createRepliesOut(): RepliesOut {
  const out = new Map<string, number>();
  const waiting = new Map<string, Set<() => void>>();
  return {
    begin(provider) {
      out.set(provider, (out.get(provider) ?? 0) + 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const left = (out.get(provider) ?? 1) - 1;
        if (left > 0) {
          out.set(provider, left);
          return;
        }
        out.delete(provider);
        const waiters = waiting.get(provider);
        waiting.delete(provider);
        for (const release of waiters ?? []) release();
      };
    },
    out: (provider) => out.has(provider),
    none(provider, stop) {
      if (!out.has(provider) || stop.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        const waiters = waiting.get(provider) ?? new Set();
        waiting.set(provider, waiters);
        const release = () => {
          stop.removeEventListener("abort", release);
          waiters.delete(release);
          resolve();
        };
        waiters.add(release);
        stop.addEventListener("abort", release, { once: true });
      });
    },
  };
}
