import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  DEFAULT_ASSISTANT,
  type EditCause,
  type MeetingFill,
  MIND_CONTENT_FIELD,
  type WindowLayout,
} from "../../src/core/api";
import type { Undoable } from "../../src/renderer/src/undo";
import { meetingFillCause } from "../../src/shared/meetingFill";

/*
 * A Meeting's fill as each copy of its Note takes it on its own Undo (#2527): two editors bound
 * to two copies of one Note, kept in step through a stand-in for the core that keeps the Note's
 * document and sends every change to every copy, as the core does.
 */

const MIND = "meeting-note";
const MEETING = "meeting";

type MindUpdate = { mindId: string; update: Uint8Array; cause?: unknown };

const bridge = vi.hoisted(() => ({
  listeners: new Set<(payload: MindUpdate) => void>(),
  openMind: async (_mindId: string): Promise<unknown> => null,
  applyMindUpdate: async (_mindId: string, _update: Uint8Array): Promise<void> => undefined,
  follows: [] as [string, boolean][],
  /** The fills the store was asked to take back through the core. */
  undoFills: [] as string[],
  /** What Undo said in My notes. */
  told: [] as string[],
  /** The window's Meetings, as the core last sent them: only the fill and its Note matter here. */
  setMeetings: (_meetings: { id: string; mindId: string; fill: MeetingFill | null }[]): void =>
    undefined,
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: (name: string, listener: (payload: MindUpdate) => void) => {
      if (name !== "mind.update") return () => undefined;
      bridge.listeners.add(listener);
      return () => bridge.listeners.delete(listener);
    },
    openMind: (mindId: string) => bridge.openMind(mindId),
    applyMindUpdate: (mindId: string, update: Uint8Array) => bridge.applyMindUpdate(mindId, update),
    closeMind: async () => undefined,
    watchComparisonMind: async () => undefined,
    unwatchComparisonMind: async () => undefined,
  },
}));

vi.mock("../../src/renderer/src/meetings", async () => {
  const { create } = await import("zustand");
  const useMeetings = create(() => ({
    meetings: [] as { id: string; mindId: string; fill: MeetingFill | null }[],
    problems: {},
    followFillUndo: async (meetingId: string, undone: boolean) => {
      bridge.follows.push([meetingId, undone]);
    },
    undoFill: async (meetingId: string) => {
      bridge.undoFills.push(meetingId);
    },
  }));
  bridge.setMeetings = (meetings) => useMeetings.setState({ meetings });
  return { useMeetings };
});

const { openMindCopy, flushMindUpdates } = await import("../../src/renderer/src/mindCopies");
const { takeFillInEditor } = await import("../../src/renderer/src/editor/meetingFillUndo");
const {
  endHandOver,
  fillLineHandedTo,
  fillNextIn,
  fillStateIn,
  fillStepIn,
  letGoOfUndoneFill,
  undoFillInEditor,
} = await import("../../src/renderer/src/meetingFillSteps");
const { nextToRedo, nextToUndo, undoReady, useUndo } = await import("../../src/renderer/src/undo");
const { useAppStore } = await import("../../src/renderer/src/store");
const { showMeetingNoteView, useMeetingNoteViews } = await import(
  "../../src/renderer/src/meetingViews"
);
const { MyNotes, MyNotesHistory, showMyNotes } = await import(
  "../../src/renderer/src/editor/myNotes"
);
const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");

const WORDS = {
  en: {
    own: "My notes",
    heading: "Action items",
    bullet: "Send the pricing note",
    typed: " to Dana",
  },
  "zh-CN": { own: "我的笔记", heading: "待办", bullet: "发送报价说明", typed: "给小王" },
} as const;

let server: Y.Doc;
const cleanups: (() => void)[] = [];
const fill: { send: (mindId: string, update: Uint8Array, cause?: EditCause) => void } = {
  send: () => undefined,
};

beforeEach(() => {
  const document = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  class TransactionOnlyMutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  const window = new Proxy(document.defaultView, {
    get: (target, name) =>
      name === "MutationObserver" ? TransactionOnlyMutationObserver : Reflect.get(target, name),
  });
  Object.assign(document, {
    getSelection: () => null,
    implementation: {
      createHTMLDocument: () =>
        new DOMParser().parseFromString("<html><head></head><body></body></html>", "text/html"),
    },
  });
  for (const [name, value] of Object.entries({
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
  })) {
    vi.stubGlobal(name, value);
  }
  server = new Y.Doc();
  bridge.follows = [];
  bridge.undoFills = [];
  useUndo.setState({ done: [], undone: [], aside: [] });
  showTabs(["tab-1", "tab-2"]);
  bridge.told = [];
  const send = (mindId: string, update: Uint8Array, cause?: EditCause) => {
    for (const listener of [...bridge.listeners]) {
      listener({ mindId, update, ...(cause && { cause }) });
    }
  };
  bridge.openMind = async () => ({ state: Y.encodeStateAsUpdate(server), access: "edit" });
  bridge.applyMindUpdate = async (mindId, update) => {
    Y.applyUpdate(server, update);
    send(mindId, update);
  };
  fill.send = send;
  bridge.setMeetings([{ id: MEETING, mindId: MIND, fill: null }]);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  endHandOver(MEETING);
  useMeetingNoteViews.setState({ views: {}, focus: null, details: null });
  bridge.listeners.clear();
  vi.unstubAllGlobals();
});

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

function setFill(state: MeetingFill["state"]): void {
  bridge.setMeetings([
    { id: MEETING, mindId: MIND, fill: { state, mode: "sections", local: false, problem: null } },
  ]);
}

function element(name: string, children: (Y.XmlElement | Y.XmlText)[], id?: string) {
  const node = new Y.XmlElement(name);
  if (id) node.setAttribute("id", id);
  node.insert(0, children);
  return node;
}

/** The core changes the Note, as one update it sends every copy, with `cause` for an edit asked for. */
function fromCore(change: (note: Y.XmlFragment) => void, cause?: EditCause): void {
  let update: Uint8Array | null = null;
  const take = (each: Uint8Array) => {
    update = each;
  };
  server.on("update", take);
  server.transact(() => change(server.getXmlFragment(MIND_CONTENT_FIELD)));
  server.off("update", take);
  if (!update) throw new Error("The core changed nothing.");
  fill.send(MIND, update, cause);
}

/**
 * The core writes the fill: a heading and a bullet after the User's line, one edit with its cause.
 * With `cited`, the bullet ends in a Citation, found.
 */
function fillFromCore(words: (typeof WORDS)[keyof typeof WORDS], cited = false): void {
  const citation = new Y.XmlElement("citation");
  citation.setAttribute("check", "found");
  const bullet = [new Y.XmlText(words.bullet), ...(cited ? [citation] : [])];
  fromCore(
    (note) =>
      note.push([
        element("heading", [new Y.XmlText(words.heading)], "fill-heading"),
        element("bulletList", [element("listItem", [element("paragraph", bullet)])], "fill-list"),
      ]),
    meetingFillCause(MEETING),
  );
  setFill("filled");
}

/** The fill's first Citation, as the core holds it. */
function citationIn(note: Y.XmlFragment): Y.XmlElement {
  const found = note
    .createTreeWalker((each) => each instanceof Y.XmlElement && each.nodeName === "citation")
    .next();
  if (found.done || !(found.value instanceof Y.XmlElement)) throw new Error("No Citation.");
  return found.value;
}

/** What an Undo says, by its words' keys. */
const saidBy = (
  change:
    | { said: (t: (key: string) => string, cut: (name: string) => string) => string }
    | undefined,
) =>
  change?.said(
    (key) => key,
    (name) => name,
  ) ?? "";

/** A copy of the Note, open in an editor that takes the fill as its own step. */
/** `mine`: the copy can show My notes, with its Undo. */
async function openEditor(mine = false): Promise<Editor> {
  return (await mountEditor(mine)).editor;
}

/**
 * A copy of the Note in a tab's editor, with what ends that editor as a tab switch does: the
 * effect holding the fill first, or the editor first, as either may come first.
 */
async function openInTab(tabId: string) {
  return mountEditor(false, tabId);
}

async function mountEditor(mine: boolean, tabId?: string) {
  const doc = await new Promise<Y.Doc>((resolve, reject) => {
    const close = openMindCopy(
      MIND,
      (copy) => (copy.doc ? resolve(copy.doc) : reject(new Error("No copy."))),
      reject,
    );
    cleanups.push(close);
  });
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      ...(mine
        ? [
            MyNotes,
            MyNotesHistory.configure({
              fillNext: fillNextIn,
              fillState: fillStateIn,
              tell: (said) => bridge.told.push(said),
            }),
          ]
        : []),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  const release = takeFillInEditor(editor, MEETING, tabId);
  let effect = true;
  /** The effect holding the fill ends, the editor still drawn. */
  const endEffect = () => {
    if (!effect) return;
    effect = false;
    release();
  };
  let open = true;
  const close = (first: "effect" | "editor" = "effect") => {
    if (!open) return;
    open = false;
    if (first === "editor") editor.destroy();
    endEffect();
    if (first === "effect") editor.destroy();
  };
  cleanups.push(() => close());
  return { editor, close, release: endEffect };
}

/** Types at the end of the first text holding `words`. */
function typeAfter(editor: Editor, words: string, typed: string): void {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(words)) at = pos + node.nodeSize;
  });
  if (at < 0) throw new Error(`No "${words}" to type after.`);
  editor.view.dispatch(editor.state.tr.insertText(typed, at));
}

async function settled(editor: Editor, text: string): Promise<void> {
  await flushMindUpdates(MIND);
  await vi.waitFor(() => expect(linesOf(editor).join("\n")).toBe(text));
}

/** The Note's lines, one for each paragraph or heading, in order. */
function linesOf(editor: Editor): string[] {
  const lines: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isTextblock) lines.push(node.textContent);
  });
  return lines;
}

/** The User's own line, in the Note before either copy opens. */
function ownLine(words: (typeof WORDS)[keyof typeof WORDS]): void {
  server
    .getXmlFragment(MIND_CONTENT_FIELD)
    .push([element("paragraph", [new Y.XmlText(words.own)], "own")]);
}

describe.each(["en", "zh-CN"] as const)("the fill in two copies of one Note (%s)", (language) => {
  const words = WORDS[language];
  const filledText = `${words.own}\n${words.heading}\n${words.bullet}`;

  // protects=with the Note open twice, words the User typed into a fill bullet in one copy stay when the other copy's ⌘Z or line Undo runs: that copy lets the fill go, so Undo there is the core's, which keeps typed Blocks (#2527); fails_when=⌘Z in the other copy deletes the bullet with the typed words, or its line still offers Undo; no_claim=the window's drawing of the line.
  test("words typed into the fill in one copy stay when the other copy undoes", async () => {
    ownLine(words);
    const first = await openEditor();
    const second = await openEditor();
    setFill("filling");
    fillFromCore(words);
    expect(fillStepIn(MEETING, first)).toBe("top");
    expect(fillStepIn(MEETING, second)).toBe("top");

    typeAfter(first, words.bullet, words.typed);
    const typedText = `${words.own}\n${words.heading}\n${words.bullet}${words.typed}`;
    await settled(second, typedText);
    expect(fillStepIn(MEETING, second)).toBeNull();
    expect(fillStepIn(MEETING, first)).toBe("done");
    expect(await undoFillInEditor(MEETING, second)).toBe(false);

    second.commands.undo();
    await settled(second, typedText);
    await settled(first, typedText);
    expect(bridge.follows).toEqual([]);
  });

  // protects=each copy takes the fill as its own step, so ⌘Z in a copy the User typed in before the fill takes back the fill and keeps the typing; the other copy, its fill taken back there, lets it go, offering no Undo of it (#2527); fails_when=only the last copy opened takes the fill, ⌘Z in the first takes back the User's typing, or the second still holds a fill that is gone; no_claim=two windows' own processes.
  test("⌘Z in either copy takes back the fill alone, and the other copy lets it go", async () => {
    ownLine(words);
    const first = await openEditor();
    const second = await openEditor();
    typeAfter(first, words.own, "!");
    await settled(second, `${words.own}!`);
    setFill("filling");
    fillFromCore(words);
    await settled(first, `${words.own}!\n${words.heading}\n${words.bullet}`);

    first.commands.undo();
    await settled(first, `${words.own}!`);
    await settled(second, `${words.own}!`);
    expect(fillStepIn(MEETING, first)).toBe("undone");
    expect(fillStepIn(MEETING, second)).toBeNull();
    expect(bridge.follows).toEqual([[MEETING, true]]);
    setFill("undone");

    first.commands.redo();
    await settled(second, `${words.own}!\n${words.heading}\n${words.bullet}`);
    expect(fillStepIn(MEETING, first)).toBe("top");
    expect(bridge.follows).toEqual([
      [MEETING, true],
      [MEETING, false],
    ]);
  });

  // protects=a check's result the core writes into the fill afterwards, a Citation marked found or not found, or a mark on its words, leaves the fill on the copy's Undo: ⌘Z still takes it back (#2527); fails_when=the core's mark makes the copy let the fill go, so ⌘Z stops taking the fill back right after it lands; no_claim=which checks run after a fill.
  test.each(["found", "not-found"] as const)(
    "a Citation the core marks %s after the fill, and a mark on its words, leave ⌘Z taking the fill back",
    async (check) => {
      ownLine(words);
      const editor = await openEditor();
      setFill("filling");
      fillFromCore(words, true);
      await settled(editor, filledText);

      fromCore((note) => {
        citationIn(note).setAttribute("check", check === "found" ? "not-found" : "found");
        citationIn(note).setAttribute("check", check);
        const text = citationIn(note).prevSibling;
        if (text instanceof Y.XmlText) text.format(0, words.bullet.length, { highlight: {} });
      });
      await vi.waitFor(() => {
        let marked = "";
        editor.state.doc.descendants((node) => {
          if (node.type.name === "citation") marked = String(node.attrs.check);
        });
        expect(marked).toBe(check);
      });
      expect(fillStepIn(MEETING, editor)).toBe("top");

      editor.commands.undo();
      await settled(editor, words.own);
      expect(bridge.follows).toEqual([[MEETING, true]]);
    },
  );

  // protects=after ⌘Z and Try again, ⇧⌘Z can't bring the first fill back while the new one is written, so the Note never gets both; a fill the core takes back from elsewhere is let go too (#2527); fails_when=⇧⌘Z puts the old fill back during "filling", or a copy keeps offering Undo of a fill the core took back; no_claim=the core's own fill.
  test("a fill the core moves on from, filling anew or taken back elsewhere, leaves the copy's history", async () => {
    ownLine(words);
    const editor = await openEditor();
    setFill("filling");
    fillFromCore(words);
    await settled(editor, filledText);

    // Fill in again lets go at once, before the core says it fills.
    editor.commands.undo();
    await settled(editor, words.own);
    setFill("undone");
    expect(letGoOfUndoneFill(MEETING)).toBe(true);
    editor.commands.redo();
    await settled(editor, words.own);
    expect(fillStepIn(MEETING, editor)).toBeNull();
    setFill("filling");
    fillFromCore(words);
    await settled(editor, filledText);

    // Filling anew from elsewhere, as another window's Fill in again.
    editor.commands.undo();
    await settled(editor, words.own);
    setFill("undone");
    setFill("filling");
    editor.commands.redo();
    await settled(editor, words.own);
    expect(fillStepIn(MEETING, editor)).toBeNull();

    fillFromCore(words);
    await settled(editor, filledText);
    expect(fillStepIn(MEETING, editor)).toBe("top");
    setFill("undone");
    expect(fillStepIn(MEETING, editor)).toBeNull();
    editor.commands.undo();
    await settled(editor, filledText);
  });

  // protects=⌘Z in My notes, when another copy left the User's last step empty, doesn't take back the fill past it: the fill is put back at once and the line says to undo it from Notes (#138); fails_when=Yjs passes over the empty step and the fill goes unseen; no_claim=Yjs's own choice of step.
  test("⌘Z in My notes past a step another copy emptied leaves the fill in place", async () => {
    ownLine(words);
    const first = await openEditor(true);
    const second = await openEditor();
    setFill("filling");
    fillFromCore(words);
    await settled(first, filledText);
    showMyNotes(first, true);
    typeAfter(first, words.own, words.typed);
    const typedText = `${words.own}${words.typed}\n${words.heading}\n${words.bullet}`;
    await settled(second, typedText);
    let end = -1;
    second.state.doc.descendants((node, pos) => {
      if (end < 0 && node.isTextblock && node.textContent === `${words.own}${words.typed}`) {
        end = pos + node.nodeSize - 1;
      }
      return end < 0;
    });
    second.view.dispatch(second.state.tr.delete(end - words.typed.length, end));
    await settled(first, filledText);

    first.commands.undo();
    await settled(first, filledText);
    expect(bridge.told).toEqual(["fillUndo"]);
    expect(fillStepIn(MEETING, first)).toBe("top");
  });

  /** The fill's Undo on the app's stack, reached or not: the editor's own, or its tab's. */
  const fillOnStack = () =>
    useUndo.getState().done.find((change) => saidBy(change).startsWith("meetings.fill"));
  /** What ⌘Z takes back next, and what Edit › Undo names. */
  const next = () => nextToUndo(useUndo.getState());
  /** The fill's Undo is on the stack, and ⌘Z and Edit › Undo pass over it. */
  const passedOver = () => {
    const fill = fillOnStack();
    expect(saidBy(fill)).toBe("meetings.fill.filled");
    expect(useUndo.getState().aside).toContain(fill);
    expect(next()).not.toBe(fill);
  };
  /** The fill's Undo is what ⌘Z takes back next. */
  const reached = () => {
    expect(saidBy(next())).toBe("meetings.fill.filled");
    expect(
      useUndo.getState().done.filter((each) => saidBy(each).startsWith("meetings.fill")),
    ).toHaveLength(1);
  };

  /** The tab's view of the Note, as its chip sets it. */
  const view = (tabId: string, shown: "notes" | "mine" | "transcript") =>
    showMeetingNoteView(tabId, MIND, shown);

  /** A change made after the fill, elsewhere: on the app's stack, recording what is done to it. */
  const later = (log: string[]): Undoable => ({
    said: () => "later",
    name: () => "later",
    undo: async () => {
      log.push("undo later");
    },
    redo: async () => {
      log.push("redo later");
    },
  });

  /** The Note's tab filled: the editor in it holds the fill on top. */
  async function filledInTab(tabId = "tab-1") {
    ownLine(words);
    const opened = await openInTab(tabId);
    setFill("filling");
    fillFromCore(words);
    await settled(opened.editor, filledText);
    return opened;
  }

  // protects=a tab switch is no typing: an editor that ends with the fill's step on top hands it to its tab, whose next editor offers the line, through any number of switches, and ⌘Z there takes back what the User did first and then the fill, through the core; while no editor of the tab shows, the fill's Undo keeps its place and ⌘Z passes over it (#3099); fails_when=the line is lost on a switch, comes back after the User acted, ⌘Z takes the fill back before the User's own step, or reaches it with no editor of its tab; no_claim=how the window draws the line, which the smoke spec shows.
  test.each(["effect", "editor"] as const)(
    "a tab's editor ending with the fill on top hands it to the tab, ⌘Z there taking the User's step first (%s ends first)",
    async (first) => {
      const before = await filledInTab();
      expect(fillStepIn(MEETING, before.editor)).toBe("top");

      before.close(first);
      expect(fillLineHandedTo(MEETING, "tab-1")).toBe(true);
      expect(fillLineHandedTo(MEETING, "tab-2")).toBe(false);
      passedOver();

      const between = await openInTab("tab-1");
      await settled(between.editor, filledText);
      reached();
      between.close();
      passedOver();
      const after = await openInTab("tab-1");
      await settled(after.editor, filledText);
      expect(fillStepIn(MEETING, after.editor)).toBeNull();
      expect(fillLineHandedTo(MEETING, "tab-1")).toBe(true);

      typeAfter(after.editor, words.own, words.typed);
      expect(fillLineHandedTo(MEETING, "tab-1")).toBe(false);
      reached();

      // ⌘Z in a Note: its own history first, then the app's (commands/edit.ts).
      expect(after.editor.commands.undo()).toBe(true);
      await settled(after.editor, filledText);
      expect(bridge.undoFills).toEqual([]);
      expect(after.editor.commands.undo()).toBe(false);
      await useUndo.getState().undo();
      expect(bridge.undoFills).toEqual([MEETING]);
    },
  );

  // protects=the core's Undo takes the place of the editor's on the app's stack, so a change made after the fill stays above it, whichever of the editor and its effect ends first: the editor's ending hands over before its own offer leaves the stack (#3099); fails_when=the fill jumps ahead of the later change, or the stack holds two Undos of the fill; no_claim=what the later change is.
  test.each(["effect", "editor"] as const)(
    "a change made after the fill stays above it through a tab switch (%s ends first)",
    async (first) => {
      const log: string[] = [];
      const before = await filledInTab();
      const fill = fillOnStack();
      const made = later(log);
      useUndo.getState().push(made);
      expect(useUndo.getState().done).toEqual([fill, made]);

      before.close(first);
      const [handed, after] = useUndo.getState().done;
      expect(saidBy(handed)).toBe("meetings.fill.filled");
      expect(handed).not.toBe(fill);
      expect(after).toBe(made);
      await useUndo.getState().undo();
      expect(log).toEqual(["undo later"]);
      expect(bridge.undoFills).toEqual([]);

      const back = await openInTab("tab-1");
      await settled(back.editor, filledText);
      await useUndo.getState().undo();
      expect(bridge.undoFills).toEqual([MEETING]);
    },
  );

  // protects=the hand-over also runs when the effect ends with its editor still drawn: the editor lets go of the fill's step, so its own ⌘Z can't reach it, and the stack holds one Undo of the fill, the core's, which the tab's next effect reaches (#3099); fails_when=the stack holds two Undos of one fill, or the note's own ⌘Z takes the step while the core's Undo is offered; no_claim=when React ends an effect early.
  test("an effect that ends with its editor still drawn hands over once, and the editor lets the step go", async () => {
    const opened = await filledInTab();
    opened.release();
    expect(
      useUndo.getState().done.filter((each) => saidBy(each).startsWith("meetings.fill")),
    ).toHaveLength(1);
    passedOver();
    expect(opened.editor.commands.undo()).toBe(false);
    await settled(opened.editor, filledText);
    const again = takeFillInEditor(opened.editor, MEETING, "tab-1");
    reached();
    await useUndo.getState().undo();
    expect(bridge.undoFills).toEqual([MEETING]);
    again();
  });

  // protects=a closed tab is handed nothing: the layout drops the tab before its editor ends, and the fill's Undo then leaves the stack with the Note, as on main (#3099); fails_when=a line or an Undo of the fill is kept for a tab already closed; no_claim=Reopen closed tab.
  test("an editor ending in a tab the layout has closed hands nothing over", async () => {
    const before = await filledInTab();
    showTabs(["tab-2"]);
    before.close();
    expect(fillLineHandedTo(MEETING, "tab-1")).toBe(false);
    expect(fillOnStack()).toBeUndefined();
    await useUndo.getState().undo();
    expect(bridge.undoFills).toEqual([]);
  });

  // protects=only a step still on top is handed over: once the User typed after the fill, the editor ending hands the tab nothing, so no line comes back (#3099); fails_when=a line or an Undo of the fill comes back after the User typed; no_claim=the User's typed Undo across a tab switch, another issue (#3115).
  test("a tab's editor the User typed in after the fill hands nothing over", async () => {
    const before = await filledInTab();
    typeAfter(before.editor, words.own, words.typed);
    expect(fillStepIn(MEETING, before.editor)).toBe("done");

    before.close();
    expect(fillLineHandedTo(MEETING, "tab-1")).toBe(false);
    const after = await openInTab("tab-1");
    await settled(after.editor, `${words.own}${words.typed}\n${words.heading}\n${words.bullet}`);
    expect(fillOnStack()).toBeUndefined();
  });

  // protects=what a tab was handed goes once the fill moves on: taken back elsewhere, or filled anew, the line and the app's Undo of it go (#3099); fails_when=the tab keeps a line or an Undo for a fill that is gone; no_claim=the tab closing, which the smoke spec shows.
  test.each(["undone", "filling"] as const)(
    "a fill %s elsewhere takes back what its tab was handed",
    async (state) => {
      const before = await filledInTab();
      before.close();
      expect(fillLineHandedTo(MEETING, "tab-1")).toBe(true);
      const after = await openInTab("tab-1");
      await settled(after.editor, filledText);
      reached();

      setFill(state);
      expect(fillLineHandedTo(MEETING, "tab-1")).toBe(false);
      expect(fillOnStack()).toBeUndefined();
    },
  );

  // protects=the fill's Undo is reached only while its text shows: with no editor of its tab open, as from the Transcript's own tab or another Note's, or from another tab that never held the fill, ⌘Z and Edit › Undo pass over it, Edit › Undo is off when it is the only change, and a held ⌘Z steps past it and stops; the tab's editor on Notes reaches it again, and it works (#3099); fails_when=⌘Z elsewhere takes the fill back out of sight, the menu names it or is on for it, or it isn't reached once the Note shows again; no_claim=the Edit menu's words, which the smoke spec reads.
  test("⌘Z elsewhere passes over the handed-over fill, and the tab's editor reaches it again", async () => {
    const before = await filledInTab();
    before.close();
    passedOver();
    expect(undoReady(useUndo.getState())).toBe(false);
    await useUndo.getState().undo();
    await useUndo.getState().undo();
    expect(bridge.undoFills).toEqual([]);

    const elsewhere = await openInTab("tab-2");
    await settled(elsewhere.editor, filledText);
    passedOver();
    await useUndo.getState().undo();
    expect(bridge.undoFills).toEqual([]);
    elsewhere.close();

    const after = await openInTab("tab-1");
    await settled(after.editor, filledText);
    reached();
    expect(undoReady(useUndo.getState())).toBe(true);
    await useUndo.getState().undo();
    expect(bridge.undoFills).toEqual([MEETING]);
  });

  // protects=a held ⌘Z steps past a fill whose text doesn't show to the change below it, and stops; ⇧⌘Z the same way round (#3099); fails_when=⌘Z or ⇧⌘Z takes the hidden fill, or stops short of the change below it; no_claim=the order of changes made in other Notes.
  test("a held ⌘Z steps past the hidden fill and stops; ⇧⌘Z the same way round", async () => {
    const log: string[] = [];
    const made = later(log);
    useUndo.getState().push(made);
    const before = await filledInTab();
    const fill = fillOnStack();
    expect(useUndo.getState().done).toEqual([made, fill]);
    view("tab-1", "transcript");
    await useUndo.getState().undo();
    await useUndo.getState().undo();
    expect(log).toEqual(["undo later"]);
    expect(fillStepIn(MEETING, before.editor)).toBe("top");
    await useUndo.getState().redo();
    await useUndo.getState().redo();
    expect(log).toEqual(["undo later", "redo later"]);

    view("tab-1", "notes");
    await useUndo.getState().undo();
    await useUndo.getState().undo();
    expect(log).toEqual(["undo later", "redo later", "undo later"]);
    await settled(before.editor, words.own);
    view("tab-1", "transcript");
    expect(nextToRedo(useUndo.getState())).toBe(made);
    await useUndo.getState().redo();
    await useUndo.getState().redo();
    expect(log).toEqual(["undo later", "redo later", "undo later", "redo later"]);
    await settled(before.editor, words.own);
    view("tab-1", "notes");
    expect(nextToRedo(useUndo.getState())).toBe(fill);
  });

  // protects=the chip's Transcript view and My notes hide the fill's text, so ⌘Z passes over the fill's Undo the editor holds there; back on Notes it takes the fill back, and a change made after the fill is still taken back first (#3099); fails_when=⌘Z on the Transcript or My notes takes the fill back unseen, or the fill jumps ahead of the later change; no_claim=⌘Z in the note on My notes, which the next test holds.
  test.each(["transcript", "mine"] as const)(
    "on the %s view ⌘Z passes over the fill the editor holds; back on Notes the later change goes first, then the fill",
    async (shown) => {
      const log: string[] = [];
      const { editor } = await filledInTab();
      reached();
      const made = later(log);
      useUndo.getState().push(made);

      view("tab-1", shown);
      passedOver();
      await useUndo.getState().undo();
      expect(log).toEqual(["undo later"]);
      await useUndo.getState().redo();
      await useUndo.getState().undo();
      expect(fillStepIn(MEETING, editor)).toBe("top");

      view("tab-1", "notes");
      // The later change, taken back before the switch, can still be done again after it.
      expect(nextToRedo(useUndo.getState())).toBe(made);
      await useUndo.getState().redo();
      await useUndo.getState().undo();
      await useUndo.getState().undo();
      expect(log).toEqual(["undo later", "redo later", "undo later", "redo later", "undo later"]);
      await settled(editor, words.own);
      expect(fillStepIn(MEETING, editor)).toBe("undone");
    },
  );

  // protects=the same for a fill handed to the tab: its editor reaches it on Notes only, never on the Transcript view or My notes (#3099); fails_when=the app's Undo takes the handed-over fill back while its text is hidden; no_claim=the line, which the smoke spec shows.
  test("the tab's editor reaches the handed-over fill on Notes only", async () => {
    const before = await filledInTab();
    before.close();

    view("tab-1", "transcript");
    const after = await openInTab("tab-1");
    await settled(after.editor, filledText);
    passedOver();
    view("tab-1", "mine");
    passedOver();
    await useUndo.getState().undo();
    expect(bridge.undoFills).toEqual([]);

    view("tab-1", "notes");
    reached();
    await useUndo.getState().undo();
    expect(bridge.undoFills).toEqual([MEETING]);
  });

  // protects=⌘Z in the note on My notes leaves the fill in place and says to undo it from Notes, whether the editor holds the fill or its tab was handed it; back on Notes the fill's Undo is reached again (#138, #3099); fails_when=⌘Z on My notes takes the fill back unseen, or says nothing; no_claim=the line's words, which the smoke spec reads.
  test.each(["held by the editor", "handed to the tab"] as const)(
    "⌘Z in My notes leaves the fill %s, and says to undo it from Notes",
    async (how) => {
      let editor: Editor;
      if (how === "held by the editor") {
        ownLine(words);
        editor = (await mountEditor(true, "tab-1")).editor;
        setFill("filling");
        fillFromCore(words);
        await settled(editor, filledText);
      } else {
        const before = await filledInTab();
        before.close();
        editor = (await mountEditor(true, "tab-1")).editor;
        await settled(editor, filledText);
      }

      view("tab-1", "mine");
      showMyNotes(editor, true);
      expect(editor.commands.undo()).toBe(true);
      expect(bridge.told).toEqual(["fillUndo"]);
      await settled(editor, filledText);
      expect(bridge.undoFills).toEqual([]);

      view("tab-1", "notes");
      showMyNotes(editor, false);
      reached();
      await useUndo.getState().undo();
      if (how === "held by the editor") await settled(editor, words.own);
      else expect(bridge.undoFills).toEqual([MEETING]);
    },
  );
});
