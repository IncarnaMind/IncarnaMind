import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { ComparisonCellRef } from "../../../core/api";
import { comparisonCellInRow, comparisonTableIn } from "./comparisonCommands";
import { asOneStep, undoStackOf } from "./editorUndo";

interface LocatedCell extends ComparisonCellRef {
  pos: number;
  cell: ProseMirrorNode;
}

export interface ComparisonRefillSnapshot extends ComparisonCellRef {
  cell: JSONContent;
}

function locateCells(
  editor: Editor,
  tableId: string,
  cells: readonly ComparisonCellRef[],
): LocatedCell[] | null {
  const found = comparisonTableIn(editor, tableId);
  if (!found) return null;
  const located: LocatedCell[] = [];
  for (const target of cells) {
    let rowAt = -1;
    found.table.forEach((row, _offset, index) => {
      if (row.attrs.documentId === target.documentId) rowAt = index;
    });
    if (rowAt < 0) return null;
    const row = found.table.child(rowAt);
    const rowPos = found.rows[rowAt];
    const at = comparisonCellInRow(row, target.questionId);
    if (rowPos === undefined || !at) return null;
    located.push({ ...target, pos: rowPos + 1 + at.offset, cell: row.child(at.index) });
  }
  return located;
}

/** Marks the cells a refill may write with a new pass id, as one Undo step. */
export function prepareComparisonRefill(
  editor: Editor,
  tableId: string,
  cells: readonly ComparisonCellRef[],
  pass: string,
): boolean {
  const located = locateCells(editor, tableId, cells);
  if (!located || located.length === 0) return false;
  const tr = editor.state.tr;
  for (const { pos } of located) tr.setNodeAttribute(pos, "fillId", pass);
  asOneStep(editor, () => editor.view.dispatch(tr));
  return true;
}

export function snapshotComparisonRefill(
  editor: Editor,
  tableId: string,
  cells: readonly ComparisonCellRef[],
): readonly ComparisonRefillSnapshot[] {
  return (locateCells(editor, tableId, cells) ?? []).map(({ cell, ...target }) => ({
    ...target,
    cell: cell.toJSON(),
  }));
}

/** Restores the pre-refill cells outside the note's history, after its prepare step was undone. */
export function restoreComparisonRefill(
  editor: Editor,
  tableId: string,
  snapshots: readonly ComparisonRefillSnapshot[],
): void {
  const located = locateCells(
    editor,
    tableId,
    snapshots.map(({ documentId, questionId }) => ({ documentId, questionId })),
  );
  if (!located) return;
  const tr = editor.state.tr;
  const changes = located.map((current, index) => ({ current, snapshot: snapshots[index] }));
  changes.sort((a, b) => b.current.pos - a.current.pos);
  for (const { current, snapshot } of changes) {
    if (!snapshot) continue;
    for (const name of Object.keys(current.cell.attrs))
      tr.setNodeAttribute(current.pos, name, null);
    for (const [name, value] of Object.entries(snapshot.cell.attrs ?? {})) {
      tr.setNodeAttribute(current.pos, name, value);
    }
    const content = editor.state.schema.nodeFromJSON({
      type: "doc",
      content: snapshot.cell.content ?? [],
    }).content;
    tr.replaceWith(current.pos + 1, current.pos + current.cell.nodeSize - 1, content);
  }
  const stack = undoStackOf(editor);
  const before = stack?.undoStack.length ?? 0;
  editor.view.dispatch(tr);
  if (stack && stack.undoStack.length > before) stack.undoStack.splice(before);
}
