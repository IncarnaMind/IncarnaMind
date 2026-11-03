/**
 * A comparison table's columns (#1833): the field open in a heading to edit a
 * column or insert one beside it, and the commands that change a table. The
 * core is the one writer of a table's structure, so every command asks it,
 * and one undo stack in the window takes them back and does them again
 * through the core; the fill each one asks for follows.
 */
import { MAX_COMPARISON_QUESTIONS } from "../../shared/comparisons";
import { clientId } from "./clientId";
import {
  type ComparisonColumnHandle,
  staleAnswerKey,
  useComparisonColumns,
} from "./comparisonColumnState";
import { structure } from "./comparisonStructure";
import { fillComparisonTable } from "./comparisons";
import { core } from "./core";
import {
  comparisonColumnHere,
  comparisonColumnStep,
  lastComparisonColumn,
} from "./editor/comparisonColumnCommands";
import {
  offerStructureUndo,
  releaseStructureStep,
  reserveStructureStep,
  type StructureChange,
} from "./editor/comparisonStructureUndo";

export type { ComparisonColumnField, ComparisonColumnHandle } from "./comparisonColumnState";
export { comparisonColumnHandles, useComparisonColumns } from "./comparisonColumnState";

const focus = (handle: ComparisonColumnHandle, questionId: string | null) =>
  useComparisonColumns.getState().focusColumn(handle.tableId, questionId);

const fill = (handle: ComparisonColumnHandle, questionIds: readonly string[]) =>
  void fillComparisonTable({
    mindId: handle.mindId,
    tableId: handle.tableId,
    questionIds,
  });

function answersOf(
  handle: ComparisonColumnHandle,
  questionId: string,
): { documentId: string; words: string }[] {
  const answers: { documentId: string; words: string }[] = [];
  const table = handle.editor.state.doc;
  table.descendants((node) => {
    if (node.type.name !== "comparisonRow") return true;
    node.forEach((cell) => {
      if (cell.type.name !== "comparisonCell") return;
      if (cell.attrs.questionId !== questionId) return;
      const words = cell.textBetween(0, cell.content.size, "\n", " ").trim();
      if (words) answers.push({ documentId: String(node.attrs.documentId ?? ""), words });
    });
    return false;
  });
  return answers;
}

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
export async function saveColumnEdit(
  handle: ComparisonColumnHandle,
  questionId: string,
  { text, label }: { text: string; label: string },
): Promise<void> {
  const answers = answersOf(handle, questionId);
  closeColumnField();
  const seq = reserveStructureStep(handle.editor);
  const edited = await structure(handle, () =>
    core.editComparisonColumn({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      questionId,
      text,
      label,
    }),
  );
  if (!edited?.changed) {
    // Saved nothing, or nothing changed: the field closes and the heading takes the focus back.
    releaseStructureStep(handle.editor);
    focus(handle, questionId);
    return;
  }
  if (edited.refilled) {
    for (const answer of answers) {
      useComparisonColumns
        .getState()
        .rememberStale(
          staleAnswerKey(handle.tableId, answer.documentId, edited.questionId),
          answer.words,
        );
    }
  }
  offerStructureUndo(
    handle.editor,
    {
      mindId: handle.mindId,
      tableId: handle.tableId,
      step: edited.step,
      said: (t) => t("comparison.column.edited", { label: edited.label }),
    } satisfies StructureChange,
    seq,
  );
  focus(handle, edited.questionId);
  if (edited.refilled) fill(handle, [edited.questionId]);
}

/** "+ Question": a column after the table's last one, with a waiting cell in every row. */
export async function addColumn(handle: ComparisonColumnHandle, text: string): Promise<void> {
  const last = lastComparisonColumn(handle.editor, handle.tableId);
  if (!last) return;
  const seq = reserveStructureStep(handle.editor);
  const added = await structure(handle, () =>
    core.insertComparisonColumn({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      questionId: last,
      side: "right",
      text,
    }),
  );
  if (!added) {
    releaseStructureStep(handle.editor);
    return;
  }
  offerStructureUndo(
    handle.editor,
    {
      mindId: handle.mindId,
      tableId: handle.tableId,
      step: added.step,
      said: (t) => t("comparison.column.inserted", { label: added.label }),
    } satisfies StructureChange,
    seq,
  );
  focus(handle, added.questionId);
  if (added.fill) fill(handle, [added.questionId]);
}

/** Saves the column an insert asked for, beside the one it was opened on. */
export async function saveColumnInsert(
  handle: ComparisonColumnHandle,
  questionId: string,
  side: "left" | "right",
  text: string,
): Promise<void> {
  closeColumnField();
  const seq = reserveStructureStep(handle.editor);
  const added = await structure(handle, () =>
    core.insertComparisonColumn({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      questionId,
      side,
      text,
    }),
  );
  if (!added) {
    // No column was added: the heading the field was opened on takes the focus back.
    releaseStructureStep(handle.editor);
    focus(handle, questionId);
    return;
  }
  offerStructureUndo(
    handle.editor,
    {
      mindId: handle.mindId,
      tableId: handle.tableId,
      step: added.step,
      said: (t) => t("comparison.column.inserted", { label: added.label }),
    } satisfies StructureChange,
    seq,
  );
  focus(handle, added.questionId);
  if (added.fill) fill(handle, [added.questionId]);
}

/** A column copied beside itself: its Answers come along, so no model is asked for them again. */
export async function duplicateColumn(
  handle: ComparisonColumnHandle,
  questionId: string,
): Promise<void> {
  const seq = reserveStructureStep(handle.editor);
  const added = await structure(handle, () =>
    core.duplicateComparisonColumn({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      questionId,
    }),
  );
  if (!added) {
    releaseStructureStep(handle.editor);
    return;
  }
  offerStructureUndo(
    handle.editor,
    {
      mindId: handle.mindId,
      tableId: handle.tableId,
      step: added.step,
      said: (t) => t("comparison.column.duplicated", { label: added.label }),
    } satisfies StructureChange,
    seq,
  );
  focus(handle, added.questionId);
  if (added.fill) fill(handle, [added.questionId]);
}

/** Removes a column whole; the last column can't be removed, so it isn't offered. */
export async function removeColumn(
  handle: ComparisonColumnHandle,
  questionId: string,
): Promise<void> {
  const seq = reserveStructureStep(handle.editor);
  const removed = await structure(handle, () =>
    core.removeComparisonColumn({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      questionId,
    }),
  );
  if (!removed) {
    releaseStructureStep(handle.editor);
    return;
  }
  offerStructureUndo(
    handle.editor,
    {
      mindId: handle.mindId,
      tableId: handle.tableId,
      step: removed.step,
      questionId,
      said: (t) => t("comparison.column.removed", { label: removed.label }),
    } satisfies StructureChange,
    seq,
  );
  focus(handle, removed.focusId);
}

/**
 * A column moved to `to`, its Answers with it. The core writes the Questions'
 * order and every row's cells in one change; Undo and Redo ask the core to
 * move it back or forward.
 */
export async function moveColumn(
  handle: ComparisonColumnHandle,
  questionId: string,
  to: number,
): Promise<void> {
  const here = comparisonColumnHere(handle.editor, handle.tableId, questionId);
  if (!here || here.index === to) return;
  const seq = reserveStructureStep(handle.editor);
  const moved = await structure(handle, () =>
    core.moveComparisonColumn({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      questionId,
      to,
    }),
  );
  if (!moved?.moved) {
    releaseStructureStep(handle.editor);
    focus(handle, questionId);
    return;
  }
  offerStructureUndo(
    handle.editor,
    {
      mindId: handle.mindId,
      tableId: handle.tableId,
      step: moved.step,
      questionId,
      said: (t) => t("comparison.column.moved", { label: here.label }),
    } satisfies StructureChange,
    seq,
  );
  focus(handle, questionId);
}

/** A column moved one visible column left or right, past hidden ones. */
export async function stepColumn(
  handle: ComparisonColumnHandle,
  questionId: string,
  direction: -1 | 1,
): Promise<void> {
  const to = comparisonColumnStep(handle.editor, handle.tableId, questionId, direction);
  if (to === null) return;
  await moveColumn(handle, questionId, to);
}

/** A column made wider or narrower; dragging says it once, when the pointer lets go. */
export async function resizeColumn(
  handle: ComparisonColumnHandle,
  questionId: string,
  width: number,
): Promise<void> {
  const seq = reserveStructureStep(handle.editor);
  const resized = await structure(handle, () =>
    core.resizeComparisonColumn({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      questionId,
      width,
    }),
  );
  if (!resized) {
    releaseStructureStep(handle.editor);
    return;
  }
  offerStructureUndo(
    handle.editor,
    {
      mindId: handle.mindId,
      tableId: handle.tableId,
      step: resized.step,
      questionId,
      said: (t) => t("comparison.column.resized", { label: resized.label }),
    } satisfies StructureChange,
    seq,
  );
}

/** A column hidden from the table, its cells and Answers kept with the Note. */
export async function hideColumn(
  handle: ComparisonColumnHandle,
  questionId: string,
): Promise<void> {
  const seq = reserveStructureStep(handle.editor);
  const hidden = await structure(handle, () =>
    core.setComparisonColumnHidden({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      questionId,
      hidden: true,
    }),
  );
  if (!hidden) {
    releaseStructureStep(handle.editor);
    return;
  }
  offerStructureUndo(
    handle.editor,
    {
      mindId: handle.mindId,
      tableId: handle.tableId,
      step: hidden.step,
      questionId,
      said: (t) => t("comparison.column.hid", { label: hidden.label }),
    } satisfies StructureChange,
    seq,
  );
  if (hidden.focusId) {
    focus(handle, hidden.focusId);
    return;
  }
  // Nothing is left to take the focus: the table's hidden-columns button shows what went.
  if (typeof requestAnimationFrame !== "function" || typeof document === "undefined") return;
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(
        `.comparison-table[data-comparison-table="${CSS.escape(handle.tableId)}"] [data-testid="comparison-table-menu"]`,
      )
      ?.focus(),
  );
}

/** A hidden column shown again, in its own place. */
export async function showColumn(
  handle: ComparisonColumnHandle,
  questionId: string,
): Promise<void> {
  const seq = reserveStructureStep(handle.editor);
  const shown = await structure(handle, () =>
    core.setComparisonColumnHidden({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      questionId,
      hidden: false,
    }),
  );
  if (!shown) {
    releaseStructureStep(handle.editor);
    return;
  }
  offerStructureUndo(
    handle.editor,
    {
      mindId: handle.mindId,
      tableId: handle.tableId,
      step: shown.step,
      questionId,
      said: (t) => t("comparison.column.shown", { label: shown.label }),
    } satisfies StructureChange,
    seq,
  );
  focus(handle, shown.focusId);
}

export const canInsertColumn = (count: number): boolean => count < MAX_COMPARISON_QUESTIONS;
