import { Editor, getSchema, type JSONContent } from "@tiptap/core";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { describe, expect, onTestFinished, test } from "vitest";
import { CITATION_NODE, FOOTNOTE_NODE, QUESTION_BLOCK } from "../../src/core/api";
import {
  citationNumbersPlugin,
  numberedCitations,
  numberedFootnotes,
  numberFootnotes,
  textBlockEdited,
} from "../../src/renderer/src/editor/citationNumbers";
import {
  canInsertFootnote,
  findFootnote,
  footnoteText,
  insertFootnote,
  openFootnoteOf,
} from "../../src/renderer/src/editor/footnoteSchema";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

/*
 * Footnotes the User writes (#284) in the editor: numbered with Citations,
 * inserted after the selection and opened, typed as "^[…]", and copied.
 */

const schema = getSchema(noteExtensions());

const text = (value: string, ...marks: string[]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks.length > 0 && { marks: marks.map((type) => ({ type })) }),
});
const paragraph = (id: string, ...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content,
});
const citation = (documentId: string): JSONContent => ({
  type: CITATION_NODE,
  attrs: { documentId, documentName: documentId, check: "found" },
});
const footnote = (id: string, ...content: JSONContent[]): JSONContent => ({
  type: FOOTNOTE_NODE,
  attrs: { id },
  content,
});

const stateWith = (blocks: JSONContent[]) =>
  EditorState.create({
    doc: schema.nodeFromJSON({ type: "doc", content: blocks }),
    plugins: [citationNumbersPlugin()],
  });

/**
 * An editor of these Blocks, not drawn (there is no page here), with its
 * plugins: they are added only once an editor is drawn, so they are put in here.
 */
function editorWith(blocks: JSONContent[]): Editor {
  const editor = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: { type: "doc", content: blocks },
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  onTestFinished(() => editor.destroy());
  return editor;
}

/** Types `typed` at the cursor as the editor takes typing in, so input rules see it. */
function type(editor: Editor, typed: string) {
  for (const character of typed) {
    const { from, to } = editor.state.selection;
    const insert = () => editor.state.tr.insertText(character, from, to);
    const handled = editor.state.plugins.some((plugin) =>
      plugin.props.handleTextInput?.call(plugin, editor.view, from, to, character, insert),
    );
    if (!handled) editor.view.dispatch(insert());
  }
}

const footnoteTexts = (editor: Editor) => {
  const texts: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== FOOTNOTE_NODE) return true;
    texts.push(footnoteText(node));
    return false;
  });
  return texts;
};

describe("one numbering for footnotes and Citations", () => {
  test("they are numbered together, top to bottom through the Mind; a Citation in a footnote has no number", () => {
    const state = stateWith([
      paragraph("a", text("Tides"), footnote("n1", text("Twice a month")), citation("tides")),
      paragraph("b", text("Notes")),
      paragraph("c", citation("moon"), footnote("n2", text("See "), citation("harbour"))),
    ]);

    const { citations, footnotes } = numberFootnotes(state.doc);
    expect(footnotes.map((each) => `${each.id}:${each.number}`)).toEqual(["n1:1", "n2:4"]);
    expect(citations.map((each) => `${each.attributes.documentId}:${each.number}`)).toEqual([
      "tides:2",
      "moon:3",
    ]);
    // Citations keep their key in their Block, so their marks in the margin keep theirs.
    expect(citations.map((each) => each.key)).toEqual(["a:1", "c:1"]);
    expect(numberedFootnotes(state)).toEqual(footnotes);
    expect(numberedCitations(state)).toEqual(citations);
  });

  test("typing beside a footnote renumbers nothing; adding or removing one renumbers the rest", () => {
    let state = stateWith([
      paragraph("a", text("Tides"), footnote("n1", text("Twice a month"))),
      paragraph("b", citation("moon")),
    ]);
    const typing = state.tr.insertText("Spring ", 1);
    expect(textBlockEdited(typing)).toBe(0);
    state = state.apply(typing);
    expect(numberedFootnotes(state).map((each) => each.number)).toEqual([1]);
    expect(numberedFootnotes(state)[0]?.pos).toBe(1 + "Spring Tides".length);

    // A footnote added before the Citation in the next Block: the Citation becomes 3.
    const added = state.tr.insert(1, schema.nodeFromJSON(footnote("n0", text("First"))));
    expect(textBlockEdited(added)).toBeNull();
    state = state.apply(added);
    expect(numberedFootnotes(state).map((each) => `${each.id}:${each.number}`)).toEqual([
      "n0:1",
      "n1:2",
    ]);
    expect(numberedCitations(state).map((each) => each.number)).toEqual([3]);
  });
});

describe("inserting a footnote", () => {
  test("goes after the selection, as an empty footnote opened to be written, the cursor after it", () => {
    const editor = editorWith([paragraph("a", text("Spring tides are strongest"))]);
    editor.commands.setTextSelection({ from: 1, to: 13 });

    const id = insertFootnote(editor);

    expect(id).toEqual(expect.any(String));
    const found = id ? findFootnote(editor.state.doc, id) : null;
    expect(found?.pos).toBe(13);
    expect(found?.node.content.size).toBe(0);
    expect(openFootnoteOf(editor.state)).toBe(id);
    expect(editor.state.selection.from).toBe(13 + (found?.node.nodeSize ?? 0));
    expect(editor.state.doc.textContent).toBe("Spring tides are strongest");
  });

  test("with a footnote selected, opens that one instead of adding another", () => {
    const editor = editorWith([paragraph("a", text("Tides"), footnote("n1", text("Twice")))]);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 6)));
    expect(insertFootnote(editor)).toBe("n1");
    expect(openFootnoteOf(editor.state)).toBe("n1");
    expect(footnoteTexts(editor)).toEqual(["Twice"]);
  });

  test("isn't offered in a Question or in code", () => {
    const editor = editorWith([
      { type: QUESTION_BLOCK, attrs: { id: "q" }, content: [text("When?")] },
      { type: "codeBlock", attrs: { id: "c" }, content: [text("tide()")] },
    ]);
    editor.commands.setTextSelection(3);
    expect(canInsertFootnote(editor.state)).toBe(false);
    expect(insertFootnote(editor)).toBeNull();
    const code = 1 + (editor.state.doc.firstChild?.nodeSize ?? 0) + 2;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, code)),
    );
    expect(canInsertFootnote(editor.state)).toBe(false);
    expect(footnoteTexts(editor)).toEqual([]);
  });
});

describe("typing ^[…]", () => {
  test("makes a footnote of the words between the brackets, with their marks", () => {
    const editor = editorWith([paragraph("a", text("Spring tides"))]);
    editor.commands.setTextSelection(13);
    type(editor, "^[Twice a ");
    editor.commands.setMark("bold");
    type(editor, "month");
    editor.commands.unsetMark("bold");
    type(editor, "]");

    expect(footnoteTexts(editor)).toEqual(["Twice a month"]);
    expect(editor.state.doc.textContent).toBe("Spring tidesTwice a month");
    let bold = "";
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === "bold")) bold += node.text;
    });
    expect(bold).toBe("month");
    expect(editor.getText()).toBe("Spring tides^[Twice a month]");
  });

  test("takes Chinese text and full-width brackets, and does nothing in a Question", () => {
    const editor = editorWith([
      paragraph("a", text("大潮")),
      { type: QUESTION_BLOCK, attrs: { id: "q" }, content: [text("Why")] },
    ]);
    editor.commands.setTextSelection(3);
    type(editor, "^【每月两次】");
    expect(footnoteTexts(editor)).toEqual(["每月两次"]);

    const end = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(end);
    type(editor, "^[not here]");
    expect(footnoteTexts(editor)).toEqual(["每月两次"]);
    expect(editor.state.doc.lastChild?.textContent).toBe("Why^[not here]");
  });
});

describe("copying a footnote", () => {
  test("as HTML it is a <sup> holding its text; as plain text, ^[…]", () => {
    const node = schema.nodeFromJSON(footnote("n1", text("See "), citation("harbour")));
    const spec = node.type.spec;
    expect(spec.parseDOM?.[0]?.tag).toBe(`sup[data-type="${FOOTNOTE_NODE}"]`);
    const dom = spec.toDOM?.(node);
    expect(Array.isArray(dom) && dom[0]).toBe("sup");
    // Its text goes inside it (the "hole"), its Citation included.
    expect(Array.isArray(dom) && dom.at(-1)).toBe(0);
    expect(footnoteText(node)).toBe("See [harbour]");
  });

  test("a pasted copy, whose ID pasting takes off, gets a new one", () => {
    const editor = editorWith([paragraph("a", text("Tides"), footnote("n1", text("Twice")))]);
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
      type: FOOTNOTE_NODE,
      content: [text("Twice")],
    });
    const ids = numberFootnotes(editor.state.doc).footnotes.map((each) => each.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe("n1");
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("a Word file's notes (#746)", () => {
  const endnote = (id: string, ...content: JSONContent[]): JSONContent => ({
    type: FOOTNOTE_NODE,
    attrs: { id, endnote: true, source: `w:endnoteReference#${id}` },
    content,
  });
  const kept = (kind: "footnote" | "endnote"): JSONContent => ({
    type: "wordAtom",
    attrs: { kind, label: "9", text: "A table in a note", source: `w:${kind}Reference#9` },
  });

  test("endnotes are numbered on their own; a note kept as is counts where it is, as the file counts it", () => {
    const state = stateWith([
      paragraph("a", text("One"), footnote("f1", text("A")), endnote("e1", text("B"))),
      paragraph("b", kept("footnote"), citation("tides"), kept("endnote")),
      paragraph("c", footnote("f2", text("C")), endnote("e2", text("D"))),
    ]);
    const { citations, footnotes } = numberFootnotes(state.doc);
    expect(
      footnotes.map(
        (each) => `${each.endnote ? "e" : "f"}${each.number}${each.kept ? " kept" : ""}`,
      ),
    ).toEqual(["f1", "e1", "f2 kept", "e2 kept", "f4", "e3"]);
    expect(citations.map((each) => each.number)).toEqual([3]);
  });

  test("a note's text can hold what the import kept as is, and keeps where its XML is when copied", () => {
    const node = schema.nodeFromJSON(
      footnote(
        "f1",
        text("See "),
        {
          type: "wordAtom",
          attrs: { kind: "bookmark", source: "word/footnotes.xml!w:bookmarkStart#0" },
        },
        text("the deed"),
      ),
    );
    expect(() => node.check()).not.toThrow();
    expect(footnoteText(node)).toBe("See the deed");
    const copied = schema.nodeFromJSON(endnote("e1", text("B")));
    expect(copied.attrs).toMatchObject({ endnote: true, source: "w:endnoteReference#e1" });
  });
});
