import type { Editor, JSONContent } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { parseHTML } from "linkedom";
import { describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { changeIndent } from "../../src/renderer/src/editor/formatCommands";
import {
  canContinueNumbering,
  continueNumbering,
  drawnMarkers,
  restartNumbering,
  setNumbering,
} from "../../src/renderer/src/editor/numbering";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor, headlessEditor, typeText } from "../helpers/editor";
import { connectToMind } from "../helpers/mindClient";

/*
 * Numbered lists' schemes (#1419): the markers each scheme draws at each level, a list begun by
 * typing a marker, Tab and Shift-Tab across the level a list starts at, joined lists, Restart and
 * Continue, and a Mind saved before schemes. Through the editor's own commands.
 */

const item = (text: string, ...lists: JSONContent[]): JSONContent => ({
  type: "listItem",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }, ...lists],
});
const ordered = (attrs: Record<string, unknown>, ...items: JSONContent[]): JSONContent => ({
  type: "orderedList",
  attrs,
  content: items,
});
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});

function editorWith(blocks: JSONContent[]): Editor {
  const editor = headlessEditor();
  editor.commands.setContent({ type: "doc", content: blocks });
  return editor;
}

const markers = (editor: Editor) => drawnMarkers(editor.state.doc).map((each) => each.marker);

function caretAt(editor: Editor, at: number) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)));
}

function caretIn(editor: Editor, words: string, { end = false } = {}) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(words)) {
      at = pos + node.text.indexOf(words) + (end ? words.length : 0);
    }
    return at < 0;
  });
  if (at < 0) throw new Error(`No "${words}".`);
  caretAt(editor, at);
}

function selectFromTo(editor: Editor, fromWords: string, toWords: string) {
  let from = -1;
  let to = -1;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const text = node.text ?? "";
    if (from < 0 && text.includes(fromWords)) from = pos + text.indexOf(fromWords);
    if (to < 0 && text.includes(toWords)) to = pos + text.indexOf(toWords) + toWords.length;
    return true;
  });
  if (from < 0 || to < 0) throw new Error(`No "${fromWords}" or "${toWords}".`);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
  );
}

const selectedText = (editor: Editor) =>
  editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, " ");

function newLineAtEnd(editor: Editor) {
  editor.commands.insertContentAt(editor.state.doc.content.size, paragraph(""));
  caretAt(editor, editor.state.doc.content.size - 1);
}

const lists = (editor: Editor) => {
  const found: Record<string, unknown>[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name !== "orderedList") return;
    found.push({
      numbering: node.attrs.numbering,
      startLevel: node.attrs.startLevel ?? 0,
      items: node.childCount,
    });
  });
  return found;
};

async function boundToNewMind() {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const mind = await core.createMind({ title: "Lease" });
  return connectToMind(core, mind.id);
}

describe("Numbering schemes", () => {
  const fourLevels = (attrs: Record<string, unknown>) =>
    ordered(
      attrs,
      item("One", ordered({}, item("Two", ordered({}, item("Three", ordered({}, item("Four"))))))),
      item("Five"),
    );

  // protects=each scheme draws its own marker at each level, deeper levels repeating its last format and Outline adding a number; fails_when=a level draws another scheme's marker; no_claim=how wide each marker is drawn.
  test.each([
    ["default", ["1.", "a.", "i.", "i.", "2."]],
    ["outline", ["1.", "1.1.", "1.1.1.", "1.1.1.1.", "2."]],
    ["clauses", ["(a)", "(i)", "(A)", "(A)", "(b)"]],
    ["chinese", ["一、", "（一）", "1.", "（1）", "二、"]],
  ])("%s draws %o", (numbering, expected) => {
    expect(markers(editorWith([fourLevels({ numbering })]))).toEqual(expected);
  });

  // protects=a scheme applies to the whole list, nested levels too, and to a paragraph, which becomes a numbered item; fails_when=only the caret's level changes, or the paragraph stays text; no_claim=the menus that call it.
  test("a scheme applies to the whole list, and numbers a paragraph", () => {
    const editor = editorWith([fourLevels({})]);
    caretIn(editor, "Three");
    setNumbering(editor, "clauses");
    expect(markers(editor)).toEqual(["(a)", "(i)", "(A)", "(A)", "(b)"]);

    const plain = editorWith([paragraph("Plain")]);
    caretIn(plain, "Plain");
    setNumbering(plain, "chinese");
    expect(markers(plain)).toEqual(["一、"]);
  });

  // protects=Continue numbering goes on from the numbered list before, offered only when there is one and the list doesn't go on yet, and Restart at 1 starts it again; fails_when=a continued list starts at 1, or Continue is offered with nothing to go on from; no_claim=none beyond protects.
  test("Restart at 1 and Continue numbering", () => {
    const editor = editorWith([
      ordered({}, item("A"), item("B")),
      paragraph("Between"),
      ordered({}, item("C"), item("D")),
    ]);
    caretIn(editor, "A");
    expect(canContinueNumbering(editor)).toBe(false);
    caretIn(editor, "C");
    expect(canContinueNumbering(editor)).toBe(true);
    continueNumbering(editor);
    expect(markers(editor)).toEqual(["1.", "2.", "3.", "4."]);
    expect(canContinueNumbering(editor)).toBe(false);
    restartNumbering(editor);
    expect(markers(editor)).toEqual(["1.", "2.", "1.", "2."]);
  });

  // protects=a start a pasted or stored list holds, however large, draws at once as its number where the scheme can't write it; fails_when=the conversion loops or its work grows with the number; no_claim=the marker a scheme draws at a value it can still write.
  test("a list's extreme start draws at once", () => {
    const stored = editorWith([
      ordered({ numbering: "clauses", startLevel: 1, start: 1e20 }, item("Huge")),
    ]);
    expect(markers(stored)).toEqual(["(100000000000000000000)"]);

    const roman = editorWith([ordered({ startLevel: 2, start: 1e20 }, item("Huge"))]);
    expect(markers(roman)).toEqual(["100000000000000000000."]);

    const { document } = parseHTML(
      '<!doctype html><html><body><ol start="100000000000000000000" data-numbering="clauses" data-start-level="1"><li><p>Pasted</p></li></ol></body></html>',
    );
    const pasted = ProseMirrorDOMParser.fromSchema(headlessEditor().schema).parse(
      document.body as unknown as Node,
    );
    expect(drawnMarkers(pasted).map((each) => each.marker)).toEqual(["(100000000000000000000)"]);
  });

  // protects=Restart at 1 and a scheme act on the numbered list under a to-do, not on the numbered list around it; fails_when=the outer list changes and the inner one keeps its look; no_claim=Tab and Shift-Tab there.
  test("Restart and a scheme act on a numbered list under a to-do, not the list around it", () => {
    const editor = editorWith([
      ordered(
        { numbering: "outline", start: 3 },
        item("Outer", {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              content: [paragraph("To-do"), ordered({ start: 5 }, item("A"), item("B"))],
            },
          ],
        }),
      ),
    ]);
    expect(markers(editor)).toEqual(["3.", "5.", "6."]);
    caretIn(editor, "A");
    restartNumbering(editor);
    expect(markers(editor)).toEqual(["3.", "1.", "2."]);
    setNumbering(editor, "clauses");
    expect(markers(editor)).toEqual(["3.", "(a)", "(b)"]);
  });

  // protects=Continue numbering is not offered to a list after a numbered list inside a to-do, which starts fresh; fails_when=the to-do's list is taken for a list above; no_claim=a list after a top-level one, which the Restart and Continue test covers.
  test("a numbered list in a to-do above doesn't make a later list continuable", () => {
    const editor = editorWith([
      {
        type: "taskList",
        content: [{ type: "taskItem", content: [paragraph("To-do"), ordered({}, item("Inside"))] }],
      },
      paragraph("Between"),
      ordered({}, item("After")),
    ]);
    caretIn(editor, "After");
    expect(canContinueNumbering(editor)).toBe(false);
  });

  // protects=a numbered list under a bullet or a to-do draws with its own scheme and level, and a scheme applies to the whole list; fails_when=it draws no marker or takes the list above's scheme; no_claim=Continue numbering, which such a list doesn't offer.
  test("a numbered list under a bullet or a to-do draws its own scheme", () => {
    const editor = editorWith([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph("Bullet"),
              ordered({ numbering: "chinese" }, item("A", ordered({}, item("B")))),
            ],
          },
        ],
      },
      {
        type: "taskList",
        content: [{ type: "taskItem", content: [paragraph("To-do"), ordered({}, item("C"))] }],
      },
    ]);
    expect(markers(editor)).toEqual(["一、", "（一）", "1."]);
    caretIn(editor, "A");
    setNumbering(editor, "clauses");
    expect(markers(editor)).toEqual(["(a)", "(i)", "1."]);
  });
});

describe("Typing a marker", () => {
  // protects=a scheme's first marker typed at the start of an empty line begins a list in that scheme at the level that draws it, the marker drawn and not left as text, in English and Chinese, and any "N. " a default list at N as before; fails_when=the marker stays typed, or the list draws another scheme, level or number; no_claim=Chinese typed through an input method, which the e2e covers.
  test.each([
    ["1. ", "1.", { numbering: null, startLevel: 0 }],
    ["3. ", "3.", { numbering: null, startLevel: 0 }],
    ["a. ", "a.", { numbering: null, startLevel: 1 }],
    ["i. ", "i.", { numbering: null, startLevel: 2 }],
    ["1.1 ", "1.1.", { numbering: "outline", startLevel: 1 }],
    ["1.1. ", "1.1.", { numbering: "outline", startLevel: 1 }],
    ["(a) ", "(a)", { numbering: "clauses", startLevel: 0 }],
    ["(i) ", "(i)", { numbering: "clauses", startLevel: 1 }],
    ["(A) ", "(A)", { numbering: "clauses", startLevel: 2 }],
    ["一、", "一、", { numbering: "chinese", startLevel: 0 }],
    ["（一）", "（一）", { numbering: "chinese", startLevel: 1 }],
    ["（1）", "（1）", { numbering: "chinese", startLevel: 3 }],
  ])("typing %s begins a list", (typed, marker, list) => {
    const editor = editorWith([paragraph("")]);
    caretAt(editor, 1);
    typeText(editor, `${typed}Clause`);
    expect(lists(editor)).toEqual([{ ...list, items: 1 }]);
    expect(markers(editor)).toEqual([marker]);
    expect(editor.state.doc.textContent).toBe("Clause");
  });

  // protects=only a first marker begins a list: "(1) " draws in no scheme, and "(ii) ", "b. " or "c. " (as in "c. 1990") stay what was typed; fails_when=any of them becomes a list; no_claim=none beyond protects.
  test.each(["(1) ", "(ii) ", "b. ", "c. 1990"])("typing %s stays text", (typed) => {
    const editor = editorWith([paragraph("")]);
    caretAt(editor, 1);
    typeText(editor, typed);
    expect(lists(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe(typed);
  });

  // protects=a typed marker means that number, so typed on the line under a list it begins a new list at 1, in its own scheme; fails_when=the line joins the list above, or goes on with its numbers; no_claim=none beyond protects.
  test("under another list, a typed marker begins a new one", () => {
    const editor = editorWith([ordered({ numbering: "clauses", startLevel: 1 }, item("First"))]);
    newLineAtEnd(editor);
    typeText(editor, "(i) Second");
    newLineAtEnd(editor);
    typeText(editor, "一、Third");
    expect(lists(editor)).toEqual([
      { numbering: "clauses", startLevel: 1, items: 1 },
      { numbering: "clauses", startLevel: 1, items: 1 },
      { numbering: "chinese", startLevel: 0, items: 1 },
    ]);
    expect(markers(editor)).toEqual(["(i)", "(i)", "一、"]);
  });

  // protects=⌘Z straight after a typed marker puts the typed text back, and the text typed after the marker is a step of its own; fails_when=⌘Z takes the typed marker away too, or the text typed after it with the list; no_claim=Redo.
  test("⌘Z straight after puts the typed marker back", async () => {
    const editor = boundEditor(await boundToNewMind());
    caretAt(editor, 1);
    typeText(editor, "(i) ");
    expect(lists(editor)).toEqual([{ numbering: "clauses", startLevel: 1, items: 1 }]);
    editor.commands.undo();
    expect(lists(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe("(i) ");
    typeText(editor, "Rent");
    expect(editor.state.doc.textContent).toBe("(i) Rent");
    expect(lists(editor)).toEqual([]);

    newLineAtEnd(editor);
    typeText(editor, "(a) Rent");
    editor.commands.undo();
    expect(lists(editor)).toEqual([{ numbering: "clauses", startLevel: 0, items: 1 }]);
    expect(editor.state.doc.lastChild?.textContent).toBe("");
  });
});

describe("A list that starts deeper", () => {
  // protects=a list that starts at a deeper level draws that level's markers; fails_when=it draws the first level's; no_claim=its indent, which the e2e covers.
  test("a list begun with “(i)” draws the second level's markers", () => {
    const editor = editorWith([
      ordered({ numbering: "clauses", startLevel: 1 }, item("A"), item("B")),
    ]);
    expect(markers(editor)).toEqual(["(i)", "(ii)"]);
  });

  // protects=Tab on a list's first item takes only that item a level deeper, in a list of its own, as in Word, and Shift-Tab brings it back into the one list; on a one-item list the list goes deeper; Shift-Tab on a later item brings it up a level, the items before it staying and those after it nesting under it, so each keeps its level; at the first level Shift-Tab takes the item out as before; fails_when=a level is lost, an item moves two levels, or the items after the first move with it; no_claim=none beyond protects.
  test("Tab and Shift-Tab across the level a list starts at", () => {
    const editor = editorWith([
      ordered({ numbering: "clauses", startLevel: 1 }, item("A"), item("B"), item("C")),
    ]);
    caretIn(editor, "A");
    changeIndent(editor, 1);
    expect(lists(editor)).toEqual([
      { numbering: "clauses", startLevel: 2, items: 1 },
      { numbering: "clauses", startLevel: 1, items: 2 },
    ]);
    expect(markers(editor)).toEqual(["(A)", "(i)", "(ii)"]);
    expect(editor.state.selection.$from.parent.textContent).toBe("A");
    changeIndent(editor, -1);
    expect(lists(editor)).toEqual([{ numbering: "clauses", startLevel: 1, items: 3 }]);
    expect(markers(editor)).toEqual(["(i)", "(ii)", "(iii)"]);

    caretIn(editor, "B");
    changeIndent(editor, -1);
    expect(lists(editor)).toEqual([
      { numbering: "clauses", startLevel: 1, items: 1 },
      { numbering: "clauses", startLevel: 0, items: 1 },
    ]);
    expect(markers(editor)).toEqual(["(i)", "(a)", "(i)"]);
    expect(editor.state.selection.$from.parent.textContent).toBe("B");

    const single = editorWith([ordered({ numbering: "clauses" }, item("Only"))]);
    caretIn(single, "Only");
    changeIndent(single, 1);
    expect(lists(single)).toEqual([{ numbering: "clauses", startLevel: 1, items: 1 }]);

    const flat = editorWith([ordered({}, item("X"), item("Y"))]);
    caretIn(flat, "Y");
    changeIndent(flat, -1);
    expect(markers(flat)).toEqual(["1."]);
    expect(flat.state.doc.lastChild?.type.name).toBe("paragraph");
  });

  // protects=Tab and Shift-Tab change the level of every selected item, from the first, and keep the selection on them; fails_when=only the item the selection begins in moves, or the selection becomes a caret; no_claim=Undo, which the e2e covers.
  test("Tab and Shift-Tab change the level of every selected item", () => {
    const editor = editorWith([
      ordered({ numbering: "clauses", startLevel: 1 }, item("A"), item("B"), item("C")),
    ]);
    selectFromTo(editor, "A", "B");
    changeIndent(editor, 1);
    expect(lists(editor)).toEqual([
      { numbering: "clauses", startLevel: 2, items: 2 },
      { numbering: "clauses", startLevel: 1, items: 1 },
    ]);
    expect(markers(editor)).toEqual(["(A)", "(B)", "(i)"]);
    expect(selectedText(editor)).toBe("A B");

    changeIndent(editor, -1);
    expect(lists(editor)).toEqual([{ numbering: "clauses", startLevel: 1, items: 3 }]);
    expect(markers(editor)).toEqual(["(i)", "(ii)", "(iii)"]);
    expect(selectedText(editor)).toBe("A B");
  });

  // protects=Tab then Shift-Tab on the first item of a list that continues the list above gives one list again, still continuing, with the numbers it had; fails_when=the raise drops the continuation, leaves two lists, or restarts the numbering; no_claim=the same round trip on a list that doesn't continue, which the test above covers.
  test("Tab then Shift-Tab on a continued list keeps it continuing", () => {
    const editor = editorWith([
      ordered({ numbering: "clauses", startLevel: 1 }, item("First"), item("Second")),
      paragraph("Between"),
      ordered(
        { numbering: "clauses", startLevel: 1, continues: true },
        item("Third"),
        item("Fourth"),
      ),
    ]);
    expect(markers(editor)).toEqual(["(i)", "(ii)", "(iii)", "(iv)"]);
    caretIn(editor, "Third");
    changeIndent(editor, 1);
    changeIndent(editor, -1);
    expect(lists(editor)).toEqual([
      { numbering: "clauses", startLevel: 1, items: 2 },
      { numbering: "clauses", startLevel: 1, items: 2 },
    ]);
    const continued = editor.state.doc.child(2);
    expect(continued.attrs.continues).toBe(true);
    expect(markers(editor)).toEqual(["(i)", "(ii)", "(iii)", "(iv)"]);
  });

  // protects=a one-item list that continues the list above keeps continuing through Tab then Shift-Tab, with the number it had; fails_when=the continuation is dropped and the list starts at 1; no_claim=a list that doesn't continue.
  test("a one-item continued list keeps continuing through Tab then Shift-Tab", () => {
    const editor = editorWith([
      ordered({ numbering: "clauses", startLevel: 1 }, item("First"), item("Second")),
      paragraph("Between"),
      ordered({ numbering: "clauses", startLevel: 1, continues: true }, item("Third")),
    ]);
    expect(markers(editor)).toEqual(["(i)", "(ii)", "(iii)"]);
    caretIn(editor, "Third");
    changeIndent(editor, 1);
    changeIndent(editor, -1);
    expect(editor.state.doc.child(2).attrs.continues).toBe(true);
    expect(markers(editor)).toEqual(["(i)", "(ii)", "(iii)"]);
  });

  // protects=a continued list whose every item is selected keeps continuing through Tab then Shift-Tab, with its numbers and the selection; fails_when=the continuation is dropped; no_claim=a partial selection of a continued list with a list after it, which joins that list.
  test("a wholly selected continued list keeps continuing through Tab then Shift-Tab", () => {
    const editor = editorWith([
      ordered({ numbering: "clauses", startLevel: 1 }, item("First"), item("Second")),
      paragraph("Between"),
      ordered(
        { numbering: "clauses", startLevel: 1, continues: true },
        item("Third"),
        item("Fourth"),
      ),
    ]);
    selectFromTo(editor, "Third", "Fourth");
    changeIndent(editor, 1);
    changeIndent(editor, -1);
    expect(editor.state.doc.child(2).attrs.continues).toBe(true);
    expect(markers(editor)).toEqual(["(i)", "(ii)", "(iii)", "(iv)"]);
    expect(selectedText(editor)).toBe("Third Fourth");
  });

  // protects=Tab in a table moves between cells, from a list item in one too (DESIGN.md › Lists › Keys); fails_when=the item indents instead; no_claim=Shift-Tab, which the same guard covers.
  test("Tab in a table moves between cells, not the item's level", () => {
    const editor = editorWith([
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [ordered({}, item("Cell one"), item("Cell two"))] },
              { type: "tableCell", content: [paragraph("Second cell")] },
            ],
          },
        ],
      },
    ]);
    caretIn(editor, "Cell one");
    const keydown = {
      key: "Tab",
      keyCode: 9,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    } as unknown as KeyboardEvent;
    const handled = editor.state.plugins.some((plugin) =>
      plugin.props.handleKeyDown?.call(plugin, editor.view, keydown),
    );
    expect(handled).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe("Second cell");
    const found: Record<string, unknown>[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "orderedList") found.push(node.attrs);
      return true;
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.startLevel ?? 0).toBe(0);
  });

  // protects=lists side by side at different levels stay two lists, whatever is done beside them, until an edit (Backspace, Delete) joins them; fails_when=they join by themselves; no_claim=paste, which keeps the list pasted into.
  test("lists at different levels side by side stay apart", () => {
    const editor = editorWith([
      ordered({ numbering: "clauses", startLevel: 1 }, item("A")),
      ordered({ numbering: "clauses", startLevel: 0 }, item("B")),
    ]);
    caretIn(editor, "B", { end: true });
    typeText(editor, " and more");
    expect(lists(editor)).toEqual([
      { numbering: "clauses", startLevel: 1, items: 1 },
      { numbering: "clauses", startLevel: 0, items: 1 },
    ]);
  });

  // protects=Enter on an empty item, or Backspace at its start, steps out one level in a list that starts deeper, and ends the list only at the first level; fails_when=the item leaves the list from a deeper level; no_claim=nested lists, whose step out is Tiptap's.
  test.each(["Enter", "Backspace"])("%s on an empty item steps out one level", (key) => {
    const editor = editorWith([
      ordered({ numbering: "clauses", startLevel: 1 }, item("A"), item("")),
    ]);
    caretAt(editor, editor.state.doc.content.size - 3);
    // Only what the editor's keymap reads: the tests run without a DOM.
    const keydown = {
      key,
      keyCode: key === "Enter" ? 13 : 8,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    } as unknown as KeyboardEvent;
    const press = () =>
      editor.state.plugins.some((plugin) =>
        plugin.props.handleKeyDown?.call(plugin, editor.view, keydown),
      );
    press();
    expect(lists(editor)).toEqual([
      { numbering: "clauses", startLevel: 1, items: 1 },
      { numbering: "clauses", startLevel: 0, items: 1 },
    ]);
    expect(markers(editor)).toEqual(["(i)", "(a)"]);
    press();
    expect(lists(editor)).toEqual([{ numbering: "clauses", startLevel: 1, items: 1 }]);
  });

  // protects=two lists joined by Backspace at the start of the second, or Delete at the end of the first, become one list with the first's start level; fails_when=the joined list loses the first's level, or its items keep two; no_claim=pasting a list into a list, which keeps the list pasted into, as ProseMirror does.
  test.each([
    [
      "Backspace",
      (editor: Editor) => caretIn(editor, "B"),
      (editor: Editor) => editor.commands.joinBackward(),
    ],
    [
      "Delete",
      (editor: Editor) => caretIn(editor, "A", { end: true }),
      (editor: Editor) => editor.commands.joinForward(),
    ],
  ])("lists joined by %s take the first's start level", (_, place, join) => {
    const editor = editorWith([
      ordered({ numbering: "clauses", startLevel: 1 }, item("A")),
      ordered({ numbering: "clauses", startLevel: 0 }, item("B")),
    ]);
    place(editor);
    join(editor);
    expect(lists(editor)).toEqual([{ numbering: "clauses", startLevel: 1, items: 2 }]);
    expect(markers(editor)).toEqual(["(i)", "(ii)"]);
  });
});

describe("A Mind saved before numbering schemes", () => {
  const element = (name: string, children: (Y.XmlElement | string)[], start?: string) => {
    const node = new Y.XmlElement(name);
    if (start) node.setAttribute("start", start);
    node.insert(
      0,
      children.map((child) => (typeof child === "string" ? new Y.XmlText(child) : child)),
    );
    return node;
  };
  const oldItem = (text: string, ...nested: Y.XmlElement[]) =>
    element("listItem", [element("paragraph", [text]), ...nested]);

  // protects=a Mind saved before schemes, its numbered lists with no scheme, start level or continuation, reads as "1. a." from the first level and starts each list again, and opening it writes nothing back: no migration; fails_when=its markers or levels change, or opening it changes the Mind; no_claim=none beyond protects.
  test("keeps its look, and opening it changes nothing", async () => {
    const client = await boundToNewMind();
    client.doc.transact(() => {
      client.blocks.delete(0, client.blocks.length);
      client.blocks.insert(0, [
        element(
          "orderedList",
          [oldItem("One", element("orderedList", [oldItem("Two")], "1"))],
          "1",
        ),
        element("paragraph", ["Between"]),
        element("orderedList", [oldItem("Again")], "1"),
      ]);
    });
    await client.settled();
    const saved = Y.encodeStateVector(client.doc);

    const editor = boundEditor(client);
    expect(markers(editor)).toEqual(["1.", "a.", "1."]);
    expect(lists(editor)).toEqual([
      { numbering: null, startLevel: 0, items: 1 },
      { numbering: null, startLevel: 0, items: 1 },
    ]);
    expect(Y.encodeStateVector(client.doc)).toEqual(saved);
  });
});
