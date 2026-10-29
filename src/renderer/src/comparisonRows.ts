/**
 * A comparison table's rows (#1837): Documents added to a table that exists,
 * a row removed or moved, and its Document opened beside the table. The core
 * is the one writer of a table's structure, so every change asks it on the
 * same queue as a fill, and the window's one history takes it back through
 * the core.
 */
import { clientId } from "./clientId";
import { type ComparisonTableHandle, structure } from "./comparisonStructure";
import { fillComparisonTable } from "./comparisons";
import { useComparisonTables } from "./comparisonTableState";
import { core } from "./core";
import { comparisonRowHere, comparisonRowStep } from "./editor/comparisonRowCommands";
import {
  offerStructureUndo,
  releaseStructureStep,
  reserveStructureStep,
} from "./editor/comparisonStructureUndo";
import { openDocumentBeside } from "./verify";

/** The Documents are added as rows at the end; only their cells fill. */
export async function addDocuments(
  handle: ComparisonTableHandle,
  documentIds: readonly string[],
): Promise<void> {
  if (documentIds.length === 0) return;
  const seq = reserveStructureStep(handle.editor);
  const added = await structure(handle, () =>
    core.addComparisonRows({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      documentIds,
    }),
  );
  if (!added || added.documentIds.length === 0) {
    releaseStructureStep(handle.editor);
    return;
  }
  offerStructureUndo(
    handle.editor,
    {
      mindId: handle.mindId,
      tableId: handle.tableId,
      step: added.step,
      said: (t) =>
        t(
          added.documentIds.length === 1
            ? "comparison.table.added.one"
            : "comparison.table.added.other",
          { count: added.documentIds.length },
        ),
    },
    seq,
  );
  if (added.fill) {
    void fillComparisonTable({
      mindId: handle.mindId,
      tableId: handle.tableId,
      documentIds: added.documentIds,
    });
  }
  useComparisonTables.getState().focusRow(handle.tableId, added.documentIds[0] ?? null);
}

/** A row taken out whole; Undo brings it back with its Answers. */
export async function removeRow(handle: ComparisonTableHandle, documentId: string): Promise<void> {
  const seq = reserveStructureStep(handle.editor);
  const removed = await structure(handle, () =>
    core.removeComparisonRow({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      documentId,
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
      said: (t) => t("comparison.row.removedRow", { name: removed.label }),
    },
    seq,
  );
  useComparisonTables.getState().focusRow(handle.tableId, removed.focusDocumentId);
}

/** A row moved to a place among the rows, its cells with it. */
export async function moveRow(
  handle: ComparisonTableHandle,
  documentId: string,
  to: number,
): Promise<void> {
  const here = comparisonRowHere(handle.editor, handle.tableId, documentId);
  if (!here || here.index === to) return;
  const seq = reserveStructureStep(handle.editor);
  const moved = await structure(handle, () =>
    core.moveComparisonRow({
      mindId: handle.mindId,
      clientId,
      tableId: handle.tableId,
      documentId,
      to,
    }),
  );
  if (!moved?.moved) {
    releaseStructureStep(handle.editor);
    useComparisonTables.getState().focusRow(handle.tableId, documentId);
    return;
  }
  offerStructureUndo(
    handle.editor,
    {
      mindId: handle.mindId,
      tableId: handle.tableId,
      step: moved.step,
      said: (t) => t("comparison.row.moved", { name: here.label }),
    },
    seq,
  );
  useComparisonTables.getState().focusRow(handle.tableId, documentId);
}

/** A row moved one place up or down. */
export async function stepRow(
  handle: ComparisonTableHandle,
  documentId: string,
  direction: -1 | 1,
): Promise<void> {
  const to = comparisonRowStep(handle.editor, handle.tableId, documentId, direction);
  if (to === null) return;
  await moveRow(handle, documentId, to);
}

/** A row's Document beside the table, at its start. */
export function openRowDocument(documentId: string): void {
  openDocumentBeside(documentId);
}
