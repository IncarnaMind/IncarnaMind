import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { describe, expect, onTestFinished, test } from "vitest";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  forgetMenuClosed,
  keepMenuClosed,
  menuClosedOver,
} from "../../src/renderer/src/editor/selectionDismissal";

const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text: value }],
});

function editorWith(blocks: JSONContent[]): Editor {
  const editor = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: { type: "doc", content: blocks },
  });
  onTestFinished(() => editor.destroy());
  return editor;
}

/** Selects the document's text from `from` to `to`, as find does over its match. */
const select = (editor: Editor, from: number, to: number) =>
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
  );

describe("the selection menu stays closed over a selection the User didn't make", () => {
  test("closed over the marked selection until the selection changes, and open over a new one", () => {
    const editor = editorWith([paragraph("Tides follow the Moon, and the moon pulls the sea.")]);
    // "moon", the second word of that name: character 34, so from 35 to 39 in the document.
    keepMenuClosed(editor, 35, 39);
    select(editor, 35, 39);
    expect(menuClosedOver(editor)).toBe(true);
    // Still closed while an update already waiting arrives over the same selection.
    expect(menuClosedOver(editor)).toBe(true);

    // A selection the User makes opens it, and the old mark is forgotten.
    select(editor, 1, 6);
    expect(menuClosedOver(editor)).toBe(false);
    select(editor, 35, 39);
    expect(menuClosedOver(editor)).toBe(false);
  });

  test("forgotten, the menu opens over the same selection again", () => {
    const editor = editorWith([paragraph("Tides follow the Moon.")]);
    keepMenuClosed(editor, 1, 6);
    select(editor, 1, 6);
    expect(menuClosedOver(editor)).toBe(true);

    forgetMenuClosed(editor);
    expect(menuClosedOver(editor)).toBe(false);
  });
});
