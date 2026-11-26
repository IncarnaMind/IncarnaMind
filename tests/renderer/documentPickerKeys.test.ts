import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  listenForDocumentPickerKeys,
  openDocumentPicker,
  takeTypedTrigger,
} from "../../src/renderer/src/editor/documentPicker";
import { dialogOrMenuOpen } from "../../src/renderer/src/escapeDismiss";
import { stubEditorDom } from "../helpers/editorDom";

vi.mock("../../src/renderer/src/escapeDismiss", () => ({ dialogOrMenuOpen: vi.fn() }));

// protects=the Document picker receives keyboard input still on the page after the palette closes (#2586); fails_when=it drops that input or takes it from an active control or IME.
test("the Document picker handles a page key only while it owns the keyboard", () => {
  stubEditorDom();
  const editor = new Editor({ element: document.createElement("div"), extensions: [StarterKit] });
  const field = document.createElement("input");
  document.body.append(editor.view.dom, field);
  onTestFinished(() => {
    editor.destroy();
    vi.unstubAllGlobals();
  });
  const take = vi.fn(() => true);
  const stop = listenForDocumentPickerKeys(editor, take);
  const key = (target: HTMLElement, value: string, composing = false) => {
    Object.defineProperty(document, "activeElement", { configurable: true, value: target });
    const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), {
      key: value,
      isComposing: composing,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(key(field, "Enter")).toBe(false);
  expect(key(document.body, "Escape", true)).toBe(false);
  vi.mocked(dialogOrMenuOpen).mockReturnValue(true);
  expect(key(document.body, "Escape")).toBe(false);
  expect(take).not.toHaveBeenCalled();

  vi.mocked(dialogOrMenuOpen).mockReturnValue(false);
  expect(key(document.body, "t")).toBe(true);
  expect(editor.getText()).toBe("t");
  expect(key(document.body, "Enter")).toBe(true);
  expect(take).toHaveBeenCalledOnce();
  stop();
  expect(key(document.body, "Escape")).toBe(false);
  expect(take).toHaveBeenCalledOnce();
});

// protects=cancelling a command-opened Document picker refocuses the editor before restoring the saved selection (#1741); fails_when=dispatch runs while unfocused so ProseMirror skips selectionToDOM.
test("cancelling a command-typed trigger focuses the editor before dispatching selection restoration", () => {
  stubEditorDom();
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Revenue grew last year." }] },
      ],
    },
  });
  document.body.append(editor.view.dom);
  onTestFinished(() => {
    editor.destroy();
    vi.unstubAllGlobals();
  });

  editor.commands.setTextSelection({ from: 1, to: 8 });
  openDocumentPicker(editor, 8, { forCommand: true });
  expect(editor.getText()).toBe("Revenue @ grew last year.");

  let focusedBeforeDispatch = false;
  let sawDispatch = false;
  const origFocus = editor.view.focus.bind(editor.view);
  const origDispatch = editor.view.dispatch.bind(editor.view);
  vi.spyOn(editor.view, "focus").mockImplementation(() => {
    if (!sawDispatch) focusedBeforeDispatch = true;
    origFocus();
  });
  vi.spyOn(editor.view, "dispatch").mockImplementation((tr) => {
    sawDispatch = true;
    origDispatch(tr);
  });

  takeTypedTrigger(editor, 10, true);
  expect(focusedBeforeDispatch).toBe(true);
  expect(sawDispatch).toBe(true);
  expect(editor.getText()).toBe("Revenue grew last year.");
  expect(editor.state.selection.anchor).toBe(1);
  expect(editor.state.selection.head).toBe(8);
});
