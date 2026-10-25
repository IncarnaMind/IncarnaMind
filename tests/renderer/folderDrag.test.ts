import { beforeAll, describe, expect, test } from "vitest";
import type { Dragged } from "../../src/renderer/src/dragDrop";
import type { ObjectRef } from "../../src/renderer/src/objects";

type Store = typeof import("../../src/renderer/src/store");
type Targets = typeof import("../../src/renderer/src/folderDrag");
let store: Store["useAppStore"];
let targets: Targets;

beforeAll(async () => {
  // The store reads the bridge the preload exposes.
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  store = (await import("../../src/renderer/src/store")).useAppStore;
  targets = await import("../../src/renderer/src/folderDrag");
});

const doc = (id: string): ObjectRef => ({ kind: "document", id });
const at = { x: 0, y: 0 };
const library = (assignments: { documentId: string; groupId: string }[]) =>
  ({ groups: [{ id: "f", name: "Finance" }], assignments }) as never;
const tagged = (id: string, tagId: string | null) =>
  ({ id, tags: tagId ? [{ tagId, source: "user", needsReview: false }] : [] }) as never;

describe("the Folder and Tag targets", () => {
  test("answer from the Library as it is now, for the same drag, after it changes mid-drag", () => {
    const dragged: Dragged = { kind: "objects", refs: [doc("a"), doc("b")] };
    store.setState({
      minds: [],
      documents: [tagged("a", null), tagged("b", null)],
      library: library([]),
    });
    expect(targets.folderTarget("f").accepts(dragged, at)).not.toBeNull();
    expect(targets.folderTarget(null).accepts(dragged, at)).toBeNull();

    store.setState({
      library: library([
        { documentId: "a", groupId: "f" },
        { documentId: "b", groupId: "f" },
      ]),
    });
    expect(targets.folderTarget("f").accepts(dragged, at)).toBeNull();
    expect(targets.folderTarget(null).accepts(dragged, at)).not.toBeNull();
  });

  test("a Document waiting in a Suggested Folder can be moved into it, which accepts it", () => {
    const dragged: Dragged = { kind: "objects", refs: [doc("a")] };
    store.setState({
      minds: [],
      documents: [tagged("a", null)],
      library: {
        groups: [{ id: "f", name: "Finance" }],
        assignments: [{ documentId: "a", groupId: "f", suggested: true }],
      } as never,
    });
    expect(targets.folderTarget("f").accepts(dragged, at)).not.toBeNull();
    expect(targets.folderTarget(null).accepts(dragged, at)).not.toBeNull();

    store.setState({
      library: {
        groups: [{ id: "f", name: "Finance" }],
        assignments: [{ documentId: "a", groupId: "f", suggested: false }],
      } as never,
    });
    expect(targets.folderTarget("f").accepts(dragged, at)).toBeNull();
  });

  test("a Tag takes Documents that don't have it yet, and nothing once they all do", () => {
    const dragged: Dragged = { kind: "objects", refs: [doc("a"), doc("b")] };
    store.setState({ documents: [tagged("a", "t"), tagged("b", null)] });
    expect(targets.tagTarget("t").accepts(dragged, at)).not.toBeNull();
    store.setState({ documents: [tagged("a", "t"), tagged("b", "t")] });
    expect(targets.tagTarget("t").accepts(dragged, at)).toBeNull();
    expect(
      targets
        .tagTarget("t")
        .accepts({ kind: "objects", refs: [doc("a"), { kind: "mind", id: "m" }] }, at),
    ).toBeNull();
  });
});
