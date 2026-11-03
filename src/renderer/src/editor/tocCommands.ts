import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { TABLE_OF_CONTENTS_NODE } from "../../../core/api";
import { insertBlock } from "./insertBlock";

/**
 * Puts a table of contents after the Block the cursor is in (#1935), or in
 * the empty line it is in, and leaves the cursor after it. The slash menu, ⌘K
 * and the Note's menu reach it.
 */
export function insertTableOfContents(editor: Editor): void {
  const { from } = editor.state.selection;
  const pos = insertBlock(editor, { from, to: from }, { type: TABLE_OF_CONTENTS_NODE });
  if (pos === null) return;
  editor
    .chain()
    .focus()
    .setTextSelection(TextSelection.near(editor.state.doc.resolve(pos + 1), 1).from)
    .run();
}
