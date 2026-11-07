import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { type EditCause, type MeetingFill, MIND_CONTENT_FIELD } from "../../src/core/api";
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
  /** The window's Meetings, as the core last sent them: only the fill matters here. */
  setMeetings: (_meetings: { id: string; fill: MeetingFill | null }[]): void => undefined,
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
    meetings: [] as { id: string; fill: MeetingFill | null }[],
    problems: {},
    followFillUndo: async (meetingId: string, undone: boolean) => {
      bridge.follows.push([meetingId, undone]);
    },
  }));
  bridge.setMeetings = (meetings) => useMeetings.setState({ meetings });
  return { useMeetings };
});

const { openMindCopy, flushMindUpdates } = await import("../../src/renderer/src/mindCopies");
const { takeFillInEditor } = await import("../../src/renderer/src/editor/meetingFillUndo");
const { fillStepIn, undoFillInEditor } = await import("../../src/renderer/src/meetingFillSteps");
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
  bridge.setMeetings([{ id: MEETING, fill: null }]);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  bridge.listeners.clear();
  vi.unstubAllGlobals();
});

function setFill(state: MeetingFill["state"]): void {
  bridge.setMeetings([
    { id: MEETING, fill: { state, mode: "sections", local: false, problem: null } },
  ]);
}

function element(name: string, children: (Y.XmlElement | Y.XmlText)[], id?: string) {
  const node = new Y.XmlElement(name);
  if (id) node.setAttribute("id", id);
  node.insert(0, children);
  return node;
}

/** The core writes the fill: a heading and a bullet after the User's line, one edit with its cause. */
function fillFromCore(words: (typeof WORDS)[keyof typeof WORDS]): void {
  let update: Uint8Array | null = null;
  const take = (each: Uint8Array) => {
    update = each;
  };
  server.on("update", take);
  server.transact(() => {
    server
      .getXmlFragment(MIND_CONTENT_FIELD)
      .push([
        element("heading", [new Y.XmlText(words.heading)], "fill-heading"),
        element(
          "bulletList",
          [element("listItem", [element("paragraph", [new Y.XmlText(words.bullet)])])],
          "fill-list",
        ),
      ]);
  });
  server.off("update", take);
  if (!update) throw new Error("The fill changed nothing.");
  fill.send(MIND, update, meetingFillCause(MEETING));
  setFill("filled");
}

/** A copy of the Note, open in an editor that takes the fill as its own step. */
async function openEditor(): Promise<Editor> {
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
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  cleanups.push(() => editor.destroy());
  cleanups.push(takeFillInEditor(editor, MEETING));
  return editor;
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

  // protects=after ⌘Z and Try again, ⇧⌘Z can't bring the first fill back while the new one is written, so the Note never gets both; a fill the core takes back from elsewhere is let go too (#2527); fails_when=⇧⌘Z puts the old fill back during "filling", or a copy keeps offering Undo of a fill the core took back; no_claim=the core's own fill.
  test("a fill the core moves on from, filling anew or taken back elsewhere, leaves the copy's history", async () => {
    ownLine(words);
    const editor = await openEditor();
    setFill("filling");
    fillFromCore(words);
    await settled(editor, filledText);

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
});
