/**
 * A comparison table's rows and its own state in this window (#1837): the
 * tables and rows an editor shows (what a menu or ⌘K acts on), the row whose
 * head takes the focus next, the Documents picker open in a table, the row
 * being dragged, and the counts the User clicked to show only the rows they
 * name.
 */
import { create } from "zustand";
import type { ComparisonTableHandle } from "./comparisonStructure";

export interface ComparisonRowHandle extends ComparisonTableHandle {
  documentId: string;
}

/** The tables with an editor showing them, by Block id. */
export const comparisonTableHandles = new Map<string, ComparisonTableHandle>();
/** The rows with an editor showing them, by `comparisonRowKey`. */
export const comparisonRowHandles = new Map<string, ComparisonRowHandle>();

export const comparisonRowKey = (tableId: string, documentId: string) => `${tableId}/${documentId}`;

/** A count of the title line: the rows with a cell that found nothing, or one that failed. */
export type RowProblem = "nothing" | "failed";

/** A row being dragged, and the place among all rows it would land in. */
export interface RowDrag {
  tableId: string;
  documentId: string;
  at: number;
}

interface ComparisonTableState {
  /** The table whose Add Documents picker is open, if any. */
  adding: string | null;
  /** The table whose name is being typed in place, if any. */
  renaming: string | null;
  /** The row whose head takes the focus once it is drawn. */
  focus: { tableId: string; documentId: string } | null;
  drag: RowDrag | null;
  /** The counts clicked for a table: only the rows with a cell of each show. */
  filters: ReadonlyMap<string, ReadonlySet<RowProblem>>;
  /** The columns each table hides, as the cells a row counts: kept by its view. */
  hiddenColumns: ReadonlyMap<string, ReadonlySet<string>>;
  openAddDocuments(tableId: string): void;
  closeAddDocuments(): void;
  startRename(tableId: string): void;
  endRename(): void;
  focusRow(tableId: string, documentId: string | null): void;
  clearFocus(tableId: string, documentId: string): void;
  startDrag(drag: RowDrag): void;
  moveDrag(at: number): void;
  endDrag(): void;
  toggleFilter(tableId: string, problem: RowProblem): void;
  clearFilter(tableId: string): void;
  setHiddenColumns(tableId: string, questionIds: readonly string[]): void;
}

export const useComparisonTables = create<ComparisonTableState>()((set) => ({
  adding: null,
  renaming: null,
  focus: null,
  drag: null,
  filters: new Map(),
  hiddenColumns: new Map(),
  openAddDocuments: (tableId) => set({ adding: tableId }),
  closeAddDocuments: () => set({ adding: null }),
  startRename: (tableId) => set({ renaming: tableId }),
  endRename: () => set({ renaming: null }),
  focusRow: (tableId, documentId) => set({ focus: documentId ? { tableId, documentId } : null }),
  clearFocus: (tableId, documentId) =>
    set((state) =>
      state.focus?.tableId === tableId && state.focus.documentId === documentId
        ? { focus: null }
        : {},
    ),
  startDrag: (drag) => set({ drag }),
  moveDrag: (at) =>
    set((state) => (state.drag && state.drag.at !== at ? { drag: { ...state.drag, at } } : {})),
  endDrag: () => set({ drag: null }),
  toggleFilter: (tableId, problem) =>
    set((state) => {
      const current = new Set(state.filters.get(tableId) ?? []);
      if (current.has(problem)) current.delete(problem);
      else current.add(problem);
      const filters = new Map(state.filters);
      if (current.size === 0) filters.delete(tableId);
      else filters.set(tableId, current);
      return { filters };
    }),
  clearFilter: (tableId) =>
    set((state) => {
      if (!state.filters.has(tableId)) return {};
      const filters = new Map(state.filters);
      filters.delete(tableId);
      return { filters };
    }),
  setHiddenColumns: (tableId, questionIds) =>
    set((state) => {
      const current = state.hiddenColumns.get(tableId);
      const next = new Set(questionIds);
      const same =
        current !== undefined &&
        current.size === next.size &&
        [...next].every((id) => current.has(id));
      if (same) return {};
      const hiddenColumns = new Map(state.hiddenColumns);
      if (next.size === 0) hiddenColumns.delete(tableId);
      else hiddenColumns.set(tableId, next);
      return { hiddenColumns };
    }),
}));
