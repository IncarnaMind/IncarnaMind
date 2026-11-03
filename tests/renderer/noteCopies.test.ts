/**
 * A copy of a Word file's note is a footnote of the User's own (#746): in the
 * editor of a Note bound to its Yjs document, as the app's is, and through
 * its own copy and paste, a copy pasted while the note is there, into the
 * Note of another file or into a Note not imported from Word is numbered with
 * the footnotes, and a note moved within its file stays the file's endnote.
 * What the import kept as is (a field, a note, a picture) pasted into another
 * file's Note has no place in it either.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import {
  FOOTNOTE_NODE,
  MIND_CONTENT_FIELD,
  MIND_WORD_FIELD,
  PAGE_BREAK_NODE,
  WORD_ATOM_NODE,
  WORD_BLOCK_NODE,
} from "../../src/core/api";
import { numberFootnotes } from "../../src/renderer/src/editor/citationNumbers";
import { findFootnote, footnoteText } from "../../src/renderer/src/editor/footnoteSchema";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

/** A page for the editor, with what ProseMirror's copy and paste make their HTML in. */
function domDocument() {
  const page = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(page, "styleSheets", { value: [] });
  Object.defineProperty(page, "implementation", { value: { createHTMLDocument: domDocument } });
  return page;
}
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
const pageBreak = (): JSONContent => ({ type: PAGE_BREAK_NODE, attrs: { source: "w:br#0" } });

const FILE_A = "a".repeat(64);
const FILE_B = "b".repeat(64);

/** An editor of a Note holding these Blocks, imported from the Word file with this hash, or not. */
function noteWith(blocks: JSONContent[], file: string | null): Editor {
  const source = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: { type: "doc", content: blocks },
  });
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(source.state.doc, doc.getXmlFragment(MIND_CONTENT_FIELD));
  source.destroy();
  if (file) {
    doc.getMap(MIND_WORD_FIELD).set("file", {
      name: "Brief.docx",
      sha256: file,
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

/** What copying the node at `pos` puts on the clipboard, through the editor's own copy. */
function copied(editor: Editor, pos: number): string {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) throw new Error("Nothing to copy.");
  return editor.view.serializeForClipboard(editor.state.doc.slice(pos, pos + node.nodeSize)).dom
    .innerHTML;
}

/** Pastes clipboard HTML at the end of the last paragraph, as the editor takes a paste. */
function paste(editor: Editor, html: string): void {
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.view.pasteHTML(html, new Event("paste") as ClipboardEvent);
}

const endnoteAt = (editor: Editor, id: string) => {
  const found = findFootnote(editor.state.doc, id);
  if (!found) throw new Error(`No note ${id}.`);
  return found;
};

const shown = (editor: Editor) =>
  numberFootnotes(editor.state.doc).footnotes.map(
    (each) => `${each.endnote ? "e" : "f"}${each.number} ${footnoteText(each.node)}`,
  );

const placesOf = (editor: Editor) => {
  const found: unknown[] = [];
  editor.state.doc.descendants((node) => {
    if ([FOOTNOTE_NODE, PAGE_BREAK_NODE, "image"].includes(node.type.name))
      found.push(node.attrs.source);
  });
  return found;
};

const kept = (kind: string, source: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type: WORD_ATOM_NODE,
  attrs: { kind, label: "", text: "", source, hash: null, ...attrs },
});

/** What the import kept as is, in the Note: each atom's kind and place. */
const keptIn = (editor: Editor) => {
  const found: [unknown, unknown][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === WORD_ATOM_NODE || node.type.name === WORD_BLOCK_NODE)
      found.push([node.attrs.kind, node.attrs.hash === null ? node.attrs.source : "hash"]);
  });
  return found;
};

/** The position of the first node of this type whose attribute `kind` is `kind`. */
const keptAt = (editor: Editor, kind: string) => {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.attrs.kind === kind) at = pos;
  });
  if (at < 0) throw new Error(`No ${kind}.`);
  return at;
};

describe("a copy of a Word file's note", () => {
  test("pasted while the note is there is a footnote of the User's own, numbered with the footnotes; the note is still the file's", () => {
    const editor = noteWith(
      [paragraph("a", text("One"), footnote("f1", "A"), endnote("e1", "B"))],
      FILE_A,
    );
    const clipboard = copied(editor, endnoteAt(editor, "e1").pos);
    paste(editor, clipboard);
    expect(shown(editor)).toEqual(["f1 A", "e1 B", "f2 B"]);
    expect(numberFootnotes(editor.state.doc).footnotes[2]?.node.attrs).toMatchObject({
      source: null,
      endnote: null,
    });
    // One written as JSON, as a command that copies a Block writes it, is a copy too.
    editor.commands.insertContentAt(1, {
      type: FOOTNOTE_NODE,
      attrs: { endnote: true, source: "w:endnoteReference#0" },
      content: [text("B")],
    });
    expect(shown(editor)).toEqual(["f1 B", "f2 A", "e1 B", "f3 B"]);
    expect(endnoteAt(editor, "e1").node.attrs).toMatchObject({
      endnote: true,
      source: "w:endnoteReference#0",
    });
  });

  test("moved, cut and pasted elsewhere in its Note, is the file's endnote still", () => {
    const editor = noteWith(
      [paragraph("a", text("One"), endnote("e1", "B")), paragraph("b", text("Two"))],
      FILE_A,
    );
    const { pos, node } = endnoteAt(editor, "e1");
    const clipboard = copied(editor, pos);
    editor.commands.deleteRange({ from: pos, to: pos + node.nodeSize });
    paste(editor, clipboard);
    expect(shown(editor)).toEqual(["e1 B"]);
    expect(placesOf(editor)).toEqual(["w:endnoteReference#0"]);
  });

  test.each([
    ["English", "Mine", "From A."],
    ["Chinese", "我的", "来自甲。"],
  ])(
    "pasted into the Note of another Word file is a footnote, and a page break or a picture a new one, their places in the first file gone (%s)",
    (_, mine, fromA) => {
      const logo: JSONContent = {
        type: "image",
        attrs: { src: "data:image/png;base64,iVBORw0KGgo=", alt: fromA, source: "w:drawing#0" },
      };
      const a = noteWith(
        [paragraph("a", text("One"), endnote("e1", fromA), pageBreak(), logo)],
        FILE_A,
      );
      const b = noteWith(
        [
          paragraph("b", text(mine), {
            ...footnote("g1", "Own"),
            attrs: { id: "g1", source: "w:footnoteReference#0" },
          }),
        ],
        FILE_B,
      );
      paste(b, copied(a, endnoteAt(a, "e1").pos));
      const breakAt = endnoteAt(a, "e1").pos + endnoteAt(a, "e1").node.nodeSize;
      paste(b, copied(a, breakAt));
      paste(b, copied(a, breakAt + 1));
      expect(shown(b)).toEqual(["f1 Own", `f2 ${fromA}`]);
      expect(placesOf(b)).toEqual(["w:footnoteReference#0", null, null, null]);
    },
  );

  test("pasted into another Note of the same file, where its place is free, is the file's endnote", () => {
    const a = noteWith([paragraph("a", text("One"), endnote("e1", "B"))], FILE_A);
    const again = noteWith([paragraph("c", text("Again"))], FILE_A);
    paste(again, copied(a, endnoteAt(a, "e1").pos));
    expect(shown(again)).toEqual(["e1 B"]);
    expect(placesOf(again)).toEqual(["w:endnoteReference#0"]);
  });

  test("pasted into a Note not imported from Word is a footnote", () => {
    const a = noteWith([paragraph("a", text("One"), endnote("e1", "B"))], FILE_A);
    const mine = noteWith([paragraph("m", text("Mine"), footnote("f1", "A"))], null);
    paste(mine, copied(a, endnoteAt(a, "e1").pos));
    expect(shown(mine)).toEqual(["f1 A", "f2 B"]);
    expect(placesOf(mine)).toEqual([null, null]);
  });
});

describe("a copy of what a Word file's import kept as is", () => {
  test.each([
    ["English", "Mine", "2026-01-01", "A note with a picture.", "A's chart"],
    ["Chinese", "我的", "2026年1月1日", "甲文件带图片的脚注。", "甲文件的图表"],
  ])(
    "pasted into the Note of another Word file has no place there, a note kept as is numbered with its footnotes (%s)",
    (_, mine, date, noteText, chart) => {
      const a = noteWith(
        [
          paragraph(
            "a",
            text("One"),
            kept("field", "w:r#5..w:r#7", { label: date, hash: "a1", info: { field: "DATE" } }),
            kept("endnote", "w:endnoteReference#0", { label: "1", text: noteText }),
            kept("picture", "w:drawing#0", { label: chart }),
          ),
          {
            type: WORD_BLOCK_NODE,
            attrs: { id: "k", kind: "control", label: "", text: "Contents", source: "w:sdt#0" },
          },
          paragraph("c", text("Noted"), {
            type: FOOTNOTE_NODE,
            attrs: { id: "f1", source: "w:footnoteReference#0" },
            content: [
              text("See "),
              kept("field", "word/footnotes.xml!w:r#3..w:r#5", { label: "7" }),
            ],
          }),
        ],
        FILE_A,
      );
      const b = noteWith([paragraph("b", text(mine))], FILE_B);
      for (const kind of ["field", "endnote", "picture", "control"])
        paste(b, copied(a, keptAt(a, kind)));
      paste(b, copied(a, endnoteAt(a, "f1").pos));
      expect(keptIn(b)).toEqual([
        ["field", null],
        ["footnote", null],
        ["picture", null],
        ["field", null],
        ["control", null],
      ]);
      expect(
        numberFootnotes(b.state.doc).footnotes.map(
          (each) => `${each.endnote ? "e" : "f"}${each.number}${each.kept ? " kept" : ""}`,
        ),
      ).toEqual(["f1 kept", "f2"]);
      expect(placesOf(b)).toEqual([null]);
    },
  );

  test("copied within its file's Note, a field keeps its place, and a note kept as is, while the note is there, is the User's footnote", () => {
    const a = noteWith(
      [
        paragraph(
          "a",
          text("One"),
          kept("field", "w:r#5..w:r#7", { label: "2026-01-01" }),
          kept("footnote", "w:footnoteReference#1", { label: "1", text: "Kept." }),
        ),
      ],
      FILE_A,
    );
    paste(a, copied(a, keptAt(a, "field")));
    paste(a, copied(a, keptAt(a, "footnote")));
    expect(keptIn(a)).toEqual([
      ["field", "w:r#5..w:r#7"],
      ["footnote", "w:footnoteReference#1"],
      ["field", "w:r#5..w:r#7"],
      ["footnote", null],
    ]);
  });
});
