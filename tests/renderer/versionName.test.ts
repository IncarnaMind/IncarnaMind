import { describe, expect, test, vi } from "vitest";
import type { Checkpoint } from "../../src/core/api";

const bridge = vi.hoisted(() => ({
  names: [] as (string | null)[],
  hold: null as Promise<void> | null,
}));
vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => undefined,
    renameCheckpoint: async (_mindId: string, id: string, name: string | null) => {
      if (bridge.hold && name === "Second draft") await bridge.hold;
      bridge.names.push(name);
      return { ...version, id, name };
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

/* Naming a version in History (#1933): its Undo takes back the latest name first. */

describe("naming a version", () => {
  // protects=a ⌘Z pressed while a second name is still being saved waits for it and takes it back, leaving the first name, never the first undone with the second landing after (#1933); fails_when=the name left is the second; no_claim=the field's focus, which the smoke spec covers.
  test("Undo while a second name is saved takes back the second", async () => {
    const { renameVersion } = await import(
      "../../src/renderer/src/components/history/versionNames"
    );
    const { useUndo } = await import("../../src/renderer/src/undo");
    let shown: Checkpoint = version;
    const onNamed = (named: Checkpoint) => {
      shown = named;
    };
    await renameVersion("note", shown, "First draft", onNamed);
    let release: () => void = () => undefined;
    bridge.hold = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const second = renameVersion("note", shown, "Second draft", onNamed);
    const undone = useUndo.getState().undo();
    release();
    await second;
    await undone;
    expect(bridge.names).toEqual(["First draft", "Second draft", "First draft"]);
  });
});
