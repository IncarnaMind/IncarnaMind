import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { type Core, DATABASE_FILE, MIND_CONTENT_FIELD } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { errorForWindow } from "../../src/shared/errorWording";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * A window's copy of a Mind after a change the core couldn't take (#1119): the
 * real core behind the bridge, its errors as the window gets them, the window's
 * own copy, and a restart to see what was stored.
 */

const bridge = vi.hoisted(() => ({
  core: null as Core | null,
  /** Calls of applyMindUpdate, and how many to drop before or after they reach the core. */
  calls: 0,
  droppedBefore: 0,
  droppedAfter: 0,
}));

const coreOf = () => {
  if (!bridge.core) throw new Error("No core.");
  return bridge.core;
};

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: (...args: Parameters<Core["on"]>) => coreOf().on(...args),
    openMind: (mindId: string) => coreOf().openMind(mindId),
    closeMind: (mindId: string) => coreOf().closeMind(mindId),
    applyMindUpdate: async (mindId: string, update: Uint8Array) => {
      bridge.calls += 1;
      if (bridge.droppedBefore > 0) {
        bridge.droppedBefore -= 1;
        throw new Error("The message was lost.");
      }
      try {
        await coreOf().applyMindUpdate(mindId, update);
      } catch (error) {
        throw errorForWindow(error);
      }
      if (bridge.droppedAfter > 0) {
        bridge.droppedAfter -= 1;
        throw new Error("The reply was lost.");
      }
    },
    watchComparisonMind: async () => undefined,
    unwatchComparisonMind: async () => undefined,
  },
}));

const { openMindCopy } = await import("../../src/renderer/src/mindCopies");

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getXmlFragment(MIND_CONTENT_FIELD).toString();
};

/** A Mind open in a window's copy, holding "BASE" once stored, and a way to type at its end. */
async function openCopy(dataDir: string) {
  const core = startCore(dataDir);
  bridge.core = core;
  const mind = await core.createMind({ title: "Notes" });
  const failures: unknown[] = [];
  const doc = await new Promise<Y.Doc>((resolve, reject) => {
    openMindCopy(
      mind.id,
      (copy) => (copy.doc ? resolve(copy.doc) : reject(new Error("No copy."))),
      (error) => failures.push(error),
    );
  });
  const held = () => core.openMind(mind.id).then(({ state }) => textOf(state));
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText("BASE");
  paragraph.insert(0, [text]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
  await vi.waitFor(async () => expect(await held()).toBe("<paragraph>BASE</paragraph>"));
  bridge.calls = 0;
  return {
    core,
    mindId: mind.id,
    failures,
    held,
    type: (words: string) => text.insert(text.length, words),
  };
}

async function afterRestart(dataDir: string, mindId: string): Promise<string> {
  return textOf((await startCore(dataDir).openMind(mindId)).state);
}

describe("A window's copy after a change the core couldn't take (#1119)", () => {
  // protects=the issue's case: storage refuses a write, comes back, and the typing after it is stored with the refused change, there after a restart; the window isn't told a change failed, as the core keeps it; fails_when=the later typing shows in the window but is gone after a restart; no_claim=a real full disk.
  test("typing after a refused write is stored with it", async () => {
    const dataDir = await createTempDataFolder();
    const copy = await openCopy(dataDir);
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.exec(
      "CREATE TRIGGER fail_writes BEFORE INSERT ON mind_updates BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END",
    );

    copy.type(" LOST");
    await vi.waitFor(async () => expect(await copy.core.unsavedChanges()).not.toBeNull());
    db.exec("DROP TRIGGER fail_writes");
    db.close();
    copy.type(" AFTER");
    await vi.waitFor(async () => expect(await copy.core.unsavedChanges()).toBeNull());
    copy.core.close();

    expect(copy.failures).toEqual([]);
    expect(await afterRestart(dataDir, copy.mindId)).toBe("<paragraph>BASE LOST AFTER</paragraph>");
  });

  // protects=a change that never reached the core goes again inside the whole copy once the core says a later one builds on it, so all of it is stored; fails_when=the lost change, and every change after it, never reach storage; no_claim=none beyond protects.
  test("a change that never reached the core goes again in the whole copy", async () => {
    const dataDir = await createTempDataFolder();
    const copy = await openCopy(dataDir);

    bridge.droppedBefore = 1;
    copy.type(" ONE");
    await vi.waitFor(() => expect(copy.failures).toHaveLength(1));
    copy.type(" TWO");
    await vi.waitFor(async () =>
      expect(await copy.held()).toBe("<paragraph>BASE ONE TWO</paragraph>"),
    );
    copy.core.close();

    expect(await afterRestart(dataDir, copy.mindId)).toBe("<paragraph>BASE ONE TWO</paragraph>");
  });

  // protects=a failure that isn't a missed change doesn't send the whole copy again: the core already holds the change; fails_when=every refusal sends the whole Mind (100 keystrokes of a 1 MB Mind: 100 MB); no_claim=none beyond protects.
  test("any other failure sends nothing again", async () => {
    const dataDir = await createTempDataFolder();
    const copy = await openCopy(dataDir);

    bridge.droppedAfter = 1;
    copy.type(" ONE");
    await vi.waitFor(() => expect(copy.failures).toHaveLength(1));
    copy.type(" TWO");
    await vi.waitFor(async () =>
      expect(await copy.held()).toBe("<paragraph>BASE ONE TWO</paragraph>"),
    );

    expect(bridge.calls).toBe(2);
  });
});
