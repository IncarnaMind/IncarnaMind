import { describe, expect, test } from "vitest";
import type { ProviderError } from "../../src/core";
import {
  RATE_LIMIT_PAUSES_MS,
  RunItemError,
  RunItemGaveWay,
  runItems,
} from "../../src/core/runs/stop";

const failure = (kind: ProviderError["kind"], extra: Partial<ProviderError> = {}) =>
  new RunItemError({ kind, message: kind, ...extra });

/** A wait that returns at once, noting how long it was asked to wait. */
function noWait() {
  const waited: number[] = [];
  return { waited, wait: async (ms: number) => void waited.push(ms) };
}

describe("Running a run's items", () => {
  test("runs at most `concurrency` at once, starting them in order", async () => {
    let running = 0;
    let most = 0;
    const started: number[] = [];
    const run = await runItems(
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      async (item) => {
        started.push(item);
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setImmediate(resolve));
        running--;
        return item * 10;
      },
      { concurrency: 4 },
    );
    expect(most).toBe(4);
    expect(started).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(run.outcomes.map((each) => (each.status === "done" ? each.value : null))).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80, 90,
    ]);
  });

  // protects=a rate-limited item is tried again after growing pauses, and once one outlasts them all the items after it aren't sent, so a key that stays limited gives up after one round of pauses (#1618); fails_when=each item waits out every pause in turn, or the pauses don't grow; no_claim=how long a real provider's limit lasts.
  test("an item the provider limited is tried again after a pause, longer each time, and once one outlasts the pauses the rest aren't sent", async () => {
    const { waited, wait } = noWait();
    const tries = new Map<string, number>();
    const run = await runItems(
      ["busy once", "always busy", "after it"],
      async (item) => {
        const tried = (tries.get(item) ?? 0) + 1;
        tries.set(item, tried);
        if (item === "always busy" || (item === "busy once" && tried === 1)) {
          throw failure("rate-limit");
        }
        return item;
      },
      { wait },
    );
    expect(run.outcomes.map((each) => each.status)).toEqual(["done", "failed", "failed"]);
    expect(run.outcomes[2]).toMatchObject({ error: { kind: "rate-limit" } });
    expect(tries.get("busy once")).toBe(2);
    expect(tries.get("always busy")).toBe(RATE_LIMIT_PAUSES_MS.length + 1);
    expect(tries.has("after it")).toBe(false);
    // The pauses grow for the item limited again: 1 s, 2 s, 4 s…
    expect(waited.length).toBeGreaterThanOrEqual(RATE_LIMIT_PAUSES_MS.length);
    expect(Math.max(...waited)).toBeLessThanOrEqual(RATE_LIMIT_PAUSES_MS.at(-1) ?? 0);
    expect(Math.max(...waited)).toBeGreaterThan(RATE_LIMIT_PAUSES_MS[0]);
  });

  // protects=a key that never stops limiting gives up after one item's round of pauses, with every item not sent ending on the limit's reason (#1618); fails_when=each item runs its own round of pauses in turn; no_claim=the pauses' lengths.
  test("a provider that keeps limiting ends the run after one round of pauses", async () => {
    const { waited, wait } = noWait();
    const tries = new Map<number, number>();
    const run = await runItems(
      Array.from({ length: 12 }, (_, index) => index + 1),
      async (item) => {
        tries.set(item, (tries.get(item) ?? 0) + 1);
        await new Promise((resolve) => setImmediate(resolve));
        throw failure("rate-limit");
      },
      { concurrency: 6, wait },
    );
    expect(run.outcomes.every((each) => each.status === "failed")).toBe(true);
    expect(Math.max(...tries.values())).toBe(RATE_LIMIT_PAUSES_MS.length + 1);
    expect(tries.size).toBeLessThanOrEqual(6);
    // At most each pause once per item that was tried: never twelve rounds of them.
    expect(waited.length).toBeLessThan(6 * RATE_LIMIT_PAUSES_MS.length);
  });

  // protects=a provider that limits requests gets fewer at once, and as many again once a round of items has gone through without a limit; every item is still done (#1618); fails_when=the run keeps sending as many at once after a limit, or never gets back to its number; no_claim=how long the pauses are.
  test("a provider limiting requests lowers how many run at once, and a calm round brings them back", async () => {
    const { wait } = noWait();
    let running = 0;
    let limited = false;
    const startedAt: { running: number; afterLimit: boolean }[] = [];
    const run = await runItems(
      Array.from({ length: 24 }, (_, index) => index + 1),
      async (item) => {
        running++;
        startedAt.push({ running, afterLimit: limited });
        try {
          await new Promise((resolve) => setImmediate(resolve));
          if (item === 2 && !limited) {
            limited = true;
            throw failure("rate-limit");
          }
          return item;
        } finally {
          running--;
        }
      },
      { concurrency: 4, wait },
    );
    const after = startedAt.filter((each) => each.afterLimit);
    expect(Math.max(...after.slice(0, 3).map((each) => each.running))).toBeLessThanOrEqual(3);
    expect(Math.max(...after.slice(-6).map((each) => each.running))).toBe(4);
    expect(running).toBe(0);
    expect(run.outcomes.map((each) => each.status)).toEqual(Array(24).fill("done"));
  });

  // protects=a run sent more at once than its provider's proven number drops straight back to it at the first limit, loses one more per limit below it, and never grows past it again; every item is still done (#2532); fails_when=the first limit takes only one place away, or a calm round brings the run back above the proven number; no_claim=how long the pauses are.
  test("a run past its proven number drops straight back to it at a limit, and stays at or under it", async () => {
    const { wait } = noWait();
    let running = 0;
    const limitedAt = new Set<number>();
    const startedAt: { running: number; limits: number }[] = [];
    const run = await runItems(
      Array.from({ length: 40 }, (_, index) => index + 1),
      async (item) => {
        running++;
        startedAt.push({ running, limits: limitedAt.size });
        try {
          await new Promise((resolve) => setImmediate(resolve));
          if ((item === 12 || item === 20) && !limitedAt.has(item)) {
            limitedAt.add(item);
            throw failure("rate-limit");
          }
          return item;
        } finally {
          running--;
        }
      },
      { concurrency: 12, limitedAtOnce: 6, wait },
    );
    const before = startedAt.filter((each) => each.limits === 0);
    const afterOne = startedAt.filter((each) => each.limits === 1);
    const afterTwo = startedAt.filter((each) => each.limits === 2);
    expect(Math.max(...before.map((each) => each.running))).toBe(12);
    expect(Math.max(...afterOne.map((each) => each.running))).toBeLessThanOrEqual(6);
    expect(Math.max(...afterTwo.slice(0, 4).map((each) => each.running))).toBeLessThanOrEqual(5);
    expect(Math.max(...afterTwo.map((each) => each.running))).toBe(6);
    expect(run.outcomes.map((each) => each.status)).toEqual(Array(40).fill("done"));
  });

  // protects=items that give way together go back in their place and are tried again in their order, counting no try (#2532); fails_when=they are tried again last first, as when each was put at the queue's front; no_claim=what makes an item give way.
  test("items that give way together are tried again in their order", async () => {
    const { wait } = noWait();
    const started: number[] = [];
    const tried = new Set<number>();
    const run = await runItems(
      [1, 2, 3, 4, 5, 6],
      async (item) => {
        started.push(item);
        const first = !tried.has(item);
        tried.add(item);
        if (item === 1 && first) throw failure("rate-limit");
        // Once the limit has left one place, the other three give way together.
        if (item <= 4 && first) {
          await new Promise((resolve) => setImmediate(resolve));
          throw new RunItemGaveWay();
        }
        return item;
      },
      { concurrency: 4, limitedAtOnce: 1, wait },
    );
    expect(started).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 5, 6]);
    expect(run.outcomes.map((each) => each.status)).toEqual(Array(6).fill("done"));
  });

  test("an item limited while the others still run is tried again once they are done", async () => {
    const { wait } = noWait();
    let release = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let tries = 0;
    const run = await runItems(
      ["slow", "limited once"],
      async (item) => {
        if (item === "slow") {
          await slow;
          return item;
        }
        tries++;
        if (tries === 1) {
          // The slow item ends only after this one's worker has left it to the slow one's.
          setImmediate(release);
          throw failure("rate-limit");
        }
        return item;
      },
      { concurrency: 2, wait },
    );
    expect(tries).toBe(2);
    expect(run.outcomes.map((each) => each.status)).toEqual(["done", "done"]);
  });

  test("a plan's limit stops the run: items running finish, those not started aren't checked", async () => {
    const heard: string[] = [];
    const run = await runItems(
      ["a", "b", "c", "d", "e", "f"],
      async (item) => {
        // b's provider refuses at once, while a and c are still running.
        if (item === "b") throw failure("plan-limit", { resetsAt: "2026-10-12T14:30:00.000Z" });
        await new Promise((resolve) => setImmediate(resolve));
        return item;
      },
      { concurrency: 3, onOutcome: (item, outcome) => heard.push(`${item}:${outcome.status}`) },
    );
    expect(run.stop).toEqual({ reason: "plan-limit", resetsAt: "2026-10-12T14:30:00.000Z" });
    expect(run.outcomes.map((each) => each.status)).toEqual([
      "done",
      "not-checked",
      "done",
      "not-checked",
      "not-checked",
      "not-checked",
    ]);
    // Each was heard as it ended, once.
    expect(heard.sort()).toEqual(
      [
        "a:done",
        "b:not-checked",
        "c:done",
        "d:not-checked",
        "e:not-checked",
        "f:not-checked",
      ].sort(),
    );
  });

  test("stopping the run leaves the items not yet done stopped", async () => {
    const controller = new AbortController();
    const run = await runItems(
      [1, 2, 3],
      async (item) => {
        if (item === 2) {
          controller.abort();
          throw new DOMException("Stopped.", "AbortError");
        }
        return item;
      },
      { signal: controller.signal },
    );
    expect(run.outcomes.map((each) => each.status)).toEqual(["done", "stopped", "stopped"]);
    expect(run.stop).toBeNull();
  });

  // protects=an outcome listener that throws is never its item's failure and is never heard twice: the item keeps the outcome it had, every item still runs and is heard once, and the run comes back with the listener's first error once every item has settled (#2543); fails_when=the throw is filed as the item's failure and the listener hears it again as failed, or the run stops before its other items run; no_claim=how a caller says the error.
  test("a throwing outcome listener never fails its item, and the run comes back with its error once every item has settled", async () => {
    const heard: string[] = [];
    const ran: string[] = [];
    const thrown = new Error("The mark couldn't be written.");
    const run = await runItems(
      ["first", "second", "third"],
      async (item) => {
        ran.push(item);
        return item;
      },
      {
        onOutcome(item, outcome) {
          heard.push(`${item}:${outcome.status}`);
          if (item === "first" && outcome.status === "done") throw thrown;
        },
      },
    );
    // The listener heard each item once, with the outcome its check gave: never a second, failed "first".
    expect(heard).toEqual(["first:done", "second:done", "third:done"]);
    expect(ran).toEqual(["first", "second", "third"]);
    expect(run.outcomeError?.error).toBe(thrown);
    expect(run.outcomes.map((each) => each.status)).toEqual(["done", "done", "done"]);
  });

  test("a listener that throws a falsy value still comes back as the error", async () => {
    const run = await runItems(["only"], async () => 1, {
      onOutcome() {
        throw undefined;
      },
    });
    expect(run.outcomeError).not.toBeNull();
    expect(run.outcomeError?.error).toBeUndefined();
  });
});
