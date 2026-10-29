import type { Editor } from "@tiptap/core";
import { COMPARISON_TABLE_NODE } from "../../../core/api";

/** Where a comparison table is in the editor, by its id; null when it isn't there. */
export function comparisonTableAt(editor: Editor, tableId: string): number | null {
  let found: number | null = null;
  editor.state.doc.forEach((block, offset) => {
    if (block.type.name === COMPARISON_TABLE_NODE && block.attrs.id === tableId) found = offset;
  });
  return found;
}
