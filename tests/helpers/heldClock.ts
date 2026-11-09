import { CLAIM_TIME_LIMIT_MS } from "../../src/core/answers/checks/runCheck";
import type { PaceTimers } from "../../src/core/sources/pace";

/** A clock for the core's waits that only moves when the test moves it. */
export function heldClock() {
  let time = Date.parse("2026-10-18T09:00:00.000Z");
  const held: { until: number; resolve(): void }[] = [];
  const timers: PaceTimers = {
    now: () => time,
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        if (ms <= 0) return resolve();
        const wait = { until: time + ms, resolve };
        held.push(wait);
        signal.addEventListener(
          "abort",
          () => {
            held.splice(held.indexOf(wait), 1);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
  return {
    timers,
    now: () => time,
    /** How many waits are held. */
    waits: () => held.length,
    /** Moves the clock on, ending the waits that are over. */
    advance(ms: number) {
      time += ms;
      for (const wait of held.filter((each) => each.until <= time)) {
        held.splice(held.indexOf(wait), 1);
        wait.resolve();
      }
    },
  };
}

export type Clock = ReturnType<typeof heldClock>;

/**
 * The core's waits for checks (src/core/answers/checks/runCheck.ts) on a clock no test has to
 * move: each pause after a rate limit ends at once, and is kept; a check's time limit, `limitMs`,
 * ends only when the test calls `timeOut`.
 */
export function checkClock(limitMs = CLAIM_TIME_LIMIT_MS) {
  const paused: number[] = [];
  const limits = new Set<() => void>();
  /** How far the pauses moved the clock on. */
  let ahead = 0;
  const timers: PaceTimers = {
    now: () => Date.now() + ahead,
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        if (ms < limitMs) {
          if (ms > 0) paused.push(ms);
          ahead += Math.max(0, ms);
          return resolve();
        }
        const end = () => {
          limits.delete(end);
          resolve();
        };
        limits.add(end);
        signal.addEventListener(
          "abort",
          () => {
            limits.delete(end);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
  return {
    timers,
    /** The pauses the core waited, in ms, the first first. */
    pauses: () => [...paused],
    /** How many checks are waiting on their time limit: those whose reply hasn't come. */
    waiting: () => limits.size,
    /** Ends every time limit the core is waiting on. */
    timeOut() {
      for (const end of [...limits]) end();
    },
  };
}
