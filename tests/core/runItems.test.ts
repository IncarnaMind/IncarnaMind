import { APICallError } from "ai";
import { describe, expect, test } from "vitest";
import type { ProviderError } from "../../src/core";
import { RATE_LIMIT_PAUSES_MS, RunItemError, runItems, slots } from "../../src/core/runs/stop";

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

/** A service's rate limit, as the AI SDK throws it: `retryAfter` in seconds when it says how long. */
const limited = (retryAfter?: string) =>
  new APICallError({
    message: "Rate limit reached.",
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode: 429,
    ...(retryAfter !== undefined && { responseHeaders: { "retry-after": retryAfter } }),
    isRetryable: true,
  });

/** A clock that moves on by each wait at once, noting each, as a run's pauses keep it. */
function steppedClock() {
  let now = 0;
  const waited: number[] = [];
  return {
    waited,
    now: () => now,
    wait: async (ms: number) => {
      waited.push(ms);
      now += ms;
    },
  };
}

describe("Changing how many of a run's items run at once (#2532)", () => {
  /** Runs `count` items that each end when `release` is called, noting the most running at once. */
  function held(count: number) {
    const ends: (() => void)[] = [];
    const seen = { running: 0, most: 0 };
    const each = async (item: number) => {
      seen.running++;
      seen.most = Math.max(seen.most, seen.running);
      await new Promise<void>((resolve) => ends.push(resolve));
      seen.running--;
      return item;
    };
    const release = async (howMany: number) => {
      for (const end of ends.splice(0, howMany)) end();
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { items: Array.from({ length: count }, (_, at) => at), each, release, seen };
  }

  // protects=a run told to go wider starts more of its items at once, and told to go back starts no new item until fewer than the smaller number are running, the items already running finishing; fails_when=a resize is ignored, a narrowed run keeps starting items past its size, or an item is lost or run twice across a resize; no_claim=when a check asks for a resize.
  test("a run made wider starts more items at once, and made narrower starts none until it is back under its size", async () => {
    const { items, each, release, seen } = held(20);
    let resize: (size: number) => void = () => undefined;
    const run = runItems(items, each, {
      concurrency: 3,
      wider: (set) => {
        resize = set;
      },
    });
    await release(0);
    expect(seen.running).toBe(3);

    resize(6);
    await release(0);
    expect(seen.running).toBe(6);

    resize(2);
    await release(3);
    expect(seen.running).toBe(3);
    await release(2);
    expect(seen.running).toBe(2);

    while (seen.running > 0) await release(seen.running);
    const { outcomes } = await run;
    expect(seen.most).toBe(6);
    expect(outcomes.map((each) => (each.status === "done" ? each.value : null))).toEqual(items);
  });

  // protects=model calls sharing a run's places go more at once after the places are raised, the waiting ones starting in the order they asked, and after the places are lowered a waiting call starts only once fewer calls than that are running; fails_when=raising the places leaves waiting calls waiting, or lowering them lets a call start past the new number; no_claim=which calls a check sends through its places.
  test("a run's shared places can be raised and lowered while calls wait", async () => {
    const limit = slots(2);
    const ends: (() => void)[] = [];
    const started: number[] = [];
    const calls = [0, 1, 2, 3, 4, 5, 6].map((call) =>
      limit.run(async () => {
        started.push(call);
        await new Promise<void>((resolve) => ends.push(resolve));
      }),
    );
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    await settle();
    expect(started).toEqual([0, 1]);
    expect(limit.free()).toBe(0);

    limit.resize(4);
    await settle();
    expect(started).toEqual([0, 1, 2, 3]);

    limit.resize(2);
    for (const end of ends.splice(0, 2)) end();
    await settle();
    expect(started).toEqual([0, 1, 2, 3]);
    for (const end of ends.splice(0, 1)) end();
    await settle();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    while (ends.length > 0) {
      for (const end of ends.splice(0)) end();
      await settle();
    }
    await Promise.all(calls);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(limit.free()).toBe(2);
  });
});

describe("Sending an item's requests through its run (#2944)", () => {
  // protects=a refused request waits as long as the service says, never less, and is sent again inside its item, which isn't tried again from its start; fails_when=the item is run again from its start, or the request goes sooner than the stated wait; no_claim=how a real service words its wait.
  test("a refused request goes again inside its item once the service's stated wait is over", async () => {
    const clock = steppedClock();
    const sent: number[] = [];
    let starts = 0;
    const run = await runItems(
      ["40 s", "half a second"],
      async (item, requests) => {
        starts++;
        let refused = false;
        return requests.send(async () => {
          sent.push(clock.now());
          if (refused) return item;
          refused = true;
          throw limited(item === "40 s" ? "40" : "0.5");
        });
      },
      { wait: clock.wait, now: clock.now },
    );

    expect(run.outcomes.map((each) => each.status)).toEqual(["done", "done"]);
    expect(starts).toBe(2);
    // A stated wait under a second is held to a second.
    expect(clock.waited).toEqual([40_000, 1_000]);
    expect(sent).toEqual([0, 40_000, 40_000, 41_000]);
  });

  // protects=a rate limit that doesn't say how long is thrown as it came, so the AI SDK's own retries and then the run's pauses answer it as before (#2944: with no stated time, today's steps stay); fails_when=a limit with no stated time is waited out inside the item, or gets no pause; no_claim=the length of the pauses.
  test("a limit that doesn't say how long is thrown as it came, and the item is tried again after the run's pause", async () => {
    const clock = steppedClock();
    let tries = 0;
    const run = await runItems(
      ["limited once"],
      async (item, requests) => {
        tries++;
        return requests.send(async () => {
          if (tries === 1) throw limited();
          return item;
        });
      },
      { wait: clock.wait, now: clock.now },
    );

    expect(run.outcomes.map((each) => each.status)).toEqual(["done"]);
    expect(tries).toBe(2);
    expect(clock.waited).toEqual([RATE_LIMIT_PAUSES_MS[0]]);
  });

  // protects=a request refused again after its stated wait isn't waited for a second time: it is thrown, so the run's pauses answer it as for any limit that holds on, and the item goes again from its start after them (#2944: a key that counts refused requests was kept refusing by every request going back at each stated time); fails_when=a request waits a second stated time, or the item is not tried again; no_claim=the length of the pauses.
  test("a request refused again after its wait falls to the run's pauses", async () => {
    const clock = steppedClock();
    let refusals = 0;
    const run = await runItems(
      ["limited twice"],
      async (item, requests) =>
        requests.send(async () => {
          if (refusals++ < 2) throw limited("30");
          return item;
        }),
      { wait: clock.wait, now: clock.now },
    );

    expect(run.outcomes.map((each) => each.status)).toEqual(["done"]);
    expect(clock.waited).toEqual([30_000, RATE_LIMIT_PAUSES_MS[0]]);
  });

  // protects=a stated wait of more than two minutes is not waited: its request is given up at once, its item fails for the rate limit and isn't tried again, and the items after it aren't sent (#2944: past two minutes the sentence is Not checked with the rate-limit reason and the later ones aren't sent); fails_when=it waits, its item starts again, or a later item is sent; no_claim=what a real key does after two minutes.
  test("a stated wait past two minutes is given up, and the items not started aren't sent", async () => {
    const clock = steppedClock();
    const sent: string[] = [];
    const run = await runItems(
      ["limited", "after it"],
      async (item, requests) =>
        requests.send(async () => {
          sent.push(item);
          if (item === "limited") throw limited("150");
          return item;
        }),
      { wait: clock.wait, now: clock.now },
    );

    expect(clock.waited).toEqual([]);
    expect(sent).toEqual(["limited"]);
    expect(run.outcomes.map((each) => each.status)).toEqual(["failed", "failed"]);
    expect(run.outcomes[0]).toMatchObject({ error: { kind: "rate-limit" } });
    expect(run.outcomes[1]).toMatchObject({ error: { kind: "rate-limit" } });
  });

  // protects=the run hears each rate limit its requests met, whether it said how long to wait or not (#2944); fails_when=a limit is missed, or counted twice; no_claim=what the run does about it.
  test("the run hears each rate limit a request met", async () => {
    const clock = steppedClock();
    let limits = 0;
    let sends = 0;
    await runItems(
      ["limited"],
      async (item, requests) =>
        requests.send(async () => {
          if (sends++ === 0) throw limited("2");
          if (sends === 2) throw limited();
          return item;
        }),
      { wait: clock.wait, now: clock.now, onLimit: () => limits++ },
    );

    expect(limits).toBeGreaterThanOrEqual(2);
  });

  // protects=a stopped run ends a request's wait at once: it is sent no more, and its item is stopped (#2944); fails_when=the request waits out the service's stated wait, or is sent after the stop; no_claim=how soon a real wait ends.
  test("stopping the run ends a request's wait, and it isn't sent again", async () => {
    const stop = new AbortController();
    let sent = 0;
    const run = await runItems(
      ["limited"],
      async (_, requests) =>
        requests.send(async () => {
          sent++;
          throw limited("40");
        }),
      {
        signal: stop.signal,
        wait: (_, signal) =>
          new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
            stop.abort();
          }),
      },
    );

    expect(sent).toBe(1);
    expect(run.outcomes.map((each) => each.status)).toEqual(["stopped"]);
  });

  // protects=the run says when its waiting ends while a request waits on a stated limit, and that it has ended after (#2944: the line reads "Rate limit reached · resumes at {time}" meanwhile); fails_when=nothing is heard, the time is not the end of the wait, or it is never heard to end; no_claim=how the line is worded.
  test("the run says when a request's wait ends, and once it has", async () => {
    const clock = steppedClock();
    const heard: (number | null)[] = [];
    await runItems(
      ["limited"],
      async (item, requests) => {
        let refused = false;
        return requests.send(async () => {
          if (refused) return item;
          refused = true;
          throw limited("40");
        });
      },
      { wait: clock.wait, now: clock.now, onPause: (until) => heard.push(until) },
    );

    expect(heard).toEqual([40_000, null]);
  });
});
