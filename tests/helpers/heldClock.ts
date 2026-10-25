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
