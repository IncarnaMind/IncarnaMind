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

/** The name as one line, its space trimmed; empty takes the name off, back to "Comparison table". */
export function comparisonTitleTyped(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_COMPARISON_TITLE);
}

/** Saves the table's name as the User typed it, as one step of the note's Undo. */
export function changeComparisonTitle(editor: Editor, tableId: string, value: string): void {
  if (!editor.isEditable) return;
  const pos = comparisonTableAt(editor, tableId);
  if (pos === null) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const title = comparisonTitleTyped(value);
  if (title === comparisonTitleOf(node.attrs)) return;
  const changed = asOneStep(editor, () => {
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, title: title || null }),
    );
    return true;
  });
  if (!changed) return;
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
