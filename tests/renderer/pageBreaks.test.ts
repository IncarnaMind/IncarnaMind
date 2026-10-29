import { getSchema, type JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { updateYFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD, PAGE_BREAK_NODE } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  canInsertPageBreak,
  insertPageBreak,
  pageBreakPlace,
} from "../../src/renderer/src/editor/pageBreakSchema";
import { boundEditorTo } from "../helpers/editor";

/*
 * Page breaks in any Note (#746): put where the selection starts, selected
 * as one thing, deleted like any Block, and taken back with ⌘Z.
 */

const text = (value: string): JSONContent => ({ type: "text", text: value });
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

/** A key pressed in the note, as the editor's keymaps take it. */
function press(editor: ReturnType<typeof noteWith>, key: "Backspace" | "Delete"): boolean {
  const event = {
    key,
    keyCode: key === "Backspace" ? 8 : 46,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;
  return editor.state.plugins.some(
    (plugin) => plugin.props.handleKeyDown?.call(plugin, editor.view, event) === true,
  );
}

function blocksOf(editor: ReturnType<typeof noteWith>) {
  const json: JSONContent = editor.getJSON();
  return (json.content ?? []).map((block) =>
    (block.content ?? []).map((node) => (node.type === "text" ? node.text : node.type)),
  );
}

describe("a page break", () => {
  test("ends the line where the cursor is, as Word's does: what follows starts a paragraph of its own, with the cursor", () => {
    const editor = noteWith([paragraph(text("Page one. Page two."))]);
    editor.commands.setTextSelection(11);
    expect(insertPageBreak(editor)).toBe(true);
    expect(blocksOf(editor)).toEqual([["Page one. ", PAGE_BREAK_NODE], ["Page two."]]);
    const { $from } = editor.state.selection;
    expect([$from.index(0), $from.parentOffset]).toEqual([1, 0]);
  });

  test("at a line's start, is a line of its own before it, and the line stays the one it was", () => {
    const editor = noteWith([paragraph(text("Schedule"))]);
    const id = editor.state.doc.child(0).attrs.id;
    editor.commands.setTextSelection(1);
    insertPageBreak(editor);
    expect(blocksOf(editor)).toEqual([[PAGE_BREAK_NODE], ["Schedule"]]);
    expect(editor.state.doc.child(1).attrs.id).toBe(id);
    expect(editor.state.doc.child(0).attrs.id).not.toBe(id);
    expect(editor.state.selection.$from.index(0)).toBe(1);
  });

  test("goes before selected text, which stays and starts the next page", () => {
    const editor = noteWith([paragraph(text("Keep this together."))]);
    editor.commands.setTextSelection({ from: 6, to: 10 });
    insertPageBreak(editor);
    expect(blocksOf(editor)).toEqual([["Keep ", PAGE_BREAK_NODE], ["this together."]]);
  });

  test("can't go in a table, a Question or code", () => {
    const editor = noteWith([
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [paragraph(text("A cell"))] }],
          },
        ],
      },
      { type: "codeBlock", content: [text("let x = 1;")] },
      { type: "question", content: [text("Who signed?")] },
    ]);
    const lines: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock) lines.push(pos + 2);
    });
    expect(lines).toHaveLength(3);
    for (const at of lines) {
      editor.commands.setTextSelection(at);
      expect(editor.state.selection.$from.parent.inlineContent).toBe(true);
      expect(canInsertPageBreak(editor.state)).toBe(false);
      expect(pageBreakPlace(editor.state)).toBeNull();
    }
  });

  test("selected and deleted, goes with its line when it is alone on one, and ⌘Z brings it back", () => {
    const editor = noteWith([
      paragraph(text("Before.")),
      paragraph({ type: PAGE_BREAK_NODE }),
      paragraph(text("After.")),
    ]);
    const at = editor.state.doc.child(0).nodeSize + 1;
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)));
    expect(press(editor, "Backspace")).toBe(true);
    expect(blocksOf(editor)).toEqual([["Before."], ["After."]]);
    editor.commands.undo();
    expect(blocksOf(editor)).toEqual([["Before."], [PAGE_BREAK_NODE], ["After."]]);
  });

  test("in the middle of a line, deleted, leaves the text joined, and ⌘Z brings it back", () => {
    const editor = noteWith([paragraph(text("One."), { type: PAGE_BREAK_NODE }, text("Two."))]);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 5)));
    press(editor, "Delete");
    expect(blocksOf(editor)).toEqual([["One.Two."]]);
    editor.commands.undo();
    expect(blocksOf(editor)).toEqual([["One.", PAGE_BREAK_NODE, "Two."]]);
  });

  test("put in, ⌘Z takes it out again in one step", () => {
    const editor = noteWith([paragraph(text("Typed."))]);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7)));
    insertPageBreak(editor);
    expect(blocksOf(editor)).toEqual([["Typed.", PAGE_BREAK_NODE], []]);
    editor.commands.undo();
    expect(blocksOf(editor)).toEqual([["Typed."]]);
  });
});

describe("⌘↵ in the note", () => {
  /** ⌘↵ (Ctrl+Enter off macOS) pressed in the note, as the editor's keymaps take it. */
  function modEnter(editor: ReturnType<typeof noteWith>): boolean {
    const mac = /Mac/.test(navigator.platform);
    const event = {
      key: "Enter",
      keyCode: 13,
      shiftKey: false,
      altKey: false,
      ctrlKey: !mac,
      metaKey: mac,
      preventDefault: () => undefined,
    } as unknown as KeyboardEvent;
    return editor.state.plugins.some(
      (plugin) => plugin.props.handleKeyDown?.call(plugin, editor.view, event) === true,
    );
  }

  test("puts a page break where the cursor is", () => {
    const editor = noteWith([paragraph(text("One. Two."))]);
    editor.commands.setTextSelection(6);
    expect(modEnter(editor)).toBe(true);
    expect(blocksOf(editor)).toEqual([["One. ", PAGE_BREAK_NODE], ["Two."]]);
  });

  test("where no page break can go, is a line break as before", () => {
    const editor = noteWith([{ type: "question", content: [text("Who signed?")] }]);
    editor.commands.setTextSelection(5);
    expect(modEnter(editor)).toBe(true);
    expect(blocksOf(editor)).toEqual([["Who ", "hardBreak", "signed?"]]);
  });
});
