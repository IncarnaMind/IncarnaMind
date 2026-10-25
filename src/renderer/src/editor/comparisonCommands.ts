import type { Editor } from "@tiptap/core";
import { COMPARISON_TABLE_NODE } from "../../../core/api";
import { comparisonQuestionsOf } from "../../../shared/comparisons";
import { insertComparisonColumnAt } from "./comparisonColumnCommands";

/** Where a comparison table is in the editor, by its id; null when it isn't there. */
export function comparisonTableAt(editor: Editor, tableId: string): number | null {
  let found: number | null = null;
  editor.state.doc.forEach((block, offset) => {
    if (block.type.name === COMPARISON_TABLE_NODE && block.attrs.id === tableId) found = offset;
  });
  return found;
}

/**
 * "+ Question" (#98): a column for `question` at the table's end, and in each
 * row a cell waiting to be filled, as one change ⌘Z takes back; its id, for
 * the fill of its cells alone. Null when the table is gone or has as many
 * columns as a table holds.
 */
export function addComparisonColumn(
  editor: Editor,
  tableId: string,
  question: string,
): string | null {
  const pos = comparisonTableAt(editor, tableId);
  const table = pos === null ? null : editor.state.doc.nodeAt(pos);
  if (!table) return null;
  const count = comparisonQuestionsOf(table.attrs).length;
  return insertComparisonColumnAt(editor, tableId, count, question);
}
