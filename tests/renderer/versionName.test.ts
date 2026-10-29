import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Checkpoint } from "../../src/core/api";

const bridge = vi.hoisted(() => ({
  name: null as string | null,
  held: new Map<string, Promise<void>>(),
}));
vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => undefined,
    renameCheckpoint: async (_mindId: string, id: string, name: string | null) => {
      const held = name === null ? undefined : bridge.held.get(name);
      if (held) await held;
      const was = bridge.name;
      bridge.name = name;
      return { checkpoint: { ...version, id, name }, was };
    },
  },
}));

const version: Checkpoint = {
  id: "version-1",
  mindId: "note",
  reason: "export",
  createdAt: "2026-10-28T09:00:00.000Z",
  name: null,
  file: "Credit paper.docx",
};

/* Naming a version in History (#1933): its Undo takes the names back in the order they were given. */

const hold = (name: string) => {
  let release: () => void = () => undefined;
  bridge.held.set(
    name,
    new Promise<void>((resolve) => {
      release = () => resolve();
    }),
  );
  return () => release();
};

const naming = async () => {
  const { renameVersion } = await import("../../src/renderer/src/components/history/versionNames");
  const { useUndo } = await import("../../src/renderer/src/undo");
  return { renameVersion, undo: () => useUndo.getState().undo() };
};

describe("naming a version", () => {
  beforeEach(async () => {
    bridge.name = null;
    bridge.held.clear();
    const { useUndo } = await import("../../src/renderer/src/undo");
    useUndo.setState({ done: [], undone: [] });
  });

  // protects=a ⌘Z pressed while a second name is still being saved waits for it and takes it back, leaving the first name, never the first undone with the second landing after (#1933); fails_when=the name left is the second; no_claim=the field's focus, which the smoke spec covers.
  test("Undo while a second name is saved takes back the second", async () => {
    const { renameVersion, undo } = await naming();
    let shown: Checkpoint = version;
    const onNamed = (named: Checkpoint) => {
      shown = named;
    };
    await renameVersion("note", shown, "First draft", onNamed);
    const release = hold("Second draft");
    const second = renameVersion("note", shown, "Second draft", onNamed);
    const undone = undo();
    release();
    await second;
    await undone;
    expect(bridge.name).toBe("First draft");
  });

  // protects=a second name given while the first is still being saved, from the version as History showed it before either landed, is taken back by ⌘Z to the first, in the order the User named them (#1933), in English and Chinese; fails_when=⌘Z leaves the version unnamed; no_claim=names given on another device.
  test.each([
    { language: "en", first: "First draft", second: "Second draft" },
    { language: "zh-CN", first: "初稿", second: "二稿" },
  ])(
    "Undo after two names given at once takes back the second ($language)",
    async ({ first, second }) => {
      const { renameVersion, undo } = await naming();
      const release = hold(first);
      const onNamed = () => undefined;
      const naming1 = renameVersion("note", version, first, onNamed);
      const naming2 = renameVersion("note", version, second, onNamed);
      release();
      await naming1;
      await naming2;
      expect(bridge.name).toBe(second);
      await undo();
      expect(bridge.name).toBe(first);
      await undo();
      expect(bridge.name).toBeNull();
    },
  );
});
