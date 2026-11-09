/**
 * The editor's own copy and paste in a test: a page for it to make its HTML in, a Note's editor
 * bound to a Yjs document as the app's is, what copying a Block puts on the clipboard, and a
 * paste of it that runs through ProseMirror's paste handler and the extensions' hooks.
 */
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { onTestFinished } from "vitest";
import type * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

function domDocument() {
  const page = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(page, "styleSheets", { value: [] });
  Object.defineProperty(page, "implementation", { value: { createHTMLDocument: domDocument } });
  return page;
}

/** Gives the test file a page, as the browser gives the app's. */
export function installDom(): void {
  const dom = domDocument();
  Object.assign(globalThis, {
    window: dom.defaultView,
    document: dom,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
  });
}

/** A Note's editor on this Yjs document, as the app's is: what it holds shows, what is done in it is written. */
export function noteEditor(doc: Y.Doc): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  onTestFinished(() => editor.destroy());
  return editor;
}

/** What copying the Block at `pos` puts on the clipboard, through the editor's own copy. */
export function copiedHtml(editor: Editor, pos: number): string {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) throw new Error("Nothing to copy.");
  return editor.view.serializeForClipboard(editor.state.doc.slice(pos, pos + node.nodeSize)).dom
    .innerHTML;
}

/** Pastes clipboard HTML where the caret is, as the browser's paste event reaches the editor. */
export function pasteHtml(editor: Editor, html: string): void {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/html" ? html : "") },
  });
  editor.view.dispatchEvent(event);
}
