/**
 * A comparison table's columns (#1833): the field open in a heading to edit a
 * column or insert one beside it, and the four commands that change a table,
 * each one change of the note, with its undo line and the fill that follows.
 */
import { comparisonLabelOf, MAX_COMPARISON_QUESTIONS } from "../../shared/comparisons";
import { type ComparisonColumnHandle, useComparisonColumns } from "./comparisonColumnState";
import { fillComparisonTable } from "./comparisons";
import {
  duplicateComparisonColumn,
  editComparisonColumn,
  insertComparisonColumnBeside,
  questionLine,
  removeComparisonColumn,
} from "./editor/comparisonColumnCommands";
import { offerEditorUndo } from "./editor/editorUndo";

export type { ComparisonColumnField, ComparisonColumnHandle } from "./comparisonColumnState";
export { comparisonColumnHandles, useComparisonColumns } from "./comparisonColumnState";

const fill = (handle: ComparisonColumnHandle, questionIds: readonly string[]) =>
  void fillComparisonTable({
    mindId: handle.mindId,
    tableId: handle.tableId,
    questionIds,
  });

/** The heading opens the label and Question in place. */
export function startColumnEdit(handle: ComparisonColumnHandle, questionId: string): void {
  useComparisonColumns.getState().openField({
    mode: "edit",
    tableId: handle.tableId,
    questionId,
    side: "right",
  });
}

/** The heading asks for the new column's Question in place, before it exists. */
export function startColumnInsert(
  handle: ComparisonColumnHandle,
  questionId: string,
  side: "left" | "right",
): void {
  useComparisonColumns
    .getState()
    .openField({ mode: "insert", tableId: handle.tableId, questionId, side });
}

export function closeColumnField(): void {
  useComparisonColumns.getState().closeField();
}

/** Saves a column's label and Question: a new Question refills that column alone. */
export function saveColumnEdit(
  handle: ComparisonColumnHandle,
  questionId: string,
  { text, label }: { text: string; label: string },
): void {
  const done = editComparisonColumn(handle.editor, handle.tableId, questionId, { text, label });
  closeColumnField();
  if (!done?.changed) {
    // Saved nothing, or nothing changed: the field closes and the heading takes the focus back.
    useComparisonColumns.getState().focusColumn(handle.tableId, questionId);
    return;
  }
  offerEditorUndo(handle.editor, (t) => t("comparison.column.edited", { label: done.label }));
  useComparisonColumns.getState().focusColumn(handle.tableId, done.questionId);
  if (done.refilled) fill(handle, [done.questionId]);
}

/** Saves the column an insert asked for, beside the one it was opened on. */
export function saveColumnInsert(
  handle: ComparisonColumnHandle,
  questionId: string,
  side: "left" | "right",
  text: string,
): void {
  const id = insertComparisonColumnBeside(handle.editor, handle.tableId, questionId, side, text);
  closeColumnField();
  if (!id) {
    // No column was added: the heading the field was opened on takes the focus back.
    useComparisonColumns.getState().focusColumn(handle.tableId, questionId);
    return;
  }
  const label = comparisonLabelOf({ text: questionLine(text) });
  offerEditorUndo(handle.editor, (t) => t("comparison.column.inserted", { label }));
  useComparisonColumns.getState().focusColumn(handle.tableId, id);
  fill(handle, [id]);
}

/** A column copied beside itself: its Answers come along, so no model is asked for them again. */
export function duplicateColumn(handle: ComparisonColumnHandle, questionId: string): void {
  const done = duplicateComparisonColumn(handle.editor, handle.tableId, questionId);
  if (!done) return;
  offerEditorUndo(handle.editor, (t) => t("comparison.column.duplicated", { label: done.label }));
  useComparisonColumns.getState().focusColumn(handle.tableId, done.questionId);
  if (done.fill) fill(handle, [done.questionId]);
}

/** Removes a column whole; the last column can't be removed, so it isn't offered. */
export function removeColumn(handle: ComparisonColumnHandle, questionId: string): void {
  const done = removeComparisonColumn(handle.editor, handle.tableId, questionId);
  if (!done) return;
  offerEditorUndo(handle.editor, (t) => t("comparison.column.removed", { label: done.label }));
  useComparisonColumns.getState().focusColumn(handle.tableId, done.focusId);
}

export const canInsertColumn = (count: number): boolean => count < MAX_COMPARISON_QUESTIONS;
