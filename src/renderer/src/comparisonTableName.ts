/**
 * A comparison table's own name (#1837): typed in place on its title line,
 * kept with the Note, and naming the Excel file and sheet an export writes.
 * The name is one change of the Note, so its Undo is the note's own.
 */
import type { Editor } from "@tiptap/core";
import { comparisonTitleOf, MAX_COMPARISON_TITLE } from "../../shared/comparisons";
import { useComparisonTables } from "./comparisonTableState";
import { comparisonTableAt } from "./editor/comparisonCommands";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";

export function changeComparisonTitle(editor: Editor, tableId: string, value: string): void {
  if (!editor.isEditable) return;
  const pos = comparisonTableAt(editor, tableId);
  if (pos === null) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const title = value.replace(/\s+/g, " ").trim().slice(0, MAX_COMPARISON_TITLE);
  if (title === comparisonTitleOf(node.attrs)) return;
  const changed = asOneStep(editor, () => {
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, title: title || null }),
    );
    return true;
  });
  // A row moving in another window may have had this change dropped by the structure lock.
  const renamed = editor.state.doc.nodeAt(pos);
  if (!changed || !renamed || comparisonTitleOf(renamed.attrs) !== title) return;
  offerEditorUndo(editor, (t) =>
    t("comparison.table.renamed", { name: title || t("comparison.title") }),
  );
}

/** Opens the name field on the table's title line, taking the focus. */
export function startTableRename(tableId: string): void {
  useComparisonTables.getState().startRename(tableId);
}

export function endTableRename(): void {
  useComparisonTables.getState().endRename();
}
