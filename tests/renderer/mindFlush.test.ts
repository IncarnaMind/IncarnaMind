import { describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { TranslatableError } from "../../src/core/errors";

/**
 * The window's changes to a Mind are sent as they are made; an ask that must
 * see them, such as a column move that copies each cell, waits for them to
 * reach the core first (flushMindUpdates).
 */
interface PendingSave {
  mindId: string;
  update: Uint8Array;
  resolve(): void;
  reject(error: unknown): void;
}

const bridge = vi.hoisted(() => ({
  applied: [] as Uint8Array[],
  release: [] as (() => void)[],
  pending: [] as PendingSave[],
  listeners: [] as ((event: { mindId: string; update: Uint8Array }) => void)[],
  watched: [] as string[],
  unwatched: [] as string[],
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: (listener: (event: { mindId: string; update: Uint8Array }) => void) => {
      bridge.listeners.push(listener);
      return () => {
        bridge.listeners = bridge.listeners.filter((each) => each !== listener);
      };
    },
    // A Yjs update of an empty document: two zero bytes.
    openMind: async () => ({ state: new Uint8Array([0, 0]), access: "edit" }),
    applyMindUpdate: async (mindId: string, update: Uint8Array) => {
      await new Promise<void>((resolve, reject) => {
        bridge.release.push(resolve);
        bridge.pending.push({ mindId, update, resolve, reject });
      });
      bridge.applied.push(update);
    },
    closeMind: async () => undefined,
    watchComparisonMind: async ({ mindId }: { mindId: string }) => {
      bridge.watched.push(mindId);
    },
    unwatchComparisonMind: async ({ mindId }: { mindId: string }) => {
      bridge.unwatched.push(mindId);
    },
  },
  files: {},
}));

import { flushMindUpdates, type OpenedCopy, openMindCopy } from "../../src/renderer/src/mindCopies";

describe("A window's changes to a Mind", () => {
  test("flushMindUpdates waits until the changes sent before it have reached the core", async () => {
    const copy = await new Promise<OpenedCopy>((resolve, reject) => {
      const close = openMindCopy("mind-1", resolve, reject);
      onTestFinished(close);
    });
    const doc = copy.doc;
    if (!doc) throw new Error("The Mind didn't open.");
    doc.transact(() => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText("typed just before the move")]);
      doc.getXmlFragment("content").push([paragraph]);
    });
    let flushed = false;
    const waiting = flushMindUpdates("mind-1").then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(bridge.applied).toEqual([]);
    for (const release of bridge.release) release();
    await waiting;
    expect(flushed).toBe(true);
    expect(bridge.applied).toHaveLength(1);
  });

  test("two copies of one Mind in a window watch once, and the last close lets go", async () => {
    bridge.watched.length = 0;
    bridge.unwatched.length = 0;
    const open = () =>
      new Promise<{ copy: OpenedCopy; close: () => void }>((resolve, reject) => {
        const close = openMindCopy("mind-2", (copy) => resolve({ copy, close }), reject);
      });
    const first = await open();
    const second = await open();
    expect(bridge.watched).toEqual(["mind-2"]);
    first.close();
    expect(bridge.unwatched).toEqual([]);
    second.close();
    expect(bridge.unwatched).toEqual(["mind-2"]);
    expect(bridge.watched).toEqual(["mind-2"]);
  });

  // protects=a failed missedChange retry resolves the original entry false so flushMindUpdates never reports true while a second save on the same Note is pending (#3839); fails_when=the retry finalizer drops its entry while the original resolves true
  test("flushMindUpdates returns false when a missedChange retry fails while another save is pending", async () => {
    bridge.pending.length = 0;
    const failures: unknown[] = [];
    const copy = await new Promise<OpenedCopy>((resolve) => {
      const close = openMindCopy("mind-retry-fail", resolve, (error) => failures.push(error));
      onTestFinished(close);
    });
    const doc = copy.doc;
    if (!doc) throw new Error("The Mind didn't open.");
    const text = new Y.XmlText("Start");
    doc.transact(() => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [text]);
      doc.getXmlFragment("content").push([paragraph]);
    });
    doc.transact(() => {
      text.insert(text.length, " more");
    });

    const [firstSave, secondSave] = bridge.pending;
    if (!firstSave || !secondSave) throw new Error("Expected two pending saves.");

    const flushed = flushMindUpdates("mind-retry-fail");
    firstSave.reject(new TranslatableError({ key: "error.mind.missedChange" }));
    await vi.waitFor(() => expect(bridge.pending).toHaveLength(3));
    const retrySave = bridge.pending[2];
    if (!retrySave) throw new Error("Expected missedChange retry save.");

    const retryError = new Error("Disk full on retry");
    retrySave.reject(retryError);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    secondSave.resolve();
    expect(await flushed).toBe(false);
    expect(failures).toEqual([retryError]);
  });

  // protects=a successful missedChange retry keeps flushMindUpdates waiting until the retry completes and resolves true while a second save on the same Note is pending (#3839); fails_when=flushMindUpdates returns early or reports false on recovered retry
  test("flushMindUpdates waits for a successful missedChange retry alongside another save and returns true", async () => {
    bridge.pending.length = 0;
    const failures: unknown[] = [];
    const copy = await new Promise<OpenedCopy>((resolve) => {
      const close = openMindCopy("mind-retry-ok", resolve, (error) => failures.push(error));
      onTestFinished(close);
    });
    const doc = copy.doc;
    if (!doc) throw new Error("The Mind didn't open.");
    const text = new Y.XmlText("Start");
    doc.transact(() => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [text]);
      doc.getXmlFragment("content").push([paragraph]);
    });
    doc.transact(() => {
      text.insert(text.length, " more");
    });

    const [firstSave, secondSave] = bridge.pending;
    if (!firstSave || !secondSave) throw new Error("Expected two pending saves.");

    let settled = false;
    const flushed = flushMindUpdates("mind-retry-ok").then((ok) => {
      settled = true;
      return ok;
    });
    firstSave.reject(new TranslatableError({ key: "error.mind.missedChange" }));
    await vi.waitFor(() => expect(bridge.pending).toHaveLength(3));
    const retrySave = bridge.pending[2];
    if (!retrySave) throw new Error("Expected missedChange retry save.");

    secondSave.resolve();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(settled).toBe(false);

    retrySave.resolve();
    expect(await flushed).toBe(true);
    expect(failures).toEqual([]);
  });
});
