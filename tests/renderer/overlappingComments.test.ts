import { Editor } from "@tiptap/core";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { COMMENT_MARK } from "../../src/core/api";
import { commentRuns } from "../../src/renderer/src/editor/commentSchema";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

/*
 * Words can be in several comments, as in a Word file (#2585): each comment's runs cover its own
 * words, and the Note reads back from its Yjs text with every comment.
 */

const on = (...ids: string[]) => ids.map((id) => ({ type: COMMENT_MARK, attrs: { id } }));

function crossing(): Editor {
  const editor = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [
            { type: "text", text: "Revenue grew ", marks: on("dana") },
            { type: "text", text: "12% in May", marks: on("dana", "luis") },
            { type: "text", text: " and June.", marks: on("luis") },
          ],
        },
      ],
    },
  });
  onTestFinished(() => editor.destroy());
  return editor;
}

const wordsOf = (editor: Editor) =>
  commentRuns(editor.state.doc).map((run) => [
    run.id,
    editor.state.doc.textBetween(run.from, run.to),
  ]);

test("each comment's run covers its own words, and the Note reads back from Yjs with both", () => {
  const editor = crossing();
  editor.state.doc.check();
  expect(wordsOf(editor)).toEqual([
    ["dana", "Revenue grew 12% in May"],
    ["luis", "12% in May and June."],
  ]);

  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const fragment = doc.getXmlFragment("prosemirror");
  prosemirrorToYXmlFragment(editor.state.doc, fragment);
  const again = yXmlFragmentToProseMirrorRootNode(fragment, editor.schema);
  again.check();
  expect(again.eq(editor.state.doc)).toBe(true);
});
