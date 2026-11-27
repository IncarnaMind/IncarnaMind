import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import { stubEditorDom } from "../helpers/editorDom";

/*
 * Enter beside a Word file's unseen markers in a clause (#746): the start of a bookmark a
 * cross-reference names stays with the clause's words, wherever the click at their start put the
 * cursor, as Word keeps it, and a marker an arrow selected isn't deleted by Enter.
 */

vi.mock("../../src/renderer/src/core", () => ({
  core: { on: () => () => undefined },
}));

stubEditorDom();
const { Editor } = await import("@tiptap/core");
const { NodeSelection, TextSelection } = await import("@tiptap/pm/state");
const { WORD_ATOM_NODE } = await import("../../src/core/api");
const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");
const { WordMarkerKeys } = await import("../../src/renderer/src/editor/wordMarkerKeys");
const { pressEnter } = await import("../helpers/editor");

const START = "w:bookmarkStart#0";
const END = "w:bookmarkEnd#0";

const marker = (source: string): JSONContent => ({
  type: WORD_ATOM_NODE,
  attrs: { kind: "bookmark", label: "", text: "", source },
});

const item = (content: JSONContent[]): JSONContent => ({
  type: "listItem",
  content: [{ type: "paragraph", content }],
});

/** Two clauses of a numbered list, the second bookmarked from its first word to its last. */
function contract(clause: string) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...noteExtensions(), WordMarkerKeys],
    content: {
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            item([{ type: "text", text: "Scope." }]),
            item([marker(START), { type: "text", text: clause }, marker(END)]),
          ],
        },
      ],
    },
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  let start = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === clause) start = pos + 1;
  });
  return { editor, start };
}

/** Each paragraph: its words, and each marker as where it is in the file. */
function lines(editor: InstanceType<typeof Editor>): string[][] {
  const found: string[][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "paragraph") return;
    const parts: string[] = [];
    node.forEach((child) => {
      parts.push(child.isText ? (child.text ?? "") : String(child.attrs.source));
    });
    found.push(parts);
  });
  return found;
}

const CLAUSES = [
  "Confidential Information means all information disclosed.",
  "保密信息指一方披露的全部信息。",
];

describe("Enter beside a bookmark in a Word file's clause", () => {
  // protects=Enter with the cursor where a click at a clause's first word puts it, after the unseen start of its bookmark, makes the new line before the clause and leaves the bookmark's start with the clause's words, so a cross-reference to it still names the clause, in English and Chinese; fails_when=the bookmark's start stays on the new empty line; no_claim=what the export writes, which tests/core/wordFields.test.ts holds.
  test.each(CLAUSES)("at its start, the new line comes before the whole clause: %s", (clause) => {
    const { editor, start } = contract(clause);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start + 1)),
    );
    pressEnter(editor);
    expect(lines(editor)).toEqual([["Scope."], [], [START, clause, END]]);
    // The cursor stays in front of the clause's words, where the click put it.
    const { $head } = editor.state.selection;
    expect([$head.parent.textContent, $head.parentOffset]).toEqual([clause, 1]);
    editor.destroy();
  });

  // protects=Enter at a clause's last word, before the unseen end of its bookmark, makes the new line after the clause with the bookmark's end left on the clause; fails_when=the bookmark's end goes to the new line; no_claim=a bookmark over several paragraphs.
  test("at its end, the new line comes after the whole clause", () => {
    const clause = CLAUSES[0] as string;
    const { editor, start } = contract(clause);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, start + 1 + clause.length),
      ),
    );
    pressEnter(editor);
    expect(lines(editor)).toEqual([["Scope."], [START, clause, END], []]);
    editor.destroy();
  });

  // protects=a bookmark's start an arrow selected isn't deleted by Enter: the clause moves down with it; fails_when=Enter replaces the selected marker; no_claim=typing over a selected marker.
  test("on a selected start of a bookmark, Enter keeps it", () => {
    const clause = CLAUSES[0] as string;
    const { editor, start } = contract(clause);
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, start)),
    );
    pressEnter(editor);
    expect(lines(editor)).toEqual([["Scope."], [], [START, clause, END]]);
    editor.destroy();
  });

  // protects=Enter between a clause's words splits there as anywhere else, the bookmark's start on the first part and its end on the second; fails_when=the split moves to the clause's start or end; no_claim=which part a cross-reference then names.
  test("between its words, Enter splits where the cursor is", () => {
    const clause = CLAUSES[0] as string;
    const { editor, start } = contract(clause);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start + 1 + 12)),
    );
    pressEnter(editor);
    expect(lines(editor)).toEqual([
      ["Scope."],
      [START, "Confidential"],
      [" Information means all information disclosed.", END],
    ]);
    editor.destroy();
  });
});
