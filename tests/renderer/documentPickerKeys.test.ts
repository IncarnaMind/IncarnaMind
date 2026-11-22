import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, onTestFinished, test, vi } from "vitest";
import { listenForDocumentPickerKeys } from "../../src/renderer/src/editor/documentPicker";
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
