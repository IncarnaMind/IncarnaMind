import { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { DOMParser } from "linkedom";
import { afterEach, expect, test, vi } from "vitest";
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
  vi.unstubAllGlobals();
});

const LINE = "The island routes sail every hour from the outer harbour pier.";

/** A Note of one line, its match selected as find leaves it, and the page showing a caret at `at`. */
function clickedInto(at: number | null, lines = [LINE]) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...editorExtensions(), PageCaret],
    content: {
      type: "doc",
      content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
    },
  });
  editors.push(editor);
  const from = 1 + LINE.indexOf("outer");
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + 18)),
  );
  let text = editor.view.dom.querySelector("p")?.firstChild ?? null;
  Object.defineProperty(editor.view, "hasFocus", { value: () => true });
  Object.defineProperty(editor.view.dom.ownerDocument, "getSelection", {
    configurable: true,
    // The page's selection as the click left it; drawing the editor's onto it changes nothing.
    value: () => ({
      get isCollapsed() {
        return at !== null;
      },
      get focusNode() {
        return text;
      },
      get focusOffset() {
        return at ?? 0;
      },
      get anchorNode() {
        return text;
      },
      modify(_alter: string, direction: string, granularity: string) {
        const first = direction === "left" || direction === "backward";
        if (granularity === "documentboundary") {
          const block = first
            ? editor.view.dom.firstElementChild
            : editor.view.dom.lastElementChild;
          text = block?.firstChild ?? null;
        }
        at = first ? 0 : (text?.textContent?.length ?? 0);
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

type Modifiers = Partial<
  Pick<KeyboardEvent, "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "isComposing">
>;
function press(editor: Editor, key: string, modifiers: Modifiers = {}): void {
  const event = {
    key,
    keyCode: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: key === "k",
    ...modifiers,
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
  press(editor, "ArrowRight", { shiftKey: true });
  expect(editor.state.selection.eq(before)).toBe(true);
});

test.each([
  ["MacIntel", "ArrowDown", "ArrowUp", { metaKey: true }],
  ["Linux x86_64", "End", "Home", { ctrlKey: true }],
  ["Win32", "End", "Home", { ctrlKey: true }],
] as const)(
  "a newly focused %s editor keeps the document-edge move before Enter",
  (platform, end, home, modifiers) => {
    const last = "第二段。";
    const editor = clickedInto(0, [LINE, last]);
    vi.stubGlobal("navigator", { platform });
    editor.commands.setTextSelection(1);
    press(editor, end, modifiers);
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
    press(editor, "Enter");
    expect(editor.state.doc.children.map((node) => node.textContent)).toEqual([LINE, last, ""]);
    press(editor, home, modifiers);
    expect(editor.state.selection.from).toBe(1);
  },
);

test("only a handled move to a different document edge requests scrolling", () => {
  const editor = clickedInto(LINE.indexOf("outer"));
  vi.stubGlobal("navigator", { platform: "Linux x86_64" });
  const scrolls = vi.fn();
  editor.on("transaction", ({ transaction }) => {
    if (transaction.scrolledIntoView) scrolls();
  });
  press(editor, "k");
  expect(scrolls).not.toHaveBeenCalled();
  press(editor, "End", { ctrlKey: true });
  expect(scrolls).toHaveBeenCalledTimes(1);
  press(editor, "End", { ctrlKey: true });
  expect(scrolls).toHaveBeenCalledTimes(1);
});

test.each([
  ["MacIntel", "End", { ctrlKey: true }],
  ["Linux x86_64", "ArrowDown", { metaKey: true }],
  ["Win32", "End", { ctrlKey: true, shiftKey: true }],
  ["MacIntel", "ArrowDown", { metaKey: true, altKey: true }],
  ["MacIntel", "ArrowDown", { metaKey: true, ctrlKey: true }],
  ["Linux x86_64", "End", { ctrlKey: true, isComposing: true }],
] as const)(
  "%s leaves %s with unmatched modifiers or composition to the host",
  (platform, key, modifiers) => {
    const editor = clickedInto(0);
    vi.stubGlobal("navigator", { platform });
    editor.commands.setTextSelection(1);
    press(editor, key, modifiers);
    expect(editor.state.selection.from).toBe(1);
  },
);

test("a document-edge shortcut preserves a selected node and leaves selected text to the browser", () => {
  const editor = clickedInto(null);
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  const selections = [editor.state.selection, new NodeSelection(editor.state.doc.resolve(0))];
  for (const selection of selections) {
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    press(editor, "ArrowDown", { metaKey: true });
    expect(editor.state.selection.eq(selection)).toBe(true);
  }
});
