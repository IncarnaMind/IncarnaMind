import { readFileSync } from "node:fs";
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment, yUndoPluginKey } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { type Meeting, type MeetingFill, MIND_CONTENT_FIELD } from "../../src/core/api";
import {
  MeetingFillPlace,
  setMeetingFillPlace,
} from "../../src/renderer/src/editor/meetingFillPlace";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { useUndo } from "../../src/renderer/src/undo";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const actions = vi.hoisted(() => ({ fillNotes: vi.fn(), undoFill: vi.fn() }));
vi.mock("../../src/renderer/src/i18n", () => ({
  useT: () => (key: MessageKey, params?: MessageParams) => translate("en", key, params),
}));
vi.mock("../../src/renderer/src/meetings", () => ({
  useMeetings: { getState: () => actions },
}));
vi.mock("../../src/renderer/src/meetingViews", () => ({ showMeetingNoteView: vi.fn() }));
vi.mock("../../src/renderer/src/components/tabs/tabItems", () => ({
  useTabPlace: () => ({ tabId: "meeting-tab", groupId: "meeting-group" }),
}));

let editor: Editor | null = null;
let root: Root | null = null;
let doc: Y.Doc | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  const document = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  // Linkedom reports subtree childList targets as the root; these tests drive document transactions.
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
    IS_REACT_ACT_ENVIRONMENT: true,
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
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  editor?.destroy();
  editor = null;
  doc?.destroy();
  doc = null;
  vi.unstubAllGlobals();
});

const paragraph = (id: string, text: string): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: text ? [{ type: "text", text }] : [],
});

function editorWith(content: JSONContent[]): Editor {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [...noteExtensions(), MeetingFillPlace],
    content: { type: "doc", content },
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return editor;
}

function collaborativeEditorWith(content: JSONContent[]): { editor: Editor; doc: Y.Doc } {
  const source = editorWith(content);
  doc = new Y.Doc();
  prosemirrorToYXmlFragment(source.state.doc, doc.getXmlFragment(MIND_CONTENT_FIELD));
  source.destroy();
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
      MeetingFillPlace,
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return { editor, doc };
}

function slotOf(editor: Editor): HTMLElement {
  const slots = editor.view.dom.querySelectorAll<HTMLElement>('[data-testid="meeting-fill-place"]');
  expect(slots).toHaveLength(1);
  const slot = slots[0];
  if (!slot) throw new Error("No meeting fill slot");
  return slot;
}

test("places one status before the first surviving added Block in document order", () => {
  const editor = editorWith([
    paragraph("own", "My notes"),
    paragraph("earlier", "较早的补充"),
    paragraph("later", "Later addition"),
  ]);

  setMeetingFillPlace(editor, ["missing", "later", "earlier", "earlier"]);

  const slot = slotOf(editor);
  expect(slot.previousElementSibling?.textContent).toBe("My notes");
  expect(slot.nextElementSibling?.textContent).toBe("较早的补充");
  expect(slot.getAttribute("contenteditable")).toBe("false");
});

test("deleting the first anchor moves the status to the next survivor, then to the end", () => {
  const editor = editorWith([
    paragraph("own", "My notes"),
    paragraph("first", "First addition"),
    paragraph("second", "Second addition"),
    paragraph("tail", "My later notes"),
  ]);
  setMeetingFillPlace(editor, ["second", "first"]);
  expect(slotOf(editor).nextElementSibling?.textContent).toBe("First addition");

  const firstAt = editor.state.doc.child(0).nodeSize;
  editor.view.dispatch(
    editor.state.tr.delete(firstAt, firstAt + editor.state.doc.child(1).nodeSize),
  );
  expect(slotOf(editor).nextElementSibling?.textContent).toBe("Second addition");

  editor.view.dispatch(
    editor.state.tr.delete(firstAt, firstAt + editor.state.doc.child(1).nodeSize),
  );
  expect(slotOf(editor).previousElementSibling?.textContent).toBe("My later notes");
  expect(slotOf(editor).nextElementSibling).toBeNull();
});

test("reordering surviving Blocks recomputes document order instead of mapping the old anchor", () => {
  const editor = editorWith([
    paragraph("own", "My notes"),
    paragraph("first", "First addition"),
    paragraph("second", "Second addition"),
  ]);
  setMeetingFillPlace(editor, ["first", "second"]);
  const firstAt = editor.state.doc.child(0).nodeSize;
  const first = editor.state.doc.child(1);
  const moved = editor.state.tr.delete(firstAt, firstAt + first.nodeSize);
  editor.view.dispatch(moved.insert(moved.doc.content.size, first));
  expect(slotOf(editor).nextElementSibling?.textContent).toBe("Second addition");
});

test("an earlier added Block arriving after the meeting event replaces the fallback anchor", () => {
  const editor = editorWith([paragraph("own", "My notes")]);
  setMeetingFillPlace(editor, ["late", "early"]);
  expect(slotOf(editor).nextElementSibling).toBeNull();

  editor.commands.insertContentAt(
    editor.state.doc.content.size,
    paragraph("late", "Late addition"),
  );
  expect(slotOf(editor).nextElementSibling?.textContent).toBe("Late addition");

  editor.commands.insertContentAt(
    editor.state.doc.child(0).nodeSize,
    paragraph("early", "Earlier addition"),
  );
  expect(slotOf(editor).nextElementSibling?.textContent).toBe("Earlier addition");
});

test.each([{ ids: [] }, { ids: ["deleted"] }])(
  "an empty Note has one valid document-end slot for $ids",
  ({ ids }) => {
    const editor = editorWith([paragraph("empty", "")]);
    const before = editor.getJSON();
    setMeetingFillPlace(editor, ids);
    expect(slotOf(editor).previousElementSibling?.tagName).toBe("P");
    expect(slotOf(editor).nextElementSibling).toBeNull();
    expect(editor.getJSON()).toEqual(before);
  },
);

test("unreported AI writing is never used as an inferred anchor", () => {
  const generated = paragraph("unrelated", "Other AI writing");
  generated.content = [{ type: "text", text: "Other AI writing", marks: [{ type: "generated" }] }];
  const editor = editorWith([generated, paragraph("own", "My final line")]);
  setMeetingFillPlace(editor, []);
  expect(slotOf(editor).previousElementSibling?.textContent).toBe("My final line");
  expect(slotOf(editor).nextElementSibling).toBeNull();
});

test("a reported Block inside a quote keeps its slot at that Block", () => {
  const editor = editorWith([
    { type: "blockquote", content: [paragraph("added", "Nested addition")] },
    paragraph("own", "My final line"),
  ]);
  setMeetingFillPlace(editor, ["added"]);
  expect(slotOf(editor).parentElement?.tagName).toBe("BLOCKQUOTE");
  expect(slotOf(editor).nextElementSibling?.textContent).toBe("Nested addition");
});

test("slot updates leave document JSON, Yjs bytes, clipboard, selection and both Undo stacks intact", () => {
  const { editor, doc } = collaborativeEditorWith([
    paragraph("own", "My notes"),
    paragraph("added", "Added writing"),
  ]);
  const before = editor.getJSON();
  const bytes = Y.encodeStateAsUpdate(doc);
  const selection = editor.state.selection;
  const globalUndo = useUndo.getState();
  const localUndo = yUndoPluginKey.getState(editor.state)?.undoManager;
  expect(localUndo).toBeDefined();
  const clipboardBefore = editor.view.serializeForClipboard(editor.state.doc.slice(0));

  setMeetingFillPlace(editor, ["added"]);
  const slot = slotOf(editor);
  slot.textContent = "Status controls that must not be copied";
  setMeetingFillPlace(editor, ["added"]);
  expect(slotOf(editor)).toBe(slot);
  const clipboardAfter = editor.view.serializeForClipboard(editor.state.doc.slice(0));
  expect(clipboardAfter.dom.innerHTML).toBe(clipboardBefore.dom.innerHTML);
  expect(clipboardAfter.text).toBe(clipboardBefore.text);
  setMeetingFillPlace(editor, []);
  setMeetingFillPlace(editor, null);

  expect(editor.view.dom.querySelector('[data-testid="meeting-fill-place"]')).toBeNull();
  expect(editor.getJSON()).toEqual(before);
  expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
  expect(editor.state.selection).toBe(selection);
  expect(localUndo?.undoStack).toEqual([]);
  expect(localUndo?.redoStack).toEqual([]);
  expect(useUndo.getState().done).toBe(globalUndo.done);
  expect(useUndo.getState().undone).toBe(globalUndo.undone);
});

test("Yjs content arriving after the fill event moves the slot to its reported Block", () => {
  const { editor, doc } = collaborativeEditorWith([paragraph("own", "My notes")]);
  setMeetingFillPlace(editor, ["arriving"]);
  expect(slotOf(editor).nextElementSibling).toBeNull();

  const added = new Y.XmlElement("paragraph");
  added.setAttribute("id", "arriving");
  const text = new Y.XmlText();
  text.insert(0, "Arrived from the core");
  added.insert(0, [text]);
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([added]);

  expect(slotOf(editor).previousElementSibling?.textContent).toBe("My notes");
  expect(slotOf(editor).nextElementSibling?.textContent).toBe("Arrived from the core");
});

const fillOf = (fill: Partial<MeetingFill> = {}): MeetingFill => ({
  state: "filled",
  mode: "sections",
  local: false,
  problem: null,
  ...fill,
});

const meetingOf = (fill: MeetingFill | null): Meeting => ({
  id: "meeting",
  mindId: "note",
  kind: "meeting",
  status: "stopped",
  pausedBy: null,
  systemAudio: true,
  sources: { microphone: "off", system: "off" },
  recordedMs: 60_000,
  recordingSince: null,
  gaps: [],
  startedAt: "2026-11-04T10:00:00.000Z",
  stoppedAt: "2026-11-04T10:01:00.000Z",
  audio: { kept: false, expiresAt: null, deletedAt: null },
  saveError: null,
  transcript: null,
  health: { realTimeFactor: null, measuredMs: 0, keepsUp: null, events: [] },
  microphonePausedAtMs: null,
  help: null,
  helpTemplate: null,
  fill,
  createdAt: "2026-11-04T10:00:00.000Z",
  updatedAt: "2026-11-04T10:01:00.000Z",
});

async function showAt(editor: Editor, meeting: Meeting): Promise<HTMLElement> {
  const componentPath = "../../src/renderer/src/components/MeetingFillAt.tsx";
  const { MeetingFillAt }: { MeetingFillAt: ComponentType<{ editor: Editor; meeting: Meeting }> } =
    await import(componentPath);
  if (!container) {
    container = document.createElement("div");
    document.body.append(container, editor.view.dom);
    root = createRoot(container);
  }
  await act(() => root?.render(createElement(MeetingFillAt, { editor, meeting })));
  return container;
}

/** The fill as the editor holds it on its own Undo (editor/meetingFillUndo): on top. */
async function heldOnTop(meetingId: string): Promise<() => void> {
  const { holdFillSteps } = await import("../../src/renderer/src/meetingFillSteps");
  return holdFillSteps(meetingId, {
    state: () => "done",
    onTop: () => true,
    add: () => undefined,
    undo: () => undefined,
    observe: () => () => undefined,
  });
}

test("portals the actual fill line into the writing with its native Undo action", async () => {
  const editor = editorWith([paragraph("own", "My notes"), paragraph("added", "Added writing")]);
  const meeting = meetingOf({ ...fillOf(), addedBlockIds: ["added"] });
  const release = await heldOnTop(meeting.id);
  const container = await showAt(editor, meeting);

  const slot = slotOf(editor);
  expect(slot.nextElementSibling?.textContent).toBe("Added writing");
  expect(slot.textContent).toBe("Note filled in from the call · Undo");
  expect(editor.view.dom.querySelectorAll('[data-testid="meeting-fill-line"]')).toHaveLength(1);
  expect(container.textContent).toBe("");
  const undo = slot.querySelector<HTMLButtonElement>('[data-testid="meeting-fill-undo"]');
  expect(undo?.tagName).toBe("BUTTON");
  expect(undo?.hasAttribute("disabled")).toBe(false);
  expect(undo?.getAttribute("tabindex")).not.toBe("-1");
  await act(() => undo?.click());
  expect(actions.undoFill.mock.calls).toEqual([[meeting.id]]);
  release();
});

test.each(["waiting", "filling", "failed", "undone", "filled", "off"] as const)(
  "%s without reported additions stays at the writing's end",
  async (state) => {
    const editor = editorWith([paragraph("own", "My notes"), paragraph("last", "My final line")]);
    const meeting = meetingOf(fillOf({ state }));
    const release = state === "filled" ? await heldOnTop(meeting.id) : () => undefined;
    await showAt(editor, meeting);
    const slot = slotOf(editor);
    expect(slot.previousElementSibling?.textContent).toBe("My final line");
    expect(slot.nextElementSibling).toBeNull();
    expect(slot.querySelectorAll('[data-testid="meeting-fill-line"]')).toHaveLength(1);
    release();
  },
);

test.each(["filled", "failed"] as const)(
  "a %s partial/problem line survives typing and follows its next surviving addition",
  async (state) => {
    const editor = editorWith([
      paragraph("own", "My notes"),
      paragraph("first", "First addition"),
      paragraph("next", "Next addition"),
    ]);
    await showAt(
      editor,
      meetingOf({ ...fillOf({ state, omitted: 1 }), addedBlockIds: ["first", "next"] }),
    );
    const text = slotOf(editor).textContent;

    await act(() => editor.view.dispatch(editor.state.tr.insertText("Still writing ", 1)));
    expect(slotOf(editor).textContent).toBe(text);

    const at = editor.state.doc.child(0).nodeSize;
    await act(() =>
      editor.view.dispatch(editor.state.tr.delete(at, at + editor.state.doc.child(1).nodeSize)),
    );
    expect(slotOf(editor).nextElementSibling?.textContent).toBe("Next addition");
    expect(slotOf(editor).textContent).toBe(text);
    expect(editor.view.dom.querySelectorAll('[data-testid="meeting-fill-line"]')).toHaveLength(1);
  },
);

test("a cleared fill, Memo and unmounted component leave no inline status behind", async () => {
  const editor = editorWith([paragraph("own", "My notes")]);
  await showAt(editor, meetingOf(fillOf()));
  slotOf(editor);
  await showAt(editor, meetingOf(null));
  expect(editor.view.dom.querySelector('[data-testid="meeting-fill-place"]')).toBeNull();
  await showAt(editor, { ...meetingOf(fillOf()), kind: "memo" });
  expect(editor.view.dom.querySelector('[data-testid="meeting-fill-place"]')).toBeNull();
  await showAt(editor, meetingOf(fillOf()));
  slotOf(editor);
  await act(() => root?.unmount());
  root = null;
  expect(editor.view.dom.querySelector('[data-testid="meeting-fill-place"]')).toBeNull();
});

test("the legacy Meeting header fill line is kept only for a Memo", () => {
  const source = readFileSync(
    new URL("../../src/renderer/src/components/MeetingInMind.tsx", import.meta.url),
    "utf8",
  );
  const callPage = source.indexOf('if (meeting.kind === "meeting") {');
  expect(callPage).toBeGreaterThan(0);
  expect(source.indexOf("<MeetingFillLine meeting={meeting} />")).toBeGreaterThan(callPage);
  expect(source.slice(callPage, source.indexOf("<MeetingFillLine"))).toContain("return (");
});
