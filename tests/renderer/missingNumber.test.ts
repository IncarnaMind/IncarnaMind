/*
 * The mark where a figure couldn't be calculated, in the Note's editor (#2577): one inline atom with
 * no attributes, which the arrows step over as one character and Shift with an arrow selects;
 * Backspace and Delete take it out whole, typing over it replaces it, and ⌘Z brings it back. It
 * takes no number in the one series, and a copy writes its words in the interface language.
 */
import {
  getSchema,
  getTextBetween,
  getTextSerializersFromSchema,
  type JSONContent,
} from "@tiptap/core";
import { DOMSerializer, DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { updateYFragment } from "@tiptap/y-tiptap";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { numberFootnotes } from "../../src/renderer/src/editor/citationNumbers";
import { copiedText } from "../../src/renderer/src/editor/copyNotes";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { translate } from "../../src/shared/i18n";
import { boundEditorTo, typeText } from "../helpers/editor";

const text = (value: string): JSONContent => ({ type: "text", text: value });
const MARK: JSONContent = { type: "missingNumber" };
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

const schema = getSchema(noteExtensions());

/** A Note holding these Blocks, as stored, in an editor bound to it: nothing to undo yet. */
function noteWith(blocks: JSONContent[]) {
  const doc = new Y.Doc();
  updateYFragment(
    doc,
    doc.getXmlFragment(MIND_CONTENT_FIELD),
    schema.nodeFromJSON({ type: "doc", content: blocks }),
    { mapping: new Map(), isOMark: new Map() },
  );
  return boundEditorTo(doc);
}

type Editor = ReturnType<typeof noteWith>;

/** A key pressed in the note, as the editor's keymaps take it. */
function press(editor: Editor, key: string, shiftKey = false): boolean {
  const event = {
    key,
    keyCode: 0,
    shiftKey,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;
  return editor.state.plugins.some(
    (plugin) => plugin.props.handleKeyDown?.call(plugin, editor.view, event) === true,
  );
}

/** The first paragraph, the mark as "‹mark›". */
function line(editor: Editor): string {
  let read = "";
  editor.state.doc.child(0).forEach((node) => {
    read += node.isText ? (node.text ?? "") : node.type.name === "missingNumber" ? "‹mark›" : "?";
  });
  return read;
}

/** "Growth was ‹mark›.": the mark's place, after "Growth was ". */
const AT = 1 + "Growth was ".length;

const growth = () => noteWith([paragraph(text("Growth was "), MARK, text("."))]);

test("the Note schema keeps the mark as one selectable inline atom with no attributes", () => {
  const node = schema.nodeFromJSON(MARK);
  expect(node.isInline).toBe(true);
  expect(node.isAtom).toBe(true);
  expect(node.type.spec.selectable).toBe(true);
  expect(node.toJSON()).toEqual({ type: "missingNumber" });
});

describe("in the editor", () => {
  test("the arrows step over the mark as one character, both ways", () => {
    const editor = growth();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, AT)));
    expect(press(editor, "ArrowRight")).toBe(true);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(AT + 1);
    expect(press(editor, "ArrowLeft")).toBe(true);
    expect(editor.state.selection.from).toBe(AT);
  });

  test("Shift with an arrow selects the mark, as one thing, and typing over it replaces it; ⌘Z brings it back", () => {
    const editor = growth();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, AT)));
    press(editor, "ArrowRight", true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe("missingNumber");
    editor.view.dispatch(editor.state.tr.insertText("8.0%"));
    expect(line(editor)).toBe("Growth was 8.0%.");
    editor.commands.undo();
    expect(line(editor)).toBe("Growth was ‹mark›.");
  });

  test("Backspace after the mark takes it out whole, and ⌘Z brings it back", () => {
    const editor = growth();
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, AT + 1)),
    );
    expect(press(editor, "Backspace")).toBe(true);
    expect(line(editor)).toBe("Growth was .");
    editor.commands.undo();
    expect(line(editor)).toBe("Growth was ‹mark›.");
  });

  test("Delete before the mark takes it out whole, and ⌘Z brings it back", () => {
    const editor = growth();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, AT)));
    expect(press(editor, "Delete")).toBe(true);
    expect(line(editor)).toBe("Growth was .");
    editor.commands.undo();
    expect(line(editor)).toBe("Growth was ‹mark›.");
  });

  test("the words typed by the User stay text", () => {
    const editor = noteWith([paragraph(text("Growth was "))]);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, AT)));
    typeText(editor, "[number missing]");
    expect(line(editor)).toBe("Growth was [number missing]");
  });
});

test("the mark takes no number in the one series", () => {
  const cite = (documentId: string): JSONContent => ({
    type: "citation",
    attrs: { documentId, documentName: documentId, check: "found" },
  });
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [paragraph(text("A "), cite("a"), text(" was "), MARK, text(" and "), cite("b"))],
  });
  const numbered = numberFootnotes(doc);
  expect(numbered.citations.map((each) => each.number)).toEqual([1, 2]);
  expect(numbered.figures).toEqual([]);
  expect(numbered.footnotes).toEqual([]);
});

describe.each([
  ["en", "Growth was [number missing]."],
  ["zh-CN", "Growth was [缺少数字]."],
] as const)("copied with the interface in %s", (language, copied) => {
  const words = () => translate(language, "missingNumber.words");
  const inLanguage = getSchema(noteExtensions({ missingNumberWords: words }));
  const doc = inLanguage.nodeFromJSON({
    type: "doc",
    content: [paragraph(text("Growth was "), MARK, text("."))],
  });

  test("the plain text writes the mark's words", () => {
    const plain = getTextBetween(
      doc,
      { from: 0, to: doc.content.size },
      { textSerializers: getTextSerializersFromSchema(inLanguage) },
    );
    expect(plain).toBe(copied);
  });

  test("a copy with a Citation writes them too, beside its Sources", () => {
    const cited = inLanguage.nodeFromJSON({
      type: "doc",
      content: [
        paragraph(text("Growth was "), MARK, text("."), {
          type: "citation",
          attrs: { documentId: "d", documentName: "Loans", check: "found" },
        }),
      ],
    });
    const plain = copiedText(cited.content, inLanguage, { language, documents: [] });
    expect(plain.split("\n")[0]).toBe(`${copied}[1]`);
  });

  test("the HTML shows the words, and pastes back into a Note as the mark", () => {
    const { document } = parseHTML("<!doctype html><html><body></body></html>");
    const dom = DOMSerializer.fromSchema(inLanguage).serializeFragment(doc.content, { document });
    document.body.append(dom);
    expect(document.body.textContent).toBe(copied);
    const pasted = ProseMirrorDOMParser.fromSchema(inLanguage).parse(document.body);
    expect(pasted.firstChild?.child(1).type.name).toBe("missingNumber");
  });
});
