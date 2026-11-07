import type { ComparisonCellRef, ComparisonFillMode } from "../../core/api";
import { comparisonCellOf, comparisonRefillable } from "../../shared/comparisons";
import {
  comparisonCellChecked,
  comparisonCellContent,
  comparisonCellTarget,
  signOffsOf,
} from "../../shared/signOffs";
import type { ComparisonHandle } from "./comparisonColumnState";
import { fillComparisonTable, stopComparisonTable } from "./comparisons";
import { comparisonCellInRow, comparisonTableIn } from "./editor/comparisonCommands";
import {
  prepareComparisonRefill,
  restoreComparisonRefill,
  snapshotComparisonRefill,
} from "./editor/comparisonFillCommands";
import { offerEditorUndo } from "./editor/editorUndo";
import { liveVersions, noteDocOf } from "./editor/signOffActions";
import { useNotices } from "./notices";

export type ComparisonRefillStart =
  | { started: true; pass: string }
  | { started: false; reason: "nothing-to-fill" | "not-found" };

export type ComparisonRefillScope = "row" | "column";

/** A cell of the table as it is now, with whether the User's own mark stands on it. */
type CellState = ReturnType<typeof comparisonCellOf>;

function statesOf(
  handle: ComparisonHandle,
  requested: readonly ComparisonCellRef[],
): Map<ComparisonCellRef, CellState> {
  const found = comparisonTableIn(handle.editor, handle.tableId);
  const states = new Map<ComparisonCellRef, CellState>();
  if (!found) return states;
  const doc = noteDocOf(handle.editor);
  const signOffs = doc ? signOffsOf(doc) : [];
  const versions = liveVersions();
  for (const target of requested) {
    found.table.forEach((row) => {
      if (row.attrs.documentId !== target.documentId) return;
      const at = comparisonCellInRow(row, target.questionId);
      if (!at) return;
      const cell = row.child(at.index);
      states.set(target, {
        ...comparisonCellOf(cell.attrs),
        reviewed: comparisonCellChecked(
          signOffs,
          comparisonCellTarget(handle.tableId, target.documentId, target.questionId),
          comparisonCellContent(cell.toJSON()),
          versions,
        ),
      });
    });
  }
  return states;
}

/** The cells the User wrote or checked themselves: a whole-table fill leaves them unless asked. */
export function ownComparisonCells(
  handle: ComparisonHandle,
  requested: readonly ComparisonCellRef[],
): ComparisonCellRef[] {
  const states = statesOf(handle, requested);
  return requested.filter((target) => {
    const state = states.get(target);
    return state !== undefined && (state.edited === true || state.reviewed === true);
  });
}

export function refillableComparisonCells(
  handle: ComparisonHandle,
  mode: ComparisonFillMode,
  requested: readonly ComparisonCellRef[],
  scope?: ComparisonRefillScope,
): ComparisonCellRef[] {
  const unique = requested.filter(
    (target, index) =>
      requested.findIndex(
        (other) => other.documentId === target.documentId && other.questionId === target.questionId,
      ) === index,
  );
  const states = statesOf(handle, unique);
  const candidates = unique.filter((target) => {
    const state = states.get(target);
    return state !== undefined && comparisonRefillable(state, mode, true);
  });
  return candidates.filter((target) => {
    const state = states.get(target);
    return (
      state !== undefined &&
      comparisonRefillable(state, mode, scope === undefined && unique.length === 1)
    );
  });
}

/** Starts one scoped refill, after replacing only its eligible cells with a new pass identity. */
export function refillComparison(
  handle: ComparisonHandle,
  mode: ComparisonFillMode,
  requested: readonly ComparisonCellRef[],
  scope?: ComparisonRefillScope,
): ComparisonRefillStart {
  if (!handle.editor.isEditable) return { started: false, reason: "not-found" };
  const cells = refillableComparisonCells(handle, mode, requested, scope);
  if (cells.length === 0) {
    useNotices.getState().confirm("comparison.nothingToFill");
    return { started: false, reason: requested.length === 0 ? "not-found" : "nothing-to-fill" };
  }
  const before = snapshotComparisonRefill(handle.editor, handle.tableId, cells);
  const pass = crypto.randomUUID();
  if (!prepareComparisonRefill(handle.editor, handle.tableId, cells, pass)) {
    return { started: false, reason: "not-found" };
  }
  offerEditorUndo(
    handle.editor,
    (t) =>
      t(cells.length === 1 ? "comparison.refill.one" : "comparison.refill.other", {
        count: cells.length,
      }),
    undefined,
    () => {
      void stopComparisonTable({ mindId: handle.mindId, tableId: handle.tableId, pass });
      restoreComparisonRefill(handle.editor, handle.tableId, before);
    },
  );
  const targets =
    scope === "row"
      ? { documentIds: [...new Set(cells.map((cell) => cell.documentId))] }
      : scope === "column"
        ? { questionIds: [...new Set(cells.map((cell) => cell.questionId))] }
        : { cells };
  void fillComparisonTable({
    mindId: handle.mindId,
    tableId: handle.tableId,
    ...targets,
    mode,
    pass,
  });
  return { started: true, pass };
}
