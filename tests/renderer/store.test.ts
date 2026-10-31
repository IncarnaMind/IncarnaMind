import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type CoreEventName,
  type CoreEvents,
  DEFAULT_ASSISTANT,
  type DeletedItem,
  type Document,
  type DocumentGroupAssignment,
  type Folder,
  type LibrarySnapshot,
  type Mind,
  type MovedDocument,
  type WindowLayout,
} from "../../src/core/api";
import type { Translate } from "../../src/renderer/src/objects";
import { translate } from "../../src/shared/i18n";
import { isFreed } from "../helpers/freed";
import { undoLines } from "../helpers/undoLines";

/*
 * The store follows the core's events (#156): per-Document ones are gathered
 * and applied together, Library assignments in place, without reading the
 * whole Library again. The store reads the bridge the preload exposes, so a
 * fake one stands in for it here.
 */

const listeners = new Map<string, ((payload: unknown) => void)[]>();
const methods = new Map<string, ReturnType<typeof vi.fn>>();
const bridge = new Proxy(
  {
    on(event: string, listener: (payload: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => undefined;
    },
  },
  {
    get(target, name: string) {
      if (name === "on") return target.on;
      let method = methods.get(name);
      if (!method) {
        method = vi.fn(async () => undefined);
        methods.set(name, method);
      }
      return method;
    },
  },
);

function emit<E extends CoreEventName>(event: E, payload: CoreEvents[E]) {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}

const method = (name: string) => {
  // Reading it through the bridge makes it if it isn't there yet.
  (bridge as unknown as Record<string, unknown>)[name];
  return methods.get(name) as ReturnType<typeof vi.fn>;
};

const doc = (id: string, version = 0) =>
  ({ id, name: `${id} v${version}`, tags: [], linkedFolderId: null }) as unknown as Document;

const assignment = (
  documentId: string,
  status: DocumentGroupAssignment["status"],
  groupId: string | null = null,
): DocumentGroupAssignment => ({
  documentId,
  groupId,
  source: "automatic",
  suggested: false,
  status,
  error: null,
  model: null,
});

/** A Document a move moved, with the rows before and after as the core returns them. */
const movedDocument = (
  id: string,
  from: string | null,
  before: DocumentGroupAssignment | null,
  to: string | null,
): MovedDocument => {
  const state = (item: DocumentGroupAssignment | null) => {
    if (!item) return { assignment: null, tagging: null };
    const { documentId: _id, tagging: _tagging, ...fields } = item;
    return { assignment: fields, tagging: null };
  };
  return {
    id,
    from,
    change: {
      documentId: id,
      before: state(before),
      after: state({
        documentId: id,
        groupId: to,
        source: "user",
        suggested: false,
        status: "classified",
        error: null,
        model: null,
      }),
    },
  };
};

const researchGroup = (keepInside = false) => ({
  id: "g",
  name: "Research",
  description: "",
  countsOwnFiles: false,
  keepInside,
  createdAt: "",
  updatedAt: "",
});

const snapshot = (assignments: DocumentGroupAssignment[]): LibrarySnapshot => ({
  groups: [researchGroup()],
  deletedGroups: [],
  assignments,
  settings: {
    classifier: { kind: "automatic" },
    automatic: false,
    organizeWith: null,
    taggingStopped: [],
  },
  automaticDefault: false,
});

let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;
let words: Translate;
let said: ReturnType<typeof undoLines>["said"];
let named: ReturnType<typeof undoLines>["named"];

beforeAll(async () => {
  // One clock for the file: the store remembers when it last changed, from one test to the next.
  vi.useFakeTimers();
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: {},
  };
  ({ useAppStore } = await import("../../src/renderer/src/store"));
  ({ translateNow: words } = await import("../../src/renderer/src/i18n"));
  ({ said, named } = undoLines(words));
});

afterAll(() => {
  vi.useRealTimers();
});

/** Lets the promises already settled run on (a reply from the bridge, and what awaits it). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  // A quiet spell, so each test starts with nothing waiting.
  vi.advanceTimersByTime(1000);
  for (const each of methods.values()) each.mockReset();
  method("restore").mockResolvedValue({ audioLost: [] });
  useAppStore.setState({
    documents: [doc("a"), doc("b"), doc("c")],
    library: snapshot([assignment("a", "pending"), assignment("b", "pending")]),
  });
});

describe("the store follows the core's per-Document events", () => {
  test("a burst changes the store once, each Document to its latest copy, the rest untouched", () => {
    const before = useAppStore.getState().documents;
    const updates = vi.fn();
    const stop = useAppStore.subscribe(updates);
    emit("document.status", doc("a", 1));
    emit("documents.tagged", [doc("a", 2), doc("b", 1)]);
    emit("document.status", doc("x", 1));
    emit("documents.moved", [doc("b", 2)]);
    // Nothing yet: the events wait for the next update.
    expect(useAppStore.getState().documents).toBe(before);
    vi.advanceTimersByTime(100);
    stop();
    expect(updates).toHaveBeenCalledTimes(1);
    const after = useAppStore.getState().documents;
    expect(after.map((each) => each.name)).toEqual(["x v1", "a v2", "b v2", "c v0"]);
    expect(after[3]).toBe(before[2]);
  });

  test("events coming fast are gathered: at most one store update per 100ms", () => {
    const updates = vi.fn();
    const stop = useAppStore.subscribe(updates);
    for (let i = 1; i <= 300; i++) {
      emit("documents.tagged", [doc(i % 2 ? "a" : "b", i)]);
      emit("library.assignments", [assignment(i % 2 ? "a" : "b", "classifying")]);
      vi.advanceTimersByTime(2);
    }
    vi.advanceTimersByTime(100);
    stop();
    // 600 events over 600ms: about one update each 100ms, not one each.
    expect(updates.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(updates.mock.calls.length).toBeLessThanOrEqual(9);
    const { documents } = useAppStore.getState();
    expect(documents.find((each) => each.id === "a")?.name).toBe("a v299");
    expect(documents.find((each) => each.id === "b")?.name).toBe("b v300");
  });

  test("removed Documents go, even with a change to them still waiting", () => {
    emit("documents.tagged", [doc("a", 1)]);
    emit("documents.removed", ["a", "c"]);
    vi.advanceTimersByTime(100);
    expect(useAppStore.getState().documents.map((each) => each.id)).toEqual(["b"]);
  });

  test("a change the User makes isn't undone by an older event still waiting", async () => {
    emit("document.status", doc("a", 1));
    method("renameDocument").mockResolvedValue({ ...doc("a", 2), name: "Renamed" });
    await useAppStore.getState().renameDocument("a", "Renamed");
    vi.advanceTimersByTime(1000);
    expect(useAppStore.getState().documents.find((each) => each.id === "a")?.name).toBe("Renamed");
  });
});

describe("the store follows the Library's assignments", () => {
  test("they change in place, without reading the whole Library again", () => {
    const before = useAppStore.getState().library;
    emit("library.assignments", [assignment("b", "classified", "g"), assignment("c", "pending")]);
    vi.advanceTimersByTime(100);
    const library = useAppStore.getState().library;
    expect(method("getLibrary")).not.toHaveBeenCalled();
    expect(
      library?.assignments.map((each) => [each.documentId, each.status, each.groupId]),
    ).toEqual([
      ["a", "pending", null],
      ["b", "classified", "g"],
      ["c", "pending", null],
    ]);
    expect(library?.assignments[0]).toBe(before?.assignments[0]);
    expect(library?.groups).toBe(before?.groups);
  });

  test("a change to the Folders reads the Library again, and older assignments don't land on it", async () => {
    // Waiting, not yet applied: the snapshot read after it has it already, and newer.
    emit("library.assignments", [assignment("a", "classifying")]);
    method("getLibrary").mockResolvedValue(
      snapshot([assignment("a", "classified", "g"), assignment("b", "pending")]),
    );
    emit("library.changed", null);
    expect(method("getLibrary")).toHaveBeenCalledTimes(1);
    await settle();
    expect(useAppStore.getState().library?.assignments[0]?.status).toBe("classified");
    vi.advanceTimersByTime(1000);
    expect(useAppStore.getState().library?.assignments[0]).toMatchObject({
      status: "classified",
      groupId: "g",
    });
    // Assignments after the snapshot change it as usual.
    emit("library.assignments", [assignment("b", "failed")]);
    vi.advanceTimersByTime(1000);
    expect(useAppStore.getState().library?.assignments[1]?.status).toBe("failed");
  });

  test("before the Library is loaded, its assignments wait for the snapshot loading reads", () => {
    useAppStore.setState({ library: null });
    emit("library.assignments", [assignment("a", "classified")]);
    emit("documents.tagged", [doc("a", 1)]);
    vi.advanceTimersByTime(100);
    expect(useAppStore.getState().library).toBeNull();
    expect(useAppStore.getState().documents[0]?.name).toBe("a v1");
  });
});

describe("undoing a move", () => {
  test("moves each Mind back, and puts each Document's assignment back with who chose it", async () => {
    const { useUndo } = await import("../../src/renderer/src/undo");
    const filed = assignment("a", "classified", "g");
    useAppStore.setState({
      minds: [
        {
          id: "m",
          title: "Plan",
          autoTitle: "",
          kind: "mind",
          folderId: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
      library: snapshot([filed]),
    });
    const moved = movedDocument("a", "g", filed, "h");
    method("moveToFolder").mockResolvedValue({
      folderId: "h",
      minds: [{ id: "m", from: null }],
      documents: [moved],
      conversations: [],
    });

    await useAppStore.getState().moveToFolder({ mindIds: ["m"], documentIds: ["a"] }, "h");
    await useUndo.getState().undo();

    expect(method("moveToFolder")).toHaveBeenLastCalledWith({
      mindIds: ["m"],
      documentIds: [],
      conversationIds: [],
      folderId: null,
    });
    expect(method("restoreAssignment")).toHaveBeenCalledWith(
      "a",
      moved.change.before,
      moved.change.after,
    );
  });
});

describe("changes the User can take back", () => {
  const mind = {
    id: "m",
    title: "Plan",
    autoTitle: "",
    kind: "mind" as const,
    folderId: null,
    createdAt: "",
    updatedAt: "",
  };
  let useUndo: typeof import("../../src/renderer/src/undo").useUndo;

  beforeAll(async () => {
    ({ useUndo } = await import("../../src/renderer/src/undo"));
  });

  beforeEach(() => {
    useUndo.setState({ done: [], undone: [], line: null });
    useAppStore.setState({ minds: [mind], settings: null });
  });

  const top = () => useUndo.getState().done.at(-1);

  test("a Folder wall is undone and redone with its other fields intact", async () => {
    const group = researchGroup(false);
    useAppStore.setState({ library: { ...snapshot([]), groups: [group] } });
    method("updateLibraryGroup").mockResolvedValue({ ...group, keepInside: true });
    await useAppStore.getState().editFolder("g", {
      name: group.name,
      description: group.description,
      countsOwnFiles: group.countsOwnFiles,
      keepInside: true,
    });
    expect(said(top())).toBe("“Research” now keeps its work inside it");
    expect(undoLines((key, params) => translate("zh-CN", key, params)).said(top())).toBe(
      "已开启“Research”只在本文件夹内工作",
    );

    useAppStore.setState({
      library: { ...snapshot([]), groups: [{ ...group, keepInside: true }] },
    });
    method("updateLibraryGroup").mockResolvedValue({ ...group, keepInside: false });
    await useAppStore.getState().editFolder("g", {
      name: group.name,
      description: group.description,
      countsOwnFiles: group.countsOwnFiles,
      keepInside: false,
    });
    expect(said(top())).toBe("“Research” no longer keeps its work inside it");
    expect(undoLines((key, params) => translate("zh-CN", key, params)).said(top())).toBe(
      "已关闭“Research”只在本文件夹内工作",
    );
    useAppStore.setState({ library: { ...snapshot([]), groups: [group] } });
    method("updateLibraryGroup").mockResolvedValue({ ...group, keepInside: true });
    await useAppStore.getState().editFolder("g", {
      name: group.name,
      description: group.description,
      countsOwnFiles: group.countsOwnFiles,
      keepInside: true,
    });
    expect(method("updateLibraryGroup")).toHaveBeenLastCalledWith("g", {
      name: group.name,
      description: group.description,
      countsOwnFiles: group.countsOwnFiles,
      keepInside: true,
    });
    await useUndo.getState().undo();
    expect(method("updateLibraryGroup")).toHaveBeenLastCalledWith("g", {
      name: group.name,
      description: group.description,
      countsOwnFiles: group.countsOwnFiles,
      keepInside: false,
    });
    await useUndo.getState().redo();
    expect(method("updateLibraryGroup")).toHaveBeenLastCalledWith("g", {
      name: group.name,
      description: group.description,
      countsOwnFiles: group.countsOwnFiles,
      keepInside: true,
    });
  });

  test("moving out of a walled Folder says what changed", async () => {
    const group = researchGroup(true);
    const filed = assignment("a", "classified", "g");
    useAppStore.setState({ library: { ...snapshot([filed]), groups: [group] } });
    method("moveToFolder").mockResolvedValue({
      folderId: null,
      minds: [],
      documents: [movedDocument("a", "g", filed, null)],
      conversations: [],
    });
    await useAppStore.getState().moveToFolder({ documentIds: ["a"] }, null);
    expect(said(top())).toContain("no longer limited to that Folder’s Documents and notes");
  });

  test("making a Folder with an item from a walled Folder says it moved out", async () => {
    const group = researchGroup(true);
    const filed = assignment("a", "classified", "g");
    useAppStore.setState({ library: { ...snapshot([filed]), groups: [group] } });
    method("createLibraryGroup").mockResolvedValue({ ...researchGroup(), id: "n", name: "New" });
    method("moveToFolder").mockResolvedValue({
      folderId: "n",
      minds: [],
      documents: [movedDocument("a", "g", filed, "n")],
      conversations: [],
    });
    await useAppStore.getState().createFolder({ documentIds: ["a"] }, "New");
    expect(said(top())).toContain("no longer limited to that Folder’s Documents and notes");
  });

  test("a rename says so, is undone by the old name and done again by the new", async () => {
    method("renameMind").mockResolvedValue({ ...mind, title: "Budget" });
    await useAppStore.getState().renameMind("m", "Budget");
    expect(said(top())).toBe("Renamed to “Budget”");
    expect(named(top())).toBe("Rename");
    await useUndo.getState().undo();
    expect(method("renameMind")).toHaveBeenLastCalledWith("m", "Plan");
    await useUndo.getState().redo();
    expect(method("renameMind")).toHaveBeenLastCalledWith("m", "Budget");
  });

  test("a delete asks nothing, says it went to Recently deleted, is undone by restoring it and done again", async () => {
    await useAppStore.getState().deleteDocuments(["a"]);
    expect(said(top())).toBe("Moved “a v0” to Recently deleted");
    expect(useAppStore.getState().documents.map((each) => each.id)).toEqual(["b", "c"]);
    await useUndo.getState().undo();
    expect(method("restore")).toHaveBeenCalledWith([{ kind: "document", id: "a" }], {
      reopen: true,
    });
    await useUndo.getState().redo();
    expect(method("deleteDocuments")).toHaveBeenCalledTimes(2);
  });

  // protects=deleting several Documents is one call to the core and one change, said by their count (#1349); fails_when=the core is asked once per Document, which took 90 s for 1,700; no_claim=how long the core takes.
  test("several Documents deleted together are one call and one change, said by their count", async () => {
    await useAppStore.getState().deleteDocuments(["a", "b"]);
    expect(method("deleteDocuments")).toHaveBeenCalledTimes(1);
    expect(method("deleteDocuments")).toHaveBeenCalledWith(["a", "b"]);
    expect(said(top())).toBe("Moved 2 Documents to Recently deleted");
    expect(named(top())).toBe("Delete 2 Documents");
    expect(useAppStore.getState().documents.map((each) => each.id)).toEqual(["c"]);
    await useUndo.getState().undo();
    expect(method("restore")).toHaveBeenCalledWith(
      [
        { kind: "document", id: "a" },
        { kind: "document", id: "b" },
      ],
      { reopen: true },
    );
  });

  const slow = () => {
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { done, finish };
  };
  const note = () => useUndo.getState().line?.note?.(words);
  const ids = () => useAppStore.getState().documents.map((each) => each.id);

  // protects=a delete still going after a second says so where its result will show, until it is done, and its Undo puts every row back at once, in its place, before the core answers (#1349); fails_when=nothing shows meanwhile, the note outlives the delete, or the rows wait for the core; no_claim=how long the core takes.
  test("a delete that takes longer than a second says so until it is done, and its Undo puts the rows back at once", async () => {
    const deleting = slow();
    method("deleteDocuments").mockReturnValue(deleting.done);
    const deleted = useAppStore.getState().deleteDocuments(["a", "b"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(note()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(note()).toBe("Moving 2 Documents to Recently deleted…");
    deleting.finish();
    await deleted;
    expect(said(useUndo.getState().line?.change)).toBe("Moved 2 Documents to Recently deleted");
    expect(ids()).toEqual(["c"]);

    const restoring = slow();
    method("restore").mockReturnValue(restoring.done.then(() => ({ audioLost: [] })));
    const undone = useUndo.getState().undo();
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["a", "b", "c"]);
    restoring.finish();
    await undone;
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  // protects=an Undo the core refuses takes the rows it put back out again, and says why; fails_when=the rows stay though the Documents are still deleted; no_claim=none beyond protects.
  test("an Undo the core refuses takes the rows out again", async () => {
    await useAppStore.getState().deleteDocuments(["a", "b"]);
    method("restore").mockRejectedValue(new Error("The folder was unlinked."));
    await useUndo.getState().undo();
    expect(ids()).toEqual(["c"]);
    expect(useUndo.getState().line?.problem?.step).toBe("undo");
  });

  // protects=a second ⌘⌫ on the same Documents while the first delete runs finds nothing left to delete, and says nothing wrong (#1349); fails_when=the core is asked twice and the second fails with "There is no such Document"; no_claim=none beyond protects.
  test("a second delete of the same Documents during the first does nothing", async () => {
    const deleting = slow();
    method("deleteDocuments").mockReturnValue(deleting.done);
    const first = useAppStore.getState().deleteDocuments(["a", "b"]);
    const second = useAppStore.getState().deleteDocuments(["a", "b"]);
    deleting.finish();
    await first;
    await second;
    expect(method("deleteDocuments")).toHaveBeenCalledTimes(1);
    expect(said(useUndo.getState().line?.change)).toBe("Moved 2 Documents to Recently deleted");
  });

  // protects=⌘Z pressed while a delete is still running takes back that delete once it lands, never an earlier change (#1349); fails_when=the earlier change is undone and the Documents stay deleted; no_claim=none beyond protects.
  test("⌘Z pressed while a delete is running takes back that delete, not an earlier change", async () => {
    method("renameMind").mockResolvedValue({ ...mind, title: "Budget" });
    await useAppStore.getState().renameMind("m", "Budget");
    const deleting = slow();
    method("deleteDocuments").mockReturnValue(deleting.done);
    const deleted = useAppStore.getState().deleteDocuments(["a", "b"]);
    await vi.advanceTimersByTimeAsync(1_000);
    const undone = useUndo.getState().undo();
    deleting.finish();
    await deleted;
    await undone;
    expect(method("restore")).toHaveBeenCalledWith(
      [
        { kind: "document", id: "a" },
        { kind: "document", id: "b" },
      ],
      { reopen: true },
    );
    expect(method("renameMind")).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  test("a Tag added is undone by putting each link back as it was, with who chose it", async () => {
    useAppStore.setState({
      tags: [{ id: "t", name: "Contract" } as never],
      documents: [
        {
          ...doc("a"),
          tags: [{ tagId: "t", source: "automatic", confidence: 0.4, needsReview: true }],
        } as unknown as Document,
        doc("b"),
      ],
    });
    await useAppStore.getState().addTagToDocuments(["a", "b"], "t");
    expect(said(top())).toBe("Tagged 2 Documents Contract");
    await useUndo.getState().undo();
    expect(method("revertDocumentTags")).toHaveBeenCalledWith([
      {
        documentId: "a",
        tagId: "t",
        link: { source: "automatic", confidence: 0.4, needsReview: true },
      },
      { documentId: "b", tagId: "t", link: null },
    ]);
    await useUndo.getState().redo();
    expect(method("addTagToDocuments")).toHaveBeenCalledTimes(2);
  });

  test("a move is done again where it went, and refused, with Restore, once the Folder it came from is gone", async () => {
    const filed = assignment("a", "classified", "g");
    useAppStore.setState({ library: snapshot([filed]) });
    const moved = movedDocument("a", "g", filed, null);
    method("moveToFolder").mockResolvedValue({
      folderId: null,
      minds: [],
      documents: [moved],
      conversations: [],
    });
    await useAppStore.getState().moveToFolder({ documentIds: ["a"] }, null);
    expect(named(top())).toBe("Move “a v0”");
    // Research is deleted meanwhile.
    useAppStore.setState({ library: { ...snapshot([]), groups: [] } });
    await useUndo.getState().undo();
    const problem = useUndo.getState().line?.problem;
    expect(problem?.reason(words)).toBe("“Research” is deleted");
    expect(problem?.fix?.label(words)).toBe("Restore Research");
    expect(method("restoreAssignment")).not.toHaveBeenCalled();
    method("getLibrary").mockResolvedValue(snapshot([]));
    await problem?.fix?.run();
    expect(method("restore")).toHaveBeenCalledWith([{ kind: "folder", id: "g" }]);
    expect(method("restoreAssignment")).toHaveBeenCalledWith(
      "a",
      moved.change.before,
      moved.change.after,
    );
    await useUndo.getState().redo();
    expect(method("moveToFolder")).toHaveBeenCalledTimes(2);
  });

  test("the line and the Edit menu's name in Chinese, one and several", async () => {
    useAppStore.setState({ settings: { language: "zh-CN" } as never });
    method("moveToFolder").mockResolvedValue({
      folderId: "g",
      minds: [],
      documents: [movedDocument("a", null, null, "g"), movedDocument("b", null, null, "g")],
      conversations: [],
    });
    useAppStore.setState({ library: snapshot([]) });
    await useAppStore.getState().moveToFolder({ documentIds: ["a", "b"] }, "g");
    expect(said(top())).toBe("已将 2 个文档移动到“Research”");
    expect(named(top())).toBe("移动 2 个文档");
    await useAppStore.getState().deleteMind("m");
    expect(said(top())).toBe("已将“Plan”移到回收站");
    expect(named(top())).toBe("删除‘Plan’");
  });

  // protects=Undo of a Note's delete says so when its Meeting came back without its audio, and says nothing more when it came back whole, in English and Chinese (#1253); fails_when=lost audio goes unsaid, or a whole restore says audio was lost; no_claim=how the core finds the audio gone.
  test("Undo of a Note's delete says when its Meeting's audio couldn't come back, and only then", async () => {
    await useAppStore.getState().deleteMind("m");
    await useUndo.getState().undo();
    expect(method("restore")).toHaveBeenLastCalledWith([{ kind: "mind", id: "m" }], {
      reopen: true,
    });
    expect(useUndo.getState().line).toBeNull();

    await useUndo.getState().redo();
    method("restore").mockResolvedValue({ audioLost: ["m"] });
    await useUndo.getState().undo();
    const note = useUndo.getState().line?.note;
    expect(note?.(words)).toBe(
      "Restored “Plan” without its audio: it was no longer on this computer.",
    );
    expect(note?.((key, params) => translate("zh-CN", key, params))).toBe(
      "已恢复“Plan”，但音频已不在这台电脑上，无法恢复。",
    );
  });

  // protects=Restore from Recently deleted says so when a Note's Meeting came back without its audio, for one item or several, and only then, in English and Chinese (#1253); fails_when=lost audio goes unsaid, or a whole restore says audio was lost; no_claim=how the core finds the audio gone.
  test("Restore from Recently deleted says when a Meeting's audio couldn't come back, and only then", async () => {
    const { restoreItems } = await import("../../src/renderer/src/recentlyDeleted");
    const zh = undoLines((key, params) => translate("zh-CN", key, params));
    const item = (id: string, name: string): DeletedItem => ({
      kind: "mind",
      id,
      name,
      deletedAt: "2026-10-06T09:00:00.000Z",
      documentKind: null,
      groupId: null,
      linkedFolderId: null,
    });
    method("listDeleted").mockResolvedValue([]);

    await restoreItems([item("m", "Plan")]);
    expect(said(top())).toBe("Restored “Plan”");

    method("restore").mockResolvedValue({ audioLost: ["m"] });
    await restoreItems([item("m", "Plan")]);
    expect(said(top())).toBe(
      "Restored “Plan” without its audio: it was no longer on this computer.",
    );
    expect(zh.said(top())).toBe("已恢复“Plan”，但音频已不在这台电脑上，无法恢复。");
    await restoreItems([item("m", "Plan"), item("n", "Budget")]);
    expect(said(top())).toBe(
      "Restored 2 items without some meeting audio: it was no longer on this computer.",
    );
    expect(zh.said(top())).toBe("已恢复 2 项，但部分会议音频已不在这台电脑上，无法恢复。");
  });
});

describe("making a Mind", () => {
  const made = {
    id: "n",
    title: "",
    autoTitle: "",
    kind: "mind" as const,
    folderId: null,
    createdAt: "",
    updatedAt: "",
  };
  let useUndo: typeof import("../../src/renderer/src/undo").useUndo;

  beforeAll(async () => {
    ({ useUndo } = await import("../../src/renderer/src/undo"));
  });

  beforeEach(() => {
    useUndo.setState({ done: [], undone: [], line: null });
    useAppStore.setState({ minds: [], settings: null });
    method("createMind").mockResolvedValue(made);
  });

  const top = () => useUndo.getState().done.at(-1);

  test("a Mind made says nothing and leaves nothing for ⌘Z, however it is made: Delete takes it back", async () => {
    const titled = { ...made, title: "Tides" };
    const ways = [
      () => useAppStore.getState().createMind(),
      () => useAppStore.getState().createMind({ titled: true, folderId: "f" }),
      () => {
        method("createMind").mockResolvedValue(titled);
        return useAppStore.getState().createMind({ title: "Tides", startQuestion: true });
      },
    ];
    for (const makeOne of ways) {
      await makeOne();
      expect(top()).toBeUndefined();
      expect(useUndo.getState().line).toBeNull();
    }
    expect(method("createMind")).toHaveBeenCalledWith({ title: "Tides", headed: true });
    expect(method("deleteMind")).not.toHaveBeenCalled();
  });

  describe("its Folder, when none is given (#1362)", () => {
    const inFolder = { ...made, id: "m", folderId: "contracts" };
    const alone = (folderId: string) => ({ folderIds: [folderId], tagIds: [], documentIds: [] });
    const front = (mind: Mind | null) =>
      useAppStore.setState({
        minds: mind ? [mind] : [],
        layout: {
          groups: [
            {
              id: "group",
              tabs: mind
                ? [
                    {
                      id: "tab",
                      item: { kind: "mind", mindId: mind.id },
                      preview: false,
                      pinned: false,
                      place: null,
                      opened: 0,
                    },
                  ]
                : [],
              activeTabId: mind ? "tab" : null,
              width: 1,
            },
          ],
          focusedGroupId: "group",
          reopenable: 0,
          assistant: DEFAULT_ASSISTANT,
        } satisfies WindowLayout,
      });
    const madeIn = () => method("createMind").mock.lastCall?.[0];

    afterEach(() => useAppStore.setState({ layout: null }));

    test("it is the Folder of the Mind in front, and no Folder when none is", async () => {
      front(inFolder);
      await useAppStore.getState().createMind({ titled: true });
      expect(madeIn()).toEqual({ headed: true, folderId: "contracts" });

      front(null);
      await useAppStore.getState().createMind({ titled: true });
      expect(madeIn()).toEqual({ headed: true });
    });

    test("it is the one Folder a scope names, over the Folder of the Mind in front", async () => {
      front(inFolder);
      await useAppStore.getState().createMind({ startQuestion: true, scope: alone("board") });
      expect(madeIn()).toEqual({ folderId: "board" });

      front(inFolder);
      await useAppStore
        .getState()
        .createMind({ startQuestion: true, scope: { ...alone("board"), tagIds: ["urgent"] } });
      expect(madeIn()).toEqual({ folderId: "contracts" });
    });

    test("a Folder given, or none (null), is kept, whichever Mind is in front", async () => {
      front(inFolder);
      await useAppStore.getState().createMind({ titled: true, folderId: "board" });
      expect(madeIn()).toEqual({ headed: true, folderId: "board" });

      await useAppStore.getState().createMind({ titled: true, folderId: null });
      expect(madeIn()).toEqual({ headed: true });
    });
  });

  test("a Mind made leaves the line of the change before it, and that change, as they were", async () => {
    const before = { said: () => "Moved “Quarterly” to Finance", undo: async () => undefined };
    useUndo.getState().push(before);
    await useAppStore.getState().createMind();
    expect(top()).toBe(before);
    expect(useUndo.getState().line?.change).toBe(before);
  });

  test("a Mind the core can't make is a problem, with no step to undo", async () => {
    method("createMind").mockRejectedValue(new Error("The disk is full."));
    expect(await useAppStore.getState().createMind()).toBeNull();
    expect(useUndo.getState().done).toEqual([]);
    const { useNotices } = await import("../../src/renderer/src/notices");
    for (const notice of useNotices.getState().errors)
      useNotices.getState().dismissError(notice.id);
  });

  test("a Mind whose tab the core refuses is not shown, and asks for no focus", async () => {
    method("changeLayout").mockRejectedValue(new Error("The layout was refused."));
    const before = useAppStore.getState().layout;
    expect(await useAppStore.getState().createMind({ titled: true })).toBeNull();
    expect(useAppStore.getState().bodyToFocus).toBeNull();
    expect(useAppStore.getState().layout).toBe(before);
    const { useNotices } = await import("../../src/renderer/src/notices");
    for (const notice of useNotices.getState().errors)
      useNotices.getState().dismissError(notice.id);
  });

  test("asking about Documents makes a Mind only when there is none to ask in", async () => {
    const scope = { folderIds: [], tagIds: [], documentIds: ["a"] };
    const bridge = { kind: "documents" as const, title: "a", count: 1, scope };
    await useAppStore.getState().askAbout(bridge);
    expect(method("createMind")).toHaveBeenCalledTimes(1);
    expect(useUndo.getState().done).toEqual([]);
    useAppStore.setState({ minds: [made] });
    await useAppStore.getState().askAbout(bridge);
    expect(method("createMind")).toHaveBeenCalledTimes(1);
  });
});

describe("Get started's Add your Documents", () => {
  const inFolder = (
    id: string,
    linkedFolderId: string | null,
    status: Document["status"] = "ready",
  ) => ({ ...doc(id), linkedFolderId, status }) as Document;
  const example = (linkedFolderId: string) =>
    ({
      group: "credit",
      available: true,
      mindId: "m",
      linkedFolderId,
      answerId: "a",
      more: [],
    }) satisfies CoreEvents["examples.changed"];
  const ticked = () => useAppStore.getState().settings?.device.gettingStarted.indexed;

  beforeEach(() => {
    useAppStore.setState({
      examples: example("old"),
      otherExamples: [],
      settings: {
        device: {
          gettingStarted: {
            started: true,
            hidden: false,
            citationChecked: false,
            mistakeSeen: false,
            indexed: false,
            askedOwn: false,
            askedReady: false,
          },
        },
      } as unknown as NonNullable<ReturnType<typeof useAppStore.getState>["settings"]>,
    });
  });

  test("the example's Documents after it follows the language don't tick it, a Document the User adds does", () => {
    emit("examples.changed", example("new"));
    emit("document.status", inFolder("a", "new"));
    expect(ticked()).toBe(false);

    emit("document.status", inFolder("mine", "theirs"));
    expect(ticked()).toBe(true);
  });

  test("a Document the User adds ticks it once it has been read, not while it is read or when it can't be (#1457)", () => {
    for (const status of ["queued", "extracting", "failed", "no-text"] as const) {
      emit("document.status", inFolder("mine", null, status));
      expect(ticked()).toBe(false);
    }
    emit("document.status", inFolder("mine", null, "waiting-for-model"));
    expect(ticked()).toBe(true);
  });

  test("the Documents already there tick it only when one of the User's own has been read (#1457)", () => {
    useAppStore.setState({ documents: [inFolder("a", "old"), inFolder("mine", null, "failed")] });
    emit("connectors.changed", []);
    expect(ticked()).toBe(false);

    useAppStore.setState({ documents: [inFolder("a", "old"), inFolder("mine", null)] });
    emit("connectors.changed", []);
    expect(ticked()).toBe(true);
  });
});

describe("changing a Linked folder", () => {
  const linked = {
    id: "l",
    path: "/Users/me/Papers",
    folderId: "f",
    status: "watching" as const,
    layout: "tree" as const,
    progress: { files: 0, indexed: 0 },
    onlineOnly: { files: 0, bytes: 0, downloading: false },
    unsupportedFiles: 0,
    createdAt: "",
    updatedAt: "",
  };
  let useUndo: typeof import("../../src/renderer/src/undo").useUndo;

  beforeAll(async () => {
    ({ useUndo } = await import("../../src/renderer/src/undo"));
  });

  beforeEach(() => {
    useUndo.setState({ done: [], undone: [], line: null });
    useAppStore.setState({ linkedFolders: [linked], settings: null });
  });

  const top = () => useUndo.getState().done.at(-1);

  test("pausing is undone by resuming it and done again by pausing", async () => {
    method("setLinkedFolderPaused").mockResolvedValue({ ...linked, status: "paused" });
    const change = await useAppStore.getState().setLinkedFolderPaused("l", true);
    expect(change).toBe(top());
    expect(said(change)).toBe("Paused reading in “Papers”");
    expect(named(change)).toBe("Pause reading");
    expect(useAppStore.getState().linkedFolders[0]?.status).toBe("paused");
    method("setLinkedFolderPaused").mockResolvedValue(linked);
    await useUndo.getState().undo();
    expect(method("setLinkedFolderPaused")).toHaveBeenLastCalledWith("l", false);
    expect(useAppStore.getState().linkedFolders[0]?.status).toBe("watching");
    method("setLinkedFolderPaused").mockResolvedValue({ ...linked, status: "paused" });
    await useUndo.getState().redo();
    expect(method("setLinkedFolderPaused")).toHaveBeenLastCalledWith("l", true);
    expect(said(top())).toBe("Paused reading in “Papers”");
  });

  test("resuming says so, and pausing what is paused already offers nothing to undo", async () => {
    useAppStore.setState({ linkedFolders: [{ ...linked, status: "paused" }] });
    method("setLinkedFolderPaused").mockResolvedValue({ ...linked, status: "paused" });
    expect(await useAppStore.getState().setLinkedFolderPaused("l", true)).toBeUndefined();
    method("setLinkedFolderPaused").mockResolvedValue({ ...linked, status: "scanning" });
    const change = await useAppStore.getState().setLinkedFolderPaused("l", false);
    expect(said(change)).toBe("Resumed reading in “Papers”");
    expect(named(change)).toBe("Resume reading");
  });

  test("the lines in Chinese", async () => {
    useAppStore.setState({ settings: { language: "zh-CN" } as never });
    method("setLinkedFolderPaused").mockResolvedValue({ ...linked, status: "paused" });
    await useAppStore.getState().setLinkedFolderPaused("l", true);
    expect(said(top())).toBe("已暂停读取“Papers”");
    expect(named(top())).toBe("暂停读取");
  });
});

describe("making a Folder", () => {
  const made = {
    id: "n",
    name: "Untitled Folder",
    description: "",
    countsOwnFiles: false,
    keepInside: false,
    createdAt: "",
    updatedAt: "",
  };
  let useUndo: typeof import("../../src/renderer/src/undo").useUndo;
  let useRequests: typeof import("../../src/renderer/src/requests").useRequests;
  let useNotices: typeof import("../../src/renderer/src/notices").useNotices;

  beforeAll(async () => {
    ({ useUndo } = await import("../../src/renderer/src/undo"));
    ({ useRequests } = await import("../../src/renderer/src/requests"));
    ({ useNotices } = await import("../../src/renderer/src/notices"));
  });

  /** The Library as the core has it once the new Folder is in it, named `name`. */
  const withNewFolder = (name = made.name, assignments: DocumentGroupAssignment[] = []) => {
    const library = snapshot(assignments);
    method("getLibrary").mockResolvedValue({
      ...library,
      groups: [...library.groups, { ...made, name }],
    });
  };
  const top = () => useUndo.getState().done.at(-1);
  /** What the line says once the Undo of the Folder came back, if it kept it. */
  const noteNow = () => useUndo.getState().line?.note?.(words) ?? null;

  beforeEach(() => {
    useUndo.setState({ done: [], undone: [], line: null });
    useRequests.setState({ nameFolder: null });
    useAppStore.setState({ settings: null, minds: [] });
    method("createLibraryGroup").mockResolvedValue(made);
    method("listMinds").mockResolvedValue([]);
    method("listConversations").mockResolvedValue([]);
    withNewFolder();
  });

  test("makes “Untitled Folder”, asks for its name in place, and one Undo removes it, one Redo brings it back", async () => {
    expect(await useAppStore.getState().createFolder()).toBe("n");
    expect(method("createLibraryGroup")).toHaveBeenCalledWith({
      name: "Untitled Folder",
      description: "",
    });
    expect(useRequests.getState().nameFolder).toBe("n");
    expect(said(top())).toBe("Made “Untitled Folder”");
    expect(named(top())).toBe("New Folder");
    await useUndo.getState().undo();
    expect(method("deleteLibraryGroup")).toHaveBeenCalledWith("n");
    await useUndo.getState().redo();
    expect(method("restore")).toHaveBeenCalledWith([{ kind: "folder", id: "n" }]);
  });

  test("a Folder the core can't make is a problem in place, with no step to undo", async () => {
    method("createLibraryGroup").mockRejectedValue(
      new Error("A Folder with this name already exists."),
    );
    expect(await useAppStore.getState().createFolder()).toBeNull();
    expect(useUndo.getState().done).toEqual([]);
    const [notice] = useNotices.getState().errors;
    expect(notice?.message).toContain("already exists");
    if (notice) useNotices.getState().dismissError(notice.id);
  });

  test("a name the Folders already have is numbered, and Chinese names are made in Chinese", async () => {
    useAppStore.setState({
      library: {
        ...snapshot([]),
        groups: [{ ...made, id: "x", name: "untitled folder" }],
      },
    });
    await useAppStore.getState().createFolder();
    expect(method("createLibraryGroup")).toHaveBeenLastCalledWith({
      name: "Untitled Folder 2",
      description: "",
    });
    useAppStore.setState({ settings: { language: "zh-CN" } as never, library: snapshot([]) });
    await useAppStore.getState().createFolder();
    expect(method("createLibraryGroup")).toHaveBeenLastCalledWith({
      name: "未命名文件夹",
      description: "",
    });
    expect(said(top())).toBe("已新建文件夹“未命名文件夹”");
  });

  test("its first name is part of making it: one step, named, which one Undo removes", async () => {
    await useAppStore.getState().createFolder();
    withNewFolder("Chapter 2");
    method("updateLibraryGroup").mockResolvedValue({ ...made, name: "Chapter 2" });
    await useAppStore.getState().nameNewFolder("n", "  Chapter 2 ");
    expect(method("updateLibraryGroup")).toHaveBeenCalledWith("n", {
      name: "Chapter 2",
      description: "",
    });
    expect(useUndo.getState().done).toHaveLength(1);
    expect(said(top())).toBe("Made “Chapter 2”");
    await useUndo.getState().undo();
    expect(method("deleteLibraryGroup")).toHaveBeenCalledWith("n");
    expect(method("updateLibraryGroup")).toHaveBeenCalledTimes(1);
  });

  test("a blank name, or one the Folder has, changes nothing; a later name is a step of its own", async () => {
    await useAppStore.getState().createFolder();
    await useAppStore.getState().nameNewFolder("n", "   ");
    await useAppStore.getState().nameNewFolder("n", "Untitled Folder");
    expect(method("updateLibraryGroup")).not.toHaveBeenCalled();
    expect(said(top())).toBe("Made “Untitled Folder”");
    // Another change came after it, so the name no longer belongs to making it.
    useUndo.getState().push({ said: () => "Something else", undo: async () => undefined });
    method("updateLibraryGroup").mockResolvedValue({ ...made, name: "Later" });
    await useAppStore.getState().nameNewFolder("n", "Later");
    expect(useUndo.getState().done.map(said)).toEqual([
      "Made “Untitled Folder”",
      "Something else",
      "Renamed to “Later”",
    ]);
  });

  test("with Documents and Minds: they move in at once, in one step, and Undo puts each back before the Folder goes", async () => {
    const filed = assignment("a", "classified", "g");
    useAppStore.setState({
      documents: [doc("a"), doc("b"), doc("c")],
      minds: [
        {
          id: "m",
          title: "Plan",
          autoTitle: "",
          kind: "mind",
          folderId: "g",
          createdAt: "",
          updatedAt: "",
        },
      ],
      library: snapshot([filed]),
    });
    const movedA = movedDocument("a", "g", filed, "n");
    const movedB = movedDocument("b", null, null, "n");
    const movedC = movedDocument("c", null, null, "n");
    method("moveToFolder").mockResolvedValue({
      folderId: "n",
      minds: [{ id: "m", from: "g" }],
      documents: [movedA, movedB, movedC],
      conversations: [],
    });
    withNewFolder("Untitled Folder", [filed]);
    // The Mind is back in its own Folder once Undo has put it there.
    method("listMinds").mockResolvedValue([
      {
        id: "m",
        title: "Plan",
        autoTitle: "",
        kind: "mind",
        folderId: "g",
        createdAt: "",
        updatedAt: "",
      },
    ]);

    await useAppStore.getState().createFolder({ mindIds: ["m"], documentIds: ["a", "b", "c"] });
    expect(method("moveToFolder")).toHaveBeenCalledWith({
      mindIds: ["m"],
      documentIds: ["a", "b", "c"],
      conversationIds: [],
      folderId: "n",
    });
    expect(said(top())).toBe("Made “Untitled Folder” with 4 items");

    await useUndo.getState().undo();
    expect(method("moveToFolder")).toHaveBeenLastCalledWith({
      mindIds: ["m"],
      documentIds: [],
      conversationIds: [],
      folderId: "g",
    });
    expect(method("restoreAssignment")).toHaveBeenCalledWith(
      "a",
      movedA.change.before,
      movedA.change.after,
    );
    expect(method("restoreAssignment")).toHaveBeenCalledWith(
      "b",
      movedB.change.before,
      movedB.change.after,
    );
    expect(method("restoreAssignment")).toHaveBeenCalledWith(
      "c",
      movedC.change.before,
      movedC.change.after,
    );
    expect(method("deleteLibraryGroup").mock.invocationCallOrder[0]).toBeGreaterThan(
      method("restoreAssignment").mock.invocationCallOrder[2] ?? 0,
    );

    await useUndo.getState().redo();
    expect(method("restore")).toHaveBeenCalledWith([{ kind: "folder", id: "n" }]);
    expect(method("moveToFolder")).toHaveBeenLastCalledWith({
      mindIds: ["m"],
      documentIds: ["a", "b", "c"],
      conversationIds: [],
      folderId: "n",
    });
  });

  test("a Document filed in the new Folder since keeps it, and the line says so in English and in Chinese", async () => {
    await useAppStore.getState().createFolder();
    // Another window filed it here after the Folder was made: Undo leaves that work where it is.
    withNewFolder(made.name, [assignment("later", "classified", "n")]);
    await useUndo.getState().undo();
    expect(method("deleteLibraryGroup")).not.toHaveBeenCalled();
    expect(noteNow()).toBe("Kept the Folder “Untitled Folder”: you’ve filed things in it since.");

    useUndo.setState({ done: [], undone: [], line: null });
    useAppStore.setState({ settings: { language: "zh-CN" } as never });
    await useAppStore.getState().createFolder();
    withNewFolder("未命名文件夹", [assignment("later", "classified", "n")]);
    await useUndo.getState().undo();
    expect(method("deleteLibraryGroup")).not.toHaveBeenCalled();
    expect(noteNow()).toBe("保留了文件夹“未命名文件夹”：之后你在里面放了其他内容。");
  });

  test("a Mind put in the new Folder since keeps it too", async () => {
    await useAppStore.getState().createFolder();
    method("listMinds").mockResolvedValue([
      {
        id: "later",
        title: "Plan",
        autoTitle: "",
        kind: "mind",
        folderId: "n",
        createdAt: "",
        updatedAt: "",
      },
    ]);
    await useUndo.getState().undo();
    expect(method("deleteLibraryGroup")).not.toHaveBeenCalled();
    expect(noteNow()).toBe("Kept the Folder “Untitled Folder”: you’ve filed things in it since.");
  });

  test("a conversation put in the new Folder since keeps it too", async () => {
    await useAppStore.getState().createFolder();
    method("listConversations").mockResolvedValue([
      {
        id: "later",
        title: "",
        autoTitle: "Why do parks cool at night",
        folderId: "n",
        askedFrom: [],
        createdAt: "",
        updatedAt: "",
      },
    ]);
    await useUndo.getState().undo();
    expect(method("deleteLibraryGroup")).not.toHaveBeenCalled();
    expect(noteNow()).toBe("Kept the Folder “Untitled Folder”: you’ve filed things in it since.");
  });

  test("a Folder only Organize has suggested into goes, and says nothing about being kept", async () => {
    await useAppStore.getState().createFolder();
    // A suggestion waiting in To review is Organize's, not something the User filed here.
    withNewFolder(made.name, [{ ...assignment("later", "pending", "n"), suggested: true }]);
    await useUndo.getState().undo();
    expect(method("deleteLibraryGroup")).toHaveBeenCalledWith("n");
    expect(noteNow()).toBeNull();
  });

  test("the line says how many went in, in English and in Chinese", async () => {
    useAppStore.setState({ documents: [doc("a"), doc("b"), doc("c")] });
    method("moveToFolder").mockResolvedValue({
      folderId: "n",
      minds: [],
      documents: ["a", "b", "c"].map((id) => movedDocument(id, null, null, "n")),
      conversations: [],
    });
    await useAppStore.getState().createFolder({ documentIds: ["a", "b", "c"] });
    expect(said(top())).toBe("Made “Untitled Folder” with 3 Documents");
    useUndo.setState({ done: [], undone: [], line: null });
    useAppStore.setState({ settings: { language: "zh-CN" } as never, library: snapshot([]) });
    await useAppStore.getState().createFolder({ documentIds: ["a"] });
    expect(said(top())).toBe("已新建文件夹“未命名文件夹”，放入“a v0”");
    useAppStore.setState({ library: snapshot([]) });
    await useAppStore.getState().createFolder({ documentIds: ["a", "b", "c"] });
    expect(said(top())).toBe("已新建文件夹“未命名文件夹”，放入 3 个文档");
  });
});

describe("loading keeps a list the core pushed after reading it", () => {
  beforeEach(() => {
    method("listMinds").mockResolvedValue([]);
    method("getSettings").mockResolvedValue({ device: { gettingStarted: { askedOwn: false } } });
    method("getExamples").mockResolvedValue({
      group: "credit",
      available: false,
      mindId: null,
      linkedFolderId: null,
      answerId: null,
      more: [],
    });
  });
  const folder = (id: string) => ({ id, name: id }) as unknown as Folder;
  const folderIds = () => useAppStore.getState().folders.map((each) => each.id);
  const later = <T>() => {
    let reply: (value: T) => void = () => undefined;
    const promise = new Promise<T>((resolve) => {
      reply = resolve;
    });
    return { promise, reply: (value: T) => reply(value) };
  };

  test("a Folder pushed while loading still waits stays", async () => {
    const connectors = later<never[]>();
    method("listConnectors").mockReturnValue(connectors.promise);
    method("listFolders").mockResolvedValue([folder("mine")]);

    const loading = useAppStore.getState().load();
    await settle();
    await settle();
    // The example Linked folder's first scan makes its Folder after the list was read.
    emit("folders.changed", [folder("mine"), folder("examples")]);
    connectors.reply([]);
    await loading;

    expect(folderIds()).toEqual(["mine", "examples"]);
  });

  test("a list pushed before it was read gives way to the read, which is newer", async () => {
    const folders = later<Folder[]>();
    method("listConnectors").mockResolvedValue([]);
    method("listFolders").mockReturnValue(folders.promise);

    const loading = useAppStore.getState().load();
    await settle();
    emit("folders.changed", [folder("mine")]);
    folders.reply([folder("mine"), folder("examples")]);
    await loading;

    expect(folderIds()).toEqual(["mine", "examples"]);
  });

  test("a Document read while loading still waits shows the status the core gave it since (#1741)", async () => {
    const connectors = later<never[]>();
    method("listConnectors").mockReturnValue(connectors.promise);
    method("listFolders").mockResolvedValue([]);
    const reading = { ...doc("example"), status: "extracting" } as Document;
    method("listDocuments").mockResolvedValue([reading, doc("mine")]);

    const loading = useAppStore.getState().load();
    await settle();
    await settle();
    // The example's PDF, cut off by the last quit, is read to the end while loading waits.
    emit("document.status", { ...reading, status: "ready" });
    vi.advanceTimersByTime(100);
    connectors.reply([]);
    await loading;
    vi.advanceTimersByTime(100);

    expect(useAppStore.getState().documents.map((each) => [each.id, each.status])).toEqual([
      ["example", "ready"],
      ["mine", undefined],
    ]);
  });
});

describe("Organize says what it did (#763)", () => {
  test("once it has gone through the Documents it says how many got a Suggested Folder, and Undo puts each back", async () => {
    const { sayWhenOrganized } = await import("../../src/renderer/src/organizeRun");
    const { useUndo } = await import("../../src/renderer/src/undo");
    const before = new Map([
      ["a", assignment("a", "classified")],
      ["b", assignment("b", "classified")],
    ]);
    sayWhenOrganized(["a", "b"], before);

    useAppStore.setState({
      library: snapshot([assignment("a", "pending"), assignment("b", "classifying")]),
    });
    const earlier = useUndo.getState().line;
    expect(useUndo.getState().line).toBe(earlier);
    const suggested = (id: string) => ({
      ...assignment(id, "classified", "g"),
      suggested: true,
    });
    useAppStore.setState({ library: snapshot([suggested("a"), suggested("b")]) });

    const change = useUndo.getState().line?.change;
    expect(said(change)).toBe("Organize suggested a Folder for 2 Documents");
    await useUndo.getState().undo();
    const restored = method("restoreAssignment");
    expect(restored).toHaveBeenCalledTimes(2);
    expect(restored.mock.calls[0]?.[0]).toBe("a");
    expect(restored.mock.calls[0]?.[1]).toMatchObject({
      assignment: { groupId: null, suggested: false },
    });
  });

  test("Undo leaves a Document the User moved since", async () => {
    const { sayWhenOrganized } = await import("../../src/renderer/src/organizeRun");
    const { useUndo } = await import("../../src/renderer/src/undo");
    method("restoreAssignment").mockClear();
    const before = new Map([
      ["a", assignment("a", "classified")],
      ["b", assignment("b", "classified")],
    ]);
    useAppStore.setState({
      library: snapshot([assignment("a", "pending"), assignment("b", "pending")]),
    });
    sayWhenOrganized(["a", "b"], before);
    const suggested = (id: string) => ({ ...assignment(id, "classified", "g"), suggested: true });
    useAppStore.setState({ library: snapshot([suggested("a"), suggested("b")]) });
    // The User puts b somewhere else.
    useAppStore.setState({
      library: snapshot([
        suggested("a"),
        { ...assignment("b", "classified", null), source: "user" },
      ]),
    });
    await useUndo.getState().undo();
    const restored = method("restoreAssignment");
    expect(restored).toHaveBeenCalledTimes(1);
    expect(restored.mock.calls[0]?.[0]).toBe("a");
  });
});

describe("Undo of an Organize that began with Documents unfinished (#1391)", () => {
  const FOLDERS = ["g1", "g2", "g3", "g4", "g5"];
  const ids = (count: number) => Array.from({ length: count }, (_, at) => `d${at}`);
  const suggestedIn = (id: string, groupId: string) => ({
    ...assignment(id, "classified", groupId),
    suggested: true,
  });

  // protects=Documents that were waiting for a model or queued when Organize was asked go back with no assignment, so none shows "Needs attention" with a model chosen and none is organized again at the next start, and Redo gives each its Folder back, for 70 Documents in 5 Folders; fails_when=Undo puts them back as waiting or queued, or Redo skips Documents that have no assignment; no_claim=the core's restore.
  test.each([
    { count: 2, before: "waiting" as const },
    { count: 70, before: "waiting" as const },
    { count: 70, before: "pending" as const },
  ])(
    "$count Documents $before: Undo puts them back with no assignment, and Redo gives their Folders",
    async ({ count, before: status }) => {
      const { sayWhenOrganized } = await import("../../src/renderer/src/organizeRun");
      const { useUndo } = await import("../../src/renderer/src/undo");
      method("restoreAssignment").mockClear();
      const documents = ids(count);
      const folderOf = (at: number) => FOLDERS[at % FOLDERS.length] ?? "g1";
      const before = new Map(documents.map((id) => [id, assignment(id, status)]));
      useAppStore.setState({
        library: snapshot(documents.map((id) => assignment(id, "pending"))),
      });
      sayWhenOrganized(documents, before);
      useAppStore.setState({
        library: snapshot(documents.map((id, at) => suggestedIn(id, folderOf(at)))),
      });
      // As the core does: the change it made, the rows before and after, the other way round.
      method("restoreAssignment").mockImplementation(
        async (id: string, putBack: unknown, left: unknown) => ({
          documentId: id,
          before: left,
          after: putBack,
        }),
      );

      await useUndo.getState().undo();
      const restored = method("restoreAssignment");
      expect(restored).toHaveBeenCalledTimes(count);
      expect(restored.mock.calls.map((call) => call[1])).toEqual(
        documents.map(() => ({ assignment: null, tagging: null })),
      );

      // Nothing is left for Organize to do: the Library holds no assignment for them.
      restored.mockClear();
      useAppStore.setState({ library: snapshot([]) });
      await useUndo.getState().redo();
      expect(restored).toHaveBeenCalledTimes(count);
      documents.forEach((id, at) => {
        const call = restored.mock.calls.find((each) => each[0] === id);
        expect(call?.[1]).toMatchObject({
          assignment: { groupId: folderOf(at), suggested: true },
        });
      });
    },
  );

  test("a Document that was filed before Organize is put back as it was", async () => {
    const { sayWhenOrganized } = await import("../../src/renderer/src/organizeRun");
    const { useUndo } = await import("../../src/renderer/src/undo");
    method("restoreAssignment").mockClear();
    const before = new Map([["a", assignment("a", "classified", "g0")]]);
    useAppStore.setState({ library: snapshot([assignment("a", "pending")]) });
    sayWhenOrganized(["a"], before);
    useAppStore.setState({ library: snapshot([suggestedIn("a", "g")]) });

    await useUndo.getState().undo();

    expect(method("restoreAssignment").mock.calls[0]?.[1]).toMatchObject({
      assignment: { groupId: "g0", suggested: false, status: "classified" },
    });
  });
});

describe("an undo line keeps only what it shows", () => {
  const plan: Mind = {
    id: "m",
    title: "Plan",
    autoTitle: "",
    kind: "mind",
    folderId: null,
    createdAt: "",
    updatedAt: "",
  };
  const made = {
    id: "n",
    name: "Untitled Folder",
    description: "",
    countsOwnFiles: false,
    keepInside: false,
    createdAt: "",
    updatedAt: "",
  };
  let useUndo: typeof import("../../src/renderer/src/undo").useUndo;
  let stopTagging: typeof import("../../src/renderer/src/taggingStop").stopTagging;

  beforeAll(async () => {
    ({ useUndo } = await import("../../src/renderer/src/undo"));
    ({ stopTagging } = await import("../../src/renderer/src/taggingStop"));
  });

  beforeEach(() => {
    useUndo.setState({ done: [], undone: [], line: null });
    useAppStore.setState({ settings: null });
    method("createLibraryGroup").mockResolvedValue(made);
    method("getLibrary").mockResolvedValue(snapshot([]));
  });

  const top = () => useUndo.getState().done.at(-1);

  /** The lists the store holds, held nowhere else: each is freed once the store holds others. */
  const holdLists = () => {
    const library = snapshot([assignment("a", "classified")]);
    const documents = [doc("a"), doc("b")];
    const minds = [plan];
    useAppStore.setState({ library, documents, minds });
    return [library, library.groups, library.assignments, documents, minds].map(
      (list) => new WeakRef(list),
    );
  };

  const freedOnceReplaced = async (held: WeakRef<object>[]) => {
    useAppStore.setState({ library: snapshot([]), documents: [], minds: [] });
    expect(await Promise.all(held.map(isFreed))).toEqual(held.map(() => true));
  };

  test("moving a Document", async () => {
    const held = holdLists();
    method("moveToFolder").mockResolvedValue({
      folderId: "g",
      minds: [],
      documents: [movedDocument("a", null, null, "g")],
      conversations: [],
    });
    await useAppStore.getState().moveToFolder({ documentIds: ["a"] }, "g");
    await freedOnceReplaced(held);
    expect(said(top())).toBe("Moved “a v0” to Research");
    expect(named(top())).toBe("Move “a v0”");
  });

  test("moving a Mind and a Document", async () => {
    const held = holdLists();
    method("moveToFolder").mockResolvedValue({
      folderId: "g",
      minds: [{ id: "m", from: null }],
      documents: [movedDocument("a", null, null, "g")],
      conversations: [],
    });
    await useAppStore.getState().moveToFolder({ mindIds: ["m"], documentIds: ["a"] }, "g");
    await freedOnceReplaced(held);
    expect(said(top())).toBe("Moved 2 items to Research");
  });

  test("making a Folder with a Document in it, and naming it", async () => {
    const held = holdLists();
    method("moveToFolder").mockResolvedValue({
      folderId: "n",
      minds: [],
      documents: [movedDocument("a", null, null, "n")],
      conversations: [],
    });
    const library = snapshot([]);
    method("getLibrary").mockResolvedValue({ ...library, groups: [...library.groups, made] });
    method("updateLibraryGroup").mockResolvedValue({ ...made, name: "Chapter 2" });
    await useAppStore.getState().createFolder({ documentIds: ["a"] });
    expect(said(top())).toBe("Made “Untitled Folder” with “a v0”");
    await useAppStore.getState().nameNewFolder("n", "Chapter 2");
    await freedOnceReplaced(held);
    expect(said(top())).toBe("Made “Chapter 2” with “a v0”");
  });

  test("counting Documents as evidence", async () => {
    const { countAsEvidence } = await import("../../src/renderer/src/evidence");
    const count = async () => {
      const documents = [doc("a"), doc("b")];
      return { change: await countAsEvidence(documents, true), held: new WeakRef(documents) };
    };
    const { change, held } = await count();
    expect(await isFreed(held)).toBe(true);
    expect(said(change)).toBe("2 Documents count as evidence now");
    await change.undo();
    expect(method("setCountedAsEvidence")).toHaveBeenLastCalledWith("b", false);
  });

  test("tagging Documents", async () => {
    const { retagged } = await import("../../src/renderer/src/changes");
    const tag = () => {
      const names = ["a v0", "b v0"];
      const change = retagged({ added: true, tag: "Report", names }, [], async () => undefined);
      return { change, held: new WeakRef(names) };
    };
    const { change, held } = tag();
    expect(await isFreed(held)).toBe(true);
    expect(said(change)).toBe("Tagged 2 Documents Report");
  });

  test("importing references", async () => {
    const { useReferenceImport } = await import("../../src/renderer/src/referenceImport");
    const read = async () => {
      const entries = [{ title: "Tides" }, { title: "Harbours" }];
      method("importReferences").mockResolvedValue({
        outcome: "imported",
        importId: "i",
        format: "bibtex",
        total: 2,
        matched: 0,
        unmatched: 2,
        changed: 2,
        merged: 0,
        problems: [],
        entries,
        files: 0,
      });
      method("listUnmatchedReferences").mockResolvedValue([]);
      const change = await useReferenceImport.getState().importPath("/refs/tides.bib");
      method("importReferences").mockReset();
      useReferenceImport.setState({ result: null });
      return { change, held: new WeakRef(entries) };
    };
    const { change, held } = await read();
    expect(await isFreed(held)).toBe(true);
    expect(said(change)).toBe("Imported references from “tides.bib”");
    await change?.undo();
    expect(method("undoReferenceImport")).toHaveBeenCalledWith("i");
  });

  test("stopping Tagging", async () => {
    const held = holdLists();
    method("stopTagging").mockResolvedValue(["g", null]);
    const change = await stopTagging();
    await freedOnceReplaced(held);
    expect(said(change)).toBe("Stopped Tagging Documents in “Research” and not in a Folder");
  });
});

describe("Get started's Ask a question", () => {
  const finished = (answerId: string, status: "done" | "stopped") =>
    emit("answer.finished", { answerId, status } as CoreEvents["answer.finished"]);
  const asked = () => useAppStore.getState().settings?.device.gettingStarted.askedOwn;

  beforeEach(() => {
    useAppStore.setState({
      examples: {
        group: "credit",
        available: true,
        mindId: "m",
        linkedFolderId: "f",
        answerId: "example",
        more: [],
      } satisfies CoreEvents["examples.changed"],
      otherExamples: [],
      settings: {
        device: {
          gettingStarted: {
            started: true,
            hidden: false,
            citationChecked: false,
            mistakeSeen: false,
            indexed: false,
            askedOwn: false,
            askedReady: false,
          },
        },
      } as unknown as NonNullable<ReturnType<typeof useAppStore.getState>["settings"]>,
    });
  });

  test("it ticks once an Answer to the User's own Question arrives, not when it fails, is stopped or is the example's", () => {
    emit("answer.failed", { answerId: "own" } as CoreEvents["answer.failed"]);
    finished("own", "stopped");
    finished("example", "done");
    expect(asked()).toBe(false);

    finished("own", "done");
    expect(asked()).toBe(true);
  });

  test("a later failed Answer doesn't take the tick back", () => {
    finished("own", "done");
    emit("answer.failed", { answerId: "again" } as CoreEvents["answer.failed"]);
    expect(asked()).toBe(true);
  });

  test("the first own Answer is recorded even when this device has no first-run checklist", () => {
    const state = useAppStore.getState();
    const settings = state.settings;
    if (!settings) throw new Error("Settings have not loaded.");
    useAppStore.setState({
      settings: {
        ...settings,
        device: {
          ...settings.device,
          gettingStarted: { ...settings.device.gettingStarted, started: false },
        },
      },
    });
    finished("example", "done");
    expect(asked()).toBe(false);
    finished("own", "done");
    expect(asked()).toBe(true);
  });
});
