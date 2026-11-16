/**
 * The time a check's requests wait without the check being slow: behind a reply on their key
 * (./repliesFirst), or on a rate limit's stated wait (#2944). It counts against neither the
 * check's time limit nor its pauses: they count only the time nothing of it waited.
 */
import type { PaceTimers } from "../../sources/pace";

export interface HeldTime {
  /** Marks time as held until the returned function is called; a second call does nothing. */
  begin(): () => void;
  /** `base`, whose sleeps leave out the time held. */
  timers: PaceTimers;
  /** The clock the held time is kept by, whose sleeps leave nothing out: for a wait that is the hold itself. */
  base: PaceTimers;
  /** Aborts after `ms` of time nothing was held, unless `until` aborts first. */
  timeout(ms: number, until: AbortSignal): AbortSignal;
}

/** Settles after `ms` on the computer's clock, or rejects once `signal` aborts; never keeps the host up. */
const sleepHere = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    timer.unref?.();
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });

export function heldTime(base: PaceTimers): HeldTime {
  let holding = 0;
  let since = 0;
  let held = 0;
  // The same on the computer's own clock, for the limits a check keeps apart from `base`.
  let sinceHere = 0;
  let heldHere = 0;
  const resumed = new Set<() => void>();
  const heldSoFar = () => held + (holding > 0 ? base.now() - since : 0);
  const heldHereSoFar = () => heldHere + (holding > 0 ? Date.now() - sinceHere : 0);

  const free = (signal: AbortSignal) =>
    holding === 0
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          const resume = () => {
            signal.removeEventListener("abort", stop);
            resolve();
          };
          const stop = () => {
            resumed.delete(resume);
            reject(signal.reason);
          };
          resumed.add(resume);
          signal.addEventListener("abort", stop, { once: true });
        });

  const timers: PaceTimers = {
    now: base.now,
    async sleep(ms, signal) {
      let left = ms;
      while (left > 0) {
        const from = heldSoFar();
        await base.sleep(left, signal);
        // Only the time held inside the sleep is owed: `free` sits out the rest of it.
        left = heldSoFar() - from;
        await free(signal);
      }
    },
  };

  return {
    begin() {
      if (holding++ === 0) {
        since = base.now();
        sinceHere = Date.now();
      }
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        if (--holding > 0) return;
        held += base.now() - since;
        heldHere += Date.now() - sinceHere;
        for (const resume of [...resumed]) resume();
        resumed.clear();
      };
    },
    timers,
    base,
    timeout(ms, until) {
      const timedOut = new AbortController();
      const run = async () => {
        let left = ms;
        while (left > 0) {
          const from = heldHereSoFar();
          await sleepHere(left, until);
          left = heldHereSoFar() - from;
          await free(until);
        }
        timedOut.abort(new DOMException("The check's time limit passed.", "TimeoutError"));
      };
      run().catch(() => undefined);
      return timedOut.signal;
    },
  };
}
