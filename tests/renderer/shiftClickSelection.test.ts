import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CITATION_NODE } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { notifyShiftPressTaken, onShiftPressTaken } from "../../src/renderer/src/editor/peek";
import {
  clearTakenMarkerPress,
  extendSelectionTo,
  hasSelectionToExtend,
  hasTakenMarkerPress,
  syncSelectionFromDOM,
} from "../../src/renderer/src/editor/shiftClickSelection";

const schema = getSchema(noteExtensions());

const doc = schema.nodeFromJSON({
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [
        { type: "text", text: "3.1 倍 " },
        {
          type: CITATION_NODE,
          attrs: { documentId: "d1", documentName: "Results", check: "found" },
        },
        { type: "text", text: "，而贷款协议规定。" },
      ],
    },
    { type: "paragraph", attrs: { id: "p2" } },
  ],
});

interface FakeSelection {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
  isCollapsed: boolean;
}

function makeView(
  initialSelection: { anchor: number; head: number },
  domSelection: FakeSelection | null,
  options: { focused?: boolean; coordsPos?: { pos: number; inside: number } } = {},
) {
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, initialSelection.anchor, initialSelection.head),
  });
  const textNode = {} as Node;
  const dispatched: Array<{ anchor: number; head: number }> = [];
  let focused = options.focused ?? true;
  const selection = domSelection
    ? { ...domSelection, anchorNode: textNode, focusNode: textNode }
    : null;
  const dom = {
    contains: (node: Node | null) => node === textNode,
    ownerDocument: {
      getSelection: () => selection,
    },
  };
  const view = {
    isDestroyed: false,
    composing: false,
    dom,
    get state() {
      return state;
    },
    hasFocus: () => focused,
    focus: () => {
      focused = true;
    },
    posAtDOM: (_node: Node, offset: number) => offset,
    posAtCoords: () => options.coordsPos ?? null,
    dispatch: (tr: Transaction) => {
      state = state.apply(tr);
      dispatched.push({ anchor: state.selection.anchor, head: state.selection.head });
    },
  } as unknown as EditorView;
  return { view, dispatched };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shiftClickSelection (#3697)", () => {
  test("syncSelectionFromDOM copies a double-click range before selectionchange arrives", () => {
    // Editor state still sits at the empty trailing paragraph; the page holds the double-clicked word.
    const trailing = doc.content.size - 1;
    const { view, dispatched } = makeView(
      { anchor: trailing, head: trailing },
      { anchorNode: null, anchorOffset: 5, focusNode: null, focusOffset: 6, isCollapsed: false },
    );

    expect(syncSelectionFromDOM(view)).toBe(true);
    expect(dispatched).toEqual([{ anchor: 5, head: 6 }]);
    expect(view.state.selection.from).toBe(5);
    expect(view.state.selection.to).toBe(6);
  });

  test("extendSelectionTo forces a selection change when stale editor state already equals the target", () => {
    vi.stubGlobal("Element", class {});
    // Citation is at pos 7 (size 1, ends at 8). Prior selection was [5, 8], then a quick double-click
    // narrowed the DOM selection to [5, 6] before selectionchange reached ProseMirror.
    const { view, dispatched } = makeView(
      { anchor: 5, head: 8 },
      { anchorNode: null, anchorOffset: 5, focusNode: null, focusOffset: 6, isCollapsed: false },
      { coordsPos: { pos: 8, inside: -1 } },
    );
    let prevented = false;
    const event = {
      defaultPrevented: false,
      button: 0,
      shiftKey: true,
      clientX: 100,
      clientY: 20,
      target: null,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as MouseEvent;

    expect(extendSelectionTo(view, event)).toBe(true);
    expect(prevented).toBe(true);
    // Syncs [5, 6] first so the [5, 8] dispatch differs from prev.selection and runs selectionToDOM.
    expect(dispatched).toEqual([
      { anchor: 5, head: 6 },
      { anchor: 5, head: 8 },
    ]);
  });

  test("hasSelectionToExtend follows the page's selection before ProseMirror catches up", () => {
    const trailing = doc.content.size - 1;
    const withRange = makeView(
      { anchor: trailing, head: trailing },
      { anchorNode: null, anchorOffset: 5, focusNode: null, focusOffset: 6, isCollapsed: false },
    );
    expect(hasSelectionToExtend(withRange.view)).toBe(true);

    const withCaret = makeView(
      { anchor: 5, head: 8 },
      { anchorNode: null, anchorOffset: 5, focusNode: null, focusOffset: 5, isCollapsed: true },
    );
    expect(hasSelectionToExtend(withCaret.view)).toBe(false);
  });

  test("notifyShiftPressTaken invokes listeners synchronously and clearTakenMarkerPress resets view state", () => {
    const marker = new EventTarget();
    let notified = 0;
    const stop = onShiftPressTaken(marker, () => {
      notified++;
    });
    notifyShiftPressTaken(marker);
    expect(notified).toBe(1);
    stop();
    notifyShiftPressTaken(marker);
    expect(notified).toBe(1);

    const { view } = makeView({ anchor: 5, head: 6 }, null);
    expect(hasTakenMarkerPress(view)).toBe(false);
    clearTakenMarkerPress(view);
    expect(hasTakenMarkerPress(view)).toBe(false);
  });
});
