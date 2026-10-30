/**
 * A copy of a Word file's note is a footnote of the User's own (#746): in the
 * editor of a Note bound to its Yjs document, as the app's is, a copy pasted
 * while the note is there, or into a Note not imported from Word, is
 * numbered with the footnotes, and a note moved stays the file's endnote.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { FOOTNOTE_NODE, MIND_CONTENT_FIELD, MIND_WORD_FIELD } from "../../src/core/api";
import { numberFootnotes } from "../../src/renderer/src/editor/citationNumbers";
import { findFootnote, footnoteText } from "../../src/renderer/src/editor/footnoteSchema";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const dom = new DOMParser().parseFromString(
  "<!doctype html><html><head></head><body></body></html>",
  "text/html",
);
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

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (id: string, ...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content,
});
const footnote = (id: string, value: string): JSONContent => ({
  type: FOOTNOTE_NODE,
  attrs: { id },
  content: [text(value)],
});
const endnote = (id: string, value: string): JSONContent => ({
  type: FOOTNOTE_NODE,
  attrs: { id, endnote: true, source: "w:endnoteReference#0" },
  content: [text(value)],
});
/** A copy of the endnote as pasting one writes it: its place and kind kept, its ID taken off. */
const pasted = (): JSONContent => ({
  type: FOOTNOTE_NODE,
  attrs: { endnote: true, source: "w:endnoteReference#0" },
  content: [text("B")],
});

/** An editor of a Note holding these Blocks, imported from a Word file or not. */
function noteWith(blocks: JSONContent[], { fromWord }: { fromWord: boolean }): Editor {
  const source = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: { type: "doc", content: blocks },
  });
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(source.state.doc, doc.getXmlFragment(MIND_CONTENT_FIELD));
  source.destroy();
  if (fromWord) {
    doc.getMap(MIND_WORD_FIELD).set("file", {
      name: "Brief.docx",
      sha256: "0".repeat(64),
      size: 1,
      part: "word/document.xml",
    });
  }
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...noteExtensions(),
      Collaboration.configure({ document: doc, field: MIND_CONTENT_FIELD }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  onTestFinished(() => {
    editor.destroy();
    doc.destroy();
  });
  return editor;
}

const shown = (editor: Editor) =>
  numberFootnotes(editor.state.doc).footnotes.map(
    (each) => `${each.endnote ? "e" : "f"}${each.number} ${footnoteText(each.node)}`,
  );

describe("a copy of a Word file's note", () => {
  test("pasted while the note is there is a footnote of the User's own, numbered with the footnotes; the note is still the file's", () => {
    const editor = noteWith(
      [paragraph("a", text("One"), footnote("f1", "A"), endnote("e1", "B"))],
      { fromWord: true },
    );
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, pasted());
    expect(shown(editor)).toEqual(["f1 A", "e1 B", "f2 B"]);
    expect(numberFootnotes(editor.state.doc).footnotes[2]?.node.attrs).toMatchObject({
      source: null,
      endnote: null,
    });
    editor.commands.insertContentAt(1, pasted());
    expect(shown(editor)).toEqual(["f1 B", "f2 A", "e1 B", "f3 B"]);
    expect(findFootnote(editor.state.doc, "e1")?.node.attrs).toMatchObject({
      endnote: true,
      source: "w:endnoteReference#0",
    });
  });

  test("moved, cut and pasted elsewhere, is the file's endnote still", () => {
    const editor = noteWith(
      [paragraph("a", text("One"), endnote("e1", "B")), paragraph("b", text("Two"))],
      { fromWord: true },
    );
    const found = findFootnote(editor.state.doc, "e1");
    if (!found) throw new Error("No endnote.");
    editor.commands.deleteRange({ from: found.pos, to: found.pos + found.node.nodeSize });
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, pasted());
    expect(shown(editor)).toEqual(["e1 B"]);
    expect(numberFootnotes(editor.state.doc).footnotes[0]?.node.attrs).toMatchObject({
      endnote: true,
      source: "w:endnoteReference#0",
    });
  });

  test("pasted into a Note not imported from Word is a footnote", () => {
    const editor = noteWith([paragraph("a", text("Mine"), footnote("f1", "A"))], {
      fromWord: false,
    });
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, pasted());
    expect(shown(editor)).toEqual(["f1 A", "f2 B"]);
  });
});
