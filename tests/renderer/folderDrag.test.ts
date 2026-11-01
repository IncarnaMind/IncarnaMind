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

describe("a Folder dragged onto another (#246)", () => {
  const folder = (id: string): ObjectRef => ({ kind: "folder", id });
  const groups = (list: { id: string; name: string; parentId: string | null }[]) =>
    ({ groups: list, assignments: [] }) as never;
  /** A row 40px tall with its top at 100: its middle nests, its first and last 11px place beside. */
  const rect = () => ({ top: 100, bottom: 140, height: 40, left: 0, right: 200 }) as DOMRect;
  const middle = { x: 100, y: 120 };
  const topEdge = { x: 100, y: 104 };

  beforeAll(() => {
    store.setState({
      minds: [],
      documents: [],
      library: groups([
        { id: "thesis", name: "Thesis", parentId: null },
        { id: "chapter", name: "Chapter 2", parentId: "thesis" },
        { id: "other", name: "Other", parentId: null },
      ]),
    });
  });

  test("its middle puts it inside, and a top edge puts it beside", () => {
    const target = targets.folderTarget("chapter", rect);
    expect(target.accepts({ kind: "objects", refs: [folder("other")] }, middle)).toMatchObject({
      kind: "move",
      place: "into",
    });
    expect(target.accepts({ kind: "objects", refs: [folder("other")] }, topEdge)).toMatchObject({
      kind: "move",
      place: "before",
    });
  });

  test("a Folder can't go inside itself or one of its own sub-Folders, and the row says why", () => {
    const intoItsOwnSubfolder = targets.folderTarget("chapter", rect);
    const dragged = { kind: "objects" as const, refs: [folder("thesis")] };
    expect(intoItsOwnSubfolder.accepts(dragged, middle)).toBeNull();
    expect(intoItsOwnSubfolder.refuses?.(dragged, middle)).toBeTypeOf("function");
    // Beside its own sub-Folder is inside itself too: Chapter 2's parent is Thesis.
    expect(intoItsOwnSubfolder.accepts(dragged, topEdge)).toBeNull();
    expect(intoItsOwnSubfolder.refuses?.(dragged, topEdge)).toBeTypeOf("function");

    const itself = targets.folderTarget("thesis", rect);
    expect(itself.accepts({ kind: "objects", refs: [folder("thesis")] }, middle)).toBeNull();
    expect(itself.refuses?.({ kind: "objects", refs: [folder("thesis")] }, middle)).toBeTypeOf(
      "function",
    );
  });

  test("a Folder already inside one takes no drop there, and one going out changes where it is", () => {
    // Chapter 2 is already in Thesis: its middle is no move, and nothing is refused.
    const thesis = targets.folderTarget("thesis", rect);
    const chapter = { kind: "objects" as const, refs: [folder("chapter")] };
    expect(thesis.accepts(chapter, middle)).toBeNull();
    expect(thesis.refuses?.(chapter, middle)).toBeNull();
    // The top level takes a Folder out of its Folder.
    expect(targets.folderTopTarget().accepts(chapter, middle)).toMatchObject({ kind: "move" });
    expect(
      targets.folderTopTarget().accepts({ kind: "objects", refs: [folder("thesis")] }, middle),
    ).toBeNull();
  });
});
