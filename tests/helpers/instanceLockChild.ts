import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { heldByAnotherCopy, lockInstance } from "../../src/main/instanceLock";

/**
 * One of the copies in tests/main/instanceLock.test.ts. `race`: asks for the lock at the start of
 * each round, together with the other copy, holds it a moment and says when it did; `hold`: takes
 * it, says so and waits to be killed; `try`: asks once and says what it got; `leaving`: the same, as
 * the app does once it got Electron's lock, saying first when it found the folder held. `race` with
 * `garbage` first writes text into one or both of the lock files, before each round.
 */
const [mode, folder, ...rest] = process.argv.slice(2);

const report = (what: string, error: unknown) => console.error(what, error);
const now = () => process.hrtime.bigint();
const waitUntil = (until: bigint) => {
  while (now() < until) {
    // Spinning keeps the two copies within microseconds of each other.
  }
};

if (mode === "try" || mode === "leaving") {
  const leaving = mode === "leaving" && heldByAnotherCopy(folder ?? "", report);
  if (leaving) console.log(JSON.stringify({ sawItHeld: true }));
  const lock = lockInstance(folder ?? "", report, { holderMayBeLeaving: leaving });
  console.log(JSON.stringify({ held: lock.held }));
  lock.release();
} else if (mode === "hold") {
  const lock = lockInstance(folder ?? "", report);
  console.log(JSON.stringify({ held: lock.held }));
  setInterval(() => undefined, 1_000);
} else {
  // Every round starts when all the copies are ready for it, so a copy that was slowed down in one
  // round doesn't put the others out of step in the rest.
  const [rounds, holdMs, copies, index] = rest.slice(0, 4).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const garbage = rest[4] === "garbage";
  const text = "not a database, only text that is long enough ".repeat(8);
  const syncFolder = join(folder ?? "", "..", `${basename(folder ?? "")}-sync`);
  mkdirSync(syncFolder, { recursive: true });
  const ready = (round: number) => {
    writeFileSync(join(syncFolder, `${round}-${index}`), "");
    for (let other = 0; other < copies; other++) {
      while (!existsSync(join(syncFolder, `${round}-${other}`))) {
        // Spinning keeps the copies within microseconds of each other.
      }
    }
  };
  const results: { held: boolean; at: string; from?: string; to?: string }[] = [];
  for (let round = 0; round < rounds; round++) {
    if (garbage && index === 0) {
      const kind = round % 3;
      if (kind !== 1) writeFileSync(join(folder ?? "", "instance.lock"), text);
      if (kind !== 0) writeFileSync(join(folder ?? "", "instance.owner"), text);
    }
    ready(round);
    const lock = lockInstance(folder ?? "", report);
    const from = now();
    if (!lock.held) {
      results.push({ held: false, at: String(from) });
      continue;
    }
    waitUntil(from + BigInt(holdMs) * 1_000_000n);
    const to = now();
    lock.release();
    results.push({ held: true, at: String(from), from: String(from), to: String(to) });
  }
  console.log(JSON.stringify(results));
}
