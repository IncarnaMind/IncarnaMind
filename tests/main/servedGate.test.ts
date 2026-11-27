import { describe, expect, test } from "vitest";
import { createServedGate, type ServedIpc } from "../../src/preload/servedGate";

const SERVED = "host:served";

function deferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeIpc(served: Promise<void>) {
  const events: string[] = [];
  let onInvoke: ((channel: string, args: unknown[]) => Promise<unknown>) | undefined;
  let onSend: ((channel: string, args: unknown[]) => void) | undefined;
  const ipc: ServedIpc = {
    invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      if (channel === SERVED) return served as Promise<T>;
      events.push(`invoke:${channel}:${JSON.stringify(args)}`);
      if (onInvoke) return onInvoke(channel, args) as Promise<T>;
      return Promise.resolve(`ok:${channel}` as T);
    },
    send(channel: string, ...args: unknown[]): void {
      events.push(`send:${channel}:${JSON.stringify(args)}`);
      onSend?.(channel, args);
    },
  };
  return {
    ipc,
    events,
    setOnInvoke(fn: (channel: string, args: unknown[]) => Promise<unknown>) {
      onInvoke = fn;
    },
    setOnSend(fn: (channel: string, args: unknown[]) => void) {
      onSend = fn;
    },
  };
}

describe("createServedGate", () => {
  test("flushes queued calls in FIFO order before a waiting microtask can enter the direct path", async () => {
    const served = deferred<void>();
    const { ipc, events } = fakeIpc(served.promise);
    const gate = createServedGate(ipc, SERVED);

    const first = gate.invoke<string>("first", 1);
    gate.send("second", 2);
    const third = gate.invoke<string>("third", 3);
    expect(events).toEqual([]);

    // Queue a microtask right after resolving SERVED: with a bare boolean flag set before queued
    // `.then()` handlers run, this microtask would send "interleaved" ahead of the queued calls.
    served.resolve();
    const interleaved = Promise.resolve().then(() => gate.invoke<string>("interleaved", 4));

    expect(await Promise.all([first, third, interleaved])).toEqual([
      "ok:first",
      "ok:third",
      "ok:interleaved",
    ]);
    expect(events).toEqual([
      "invoke:first:[1]",
      "send:second:[2]",
      "invoke:third:[3]",
      "invoke:interleaved:[4]",
    ]);
  });

  test("forwards calls synchronously in the same turn once served", async () => {
    const served = deferred<void>();
    const { ipc, events } = fakeIpc(served.promise);
    const gate = createServedGate(ipc, SERVED);

    served.resolve();
    await Promise.resolve();

    gate.send("direct-send", "a");
    const directInvoke = gate.invoke<string>("direct-invoke", "b");
    // Both reached IPC synchronously in this turn, before any microtask runs.
    expect(events).toEqual(['send:direct-send:["a"]', 'invoke:direct-invoke:["b"]']);
    expect(await directInvoke).toBe("ok:direct-invoke");
  });

  test("keeps re-entrant calls made during the flush in FIFO order after already-queued calls", async () => {
    const served = deferred<void>();
    const { ipc, events, setOnSend } = fakeIpc(served.promise);
    const gate = createServedGate(ipc, SERVED);

    setOnSend((channel) => {
      if (channel === "one") gate.send("reentrant");
    });
    gate.send("one");
    gate.send("two");

    served.resolve();
    await Promise.resolve();

    expect(events).toEqual(["send:one:[]", "send:two:[]", "send:reentrant:[]"]);
  });

  test("keeps flushing remaining calls when one queued invoke throws synchronously", async () => {
    const served = deferred<void>();
    const { ipc, events, setOnInvoke } = fakeIpc(served.promise);
    setOnInvoke((channel) => {
      if (channel === "bad") throw new Error("sync failure");
      return Promise.resolve(`ok:${channel}`);
    });
    const gate = createServedGate(ipc, SERVED);

    const bad = gate.invoke<string>("bad");
    const good = gate.invoke<string>("good");
    gate.send("after");

    served.resolve();
    await expect(bad).rejects.toThrow("sync failure");
    expect(await good).toBe("ok:good");
    expect(events).toEqual(["invoke:bad:[]", "invoke:good:[]", "send:after:[]"]);
  });

  test("rejects queued and later invokes cleanly and drops sends if SERVED_CHANNEL rejects", async () => {
    const served = deferred<void>();
    const { ipc, events } = fakeIpc(served.promise);
    const gate = createServedGate(ipc, SERVED);

    const queued = gate.invoke("before");
    gate.send("dropped-before");
    served.reject(new Error("window closed"));

    await expect(queued).rejects.toThrow("window closed");
    gate.send("dropped-after");
    await expect(gate.invoke("after")).rejects.toThrow("window closed");
    expect(events).toEqual([]);
  });
});
