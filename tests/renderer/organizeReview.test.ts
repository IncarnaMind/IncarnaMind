import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type CoreEventName,
  type CoreEvents,
  DEFAULT_ASSISTANT,
  type Document,
  type LibrarySnapshot,
  type OrganizeLibraryResult,
  type OrganizeReview,
  type OrganizeReviewChange,
  type OrganizeReviewConfirmation,
  type OrganizeReviewItem,
  type TabItem,
  type WindowLayout,
} from "../../src/core/api";
import type { Translate } from "../../src/renderer/src/objects";
import { translate } from "../../src/shared/i18n";
import { undoLines } from "../helpers/undoLines";

/*
 * Organize proposes and the User confirms (#1569), the window's half: a run says how far it is,
 * the Review opens only once the run ends with something in it, and each change on the Review,
 * and Confirm, is one Undo. A fake bridge stands in for the core.
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

const layoutShowing = (item: TabItem): WindowLayout => ({
  groups: [
    {
      id: "group",
      tabs: [{ id: "tab", item, preview: false, pinned: false, place: null, opened: 0 }],
      activeTabId: "tab",
      width: 1,
    },
  ],
  focusedGroupId: "group",
  reopenable: 0,
  conversationId: null,
  assistant: DEFAULT_ASSISTANT,
});
const libraryShown = layoutShowing({ kind: "library" });
const noteShown = layoutShowing({ kind: "mind", mindId: "note" });

const snapshot = (classifier: LibrarySnapshot["settings"]["classifier"]): LibrarySnapshot => ({
  groups: [],
  deletedGroups: [],
  assignments: [],
  settings: { classifier, automatic: false, organizeWith: null, taggingStopped: [] },
  automaticDefault: false,
  reviewCount: 0,
});
const planning = snapshot({ kind: "chat", choice: { providerId: "anthropic", modelId: "haiku" } });

const doc = (id: string) =>
  ({ id, name: id, tags: [], linkedFolderId: null }) as unknown as Document;

const row = (id: string, over: Partial<OrganizeReviewItem> = {}): OrganizeReviewItem => ({
  id,
  documentId: `d-${id}`,
  placement: { kind: "newFolder", newFolderId: "nf-leases" },
  ticked: true,
  origin: "library",
  edited: false,
  tags: [],
  ...over,
});
const waiting: OrganizeReview = {
  items: [row("1"), row("2")],
  folders: [
    { id: "nf-leases", name: "Leases", description: "", parentId: null, parentNewFolderId: null },
  ],
  count: 2,
};
const empty: OrganizeReview = { items: [], folders: [], count: 0 };

const planned = (proposed: number): OrganizeLibraryResult => ({
  status: "done",
  runId: "run-1",
  documents: 2,
  proposed,
  placedByModel: 0,
  requests: 1,
});

type Flow = typeof import("../../src/renderer/src/organizeReview");
let flow: Flow;
let organizing: typeof import("../../src/renderer/src/organizeDocuments");
let useAppStore: typeof import("../../src/renderer/src/store").useAppStore;
let useUndo: typeof import("../../src/renderer/src/undo").useUndo;
let useNotices: typeof import("../../src/renderer/src/notices").useNotices;
let words: Translate;
let said: ReturnType<typeof undoLines>["said"];
let named: ReturnType<typeof undoLines>["named"];

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: {},
  };
  ({ useAppStore } = await import("../../src/renderer/src/store"));
  flow = await import("../../src/renderer/src/organizeReview");
  organizing = await import("../../src/renderer/src/organizeDocuments");
  ({ useUndo } = await import("../../src/renderer/src/undo"));
  ({ useNotices } = await import("../../src/renderer/src/notices"));
  ({ translateNow: words } = await import("../../src/renderer/src/i18n"));
  ({ said, named } = undoLines(words));
});

beforeEach(() => {
  for (const each of methods.values()) each.mockReset();
  method("getLibrary").mockResolvedValue(planning);
  method("getOrganizeReview").mockResolvedValue(empty);
  useAppStore.setState({ layout: libraryShown, library: planning, documents: [] });
  flow.useOrganizeReview.setState({
    review: null,
    count: null,
    open: false,
    run: null,
    stopped: null,
    estimate: null,
    shownAll: new Set(),
  });
  useUndo.setState({ done: [], undone: [], line: null, running: null, making: 0 });
  useNotices.setState({ confirmation: null });
  organizing.useOrganizeAsk.getState().close();
});

const state = () => flow.useOrganizeReview.getState();

describe("an Organize run", () => {
  test("says how far it is, and opens the Review only once it ends with something to review", async () => {
    const result = Promise.withResolvers<OrganizeLibraryResult>();
    method("organizeLibrary").mockReturnValue(result.promise);

    const running = flow.organize({ documentIds: ["d-1", "d-2"] });
    expect(method("organizeLibrary")).toHaveBeenCalledWith({ documentIds: ["d-1", "d-2"] });
    expect(state().run).toEqual({
      input: { documentIds: ["d-1", "d-2"] },
      runId: null,
      waiting: 0,
      done: 0,
      total: 0,
    });

    emit("organize.progress", { runId: "run-1", waiting: 2, done: 0, total: 2 });
    expect(state().run).toMatchObject({ runId: "run-1", waiting: 2, done: 0, total: 2 });
    emit("organize.progress", { runId: "run-other", waiting: 0, done: 9, total: 9 });
    emit("organize.progress", { runId: "run-1", waiting: 0, done: 1, total: 2 });
    expect(state().run).toMatchObject({ runId: "run-1", waiting: 0, done: 1, total: 2 });
    expect(state().open).toBe(false);

    method("getOrganizeReview").mockResolvedValue(waiting);
    result.resolve(planned(2));
    await running;
    expect(state()).toMatchObject({ open: true, run: null, review: waiting, count: 2 });
  });

  test("with the Library out of view, the Review waits, counted, and doesn't open", async () => {
    useAppStore.setState({ layout: noteShown });
    method("organizeLibrary").mockResolvedValue(planned(2));
    method("getOrganizeReview").mockResolvedValue(waiting);

    await flow.organize({});
    expect(state()).toMatchObject({ open: false, run: null, count: 2 });
  });

  test("that proposes nothing says so, and opens nothing", async () => {
    method("organizeLibrary").mockResolvedValue(planned(0));

    await flow.organize({});
    expect(state()).toMatchObject({ open: false, run: null });
    const told = useNotices.getState().confirmation?.message;
    expect(told && translate("en", told)).toBe(
      "Organize found no Folder to suggest for these Documents",
    );
    expect(told && translate("zh-CN", told)).toBe("未能为这些文档推荐文件夹");
  });

  test("Stop ends it with how many it had read, and opens nothing", async () => {
    const result = Promise.withResolvers<OrganizeLibraryResult>();
    method("organizeLibrary").mockReturnValue(result.promise);

    const running = flow.organize({});
    emit("organize.progress", { runId: "run-1", waiting: 0, done: 12, total: 40 });
    flow.stopOrganizing();
    expect(method("stopOrganizeLibrary")).toHaveBeenCalledOnce();
    result.resolve({ status: "stopped", runId: "run-1" });
    await running;
    expect(state()).toMatchObject({ stopped: 12, run: null, open: false });
  });
});

describe("Organize, wherever it is asked from", () => {
  test("with a model that plans, plans these Documents, or the Library's in no Folder", async () => {
    method("organizeLibrary").mockResolvedValue(planned(0));

    await organizing.organizeDocuments(["d-1"]);
    expect(method("organizeLibrary")).toHaveBeenLastCalledWith({ documentIds: ["d-1"] });
    await organizing.organizeDocuments(null);
    expect(method("organizeLibrary")).toHaveBeenLastCalledWith({});
    await organizing.organizeDocuments(["d-1"], { forService: "service-a" });
    expect(method("organizeLibrary")).toHaveBeenLastCalledWith({
      documentIds: ["d-1"],
      forService: "service-a",
    });
  });

  test("Organize This Folder opens the Library and plans that Folder's own Documents", async () => {
    useAppStore.setState({ layout: noteShown });
    method("changeLayout").mockResolvedValue(libraryShown);
    method("organizeLibrary").mockResolvedValue(planned(2));
    method("getOrganizeReview").mockResolvedValue(waiting);

    await organizing.organizeFolder("contracts");
    expect(method("organizeLibrary")).toHaveBeenCalledWith({ folderId: "contracts" });
    expect(state().open).toBe(true);
  });

  test("with no model chosen, asks for one first and sends nothing", async () => {
    useAppStore.setState({
      library: snapshot({ kind: "automatic" }),
      documents: [doc("d-1"), doc("d-2")],
    });

    await organizing.organizeDocuments(null);
    expect(organizing.useOrganizeAsk.getState().ids).toEqual(["d-1", "d-2"]);
    expect(method("organizeLibrary")).not.toHaveBeenCalled();
  });
});

describe("a change on the Review", () => {
  const ticks = (values: number): OrganizeReviewChange["before"] => [
    { table: "items", id: "1", values: { ticked: values } },
  ];

  test("shows at once, and is one Undo whose steps each hand the core the change it last got", async () => {
    const made: OrganizeReviewChange = { before: ticks(1), after: ticks(0) };
    const undone: OrganizeReviewChange = { before: ticks(0), after: ticks(1) };
    const redone: OrganizeReviewChange = { before: ticks(1), after: ticks(0) };
    flow.useOrganizeReview.setState({ review: waiting, open: true });
    method("editOrganizeReview").mockResolvedValue(made);
    method("getOrganizeReview").mockResolvedValue({
      ...waiting,
      items: [row("1", { ticked: false }), row("2")],
    });

    const editing = flow.editReview({ kind: "tick", itemIds: ["1"], ticked: false });
    expect(state().review?.items.map((each) => each.ticked)).toEqual([false, true]);
    await editing;
    expect(method("editOrganizeReview")).toHaveBeenCalledWith({
      kind: "tick",
      itemIds: ["1"],
      ticked: false,
    });
    expect(useUndo.getState().done).toHaveLength(1);
    expect(named(useUndo.getState().done[0])).toBe("Change to Suggested Folders");

    const restore = method("restoreOrganizeReview");
    restore.mockResolvedValueOnce(undone).mockResolvedValueOnce(redone);
    await useUndo.getState().undo();
    await useUndo.getState().redo();
    await useUndo.getState().undo();
    const [first, second, third] = restore.mock.calls;
    expect(restore).toHaveBeenCalledTimes(3);
    // The same rows each time: only which change was handed back tells the steps apart.
    expect(first?.[0]).toBe(made.before);
    expect(first?.[1]).toBe(made.after);
    expect(second?.[0]).toBe(undone.before);
    expect(second?.[1]).toBe(undone.after);
    expect(third?.[0]).toBe(redone.before);
    expect(third?.[1]).toBe(redone.after);
  });

  test("that changed nothing is no Undo", async () => {
    flow.useOrganizeReview.setState({ review: waiting, open: true });
    method("editOrganizeReview").mockResolvedValue({ before: [], after: [] });

    await flow.editReview({ kind: "tick", itemIds: ["1"], ticked: true });
    expect(useUndo.getState().done).toHaveLength(0);
  });
});

describe("Confirm", () => {
  test("files what is ticked as one step, whose Undo brings the Review back as it was", async () => {
    const confirmation: OrganizeReviewConfirmation = {
      id: "confirmation-1",
      documentIds: ["d-1", "d-2"],
      folderIds: ["f-leases"],
      tagIds: [],
    };
    flow.useOrganizeReview.setState({ review: waiting, open: true });
    method("confirmOrganizeReview").mockResolvedValue(confirmation);

    await flow.confirmReview();
    expect(method("confirmOrganizeReview")).toHaveBeenCalledWith(["1", "2"]);
    expect(state().open).toBe(false);
    const { done } = useUndo.getState();
    expect(done).toHaveLength(1);
    expect(said(done[0])).toBe("Organized 2 Documents");
    expect(named(done[0])).toBe("Organize");

    method("getOrganizeReview").mockResolvedValue(waiting);
    await useUndo.getState().undo();
    expect(method("undoOrganizeReviewConfirmation")).toHaveBeenCalledWith("confirmation-1");
    expect(state()).toMatchObject({ open: true, review: waiting });

    method("getOrganizeReview").mockResolvedValue(empty);
    await useUndo.getState().redo();
    expect(method("redoOrganizeReviewConfirmation")).toHaveBeenCalledWith("confirmation-1");
    expect(state().open).toBe(false);
  });

  test("that filed nothing is no Undo", async () => {
    flow.useOrganizeReview.setState({ review: waiting, open: true });
    method("confirmOrganizeReview").mockResolvedValue(null);

    await flow.confirmReview();
    expect(state().open).toBe(false);
    expect(useUndo.getState().done).toHaveLength(0);
  });
});
