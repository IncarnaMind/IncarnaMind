import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { DOMParser } from "linkedom";
import { afterEach, expect, test } from "vitest";
import { PageCaret } from "../../src/renderer/src/editor/pageCaret";
import { editorExtensions } from "../helpers/editor";

/*
 * A key pressed at once after a click into selected words (#3414): Chrome sends the key before
 * it tells the editor where the click left the caret, so the editor reads the page's caret first.
 */

function domDocument() {
  const page = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(page, "styleSheets", { value: [] });
  Object.defineProperty(page, "implementation", { value: { createHTMLDocument: domDocument } });
  return page;
}
const page = domDocument();
Object.assign(globalThis, {
  window: page.defaultView,
  document: page,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
});

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

const LINE = "The island routes sail every hour from the outer harbour pier.";

/** A Note of one line, its match selected as find leaves it, and the page showing a caret at `at`. */
function clickedInto(at: number | null) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...editorExtensions(), PageCaret],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: LINE }] }],
    },
  });
  editors.push(editor);
  const from = 1 + LINE.indexOf("outer");
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + 18)),
  );
  const text = editor.view.dom.querySelector("p")?.firstChild ?? null;
  Object.defineProperty(editor.view, "hasFocus", { value: () => true });
  Object.defineProperty(editor.view.dom.ownerDocument, "getSelection", {
    configurable: true,
    // The page's selection as the click left it; drawing the editor's onto it changes nothing.
    value: () => ({
      get isCollapsed() {
        return at !== null;
      },
      focusNode: text,
      get focusOffset() {
        return at ?? 0;
      },
      anchorNode: text,
      modify(_alter: string, direction: string) {
        at = direction === "left" ? 0 : LINE.length;
      },
      rangeCount: 0,
      collapse() {},
      extend() {},
      addRange() {},
      removeAllRanges() {},
      setBaseAndExtent() {},
    }),
  });
  return editor;
}

function press(editor: Editor, key: string, shiftKey = false): void {
  const event = {
    key,
    keyCode: 0,
    shiftKey,
    altKey: false,
    ctrlKey: false,
    metaKey: key === "k",
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;
  editor.state.plugins.some(
    (plugin) => plugin.props.handleKeyDown?.call(plugin, editor.view, event) === true,
  );
}

test("a key right after a click into selected words acts at the caret the click left", () => {
  const caret = LINE.indexOf("harbour");
  const editor = clickedInto(caret);
  press(editor, "k");
  expect(editor.state.selection.empty).toBe(true);
  expect(editor.state.selection.from).toBe(1 + caret);
});

test("words the page shows selected stay selected", () => {
  const editor = clickedInto(null);
  const before = editor.state.selection;
  press(editor, "k");
  expect(editor.state.selection.eq(before)).toBe(true);
});

test("after Select All collapses at the end, the next key uses the page's caret", () => {
  const editor = clickedInto(LINE.length);
  editor.commands.selectAll();
  press(editor, "k");
  expect(editor.state.selection.empty).toBe(true);
  expect(editor.state.selection.from).toBe(1 + LINE.length);
});

test("Enter after a native move to the end keeps the paragraph above the new line", () => {
  const editor = clickedInto(LINE.length);
  editor.commands.setTextSelection(1);
  press(editor, "Enter");
  expect(editor.state.doc.children.map((block) => block.textContent)).toEqual([LINE, ""]);
});

test.each([
  ["ArrowLeft", 1, ["", LINE]],
  ["ArrowRight", LINE.length + 1, [LINE, ""]],
] as const)(
  "after Select All, %s commits the browser’s caret before Enter",
  (key, at, paragraphs) => {
    const editor = clickedInto(null);
    editor.commands.selectAll();
    press(editor, key);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(at);
    press(editor, "Enter");
    expect(editor.state.doc.children.map((node) => node.textContent)).toEqual(paragraphs);
  },
);

test("Shift and an arrow leave extending the selection to the browser", () => {
  const editor = clickedInto(null);
  editor.commands.selectAll();
  const before = editor.state.selection;
  press(editor, "ArrowRight", true);
  expect(editor.state.selection.eq(before)).toBe(true);
});
