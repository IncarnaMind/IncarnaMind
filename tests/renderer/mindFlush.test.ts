import { describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";

/**
 * The window's changes to a Mind are sent as they are made; an ask that must
 * see them, such as a column move that copies each cell, waits for them to
 * reach the core first (flushMindUpdates).
 */
const bridge = vi.hoisted(() => ({
  applied: [] as Uint8Array[],
  release: [] as (() => void)[],
  listeners: [] as ((event: { mindId: string; update: Uint8Array }) => void)[],
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
    applyMindUpdate: async (_mindId: string, update: Uint8Array) => {
      await new Promise<void>((resolve) => bridge.release.push(resolve));
      bridge.applied.push(update);
    },
    closeMind: async () => undefined,
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
});
