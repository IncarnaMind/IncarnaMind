import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  DEFAULT_ASSISTANT,
  type EditWithAiResult,
  MIND_CONTENT_FIELD,
  PROPOSAL_ATTRIBUTE,
  type WindowLayout,
} from "../../src/core/api";
import { fingerprintOfMind } from "../../src/shared/mindState";
import { recordProposalRequest, resolveProposals } from "../../src/shared/proposals";
import { stubEditorDom } from "../helpers/editorDom";

/*
 * Each tab's copy of its Note and the Undo history its editors share (#3115): editors bound to the
 * copies a tab keeps, kept in step through a stand-in for the core that keeps the Note's document
 * and sends every change to every copy, as the core does.
 */

const MIND = "note";

type MindUpdate = { mindId: string; update: Uint8Array; cause?: unknown };

const bridge = vi.hoisted(() => ({
  listeners: new Set<(payload: MindUpdate) => void>(),
  openMind: async (_mindId: string): Promise<unknown> => null,
  applyMindUpdate: async (_mindId: string, _update: Uint8Array): Promise<void> => undefined,
  opened: 0,
  closed: 0,
  /** What else was asked of the core, in order. */
  calls: [] as string[],
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: (name: string, listener: (payload: MindUpdate) => void) => {
      if (name !== "mind.update") return () => undefined;
      bridge.listeners.add(listener);
      return () => bridge.listeners.delete(listener);
    },
    openMind: (mindId: string) => {
      bridge.opened++;
      return bridge.openMind(mindId);
    },
    applyMindUpdate: (mindId: string, update: Uint8Array) => bridge.applyMindUpdate(mindId, update),
    closeMind: async () => {
      bridge.closed++;
    },
    settleUnfinished: async (mindId: string) => {
      bridge.calls.push(`settleUnfinished:${mindId}`);
    },
    undoAskedChanges: async (undoId: string) => {
      bridge.calls.push(`undoAskedChanges:${undoId}`);
      return null;
    },
    redoAskedChanges: async () => null,
    releaseAskedChanges: async (undoId: string) => {
      bridge.calls.push(`releaseAskedChanges:${undoId}`);
    },
    recordAiUse: async () => undefined,
    saveCheckpoint: async () => undefined,
    undoComparisonStructure: async ({ step }: { step: string }) => {
      bridge.calls.push(`undoComparisonStructure:${step}`);
      return { moved: true };
    },
    watchComparisonMind: async () => undefined,
    unwatchComparisonMind: async () => undefined,
  },
}));

const { flushMindUpdates, openMindCopy } = await import("../../src/renderer/src/mindCopies");
const { holdTabCopy, tabCopyNow } = await import("../../src/renderer/src/tabCopies");
const { drawHistory, keptHistory } = await import("../../src/renderer/src/editor/keptHistories");
const { followSteps, offerEditorUndo } = await import("../../src/renderer/src/editor/editorUndo");
const { cursorAtLeaving, cursorToKeep, shownSelection } = await import(
  "../../src/renderer/src/editor/shownSelection"
);
const { offerStructureUndo, reserveStructureStep, undoNoteHistory } = await import(
  "../../src/renderer/src/editor/comparisonStructureUndo"
);
const { useUndo, nextToUndo } = await import("../../src/renderer/src/undo");
const { useAppStore } = await import("../../src/renderer/src/store");
const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");
const { ProposalReview, proposalsIn } = await import(
  "../../src/renderer/src/editor/proposalReview"
);
const { AppliedEditLine, appliedLineIn } = await import(
  "../../src/renderer/src/editor/appliedEditLine"
);
const { actOnAppliedEdit, applyArrived, finishApplying, startApplying } = await import(
  "../../src/renderer/src/appliedEdits"
);

let server: Y.Doc;
const cleanups: (() => void)[] = [];

/** The core sends an update to every copy, with `cause` for an edit asked for. */
function send(update: Uint8Array, cause?: unknown): void {
  for (const listener of [...bridge.listeners]) {
    listener({ mindId: MIND, update, ...(cause !== undefined && { cause }) });
  }
}

beforeEach(() => {
  stubEditorDom();
  server = new Y.Doc();
  server.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph("Mine:"), paragraph("Theirs:")]);
  bridge.opened = 0;
  bridge.closed = 0;
  bridge.calls = [];
  bridge.openMind = async () => ({ state: Y.encodeStateAsUpdate(server), access: "edit" });
  bridge.applyMindUpdate = async (_mindId, update) => {
    Y.applyUpdate(server, update);
    send(update);
  };
  useUndo.setState({ done: [], undone: [], aside: [], line: null });
  showTabs(["tab-1", "tab-2"]);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  showTabs([]);
  bridge.listeners.clear();
  vi.unstubAllGlobals();
});

function paragraph(text: string): Y.XmlElement {
  const node = new Y.XmlElement("paragraph");
  node.insert(0, [new Y.XmlText(text)]);
  return node;
}

/** The window's tabs, each showing the Note, in one group. */
function showTabs(tabIds: readonly string[]): void {
  useAppStore.setState({
    layout: {
      groups: [
        {
          id: "group",
          tabs: tabIds.map((id) => ({
            id,
            item: { kind: "mind", mindId: MIND },
            preview: false,
            pinned: false,
            place: null,
            opened: 0,
          })),
          activeTabId: tabIds[0] ?? null,
          width: 1,
        },
      ],
      focusedGroupId: "group",
      reopenable: 0,
      conversationId: null,
      assistant: DEFAULT_ASSISTANT,
    } satisfies WindowLayout,
  });
}

/** The tab's copy of the Note and the history it keeps. */
function tabCopy(tabId: string): Promise<{ doc: Y.Doc; history: Y.UndoManager }> {
  return new Promise((resolve, reject) => {
    const stop = holdTabCopy(
      tabId,
      MIND,
      ({ copy, history }) =>
        copy.doc && history ? resolve({ doc: copy.doc, history }) : reject(new Error("No copy.")),
      reject,
    );
    cleanups.push(stop);
  });
}

/** An editor of the Note; `review` draws Proposals and the line under an edit, as the window does. */
function editorOn(doc: Y.Doc, history: Y.UndoManager | null, review = false): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({
        document: doc,
        field: MIND_CONTENT_FIELD,
        ...(history && { yUndoOptions: { undoManager: history } }),
      }),
      ...(review
        ? [
            ProposalReview,
            AppliedEditLine.configure({ translate: (key: string) => key, undoKeys: () => "" }),
          ]
        : []),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return editor;
}

/**
 * The Note shown in a tab: an editor drawn there, and what ends it as a tab switch does: `hide` at
 * once, `away` as the window does, the editor ending after the tab has heard it no longer shows.
 */
async function showInTab(tabId: string, review = false) {
  const { doc, history } = await tabCopy(tabId);
  const editor = editorOn(doc, history, review);
  const undraw = drawHistory(history, editor);
  let shown = true;
  const hide = () => {
    if (!shown) return;
    shown = false;
    undraw();
    editor.destroy();
  };
  const away = async () => {
    if (!shown) return;
    shown = false;
    undraw();
    await ticked();
    editor.destroy();
  };
  cleanups.push(hide);
  return { editor, doc, history, hide, away };
}

/** A window of its own showing the Note: a copy that is no tab's here. */
async function anotherWindow(): Promise<Editor> {
  const doc = await new Promise<Y.Doc>((resolve, reject) => {
    cleanups.push(openMindCopy(MIND, (copy) => (copy.doc ? resolve(copy.doc) : reject()), reject));
  });
  const editor = editorOn(doc, null);
  cleanups.push(() => editor.destroy());
  return editor;
}

/** Lets the window's own changes run, as after a tab switch's frame. */
const ticked = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Types at the end of the line that starts with `line`. */
function typeIn(editor: Editor, line: string, typed: string): void {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent.startsWith(line))
      at = pos + node.nodeSize - 1;
  });
  if (at < 0) throw new Error(`No line "${line}".`);
  editor.view.dispatch(editor.state.tr.insertText(typed, at));
}

const linesOf = (editor: Editor): string[] => {
  const lines: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isTextblock) lines.push(node.textContent);
  });
  return lines;
};

async function settled(editor: Editor, lines: readonly string[]): Promise<void> {
  await flushMindUpdates(MIND);
  await vi.waitFor(() => expect(linesOf(editor)).toEqual(lines));
}

/** The core writes into the Note, as one update it sends every copy. */
function fromCore(change: (note: Y.XmlFragment) => void, cause?: unknown): void {
  let update: Uint8Array | null = null;
  const take = (each: Uint8Array) => {
    update = each;
  };
  server.on("update", take);
  server.transact(() => change(server.getXmlFragment(MIND_CONTENT_FIELD)));
  server.off("update", take);
  if (!update) throw new Error("The core changed nothing.");
  send(update, cause);
}

const firstText = (note: Y.XmlFragment, index: number): Y.XmlText => {
  const element = note.get(index);
  const text = element instanceof Y.XmlElement ? element.get(0) : null;
  if (!(text instanceof Y.XmlText)) throw new Error("No text there.");
  return text;
};

describe("a tab's copy of its Note", () => {
  // protects=a tab switch ends only the editor: the editor drawn when the Note shows again binds the same copy and history, so its ⌘Z takes back what was typed before, ⇧⌘Z puts it back, through several switches, and the Note isn't asked of the core again (#3115); fails_when=the next editor starts with an empty history, or the copy is opened again; no_claim=the window's drawing, which the smoke spec shows.
  test("the editor drawn when the Note shows again takes back what was typed before, through several switches", async () => {
    const first = await showInTab("tab-1");
    typeIn(first.editor, "Mine:", " one");
    first.history.stopCapturing();
    first.hide();
    const second = await showInTab("tab-1");
    expect(second.history).toBe(first.history);
    typeIn(second.editor, "Mine:", " two");
    second.history.stopCapturing();
    second.hide();
    const third = await showInTab("tab-1");
    await settled(third.editor, ["Mine: one two", "Theirs:"]);
    expect(bridge.opened).toBe(1);
    expect(bridge.closed).toBe(0);

    expect(third.editor.commands.undo()).toBe(true);
    await settled(third.editor, ["Mine: one", "Theirs:"]);
    expect(third.editor.commands.undo()).toBe(true);
    await settled(third.editor, ["Mine:", "Theirs:"]);
    third.hide();
    const fourth = await showInTab("tab-1");
    expect(fourth.editor.commands.redo()).toBe(true);
    await settled(fourth.editor, ["Mine: one", "Theirs:"]);
    expect(linesOf(fourth.editor)).toEqual(["Mine: one", "Theirs:"]);
  });

  // protects=the history ends where a User would expect: the tab closing takes its copy and history with it, and a Note opened later in a tab starts with none (#3115); fails_when=a closed tab's history comes back, or its copy stays open; no_claim=Reopen closed tab, which opens a tab anew.
  test("a tab closed takes its copy and history with it; the Note opened later starts with none", async () => {
    const shown = await showInTab("tab-1");
    typeIn(shown.editor, "Mine:", " typed");
    await flushMindUpdates(MIND);
    shown.hide();
    showTabs(["tab-2"]);
    expect(keptHistory(shown.history)).toBeUndefined();
    expect(tabCopyNow("tab-1", MIND)).toBeNull();
    expect(bridge.closed).toBe(1);

    showTabs(["tab-1", "tab-2"]);
    const later = await showInTab("tab-1");
    expect(later.history).not.toBe(shown.history);
    await settled(later.editor, ["Mine: typed", "Theirs:"]);
    expect(later.editor.commands.undo()).toBe(false);
    expect(bridge.opened).toBe(2);
  });

  // protects=two tabs showing one Note each keep their own history: ⌘Z in one takes back only what was typed in it (#3115); fails_when=one tab's ⌘Z takes back the other's typing; no_claim=two windows, which the next test holds.
  test("two tabs of one Note keep a history each", async () => {
    const one = await showInTab("tab-1");
    const two = await showInTab("tab-2");
    typeIn(one.editor, "Mine:", " in one");
    await settled(two.editor, ["Mine: in one", "Theirs:"]);
    typeIn(two.editor, "Theirs:", " in two");
    await settled(one.editor, ["Mine: in one", "Theirs: in two"]);
    expect(one.history).not.toBe(two.history);

    expect(one.editor.commands.undo()).toBe(true);
    await settled(two.editor, ["Mine:", "Theirs: in two"]);
    expect(one.editor.commands.undo()).toBe(false);
    expect(two.editor.commands.undo()).toBe(true);
    await settled(one.editor, ["Mine:", "Theirs:"]);
  });

  // protects=an editor drawn for the tab before the last one ended, as a tab moved to another group or merged groups splitting again, records what is typed in it, and the history's listeners don't pile up over many switches: each ended editor takes off its own (#3115); fails_when=typing after a move isn't taken back, ⌘Z takes back the wrong step, or every switch leaves a listener holding an editor; no_claim=y-tiptap's own code, which tests/scripts/yTiptapPatch.test.ts reads.
  test("an editor drawn before the last one ended records its typing, and switches leave no listeners behind", async () => {
    const before = await showInTab("tab-1");
    typeIn(before.editor, "Mine:", " before");
    before.history.stopCapturing();
    const moved = await showInTab("tab-1");
    before.hide();
    typeIn(moved.editor, "Mine:", " after");
    moved.history.stopCapturing();
    expect(moved.editor.commands.undo()).toBe(true);
    await settled(moved.editor, ["Mine: before", "Theirs:"]);
    moved.hide();

    const observers = (moved.history as unknown as { _observers: Map<string, Set<unknown>> })
      ._observers;
    const counts = () =>
      ["stack-item-added", "stack-item-popped"].map((name) => observers.get(name)?.size ?? 0);
    const before10 = counts();
    for (let round = 0; round < 10; round++) (await showInTab("tab-1")).hide();
    expect(counts()).toEqual(before10);
    const last = await showInTab("tab-1");
    expect(last.editor.commands.undo()).toBe(true);
    await settled(last.editor, ["Mine:", "Theirs:"]);
  });

  // protects=a Note changed by someone else while its tab is hidden: another tab's or window's typing, the core's own write, an edit asked elsewhere and a check's mark are no steps of the hidden tab's history; back in the tab, ⌘Z takes back only what was typed there, never another's words, and nothing typed is lost (#3115); fails_when=⌘Z after coming back takes back or deletes what someone else wrote, or loses the tab's own typing; no_claim=the meeting fill's own rules, which tests/renderer/meetingFillUndo.test.ts holds.
  test("changes made elsewhere while the tab is hidden are no steps of its history", async () => {
    const shown = await showInTab("tab-1");
    typeIn(shown.editor, "Mine:", " mine");
    shown.history.stopCapturing();
    await flushMindUpdates(MIND);
    shown.hide();
    await ticked();

    const window = await anotherWindow();
    await settled(window, ["Mine: mine", "Theirs:"]);
    typeIn(window, "Mine:", " window");
    const other = await showInTab("tab-2");
    typeIn(other.editor, "Theirs:", " tab");
    await flushMindUpdates(MIND);
    fromCore((note) => note.push([paragraph("Core wrote this")]));
    fromCore((note) => note.push([paragraph("Asked elsewhere")]), {
      requestId: "elsewhere",
      request: "elsewhere",
    });
    fromCore((note) => firstText(note, 1).format(0, 3, { bold: {} }));
    const steps = shown.history.undoStack.length;

    const back = await showInTab("tab-1");
    const everyone = ["Mine: mine window", "Theirs: tab", "Core wrote this", "Asked elsewhere"];
    await settled(back.editor, everyone);
    expect(back.history.undoStack.length).toBe(steps);
    expect(back.editor.commands.undo()).toBe(true);
    await settled(back.editor, [
      "Mine: window",
      "Theirs: tab",
      "Core wrote this",
      "Asked elsewhere",
    ]);
    expect(back.editor.commands.undo()).toBe(false);
    await settled(window, ["Mine: window", "Theirs: tab", "Core wrote this", "Asked elsewhere"]);
    expect(back.editor.commands.redo()).toBe(true);
    await settled(window, everyone);
  });

  // protects=a change offered on the app's Undo from a tab's editor keeps its place through a tab switch: while no editor of the tab shows, ⌘Z passes over it and its line goes; the tab's next editor reaches it again, and ⌘Z there takes it back in the Note; the tab closing takes it off the stack (#3115); fails_when=⌘Z takes it back out of sight, its line stays, it isn't reached again, or a closed tab leaves it on the stack; no_claim=the edit's own line in the page, which the smoke spec shows.
  test("an editor's change on the app's Undo keeps its place through a switch, and goes with its tab", async () => {
    const shown = await showInTab("tab-1");
    typeIn(shown.editor, "Mine:", " changed");
    const offer = offerEditorUndo(shown.editor, (t) => t("aiText.markedAsMine"));
    const change = offer.change;
    expect(useUndo.getState().line?.change).toBe(change);
    shown.hide();
    await ticked();
    expect(useUndo.getState().done).toEqual([change]);
    expect(useUndo.getState().aside).toEqual([change]);
    expect(useUndo.getState().line).toBeNull();
    expect(nextToUndo(useUndo.getState())).toBeUndefined();

    const back = await showInTab("tab-1");
    await ticked();
    expect(useUndo.getState().aside).toEqual([]);
    expect(nextToUndo(useUndo.getState())).toBe(change);
    await useUndo.getState().undo();
    await settled(back.editor, ["Mine:", "Theirs:"]);
    expect(useUndo.getState().undone).toEqual([change]);
    await useUndo.getState().redo();
    await settled(back.editor, ["Mine: changed", "Theirs:"]);

    showTabs(["tab-2"]);
    expect(useUndo.getState().done).toEqual([]);
    expect(useUndo.getState().undone).toEqual([]);
  });
});

/** Writes the Note's Blocks as `content`, as an editor's binding writes them: only what differs. */
function writeAs(note: Y.XmlFragment, content: JSONContent[]): void {
  const source = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: { type: "doc", content },
  });
  prosemirrorToYXmlFragment(source.state.doc, note);
  source.destroy();
}

/** The Note as the core keeps it, with an edit asked for (`request`). */
function serverWith(content: JSONContent[]): void {
  server = new Y.Doc();
  writeAs(server.getXmlFragment(MIND_CONTENT_FIELD), content);
  recordProposalRequest(server, "request", {
    source: "edit-with-ai",
    requested: "edit",
    providerId: "local",
    modelId: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

const ORIGINAL: JSONContent = {
  type: "paragraph",
  attrs: { id: "original" },
  content: [{ type: "text", text: "Original" }],
};

/** A paragraph an edit asked for wrote, waiting as a Proposal. */
const PROPOSED: JSONContent = {
  type: "paragraph",
  attrs: {
    id: "added",
    [PROPOSAL_ATTRIBUTE]: { id: "change", request: "request", kind: "insert" },
  },
  content: [{ type: "text", text: "AI text" }],
};

const WROTE_ONE = { created: false, changed: 0, wrote: 1, tables: 0 };

const proposed = (held: boolean): EditWithAiResult => ({
  kind: "proposed",
  request: "request",
  proposals: 1,
  droppedCitations: 0,
  outOfDate: 0,
  ...(held && { held: true }),
  stateVector: Y.encodeStateVector(server),
});

describe("an edit through a tab switch", () => {
  // protects=a change the core applied for the assistant in a tab's Note keeps its place on the app's Undo through a tab switch: while no editor of the tab shows the Note, ⌘Z passes over it and asks the core nothing, its line goes, and the tab's next editor draws its line again and reaches it (#3115); fails_when=⌘Z on another tab takes it back unseen, it is released, or it isn't reached again; no_claim=the core's own Undo, which tests/renderer/coreApplied.test.ts holds.
  test("a change the core applied keeps its place on the app's Undo, out of reach while its tab is hidden", async () => {
    serverWith([ORIGINAL, PROPOSED]);
    const reviewBefore = Y.encodeStateAsUpdate(server);
    resolveProposals(server.getXmlFragment(MIND_CONTENT_FIELD), () => true, "accept");
    const application = {
      undoId: "core-undo",
      reviewBefore,
      afterVector: Y.encodeStateVector(server),
      afterFingerprint: fingerprintOfMind(server),
      accepted: ["change"],
      requests: ["request"],
      held: false,
    };
    const shown = await showInTab("tab-1", true);
    expect(applyArrived(shown.editor, MIND, new Set(["request"]), WROTE_ONE, { application })).toBe(
      "applied",
    );
    const [change] = useUndo.getState().done;
    expect(change).toBeDefined();

    await shown.away();
    expect(useUndo.getState().done).toEqual([change]);
    expect(useUndo.getState().aside).toEqual([change]);
    expect(nextToUndo(useUndo.getState())).toBeUndefined();
    await useUndo.getState().undo();
    expect(bridge.calls).toEqual([]);

    const back = await showInTab("tab-1", true);
    await ticked();
    expect(useUndo.getState().aside).toEqual([]);
    expect(appliedLineIn(back.editor.state)?.kind).toBe("applied");
    expect(nextToUndo(useUndo.getState())).toBe(change);
    expect(bridge.calls).toEqual([`settleUnfinished:${MIND}`]);
    await useUndo.getState().undo();
    expect(bridge.calls).toContain("undoAskedChanges:core-undo");
  });

  // protects=an edit held back keeps its line through a tab switch, and Apply in the tab's next editor applies it there as one step: its line says what changed, it is on the app's Undo, and ⌘Z takes it back to waiting (#3115); fails_when=Apply after the switch accepts the changes with no line and nothing on the app's Undo; no_claim=whether an edit is held, the core's call.
  test("an edit held back applies from its line in the tab's next editor, with its line and Undo", async () => {
    serverWith([ORIGINAL, PROPOSED]);
    const first = await showInTab("tab-1", true);
    const edit = startApplying(first.editor, MIND, "req-1");
    if (!edit) throw new Error("The edit didn't start.");
    expect(await finishApplying(edit, proposed(true))).toBe("held");
    await first.away();

    const second = await showInTab("tab-1", true);
    await ticked();
    expect(appliedLineIn(second.editor.state)?.kind).toBe("held");
    actOnAppliedEdit(second.editor, "apply");
    expect(proposalsIn(second.editor.state.doc)).toHaveLength(0);
    expect(appliedLineIn(second.editor.state)?.kind).toBe("applied");
    expect(useUndo.getState().done).toHaveLength(1);
    await useUndo.getState().undo();
    expect(proposalsIn(second.editor.state.doc)).toHaveLength(1);
  });

  // protects=an edit still being written as its tab is hidden goes on writing into the tab's copy, as one step, and applies in the tab's next editor with its line and its Undo; one that comes back while the tab shows something else waits to be reviewed, with no step of Undo that would take it out unseen (#3115); fails_when=the edit is lost, applies with no line or Undo, or ⌘Z takes its changes out while they wait; no_claim=the edit's words, the model's.
  test("an edit written while its tab is hidden applies once the tab shows it, or waits to be reviewed", async () => {
    serverWith([ORIGINAL]);
    const cause = { requestId: "req-1", request: "request", apply: true };
    const first = await showInTab("tab-1", true);
    const edit = startApplying(first.editor, MIND, "req-1");
    if (!edit) throw new Error("The edit didn't start.");
    fromCore((note) => writeAs(note, [ORIGINAL, PROPOSED]), cause);
    await first.away();
    fromCore((note) => firstText(note, 1).insert(7, ", more"), cause);
    const second = await showInTab("tab-1", true);
    await ticked();
    expect(await finishApplying(edit, proposed(false))).toMatchObject({
      applied: { paragraphs: 1, tables: 0 },
    });
    expect(linesOf(second.editor)).toEqual(["Original", "AI text, more"]);
    expect(appliedLineIn(second.editor.state)?.kind).toBe("applied");
    expect(useUndo.getState().done).toHaveLength(1);
    await useUndo.getState().undo();
    await settled(second.editor, ["Original"]);

    const later = startApplying(second.editor, MIND, "req-2");
    if (!later) throw new Error("The edit didn't start.");
    fromCore((note) => writeAs(note, [ORIGINAL, PROPOSED]), { ...cause, requestId: "req-2" });
    await second.away();
    expect(await finishApplying(later, proposed(false))).toBeNull();
    const third = await showInTab("tab-1", true);
    await settled(third.editor, ["Original", "AI text"]);
    expect(proposalsIn(third.editor.state.doc)).toHaveLength(1);
    expect(third.editor.commands.undo()).toBe(false);
    expect(proposalsIn(third.editor.state.doc)).toHaveLength(1);
  });
});

const made = (text: string): JSONContent => ({ type: "text", text });
const inParagraph = (text: string): JSONContent => ({ type: "paragraph", content: [made(text)] });
const heading = (text: string): JSONContent => ({
  type: "heading",
  attrs: { level: 2 },
  content: [made(text)],
});

/** Every kind of Block a step of the User's can insert with words in it, but a paragraph. */
const MADE: readonly (readonly [string, (text: string) => JSONContent])[] = [
  ["a heading", heading],
  [
    "a bullet",
    (text) => ({
      type: "bulletList",
      content: [{ type: "listItem", content: [inParagraph(text)] }],
    }),
  ],
  [
    "a numbered item",
    (text) => ({
      type: "orderedList",
      content: [{ type: "listItem", content: [inParagraph(text)] }],
    }),
  ],
  [
    "a checklist item",
    (text) => ({
      type: "taskList",
      content: [{ type: "taskItem", attrs: { checked: false }, content: [inParagraph(text)] }],
    }),
  ],
  ["a quote", (text) => ({ type: "blockquote", content: [inParagraph(text)] })],
  ["a code block", (text) => ({ type: "codeBlock", content: [made(text)] })],
  [
    "a table",
    (text) => ({
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableCell", content: [inParagraph(text)] }] },
      ],
    }),
  ],
  ["a Question", (text) => ({ type: "question", content: [made(text)] })],
];

/** Makes a Block at the Note's end, as a step of its own. */
function make(editor: Editor, history: Y.UndoManager, block: JSONContent): void {
  editor.commands.insertContentAt(editor.state.doc.content.size, block);
  history.stopCapturing();
}

/** The User's own change, then a Block they make after it. */
function earlierThenMade(editor: Editor, history: Y.UndoManager, block: JSONContent): void {
  typeIn(editor, "Mine:", " earlier");
  history.stopCapturing();
  make(editor, history, block);
}

describe("someone else's words in what the User made", () => {
  // protects=a Block the User made in one tab and another tab then typed in is no longer taken back by the first tab's ⌘Z, shown or hidden, whatever its kind but a paragraph: the other's words stay and ⌘Z goes on to the User's own change before it (#3115); fails_when=⌘Z deletes the other copy's words with the Block, or takes back nothing; no_claim=what Undo leaves of a Block no one else typed in, y-prosemirror's.
  test.each(MADE)("%s another tab typed in is no step of ⌘Z, shown or hidden", async (_, block) => {
    const one = await showInTab("tab-1");
    const two = await showInTab("tab-2");
    earlierThenMade(one.editor, one.history, block("Made"));
    await flushMindUpdates(MIND);
    await vi.waitFor(() => expect(linesOf(two.editor)).toContain("Made"));
    typeIn(two.editor, "Made", " by two");
    await settled(one.editor, ["Mine: earlier", "Theirs:", "Made by two"]);

    expect(one.editor.commands.undo()).toBe(true);
    await settled(two.editor, ["Mine:", "Theirs:", "Made by two"]);
    expect(one.editor.commands.undo()).toBe(false);

    await one.away();
    expect(one.history.redoStack).toHaveLength(1);
    const again = await showInTab("tab-1");
    expect(again.editor.commands.redo()).toBe(true);
    make(again.editor, again.history, block("Also"));
    await flushMindUpdates(MIND);
    await again.away();
    await vi.waitFor(() => expect(linesOf(two.editor)).toContain("Also"));
    typeIn(two.editor, "Also", " while hidden");
    await flushMindUpdates(MIND);
    const back = await showInTab("tab-1");
    const lines = ["Mine: earlier", "Theirs:", "Made by two", "Also while hidden"];
    await settled(back.editor, lines);
    expect(back.editor.commands.undo()).toBe(true);
    await settled(two.editor, ["Mine:", ...lines.slice(1)]);
    expect(back.editor.commands.undo()).toBe(false);
  });

  // protects=a paragraph the User made, which another tab then typed in, stays a step of the first tab's ⌘Z, which takes back only the User's own words in it, as Undo keeps a paragraph that isn't empty: the other tab's words stay, in the paragraph (#3115); fails_when=⌘Z takes the other tab's words, or takes back nothing of the User's; no_claim=Blocks of other kinds, which the test above holds.
  test("a paragraph another tab typed in: ⌘Z takes back the User's words in it and leaves the other's", async () => {
    const one = await showInTab("tab-1");
    const two = await showInTab("tab-2");
    earlierThenMade(one.editor, one.history, inParagraph("Made"));
    await flushMindUpdates(MIND);
    await vi.waitFor(() => expect(linesOf(two.editor)).toContain("Made"));
    typeIn(two.editor, "Made", " by two");
    await settled(one.editor, ["Mine: earlier", "Theirs:", "Made by two"]);
    expect(one.editor.commands.undo()).toBe(true);
    await settled(two.editor, ["Mine: earlier", "Theirs:", " by two"]);
    expect(one.editor.commands.undo()).toBe(true);
    await settled(two.editor, ["Mine:", "Theirs:", " by two"]);
  });

  // protects=another window's words in a Block the User made take its step out too, and with it its entry on the app's Undo, so the Edit menu's Undo can't take them out either (#3115); fails_when=the entry stays and takes the window's words back; no_claim=the tab's own Undo of its own words, which the test above holds.
  test("another window's words in a Block the User made take its Undo off the app's stack", async () => {
    const shown = await showInTab("tab-1");
    make(shown.editor, shown.history, heading("Made"));
    const offer = offerEditorUndo(shown.editor, (t) => t("aiText.markedAsMine"));
    expect(useUndo.getState().done).toEqual([offer.change]);
    const window = await anotherWindow();
    await settled(window, ["Mine:", "Theirs:", "Made"]);
    typeIn(window, "Made", " in the window");
    await settled(shown.editor, ["Mine:", "Theirs:", "Made in the window"]);
    expect(useUndo.getState().done).toEqual([]);
    expect(shown.editor.commands.undo()).toBe(false);
  });

  // protects=what someone else does outside a Block the User made, or a mark on its words as a check's result sets, leaves the User's step where it is: ⌘Z takes the Block back (#3115); fails_when=another copy's typing elsewhere, or a mark, takes the User's step out; no_claim=which marks a check sets.
  test("typing elsewhere, or a mark on its words, leaves the step that made a Block", async () => {
    const one = await showInTab("tab-1");
    const two = await showInTab("tab-2");
    earlierThenMade(one.editor, one.history, heading("Made"));
    await flushMindUpdates(MIND);
    await vi.waitFor(() => expect(linesOf(two.editor)).toContain("Made"));
    typeIn(two.editor, "Theirs:", " elsewhere");
    await flushMindUpdates(MIND);
    fromCore((note) => firstText(note, 2).format(0, 4, { bold: {} }));
    await settled(one.editor, ["Mine: earlier", "Theirs: elsewhere", "Made"]);
    expect(one.editor.commands.undo()).toBe(true);
    await settled(two.editor, ["Mine: earlier", "Theirs: elsewhere"]);
  });
});

/** A heading an edit asked for wrote, waiting as a Proposal. */
const PROPOSED_HEADING: JSONContent = {
  type: "heading",
  attrs: {
    level: 2,
    id: "added",
    [PROPOSAL_ATTRIBUTE]: { id: "change", request: "request", kind: "insert" },
  },
  content: [{ type: "text", text: "AI heading" }],
};

/** An edit asked for in the tab's editor, written by the core as `content` and applied there. */
async function appliedEdit(content: JSONContent[]) {
  const shown = await showInTab("tab-1", true);
  const edit = startApplying(shown.editor, MIND, "req-1");
  if (!edit) throw new Error("The edit didn't start.");
  fromCore((note) => writeAs(note, content), {
    requestId: "req-1",
    request: "request",
    apply: true,
  });
  expect(await finishApplying(edit, proposed(false))).toMatchObject({ applied: {} });
  expect(appliedLineIn(shown.editor.state)?.kind).toBe("applied");
  return shown;
}

/** The Note's lines as the core keeps them. */
function linesOfDoc(doc: Y.Doc): string[] {
  const lines: string[] = [];
  const walk = (element: Y.XmlElement | Y.XmlFragment) => {
    for (const child of element.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const texts = child.toArray().filter((each) => each instanceof Y.XmlText);
      if (texts.length > 0) lines.push(texts.map((each) => each.toString()).join(""));
      else walk(child);
    }
  };
  walk(doc.getXmlFragment(MIND_CONTENT_FIELD));
  return lines;
}

describe("the core writing in what an edit made", () => {
  // protects=words the core writes into a heading an applied edit made, in one change with a paragraph of its own, reach the editor and the Note whole, while the edit's step leaves the history and its line goes: the step is taken out once the editor has drawn the change, not in the middle of it, where redrawing the line would write the editor's older Note back over the change (#3115); fails_when=the core's paragraph or words are lost from the editor or written back out of the Note, or the step and its line stay; no_claim=which edits the core revises in place, the assistant's.
  test("the core's words in a heading an edit made, with a paragraph of its own, reach the Note whole and take the edit's step out", async () => {
    serverWith([ORIGINAL]);
    const shown = await appliedEdit([ORIGINAL, PROPOSED_HEADING]);
    const steps = shown.history.undoStack.length;
    fromCore((note) => {
      firstText(note, 1).insert("AI heading".length, " and more");
      note.push([paragraph("Core line")]);
    });
    const lines = ["Original", "AI heading and more", "Core line"];
    await settled(shown.editor, lines);
    await flushMindUpdates(MIND);
    expect(linesOfDoc(server)).toEqual(lines);
    expect(shown.history.undoStack).toHaveLength(steps - 1);
    expect(appliedLineIn(shown.editor.state)).toBeNull();
  });

  // protects=a Block an edit made, which the core then deletes whole, as it does writing a part again, leaves the edit's step where it is: nothing anyone wrote is inside it any more, so its Undo takes nothing of theirs, and ⌘Z still takes the edit back (#3115); fails_when=the core's deleting a Block an edit made takes the edit's step out of the history; no_claim=what Undo brings back of a Block the core deleted, Yjs's.
  test("a Block an edit made, deleted whole by the core, leaves the edit's step in the history", async () => {
    serverWith([ORIGINAL]);
    const shown = await appliedEdit([ORIGINAL, PROPOSED_HEADING, PROPOSED]);
    const steps = shown.history.undoStack.length;
    fromCore((note) => note.delete(1, 1));
    await settled(shown.editor, ["Original", "AI text"]);
    await flushMindUpdates(MIND);
    expect(linesOfDoc(server)).toEqual(["Original", "AI text"]);
    expect(shown.history.undoStack).toHaveLength(steps);
    expect(shown.editor.commands.undo()).toBe(true);
    await settled(shown.editor, ["Original"]);
  });
});

describe("what follows a tab's history", () => {
  // protects=what follows the steps of a tab's history listens through one set of listeners however many there are, and stops once its steps are off both stacks: twenty edits, each followed and offered, leave the history's listeners as they were after the first (#3115); fails_when=each edit adds listeners to the history for as long as the tab is open; no_claim=the memory the editors held, which the window's measurements report.
  test("twenty edits followed leave the history's listeners as they were", async () => {
    const shown = await showInTab("tab-1");
    const observers = (shown.history as unknown as { _observers: Map<string, Set<unknown>> })
      ._observers;
    const counts = () =>
      ["stack-item-added", "stack-item-popped", "stack-cleared"].map(
        (name) => observers.get(name)?.size ?? 0,
      );
    const edit = (round: number) => {
      typeIn(shown.editor, "Mine:", ` ${round}`);
      shown.history.stopCapturing();
      const top = shown.history.undoStack.at(-1);
      if (top) followSteps(shown.editor, [top]);
      offerEditorUndo(shown.editor, (t) => t("aiText.markedAsMine"));
    };
    edit(0);
    const first = counts();
    for (let round = 1; round <= 20; round++) edit(round);
    expect(counts()).toEqual(first);

    const undone = followSteps(shown.editor, shown.history.undoStack.slice(-1));
    expect(shown.editor.commands.undo()).toBe(true);
    expect(undone?.state()).toBe("undone");
    typeIn(shown.editor, "Theirs:", " new");
    expect(undone?.state()).toBe("undone");
  });
});

describe("the place a tab keeps", () => {
  // protects=the cursor kept for a Note's tab is where the page shows it: an arrow key moves the page's cursor at once and the editor's state a moment later, so a tab switch in between keeps the place after the last keys, not before them; outside the Note's text, the editor's own place counts (#3115); fails_when=the place kept is the editor's older one while the page's cursor has moved on; no_claim=how the browser moves its cursor.
  test("is the page's cursor when the editor's state hasn't caught up with it", async () => {
    const shown = await showInTab("tab-1");
    typeIn(shown.editor, "Mine:", " typed");
    const end = shown.editor.state.selection.anchor;
    const text = shown.editor.view.dom.querySelector("p")?.firstChild ?? null;
    if (!text) throw new Error("No text in the Note.");
    const at = (node: Node, offset: number) => () => ({
      anchorNode: node,
      anchorOffset: offset,
      focusNode: node,
      focusOffset: offset,
    });
    Object.assign(document, { getSelection: at(text, 4) });
    expect(shownSelection(shown.editor)).toEqual({ anchor: 1 + 4, head: 1 + 4 });
    expect(shown.editor.state.selection.anchor).toBe(end);
    Object.assign(document, { getSelection: at(document.body, 0) });
    expect(shownSelection(shown.editor)).toEqual({ anchor: end, head: end });
  });

  // protects=the focus leaving the editor, as ⌘T moves it to make a Note, takes the page's cursor along before the editor's state has caught up with the last keys: the place the page showed as the focus left is the one kept, and a change made to the editor's selection while it had no focus wins over it (#3115); fails_when=the place kept is the editor's older one after ⌘T, or an old place outlives a selection set since; no_claim=where ⌘T puts the focus.
  test("is the page's cursor as the focus left, unless the editor's selection moved since", async () => {
    const shown = await showInTab("tab-1");
    typeIn(shown.editor, "Mine:", " typed");
    const end = shown.editor.state.selection.anchor;
    const text = shown.editor.view.dom.querySelector("p")?.firstChild ?? null;
    if (!text) throw new Error("No text in the Note.");
    const at = (node: Node, offset: number) => () => ({
      anchorNode: node,
      anchorOffset: offset,
      focusNode: node,
      focusOffset: offset,
    });
    Object.assign(document, { getSelection: at(text, 4) });
    const left = cursorAtLeaving(shown.editor);
    Object.assign(document, { getSelection: at(document.body, 0) });
    expect(shown.editor.state.selection.anchor).toBe(end);
    expect(cursorToKeep(shown.editor, left)).toEqual({ anchor: 1 + 4, head: 1 + 4 });

    shown.editor.commands.setTextSelection(2);
    expect(cursorToKeep(shown.editor, left)).toEqual({ anchor: 2, head: 2 });
    expect(cursorToKeep(shown.editor, null)).toEqual({ anchor: 2, head: 2 });
  });
});

describe("an edit that ends with nothing to keep", () => {
  // protects=the steps a failed edit wrote leave the Note's history the way every step does, so what orders the Note's steps with a Comparison's column changes hears it: ⌘Z after an edit that failed takes back the column change made before it, not the typing before that (#3115); fails_when=a failed edit's steps go without a word, and ⌘Z then skips the column change; no_claim=why the edit failed, the core's.
  test("a failed edit's steps leave the history, and ⌘Z takes back the column change before it", async () => {
    serverWith([ORIGINAL]);
    const shown = await showInTab("tab-1", true);
    typeIn(shown.editor, "Original", " typed");
    shown.history.stopCapturing();
    const seq = reserveStructureStep(shown.editor);
    offerStructureUndo(
      shown.editor,
      { mindId: MIND, tableId: "table", step: "column", said: (t) => t("aiText.markedAsMine") },
      seq,
    );
    const edit = startApplying(shown.editor, MIND, "req-1");
    if (!edit) throw new Error("The edit didn't start.");
    fromCore(
      (note) => writeAs(note, [{ ...ORIGINAL, content: [made("Original typed")] }, PROPOSED]),
      {
        requestId: "req-1",
        request: "request",
        apply: true,
      },
    );
    expect(await finishApplying(edit, { kind: "cancelled" })).toBeNull();
    expect(undoNoteHistory(shown.editor)).toBe(true);
    await vi.waitFor(() => expect(bridge.calls).toContain("undoComparisonStructure:column"));
    expect(linesOf(shown.editor)[0]).toBe("Original typed");
  });
});
